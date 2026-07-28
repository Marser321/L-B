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
  const eventType = text(body.type || body.eventType, 'type', 1, 80);
  const outcome = outcomeFor(eventType);
  // Anything we don't act on is acknowledged, not rejected: a 4xx would make
  // HighLevel retry an event forever.
  if (!outcome) return { ignored: true, eventType };

  const externalEventId = text(body.id || body.eventId || body.invoiceId, 'id', 1, 200);
  // A HighLevel workflow finds it easier to pass the submission id than the hold
  // id, so either identifies the reservation; the submission id is resolved back
  // to its hold below.
  const rawHoldId = body.holdId || (body.meta && body.meta.holdId) || '';
  const submissionId = body.submissionId || (body.meta && body.meta.submissionId) || '';
  if (!rawHoldId && !submissionId) throw new RequestError('holdId or submissionId is required');
  const holdId = rawHoldId ? text(rawHoldId, 'holdId', 8, 64) : '';
  const amount = Number(body.amount != null ? body.amount : (body.amountPaid || 0));

  return {
    ignored: false,
    eventType,
    outcome,
    externalEventId,
    holdId,
    submissionId: submissionId ? text(submissionId, 'submissionId', 8, 100) : '',
    amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    currency: typeof body.currency === 'string' ? body.currency.slice(0, 8) : 'USD',
    payload: body
  };
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    const body = readBody(req);
    assertAuthentic(req, typeof req.body === 'string' ? req.body : JSON.stringify(body));
    const event = validateRequest(body);
    if (event.ignored) return sendJson(res, 200, { ok: true, ignored: true, type: event.eventType });

    let config = null;
    try { config = ghl.getConfig(); } catch (error) { console.error('[payments] CRM not configured; confirming rows only'); }

    const holdId = event.holdId || await agenda.resolveHoldIdBySubmission(event.submissionId);
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
    return sendJson(res, statusCode, { ok: false, error: publicMessage });
  }
}

module.exports = handler;
module.exports._test = { validateRequest, assertAuthentic, outcomeFor };
