'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  setupAgenda, callHandler, nextWeekday, CALENDARS
} = require('./support/harness.js');

const holdsHandler = require('../api/bookings/holds.js');
const availabilityHandler = require('../api/availability.js');
const expireHandler = require('../api/bookings/expire.js');
const agenda = require('../api/_lib/agenda.js');

const DATE = nextWeekday(7);

// premium-detail: 60 service + 30 buffer = 90 minutes on one van.
// car-hauler-wash: 90 + 30 = 120 minutes.
// boat-basico: 120 + 60 = 180 minutes.
function car(index = 0) {
  return {
    packageId: 'premium-detail', sizeId: 'sedan', addonIds: [],
    vehicle: { make: 'Toyota', model: `Camry${index}`, year: 2024 }
  };
}
function hauler() {
  return {
    packageId: 'car-hauler-wash', sizeId: 'standard', addonIds: [],
    vehicle: { make: 'Ford', model: 'F650', year: 2020 }
  };
}
function boat() {
  return {
    packageId: 'boat-basico', sizeId: 'boat_16_20', addonIds: [],
    vehicle: { make: 'Sea', model: 'Ray', year: 2019 }
  };
}
function membership() {
  return {
    packageId: 'membresia-2x', sizeId: 'sedan', addonIds: [],
    vehicle: { make: 'Honda', model: 'Civic', year: 2023 }
  };
}

function holdRequest(vehicles, { date = DATE, startTime = '09:00' } = {}) {
  return { date, startTime, vehicles };
}

function withKey(key) {
  return { headers: { 'idempotency-key': key } };
}

test('one to four vehicles each get their own van, and a fifth is rejected with 422', async t => {
  for (const count of [1, 2, 3, 4]) {
    const ctx = setupAgenda();
    try {
      const vehicles = Array.from({ length: count }, (unused, index) => car(index));
      const res = await callHandler(holdsHandler, holdRequest(vehicles), withKey(`fleet-${count}-0001`));

      assert.equal(res.statusCode, 201, `expected ${count} vehicles to be held`);
      assert.equal(res.body.assignments.length, count);

      // One van per vehicle: never two vehicles on the same van.
      const vans = res.body.assignments.map(assignment => assignment.resource);
      assert.equal(new Set(vans).size, count, `expected ${count} distinct vans, got ${vans.join(',')}`);

      // Each vehicle is blocked on its own van's calendar.
      const blocked = ctx.ghl.created.filter(entry => entry.kind === 'block');
      assert.equal(blocked.length, count);
      assert.equal(new Set(blocked.map(entry => entry.calendarId)).size, count);
      blocked.forEach(entry => assert.ok(CALENDARS.includes(entry.calendarId)));
    } finally {
      ctx.restore();
    }
  }

  const ctx = setupAgenda();
  t.after(() => ctx.restore());
  const vehicles = Array.from({ length: 5 }, (unused, index) => car(index));
  const res = await callHandler(holdsHandler, holdRequest(vehicles), withKey('fleet-5-000001'));

  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /at most 4 vehicles/);
  // Rejected before anything was written or blocked.
  assert.equal(ctx.ghl.created.length, 0);
  assert.equal(ctx.repository.__store().holds.length, 0);
});

test('vehicles are washed in parallel: the visit lasts as long as the slowest one, never the sum', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // 90 + 120 + 180 minutes. Summed that would be 6h30 and would not even fit
  // before 18:00; in parallel it is a three-hour visit.
  const res = await callHandler(
    holdsHandler,
    holdRequest([car(), hauler(), boat()]),
    withKey('parallel-000001')
  );

  assert.equal(res.statusCode, 201);
  const start = Date.parse(res.body.slotStart);
  const end = Date.parse(res.body.slotEnd);
  assert.equal((end - start) / 60000, 180, 'visit should last as long as the boat, the longest vehicle');

  // Every vehicle starts together and ends on its own duration.
  const durations = res.body.assignments.map(assignment => assignment.durationMinutes).sort((a, b) => a - b);
  assert.deepEqual(durations, [90, 120, 180]);
  res.body.assignments.forEach(assignment => {
    assert.equal(Date.parse(assignment.startsAt), start, 'all vehicles start at the same time');
  });
});

test('two requests racing for the same four vans: one wins, the other gets 409 and leaves nothing behind', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const request = holdRequest([car(0), car(1), car(2), car(3)]);
  // Fired together, before either has committed — the case a read-then-write
  // check would lose.
  const [first, second] = await Promise.all([
    callHandler(holdsHandler, request, withKey('race-a-0000001')),
    callHandler(holdsHandler, request, withKey('race-b-0000001'))
  ]);

  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [201, 409], 'exactly one request may win the fleet');

  const winner = first.statusCode === 201 ? first : second;
  const loser = first.statusCode === 201 ? second : first;
  assert.equal(winner.body.assignments.length, 4);
  assert.match(loser.body.error, /fleet is free|no longer available/);

  const store = ctx.repository.__store();
  // The loser rolled back completely: one hold, four assignments, four allocations.
  assert.equal(store.holds.length, 1);
  assert.equal(store.assignments.length, 4);
  assert.equal(store.allocations.length, 4);
  assert.equal(store.bookings.filter(booking => !booking.parentBookingId).length, 1);
  assert.equal(store.bookings.filter(booking => booking.parentBookingId).length, 4);
  // And it blocked no calendars.
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'block').length, 4);
});

test('a parent reservation with one child booking and one assignment per vehicle', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  await callHandler(holdsHandler, holdRequest([car(0), hauler()]), withKey('shape-00000001'));

  const store = ctx.repository.__store();
  const parents = store.bookings.filter(booking => !booking.parentBookingId);
  const children = store.bookings.filter(booking => booking.parentBookingId);

  assert.equal(parents.length, 1);
  assert.equal(children.length, 2);
  assert.equal(parents[0].vehicleCount, 2);
  children.forEach(child => assert.equal(child.parentBookingId, parents[0].id));

  // Each child carries its own window; the parent spans the longest of them.
  const childWindows = children.map(child => (child.slotEndMs - child.slotStartMs) / 60000).sort((a, b) => a - b);
  assert.deepEqual(childWindows, [90, 120]);
  assert.equal((parents[0].slotEndMs - parents[0].slotStartMs) / 60000, 120);

  // One assignment per child, each naming its own van and calendar.
  assert.equal(store.assignments.length, 2);
  store.assignments.forEach(assignment => {
    assert.ok(children.some(child => child.id === assignment.bookingId));
    assert.ok(CALENDARS.includes(assignment.calendarId));
    assert.equal(assignment.status, 'held');
  });
  assert.equal(new Set(store.assignments.map(a => a.resourceKey)).size, 2);
});

test('the rotation cursor persists across bookings and starts at the next van each time', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const picked = [];
  for (let index = 0; index < 4; index += 1) {
    // Each booking is at a different hour, so every van is free every time and
    // only the cursor decides who gets it.
    const res = await callHandler(
      holdsHandler,
      holdRequest([car(index)], { startTime: ['09:00', '11:00', '13:00', '15:00'][index] }),
      withKey(`rotate-${index}-00001`)
    );
    assert.equal(res.statusCode, 201);
    picked.push(res.body.assignments[0].resource);
  }

  assert.deepEqual(picked, ['camioneta_1', 'camioneta_2', 'camioneta_3', 'camioneta_4']);
  // Back to the start on the fifth.
  assert.equal(ctx.repository.__store().rotation.vans, 0);
});

test('rotation skips vans that are busy and only ever picks free ones', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // The cursor points at van 1, but the office already booked van 1 and van 2 by
  // hand for that window.
  const startMs = Date.parse(`${DATE}T13:00:00.000Z`);
  ctx.ghl.calendarEvents[CALENDARS[0]] = [{ start: startMs, end: startMs + 3 * 3600_000 }];
  ctx.ghl.calendarEvents[CALENDARS[1]] = [{ start: startMs, end: startMs + 3 * 3600_000 }];

  const res = await callHandler(holdsHandler, holdRequest([car()]), withKey('skip-00000001'));
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.assignments[0].resource, 'camioneta_3');
});

test('a hold blocks the vans in HighLevel so the office cannot book over it', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const res = await callHandler(holdsHandler, holdRequest([car(0), car(1)]), withKey('block-00000001'));
  assert.equal(res.statusCode, 201);

  const blocks = ctx.ghl.created.filter(entry => entry.kind === 'block');
  assert.equal(blocks.length, 2);
  blocks.forEach(block => {
    assert.match(block.body.title, /^HOLD — /);
    assert.equal(block.body.locationId, 'loc-1');
  });

  // The block id is recorded on both the allocation and the assignment, which is
  // what lets expiry and compensation clean them up later.
  const store = ctx.repository.__store();
  store.allocations.forEach(allocation => assert.match(allocation.externalEventId, /^block-/));
  store.assignments.forEach(assignment => assert.match(assignment.externalEventId, /^block-/));
});

test('a failed calendar block compensates every event already created and frees the slot', async t => {
  // Two vans block fine, the third fails.
  const ctx = setupAgenda({ blockSlotFailsAt: 2 });
  t.after(() => ctx.restore());

  const res = await callHandler(
    holdsHandler,
    holdRequest([car(0), car(1), car(2)]),
    withKey('compensate-0001')
  );

  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /Could not reserve the crew calendars/);

  // Both blocks that did get created were deleted again — no van is left blocked
  // by a reservation that does not exist.
  assert.deepEqual(ctx.ghl.deleted.sort(), ['block-1', 'block-2']);

  const store = ctx.repository.__store();
  assert.equal(store.holds[0].status, 'failed');
  assert.equal(store.holds[0].failureReason, 'external_calendar_failed');
  store.allocations.forEach(allocation => assert.equal(allocation.status, 'failed'));
  store.assignments.forEach(assignment => assert.equal(assignment.status, 'released'));
  store.bookings.forEach(booking => assert.equal(booking.status, 'failed'));

  // Released assignments do not occupy a van, so the slot is immediately bookable.
  const busy = await ctx.repository.busyAssignments({ fromMs: 0, toMs: Date.now() + 1e11 });
  assert.equal(busy.length, 0);
});

test('a hold expires after 15 minutes: the vans come back and their blocks are removed', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, holdRequest([car(0), car(1)]), withKey('expire-00000001'));
  assert.equal(held.statusCode, 201);
  const expiresAt = Date.parse(held.body.expiresAt);
  assert.equal(agenda.HOLD_TTL_MS, 15 * 60 * 1000);

  // One minute before expiry nothing is released.
  let swept = await agenda.releaseExpiredHolds({ now: expiresAt - 60_000, config: require('../api/_lib/ghl.js').getConfig() });
  assert.equal(swept.released, 0);
  assert.equal(ctx.repository.__store().assignments[0].status, 'held');

  // One second after, the hold lapses.
  swept = await agenda.releaseExpiredHolds({ now: expiresAt + 1000, config: require('../api/_lib/ghl.js').getConfig() });
  assert.equal(swept.released, 1);

  const store = ctx.repository.__store();
  assert.equal(store.holds[0].status, 'expired');
  store.assignments.forEach(assignment => assert.equal(assignment.status, 'released'));
  store.bookings.forEach(booking => assert.equal(booking.status, 'expired'));
  assert.deepEqual(ctx.ghl.deleted.sort(), ['block-1', 'block-2']);

  // The slot is free again for the next customer.
  const busy = await ctx.repository.busyAssignments({ fromMs: 0, toMs: Date.now() + 1e11 });
  assert.equal(busy.length, 0);
});

test('hold status is PII-free and distinguishes active, expired, and payment-failed checkout states', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const active = await callHandler(holdsHandler, holdRequest([car()]), withKey('status-active-0001'));
  const activeStatus = await callHandler(holdsHandler, undefined, {
    method: 'GET', query: { holdId: active.body.holdId }
  });
  assert.equal(activeStatus.statusCode, 200);
  assert.equal(activeStatus.body.status, 'active');
  assert.equal(activeStatus.body.reason, '');
  assert.equal(JSON.stringify(activeStatus.body).includes('Camry0'), false, 'status response must not disclose the vehicle descriptor');

  await agenda.confirmPayment({
    provider: 'highlevel', externalEventId: 'evt-status-failed', eventType: 'invoice.failed',
    outcome: 'failed', holdId: active.body.holdId
  });
  const failedStatus = await callHandler(holdsHandler, undefined, {
    method: 'GET', query: { holdId: active.body.holdId }
  });
  assert.equal(failedStatus.statusCode, 200);
  assert.equal(failedStatus.body.status, 'payment_failed');
  assert.equal(failedStatus.body.reason, 'PAYMENT_FAILED');

  const expiring = await callHandler(holdsHandler, holdRequest([car(1)]), withKey('status-expired-001'));
  const expired = await agenda.describeHoldStatus(expiring.body.holdId, {
    now: Date.parse(expiring.body.expiresAt) + 1,
    config: require('../api/_lib/ghl.js').getConfig()
  });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.reason, 'HOLD_EXPIRED');

  const releasable = await callHandler(holdsHandler, holdRequest([car(2)]), withKey('status-release-001'));
  const released = await callHandler(holdsHandler, { holdId: releasable.body.holdId }, { method: 'DELETE' });
  assert.equal(released.statusCode, 200);
  assert.equal(released.body.status, 'released');
  assert.equal(ctx.repository.__store().holds.find(hold => hold.id === releasable.body.holdId).status, 'released');
});

test('the expiry sweeper is authenticated and never releases a confirmed booking', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const unauthorized = await callHandler(expireHandler, {}, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(unauthorized.statusCode, 401);

  const held = await callHandler(holdsHandler, holdRequest([car()]), withKey('confirmed-0001'));
  const holdId = held.body.holdId;
  await agenda.attachCustomer({ holdId, submissionId: 'sub-000001', contactId: 'contact-1', customer: { name: 'A' } });
  await agenda.confirmPayment({
    provider: 'highlevel', externalEventId: 'evt-1', eventType: 'InvoicePaid', outcome: 'paid', holdId
  });

  // Long past the 15 minutes, but paid: the sweeper must leave it alone.
  const swept = await agenda.releaseExpiredHolds({ now: Date.now() + 3600_000 });
  assert.equal(swept.released, 0);
  assert.equal(ctx.repository.__store().holds[0].status, 'confirmed');

  const authorized = await callHandler(expireHandler, {}, { headers: { authorization: 'Bearer cron-secret' } });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.body.released, 0);
});

test('an Idempotency-Key replays the same hold, and a different body with the same key is a 409', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const request = holdRequest([car()]);
  const first = await callHandler(holdsHandler, request, withKey('idem-00000001'));
  assert.equal(first.statusCode, 201);

  const replay = await callHandler(holdsHandler, request, withKey('idem-00000001'));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.holdId, first.body.holdId);
  // A retry must not take a second van.
  assert.equal(ctx.repository.__store().assignments.length, 1);

  const different = await callHandler(holdsHandler, holdRequest([hauler()]), withKey('idem-00000001'));
  assert.equal(different.statusCode, 409);
  assert.match(different.body.error, /already used for a different request/);

  const missing = await callHandler(holdsHandler, request, { headers: {} });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.error, /Idempotency-Key/);
});

test('availability only offers a start time when every vehicle can have its own van', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const range = { from: DATE, to: DATE };
  const one = await callHandler(availabilityHandler, { ...range, vehicles: [{ packageId: 'premium-detail' }] });
  assert.equal(one.statusCode, 200);
  const oneSlots = one.body.dates[0].slots.map(slot => slot.start);
  assert.ok(oneSlots.includes('09:00'));

  // Three vans are booked out for the whole day; only one is left.
  const dayStart = Date.parse(`${DATE}T12:00:00.000Z`);
  const dayEnd = Date.parse(`${DATE}T22:00:00.000Z`);
  CALENDARS.slice(0, 3).forEach(calendarId => {
    ctx.ghl.calendarEvents[calendarId] = [{ start: dayStart, end: dayEnd }];
  });

  const stillOne = await callHandler(availabilityHandler, { ...range, vehicles: [{ packageId: 'premium-detail' }] });
  assert.ok(stillOne.body.dates.length, 'one vehicle still fits on the last free van');

  const two = await callHandler(availabilityHandler, {
    ...range,
    vehicles: [{ packageId: 'premium-detail' }, { packageId: 'premium-detail' }]
  });
  assert.equal(two.body.dates.length, 0, 'two vehicles need two vans, and only one is free');
});

test('availability reports per-vehicle durations and a parallel visit length', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const res = await callHandler(availabilityHandler, {
    from: DATE, to: DATE,
    vehicles: [
      { packageId: 'premium-detail', sizeId: 'sedan' },
      { packageId: 'boat-basico', sizeId: 'boat_16_20' }
    ]
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.perVehicleDurationMinutes, [90, 180]);
  assert.equal(res.body.visitDurationMinutes, 180, 'the visit is the longest vehicle, not 270 minutes');
  assert.equal(res.body.timezone, 'America/New_York');
  assert.equal(res.body.vehicleCount, 2);
  // Priced server-side from the ids, since sizes were supplied:
  // premium-detail/sedan $125 + boat-basico/boat_16_20 $120.
  assert.equal(res.body.estimate.min, 245);
});

test('availability never offers Sunday and rejects more than four vehicles', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // Walk a fortnight and confirm no Sunday is ever offered.
  const from = DATE;
  const to = new Date(Date.parse(`${DATE}T00:00:00Z`) + 13 * 86400000).toISOString().slice(0, 10);
  const res = await callHandler(availabilityHandler, { from, to, vehicles: [{ packageId: 'premium-detail' }] });
  res.body.dates.forEach(entry => {
    assert.notEqual(new Date(`${entry.date}T00:00:00Z`).getUTCDay(), 0, `${entry.date} is a Sunday`);
  });

  const tooMany = await callHandler(availabilityHandler, {
    from, to,
    vehicles: Array.from({ length: 5 }, () => ({ packageId: 'premium-detail' }))
  });
  assert.equal(tooMany.statusCode, 422);
});

test('48 hours of notice applies to memberships only', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // Tomorrow is inside the 48-hour membership window but well past the one-hour
  // notice a normal wash needs.
  const tomorrow = nextWeekday(1);
  const normal = await callHandler(availabilityHandler, {
    from: tomorrow, to: tomorrow, vehicles: [{ packageId: 'premium-detail' }]
  });
  assert.ok(normal.body.dates.length, 'a normal wash can be booked tomorrow');
  assert.equal(normal.body.noticeHours, 1);

  const member = await callHandler(availabilityHandler, {
    from: tomorrow, to: tomorrow, vehicles: [{ packageId: 'membresia-2x' }]
  });
  assert.equal(member.body.dates.length, 0, 'a membership cannot be booked inside 48 hours');
  assert.equal(member.body.noticeHours, 48);

  const rejected = await callHandler(
    holdsHandler,
    holdRequest([membership()], { date: tomorrow }),
    withKey('notice-00000001')
  );
  assert.equal(rejected.statusCode, 409);
  assert.match(rejected.body.error, /48 hours/);
});

test('a booking is confirmed only by a verified payment, and confirming is idempotent', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, holdRequest([membership(), car()]), withKey('pay-000000001'));
  const holdId = held.body.holdId;

  // Held is not confirmed.
  assert.equal(ctx.repository.__store().holds[0].status, 'active');
  ctx.repository.__store().bookings.forEach(booking => assert.equal(booking.status, 'held'));

  await agenda.attachCustomer({
    holdId, submissionId: 'sub-000002', contactId: 'contact-9', customer: { name: 'Jane', address: '1 Palm Ave' }
  });
  assert.equal(ctx.repository.__store().holds[0].status, 'converted');
  ctx.repository.__store().bookings.forEach(booking => assert.equal(booking.status, 'pending_payment'));

  const config = require('../api/_lib/ghl.js').getConfig();
  const paid = await agenda.confirmPayment({
    provider: 'highlevel', externalEventId: 'evt-100', eventType: 'InvoicePaid',
    outcome: 'paid', holdId, amountCents: 5000, config
  });
  assert.equal(paid.confirmed, true);

  const store = ctx.repository.__store();
  assert.equal(store.holds[0].status, 'confirmed');
  store.bookings.forEach(booking => assert.equal(booking.status, 'confirmed'));
  store.assignments.forEach(assignment => assert.equal(assignment.status, 'confirmed'));

  // Paying a DEPOSIT buys this one visit and nothing else. It must not top up a
  // membership balance: credits are granted by a paid Stripe invoice and spent
  // when a wash is delivered (see tests/memberships.test.js). Booking a membership
  // package through the deposit flow used to grant credits here, which paid the
  // customer for merely booking.
  assert.equal(await ctx.repository.membershipCreditBalance('contact-9'), 0);
  assert.equal(ctx.repository.__store().ledger.length, 0);

  // The same webhook firing again changes nothing.
  const replay = await agenda.confirmPayment({
    provider: 'highlevel', externalEventId: 'evt-100', eventType: 'InvoicePaid',
    outcome: 'paid', holdId, amountCents: 5000, config
  });
  assert.equal(replay.alreadyProcessed, true);
  assert.equal(ctx.repository.__store().ledger.length, 0);

  // Confirmation turns each block slot into a real appointment on the same van.
  const appointments = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
  assert.equal(appointments.length, 2);
  assert.deepEqual(ctx.ghl.deleted.sort(), ['block-1', 'block-2']);
});

test('a failed payment releases every van immediately', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, holdRequest([car(0), car(1)]), withKey('failpay-000001'));
  const holdId = held.body.holdId;

  const result = await agenda.confirmPayment({
    provider: 'highlevel', externalEventId: 'evt-fail', eventType: 'invoice.failed', outcome: 'failed', holdId
  });
  assert.equal(result.released, true);

  const store = ctx.repository.__store();
  assert.equal(store.holds[0].status, 'released');
  store.assignments.forEach(assignment => assert.equal(assignment.status, 'released'));
  store.bookings.forEach(booking => assert.equal(booking.status, 'cancelled'));
  const busy = await ctx.repository.busyAssignments({ fromMs: 0, toMs: Date.now() + 1e11 });
  assert.equal(busy.length, 0);
});

test('paying after the hold lapsed is a conflict, not a confirmation', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, holdRequest([car()]), withKey('late-00000001'));
  const holdId = held.body.holdId;

  const result = await agenda.confirmPayment({
    provider: 'highlevel', externalEventId: 'evt-late', eventType: 'InvoicePaid', outcome: 'paid',
    holdId, now: Date.parse(held.body.expiresAt) + 1000
  });
  assert.equal(result.conflict, true);
  assert.equal(result.status, 'expired');
  assert.equal(ctx.repository.__store().holds[0].status, 'expired');
});

test('an underpaid deposit does not confirm the booking', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, holdRequest([hauler()]), withKey('under-00000001'));
  assert.equal(held.body.deposit, 50);

  const result = await agenda.confirmPayment({
    provider: 'highlevel', externalEventId: 'evt-under', eventType: 'InvoicePaid', outcome: 'paid',
    holdId: held.body.holdId, amountCents: 3000
  });
  assert.equal(result.conflict, true);
  assert.equal(result.reason, 'underpaid');
  assert.equal(result.expectedCents, 5000);
  assert.notEqual(ctx.repository.__store().holds[0].status, 'confirmed');
});

test('slots are computed in the location timezone, whatever the server or browser thinks', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // A January date (EST, UTC-5) and a July one (EDT, UTC-4). 09:00 local must map
  // to a different UTC instant in each, which is exactly what a fixed offset — or
  // the browser's zone — would get wrong.
  const time = require('../api/_lib/time.js');
  assert.equal(time.zonedDateTimeToIso('2027-01-12', '09:00'), '2027-01-12T14:00:00.000Z');
  assert.equal(time.zonedDateTimeToIso('2027-07-12', '09:00'), '2027-07-12T13:00:00.000Z');

  const res = await callHandler(holdsHandler, holdRequest([car()]), withKey('tz-0000000001'));
  assert.equal(res.body.timezone, 'America/New_York');
  // The response is an absolute instant; the browser only renders it.
  assert.match(res.body.slotStart, /Z$/);
});

test('a released hold frees its vans for the next customer', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const config = require('../api/_lib/ghl.js').getConfig();
  const first = await callHandler(holdsHandler, holdRequest([car(0), car(1), car(2), car(3)]), withKey('rel-a-0000001'));
  assert.equal(first.statusCode, 201);

  const blocked = await callHandler(holdsHandler, holdRequest([car()]), withKey('rel-b-0000001'));
  assert.equal(blocked.statusCode, 409, 'the fleet is fully held');

  await agenda.releaseHold({ holdId: first.body.holdId, reason: 'abandoned', config });

  const afterRelease = await callHandler(holdsHandler, holdRequest([car()]), withKey('rel-c-0000001'));
  assert.equal(afterRelease.statusCode, 201);
  assert.equal(ctx.ghl.deleted.length, 4, 'the four block slots were removed from HighLevel');
});

test('holds are refused outside the working day and off the 30-minute grid', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // boat-basico is three hours; starting at 16:00 would run past 18:00.
  const late = await callHandler(holdsHandler, holdRequest([boat()], { startTime: '16:00' }), withKey('late2-0000001'));
  assert.equal(late.statusCode, 400);
  assert.match(late.body.error, /working day/);

  const offGrid = await callHandler(holdsHandler, holdRequest([car()], { startTime: '09:07' }), withKey('grid-00000001'));
  assert.equal(offGrid.statusCode, 400);

  const sunday = (() => {
    for (let offset = 7; offset < 21; offset += 1) {
      const date = new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) return date;
    }
    return null;
  })();
  const onSunday = await callHandler(holdsHandler, holdRequest([car()], { date: sunday }), withKey('sun-00000001'));
  assert.equal(onSunday.statusCode, 400);
});
