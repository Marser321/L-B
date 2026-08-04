'use strict';

// The transactional agenda.
//
// One rule explains the whole file: a visit is ONE van at ONE address, working
// through the vehicles in the driveway one after another. So the services ADD UP —
// three cars is three services plus one travel buffer, on a single van, and the
// vehicles get back-to-back windows on that van's calendar.
//
// The fleet size therefore caps how many separate CUSTOMERS can be served at the
// same hour, not how many vehicles one customer may bring. Four vans means four
// driveways at once.
//
// Everything that decides who gets a van happens inside one Postgres transaction:
// read what's busy, read the rotation cursor, pick a free van, write the hold, move
// the cursor. Two requests racing for the last van serialize on that transaction,
// so exactly one of them wins and the other gets a 409 with nothing half-created
// behind it.
//
// The external calendars are written AFTER that transaction commits, because a
// network call inside a transaction holds locks for as long as HighLevel feels
// like taking. If any of those writes fails, every event created for the hold is
// deleted again and the hold is marked failed — never a hold that only half
// blocks the fleet.

const crypto = require('node:crypto');

const { RequestError, SlotUnavailableError, IdempotencyConflictError } = require('./errors.js');
const catalog = require('./catalog.js');
const pricing = require('./pricing.js');
const ghl = require('./ghl.js');
const time = require('./time.js');
const { getRepository } = require('./repository.js');

// How long a customer has to finish paying before the vans go back on the market.
const HOLD_TTL_MS = 15 * 60 * 1000;

function newId() {
  return crypto.randomUUID();
}

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

// ── Windows ────────────────────────────────────────────────────────────────

// Where each vehicle sits in time.
//
// ONE van goes to ONE address and works through the vehicles in the driveway one
// after another, so the vehicles are laid out BACK TO BACK in cart order: vehicle
// k starts exactly where vehicle k-1 finished. The visit lasts the sum of the
// services plus one trailing buffer.
//
// This is the inverse of what this function used to do (all vehicles sharing one
// start time, the visit ending with the longest one). That model quoted 1h30 for
// three cars that really take 3h30, and blocked three separate vans for a single
// driveway.
//
// The trailing buffer rides on the LAST vehicle's window rather than living in a
// row of its own: the assignment rows on one van must not overlap (the
// `no_overlapping_assignments` exclusion constraint), and a separate visit-wide row
// would overlap every vehicle in it. Sequential `[)` ranges are adjacent, not
// overlapping, so back-to-back vehicles on one van are legal by construction.
function visitWindow(vehicles, date, startTime, timezone) {
  const packageIds = vehicles.map(vehicle => vehicle.packageId);
  const fullDay = catalog.bookingModeForPackages(packageIds) === 'full_day';
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

// Picks the ONE van that serves the whole visit, starting at the rotation cursor.
//
// One address, one van: the crew drives to the customer once and works through
// every vehicle in the driveway. So this looks for a single van free across the
// entire visit — first vehicle's start to last vehicle's end, buffer included —
// rather than one free van per vehicle.
//
// Returns null when no van is free for the whole span. A van free for the first two
// cars but busy for the third is not a usable allocation: the crew cannot hand the
// driveway over to a different van halfway through.
function allocateResources({ resources, busyByResource, perVehicle, cursor }) {
  const count = resources.length;
  if (!count || !perVehicle.length) return null;

  const visitStartMs = perVehicle[0].startMs;
  const visitEndMs = perVehicle[perVehicle.length - 1].endMs;

  // Rotation order for this attempt: cursor first, wrapping around, so consecutive
  // bookings spread across the fleet instead of hammering van 1.
  const rotationOffset = Array.from({ length: count }, (unused, offset) => offset).find(offset => {
    const busy = busyByResource[(cursor + offset) % count] || [];
    return time.isFreeAcross(busy, visitStartMs, visitEndMs);
  });
  if (rotationOffset === undefined) return null;

  const resource = resources[(cursor + rotationOffset) % count];

  return {
    nextCursor: (cursor + rotationOffset + 1) % count,
    resource,
    // Every vehicle in the cart lands on the SAME van, in cart order, each with its
    // own back-to-back window.
    assignments: perVehicle
      .slice()
      .sort((a, b) => a.vehicleIndex - b.vehicleIndex)
      .map(vehicle => ({ vehicle, resource }))
  };
}

// DB reservations and the vans' own calendars, merged into one busy list per van.
// Postgres knows what the website sold; the calendar knows what the office booked
// by hand. A slot is only free when both say so.
function mergeBusy(resources, dbBusy, externalBusy) {
  return resources.map((resource, index) => [
    ...(externalBusy[index] || []).map(interval => ({ start: interval.start, end: interval.end })),
    ...dbBusy.filter(row => row.resourceKey === resource.key).map(row => ({ start: row.start, end: row.end }))
  ]);
}

function dayBounds(date, timezone) {
  return {
    fromMs: time.zonedDateTimeToMs(date, '00:00', timezone),
    toMs: time.zonedDateTimeToMs(time.addDays(date, 1), '00:00', timezone)
  };
}

// ── Availability ───────────────────────────────────────────────────────────

// Start times where ALL N vehicles can be served at once. A slot is offered only
// when N distinct vans are free, each for the length of the vehicle it would take
// — which is why a 4-vehicle cart sees far fewer slots than a 1-vehicle cart, and
// why it never sees a slot that would collapse into a queue behind one van.
async function computeAvailability({ vehicles, from, to, language = 'en', now = Date.now(), config = null }) {
  const activeConfig = config || ghl.getConfig();
  const repository = getRepository();
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

  const [externalBusy, dbBusy] = await Promise.all([
    ghl.busyIntervalsByResource(activeConfig, rangeFrom, rangeTo),
    repository.busyAssignments({ fromMs: rangeFrom, toMs: rangeTo })
  ]);
  const busyByResource = mergeBusy(resources, dbBusy, externalBusy);

  // The cursor only decides WHICH free van gets used, never WHETHER one is free,
  // so availability can read it as 0 without touching the rotation.
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
      const allocation = allocateResources({
        resources,
        busyByResource,
        perVehicle: window.perVehicle,
        cursor: 0
      });
      if (!allocation) continue;
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

function publicHoldStatus(hold, now = Date.now()) {
  // A cron sweep may not have run at the exact millisecond a client asks. Treat
  // an open-but-past-TTL row as expired for the public status contract.
  if (['active', 'converted'].includes(hold.status) && hold.expiresAtMs <= now) {
    return { status: 'expired', reason: 'HOLD_EXPIRED' };
  }
  if (hold.status === 'active') return { status: 'active', reason: '' };
  if (hold.status === 'converted') return { status: 'pending_payment', reason: '' };
  if (hold.status === 'confirmed') return { status: 'confirmed', reason: '' };
  if (hold.status === 'expired') return { status: 'expired', reason: 'HOLD_EXPIRED' };
  if (hold.status === 'released' && hold.failureReason === 'payment_failed') {
    return { status: 'payment_failed', reason: 'PAYMENT_FAILED' };
  }
  if (hold.status === 'released') return { status: 'released', reason: 'HOLD_RELEASED' };
  return { status: 'failed', reason: 'HOLD_FAILED' };
}

// Public, PII-free status for the checkout countdown/poller. Expired rows are
// actively released here as well as by the cron sweep so a browser never sees a
// slot as reserved after its TTL simply because the next cron minute is pending.
async function describeHoldStatus(holdId, { now = Date.now(), config = null } = {}) {
  const repository = getRepository();
  let hold = await repository.getHold(holdId);
  if (!hold) throw new RequestError('Hold not found', 404, 'HOLD_NOT_FOUND');
  if (['active', 'converted'].includes(hold.status) && hold.expiresAtMs <= now) {
    await releaseHold({ holdId, reason: 'hold_expired', config });
    hold = await repository.getHold(holdId);
  }
  const assignments = await repository.assignmentsForParent(hold.parentBookingId);
  return {
    ...describeHold(hold, assignments),
    ...publicHoldStatus(hold, now)
  };
}

// ── Holds ──────────────────────────────────────────────────────────────────

function describeHold(hold, assignments) {
  return {
    holdId: hold.id,
    status: hold.status,
    timezone: hold.timezone,
    bookingMode: hold.bookingMode,
    slotStart: new Date(hold.slotStartMs).toISOString(),
    slotEnd: new Date(hold.slotEndMs).toISOString(),
    expiresAt: new Date(hold.expiresAtMs).toISOString(),
    deposit: hold.depositCents / 100,
    vehicleCount: hold.vehicleCount,
    assignments: assignments.map(assignment => ({
      vehicleIndex: assignment.vehicleIndex,
      resource: assignment.resourceKey,
      startsAt: new Date(assignment.startsAtMs).toISOString(),
      endsAt: new Date(assignment.endsAtMs).toISOString(),
      durationMinutes: assignment.durationMinutes
    }))
  };
}

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

// Creates a 15-minute hold on ONE van, or fails without leaving a trace.
//
// Returns { replayed: true, ... } when the same Idempotency-Key already produced a
// hold for the same request, so a browser that retries a dropped response gets its
// original hold back instead of a second van.
//
// `customer` is required now: the hold's footprint in HighLevel is an appointment,
// and appointments need a contact. The wizard already has the customer validated by
// the time it asks for a hold, so this costs the caller nothing — see the note on
// ghl.createHoldAppointment.
async function acquireHold({ idempotencyKey, date, startTime, vehicles, customer = null, now = Date.now(), config = null }) {
  const activeConfig = config || ghl.getConfig();
  const repository = getRepository();
  const timezone = time.bookingTimezone();
  const resources = activeConfig.resources;

  if (!resources.length) {
    // The fleet size caps how many ADDRESSES can be served at once, never how many
    // vehicles one customer may bring — a single van works through the whole
    // driveway. So the only impossible case here is having no van configured at all.
    throw new SlotUnavailableError('No vans are configured');
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
  // Read the vans' calendars BEFORE opening the transaction: a HighLevel call can
  // take seconds, and holding a row lock for that long would serialize the whole
  // day's bookings behind one slow request.
  const externalBusy = await ghl.busyIntervalsByResource(activeConfig, fromMs, toMs);

  const outcome = await repository.transaction([`day:${date}`], async tx => {
    const existing = await tx.findHoldByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) throw new IdempotencyConflictError();
      const allocations = await tx.assignmentsForParent(existing.parentBookingId);
      return { replayed: true, hold: existing, assignments: allocations };
    }

    const dbBusy = await tx.busyAssignments({ fromMs, toMs });
    const busyByResource = mergeBusy(resources, dbBusy, externalBusy);
    // Locked for the rest of the transaction, so the van we pick as "next" cannot
    // be handed out as "next" to a concurrent request as well.
    const cursor = await tx.rotationCursorForUpdate();

    const allocation = allocateResources({ resources, busyByResource, perVehicle: window.perVehicle, cursor });
    if (!allocation) {
      throw new SlotUnavailableError(
        vehicles.length > 1
          ? 'No van is free for the whole visit at that time — try an earlier start or fewer vehicles'
          : 'The selected appointment is no longer available'
      );
    }

    const holdId = newId();
    const parentId = newId();
    const quote = {
      vehicles: vehicles.map(vehicle => ({
        vehicleIndex: vehicle.vehicleIndex,
        categoryId: vehicle.categoryId,
        packageId: vehicle.packageId,
        sizeId: vehicle.sizeId,
        addonIds: vehicle.addonIds,
        durationMinutes: vehicle.durationMinutes,
        isMembership: vehicle.isMembership,
        estimate: vehicle.estimate || null,
        descriptor: vehicle.descriptor || null
      })),
      estimate: { min: estimate.min, max: estimate.max, label: estimate.label }
    };

    const hold = {
      id: holdId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      status: 'active',
      slotDate: date,
      slotStartMs: window.startMs,
      slotEndMs: window.endMs,
      timezone,
      bookingMode: window.bookingMode,
      vehicleCount: vehicles.length,
      quote,
      depositCents,
      expiresAtMs: now + HOLD_TTL_MS
    };

    const parent = {
      id: parentId,
      idempotencyKey: `hold:${idempotencyKey}`,
      status: 'held',
      slotStartMs: window.startMs,
      slotEndMs: window.endMs,
      timezone,
      vehicleCount: vehicles.length,
      depositCents,
      estimateMinCents: toCents(estimate.min),
      estimateMaxCents: toCents(estimate.max),
      quote
    };

    const children = allocation.assignments.map(({ vehicle, resource }) => {
      const childId = newId();
      const assignmentId = newId();
      return {
        child: {
          id: childId,
          status: 'held',
          vehicleIndex: vehicle.vehicleIndex,
          vehicleLabel: vehicle.label,
          packageId: vehicle.packageId,
          slotStartMs: vehicle.startMs,
          slotEndMs: vehicle.endMs,
          timezone,
          estimateMinCents: toCents(vehicle.estimate ? vehicle.estimate.min : 0),
          estimateMaxCents: toCents(vehicle.estimate ? vehicle.estimate.max : 0),
          quote: quote.vehicles[vehicle.vehicleIndex]
        },
        assignment: {
          id: assignmentId,
          resourceKey: resource.key,
          vehicleIndex: vehicle.vehicleIndex,
          vehicleLabel: vehicle.label,
          packageId: vehicle.packageId,
          durationMinutes: Math.round((vehicle.endMs - vehicle.startMs) / 60000),
          startsAtMs: vehicle.startMs,
          endsAtMs: vehicle.endMs,
          calendarId: resource.calendarId,
          status: 'held'
        },
        allocation: {
          id: newId(),
          resourceKey: resource.key,
          vehicleIndex: vehicle.vehicleIndex,
          calendarId: resource.calendarId,
          startsAtMs: vehicle.startMs,
          endsAtMs: vehicle.endMs,
          status: 'pending'
        }
      };
    });

    try {
      await tx.createHoldBundle({ hold, parent, children });
    } catch (error) {
      // The exclusion constraint fired: another transaction took one of these vans
      // for an overlapping window. Same answer as finding it busy, just found later.
      if (repository.isOverlapViolation(error)) throw new SlotUnavailableError();
      // Only the idempotency key may answer "this key was already used". Every other
      // unique violation is a schema problem wearing that error's clothes, and saying
      // "Idempotency-Key already used" sends whoever debugs it somewhere else
      // entirely. This exact trap cost real time on 2026-08-04: production ran the
      // one-van-per-address model while `booking_assignments_resource_unique` — the
      // constraint migration 004 drops — was still in the database, so every
      // multi-vehicle booking failed with a 409 about idempotency.
      if (repository.isUniqueViolation(error)) {
        if (!error.constraint || /idempotency/i.test(error.constraint)) throw new IdempotencyConflictError();
        console.error('[agenda] unexpected unique violation', error.constraint);
        throw new RequestError(
          `Booking storage rejected this reservation (${error.constraint}) — the database schema is behind the code`,
          500,
          'SCHEMA_CONFLICT'
        );
      }
      throw error;
    }
    await tx.setRotationCursor(allocation.nextCursor);

    return {
      replayed: false,
      hold: { ...hold, parentBookingId: parentId },
      assignments: children.map(entry => ({ ...entry.assignment, bookingId: entry.child.id, parentBookingId: parentId })),
      allocations: children.map(entry => ({ ...entry.allocation, holdId, assignmentId: entry.assignment.id }))
    };
  });

  if (outcome.replayed) {
    return { ...describeHold(outcome.hold, outcome.assignments), replayed: true };
  }

  // Committed. Now block the vans' own calendars so the office cannot book over a
  // slot the website has promised.
  // The contact has to exist before the appointment that references it. Done after
  // the transaction commits, like every other network call in this file.
  const contact = customer ? await ghl.upsertContact(activeConfig, customer) : null;

  await reserveExternalCalendars({
    contactId: contact ? contact.id : null,
    address: customer ? customer.address : '',
    repository,
    config: activeConfig,
    hold: outcome.hold,
    allocations: outcome.allocations,
    assignments: outcome.assignments
  });

  return { ...describeHold(outcome.hold, outcome.assignments), replayed: false };
}

// Writes one `new` appointment per vehicle on the van's calendar and records its
// id. If ANY of them fails, every appointment created for this hold is deleted
// again and the hold is marked failed, so the fleet is never left partially
// reserved by a booking that does not exist.
//
// These used to be block slots, which HighLevel rejects outright on the vans'
// Personal calendars — see the note on ghl.createHoldAppointment. Appointments also
// bring their own conflict validation, so HighLevel refusing one is meaningful: the
// van went to someone else between our read and our write. That is a 409 for the
// customer ("that slot just went, pick another"), not a 503 ("we are broken").
async function reserveExternalCalendars({ repository, config, hold, allocations, assignments, contactId, address }) {
  const created = [];
  try {
    for (const allocation of allocations) {
      const assignment = assignments.find(entry => entry.vehicleIndex === allocation.vehicleIndex);
      const event = await ghl.createHoldAppointment(config, {
        calendarId: allocation.calendarId,
        contactId,
        address,
        title: `RESERVA (sin pagar) — ${assignment ? assignment.vehicleLabel : 'website booking'}`,
        description: `Hold ${hold.id} · expira ${new Date(hold.expiresAtMs).toISOString()}`,
        startTime: new Date(allocation.startsAtMs).toISOString(),
        endTime: new Date(allocation.endsAtMs).toISOString()
      });
      created.push({ allocation, assignment, eventId: event.id });
    }
  } catch (error) {
    const taken = ghl.isSlotTakenError(error);
    console.error('[agenda] external hold failed', hold.id, error.name || 'Error', taken ? 'slot-taken' : (error.statusCode || 502));
    await compensateHold({
      repository, config, hold,
      createdEvents: created.map(entry => entry.eventId),
      reason: taken ? 'slot_taken_upstream' : 'external_calendar_failed'
    });
    if (taken) throw new SlotUnavailableError();
    throw new RequestError('Could not reserve the crew calendars — please try again', 503);
  }

  await repository.transaction([`day:${hold.slotDate}`], async tx => {
    for (const entry of created) {
      await tx.setAllocationExternalEvent(entry.allocation.id, entry.eventId, 'active');
      if (entry.assignment) await tx.setAssignmentExternalEvent(entry.assignment.id, entry.eventId, entry.allocation.calendarId);
    }
  });
}

// Undo everything a failed hold created: delete the external events we managed to
// write, then release the rows. Runs in its own transaction because the one that
// created them has already committed.
async function compensateHold({ repository, config, hold, createdEvents = [], reason = 'external_calendar_failed' }) {
  const undeleted = await ghl.deleteCalendarEventsQuietly(config, createdEvents);
  await repository.transaction([`day:${hold.slotDate}`], async tx => {
    await tx.markHoldStatus(hold.id, 'failed', { failureReason: reason });
    await tx.markAllocationsStatus(hold.id, 'failed');
    if (hold.parentBookingId) {
      // 'released' frees the van: the exclusion constraint only counts held and
      // confirmed rows, so the slot is immediately bookable again.
      await tx.markAssignmentsStatus(hold.parentBookingId, 'released');
      await tx.setBookingTreeStatus(hold.parentBookingId, 'failed', { cancelReason: reason });
    }
  });
  if (undeleted.length) {
    // The rows are released either way; these events survive in HighLevel and are
    // logged so they can be cleared by hand.
    console.error('[agenda] orphan hold events', hold.id, undeleted.join(','));
  }
}

// Loads a hold the browser claims to own and refuses it unless it is still live.
// An expired or released hold is a 409, not a 404: the slot existed, it just isn't
// the customer's any more.
async function getHoldForRequest(holdId, { now = Date.now() } = {}) {
  const repository = getRepository();
  const hold = await repository.getHold(holdId);
  if (!hold) throw new RequestError('Hold not found', 404, 'HOLD_NOT_FOUND');
  // An already-confirmed hold is returned as-is so a resubmitted form is a no-op
  // rather than an error.
  if (hold.status === 'confirmed') return hold;
  if (!['active', 'converted'].includes(hold.status)) throw new SlotUnavailableError('This hold is no longer valid');
  if (hold.expiresAtMs <= now) throw new RequestError('This hold has expired', 409, 'HOLD_EXPIRED');
  return hold;
}

async function describeExistingHold(hold) {
  const repository = getRepository();
  const assignments = await repository.assignmentsForParent(hold.parentBookingId);
  return { ...describeHold(hold, assignments), requestFingerprint: hold.requestFingerprint };
}

// The payment webhook may only know the submission id (HighLevel workflows are
// easier to configure with one). Map it back to the hold that is waiting to be paid.
async function resolveHoldIdBySubmission(submissionId) {
  const repository = getRepository();
  const parent = await repository.findParentBookingBySubmission(submissionId);
  return parent ? parent.holdId : null;
}

// ── Attaching the customer ─────────────────────────────────────────────────

// /api/quote calls this once it has upserted the contact. The booking stays
// unconfirmed: only a verified payment moves it to confirmed.
async function attachCustomer({ holdId, submissionId, contactId, opportunityId, customer, now = Date.now() }) {
  const repository = getRepository();
  const hold = await repository.getHold(holdId);
  if (!hold) throw new RequestError('Hold not found', 404);
  if (hold.status === 'confirmed') return { hold, alreadyConfirmed: true };
  if (!['active', 'converted'].includes(hold.status)) throw new SlotUnavailableError('This hold is no longer valid');
  if (hold.expiresAtMs <= now) throw new SlotUnavailableError('This hold has expired');

  await repository.transaction([`day:${hold.slotDate}`], async tx => {
    await tx.attachCustomer(hold.parentBookingId, {
      submissionId,
      contactId,
      opportunityId,
      customer,
      status: 'pending_payment'
    });
    await tx.markHoldStatus(hold.id, 'converted');
  });
  return { hold, alreadyConfirmed: false };
}

// ── Confirmation ───────────────────────────────────────────────────────────

// The ONLY path to a confirmed booking: a payment event we have verified.
//
// Idempotent by (provider, externalEventId): a webhook that fires five times
// confirms once and credits the membership once. A 'failed' outcome releases
// everything, which is the same code path expiry uses.
async function confirmPayment({ provider, externalEventId, eventType, outcome, holdId, amountCents, currency, payload, now = Date.now(), config = null }) {
  const repository = getRepository();
  const hold = await repository.getHold(holdId);
  if (!hold) throw new RequestError('Hold not found', 404);

  const result = await repository.transaction([`day:${hold.slotDate}`], async tx => {
    const inserted = await tx.insertPaymentEvent({
      id: newId(),
      provider,
      externalEventId,
      eventType,
      outcome,
      holdId: hold.id,
      parentBookingId: hold.parentBookingId,
      submissionId: null,
      amountCents,
      currency: currency || 'USD',
      payload
    });
    if (!inserted.inserted) return { alreadyProcessed: true, status: hold.status };

    const current = await tx.getHold(hold.id, { forUpdate: true });
    if (outcome !== 'paid') {
      // Payment failed: the vans go back on the market immediately rather than
      // waiting out the rest of the 15 minutes.
      await releaseWithin(tx, current, 'payment_failed', 'cancelled');
      return { released: true, status: 'cancelled' };
    }
    if (current.status === 'confirmed') return { alreadyProcessed: true, status: 'confirmed' };
    if (!['active', 'converted'].includes(current.status)) {
      // Paid after the hold was already released. The money is real, the slot is
      // not: surface a conflict so the office can refund or rebook by hand.
      return { conflict: true, status: current.status };
    }
    if (current.expiresAtMs <= now) {
      await releaseWithin(tx, current, 'expired_before_payment', 'expired');
      return { conflict: true, status: 'expired' };
    }
    // The deposit owed is the one the server computed when the hold was created,
    // never a number from the payload. A short payment does not confirm; it is
    // recorded and left for the office, which is the only party that can decide
    // whether to accept it.
    if (amountCents != null && amountCents < current.depositCents) {
      return { conflict: true, status: current.status, reason: 'underpaid', expectedCents: current.depositCents };
    }

    await tx.markHoldStatus(current.id, 'confirmed');
    await tx.markAllocationsStatus(current.id, 'active');
    await tx.markAssignmentsStatus(current.parentBookingId, 'confirmed');
    await tx.setBookingTreeStatus(current.parentBookingId, 'confirmed', { confirmedAtMs: now });

    // Membership credits are NOT granted here. This is the one-off deposit path:
    // paying a deposit buys one visit, not a monthly allowance. Credits are
    // granted by a paid Stripe invoice and spent when a wash is delivered — see
    // memberships.js. (Before the membership module existed this path granted
    // them, which credited a customer for merely booking.)
    const parent = await tx.getBooking(current.parentBookingId);
    const contactId = parent && parent.contactId;

    const assignments = await tx.assignmentsForParent(current.parentBookingId);
    return { confirmed: true, status: 'confirmed', parentBookingId: current.parentBookingId, assignments, contactId };
  });

  if (result.confirmed && config) {
    await confirmExternalAppointments({ repository, config, hold, result });
  }
  return result;
}

// Promotes the hold's appointments to `confirmed` once a payment is verified.
//
// This used to CREATE a real appointment and then delete the block slot it
// replaced. Now the hold already IS the appointment, so confirming is a status
// change on an object that exists — no create, no delete, and no window in which
// the van looks free to someone else. It also cannot fail on a slot conflict,
// because the slot is already ours.
async function confirmExternalAppointments({ repository, config, hold, result }) {
  const parent = await repository.getBooking(result.parentBookingId);
  const customer = (parent && parent.customer) || {};

  for (const assignment of result.assignments) {
    if (!assignment.externalEventId) continue;
    try {
      await ghl.updateCalendarEvent(config, assignment.externalEventId, {
        status: 'confirmed',
        // Drops the "sin pagar" label the hold carried, so the crew's calendar
        // shows what the crew needs to see.
        title: `${assignment.vehicleLabel} — ${customer.name || 'Website booking'}`,
        description: `[Booking ${result.parentBookingId}] vehículo ${assignment.vehicleIndex + 1} de ${result.assignments.length}${customer.address ? ` · ${customer.address}` : ''}`
      });
    } catch (error) {
      // The booking is paid and confirmed in Postgres, and the appointment is still
      // on the van's calendar holding the slot — only its status and label are
      // stale. That is a CRM cosmetic the office can fix, never a lost van.
      console.error('[agenda] appointment confirmation failed', result.parentBookingId, assignment.id, error.name || 'Error');
    }
  }
}

// Confirms a hold that a MEMBERSHIP pays for.
//
// Same rule as the deposit path — a hold becomes a confirmed booking only on the
// strength of a verified Stripe webhook — but the proof is different. There is no
// per-visit payment: the proof is the contract's paid cycle, which invoice.paid
// wrote and nothing else can. memberships.confirmVisit checks that before calling
// here and passes what it verified as `reason`, so the audit row says which
// invoice paid for this visit.
async function confirmHoldForMembership({ holdId, reason, now = Date.now(), config = null }) {
  const repository = getRepository();
  const hold = await repository.getHold(holdId);
  if (!hold) throw new RequestError('Hold not found', 404);
  if (hold.status === 'confirmed') {
    const assignments = await repository.assignmentsForParent(hold.parentBookingId);
    return { parentBookingId: hold.parentBookingId, assignments, alreadyConfirmed: true };
  }
  if (!['active', 'converted'].includes(hold.status)) throw new SlotUnavailableError('This hold is no longer valid');
  if (hold.expiresAtMs <= now) throw new SlotUnavailableError('This hold has expired');

  const result = await repository.transaction([`day:${hold.slotDate}`], async tx => {
    const current = await tx.getHold(hold.id, { forUpdate: true });
    if (!current || !['active', 'converted'].includes(current.status)) {
      throw new SlotUnavailableError('This hold is no longer valid');
    }
    await tx.markHoldStatus(current.id, 'confirmed');
    await tx.markAllocationsStatus(current.id, 'active');
    await tx.markAssignmentsStatus(current.parentBookingId, 'confirmed');
    await tx.setBookingTreeStatus(current.parentBookingId, 'confirmed', { confirmedAtMs: now });
    // Recorded in the same ledger the deposit flow uses, so "what authorised this
    // confirmation?" has one answer for both kinds of booking.
    await tx.insertPaymentEvent({
      id: newId(),
      provider: 'membership',
      externalEventId: reason,
      eventType: 'membership_cycle_paid',
      outcome: 'paid',
      holdId: current.id,
      parentBookingId: current.parentBookingId,
      submissionId: null,
      amountCents: 0,
      currency: 'USD',
      payload: { reason }
    });

    const children = await tx.childBookings(current.parentBookingId);
    const assignments = await tx.assignmentsForParent(current.parentBookingId);
    return {
      parentBookingId: current.parentBookingId,
      childBookingId: children.length ? children[0].id : null,
      assignments,
      contactId: (await tx.getBooking(current.parentBookingId) || {}).contactId
    };
  });

  if (config && result.contactId) {
    await confirmExternalAppointments({ repository, config, hold, result });
  }
  return result;
}

// ── Release and expiry ─────────────────────────────────────────────────────

async function releaseWithin(tx, hold, reason, bookingStatus) {
  await tx.markHoldStatus(hold.id, bookingStatus === 'expired' ? 'expired' : 'released', { failureReason: reason });
  await tx.markAllocationsStatus(hold.id, 'released');
  if (hold.parentBookingId) {
    await tx.markAssignmentsStatus(hold.parentBookingId, 'released');
    await tx.setBookingTreeStatus(hold.parentBookingId, bookingStatus, { cancelledAtMs: Date.now(), cancelReason: reason });
  }
}

// Abandonment, an explicit cancel, or a failed payment: same outcome as expiry,
// just triggered sooner.
async function releaseHold({ holdId, reason = 'released', config = null }) {
  const repository = getRepository();
  const hold = await repository.getHold(holdId);
  if (!hold) throw new RequestError('Hold not found', 404);
  if (hold.status === 'confirmed') throw new RequestError('A confirmed booking cannot be released here', 409);

  const eventIds = (await repository.allocationsForHold(holdId))
    .map(allocation => allocation.externalEventId)
    .filter(Boolean);

  await repository.transaction([`day:${hold.slotDate}`], async tx => {
    await releaseWithin(tx, hold, reason, reason === 'hold_expired' ? 'expired' : 'cancelled');
  });
  if (config && eventIds.length) await ghl.deleteCalendarEventsQuietly(config, eventIds);
  return { released: true, holdId, freedEvents: eventIds.length };
}

// Sweeps holds whose 15 minutes ran out.
//
// Safe to run on a schedule and on demand at the same time. The listing pass uses
// `for update skip locked` so two sweepers rarely pick the same hold, but the real
// guarantee is the re-read below: each hold is locked again with `for update` and
// released only if it is still unpaid and still expired. A second sweeper that
// picked the same hold therefore finds it already expired and does nothing.
async function releaseExpiredHolds({ now = Date.now(), limit = 25, config = null } = {}) {
  const repository = getRepository();
  const expired = await repository.transaction(['sweep'], async tx => tx.claimExpiredHolds(now, limit));
  const released = [];

  for (const hold of expired) {
    const allocations = await repository.allocationsForHold(hold.id);
    const eventIds = allocations.map(allocation => allocation.externalEventId).filter(Boolean);
    const didRelease = await repository.transaction([`day:${hold.slotDate}`], async tx => {
      const current = await tx.getHold(hold.id, { forUpdate: true });
      // Someone may have paid between the listing and now; never release a booking
      // that has since been confirmed.
      if (!current || !['active', 'converted'].includes(current.status)) return false;
      if (current.expiresAtMs > now) return false;
      await releaseWithin(tx, current, 'hold_expired', 'expired');
      return true;
    });
    // Only count and clean up what this run actually released, so a rolled-back
    // transaction is never reported as a release.
    if (!didRelease) continue;
    released.push(hold.id);
    if (config && eventIds.length) await ghl.deleteCalendarEventsQuietly(config, eventIds);
  }

  return { released: released.length, holdIds: released };
}

module.exports = {
  HOLD_TTL_MS,
  fingerprintRequest,
  visitWindow,
  allocateResources,
  mergeBusy,
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
  confirmHoldForMembership,
  releaseHold,
  releaseExpiredHolds,
  compensateHold,
  describeHold
};
