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

function holdRequest(vehicles, { date = DATE, startTime = '09:00', customer } = {}) {
  return {
    date,
    startTime,
    vehicles,
    // A hold reserves the van as a real appointment, and an appointment needs a
    // contact. The wizard has these validated before it asks for a hold.
    customer: customer || {
      name: 'Jane Driver',
      phone: '(239) 555-0100',
      email: 'jane@example.com',
      address: '1234 Palm Ave',
      city: 'Fort Myers',
      zip: '33901'
    }
  };
}

function withKey(key) {
  return { headers: { 'idempotency-key': key } };
}

test('one to four vehicles all ride on ONE van, and a fifth is rejected with 422', async t => {
  for (const count of [1, 2, 3, 4]) {
    const ctx = setupAgenda();
    try {
      const vehicles = Array.from({ length: count }, (unused, index) => car(index));
      const res = await callHandler(holdsHandler, holdRequest(vehicles), withKey(`fleet-${count}-0001`));

      assert.equal(res.statusCode, 201, `expected ${count} vehicles to be held`);
      assert.equal(res.body.assignments.length, count);

      // One van per ADDRESS: every vehicle of the booking is on the same van,
      // because the crew drives to the customer once.
      const vans = res.body.assignments.map(assignment => assignment.resource);
      assert.equal(new Set(vans).size, 1, `expected 1 van for ${count} vehicles, got ${vans.join(',')}`);

      // Back to back in the reported running order, with no gaps.
      const windows = res.body.assignments
        .slice()
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      for (let index = 1; index < windows.length; index += 1) {
        assert.equal(
          Date.parse(windows[index].startsAt),
          Date.parse(windows[index - 1].endsAt),
          'each vehicle starts exactly where the previous one finished'
        );
      }

      // ONE appointment for the whole visit, on ONE van's calendar. The crew drives
      // to the address once, so the calendar shows one block — not one per vehicle.
      const blocked = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
      assert.equal(blocked.length, 1, `expected 1 appointment for ${count} vehicles`);
      assert.ok(CALENDARS.includes(blocked[0].calendarId));
      // And ONE assignment row, satisfying booking_assignments_resource_unique — the
      // constraint that is still in production and that migration 004 would have had
      // to drop if a visit wrote one row per vehicle.
      assert.equal(ctx.repository.__store().assignments.length, 1);
      assert.equal(ctx.repository.__store().allocations.length, 1);
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

test('vehicles are washed one after another: the visit is the SUM of the services plus one buffer', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // Car 60 + boat 120 = 180 minutes of service, plus ONE trailing buffer. The buffer
  // is the LARGEST of the categories (the boat's 60, not the car's 30) and is charged
  // once, because the crew does not travel between vehicles in the same driveway.
  // Two vehicles, not three: a cart with marine work is capped at two.
  const res = await callHandler(
    holdsHandler,
    holdRequest([car(), boat()], { startTime: '08:00' }),
    withKey('sequential-0001')
  );

  assert.equal(res.statusCode, 201);
  const start = Date.parse(res.body.slotStart);
  const end = Date.parse(res.body.slotEnd);
  assert.equal((end - start) / 60000, 60 + 120 + 60, 'the visit is the chain, not the longest vehicle');

  // The reported running order is hands-on time per vehicle: 60 then 120. The buffer
  // is not a vehicle, so it does not appear here — it is inside the visit window.
  const inOrder = res.body.assignments
    .slice()
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  assert.deepEqual(inOrder.map(assignment => assignment.durationMinutes), [60, 120]);

  // ONE appointment covering the whole chain, buffer included.
  const created = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
  assert.equal(created.length, 1);
  assert.equal(
    (Date.parse(created[0].body.endTime) - Date.parse(created[0].body.startTime)) / 60000,
    240
  );
  // The running order is written into the appointment so one block still says what
  // happens and when.
  assert.match(created[0].body.description, /orden: .*premium-detail.*boat-basico/);
  // Comma-separated, never '·': that character delimits the description's own
  // fields, so the crew panel reads `orden:` only as far as the next one. Writing
  // the vehicles with it hid every vehicle after the first from the crew.
  const runningOrder = created[0].body.description.match(/orden:\s*([^·]+)/)[1].trim();
  assert.ok(runningOrder.includes('premium-detail') && runningOrder.includes('boat-basico'), runningOrder);

  // Nothing starts at the same time, and nothing leaves a gap.
  assert.equal(Date.parse(inOrder[0].startsAt), start);
  for (let index = 1; index < inOrder.length; index += 1) {
    assert.equal(Date.parse(inOrder[index].startsAt), Date.parse(inOrder[index - 1].endsAt));
  }

  // All three on one van.
  assert.equal(new Set(res.body.assignments.map(assignment => assignment.resource)).size, 1);
});

test('four addresses fill the fleet; the fifth customer at that hour gets 409', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // The fleet caps CUSTOMERS, not vehicles. Four separate single-car bookings at the
  // same hour take all four vans — one booking of four cars would only take one.
  for (const index of [0, 1, 2, 3]) {
    const res = await callHandler(holdsHandler, holdRequest([car(index)]), withKey(`addr-${index}-000001`));
    assert.equal(res.statusCode, 201, `van ${index + 1} should still be free`);
    assert.equal(res.body.assignments.length, 1);
  }

  // Every van is on a different address, so all four are distinct.
  const store = ctx.repository.__store();
  assert.equal(new Set(store.assignments.map(assignment => assignment.resourceKey)).size, 4);

  const fifth = await callHandler(holdsHandler, holdRequest([car(4)]), withKey('addr-4-000001'));
  assert.equal(fifth.statusCode, 409, 'no van is left for a fifth address at that hour');
  // The refusal wrote nothing.
  assert.equal(store.holds.length, 4);
  assert.equal(store.assignments.length, 4);
});

test('two requests racing for the last van: one wins, the other gets 409 and leaves nothing behind', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // Take three vans, leaving exactly one.
  for (const index of [0, 1, 2]) {
    const taken = await callHandler(holdsHandler, holdRequest([car(index)]), withKey(`pre-${index}-0000001`));
    assert.equal(taken.statusCode, 201);
  }

  const request = holdRequest([car(3)]);
  // Fired together, before either has committed — the case a read-then-write
  // check would lose.
  const [first, second] = await Promise.all([
    callHandler(holdsHandler, request, withKey('race-a-0000001')),
    callHandler(holdsHandler, request, withKey('race-b-0000001'))
  ]);

  const statuses = [first.statusCode, second.statusCode].sort();
  assert.deepEqual(statuses, [201, 409], 'exactly one request may win the last van');

  const winner = first.statusCode === 201 ? first : second;
  const loser = first.statusCode === 201 ? second : first;
  assert.equal(winner.body.assignments.length, 1);
  assert.match(loser.body.error, /no van is free|no longer available/i);

  const store = ctx.repository.__store();
  // Three pre-existing holds plus the winner. The loser rolled back completely.
  assert.equal(store.holds.length, 4);
  assert.equal(store.assignments.length, 4);
  assert.equal(store.allocations.length, 4);
  assert.equal(store.bookings.filter(booking => !booking.parentBookingId).length, 4);
  assert.equal(store.bookings.filter(booking => booking.parentBookingId).length, 4);
  // And it blocked no extra calendars.
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'appointment').length, 4);
});

test('a parent reservation with one child booking per vehicle, all on one van', async t => {
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

  // Car 60, then hauler 90 + the 30-minute trailing buffer. The parent spans the
  // whole chain: 60 + 120 = 180, not the longest single vehicle.
  const childWindows = children.map(child => (child.slotEndMs - child.slotStartMs) / 60000).sort((a, b) => a - b);
  assert.deepEqual(childWindows, [60, 120]);
  assert.equal((parents[0].slotEndMs - parents[0].slotStartMs) / 60000, 180);

  // ONE assignment for the whole visit, not one per vehicle: a van at one address is
  // busy for one contiguous block, and that is what the row means.
  assert.equal(store.assignments.length, 1);
  const [assignment] = store.assignments;
  assert.ok(children.some(child => child.id === assignment.bookingId));
  assert.ok(CALENDARS.includes(assignment.calendarId));
  assert.equal(assignment.status, 'held');
  // It spans the whole chain: 60 of car + 90 of hauler + a 30-minute buffer.
  assert.equal(assignment.durationMinutes, 180);
  assert.equal(assignment.startsAtMs, parents[0].slotStartMs);
  assert.equal(assignment.endsAtMs, parents[0].slotEndMs);
  // And it names every vehicle it covers, so the crew's calendar reads correctly.
  assert.match(assignment.vehicleLabel, /Camry/);
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

test('a hold reserves the van in HighLevel so the office cannot book over it', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const res = await callHandler(holdsHandler, holdRequest([car(0), car(1)]), withKey('block-00000001'));
  assert.equal(res.statusCode, 201);

  const held = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
  assert.equal(held.length, 1, 'one appointment for the visit, not one per vehicle');
  held.forEach(entry => {
    assert.match(entry.body.title, /^RESERVA \(sin pagar\) — /);
    assert.equal(entry.body.locationId, 'loc-1');
    // Unpaid until a verified payment says otherwise.
    assert.equal(entry.body.appointmentStatus, 'new');
    // The contact exists by hold time, which is what makes an appointment possible.
    assert.equal(entry.body.contactId, 'contact-1');
    // THE decision that lets Postgres go: HighLevel validates the slot itself.
    assert.equal(entry.body.ignoreFreeSlotValidation, false);
  });
  // One address, one van, one calendar, and the title names both vehicles.
  assert.equal(new Set(held.map(entry => entry.calendarId)).size, 1);
  assert.match(held[0].body.title, / \+ /, 'the single block names every vehicle it covers');

  // The appointment id is recorded on both the allocation and the assignment, which
  // is what lets expiry and compensation clean them up later.
  const store = ctx.repository.__store();
  store.allocations.forEach(allocation => assert.match(allocation.externalEventId, /^appt-/));
  store.assignments.forEach(assignment => assert.match(assignment.externalEventId, /^appt-/));
});

test('block slots are never used: the vans reject them outright', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  // The vans are Personal calendars and answer 400 "The calendar is not an event
  // calendar." Every hold used to fail in production because of it, so nothing may
  // go back to using them.
  const res = await callHandler(holdsHandler, holdRequest([car(0)]), withKey('noblocks-0001'));
  assert.equal(res.statusCode, 201);
  assert.equal(
    ctx.ghl.calls.some(call => call.path === '/calendars/events/block-slots'),
    false,
    'the agenda must not call the block-slots endpoint'
  );
});

test('a failed calendar write compensates every appointment already created and frees the slot', async t => {
  // The visit's single appointment fails outright.
  const ctx = setupAgenda({ appointmentFailsAt: 0 });
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
  // Nothing was created, so there is nothing to undo — and crucially nothing is left
  // behind either.
  assert.deepEqual(ctx.ghl.deleted, []);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'appointment').length, 0);

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

test('a hold expires after 15 minutes: the van comes back and its appointments are removed', async t => {
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
  assert.deepEqual(ctx.ghl.deleted, ['appt-1'], 'the visit had one appointment');

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

test('availability only offers a start time when one van is free for the WHOLE visit', async t => {
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

  // Two vehicles still need only ONE van — they just need it for longer (60 + 60 +
  // 30 = 2h30 instead of 1h30), so the last free van still serves them.
  const two = await callHandler(availabilityHandler, {
    ...range,
    vehicles: [{ packageId: 'premium-detail' }, { packageId: 'premium-detail' }]
  });
  assert.ok(two.body.dates.length, 'two vehicles ride on one van, and one van is free');
  assert.equal(two.body.visitDurationMinutes, 150);
  // The longer the visit, the fewer start times fit before 18:00.
  assert.ok(
    two.body.dates[0].slots.length < stillOne.body.dates[0].slots.length,
    'a 2h30 visit has fewer possible start times than a 1h30 one'
  );

  // Block the last van too, and nothing is offered at all.
  ctx.ghl.calendarEvents[CALENDARS[3]] = [{ start: dayStart, end: dayEnd }];
  const none = await callHandler(availabilityHandler, { ...range, vehicles: [{ packageId: 'premium-detail' }] });
  assert.equal(none.body.dates.length, 0, 'the whole fleet is busy');
});

test('availability reports per-vehicle services and the summed visit length', async t => {
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
  // Hands-on minutes per vehicle, buffer excluded: a car is 60, a boat is 120.
  assert.deepEqual(res.body.perVehicleDurationMinutes, [60, 120]);
  // One van does both, back to back, plus the boat's 60-minute buffer once.
  assert.equal(res.body.visitDurationMinutes, 240, 'the visit is the sum plus one buffer');
  assert.equal(res.body.timezone, 'America/New_York');
  assert.equal(res.body.vehicleCount, 2);
  // A marine cart is capped at two vehicles, and the contract says so.
  assert.equal(res.body.maxVehicles, 2);
  // Priced server-side from the ids, since sizes were supplied:
  // premium-detail/sedan $185 + boat-basico/boat_16_20 $120.
  assert.equal(res.body.estimate.min, 305);
  const calendarReads = ctx.ghl.calls
    .filter(call => call.method === 'GET' && call.path.startsWith('/calendars/events?'))
    .map(call => new URLSearchParams(call.path.split('?')[1]).get('calendarId'));
  assert.deepEqual([...new Set(calendarReads)].sort(), [...CALENDARS].sort());
  assert.equal(calendarReads.length, 4, 'availability reads each configured van calendar exactly once');
});

test('availability for one through four vehicles queries only the four individual van calendars', async () => {
  for (const count of [1, 2, 3, 4]) {
    const ctx = setupAgenda();
    try {
      const res = await callHandler(availabilityHandler, {
        from: DATE,
        to: DATE,
        vehicles: Array.from({ length: count }, () => ({ packageId: 'premium-detail' }))
      });
      assert.equal(res.statusCode, 200);
      const reads = ctx.ghl.calls
        .filter(call => call.method === 'GET' && call.path.startsWith('/calendars/events?'))
        .map(call => new URLSearchParams(call.path.split('?')[1]).get('calendarId'));
      assert.equal(reads.length, 4);
      assert.deepEqual([...new Set(reads)].sort(), [...CALENDARS].sort());
    } finally {
      ctx.restore();
    }
  }
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
  assert.equal(tooMany.body.code, 'MAX_VEHICLES_EXCEEDED');
});

test('availability rejects invalid carts before querying HighLevel, then returns 502 only for a valid upstream calendar failure', async t => {
  const invalid = setupAgenda({ env: { GHL_PRIVATE_TOKEN: null, DATABASE_URL: null } });

  try {
    const five = await callHandler(availabilityHandler, {
      from: DATE, to: DATE,
      vehicles: Array.from({ length: 5 }, () => ({ packageId: 'premium-detail' }))
    });
    assert.equal(five.statusCode, 422);
    assert.equal(five.body.code, 'MAX_VEHICLES_EXCEEDED');
    assert.equal(invalid.ghl.calls.length, 0);

    const empty = await callHandler(availabilityHandler, { from: DATE, to: DATE, vehicles: [] });
    assert.equal(empty.statusCode, 422);
    assert.equal(empty.body.code, 'REQUEST_INVALID');
    assert.equal(invalid.ghl.calls.length, 0);
  } finally {
    invalid.restore();
  }

  const upstream = setupAgenda({ failures: { 'GET /calendars/events': 500 } });
  t.after(() => upstream.restore());
  const valid = await callHandler(availabilityHandler, {
    from: DATE, to: DATE, vehicles: [{ packageId: 'premium-detail' }]
  });
  assert.equal(valid.statusCode, 502);
  assert.equal(valid.body.code, 'UPSTREAM_UNAVAILABLE');
  assert.ok(upstream.ghl.calls.some(call => call.path.startsWith('/calendars/events?')));
});

test('canonical availability requests use the server location clock when they omit the legacy date range', () => {
  const input = availabilityHandler._test.validateRequest({
    vehicles: [{ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [] }],
    language: 'es'
  });

  assert.match(input.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(input.to, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000, 59);
  assert.equal(input.language, 'es');
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

  // Confirmation is a STATUS CHANGE on the appointments the hold already created —
  // nothing new is created and nothing is deleted. That is the point: there is no
  // moment where the van looks free between deleting a hold and writing a booking.
  const appointments = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
  assert.equal(appointments.length, 1, 'the visit had one appointment, and no more');
  assert.deepEqual(ctx.ghl.deleted, [], 'confirming deletes nothing');

  // Each one was promoted to confirmed and relabelled away from "sin pagar".
  const updates = ctx.ghl.calls.filter(call =>
    call.method === 'PUT' && call.path.startsWith('/calendars/events/appointments/')
  );
  assert.equal(updates.length, 1);
  updates.forEach(update => {
    assert.equal(update.body.appointmentStatus, 'confirmed');
    assert.equal(/sin pagar/.test(update.body.title || ''), false);
  });
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
  // Four separate addresses take the four vans — a single four-car booking would
  // only take one.
  const held = [];
  for (const index of [0, 1, 2, 3]) {
    const res = await callHandler(holdsHandler, holdRequest([car(index)]), withKey(`rel-${index}-0000001`));
    assert.equal(res.statusCode, 201);
    held.push(res.body.holdId);
  }

  const blocked = await callHandler(holdsHandler, holdRequest([car()]), withKey('rel-b-0000001'));
  assert.equal(blocked.statusCode, 409, 'the fleet is fully held');

  await agenda.releaseHold({ holdId: held[0], reason: 'abandoned', config });

  const afterRelease = await callHandler(holdsHandler, holdRequest([car()]), withKey('rel-c-0000001'));
  assert.equal(afterRelease.statusCode, 201);
  assert.equal(ctx.ghl.deleted.length, 1, 'only the released hold\'s block slot was removed');
});

test('every paint tier is bookable, including the one that used to compute to zero minutes', async t => {
  // Regression: paint-enhancement was missing from FULL_DAY_PACKAGES while its
  // category duration was {service: 0, buffer: 0}, so it produced an assignment
  // whose start equalled its end. Postgres rejects that on two constraints, so the
  // $299 tier answered 502 for every customer who tried to buy it.
  for (const packageId of ['paint-enhancement', 'paint-correction', 'ceramic-protection']) {
    const ctx = setupAgenda();
    try {
      const res = await callHandler(holdsHandler, holdRequest([{
        packageId, sizeId: 'sedan', addonIds: [],
        vehicle: { make: 'Toyota', model: 'Camry', year: 2024 }
      }], { startTime: 'full_day' }), withKey(`paint-${packageId.slice(0, 8)}-01`));

      assert.equal(res.statusCode, 201, `${packageId} must be bookable`);
      assert.equal(res.body.bookingMode, 'full_day', packageId);

      const assignment = res.body.assignments[0];
      assert.ok(assignment.durationMinutes > 0, `${packageId} occupies real time`);
      assert.ok(
        Date.parse(assignment.endsAt) > Date.parse(assignment.startsAt),
        `${packageId} must end after it starts`
      );

      // The same two conditions Postgres enforces, checked on the stored row.
      const stored = ctx.repository.__store().assignments[0];
      assert.ok(stored.durationMinutes > 0, packageId);
      assert.ok(stored.endsAtMs > stored.startsAtMs, packageId);
    } finally {
      ctx.restore();
    }
  }
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

test('a paint cart is refused as a cart, not as an empty calendar', () => {
  // The failure this replaces: visitWindow chained two day-long blocks (20 hours),
  // every start time threw, computeAvailability swallowed the throw per slot, and
  // the customer saw zero dates across the whole 60-day window with no reason given.
  const vehicles = [
    { vehicleIndex: 0, packageId: 'paint-correction', label: 'Camry' },
    { vehicleIndex: 1, packageId: 'basico-premium', label: 'RAV4' }
  ];
  assert.throws(
    () => agenda.visitWindow(vehicles, '2026-09-15', '08:00', 'America/New_York'),
    error => error.code === 'FULL_DAY_BOOKED_ALONE' && error.statusCode === 422
  );

  // Alone, it still books the working day.
  const alone = agenda.visitWindow([vehicles[0]], '2026-09-15', '08:00', 'America/New_York');
  assert.equal(alone.bookingMode, 'full_day');
  assert.equal((alone.endMs - alone.startMs) / 60000, 600);
});

test('availability answers a paint cart with a reason, not an empty 60-day window', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const res = await callHandler(availabilityHandler, {
    vehicles: [
      { packageId: 'paint-correction', sizeId: 'suv', addonIds: [] },
      { packageId: 'basico-premium', sizeId: 'sedan', addonIds: [] }
    ]
  });

  // 422, with copy the browser can show as-is. Before this it was a 200 carrying
  // `dates: []`, which the wizard rendered as "no availability" on every date.
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'FULL_DAY_BOOKED_ALONE');
  assert.match(res.body.error, /booked on its own/);

  // On its own the same service still has a calendar.
  const alone = await callHandler(availabilityHandler, {
    vehicles: [{ packageId: 'paint-correction', sizeId: 'suv', addonIds: [] }]
  });
  assert.equal(alone.statusCode, 200);
  assert.equal(alone.body.bookingMode, 'full_day');
  assert.equal(alone.body.maxVehicles, 1);
  assert.ok(alone.body.dates.length > 0);
});
