'use strict';

const { RequestError, HighLevelError } = require('./errors.js');

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_REQUEST_TIMEOUT_MS = 10 * 1000;
// Backoff (ms) before each GET attempt when the previous one hit a transient
// HighLevel error; first entry is 0 (no wait before the initial try).
const GHL_READ_RETRY_BACKOFF_MS = [0, 400, 1200];
const CALENDAR_API_VERSION = '2021-07-28';
const SAFE_DIAGNOSTIC_FIELDS = Object.freeze([
  'altid', 'alttype', 'businessdetails', 'contactdetails', 'currency',
  'daysbefore', 'discount', 'endtype', 'executeat', 'invoicenumberprefix',
  'items', 'livemode', 'paymentmethods', 'rrule', 'schedule', 'startdate',
  'termsnotes', 'title'
]);

// The four vans, in rotation order. Each one has its own HighLevel calendar, set
// by env var, and the agenda books straight onto those calendars — never onto the
// general round-robin calendar, which would let HighLevel pick the van and make
// two of our four assignments land on the same one.
const RESOURCE_ENV_VARS = Object.freeze([
  'GHL_CALENDAR_CAMIONETA_1',
  'GHL_CALENDAR_CAMIONETA_2',
  'GHL_CALENDAR_CAMIONETA_3',
  'GHL_CALENDAR_CAMIONETA_4'
]);

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeDiagnosticHint(data) {
  // Presence-only schema diagnostics are sufficient to identify a bad
  // integration contract and cannot carry contact, invoice, token, or amount
  // values into logs.
  const serialized = JSON.stringify(data || {}).toLowerCase();
  return SAFE_DIAGNOSTIC_FIELDS.filter(field => serialized.includes(field)).join(',');
}

function safeDiagnosticMessage(data) {
  const candidate = data && (data.message || data.error || data.detail);
  if (typeof candidate !== 'string') return '';
  // Error messages are read only by the operator-only test endpoint. Still
  // redact aggressively so a provider that echoes a request cannot surface a
  // contact, credential, invoice, or other production identifier.
  return candidate
    .slice(0, 300)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/(?:bearer\s+|sk_(?:test|live)_|pk_(?:test|live)_|whsec_)[A-Za-z0-9._-]+/gi, '[redacted-secret]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted-id]');
}

// The vans available to the agenda, as { key, position, calendarId }. Ordered by
// position so the rotation cursor means the same thing on every request.
function resources() {
  const configured = RESOURCE_ENV_VARS.map((variable, index) => ({
    key: `camioneta_${index + 1}`,
    position: index + 1,
    calendarId: String(process.env[variable] || '').trim()
  }));
  const missing = configured.filter(resource => !resource.calendarId);
  if (missing.length) throw new RequestError('Crew calendars are not configured', 503, 'GHL_CREW_CALENDARS_NOT_CONFIGURED');
  const calendarIds = new Set(configured.map(resource => resource.calendarId));
  // Two vans sharing a calendar would silently halve capacity: the second
  // assignment would look free and then collide on the same calendar.
  if (calendarIds.size !== configured.length) throw new RequestError('Crew calendars are misconfigured', 503, 'GHL_CREW_CALENDARS_MISCONFIGURED');
  return configured;
}

function getConfig() {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  const assignedUserId = process.env.GHL_ASSIGNED_USER_ID;
  if (!token || !locationId || !assignedUserId) throw new RequestError('CRM is not configured', 503, 'GHL_CRM_NOT_CONFIGURED');
  return {
    token,
    locationId,
    assignedUserId,
    resources: resources(),
    pipelineId: process.env.GHL_PIPELINE_ID || '',
    pipelineStageId: process.env.GHL_PIPELINE_STAGE_ID || '',
    confirmedPipelineStageId: process.env.GHL_CONFIRMED_PIPELINE_STAGE_ID || '',
    // Online deposit collection. Off unless explicitly turned on.
    depositPaymentsEnabled: process.env.GHL_DEPOSIT_PAYMENTS === 'on',
    // Stripe is connected in both test and live mode on the sub-account; default
    // to test mode so turning the flag on can never move real money by accident.
    depositPaymentsLiveMode: process.env.GHL_DEPOSIT_LIVE_MODE === 'true'
  };
}

// Payment work does not need the four crew calendars. Keep this separate from
// `getConfig` so a calendar configuration problem cannot prevent a CRM invoice
// draft from being prepared (and, conversely, a payment-only deployment never
// needs to know a calendar id).
function getPaymentsConfig() {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) throw new RequestError('CRM is not configured', 503, 'GHL_CRM_NOT_CONFIGURED');
  return {
    token,
    locationId,
    // Test is the safe default. This flag is intentionally distinct from the
    // deposit switch so enabling recurring memberships can never alter the
    // established $30/$50 deposit flow.
    membershipPaymentsLiveMode: process.env.GHL_MEMBERSHIP_LIVE_MODE === 'true'
  };
}

async function ghlRequestOnce(config, path, options = {}) {
  let response;
  try {
    response = await fetch(`${GHL_BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        Version: options.version || 'v3',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal || AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new HighLevelError('timeout', 504);
    }
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const statusCode = response.status === 401 || response.status === 403 || response.status === 429 ? 503 : 502;
    // Server-side diagnostics must remain safe for production logs. The
    // upstream envelope can echo a contact or invoice payload, so retain only
    // method, route, status, and an optional caller-generated request id.
    console.error('[ghl-fail]', options.requestId || '-', options.method || 'GET', path, response.status);
    throw new HighLevelError(
      response.status,
      statusCode,
      options.diagnostic ? safeDiagnosticHint(data) : '',
      options.diagnostic ? safeDiagnosticMessage(data) : ''
    );
  }
  return data;
}

// A timeout, a 429, or a gateway blip from HighLevel is usually transient — it
// spikes when several bookings arrive at once and fan out concurrent calendar
// reads. Retry idempotent GETs a couple of times with backoff before surfacing
// the error. Writes (POST/PUT/DELETE) are NEVER auto-retried: a timed-out write
// may have already landed upstream, so retrying could double-book or duplicate.
function isTransientGhlError(error) {
  return error instanceof HighLevelError &&
    (error.upstreamStatus === 'timeout' || [429, 502, 503].includes(error.upstreamStatus));
}

async function ghlRequest(config, path, options = {}) {
  if ((options.method || 'GET') !== 'GET') return ghlRequestOnce(config, path, options);
  let lastError;
  for (let attempt = 0; attempt < GHL_READ_RETRY_BACKOFF_MS.length; attempt += 1) {
    const backoffMs = GHL_READ_RETRY_BACKOFF_MS[attempt];
    if (backoffMs) await wait(backoffMs);
    try {
      return await ghlRequestOnce(config, path, options);
    } catch (error) {
      lastError = error;
      const lastAttempt = attempt === GHL_READ_RETRY_BACKOFF_MS.length - 1;
      if (lastAttempt || !isTransientGhlError(error)) throw error;
    }
  }
  throw lastError;
}

// The raw events on one calendar between two instants, as the crew panel needs them:
// title, address, notes and status, not just the busy interval. Kept separate from
// busyIntervalsForCalendar because the agenda must never be tempted to make a
// scheduling decision from a title.
async function calendarEventsForCalendar(config, calendarId, startMs, endMs) {
  const query = new URLSearchParams({
    locationId: config.locationId,
    calendarId,
    startTime: String(startMs),
    endTime: String(endMs)
  });
  const data = await ghlRequest(config, `/calendars/events?${query}`, { version: CALENDAR_API_VERSION });
  return (data.events || []).filter(event => !event.deleted);
}

// A one-line invoice for money already in hand, created so the collection lands in
// the CRM's reporting rather than in a note nobody can total up. Created as a draft
// and paid immediately by the caller, so an unpaid invoice never reaches the customer.
async function createCashInvoice(config, { contactId, title, amount, reference }) {
  const result = await ghlRequest(config, '/invoices/', {
    method: 'POST',
    version: 'v3',
    body: {
      altId: config.locationId,
      altType: 'location',
      name: String(title).slice(0, 160),
      currency: 'USD',
      items: [{ name: String(title).slice(0, 160), currency: 'USD', amount, qty: 1 }],
      contactDetails: { id: contactId },
      issueDate: new Date().toISOString().slice(0, 10),
      liveMode: true,
      invoiceNumberPrefix: 'EF-',
      // Ties the invoice back to the stop it was collected at.
      termsNotes: `cita ${reference}`
    }
  });
  const invoice = result.invoice || result;
  if (!invoice || !invoice._id && !invoice.id) throw new HighLevelError(502);
  return { id: invoice._id || invoice.id };
}

// Marks an invoice paid by a manual method. `cash` is one of HighLevel's own modes
// (enum verified against their published schema: cash, card, cheque, bank_transfer,
// other), so this is a real payment record, not a status hack.
async function recordCashPayment(config, invoiceId, { amount, notes }) {
  await ghlRequest(config, `/invoices/${encodeURIComponent(invoiceId)}/record-payment`, {
    method: 'POST',
    version: 'v3',
    body: {
      altId: config.locationId,
      altType: 'location',
      mode: 'cash',
      card: {},
      cheque: {},
      notes: String(notes || '').slice(0, 300),
      amount
    }
  });
}

// Everything already on one van's calendar between two instants, including
// appointments the office booked BY HAND in HighLevel. Postgres is the source of
// truth for what the website sold, but the calendar is the source of truth for
// what the van is physically doing, so both are unioned before a slot is offered
// or a hold is granted.
async function busyIntervalsForCalendar(config, calendarId, startMs, endMs) {
  const query = new URLSearchParams({
    locationId: config.locationId,
    calendarId,
    startTime: String(startMs),
    endTime: String(endMs)
  });
  const data = await ghlRequest(config, `/calendars/events?${query}`, { version: CALENDAR_API_VERSION });
  return (data.events || [])
    .filter(event => !event.deleted && String(event.appointmentStatus || '') !== 'cancelled')
    .map(event => ({
      id: event.id,
      start: Date.parse(event.startTime),
      end: Date.parse(event.endTime)
    }))
    .filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end));
}

// Busy intervals for every van, in resource order.
async function busyIntervalsByResource(config, startMs, endMs) {
  return Promise.all(config.resources.map(resource =>
    busyIntervalsForCalendar(config, resource.calendarId, startMs, endMs)
  ));
}

// Creates a confirmed appointment on a van's calendar. Used by the membership sync,
// which writes a visit that is already paid for and already allocated, so
// `ignoreFreeSlotValidation` stays on here: the slot was decided upstream and
// re-validating it would only reject our own reservation. The website's booking path
// does NOT come through here — it uses createHoldAppointment, which validates.
async function createCalendarEvent(config, { calendarId, contactId, title, description, address, startTime, endTime, status = 'confirmed' }) {
  const result = await ghlRequest(config, '/calendars/events/appointments', {
    method: 'POST',
    version: CALENDAR_API_VERSION,
    body: {
      calendarId,
      locationId: config.locationId,
      contactId,
      title: String(title).slice(0, 160),
      appointmentStatus: status,
      description,
      address,
      meetingLocationType: 'address',
      overrideLocationConfig: true,
      startTime,
      endTime,
      ignoreDateRange: true,
      ignoreFreeSlotValidation: true,
      toNotify: false
    }
  });
  const appointment = result.appointment || result;
  if (!appointment || !appointment.id) throw new HighLevelError(502);
  return {
    id: appointment.id,
    startTime: appointment.startTime || startTime,
    endTime: appointment.endTime || endTime
  };
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

// One contact per customer, matched on phone/email by HighLevel itself.
//
// Lives here rather than in quote.js because the hold needs it too: a hold is now an
// appointment, and an appointment needs a contact. Upserting twice for one booking is
// harmless — `createNewIfDuplicateAllowed: false` means the second call returns the
// same contact instead of minting a duplicate.
async function upsertContact(config, customer) {
  const names = splitName(customer.name);
  const body = {
    locationId: config.locationId,
    name: customer.name,
    firstName: names.firstName,
    lastName: names.lastName,
    phone: customer.phone,
    address1: customer.address,
    city: customer.city,
    postalCode: customer.zip,
    country: 'US',
    source: 'L&B Website Booking',
    assignedTo: config.assignedUserId,
    createNewIfDuplicateAllowed: false
  };
  if (customer.email) body.email = customer.email;

  const result = await ghlRequest(config, '/contacts/upsert', {
    method: 'POST',
    version: CALENDAR_API_VERSION,
    body
  });
  const contact = result.contact || result;
  if (!contact || !contact.id) throw new HighLevelError(502);
  return contact;
}

// The hold's footprint in HighLevel: an appointment in the `new` status.
//
// This used to be a BLOCK SLOT, on the reasoning that a hold happens before the
// customer is known and appointments require a contact. Both halves were wrong:
//
//   · Block slots DO NOT WORK on these calendars. Verified against the live
//     sub-account on 2026-08-04: `POST /calendars/events/block-slots` answers
//     400 "The calendar is not an event calendar." on every van, with API versions
//     2021-07-28 and 2021-04-15. The vans are Personal calendars; block slots need
//     an event calendar. Every hold has been failing in production because of it.
//   · The customer IS known by then. The contact fields live in the same wizard
//     step as the calendar and are validated before the hold is attempted, so the
//     hold can upsert the contact and use it.
//
// `ignoreFreeSlotValidation` is deliberately FALSE, which is the other half of the
// change. HighLevel then refuses an overlapping appointment itself — 400 "The slot
// you have selected is no longer available." — and it serializes concurrent
// attempts (4 racing requests, exactly 1 winner, three runs, verified). That makes
// the CRM a real guard rather than a mirror, which is what lets Postgres go
// (see DISENO-SIN-BASE-DE-DATOS.md).
//
// `ignoreDateRange` stays TRUE: the website owns the notice and grid rules
// (30-minute starts, per-cart lengths, 48h for memberships), and they are already
// enforced server-side in catalog.js.
async function createHoldAppointment(config, { calendarId, contactId, title, description, address, startTime, endTime }) {
  const result = await ghlRequest(config, '/calendars/events/appointments', {
    method: 'POST',
    version: CALENDAR_API_VERSION,
    // Needed only so isSlotTakenError can tell "the van just went" apart from a
    // genuine integration fault. The message is regex-matched and never returned to
    // the browser, and safeDiagnosticMessage has already redacted emails, phone
    // numbers, secrets and long identifiers out of it.
    diagnostic: true,
    body: {
      calendarId,
      locationId: config.locationId,
      contactId,
      title: String(title).slice(0, 160),
      // `new` is the hold; a verified payment promotes it to `confirmed`.
      appointmentStatus: 'new',
      ...(description ? { description } : {}),
      ...(address ? { address, meetingLocationType: 'address', overrideLocationConfig: true } : {}),
      startTime,
      endTime,
      ignoreDateRange: true,
      ignoreFreeSlotValidation: false,
      toNotify: false
      // NO assignedUserId. Each van has its own PERSONAL calendar whose single team
      // member is that van's user, and HighLevel answers 422 "The user id not part
      // of calendar team." when an appointment on it is assigned to anyone else —
      // which is exactly what happened when this function inherited
      // `config.assignedUserId` (the office user) from the block-slot code it
      // replaced. Verified against the live sub-account: the office user 422s, the
      // calendar's own member and omitting the field both return 201. The van's
      // calendar already says who does the work, so omitting it is also the truth.
    }
  });
  const appointment = result.appointment || result;
  if (!appointment || !appointment.id) throw new HighLevelError(502);
  return { id: appointment.id, startTime, endTime };
}

// HighLevel's refusal when the van is already taken for that window. Distinguished
// from every other 400 so the caller can answer "that slot just went" (409) instead
// of "the CRM is broken" (502).
const SLOT_TAKEN_PATTERN = /slot .*(no longer available|not available|already)/i;

function isSlotTakenError(error) {
  return error instanceof HighLevelError &&
    error.upstreamStatus === 400 &&
    SLOT_TAKEN_PATTERN.test(String(error.diagnosticMessage || ''));
}

// Moves an existing appointment along the status machine, optionally relabelling
// it. `ignoreFreeSlotValidation` is TRUE here on purpose and it is not the same
// decision as on creation: the slot is ALREADY ours, so re-validating it against
// itself is what would fail. Creation is the step that must be validated.
async function updateCalendarEvent(config, eventId, { status, title, description } = {}) {
  await ghlRequest(config, `/calendars/events/appointments/${encodeURIComponent(eventId)}`, {
    method: 'PUT',
    version: CALENDAR_API_VERSION,
    body: {
      ...(status ? { appointmentStatus: status } : {}),
      ...(title ? { title: String(title).slice(0, 160) } : {}),
      ...(description ? { description } : {}),
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
      toNotify: false
    }
  });
}

function updateCalendarEventStatus(config, eventId, status) {
  return updateCalendarEvent(config, eventId, { status });
}

async function deleteCalendarEvent(config, eventId) {
  await ghlRequest(config, `/calendars/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    version: CALENDAR_API_VERSION
  });
}

// Compensation path: drop external events we created for a hold that then failed.
// Never throws — the caller is already handling a failure, and an event that
// survives is visible in the CRM and can be removed by hand. Returns the ids it
// could not delete so they can be logged and retried by the expiry sweeper.
async function deleteCalendarEventsQuietly(config, eventIds) {
  const failures = [];
  for (const eventId of eventIds.filter(Boolean)) {
    try {
      await deleteCalendarEvent(config, eventId);
    } catch (error) {
      failures.push(eventId);
      console.error('[ghl-compensate]', eventId, error.name || 'Error', error.statusCode || 502);
    }
  }
  return failures;
}

module.exports = {
  GHL_BASE_URL,
  CALENDAR_API_VERSION,
  safeDiagnosticHint,
  safeDiagnosticMessage,
  RESOURCE_ENV_VARS,
  wait,
  resources,
  getConfig,
  getPaymentsConfig,
  ghlRequest,
  isTransientGhlError,
  busyIntervalsForCalendar,
  busyIntervalsByResource,
  upsertContact,
  splitName,
  calendarEventsForCalendar,
  createCashInvoice,
  recordCashPayment,
  createHoldAppointment,
  isSlotTakenError,
  createCalendarEvent,
  updateCalendarEvent,
  updateCalendarEventStatus,
  deleteCalendarEvent,
  deleteCalendarEventsQuietly
};
