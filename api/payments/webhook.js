'use strict';

// POST /api/payments/webhook
//
// The only door to a confirmed booking.
//
// HighLevel calls this when a deposit invoice is paid (InvoicePaid) or fails. A
// paid event confirms the parent booking and all its per-vehicle children and
// credits any membership; anything else releases the vans immediately instead of
// waiting out the hold.
//
// Two things make this safe to expose:
//   * a shared secret, compared in constant time, so only HighLevel can call it;
//   * `unique (provider, external_event_id)`, so a webhook that fires five times
//     confirms once and credits once.
//
// The amounts and identifiers in the payload are used for the audit row only.
// What gets confirmed, and for how much, comes from the hold that was priced
// server-side — a forged payload cannot confirm a booking it did not pay for,
// because the deposit amount is checked against the hold before confirming.

const crypto = require('node:crypto');

const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody, assertMethod } = require('../_lib/http.js');
const { text } = require('../_lib/validate.js');
const ghl = require('../_lib/ghl.js');
const agenda = require('../_lib/agenda.js');
const recurring = require('../_lib/crm-recurring-memberships.js');

const PAID_EVENT_TYPES = new Set(['InvoicePaid', 'invoice.paid', 'OrderPaid', 'payment.succeeded']);
const FAILED_EVENT_TYPES = new Set(['InvoiceFailed', 'invoice.failed', 'payment.failed', 'InvoiceVoid', 'invoice.voided']);

function timingSafeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Shared-secret check. A signing secret is required: without one, anyone who
// learns the URL could confirm bookings nobody paid for.
function assertAuthentic(req, rawBody) {
  const secret = String(process.env.PAYMENT_WEBHOOK_SECRET || '').trim();
  if (!secret) throw new RequestError('Payment webhook is not configured', 503);

  const headers = req.headers || {};
  const signature = String(headers['x-lyb-signature'] || headers['x-wh-signature'] || '').trim();
  if (signature) {
    // HMAC over the exact bytes received, when the caller can sign.
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!timingSafeEquals(signature, expected)) throw new RequestError('Invalid signature', 401);
    return;
  }
  // HighLevel's inbound webhooks cannot sign a body, so a static bearer token in a
  // header the workflow sets is the fallback.
  const header = String(headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !timingSafeEquals(provided, secret)) throw new RequestError('Not authorized', 401);
}

function outcomeFor(eventType) {
  if (PAID_EVENT_TYPES.has(eventType)) return 'paid';
  if (FAILED_EVENT_TYPES.has(eventType)) return 'failed';
  return null;
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  const payment = body.payment && typeof body.payment === 'object' ? body.payment : {};
  const invoice = body.invoice && typeof body.invoice === 'object' ? body.invoice : {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const eventType = text(body.type || body.eventType || payment.type || data.type, 'type', 1, 80);
  const outcome = outcomeFor(eventType);
  // Anything we don't act on is acknowledged, not rejected: a 4xx would make
  // HighLevel retry an event forever.
  if (!outcome) return { ignored: true, eventType };

  const nestedInvoiceId = body.invoiceId || payment.invoiceId || invoice.id || invoice._id || data.invoiceId || '';
  const externalEventId = text(body.id || body.eventId || payment.id || payment.transactionId || data.id || nestedInvoiceId, 'id', 1, 200);

  // Booking identifiers always win. HighLevel invoice events naturally include an
  // invoiceId as well, so testing invoiceId first would misclassify every paid
  // deposit as a membership renewal.
  const rawHoldId = body.holdId || payment.holdId || data.holdId || (body.meta && body.meta.holdId) || '';
  const submissionId = body.submissionId || payment.submissionId || data.submissionId || (body.meta && body.meta.submissionId) || '';
  if (body.kind === 'booking' || rawHoldId || submissionId) {
    const holdId = rawHoldId ? text(rawHoldId, 'holdId', 8, 64) : '';
    const amount = Number(body.amount != null ? body.amount : (body.amountPaid != null ? body.amountPaid : (payment.amount || payment.amountPaid || 0)));
    return {
      ignored: false,
      kind: 'booking',
      eventType,
      outcome,
      externalEventId,
      holdId,
      submissionId: submissionId ? text(submissionId, 'submissionId', 8, 100) : '',
      invoiceId: nestedInvoiceId ? text(nestedInvoiceId, 'invoiceId', 2, 100) : '',
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      currency: typeof body.currency === 'string' ? body.currency.slice(0, 8) : 'USD',
      payload: body
    };
  }

  // A MEMBERSHIP invoice, not a booking deposit. Told apart by carrying a contractId
  // (the CRM opportunity) instead of a hold: a recurring invoice has no hold, and a
  // deposit has no contract. The workflow that calls this sends one or the other.
  const rawContractId = body.contractId || (body.meta && body.meta.contractId) || '';
  // A membership invoice identified only by its INVOICE id. The endpoint resolves the
  // contact, the plan and the date from the invoice itself, so the workflow — which is
  // contact-scoped and cannot know which of a customer's vehicles an invoice pays for —
  // only has to pass one field it definitely has.
  const rawInvoiceId = nestedInvoiceId || (body.meta && body.meta.invoiceId) || '';
  if (!rawContractId && rawInvoiceId) {
    return {
      ignored: false,
      kind: 'membership',
      eventType,
      outcome,
      externalEventId,
      contractId: '',
      invoiceId: text(rawInvoiceId, 'invoiceId', 8, 64),
      cycleStartsAt: '',
      payload: body
    };
  }
  if (rawContractId) {
    return {
      ignored: false,
      kind: 'membership',
      eventType,
      outcome,
      externalEventId,
      contractId: text(rawContractId, 'contractId', 8, 64),
      // The invoice's OWN date, so re-applying the same invoice computes the same cycle
      // end instead of pushing it out another month. Optional, and the fallback to now
      // is deliberately not idempotent — the workflow is configured to send it.
      cycleStartsAt: body.cycleStartsAt || body.issueDate || (body.meta && body.meta.issueDate) || '',
      payload: body
    };
  }
  // A HighLevel workflow finds it easier to pass the submission id than the hold
  // id, so either identifies the reservation; the submission id is resolved back
  // to its hold below.
  throw new RequestError('holdId, submissionId, contractId or invoiceId is required');
}

// Applies a membership invoice event to its contract. Resolves the custom-field ids by
// name, the same way the member page does, so the two can never disagree about which
// field holds what.
// The membership custom-field ids, resolved by name because they differ per sub-account.
async function resolveMembershipFields(config) {
  const data = await ghl.ghlRequest(config, `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`, {
    version: '2021-07-28'
  });
  const byName = new Map((data.customFields || []).map(field => [String(field.name || '').trim(), field.id]));
  const fieldIds = {
    plan: byName.get('Membership Plan') || '',
    vehicle: byName.get('Membership Vehicle') || '',
    status: byName.get('Membership Status') || '',
    cycleEnds: byName.get('Membership Cycle Ends') || '',
    portalUrl: byName.get('Membership Portal URL') || '',
    // Needed to turn on auto-payment once the first invoice has been paid.
    scheduleId: byName.get('Membership Subscription ID') || '',
    reminderDate: byName.get('Membership Credit Reminder Date') || ''
  };
  if (!fieldIds.status || !fieldIds.cycleEnds) {
    throw new RequestError('Membership fields are missing in the CRM', 503, 'MEMBERSHIP_FIELDS_MISSING');
  }
  return { fieldIds };
}

// The Memberships pipeline: its id, its stage names, and the Active stage to move a paid
// card to. All resolved by name so a renamed id cannot break it silently.
async function membershipStages(config) {
  const data = await ghl.ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`, {
    version: '2021-07-28'
  });
  const pipeline = (data.pipelines || []).find(entry => String(entry.name || '').trim() === 'Memberships');
  const stages = (pipeline && pipeline.stages) || [];
  const active = stages.find(stage => String(stage.name || '').trim() === 'Active');
  return {
    pipelineId: pipeline ? pipeline.id : '',
    names: Object.fromEntries(stages.map(stage => [stage.id, stage.name])),
    activeStageId: active ? active.id : ''
  };
}

async function applyMembershipEvent(event) {
  const membershipCrm = require('../_lib/membership-crm.js');
  const config = ghl.getConfig();

  // When only an invoice id was sent, the invoice is the source of everything: which
  // contract it pays for, and what date the cycle starts. Fetched rather than trusted,
  // so a workflow cannot pass a contract that is not the one that was actually paid.
  let contractId = event.contractId;
  let cycleStartsAt = event.cycleStartsAt;
  // Kept in the function's scope: enabling auto-payment below needs the contact this
  // invoice was billed to.
  let invoice = null;
  if (!contractId) {
    invoice = await ghl.getInvoice(config, event.invoiceId);
    const resolved = await resolveMembershipFields(config);
    const stages = await membershipStages(config);
    const contract = await membershipCrm.findContractForInvoice(
      config, resolved.fieldIds, stages.names, invoice, { pipelineId: stages.pipelineId }
    );
    contractId = contract.contractId;
    // The invoice's own date, which is what makes granting idempotent.
    cycleStartsAt = invoice.issueDate || '';
    console.log('[webhook-membership] resolved', event.invoiceId, '→', contractId);
  }
  event = { ...event, contractId, cycleStartsAt };

  const { fieldIds } = await resolveMembershipFields(config);

  if (event.outcome === 'failed') {
    const result = await membershipCrm.markPastDue(config, fieldIds, event.contractId);
    console.log('[webhook-membership] past_due', event.contractId, event.externalEventId);
    return { contractId: event.contractId, ...result };
  }

  const parsed = event.cycleStartsAt ? Date.parse(event.cycleStartsAt) : NaN;
  const cycleStartMs = Number.isFinite(parsed) ? parsed : Date.now();
  // The Active stage id, so a paid invoice moves the card as well as writing the date.
  const stages = await membershipStages(config);
  const result = await membershipCrm.grantCycle(config, fieldIds, event.contractId, {
    cycleStartMs,
    activeStageId: stages.activeStageId,
    portalUrl: fieldIds.portalUrl
      ? `${require('../_lib/public-url.js').publicAppUrl()}/m/${encodeURIComponent(require('../_lib/signed-link.js').sign('member', event.contractId))}`
      : ''
  });
  console.log('[webhook-membership] cycle granted', event.contractId, result.cycleEndsAt, event.externalEventId);

  // Turn the membership into an actual recurring CHARGE from the next cycle on.
  //
  // It cannot be done at enrolment: HighLevel's only `autoPayment.type` is `saved_card`,
  // and that needs the Stripe customer and payment method the member creates by paying
  // the first invoice. So the moment that payment lands — here — is the earliest point
  // where auto-charging is possible at all.
  //
  // Strictly best effort. If it does not take, HighLevel keeps emailing the invoice every
  // cycle and the money still arrives; nothing about the cycle the member just paid for
  // may depend on this succeeding.
  try {
    const scheduleId = await membershipCrm.readScheduleId(config, fieldIds, event.contractId);
    const outcome = await recurring.enableAutoPayment({
      config, request: ghl.ghlRequest, scheduleId,
      contactId: (invoice && (invoice.contactDetails || {}).id) || '',
      invoiceId: event.invoiceId || ''
    });
    console.log('[webhook-membership] autopay', event.contractId, outcome.enabled ? 'on' : `off:${outcome.reason}`);
  } catch (error) {
    console.error('[webhook-membership] autopay failed', event.contractId, error.name || 'Error');
  }

  return { contractId: event.contractId, ...result };
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    const body = readBody(req);
    assertAuthentic(req, typeof req.body === 'string' ? req.body : JSON.stringify(body));
    const event = validateRequest(body);
    if (event.ignored) return sendJson(res, 200, { ok: true, ignored: true, type: event.eventType });

    // Membership cycles are recorded straight onto the CRM contract. No database: the
    // opportunity IS the contract, and the cycle end IS the credit reset (see
    // membership-crm.grantCycle).
    if (event.kind === 'membership') {
      const result = await applyMembershipEvent(event);
      return sendJson(res, 200, { ok: true, ...result });
    }

    let config = null;
    try { config = ghl.getConfig(); } catch (error) { console.error('[payments] CRM not configured; confirming rows only'); }

    let holdId = event.holdId || (event.submissionId ? await agenda.resolveHoldIdBySubmission(event.submissionId) : '');
    if (!holdId && event.invoiceId) {
      const invoice = await ghl.getInvoice(config || ghl.getConfig(), event.invoiceId);
      const match = String(invoice.name || invoice.title || '').match(/hold:([a-z0-9-]{8,64})/i);
      holdId = match ? match[1] : '';
    }
    if (!holdId) throw new RequestError('No reservation matches this payment', 404);

    const result = await agenda.confirmPayment({
      provider: 'highlevel',
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      outcome: event.outcome,
      holdId,
      amountCents: event.amountCents,
      currency: event.currency,
      payload: event.payload,
      config
    });

    // A conflict (paid after the hold lapsed) is reported as 200 with a flag: the
    // office has to refund or rebook by hand, and making HighLevel retry the
    // webhook would not change the outcome.
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'Payment processing failed';
    if (statusCode >= 500) console.error('[payments]', error.name || 'Error', statusCode);
    // The code matters here: a workflow that gets MEMBERSHIP_AMBIGUOUS needs to be told
    // apart from one that hit an outage, because the first will never succeed on retry
    // and the second will.
    return sendJson(res, statusCode, { ok: false, error: publicMessage, ...(error.code ? { code: error.code } : {}) });
  }
}

module.exports = handler;
module.exports._test = { validateRequest, assertAuthentic, outcomeFor };
