'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { setupMemberships, callHandler, nextWeekday } = require('./support/harness.js');

const memberships = require('../api/_lib/memberships.js');
const membershipCatalog = require('../api/_lib/membership-catalog.js');

const DAY = 24 * 60 * 60 * 1000;

// A member with a paid cycle and a full balance, written straight to the store.
//
// This used to run a Stripe checkout and replay two webhooks. Stripe was removed on
// 2026-08-04 (everything stays in HighLevel — see DISENO-SIN-BASE-DE-DATOS.md) and the
// replacement does not exist yet, so the contract is seeded directly. Nothing is lost:
// every test below is about what a membership ENTITLES you to, not about who moved the
// money.
//
// NOTE what is no longer covered anywhere, because it went with the transport: granting
// a cycle, resetting the balance on renewal (credits do not roll over), and marking a
// contract past_due or canceled. Those are GRANT rules, they only happen when a payment
// lands, and the HighLevel implementation has to re-implement them. They are written
// down as the specification in DISENO-SIN-BASE-DE-DATOS.md §2.
async function member(ctx, overrides = {}) {
  const contractId = await ctx.activateContract(overrides);
  return { contractId, contract: ctx.contracts().find(row => row.id === contractId) };
}

// ── Catalog ────────────────────────────────────────────────────────────────

test('the catalog holds 17 membership packages and 33 monthly prices', () => {
  assert.equal(membershipCatalog.products().length, 17);
  assert.equal(membershipCatalog.entries().length, 33);

  // Spot-check every shape of price in the list.
  assert.equal(membershipCatalog.priceFor('membresia-2x', 'sedan').monthlyCents, 15000);
  assert.equal(membershipCatalog.priceFor('membresia-4x', 'van_xl').monthlyCents, 48000);
  assert.equal(membershipCatalog.priceFor('box-truck-2x', 'size_21_26').monthlyCents, 25000);
  assert.equal(membershipCatalog.priceFor('trailer-4x', 'standard').monthlyCents, 70000);
  assert.equal(membershipCatalog.priceFor('jetski-membresia', 'qty_3').monthlyCents, 30000);
  assert.equal(membershipCatalog.priceFor('golf-membresia', 'standard').monthlyCents, 13000);
  assert.equal(membershipCatalog.priceFor('atv-membresia', 'qty_2').monthlyCents, 28000);

  // 2x plans include two washes, 4x include four.
  assert.equal(membershipCatalog.priceFor('membresia-2x', 'sedan').creditsPerCycle, 2);
  assert.equal(membershipCatalog.priceFor('membresia-4x', 'sedan').creditsPerCycle, 4);
  assert.equal(membershipCatalog.priceFor('garbage-truck-4x', 'standard').creditsPerCycle, 4);
});

test('a failed payment marks past_due, blocks new bookings, and keeps the paid-cycle booking', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const { contractId } = await member(ctx, { now });

  // A visit booked and confirmed inside the cycle the customer paid for.
  const date = nextWeekday(7);
  const booked = await memberships.bookVisit({ contractId, date, startTime: '09:00', now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });
  assert.equal(ctx.visits()[0].status, 'confirmed');

  // A failed renewal is what used to set this; now it is seeded, because what the
  // rule under test reads is the STATUS, not how it got there.
  await ctx.repository.transaction(['seed'], async tx => tx.updateContract(contractId, { status: 'past_due' }));

  assert.equal(ctx.contracts()[0].status, 'past_due');
  // The wash they already paid for survives — a card failing for NEXT month does
  // not take away the visit this month bought.
  assert.equal(ctx.visits()[0].status, 'confirmed');

  // But nothing new can be booked.
  const eligibility = memberships.bookingEligibility(ctx.contracts()[0], { now });
  assert.equal(eligibility.ok, false);
  assert.equal(eligibility.code, 'past_due');
  await assert.rejects(
    memberships.bookVisit({ contractId, date: nextWeekday(14), startTime: '09:00', now }),
    /unpaid invoice/
  );
});

test('a canceled contract blocks future bookings and keeps the history', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const { contractId } = await member(ctx, { now });
  const booked = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });

  await ctx.repository.transaction(['seed'], async tx =>
    tx.updateContract(contractId, { status: 'canceled', canceledAtMs: now }));

  const contract = ctx.contracts()[0];
  assert.equal(contract.status, 'canceled');
  assert.ok(contract.canceledAtMs);
  // History intact: the contract row and its visit are both still here.
  assert.equal(ctx.contracts().length, 1);
  assert.equal(ctx.visits().length, 1);

  const eligibility = memberships.bookingEligibility(contract, { now });
  assert.equal(eligibility.ok, false);
  assert.equal(eligibility.code, 'canceled');
});

// ── Visits and credits ─────────────────────────────────────────────────────

test('a membership visit needs 48 hours of notice', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await member(ctx, { now });
  const contract = ctx.contracts()[0];
  assert.equal(memberships.MEMBERSHIP_MIN_NOTICE_MS, 48 * 60 * 60 * 1000);

  const tooSoon = memberships.bookingEligibility(contract, { now, startMs: now + 47 * 60 * 60 * 1000 });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.code, 'too_soon');

  const fine = memberships.bookingEligibility(contract, { now, startMs: now + 49 * 60 * 60 * 1000 });
  assert.equal(fine.ok, true);
});

test('the credit is spent when the service is completed, not when it is booked', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await member(ctx, { now });
  const contractId = ctx.contracts()[0].id;

  const booked = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });
  assert.equal(ctx.contracts()[0].creditsRemaining, 2, 'booking costs nothing');
  await memberships.confirmVisit({ visitId: booked.visit.id, now });
  assert.equal(ctx.contracts()[0].creditsRemaining, 2, 'confirming costs nothing either');

  await memberships.completeVisit({ visitId: booked.visit.id, now });
  assert.equal(ctx.contracts()[0].creditsRemaining, 1);
  assert.equal(ctx.visits()[0].status, 'completed');
  assert.ok(ctx.visits()[0].creditConsumedAtMs);

  // Completing twice spends one wash.
  await memberships.completeVisit({ visitId: booked.visit.id, now });
  assert.equal(ctx.contracts()[0].creditsRemaining, 1);
  assert.equal(ctx.ledger().filter(row => row.reason === 'visit_completed').length, 1);
});

test('cancelling inside 24 hours spends the wash; cancelling earlier is free', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await member(ctx, { now });
  const contractId = ctx.contracts()[0].id;

  // Booked a week out, cancelled straight away: free.
  const early = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });
  const earlyResult = await memberships.cancelVisit({ visitId: early.visit.id, now });
  assert.equal(earlyResult.late, false);
  assert.equal(earlyResult.consumed, false);
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);
  assert.equal(ctx.ledger().filter(row => row.reason === 'late_cancellation').length, 0);

  // Booked again, then cancelled 23 hours before the slot: charged.
  const late = await memberships.bookVisit({ contractId, date: nextWeekday(14), startTime: '09:00', now });
  const lateNow = late.visit.scheduledStartMs - 23 * 60 * 60 * 1000;
  const lateResult = await memberships.cancelVisit({ visitId: late.visit.id, now: lateNow });
  assert.equal(lateResult.late, true);
  assert.equal(lateResult.consumed, true);
  assert.equal(ctx.contracts()[0].creditsRemaining, 1);

  // Replaying the cancellation must not charge a second wash.
  await memberships.cancelVisit({ visitId: late.visit.id, now: lateNow });
  assert.equal(ctx.contracts()[0].creditsRemaining, 1);
  assert.equal(ctx.ledger().filter(row => row.reason === 'late_cancellation').length, 1);
});

test('a no-show spends the wash, idempotently', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await member(ctx, { now });
  const contractId = ctx.contracts()[0].id;
  const booked = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });

  const after = booked.visit.scheduledEndMs + 1000;
  await memberships.markNoShow({ visitId: booked.visit.id, now: after });
  assert.equal(ctx.visits()[0].status, 'no_show');
  assert.equal(ctx.contracts()[0].creditsRemaining, 1);

  // A retried sweep costs nothing more.
  await memberships.markNoShow({ visitId: booked.visit.id, now: after });
  assert.equal(ctx.contracts()[0].creditsRemaining, 1);
  assert.equal(ctx.ledger().filter(row => row.reason === 'no_show').length, 1);
  assert.equal(ctx.notifications().filter(row => row.template === 'visit_no_show').length, 1);
});

test('an exhausted balance refuses the next booking until the cycle renews', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await member(ctx, { packageId: 'membresia-2x', now });
  const contractId = ctx.contracts()[0].id;

  // Spend both washes of the cycle.
  for (const offset of [7, 14]) {
    const visit = await memberships.bookVisit({ contractId, date: nextWeekday(offset), startTime: '09:00', now });
    await memberships.confirmVisit({ visitId: visit.visit.id, now });
    await memberships.completeVisit({ visitId: visit.visit.id, now });
  }
  assert.equal(ctx.contracts()[0].creditsRemaining, 0);

  const eligibility = memberships.bookingEligibility(ctx.contracts()[0], { now });
  assert.equal(eligibility.ok, false);
  assert.equal(eligibility.code, 'no_credits');
  await assert.rejects(
    memberships.bookVisit({ contractId, date: nextWeekday(21), startTime: '09:00', now }),
    /No washes left/
  );

  // The customer is told once that they are out.
  assert.equal(ctx.notifications().filter(row => row.template === 'membership_credits_exhausted').length, 1);

  // A renewal restores the allowance and booking works again. Granting the cycle was
  // a payment-webhook job and went with Stripe, so it is seeded here — the rule under
  // test is that an exhausted balance BLOCKS and a restored one does not.
  const renewalAt = now + 30 * DAY;
  await ctx.repository.transaction(['seed'], async tx => tx.updateContract(contractId, {
    creditsRemaining: 2,
    currentPeriodStartMs: renewalAt,
    currentPeriodEndMs: renewalAt + 30 * DAY
  }));
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);
  // Dated after the renewal instant, not merely after today: `now` has moved a
  // month forward, so the 48-hour rule is measured from there.
  const afterRenewal = await memberships.bookVisit({
    contractId, date: nextWeekday(35), startTime: '09:00', now: renewalAt
  });
  assert.ok(afterRenewal.visit.id);
});

test('one future visit per contract', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await member(ctx, { packageId: 'membresia-4x', now });
  const contractId = ctx.contracts()[0].id;
  assert.equal(ctx.contracts()[0].creditsRemaining, 4, 'plenty of credits — the limit is not about credits');

  const first = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });
  assert.ok(first.visit.id);

  // A second open visit is refused even though three washes remain.
  await assert.rejects(
    memberships.bookVisit({ contractId, date: nextWeekday(14), startTime: '11:00', now }),
    /already has a visit booked/
  );
  assert.equal(ctx.visits().filter(visit => ['held', 'confirmed'].includes(visit.status)).length, 1);

  // Once the first is delivered, the next one can be booked.
  await memberships.confirmVisit({ visitId: first.visit.id, now });
  await memberships.completeVisit({ visitId: first.visit.id, now });
  const second = await memberships.bookVisit({ contractId, date: nextWeekday(14), startTime: '11:00', now });
  assert.ok(second.visit.id);
  assert.notEqual(second.visit.id, first.visit.id);
});

