'use strict';

const { RequestError, HighLevelError } = require('./errors.js');

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_REQUEST_TIMEOUT_MS = 10 * 1000;
// Backoff (ms) before each GET attempt when the previous one hit a transient
// HighLevel error; first entry is 0 (no wait before the initial try).
const GHL_READ_RETRY_BACKOFF_MS = [0, 400, 1200];
const CALENDAR_API_VERSION = '2021-07-28';

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
    throw new HighLevelError(response.status, statusCode);
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

// Creates the blocking appointment for ONE vehicle on ONE van's calendar.
// ignoreFreeSlotValidation is on because the website owns the grid (30-minute
// starts, per-vehicle lengths) — a shape HighLevel's own slot validation cannot
// express. Postgres already decided this van is free; this call is what stops a
// human in the CRM from double-booking it.
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

// The hold's footprint in HighLevel.
//
// A hold happens before we know who the customer is, and HighLevel appointments
// require a contact — so a hold is written as a BLOCK SLOT instead, the same
// primitive the office uses to mark a van unavailable. That is what stops someone
// booking the van by hand into a slot the website has already promised (rule: the
// hold must block the external calendar too).
//
// Endpoint: POST /calendars/events/block-slots, Version 2021-07-28. On
// confirmation the real appointment is created first and the block removed after
// (see agenda.confirmPayment), so the van is never momentarily free.
async function createBlockSlot(config, { calendarId, title, startTime, endTime, assignedUserId }) {
  const result = await ghlRequest(config, '/calendars/events/block-slots', {
    method: 'POST',
    version: CALENDAR_API_VERSION,
    body: {
      calendarId,
      locationId: config.locationId,
      title: String(title).slice(0, 160),
      startTime,
      endTime,
      assignedUserId: assignedUserId || config.assignedUserId
    }
  });
  const event = result.event || result;
  if (!event || !event.id) throw new HighLevelError(502);
  return { id: event.id, startTime, endTime };
}

async function updateCalendarEventStatus(config, eventId, status) {
  await ghlRequest(config, `/calendars/events/appointments/${encodeURIComponent(eventId)}`, {
    method: 'PUT',
    version: CALENDAR_API_VERSION,
    body: { appointmentStatus: status }
  });
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
  RESOURCE_ENV_VARS,
  wait,
  resources,
  getConfig,
  getPaymentsConfig,
  ghlRequest,
  isTransientGhlError,
  busyIntervalsForCalendar,
  busyIntervalsByResource,
  createBlockSlot,
  createCalendarEvent,
  updateCalendarEventStatus,
  deleteCalendarEvent,
  deleteCalendarEventsQuietly
};
