'use strict';

// POST /api/quote
//
// Turns a held slot into a real reservation with a customer attached, and hands
// back a deposit link. What it does NOT do is confirm the booking: confirmation
// happens only when a verified payment event arrives (api/payments/webhook.js).
// Until then the vans are held, not sold.
//
// Two things are enforced here no matter what the browser sends:
//   * at most four vehicles (HTTP 422 — there are four vans, and a tampered
//     frontend cannot conjure a fifth);
//   * every price, duration, deposit, membership flag and calendar id is looked up
//     server-side. Fields the browser sends for those are read past and dropped.
//
// The slot itself is owned by api/_lib/agenda.js against the CRM. This file is
// the CRM half: contact, opportunity, deposit invoice, notification.

const {
  RequestError, HighLevelError, SlotUnavailableError, TooManyVehiclesError, asValidationError
} = require('./_lib/errors.js');
const { sendJson, readBody, assertSameOrigin, assertMethod } = require('./_lib/http.js');
const { text, optionalText, normalizePhone, validateEmail, SUBMISSION_PATTERN } = require('./_lib/validate.js');
const { normalizeVehicles } = require('./_lib/selection.js');
const catalog = require('./_lib/catalog.js');
const pricing = require('./_lib/pricing.js');
const time = require('./_lib/time.js');
const ghl = require('./_lib/ghl.js');
const agenda = require('./_lib/agenda.js');
const paymentLinks = require('./_lib/payment-links.js');

const PIPELINE_NAME = 'Pipeline de Servicios';
const PIPELINE_STAGE_NAME = 'Pendiente de Información';
const CONFIRMED_PIPELINE_STAGE_NAME = 'Cita Confirmada';
const BOOKING_WEBHOOK_TIMEOUT_MS = 4 * 1000;
const DEPOSIT_PAYMENT_TIMEOUT_MS = 6 * 1000;

// TODO(remove-legacy-windows): retired named windows, transition window only.
const LEGACY_TIME_WINDOWS = Object.freeze({ morning: '08:00', afternoon: '12:00', evening: '16:00' });

const OPPORTUNITY_FIELDS = Object.freeze({
  category: 'Website Quote - Category',
  servicePackage: 'Website Quote - Package',
  size: 'Website Quote - Size or Quantity',
  addons: 'Website Quote - Add-ons',
  items: 'Website Quote - Items',
  itemCount: 'Website Quote - Item Count',
  vehicleMake: 'Website Quote - Vehicle Make',
  vehicleModel: 'Website Quote - Vehicle Model',
  vehicleYear: 'Website Quote - Vehicle Year',
  vehicleColor: 'Website Quote - Vehicle Color',
  vehiclePlate: 'Website Quote - License Plate',
  serviceAddress: 'Website Quote - Service Address',
  preferredDate: 'Website Quote - Preferred Date',
  preferredTime: 'Website Quote - Preferred Time',
  estimate: 'Website Quote - Estimate',
  deposit: 'Website Quote - Deposit Due',
  duration: 'Website Quote - Service Duration',
  notes: 'Website Quote - Customer Notes',
  language: 'Website Quote - Language',
  policyAcceptedAt: 'Website Quote - Policy Accepted At',
  submissionId: 'Website Quote - Submission ID',
  appointmentId: 'Website Quote - Appointment ID',
  bookingMode: 'Website Quote - Booking Mode',
  confirmedStart: 'Website Quote - Confirmed Start',
  confirmedEnd: 'Website Quote - Confirmed End',
  bookingStatus: 'Website Quote - Booking Status',
  depositStatus: 'Website Quote - Deposit Status',
  depositLink: 'Website Quote - Deposit Link',
  holdId: 'Website Quote - Hold ID',
  crewAssignments: 'Website Quote - Crew Assignments'
});

// Custom fields that a location may not have yet. Keeping them optional means a
// deploy does not hard-fail on a sub-account where scripts/setup-ghl.mjs has not
// been re-run; the booking still works, it just records less.
const OPTIONAL_FIELDS = new Set(['depositStatus', 'depositLink', 'holdId', 'crewAssignments']);
const DEPOSIT_PAYMENT_ONLY_FIELDS = new Set(['depositStatus', 'depositLink']);

let metadataPromise = null;

// ── Request validation ─────────────────────────────────────────────────────

function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  const submissionId = text(body.submissionId, 'submissionId', 8, 100);
  if (!SUBMISSION_PATTERN.test(submissionId)) throw new RequestError('submissionId is invalid');
  if (body.policyAccepted !== true) throw new RequestError('Service policies must be accepted');
  if (!['en', 'es'].includes(body.language)) throw new RequestError('language is invalid');

  const customer = body.customer || {};
  const schedule = body.schedule || {};

  // v2 payloads carry a cart in items[]; legacy payloads (long-lived open tabs)
  // carry a single selection/vehicle trio and normalize to one vehicle.
  // TODO(remove-legacy-payload): drop the legacy branch when the window closes.
  const rawItems = Array.isArray(body.items)
    ? body.items
    : [{ ...(body.selection || {}), vehicle: body.vehicle || {} }];

  // MAX_VEHICLES is the whole fleet. More than that is a 422: well-formed, but
  // impossible — and it is enforced here, before anything reaches the database.
  if (rawItems.length > catalog.MAX_VEHICLES) throw new TooManyVehiclesError(catalog.MAX_VEHICLES);

  const vehicles = normalizeVehicles(rawItems, {
    requirePricing: true,
    requireDescriptor: true,
    language: body.language,
    field: 'items'
  });

  const date = text(schedule.date, 'schedule.date', 10, 10);
  if (!time.isValidDateOnly(date)) throw new RequestError('schedule.date is invalid');
  const today = time.todayInZone();
  if (date < today) throw new RequestError('schedule.date is in the past');
  if (date > time.addDays(today, catalog.BOOKING_WINDOW_DAYS)) throw new RequestError('schedule.date is too far ahead');

  const requestedWindow = text(schedule.timeWindow, 'schedule.timeWindow', 1, 20);
  // TODO(remove-legacy-windows): long-lived open tabs still post the retired
  // morning/afternoon/evening keys; map them onto the new start-time grid.
  const mapped = LEGACY_TIME_WINDOWS[requestedWindow] || requestedWindow;
  const bookingMode = catalog.bookingModeForPackages(vehicles.map(vehicle => vehicle.packageId));
  const startTime = mapped === 'full_day' ? time.BUSINESS_DAY.start : mapped;
  if (bookingMode === 'full_day') {
    if (mapped !== 'full_day' && mapped !== time.BUSINESS_DAY.start) {
      throw new RequestError('schedule.timeWindow must be full_day for this booking');
    }
  } else {
    if (mapped === 'full_day') throw new RequestError('schedule.timeWindow is invalid for this booking');
    if (!time.START_TIME_PATTERN.test(startTime)) throw new RequestError('schedule.timeWindow is invalid');
    if (time.minutesFromTime(startTime) % time.SLOT_GRID_MINUTES !== 0) throw new RequestError('schedule.timeWindow is invalid');
  }

  const policyAcceptedAt = text(body.policyAcceptedAt, 'policyAcceptedAt', 20, 40);
  if (Number.isNaN(Date.parse(policyAcceptedAt))) throw new RequestError('policyAcceptedAt is invalid');
  const zip = optionalText(customer.zip, 'customer.zip', 10);
  if (zip && !/^\d{5}$/.test(zip)) throw new RequestError('customer.zip is invalid');
  const holdId = optionalText(body.holdId, 'holdId', 64);

  // Everything below this line is derived on the server. Anything the browser sent
  // for estimate, deposit or duration never makes it into the returned object.
  const packageIds = vehicles.map(vehicle => vehicle.packageId);
  const estimate = pricing.estimateForVehicles(
    vehicles.map(vehicle => ({ packageId: vehicle.packageId, sizeId: vehicle.sizeId, addonIds: vehicle.addonIds })),
    body.language
  );
  const timezone = time.bookingTimezone();
  const window = agenda.visitWindow(vehicles, date, startTime, timezone);

  return {
    submissionId,
    holdId,
    language: body.language,
    policyAcceptedAt,
    website: optionalText(body.website, 'website', 200),
    customer: {
      name: text(customer.name, 'customer.name', 2, 100),
      phone: normalizePhone(customer.phone),
      email: validateEmail(customer.email),
      address: text(customer.address, 'customer.address', 4, 160),
      unit: optionalText(customer.unit, 'customer.unit', 40),
      city: text(customer.city, 'customer.city', 2, 80),
      zip
    },
    vehicles,
    estimate,
    deposit: catalog.depositForPackages(packageIds),
    schedule: {
      date,
      startTime: window.startTime,
      timeWindow: bookingMode === 'full_day' ? 'full_day' : window.startTime,
      timeLabel: bookingLabel(window, body.language),
      bookingMode,
      timezone,
      // The visit lasts as long as its longest vehicle — the vans work in parallel.
      durationMinutes: Math.round((window.endMs - window.startMs) / 60000),
      perVehicleDurationMinutes: window.perVehicle.map(vehicle => vehicle.serviceMinutes),
      notes: optionalText(schedule.notes, 'schedule.notes', 1000)
    }
  };
}

function clock(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute ? `${hour12}:${String(minute).padStart(2, '0')}${suffix}` : `${hour12}${suffix}`;
}

function bookingLabel(window, language = 'en') {
  if (window.bookingMode === 'full_day') {
    return language === 'es' ? 'Día completo (8am–6pm)' : 'Full day (8am–6pm)';
  }
  const start = time.minutesFromTime(window.startTime);
  const end = start + Math.round((window.endMs - window.startMs) / 60000);
  return `${clock(start)}–${clock(end)}`;
}

// ── HighLevel metadata ─────────────────────────────────────────────────────

async function resolveMetadata(config) {
  if (!metadataPromise) {
    metadataPromise = (async () => {
      let pipelineId = config.pipelineId;
      let pipelineStageId = config.pipelineStageId;
      let confirmedPipelineStageId = config.confirmedPipelineStageId;
      if (!pipelineId || !pipelineStageId || !confirmedPipelineStageId) {
        const pipelineData = await ghl.ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`);
        const pipelines = pipelineData.pipelines || [];
        const pipeline = pipelines.find(item => String(item.name || '').toLowerCase() === PIPELINE_NAME.toLowerCase());
        const stages = pipeline && (pipeline.stages || []);
        const stage = stages && stages.find(item => String(item.name || '').toLowerCase() === PIPELINE_STAGE_NAME.toLowerCase());
        const confirmedStage = stages && stages.find(item => String(item.name || '').toLowerCase() === CONFIRMED_PIPELINE_STAGE_NAME.toLowerCase());
        if (!pipeline || !stage || !confirmedStage) throw new RequestError('Website booking pipeline is not configured', 503);
        pipelineId = pipeline.id;
        pipelineStageId = stage.id;
        confirmedPipelineStageId = confirmedStage.id;
      }

      const customFieldData = await ghl.ghlRequest(
        config,
        `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`
      );
      const fields = customFieldData.customFields || [];
      const fieldIds = {};
      const missing = [];
      Object.entries(OPPORTUNITY_FIELDS).forEach(([key, name]) => {
        const match = fields.find(field => field.model === 'opportunity' && String(field.name || '').toLowerCase() === name.toLowerCase());
        if (match) fieldIds[key] = match.id;
        else if (!OPTIONAL_FIELDS.has(key)) missing.push(name);
        // Deposit fields become mandatory once online payments are on: without
        // them the customer would get a link nobody can see in the CRM.
        else if (config.depositPaymentsEnabled && DEPOSIT_PAYMENT_ONLY_FIELDS.has(key)) missing.push(name);
      });
      if (missing.length) throw new RequestError('Website quote custom fields are not configured', 503);
      return { pipelineId, pipelineStageId, confirmedPipelineStageId, fieldIds };
    })().catch(error => {
      metadataPromise = null;
      throw error;
    });
  }
  return metadataPromise;
}

// ── CRM field values ───────────────────────────────────────────────────────

// GHL custom fields are single-value TEXT; keep serialized cart values bounded.
function truncateField(value, max = 450) {
  const str = String(value);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function uniqueJoin(values) {
  return [...new Set(values.filter(Boolean))].join('; ');
}

function addonsText(vehicle) {
  return vehicle.addonIds.length ? vehicle.addonIds.join(', ') : 'None';
}

function vehicleText(descriptor) {
  return `${descriptor.year} ${descriptor.make} ${descriptor.model}${descriptor.color ? ` ${descriptor.color}` : ''}${descriptor.plate ? ` (${descriptor.plate})` : ''}`;
}

function packagesSummary(vehicles) {
  const counts = new Map();
  vehicles.forEach(vehicle => counts.set(vehicle.packageId, (counts.get(vehicle.packageId) || 0) + 1));
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${count}× ${name}` : name)).join('; ');
}

function itemsBreakdown(vehicles) {
  return vehicles.map((vehicle, index) =>
    `${index + 1}) ${vehicle.packageId} — ${vehicle.sizeId} — ${vehicle.estimate.label} — ${vehicleText(vehicle.descriptor)} — Add-ons: ${addonsText(vehicle)}`
  ).join('\n');
}

// "camioneta_1 09:00–10:30; camioneta_2 09:00–11:00" — which van has which vehicle.
function assignmentsSummary(hold) {
  return (hold.assignments || []).map(assignment => {
    const start = new Date(assignment.startsAt);
    const end = new Date(assignment.endsAt);
    const format = value => new Intl.DateTimeFormat('en-US', {
      timeZone: hold.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(value);
    return `#${assignment.vehicleIndex + 1} ${assignment.resource} ${format(start)}–${format(end)}`;
  }).join('; ');
}

function opportunityValues(payload, hold, { bookingStatus = 'pending_payment', depositPayment = null } = {}) {
  const { customer, vehicles, estimate, schedule } = payload;
  const single = vehicles.length === 1;
  const values = {
    category: uniqueJoin(vehicles.map(vehicle => vehicle.categoryId)),
    servicePackage: packagesSummary(vehicles),
    size: single ? vehicles[0].sizeId : vehicles.map(vehicle => vehicle.sizeId).join('; '),
    addons: single ? addonsText(vehicles[0]) : vehicles.map((vehicle, index) => `${index + 1}) ${addonsText(vehicle)}`).join('; '),
    items: itemsBreakdown(vehicles),
    itemCount: String(vehicles.length),
    vehicleMake: uniqueJoin(vehicles.map(vehicle => vehicle.descriptor.make)),
    vehicleModel: uniqueJoin(vehicles.map(vehicle => vehicle.descriptor.model)),
    vehicleYear: uniqueJoin(vehicles.map(vehicle => String(vehicle.descriptor.year))),
    vehicleColor: uniqueJoin(vehicles.map(vehicle => vehicle.descriptor.color)),
    vehiclePlate: uniqueJoin(vehicles.map(vehicle => vehicle.descriptor.plate)),
    serviceAddress: [customer.address, customer.unit, customer.city, customer.zip].filter(Boolean).join(', '),
    preferredDate: schedule.date,
    preferredTime: schedule.timeLabel,
    estimate: estimate.label,
    deposit: `$${payload.deposit}`,
    duration: `${Math.floor(schedule.durationMinutes / 60)}h ${schedule.durationMinutes % 60}m`,
    notes: schedule.notes,
    language: payload.language,
    policyAcceptedAt: payload.policyAcceptedAt,
    submissionId: payload.submissionId,
    // One booking now spans several appointments, one per van, so the single
    // appointment id is replaced by the crew breakdown below.
    appointmentId: '',
    bookingMode: schedule.bookingMode,
    confirmedStart: hold ? hold.slotStart : '',
    confirmedEnd: hold ? hold.slotEnd : '',
    bookingStatus,
    holdId: hold ? hold.holdId : '',
    crewAssignments: hold ? assignmentsSummary(hold) : '',
    depositStatus: depositPayment ? 'unpaid' : '',
    depositLink: depositPayment && depositPayment.depositUrl ? depositPayment.depositUrl : ''
  };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, truncateField(value)]));
}

function customFieldsForValues(metadata, values) {
  return Object.entries(values)
    .filter(([key, value]) => value !== '' && metadata.fieldIds[key])
    .map(([key, value]) => ({ id: metadata.fieldIds[key], fieldValue: String(value) }));
}

function opportunityCustomFieldValue(field) {
  if (!field || typeof field !== 'object') return '';
  if (field.fieldValue != null) return field.fieldValue;
  if (field.fieldValueString != null) return field.fieldValueString;
  return '';
}

function opportunityFieldValue(opportunity, fieldId) {
  const field = (opportunity.customFields || []).find(item => item.id === fieldId);
  return String(opportunityCustomFieldValue(field) || '');
}

// ── HighLevel writes ───────────────────────────────────────────────────────

// Both live in ghl.js now: the hold needs the same upsert, because a hold is an
// appointment and an appointment needs a contact.
const splitName = ghl.splitName;
const upsertContact = (config, payload) => ghl.upsertContact(config, payload.customer);

async function findOpportunityBySubmission(config, metadata, contactId, submissionId) {
  const searchParams = new URLSearchParams({
    locationId: config.locationId,
    pipelineId: metadata.pipelineId,
    contactId,
    status: 'all',
    limit: '100'
  });
  const existingData = await ghl.ghlRequest(config, `/opportunities/search?${searchParams}`);
  return (existingData.opportunities || []).find(opportunity =>
    (opportunity.customFields || []).some(field =>
      field.id === metadata.fieldIds.submissionId && String(opportunityCustomFieldValue(field)) === submissionId
    )
  );
}

async function createOpportunity(config, metadata, contact, payload, hold) {
  const values = opportunityValues(payload, hold);
  const customFields = customFieldsForValues(metadata, values);
  const label = payload.vehicles.length === 1
    ? vehicleText(payload.vehicles[0].descriptor)
    : `${payload.vehicles.length} vehicles`;

  let result;
  try {
    result = await ghl.ghlRequest(config, '/opportunities/', {
      method: 'POST',
      version: 'v3',
      body: {
        pipelineId: metadata.pipelineId,
        pipelineStageId: metadata.pipelineStageId,
        locationId: config.locationId,
        contactId: contact.id,
        name: `Web Booking - ${payload.customer.name} - ${label}`.slice(0, 160),
        status: 'open',
        assignedTo: config.assignedUserId,
        monetaryValue: Math.round(payload.estimate.min),
        customFields
      }
    });
  } catch (error) {
    // HighLevel's opportunity search index is eventually consistent. If a retry
    // arrives immediately, creation may reject the duplicate before the first
    // search can see it. Recheck briefly before surfacing an error.
    if (error instanceof HighLevelError && [400, 409, 422].includes(error.upstreamStatus)) {
      for (const delayMs of [250, 500, 1000]) {
        await ghl.wait(delayMs);
        const indexed = await findOpportunityBySubmission(config, metadata, contact.id, payload.submissionId);
        if (indexed) return indexed;
      }
    }
    throw error;
  }
  const opportunity = result.opportunity || result;
  if (!opportunity || !opportunity.id) throw new HighLevelError(502);
  return opportunity;
}

// The opportunity is created in the pending stage and only moves to the confirmed
// stage from the payment webhook. A failure here never breaks the reservation: the
// slot is held in Postgres either way.
async function updateOpportunitySafely(config, metadata, opportunityId, payload, hold, options) {
  try {
    await ghl.ghlRequest(config, `/opportunities/${encodeURIComponent(opportunityId)}`, {
      method: 'PUT',
      version: 'v3',
      body: {
        pipelineStageId: metadata.pipelineStageId,
        assignedTo: config.assignedUserId,
        monetaryValue: Math.round(payload.estimate.min),
        customFields: customFieldsForValues(metadata, opportunityValues(payload, hold, options))
      }
    });
    return true;
  } catch (error) {
    console.error('[quote] opportunity update failed', payload.submissionId, error.name || 'Error');
    return false;
  }
}

// ── Deposit ────────────────────────────────────────────────────────────────

// The deposit link for a website booking.
//
// Built through the shared payment-links module, so it is composed of the same
// CRM products the office picks from when it sends a link by hand — instead of the
// free-text "Booking Deposit" line this used to write, which no report could break
// down and no operator could reuse.
//
// Idempotent on the hold: a retried submit returns the first link rather than
// invoicing the customer twice. A failure is logged and swallowed, exactly as
// before — the vans are held either way and the office can still invoice by hand.
async function createDepositPaymentLink(config, payload, hold, contact) {
  try {
    const lines = await paymentLinks.buildLines({
      purpose: 'booking_deposit',
      deposit: { amount: payload.deposit },
      livemode: Boolean(config.depositPaymentsLiveMode)
    });
    const link = await paymentLinks.issuePaymentLink({
      idempotencyKey: `deposit:${hold.holdId}`,
      purpose: 'booking_deposit',
      origin: 'web',
      contact: {
        id: contact.id,
        name: payload.customer.name,
        phone: payload.customer.phone,
        email: payload.customer.email
      },
      lines,
      holdId: hold.holdId,
      createdBy: payload.submissionId,
      config
    });
    if (!link.url) return null;
    return { depositUrl: link.url, depositRef: link.invoiceId };
  } catch (error) {
    console.error('[quote] deposit payment link failed', payload.submissionId, error.name || 'Error', error.code || '');
    return null;
  }
}

// TODO(remove-legacy-deposit): the original free-text implementation, kept until
// the CRM catalog is provisioned in production and the new path has been seen to
// work against the live sub-account. Nothing calls it.
async function createDepositPayment(config, payload, hold, contactId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEPOSIT_PAYMENT_TIMEOUT_MS);
  try {
    const email = payload.customer.email;
    const result = await ghl.ghlRequest(config, '/invoices/text2pay', {
      method: 'POST',
      version: 'v3',
      signal: controller.signal,
      body: {
        altId: config.locationId,
        altType: 'location',
        name: `Booking Deposit — ${payload.submissionId} — hold:${hold.holdId}`.slice(0, 160),
        currency: 'USD',
        items: [{ name: 'Booking Deposit', currency: 'USD', amount: payload.deposit, qty: 1 }],
        contactDetails: {
          id: contactId,
          name: payload.customer.name,
          phoneNo: payload.customer.phone,
          email
        },
        issueDate: new Date().toISOString().slice(0, 10),
        sentTo: { email: email ? [email] : [] },
        liveMode: config.depositPaymentsLiveMode,
        // 'send' publishes the invoice so the hosted link is actually payable.
        // ('draft' returns a URL but the page reads "Draft invoice cannot be
        // paid" — verified against the live sub-account.)
        action: 'send',
        userId: config.assignedUserId
      }
    });
    const depositUrl = result && typeof result.invoiceUrl === 'string' ? result.invoiceUrl : '';
    const depositRef = result && result.invoice && result.invoice._id ? String(result.invoice._id) : '';
    if (!depositUrl) return null;
    return { depositUrl, depositRef };
  } catch (error) {
    console.error('[quote] deposit payment failed', payload.submissionId, error.name || 'Error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Notification ───────────────────────────────────────────────────────────

async function notifyBookingWebhook(payload, hold, context) {
  const url = process.env.GHL_BOOKING_WEBHOOK_URL;
  if (!url) return;

  const lines = payload.vehicles.map((vehicle, index) =>
    `${index + 1}) ${vehicle.packageId} — ${vehicle.sizeId} — ${vehicle.estimate.label} — ${vehicleText(vehicle.descriptor)}`
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOKING_WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        submissionId: payload.submissionId,
        holdId: hold.holdId,
        bookingStatus: 'pending_payment',
        expiresAt: hold.expiresAt,
        name: payload.customer.name,
        email: payload.customer.email,
        phone: payload.customer.phone,
        address: payload.customer.address,
        itemCount: payload.vehicles.length,
        items: lines.join('\n'),
        crew: assignmentsSummary(hold),
        estimate: payload.estimate.label,
        deposit: payload.deposit,
        date: payload.schedule.date,
        timeLabel: payload.schedule.timeLabel,
        opportunityId: context.opportunityId,
        depositUrl: context.depositUrl || ''
      })
    });
  } catch (error) {
    console.error('[quote] booking webhook failed', payload.submissionId, error.name || 'Error');
  } finally {
    clearTimeout(timer);
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────

// Either adopts the hold the browser already has, or takes one now.
//
// Adopting is the normal path: the customer picked a slot, we held it, and they
// then filled in the form. The inline path covers a client that posts straight to
// /api/quote — it uses an Idempotency-Key derived from the submission id, so a
// double submit re-uses the first hold instead of taking a second set of vans.
async function resolveHold(payload, config) {
  const request = {
    date: payload.schedule.date,
    startTime: payload.schedule.startTime,
    vehicles: payload.vehicles
  };

  if (payload.holdId) {
    const hold = await agenda.getHoldForRequest(payload.holdId, { config });
    // The hold is the priced, authoritative version of the cart. If the form
    // posts a different cart than the one that was held, the customer would pay a
    // deposit for one thing and receive another.
    if (hold.requestFingerprint !== agenda.fingerprintRequest(request)) {
      throw new RequestError('This hold does not match the submitted booking', 409);
    }
    return agenda.describeExistingHold(hold);
  }

  return agenda.acquireHold({
    idempotencyKey: `quote-${payload.submissionId}`,
    ...request,
    // The hold IS an appointment and an appointment needs a contact, so the customer
    // travels with the request even on this path. The wizard normally holds the slot
    // before it gets here; this covers a client that posts straight to /api/quote.
    customer: payload.customer,
    config
  });
}

// The quote is useful even while an optional CRM sync is retrying. This response
// is entirely local: all money, duration, deposit and schedule values came from
// validatePayload() and the server catalog, never from HighLevel or the browser.
function localQuoteResponse(payload, hold = null, { opportunityId = '', depositPayment = null, syncPending = false } = {}) {
  return {
    ok: true,
    submissionId: payload.submissionId,
    holdId: hold ? hold.holdId : '',
    opportunityId,
    // A quoted cart without an existing hold is not presented as a reservation.
    appointmentStatus: hold ? 'pending_payment' : 'quote_ready',
    expiresAt: hold ? hold.expiresAt : '',
    holdMinutes: hold ? Math.round(agenda.HOLD_TTL_MS / 60000) : 0,
    syncPending,
    schedule: {
      date: payload.schedule.date,
      timeWindow: payload.schedule.timeWindow,
      timeLabel: payload.schedule.timeLabel,
      timezone: payload.schedule.timezone,
      durationMinutes: payload.schedule.durationMinutes,
      perVehicleDurationMinutes: payload.schedule.perVehicleDurationMinutes
    },
    estimate: { min: payload.estimate.min, max: payload.estimate.max, label: payload.estimate.label },
    deposit: payload.deposit,
    crew: hold ? hold.assignments : [],
    ...(depositPayment ? { depositUrl: depositPayment.depositUrl } : {})
  };
}

function isOperationalSyncFailure(error) {
  return error instanceof HighLevelError ||
    (error instanceof RequestError && error.statusCode >= 500) ||
    ['AbortError', 'TimeoutError', 'TypeError'].includes(error && error.name);
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  const requestId = String((req.headers && (req.headers['x-vercel-id'] || req.headers['x-request-id'])) || 'unknown').slice(0, 120);
  let submissionId = 'unknown';
  try {
    assertSameOrigin(req);
    const body = readBody(req);
    submissionId = typeof body.submissionId === 'string' ? body.submissionId.slice(0, 100) : 'unknown';
    let payload;
    try {
      payload = validatePayload(body);
    } catch (error) {
      throw asValidationError(error);
    }

    // Silently accept honeypot submissions without creating CRM records.
    if (payload.website) return sendJson(res, 200, { ok: true, submissionId: payload.submissionId });

    // A browser normally owns a hold before it reaches checkout. Reading it back is a
    // CRM call now — the hold is an appointment — so a HighLevel outage here degrades
    // to the local quote below instead of failing the submission.
    let hold = null;
    if (payload.holdId) {
      try {
        hold = await resolveHold(payload, null);
      } catch (error) {
        if (isOperationalSyncFailure(error)) {
          console.error('[quote-local]', { requestId, cause: error.name || 'Error', code: error.code || 'QUOTE_LOCAL_UNAVAILABLE' });
          return sendJson(res, 200, localQuoteResponse(payload, null, { syncPending: true }));
        }
        throw error;
      }
    }

    // CRM and payment-link work are a best-effort synchronization concern. They
    // can enrich a held booking, but never make server-side quote calculation
    // unavailable. This also keeps Stripe entirely out of /api/quote.
    try {
      const config = ghl.getConfig();
      const metadata = await resolveMetadata(config);

      if (!hold) hold = await resolveHold(payload, config);
      const contact = await upsertContact(config, payload);

      let opportunity = await findOpportunityBySubmission(config, metadata, contact.id, payload.submissionId);
      if (!opportunity) opportunity = await createOpportunity(config, metadata, contact, payload, hold);

      await agenda.attachCustomer({
        config,
        holdId: hold.holdId,
        submissionId: payload.submissionId,
        contactId: contact.id,
        opportunityId: opportunity.id,
        customer: payload.customer
      });

      let depositPayment = null;
      if (config.depositPaymentsEnabled) {
        depositPayment = await createDepositPaymentLink(config, payload, hold, contact);
      }
      const synced = await updateOpportunitySafely(config, metadata, opportunity.id, payload, hold, {
        bookingStatus: 'pending_payment',
        depositPayment
      });

      await notifyBookingWebhook(payload, hold, {
        opportunityId: opportunity.id,
        depositUrl: depositPayment ? depositPayment.depositUrl : ''
      });

      return sendJson(res, 200, localQuoteResponse(payload, hold, {
        opportunityId: opportunity.id,
        depositPayment,
        syncPending: !synced
      }));
    } catch (error) {
      if (!isOperationalSyncFailure(error)) throw error;
      console.error('[quote-sync]', { requestId, cause: error.name || 'Error', code: error.code || 'QUOTE_SYNC_UNAVAILABLE' });
      return sendJson(res, 200, localQuoteResponse(payload, hold, { syncPending: true }));
    }
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'CRM temporarily unavailable';
    if (statusCode >= 500) {
      console.error('[quote]', { requestId, cause: error.name || 'Error', code: error.code || 'QUOTE_UNAVAILABLE', statusCode });
    }
    return sendJson(res, statusCode, { ok: false, error: publicMessage, code: error.code || 'QUOTE_UNAVAILABLE' });
  }
}

module.exports = handler;
module.exports._test = {
  OPPORTUNITY_FIELDS,
  OPTIONAL_FIELDS,
  RequestError,
  HighLevelError,
  SlotUnavailableError,
  TooManyVehiclesError,
  validatePayload,
  bookingLabel,
  opportunityValues,
  opportunityCustomFieldValue,
  opportunityFieldValue,
  assignmentsSummary,
  itemsBreakdown,
  splitName,
  normalizePhone,
  createDepositPayment,
  resolveMetadata,
  resolveHold,
  localQuoteResponse,
  isOperationalSyncFailure,
  resetMetadataCache: () => { metadataPromise = null; }
};
