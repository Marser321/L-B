'use strict';

// The agenda, with the CRM as the only store.
//
// One rule explains the shape of a visit: a visit is ONE van at ONE address, working
// through the vehicles in the driveway one after another. So the services ADD UP —
// three cars is three services plus one travel buffer, on a single van, in one
// contiguous block. The fleet size caps how many separate CUSTOMERS can be served at
// the same hour, never how many vehicles one customer may bring.
//
// A second rule explains where the state lives: the reservation IS an appointment on
// the van's calendar, and `appointmentStatus` is its whole state machine.
//
//   new        reserved, waiting for payment   (what used to be a 15-minute hold row)
//   confirmed  paid
//   cancelled  released
//   showed     delivered
//
// There is no database. Everything the agenda needs to decide is readable from the
// four calendars: what is busy, which of our own holds have lapsed, and whether this
// exact request was already held (its Idempotency-Key is written into the
// appointment's description). That is why the crew panel and the member portal — both
// written against the calendar — kept working while this file still needed Postgres.
//
// What replaced the transaction: HighLevel validates and serialises appointment
// creation itself. Verified against the live sub-account on 2026-08-04 — an
// overlapping appointment is refused with 400 "The slot you have selected is no
// longer available.", and of four identical concurrent requests exactly one wins,
// three runs in a row. So the race for the last van is arbitrated upstream, by the
// same system that owns the calendar.
//
// What that costs, honestly: the FORMAL atomicity guarantee. HighLevel's behaviour is
// server-side validation, not a documented transactional contract. The two probes in
// scripts/probe-ghl-slot-*.mjs re-check it in ten seconds if it ever changes.
//
// Expiry is LAZY, because the Hobby plan allows one cron a day and a 15-minute hold
// cannot wait for it: a `new` appointment past its own `expira` is treated as free
// when computing availability, and deleted on sight when it blocks a booking. The
// daily sweep is a tidy-up, not the mechanism.

const crypto = require('node:crypto');

const { RequestError, SlotUnavailableError, IdempotencyConflictError } = require('./errors.js');
const catalog = require('./catalog.js');
const pricing = require('./pricing.js');
const ghl = require('./ghl.js');
const time = require('./time.js');

// How long a customer has to finish paying before the van goes back on the market.
const HOLD_TTL_MS = 15 * 60 * 1000;

// Appointment statuses that mean the van is NOT working that window.
const FREE_STATUSES = Object.freeze(['cancelled', 'invalid']);

// Appointment statuses that mean the visit was already delivered. They are terminal:
// a delivered visit is never released, expired or re-confirmed.
const DELIVERED_STATUSES = Object.freeze(['showed', 'noshow']);

function toCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

// Stable fingerprint of what a hold request is asking for. Two requests with the
// same Idempotency-Key must describe the same thing; if they don't, the second is
// a bug or an attack, not a retry.
function fingerprintRequest({ date, startTime, vehicles }) {
  const canonical = JSON.stringify({
    date,
    startTime,
    vehicles: vehicles.map(vehicle => ({
      packageId: vehicle.packageId,
      sizeId: vehicle.sizeId,
      addonIds: [...vehicle.addonIds].sort()
    }))
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ── The appointment as the record ──────────────────────────────────────────

// The description is a `·`-separated list of `key: value` pairs. It is read by two
// very different consumers, which is why the format is fixed here and not inlined:
// this file rebuilds a whole hold out of it, and the crew panel reads `orden:`,
// `total:` and `deposito:` off the same string to tell a crew what to collect.
//
// A '·' can therefore never appear INSIDE a value — the crew panel's parser stops at
// the next one, and a two-car stop once showed the crew a single car for exactly that
// reason.
const FIELD_SEPARATOR = ' · ';

// Where each vehicle sits in the van's chain, as `index:serviceMinutes:offsetMinutes`.
// This is what makes a row per vehicle unnecessary: "car 2 starts an hour in" is the
// visit's start plus an offset, and both numbers fit in the appointment that already
// has to exist.
function encodeVehicles(vehicles) {
  return vehicles
    .map(vehicle => [
      vehicle.vehicleIndex,
      Math.round(vehicle.serviceMinutes || 0),
      Math.round(vehicle.offsetMinutes || 0)
    ].join(':'))
    .join(',');
}

function decodeVehicles(raw) {
  return String(raw || '')
    .split(',')
    .map(entry => entry.trim().split(':').map(Number))
    .filter(parts => parts.length === 3 && parts.every(Number.isFinite))
    .map(([vehicleIndex, serviceMinutes, offsetMinutes]) => ({
      vehicleIndex, serviceMinutes, offsetMinutes
    }));
}

function buildDescription(fields) {
  return [
    fields.idempotencyKey && `key: ${fields.idempotencyKey}`,
    fields.requestFingerprint && `fp: ${fields.requestFingerprint}`,
    fields.submissionId && `sub: ${fields.submissionId}`,
    fields.opportunityId && `opp: ${fields.opportunityId}`,
    fields.failureReason && `fallo: ${fields.failureReason}`,
    fields.expiresAtMs && `expira: ${new Date(fields.expiresAtMs).toISOString()}`,
    fields.vehicles && fields.vehicles.length && `veh: ${encodeVehicles(fields.vehicles)}`,
    fields.bookingMode && `modo: ${fields.bookingMode}`,
    fields.runningOrder && `orden: ${fields.runningOrder}`,
    fields.estimateLabel && `total: ${fields.estimateLabel}`,
    fields.depositCents != null && `deposito: $${(fields.depositCents / 100).toFixed(0)}`
  ].filter(Boolean).join(FIELD_SEPARATOR);
}

// HighLevel returns the description as `notes` on a listing and as `notes` or
// `description` on a single appointment, depending on the endpoint. Read both rather
// than picking one and being wrong on half the calls.
function descriptionOf(event) {
  return String((event && (event.notes || event.description)) || '');
}

function fieldFrom(source, name) {
  // Anchored to a field boundary so `total:` cannot match the tail of another key
  // that happens to end in it, and stopping at the next '·' so one value cannot eat
  // the rest of the list.
  const match = source.match(new RegExp(`(?:^|·)\\s*${name}:?\\s*([^·]*)`, 'i'));
  return match ? match[1].trim() : '';
}

function parseHoldFields(event) {
  const source = descriptionOf(event);
  const expira = fieldFrom(source, 'expira');
  const expiresAtMs = expira ? Date.parse(expira) : NaN;
  const depositRaw = fieldFrom(source, 'deposito').replace(/[$,]/g, '');
  const depositAmount = Number(depositRaw);
  return {
    idempotencyKey: fieldFrom(source, 'key'),
    requestFingerprint: fieldFrom(source, 'fp'),
    submissionId: fieldFrom(source, 'sub'),
    opportunityId: fieldFrom(source, 'opp'),
    failureReason: fieldFrom(source, 'fallo'),
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    vehicles: decodeVehicles(fieldFrom(source, 'veh')),
    bookingMode: fieldFrom(source, 'modo') || 'slot',
    runningOrder: fieldFrom(source, 'orden'),
    estimateLabel: fieldFrom(source, 'total'),
    depositCents: Number.isFinite(depositAmount) && depositRaw ? toCents(depositAmount) : 0
  };
}

// Is this appointment one of OURS, taken by the website and still unpaid?
//
// The distinction matters because only our own lapsed holds may be deleted to make
// room. An appointment the office typed in by hand is also `new` and must be treated
// as untouchable — it has no `key:`/`expira:` fields, so it never looks like a hold.
function isWebsiteHold(event) {
  if (String(event.appointmentStatus || '') !== 'new') return false;
  const fields = parseHoldFields(event);
  return Boolean(fields.idempotencyKey && fields.expiresAtMs);
}

function isLapsedHold(event, now) {
  if (!isWebsiteHold(event)) return false;
  return parseHoldFields(event).expiresAtMs <= now;
}

// Whether the van is unavailable for this window.
//
// Cancelled and invalid appointments free the slot, and so does one of our own holds
// whose fifteen minutes ran out — that is the lazy expiry, and it is why an abandoned
// checkout costs the business a quarter of an hour of capacity instead of the rest of
// the day.
function isBlocking(event, now) {
  if (event.deleted) return false;
  if (FREE_STATUSES.includes(String(event.appointmentStatus || ''))) return false;
  if (isLapsedHold(event, now)) return false;
  return true;
}

function intervalsFrom(events, now) {
  return events
    .filter(event => isBlocking(event, now))
    .map(event => ({ id: event.id, start: Date.parse(event.startTime), end: Date.parse(event.endTime) }))
    .filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end));
}

// ── Windows ────────────────────────────────────────────────────────────────

// Where each vehicle sits in time.
//
// ONE van goes to ONE address and works through the vehicles in the driveway one
// after another, so the vehicles are laid out BACK TO BACK in cart order: vehicle
// k starts exactly where vehicle k-1 finished. The visit lasts the sum of the
// services plus one trailing buffer, which rides on the last vehicle's window.
function visitWindow(vehicles, date, startTime, timezone) {
  const packageIds = vehicles.map(vehicle => vehicle.packageId);
  const fullDay = catalog.bookingModeForPackages(packageIds) === 'full_day';
  // A full-day service takes the van's whole day, so it cannot share a visit with
  // another vehicle: chaining two day-long blocks is 20 hours and fits nowhere.
  // The cart cap (catalog.maxVehiclesForPackages) rejects this earlier and with a
  // better message; this is the backstop that keeps the failure legible instead of
  // reappearing as "the selected time does not fit in the working day" — the shape
  // it had while a paint cart silently reported no availability on every date.
  if (fullDay && vehicles.length > 1) {
    throw new RequestError('Paint protection reserves the whole day, so it is booked on its own', 422, 'FULL_DAY_BOOKED_ALONE');
  }
  const effectiveStart = fullDay ? time.BUSINESS_DAY.start : startTime;

  if (!time.START_TIME_PATTERN.test(effectiveStart || '')) throw new RequestError('startTime is invalid');
  const startMinutes = time.minutesFromTime(effectiveStart);
  if (!fullDay && startMinutes % time.SLOT_GRID_MINUTES !== 0) throw new RequestError('startTime is invalid');

  const dayStart = time.minutesFromTime(time.BUSINESS_DAY.start);
  const dayEnd = time.minutesFromTime(time.BUSINESS_DAY.end);
  const fullDayMinutes = dayEnd - dayStart;
  if (startMinutes < dayStart) throw new RequestError('The selected time does not fit in the working day');

  const startMs = time.zonedDateTimeToMs(date, effectiveStart, timezone);
  // Paint work holds the van for the whole day, so the cart collapses into one
  // day-long block instead of a chain.
  const trailingBuffer = fullDay ? 0 : catalog.visitBufferMinutes(packageIds);
  const lastIndex = vehicles.length - 1;

  let cursorMinutes = startMinutes;
  const perVehicle = vehicles.map((vehicle, index) => {
    const serviceMinutes = fullDay ? fullDayMinutes : catalog.vehicleServiceMinutes(vehicle.packageId);
    const vehicleStartMinutes = cursorMinutes;
    // The van stays blocked through the travel buffer after the last vehicle.
    const blockMinutes = serviceMinutes + (index === lastIndex ? trailingBuffer : 0);
    const endMinutes = vehicleStartMinutes + blockMinutes;
    if (endMinutes > dayEnd) throw new RequestError('The selected time does not fit in the working day');
    cursorMinutes = endMinutes;
    return {
      ...vehicle,
      serviceMinutes,
      // What the van is blocked for, which is the service plus the trailing buffer
      // on the last vehicle only.
      durationMinutes: blockMinutes,
      // Minutes after the visit's start time that this vehicle begins, so the crew
      // sheet and the UI can say "car 2 at 9am" without recomputing the chain.
      offsetMinutes: vehicleStartMinutes - startMinutes,
      startMs: time.zonedDateTimeToMs(date, time.timeFromMinutes(vehicleStartMinutes), timezone),
      endMs: time.zonedDateTimeToMs(date, time.timeFromMinutes(endMinutes), timezone)
    };
  });

  return {
    fullDay,
    bookingMode: fullDay ? 'full_day' : 'slot',
    startTime: effectiveStart,
    startMs,
    // The visit ends when the van finishes the LAST vehicle and its buffer — the
    // sum of the chain, never the longest single vehicle.
    endMs: perVehicle[perVehicle.length - 1].endMs,
    serviceMinutes: perVehicle.reduce((total, vehicle) => total + vehicle.serviceMinutes, 0),
    bufferMinutes: trailingBuffer,
    perVehicle
  };
}

// ── Allocation ─────────────────────────────────────────────────────────────

// Which van the rotation starts from.
//
// This used to be a row (`resource_rotation`) read and written under a lock, for one
// job: spread consecutive bookings across the fleet instead of hammering van 1. The
// same answer is DERIVABLE from the day we have already read — how many visits are on
// the fleet's calendars today — so the counter is not state anybody has to keep.
//
// Deriving it from a count rather than from the date matters: a date alone gives every
// booking of the day the same starting van, and van 1 would work the whole day while
// three sat idle until it was busy. Counting what is already booked advances the
// cursor exactly the way the row did.
//
// It is also retry-safe. A create that failed left nothing on the calendar, so the
// retry counts the same appointments and picks the same van: the second attempt is the
// same attempt, not a second reservation somewhere else.
function rotationCursor(dayEvents, count) {
  if (!count) return 0;
  const booked = dayEvents.reduce((total, events) => total + events.filter(event => {
    if (event.deleted) return false;
    if (FREE_STATUSES.includes(String(event.appointmentStatus || ''))) return false;
    return Boolean(parseHoldFields(event).idempotencyKey);
  }).length, 0);
  return booked % count;
}

// Picks the ONE van that serves the whole visit, starting at the rotation cursor.
//
// One address, one van: the crew drives to the customer once and works through every
// vehicle in the driveway. So this looks for a single van free across the ENTIRE
// visit — first vehicle's start to last vehicle's end, buffer included. A van free
// for the first two cars but busy for the third is not a usable allocation: the crew
// cannot hand the driveway over to a different van halfway through.
function allocateResources({ resources, busyByResource, perVehicle, cursor }) {
  const count = resources.length;
  if (!count || !perVehicle.length) return null;

  const visitStartMs = perVehicle[0].startMs;
  const visitEndMs = perVehicle[perVehicle.length - 1].endMs;

  const rotationOffset = Array.from({ length: count }, (unused, offset) => offset).find(offset => {
    const busy = busyByResource[(cursor + offset) % count] || [];
    return time.isFreeAcross(busy, visitStartMs, visitEndMs);
  });
  if (rotationOffset === undefined) return null;

  const resource = resources[(cursor + rotationOffset) % count];
  return { resource, resourceIndex: (cursor + rotationOffset) % count };
}

function dayBounds(date, timezone) {
  return {
    fromMs: time.zonedDateTimeToMs(date, '00:00', timezone),
    toMs: time.zonedDateTimeToMs(time.addDays(date, 1), '00:00', timezone)
  };
}

// ── Availability ───────────────────────────────────────────────────────────

// Start times where the whole visit fits on one van. A slot is offered only when a
// van is free for the entire chain — which is why a 4-vehicle cart sees far fewer
// slots than a 1-vehicle cart, and never one that would collapse into a queue.
async function computeAvailability({ vehicles, from, to, language = 'en', now = Date.now(), config = null }) {
  // Only the vans switched on in the CRM. With none on, every slot allocates to
  // nothing and the customer sees an empty calendar — the honest answer, and the same
  // one they would get on a fully booked week.
  const activeConfig = await ghl.withActiveResources(config || ghl.getConfig());
  const timezone = time.bookingTimezone();
  const resources = activeConfig.resources;

  const packageIds = vehicles.map(vehicle => vehicle.packageId);
  const noticeMs = catalog.noticeMsForPackages(packageIds);
  const bookingMode = catalog.bookingModeForPackages(packageIds);
  // One van works the whole driveway, so the visit is the SUM of the services plus
  // one trailing buffer — not the longest single vehicle.
  const visitMinutes = bookingMode === 'full_day'
    ? time.minutesFromTime(time.BUSINESS_DAY.end) - time.minutesFromTime(time.BUSINESS_DAY.start)
    : catalog.visitDurationMinutes(packageIds);

  const rangeFrom = time.zonedDateTimeToMs(from, '00:00', timezone);
  const rangeTo = time.zonedDateTimeToMs(time.addDays(to, 1), '00:00', timezone);

  const events = await ghl.eventsByResource(activeConfig, rangeFrom, rangeTo);
  const busyByResource = events.map(list => intervalsFrom(list, now));

  const dates = [];
  for (const date of time.datesBetween(from, to)) {
    if (time.isSunday(date)) continue;
    const slots = [];
    for (const startTime of time.gridStartTimes(visitMinutes)) {
      let window;
      try {
        window = visitWindow(vehicles, date, startTime, timezone);
      } catch (error) {
        continue;
      }
      if (window.startMs < now + noticeMs) continue;
      // The cursor only decides WHICH free van gets used, never WHETHER one is free,
      // so availability reads it as 0 without touching the rotation.
      if (!allocateResources({ resources, busyByResource, perVehicle: window.perVehicle, cursor: 0 })) continue;
      slots.push({
        start: window.startTime,
        startsAt: new Date(window.startMs).toISOString(),
        endsAt: new Date(window.endMs).toISOString()
      });
      if (bookingMode === 'full_day') break;
    }
    if (slots.length) dates.push({ date, slots });
  }

  const estimate = vehicles.every(vehicle => vehicle.sizeId)
    ? pricing.estimateForVehicles(vehicles.map(vehicle => ({
        packageId: vehicle.packageId, sizeId: vehicle.sizeId, addonIds: vehicle.addonIds
      })), language === 'es' ? 'es' : 'en')
    : null;

  return {
    timezone,
    bookingMode,
    vehicleCount: vehicles.length,
    // Additive contract fields. The browser uses these instead of recreating
    // the membership regex or its own capacity/duration rules.
    noticeHours: noticeMs / (60 * 60 * 1000),
    // Hands-on minutes per vehicle, in cart order. One van works them back to back,
    // so these ADD UP to the visit — the UI shows them as a running schedule
    // ("car 1 at 8am, car 2 at 9am"), not as parallel vans.
    perVehicleDurationMinutes: vehicles.map(vehicle => catalog.vehicleServiceMinutes(vehicle.packageId)),
    // How long the customer's driveway is occupied: the sum above plus one travel
    // buffer at the end.
    visitDurationMinutes: visitMinutes,
    maxVehicles: catalog.maxVehiclesForPackages(packageIds),
    deposit: catalog.depositForPackages(packageIds),
    ...(estimate ? { estimate: { min: estimate.min, max: estimate.max, label: estimate.label } } : {}),
    dates
  };
}

// ── Reading a hold back off the calendar ───────────────────────────────────

// The public status of a hold, derived from the appointment's own status and its
// deadline. Nothing here is stored: a `new` appointment past `expira` IS expired,
// whether or not any sweep has run.
function publicHoldStatus(hold, now = Date.now()) {
  if (hold.status === 'confirmed' || hold.status === 'delivered') return { status: 'confirmed', reason: '' };
  if (hold.status === 'released') {
    // A cancelled hold that says WHY. The checkout screen has to tell "your card was
    // declined" apart from "you changed your mind", and the appointment is the only
    // place left to write that down.
    return hold.failureReason === 'payment_failed'
      ? { status: 'payment_failed', reason: 'PAYMENT_FAILED' }
      : { status: 'released', reason: 'HOLD_RELEASED' };
  }
  if (hold.expiresAtMs && hold.expiresAtMs <= now) return { status: 'expired', reason: 'HOLD_EXPIRED' };
  // A hold that has been through /api/quote is waiting for money; one that has not is
  // still just a held slot. `sub:` is written when the customer is attached.
  if (hold.submissionId) return { status: 'pending_payment', reason: '' };
  return { status: 'active', reason: '' };
}

// One appointment, read as a hold. `null` for an appointment that is not ours.
function holdFromEvent(event, resource, timezone) {
  const fields = parseHoldFields(event);
  const startMs = Date.parse(event.startTime);
  const endMs = Date.parse(event.endTime);
  const appointmentStatus = String(event.appointmentStatus || 'new');
  const status = DELIVERED_STATUSES.includes(appointmentStatus) ? 'delivered'
    : appointmentStatus === 'confirmed' ? 'confirmed'
    : FREE_STATUSES.includes(appointmentStatus) ? 'released'
    : 'active';

  return {
    id: event.id,
    // Same value, kept under the old name: the /api/quote and webhook responses
    // report it and the office reads it off HighLevel.
    parentBookingId: event.id,
    appointmentStatus,
    status,
    calendarId: String(event.calendarId || (resource && resource.calendarId) || ''),
    resourceKey: resource ? resource.key : '',
    contactId: String(event.contactId || ''),
    title: String(event.title || ''),
    slotStartMs: startMs,
    slotEndMs: endMs,
    slotDate: time.todayInZone(startMs, timezone),
    timezone,
    bookingMode: fields.bookingMode,
    vehicleCount: fields.vehicles.length || 1,
    depositCents: fields.depositCents,
    expiresAtMs: fields.expiresAtMs,
    idempotencyKey: fields.idempotencyKey,
    failureReason: fields.failureReason,
    requestFingerprint: fields.requestFingerprint,
    submissionId: fields.submissionId,
    opportunityId: fields.opportunityId,
    quote: { vehicles: fields.vehicles },
    fields
  };
}

// The shape every caller has always received. One van, named once, plus the running
// order derived from the visit's start and each vehicle's offset.
function describeHold(hold) {
  const startMs = hold.slotStartMs;
  return {
    holdId: hold.id,
    status: hold.status,
    timezone: hold.timezone,
    bookingMode: hold.bookingMode,
    slotStart: new Date(startMs).toISOString(),
    slotEnd: new Date(hold.slotEndMs).toISOString(),
    expiresAt: hold.expiresAtMs ? new Date(hold.expiresAtMs).toISOString() : '',
    deposit: hold.depositCents / 100,
    vehicleCount: hold.vehicleCount,
    resource: hold.resourceKey || null,
    visitDurationMinutes: Math.round((hold.slotEndMs - startMs) / 60000),
    // Kept as an array so existing clients keep working, but it is the running order
    // of one van's day at this address, not a list of parallel vans.
    assignments: hold.quote.vehicles.map(vehicle => ({
      vehicleIndex: vehicle.vehicleIndex,
      resource: hold.resourceKey || null,
      startsAt: new Date(startMs + vehicle.offsetMinutes * 60000).toISOString(),
      endsAt: new Date(startMs + (vehicle.offsetMinutes + vehicle.serviceMinutes) * 60000).toISOString(),
      durationMinutes: vehicle.serviceMinutes
    }))
  };
}

// Finds the van a hold lives on. The appointment reports its own calendar; the
// resource list turns that into the key the rest of the system speaks in.
function resourceForEvent(config, event) {
  const calendarId = String((event && event.calendarId) || '');
  return config.resources.find(resource => resource.calendarId === calendarId) || null;
}

async function loadHold(holdId, { config = null } = {}) {
  const activeConfig = config || ghl.getConfig();
  const event = await ghl.getAppointment(activeConfig, holdId);
  if (!event) return null;
  return holdFromEvent(event, resourceForEvent(activeConfig, event), time.bookingTimezone());
}

// Public, PII-free status for the checkout countdown/poller.
async function describeHoldStatus(holdId, { now = Date.now(), config = null } = {}) {
  const hold = await loadHold(holdId, { config });
  if (!hold) throw new RequestError('Hold not found', 404, 'HOLD_NOT_FOUND');
  return { ...describeHold(hold), ...publicHoldStatus(hold, now) };
}

// Loads a hold the browser claims to own and refuses it unless it is still live.
// An expired or released hold is a 409, not a 404: the slot existed, it just isn't
// the customer's any more.
async function getHoldForRequest(holdId, { now = Date.now(), config = null } = {}) {
  const hold = await loadHold(holdId, { config });
  if (!hold) throw new RequestError('Hold not found', 404, 'HOLD_NOT_FOUND');
  // An already-confirmed booking is returned as-is so a resubmitted form is a no-op
  // rather than an error.
  if (hold.status === 'confirmed' || hold.status === 'delivered') return hold;
  if (hold.status !== 'active') throw new SlotUnavailableError('This hold is no longer valid');
  if (hold.expiresAtMs && hold.expiresAtMs <= now) throw new RequestError('This hold has expired', 409, 'HOLD_EXPIRED');
  return hold;
}

async function describeExistingHold(hold) {
  return { ...describeHold(hold), requestFingerprint: hold.requestFingerprint };
}

// Every appointment on the fleet's calendars over the booking window.
//
// Used by the two lookups that do not know a date: "which hold belongs to this
// submission id" and the daily sweep. It is four calls — one per van — regardless of
// how wide the window is, because the listing endpoint takes a range.
async function scanFleet(config, { now = Date.now(), backDays = 1, forwardDays = catalog.BOOKING_WINDOW_DAYS + 1 } = {}) {
  const timezone = time.bookingTimezone();
  const today = time.todayInZone(now, timezone);
  const fromMs = time.zonedDateTimeToMs(time.addDays(today, -backDays), '00:00', timezone);
  const toMs = time.zonedDateTimeToMs(time.addDays(today, forwardDays), '00:00', timezone);
  const perResource = await ghl.eventsByResource(config, fromMs, toMs);
  return perResource.flatMap((events, index) => events.map(event => ({
    event,
    resource: config.resources[index]
  })));
}

// The payment webhook may only know the submission id (HighLevel workflows are
// easier to configure with one). Map it back to the appointment waiting to be paid.
async function resolveHoldIdBySubmission(submissionId, { config = null, now = Date.now() } = {}) {
  const activeConfig = config || ghl.getConfig();
  const found = (await scanFleet(activeConfig, { now }))
    .find(entry => parseHoldFields(entry.event).submissionId === String(submissionId));
  return found ? found.event.id : null;
}

// ── Holds ──────────────────────────────────────────────────────────────────

function assertBookable(window, vehicles, date, now, timezone) {
  const packageIds = vehicles.map(vehicle => vehicle.packageId);
  const today = time.todayInZone(now, timezone);
  if (date < today) throw new RequestError('date is in the past');
  if (date > time.addDays(today, catalog.BOOKING_WINDOW_DAYS)) throw new RequestError('date is too far ahead');
  if (time.isSunday(date)) throw new RequestError('The crew does not work on Sundays');
  // 48 hours for memberships only; everything else keeps the one-hour notice.
  const noticeMs = catalog.noticeMsForPackages(packageIds);
  if (window.startMs < now + noticeMs) {
    throw new SlotUnavailableError(
      packageIds.some(catalog.isMembershipPackage)
        ? 'Memberships must be booked at least 48 hours in advance'
        : 'That start time is too soon'
    );
  }
}

// The running order the crew works through at this address, so one block on the
// calendar still says what happens and when.
function runningOrderFor(window, timezone) {
  return window.perVehicle
    .map(vehicle => {
      const at = new Date(vehicle.startMs);
      const clock = at.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
      return `${clock} ${vehicle.packageId}`;
    })
    // Joined with a comma, NOT the '·' that separates the description's own fields:
    // the crew panel reads `orden:` up to the next '·', so using it inside the value
    // truncated the list to the first vehicle — a two-car stop showed one car.
    .join(', ');
}

// Creates a 15-minute hold on ONE van, or fails without leaving a trace.
//
// Returns { replayed: true, ... } when the same Idempotency-Key already holds this
// exact request, so a browser that retries a dropped response gets its original hold
// back instead of a second van.
//
// `customer` is required: the hold IS an appointment, and appointments need a
// contact. The wizard already has the customer validated by the time it picks a time,
// so this costs the caller nothing.
async function acquireHold({ idempotencyKey, date, startTime, vehicles, customer = null, contactId = '', now = Date.now(), config = null }) {
  const activeConfig = await ghl.withActiveResources(config || ghl.getConfig());
  const timezone = time.bookingTimezone();
  const resources = activeConfig.resources;

  if (!resources.length) {
    // The fleet size caps how many ADDRESSES can be served at once, never how many
    // vehicles one customer may bring. So the only way to get here is with no van
    // working at all: either none configured, or every one switched off in the CRM.
    throw new SlotUnavailableError('No vans are working at that time');
  }

  const window = visitWindow(vehicles, date, startTime, timezone);
  assertBookable(window, vehicles, date, now, timezone);

  const fingerprint = fingerprintRequest({ date, startTime: window.startTime, vehicles });
  const packageIds = vehicles.map(vehicle => vehicle.packageId);
  const depositCents = toCents(catalog.depositForPackages(packageIds));
  const estimate = pricing.estimateForVehicles(vehicles.map(vehicle => ({
    packageId: vehicle.packageId, sizeId: vehicle.sizeId, addonIds: vehicle.addonIds
  })));

  const { fromMs, toMs } = dayBounds(date, timezone);
  const dayEvents = await ghl.eventsByResource(activeConfig, fromMs, toMs);

  // Idempotency without a table: the key is written into the appointment, so finding
  // the retry is finding the appointment. Scoped to the requested DAY, which is the
  // same read the allocation needs — one call, not two.
  //
  // A caller that reuses a key for a DIFFERENT day gets a second hold rather than a
  // 409. That is a deliberate limit of doing this without an index: the fingerprint
  // covers the date, so a genuine retry always looks in the right day.
  for (const [index, events] of dayEvents.entries()) {
    const match = events.find(event => {
      const fields = parseHoldFields(event);
      return fields.idempotencyKey && fields.idempotencyKey === idempotencyKey &&
        !FREE_STATUSES.includes(String(event.appointmentStatus || ''));
    });
    if (!match) continue;
    const existing = holdFromEvent(match, resources[index], timezone);
    if (existing.requestFingerprint !== fingerprint) throw new IdempotencyConflictError();
    return { ...describeHold(existing), replayed: true };
  }

  const description = buildDescription({
    idempotencyKey,
    requestFingerprint: fingerprint,
    expiresAtMs: now + HOLD_TTL_MS,
    vehicles: window.perVehicle,
    bookingMode: window.bookingMode,
    runningOrder: runningOrderFor(window, timezone),
    // What the crew has to collect on site, written here because the crew panel reads
    // the CALENDAR — that is what lets it work with no database behind it.
    estimateLabel: estimate.label,
    depositCents
  });
  const title = `RESERVA (sin pagar) — ${window.perVehicle.map(vehicle => vehicle.label).join(' + ')}`;

  // The contact has to exist before the appointment that references it.
  const holderContactId = contactId || (customer ? (await ghl.upsertContact(activeConfig, customer)).id : '');
  if (!holderContactId) throw new RequestError('customer is required to hold a slot', 422, 'HOLD_CUSTOMER_REQUIRED');

  // The cursor is fixed BEFORE the loop. It is derived from how many visits are
  // already on the day, and the loop below deletes some of them, so recomputing it
  // between attempts would walk the rotation forward for the wrong reason.
  const cursor = rotationCursor(dayEvents, resources.length);
  // Vans this request has already been refused by. HighLevel arbitrates the race, and
  // losing it on one van is not a reason to give up on a driveway the others could
  // serve — the old code answered 409 there.
  const refused = new Set();

  for (let attempt = 0; attempt <= resources.length; attempt += 1) {
    const busyByResource = dayEvents.map((events, index) =>
      refused.has(index)
        // Treated as busy for the rest of this request: the window is not ours.
        ? [{ start: window.startMs, end: window.endMs }]
        : intervalsFrom(events, now)
    );
    const allocation = allocateResources({
      resources,
      busyByResource,
      perVehicle: window.perVehicle,
      cursor
    });
    if (!allocation) {
      throw new SlotUnavailableError(
        vehicles.length > 1
          ? 'No van is free for the whole visit at that time — try an earlier start or fewer vehicles'
          : 'The selected appointment is no longer available'
      );
    }

    try {
      const event = await ghl.createHoldAppointment(activeConfig, {
        calendarId: allocation.resource.calendarId,
        contactId: holderContactId,
        address: customer ? customer.address : '',
        title,
        description,
        startTime: new Date(window.startMs).toISOString(),
        endTime: new Date(window.endMs).toISOString()
      });
      const hold = holdFromEvent(
        {
          id: event.id,
          calendarId: allocation.resource.calendarId,
          contactId: holderContactId,
          title,
          notes: description,
          appointmentStatus: 'new',
          startTime: event.startTime,
          endTime: event.endTime
        },
        allocation.resource,
        timezone
      );
      return { ...describeHold(hold), replayed: false };
    } catch (error) {
      if (!ghl.isSlotTakenError(error)) throw error;

      // HighLevel refused the window on this van. Two things can be in the way, and
      // they get opposite treatment:
      //
      //   · one of OUR lapsed holds — availability already reads it as free, so the
      //     create has to clear the corpse and try the same van again;
      //   · anything else (a real booking, or a concurrent request that won the race)
      //     — the van is genuinely taken, so move on to the next one.
      const events = await ghl.calendarEventsForCalendar(
        activeConfig, allocation.resource.calendarId, fromMs, toMs
      );
      const stale = events.filter(candidate =>
        isLapsedHold(candidate, now) &&
        Date.parse(candidate.startTime) < window.endMs &&
        window.startMs < Date.parse(candidate.endTime)
      );
      if (stale.length) {
        await ghl.deleteCalendarEventsQuietly(activeConfig, stale.map(candidate => candidate.id));
        const deleted = new Set(stale.map(candidate => candidate.id));
        dayEvents[allocation.resourceIndex] = events.filter(candidate => !deleted.has(candidate.id));
        console.log('[agenda] cleared lapsed holds', stale.length, allocation.resource.key);
      } else {
        dayEvents[allocation.resourceIndex] = events;
        refused.add(allocation.resourceIndex);
      }
    }
  }

  throw new SlotUnavailableError();
}

// ── Attaching the customer ─────────────────────────────────────────────────

// /api/quote calls this once it has upserted the contact and the opportunity. The
// booking stays unconfirmed: only a verified payment moves it to confirmed. What it
// writes is the pair of ids the payment webhook needs to find this appointment again.
async function attachCustomer({ holdId, submissionId, contactId, opportunityId, customer, now = Date.now(), config = null }) {
  const activeConfig = config || ghl.getConfig();
  const hold = await loadHold(holdId, { config: activeConfig });
  if (!hold) throw new RequestError('Hold not found', 404);
  if (hold.status === 'confirmed' || hold.status === 'delivered') return { hold, alreadyConfirmed: true };
  if (hold.status !== 'active') throw new SlotUnavailableError('This hold is no longer valid');
  if (hold.expiresAtMs && hold.expiresAtMs <= now) throw new SlotUnavailableError('This hold has expired');

  await ghl.updateCalendarEvent(activeConfig, holdId, {
    title: `RESERVA (sin pagar) — ${(customer && customer.name) || 'Website booking'}`,
    description: buildDescription({ ...hold.fields, submissionId, opportunityId })
  });
  return { hold, alreadyConfirmed: false };
}

// ── Confirmation ───────────────────────────────────────────────────────────

// The ONLY path to a confirmed booking: a payment we have verified.
//
// Idempotent without a ledger, and that is the point of the redesign: the question
// "was this already applied?" is answered by the appointment's own status, so a
// webhook that fires five times confirms once. There is nothing to deduplicate
// against, so there is nothing to get out of step.
async function confirmPayment({ externalEventId, outcome, holdId, amountCents, now = Date.now(), config = null }) {
  const activeConfig = config || ghl.getConfig();
  const hold = await loadHold(holdId, { config: activeConfig });
  if (!hold) throw new RequestError('Hold not found', 404);

  if (outcome !== 'paid') {
    // Payment failed: the van goes back on the market immediately rather than waiting
    // out the rest of the fifteen minutes.
    if (hold.status === 'confirmed' || hold.status === 'delivered') {
      return { conflict: true, status: hold.status, reason: 'paid_booking_not_released' };
    }
    if (hold.status === 'released') return { alreadyProcessed: true, status: 'cancelled' };
    await ghl.updateCalendarEvent(activeConfig, holdId, {
      status: 'cancelled',
      // Cancelled rather than deleted, and labelled: the customer is still sitting on
      // the checkout screen and its poller has to be able to say why.
      description: buildDescription({ ...hold.fields, failureReason: 'payment_failed', expiresAtMs: null })
    });
    console.log('[agenda] released after failed payment', holdId, externalEventId || '');
    return { released: true, status: 'cancelled' };
  }

  if (hold.status === 'confirmed' || hold.status === 'delivered') {
    return { alreadyProcessed: true, status: 'confirmed', parentBookingId: hold.id };
  }
  if (hold.status !== 'active') {
    // Paid after the hold was already released. The money is real, the slot is not:
    // surface a conflict so the office can refund or rebook by hand.
    return { conflict: true, status: hold.status };
  }
  if (hold.expiresAtMs && hold.expiresAtMs <= now) {
    return { conflict: true, status: 'expired' };
  }
  // The deposit owed is the one the server computed when the hold was created, never
  // a number from the payload. A short payment does not confirm; it is left for the
  // office, which is the only party that can decide whether to accept it.
  if (amountCents != null && hold.depositCents && amountCents < hold.depositCents) {
    return { conflict: true, status: hold.status, reason: 'underpaid', expectedCents: hold.depositCents };
  }

  // Promoting the hold is a status change on an object that already exists: no
  // create, no delete, and no window in which the van looks free to someone else.
  // It also cannot fail on a slot conflict, because the slot is already ours.
  await ghl.updateCalendarEvent(activeConfig, holdId, {
    status: 'confirmed',
    // Drops the "sin pagar" label the hold carried, so the crew's calendar shows what
    // the crew needs to see. The rest of the description — the running order, the
    // total, the deposit — is what the crew panel reads, so it is rewritten intact.
    title: hold.title.replace(/^RESERVA \(sin pagar\) — /, '').slice(0, 160) || 'Reserva confirmada',
    description: buildDescription({ ...hold.fields, expiresAtMs: null })
  });
  console.log('[agenda] confirmed', holdId, externalEventId || '');
  return { confirmed: true, status: 'confirmed', parentBookingId: hold.id, contactId: hold.contactId };
}

// ── Release and expiry ─────────────────────────────────────────────────────

// Abandonment, an explicit cancel, or a failed payment.
//
// The appointment is DELETED rather than cancelled: an unpaid hold that nobody
// completed is not a record of anything, and leaving it on the van's calendar as
// `cancelled` would put noise in front of the crew every morning. A confirmed booking
// is never deleted here — cancelling one of those is the office's or the crew's call,
// and both do it by moving its status.
async function releaseHold({ holdId, reason = 'released', config = null }) {
  const activeConfig = config || ghl.getConfig();
  const hold = await loadHold(holdId, { config: activeConfig });
  if (!hold) throw new RequestError('Hold not found', 404);
  if (hold.status === 'confirmed' || hold.status === 'delivered') {
    throw new RequestError('A confirmed booking cannot be released here', 409);
  }
  const failures = await ghl.deleteCalendarEventsQuietly(activeConfig, [holdId]);
  if (failures.length) throw new RequestError('Could not release the reservation — please try again', 503);
  console.log('[agenda] released', holdId, reason);
  return { released: true, holdId, freedEvents: 1 };
}

// Sweeps holds whose fifteen minutes ran out.
//
// This is a TIDY-UP, not the mechanism: availability already ignores a lapsed hold and
// a booking already deletes one that is in its way, so a slot is never lost waiting
// for this to run. What it buys is a calendar the office can read — one cron a day is
// all the Hobby plan allows, and it is all this needs to be worth having.
//
// Safe to run on a schedule and by hand at the same time: deleting an appointment
// twice is a 404 the second time, which deleteCalendarEventsQuietly swallows.
async function releaseExpiredHolds({ now = Date.now(), limit = 25, config = null } = {}) {
  const activeConfig = config || ghl.getConfig();
  const lapsed = (await scanFleet(activeConfig, { now }))
    .filter(entry => isLapsedHold(entry.event, now))
    .slice(0, limit);

  const released = [];
  for (const entry of lapsed) {
    const failures = await ghl.deleteCalendarEventsQuietly(activeConfig, [entry.event.id]);
    if (!failures.length) released.push(entry.event.id);
  }
  return { released: released.length, holdIds: released };
}

module.exports = {
  HOLD_TTL_MS,
  fingerprintRequest,
  visitWindow,
  allocateResources,
  rotationCursor,
  dayBounds,
  computeAvailability,
  acquireHold,
  getHoldForRequest,
  describeExistingHold,
  describeHoldStatus,
  publicHoldStatus,
  resolveHoldIdBySubmission,
  attachCustomer,
  confirmPayment,
  releaseHold,
  releaseExpiredHolds,
  describeHold,
  // Exported for the crew panel's sibling tests and for the sweeper's own checks:
  // the description codec is a contract between this file and anything that reads an
  // appointment written by it.
  buildDescription,
  parseHoldFields,
  isWebsiteHold,
  isLapsedHold,
  holdFromEvent
};
