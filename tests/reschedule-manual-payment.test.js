'use strict';

// The two gaps that were costing money every week: moving an appointment, and
// recording a payment taken in person.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupMemberships, callHandler, nextWeekday } = require('./support/harness.js');
const memberships = require('../api/_lib/memberships.js');
const visitsHandler = require('../api/memberships/visits.js');
const manualPaymentHandler = require('../api/payments/manual.js');
const holdsHandler = require('../api/bookings/holds.js');
const agenda = require('../api/_lib/agenda.js');

const DAY = 24 * 60 * 60 * 1000;
const OFFICE = { headers: { authorization: 'Bearer office-token' } };

// An active contract with a paid cycle, seeded directly.
//
// This used to run a Stripe checkout and replay two webhooks. Stripe was removed on
// 2026-08-04 and everything stays in HighLevel; what these tests exercise is that
// MOVING an appointment does not cost a wash, which has nothing to do with who took
// the payment.
async function activeContract(ctx, now) {
  await ctx.activateContract({ packageId: 'membresia-2x', sizeId: 'sedan', now });
  return ctx.contracts()[0];
}

// ── Rescheduling ───────────────────────────────────────────────────────────

test('moving an appointment does not cost a wash', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const contract = await activeContract(ctx, now);
  const booked = await memberships.bookVisit({ contractId: contract.id, date: nextWeekday(7), startTime: '09:00', now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);
  // Captured as a primitive: the in-memory repository hands back live row objects
  // (Postgres returns snapshots), so holding the row and comparing it later would
  // compare the row with itself.
  const originalStartMs = booked.visit.scheduledStartMs;

  // Moved from inside the 24-hour window, which as a CANCELLATION would have
  // spent the wash. Rescheduling is not a no-show.
  const nearly = booked.visit.scheduledStartMs - 3 * 60 * 60 * 1000;
  const moved = await memberships.rescheduleVisit({
    visitId: booked.visit.id, date: nextWeekday(21), startTime: '11:00', now: nearly
  });

  assert.equal(moved.creditConsumed, false);
  assert.equal(ctx.contracts()[0].creditsRemaining, 2, 'the balance is untouched');
  assert.equal(ctx.ledger().filter(row => row.delta < 0).length, 0, 'nothing was debited');

  // Still exactly one open visit, now at the new time.
  const open = ctx.visits().filter(visit => ['held', 'confirmed'].includes(visit.status));
  assert.equal(open.length, 1);
  assert.equal(open[0].id, booked.visit.id);
  assert.notEqual(open[0].scheduledStartMs, originalStartMs);
  assert.equal(open[0].status, 'confirmed', 'a confirmed visit stays confirmed at its new time');
});

test('the old slot goes back on the market and the new one is taken', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const contract = await activeContract(ctx, now);
  const originalDate = nextWeekday(7);
  const booked = await memberships.bookVisit({ contractId: contract.id, date: originalDate, startTime: '09:00', now });
  const originalHoldId = booked.visit.holdId;

  await memberships.rescheduleVisit({ visitId: booked.visit.id, date: nextWeekday(14), startTime: '13:00', now });

  const store = ctx.repository.__store();
  const oldHold = store.holds.find(hold => hold.id === originalHoldId);
  assert.equal(oldHold.status, 'released');
  assert.equal(oldHold.failureReason, 'rescheduled');

  // The vans of the old slot are free again; the new slot holds them instead.
  const oldAssignments = store.assignments.filter(assignment => assignment.parentBookingId === oldHold.parentBookingId);
  assert.ok(oldAssignments.every(assignment => assignment.status === 'released'));
  const live = store.assignments.filter(assignment => ['held', 'confirmed'].includes(assignment.status));
  assert.equal(live.length, 1);
});

test('a failed move leaves the original appointment untouched', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const contract = await activeContract(ctx, now);
  const booked = await memberships.bookVisit({ contractId: contract.id, date: nextWeekday(7), startTime: '09:00', now });
  const originalStart = booked.visit.scheduledStartMs;

  // The whole fleet is busy at the target time, so the move cannot succeed.
  const target = nextWeekday(14);
  const busyFrom = Date.parse(`${target}T12:00:00.000Z`);
  require('./support/harness.js').CALENDARS.forEach(calendarId => {
    ctx.ghl.calendarEvents[calendarId] = [{ start: busyFrom, end: busyFrom + 8 * 3600_000 }];
  });

  await assert.rejects(
    memberships.rescheduleVisit({ visitId: booked.visit.id, date: target, startTime: '09:00', now })
  );

  // The customer still has the appointment they started with — the new slot is
  // taken before the old one is released precisely so this cannot lose it.
  const visit = ctx.visits()[0];
  assert.equal(visit.scheduledStartMs, originalStart);
  assert.equal(['held', 'confirmed'].includes(visit.status), true);
  assert.equal(ctx.repository.__store().holds.find(hold => hold.id === visit.holdId).status, 'active');
});

test('a move still respects the 48-hour rule and the end of a cancelling membership', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const contract = await activeContract(ctx, now);
  const booked = await memberships.bookVisit({ contractId: contract.id, date: nextWeekday(7), startTime: '09:00', now });

  await assert.rejects(
    memberships.rescheduleVisit({ visitId: booked.visit.id, date: nextWeekday(1), startTime: '09:00', now }),
    /48 hours/
  );

  // A membership set to end still moves inside the cycle it paid for, but not past it.
  // Setting cancel-at-period-end was a payment-webhook job and went with Stripe, so
  // the state is seeded — the rule under test reads the contract, not the event.
  await ctx.repository.transaction(['seed'], async tx => tx.updateContract(contract.id, {
    cancelAtPeriodEnd: true,
    currentPeriodEndMs: now + 10 * DAY
  }));

  await assert.rejects(
    memberships.rescheduleVisit({ visitId: booked.visit.id, date: nextWeekday(30), startTime: '09:00', now }),
    /ends before that date/
  );
});

test('the endpoint exposes reschedule to the customer, without the office token', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const contract = await activeContract(ctx, now);
  const booked = await memberships.bookVisit({ contractId: contract.id, date: nextWeekday(7), startTime: '09:00', now });

  const res = await callHandler(visitsHandler, {
    action: 'reschedule', visitId: booked.visit.id, date: nextWeekday(14), startTime: '11:00'
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.creditConsumed, false);
  assert.ok(res.body.startsAt);
  assert.equal(res.body.crew.length, 1);
});

const HOLD_CUSTOMER = Object.freeze({
  name: 'Jane Driver', phone: '(239) 555-0100', email: 'jane@example.com',
  address: '1234 Palm Ave', city: 'Fort Myers', zip: '33901'
});

// ── Manual payment ─────────────────────────────────────────────────────────

test('a payment taken in cash confirms the booking, once', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, {
    date: nextWeekday(7), startTime: '09:00',
    vehicles: [{ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [], vehicle: { make: 'Toyota', model: 'Camry', year: 2024 } }],
    // A hold is an appointment now, and an appointment needs a contact.
    customer: HOLD_CUSTOMER
  }, { headers: { 'idempotency-key': 'manual-pay-0001' } });
  assert.equal(held.statusCode, 201);
  assert.equal(held.body.deposit, 30);

  const res = await callHandler(manualPaymentHandler, {
    holdId: held.body.holdId, method: 'cash', amount: 30,
    reference: 'recibo-8842', takenBy: 'Brenda'
  }, OFFICE);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.confirmed, true);
  assert.match(res.body.message, /confirmed/i);
  assert.equal(ctx.repository.__store().holds[0].status, 'confirmed');

  // The same receipt recorded twice confirms once.
  const again = await callHandler(manualPaymentHandler, {
    holdId: held.body.holdId, method: 'cash', amount: 30,
    reference: 'recibo-8842', takenBy: 'Brenda'
  }, OFFICE);
  assert.equal(again.body.alreadyProcessed, true);
  assert.equal(ctx.repository.__store().paymentEvents.length, 1);
});

test('recording less than the deposit does not confirm anything', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, {
    date: nextWeekday(7), startTime: '09:00',
    vehicles: [{ packageId: 'semi-truck-wash', sizeId: 'standard', addonIds: [], vehicle: { make: 'Freightliner', model: 'Cascadia', year: 2021 } }],
    customer: HOLD_CUSTOMER
  }, { headers: { 'idempotency-key': 'manual-short-01' } });
  assert.equal(held.body.deposit, 50);

  const res = await callHandler(manualPaymentHandler, {
    holdId: held.body.holdId, method: 'zelle', amount: 5,
    reference: 'zelle-short', takenBy: 'Brenda'
  }, OFFICE);

  assert.equal(res.body.conflict, true);
  assert.equal(res.body.reason, 'underpaid');
  assert.notEqual(ctx.repository.__store().holds[0].status, 'confirmed');
});

test('manual payment is closed to anyone without the office token, and validates its inputs', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const anonymous = await callHandler(manualPaymentHandler, { holdId: 'x'.repeat(12), method: 'cash', amount: 30, reference: 'r-1', takenBy: 'B' });
  assert.equal(anonymous.statusCode, 401);

  const badMethod = await callHandler(manualPaymentHandler, {
    holdId: 'x'.repeat(12), method: 'bitcoin', amount: 30, reference: 'r-1', takenBy: 'B'
  }, OFFICE);
  assert.equal(badMethod.statusCode, 400);
  assert.match(badMethod.body.error, /method must be one of/);

  const noTarget = await callHandler(manualPaymentHandler, { method: 'cash', amount: 30, reference: 'r-1', takenBy: 'B' }, OFFICE);
  assert.equal(noTarget.statusCode, 400);
  assert.match(noTarget.body.error, /holdId or submissionId/);
});

test('a manual payment is recorded through the same verified-payment path', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const held = await callHandler(holdsHandler, {
    date: nextWeekday(7), startTime: '09:00',
    vehicles: [{ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [], vehicle: { make: 'Toyota', model: 'Camry', year: 2024 } }],
    // A hold is an appointment now, and an appointment needs a contact.
    customer: HOLD_CUSTOMER
  }, { headers: { 'idempotency-key': 'manual-audit-01' } });

  await callHandler(manualPaymentHandler, {
    holdId: held.body.holdId, method: 'card_terminal', amount: 30,
    reference: 'term-0099', takenBy: 'Luis'
  }, OFFICE);

  // Who took the money, how, and against which reference — the audit the
  // hand-crafted webhook call never left behind.
  const event = ctx.repository.__store().paymentEvents[0];
  assert.equal(event.provider, 'office');
  assert.equal(event.eventType, 'manual_payment');
  assert.equal(event.externalEventId, 'office:card_terminal:term-0099');
  assert.equal(event.payload.takenBy, 'Luis');
  assert.equal(event.payload.method, 'card_terminal');
});
