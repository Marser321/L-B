'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { setupMemberships, callHandler, nextWeekday } = require('./support/harness.js');
const fixtures = require('./support/stripe-fixtures.js');

const memberships = require('../api/_lib/memberships.js');
const membershipCatalog = require('../api/_lib/membership-catalog.js');
const checkoutHandler = require('../api/memberships/checkout.js');

const DAY = 24 * 60 * 60 * 1000;

function customer(overrides = {}) {
  return { name: 'Jane Driver', email: 'jane@example.com', phone: '+12395550100', ...overrides };
}

function line(packageId = 'membresia-2x', sizeId = 'sedan', model = 'Camry') {
  return {
    packageId, sizeId,
    vehicle: { make: 'Toyota', model, year: 2024, plate: 'ABC123' }
  };
}

// Runs a checkout and the checkout.session.completed webhook, leaving contracts
// in `pending` — sold, not yet paid.
async function sell(ctx, lines = [line()], { now = Date.now() } = {}) {
  await ctx.seedPriceMap(false);
  const created = await memberships.createCheckout({
    customer: customer(),
    lines: lines.map((entry, index) => memberships.validateCheckoutLine(entry, index)),
    now
  });

  const session = ctx.stripe.sessions.get(created.stripeSessionId);
  // Stripe turns each distinct price into one subscription item.
  const items = session.lineItems.map((item, index) => ({
    id: `si_${index + 1}`,
    price: { id: item.price },
    quantity: item.quantity
  }));
  const subscriptionId = 'sub_0001';
  ctx.addSubscription({
    subscriptionId,
    customerId: session.customer,
    items,
    periodStartMs: now,
    periodEndMs: now + 30 * DAY
  });

  const event = fixtures.checkoutCompleted({
    sessionId: created.stripeSessionId,
    subscriptionId,
    customerId: session.customer,
    items
  });
  await memberships.handleEvent(event, { now });

  return { created, subscriptionId, customerId: session.customer, items };
}

// Sells and pays the first invoice, leaving contracts active with a full balance.
async function sellAndPay(ctx, lines = [line()], { now = Date.now(), invoiceId = 'in_0001' } = {}) {
  const sold = await sell(ctx, lines, { now });
  const event = fixtures.invoicePaid({
    invoiceId,
    subscriptionId: sold.subscriptionId,
    customerId: sold.customerId,
    periodStartMs: now,
    periodEndMs: now + 30 * DAY
  });
  const result = await memberships.handleEvent(event, { now });
  return { ...sold, paidEvent: event, result };
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

test('the client cannot influence the amount', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await ctx.seedPriceMap(false);

  // Everything the request says about money is ignored.
  const validated = memberships.validateCheckoutLine({
    ...line('membresia-4x', 'truck'),
    monthlyCents: 1, price: 1, amount: 1, stripePriceId: 'price_attacker', creditsPerCycle: 99
  }, 0);
  assert.equal(validated.monthlyCents, 40000);
  assert.equal(validated.creditsPerCycle, 4);
  assert.equal(validated.stripePriceId, undefined);

  // A package that is not a membership cannot be bought as one.
  assert.throws(() => memberships.validateCheckoutLine(line('premium-detail', 'sedan'), 0), error => {
    assert.equal(error.statusCode, 422);
    return true;
  });
  // Nor a size the plan is not sold in.
  assert.throws(() => memberships.validateCheckoutLine(line('membresia-2x', 'boat_16_20'), 0), /not sold in size/);
});

// ── Checkout ───────────────────────────────────────────────────────────────

test('checkout reuses one Stripe customer and prices every line from the server', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await ctx.seedPriceMap(false);

  const res = await callHandler(checkoutHandler, {
    customer: customer(),
    lines: [line('membresia-2x', 'sedan'), line('membresia-4x', 'truck', 'F150')]
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(res.body.lineCount, 2);
  assert.equal(res.body.monthlyTotal, 150 + 400);

  // A second checkout for the same email must not mint a second Stripe customer.
  const again = await callHandler(checkoutHandler, {
    customer: customer(),
    lines: [line('golf-membresia', 'standard', 'Club Car')]
  });
  assert.equal(again.statusCode, 200);
  assert.equal(ctx.stripe.customers.size, 1);
});

test('two identical vehicles become one quantity-2 line and two contracts', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  // Stripe rejects duplicate prices in one checkout, so the same plan twice is a
  // single line with quantity 2 — and must still yield two separate contracts,
  // one per vehicle, each with its own balance.
  const sold = await sell(ctx, [
    line('membresia-2x', 'sedan', 'Camry'),
    line('membresia-2x', 'sedan', 'Corolla')
  ]);

  const session = ctx.stripe.sessions.get(sold.created.stripeSessionId);
  assert.equal(session.lineItems.length, 1);
  assert.equal(session.lineItems[0].quantity, 2);

  const contracts = ctx.contracts();
  assert.equal(contracts.length, 2);
  assert.deepEqual(contracts.map(contract => contract.lineIndex).sort(), [0, 1]);
  assert.deepEqual(contracts.map(contract => contract.vehicle.model).sort(), ['Camry', 'Corolla']);
  // Same subscription item, different contracts.
  assert.equal(new Set(contracts.map(contract => contract.stripeSubscriptionItemId)).size, 1);
});

// ── Webhook idempotency ────────────────────────────────────────────────────

test('a duplicate webhook is a no-op: no second contract, no second grant, no second message', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const sold = await sell(ctx, [line()], { now });
  const paid = fixtures.invoicePaid({
    invoiceId: 'in_0001', subscriptionId: sold.subscriptionId, customerId: sold.customerId,
    periodStartMs: now, periodEndMs: now + 30 * DAY, eventId: 'evt_paid_once'
  });

  const first = await memberships.handleEvent(paid, { now });
  assert.equal(first.duplicate, false);
  assert.equal(first.activated, 1);

  // Stripe redelivers the very same event, twice.
  const second = await memberships.handleEvent(paid, { now });
  const third = await memberships.handleEvent(paid, { now });
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);

  assert.equal(ctx.contracts().length, 1);
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);
  // One grant in the ledger, not three.
  assert.equal(ctx.ledger().length, 1);
  assert.equal(ctx.ledger()[0].delta, 2);
  // One SMS, not three.
  const activated = ctx.notifications().filter(row => row.template === 'membership_activated');
  assert.equal(activated.length, 1);
});

test('an event whose handler failed is retried, not swallowed as a duplicate', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const sold = await sell(ctx, [line()], { now });
  const paid = fixtures.invoicePaid({
    invoiceId: 'in_flaky', subscriptionId: sold.subscriptionId, customerId: sold.customerId,
    periodStartMs: now, periodEndMs: now + 30 * DAY, eventId: 'evt_flaky'
  });

  // First delivery blows up somewhere inside the handler.
  const repository = ctx.repository;
  const realTransaction = repository.transaction;
  let failNext = true;
  repository.transaction = async (keys, fn) => {
    if (failNext && String(keys[0]).startsWith('subscription:')) {
      failNext = false;
      throw new Error('database blipped');
    }
    return realTransaction(keys, fn);
  };

  await assert.rejects(memberships.handleEvent(paid, { now }), /database blipped/);
  const recorded = () => ctx.repository.__store().membership.stripeEvents.find(row => row.id === 'evt_flaky');
  assert.equal(recorded().status, 'failed');
  assert.equal(ctx.contracts()[0].status, 'pending', 'nothing was applied');

  // Stripe retries the same event. It must actually run this time — treating it
  // as a duplicate would lose the payment for good.
  repository.transaction = realTransaction;
  const retry = await memberships.handleEvent(paid, { now });
  assert.equal(retry.duplicate, false);
  assert.equal(retry.activated, 1);
  assert.equal(ctx.contracts()[0].status, 'active');
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);

  // And a third delivery after success is a genuine duplicate again.
  const third = await memberships.handleEvent(paid, { now });
  assert.equal(third.duplicate, true);
  assert.equal(ctx.ledger().length, 1);
});

test('a redelivered checkout.session.completed does not duplicate contracts', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const sold = await sell(ctx, [line()], { now });
  assert.equal(ctx.contracts().length, 1);

  // Same event id → short-circuited before the handler.
  const replay = fixtures.checkoutCompleted({
    sessionId: sold.created.stripeSessionId,
    subscriptionId: sold.subscriptionId,
    customerId: sold.customerId,
    items: sold.items
  });
  await memberships.handleEvent(replay, { now });
  // Different event id, same session → the handler runs but the contract insert
  // is a no-op on (subscription_item_id, line_index).
  assert.equal(ctx.contracts().length, 1);
});

// ── Payment lifecycle ──────────────────────────────────────────────────────

test('a paid invoice activates the contract, sets the cycle, and grants the credits', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await sell(ctx, [line('membresia-4x', 'suv', 'RAV4')], { now });
  assert.equal(ctx.contracts()[0].status, 'pending');
  assert.equal(ctx.contracts()[0].creditsRemaining, 0);

  const sold = ctx.contracts()[0];
  await memberships.handleEvent(fixtures.invoicePaid({
    invoiceId: 'in_first', subscriptionId: sold.stripeSubscriptionId, customerId: 'cus_0001',
    periodStartMs: now, periodEndMs: now + 30 * DAY
  }), { now });

  const contract = ctx.contracts()[0];
  assert.equal(contract.status, 'active');
  assert.equal(contract.creditsRemaining, 4, 'a 4x plan grants four washes');
  assert.equal(contract.currentPeriodStartMs, Math.floor(now / 1000) * 1000);
  assert.ok(contract.activatedByEventId, 'the paying event is recorded as proof');
  assert.equal(contract.paidInvoiceId, 'in_first');
});

test('a failed payment marks past_due, blocks new bookings, and keeps the paid-cycle booking', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const sold = await sellAndPay(ctx, [line()], { now });
  const contractId = ctx.contracts()[0].id;

  // A visit booked and confirmed inside the cycle the customer paid for.
  const date = nextWeekday(7);
  const booked = await memberships.bookVisit({ contractId, date, startTime: '09:00', now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });
  assert.equal(ctx.visits()[0].status, 'confirmed');

  await memberships.handleEvent(fixtures.invoicePaymentFailed({
    invoiceId: 'in_failed', subscriptionId: sold.subscriptionId, customerId: sold.customerId
  }), { now });

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

test('a paid renewal resets the balance instead of accumulating it', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const sold = await sellAndPay(ctx, [line()], { now });
  const contractId = ctx.contracts()[0].id;
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);

  // One wash delivered this cycle: balance 1.
  const booked = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });
  await memberships.completeVisit({ visitId: booked.visit.id, now });
  assert.equal(ctx.contracts()[0].creditsRemaining, 1);

  // Next month is paid. Unused washes do not roll over: back to 2, not 3.
  const renewalAt = now + 30 * DAY;
  const result = await memberships.handleEvent(fixtures.invoicePaid({
    invoiceId: 'in_renewal', subscriptionId: sold.subscriptionId, customerId: sold.customerId,
    periodStartMs: renewalAt, periodEndMs: renewalAt + 30 * DAY
  }), { now: renewalAt });

  assert.equal(result.renewed, 1);
  assert.equal(result.activated, 0, 'a renewal is not a first activation');
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);
  assert.equal(ctx.contracts()[0].currentPeriodEndMs, Math.floor((renewalAt + 30 * DAY) / 1000) * 1000);

  // The ledger still explains the balance: +2 granted, -1 spent, +1 reset.
  const balance = await ctx.repository.creditBalanceForContract(contractId);
  assert.equal(balance, 2);
  assert.deepEqual(ctx.ledger().map(row => row.delta), [2, -1, 1]);
  assert.deepEqual(ctx.ledger().map(row => row.reason), ['cycle_granted', 'visit_completed', 'cycle_renewed']);
});

test('cancel at period end keeps the current cycle and stops the renewal', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const sold = await sellAndPay(ctx, [line()], { now });
  const periodEnd = now + 30 * DAY;

  await memberships.handleEvent(fixtures.subscriptionUpdated({
    subscriptionId: sold.subscriptionId, customerId: sold.customerId,
    status: 'active', cancelAtPeriodEnd: true,
    periodStartMs: now, periodEndMs: periodEnd
  }), { now });

  const contract = ctx.contracts()[0];
  assert.equal(contract.status, 'active', 'the cycle they paid for is still theirs');
  assert.equal(contract.cancelAtPeriodEnd, true);
  assert.equal(contract.creditsRemaining, 2, 'credits are not clawed back');

  // Bookable inside the remaining cycle...
  const inside = memberships.bookingEligibility(contract, { now, startMs: now + 5 * DAY });
  assert.equal(inside.ok, true);
  // ...but not past the end of it.
  const after = memberships.bookingEligibility(contract, { now, startMs: periodEnd + DAY });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'after_period_end');

  assert.equal(ctx.notifications().filter(row => row.template === 'membership_cancel_scheduled').length, 1);
});

test('a deleted subscription blocks future bookings and keeps the history', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  const sold = await sellAndPay(ctx, [line()], { now });
  const contractId = ctx.contracts()[0].id;
  const booked = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });

  await memberships.handleEvent(fixtures.subscriptionDeleted({
    subscriptionId: sold.subscriptionId, customerId: sold.customerId
  }), { now });

  const contract = ctx.contracts()[0];
  assert.equal(contract.status, 'canceled');
  assert.ok(contract.canceledAtMs);
  // History intact: the contract row, its visit and its ledger are all still here.
  assert.equal(ctx.contracts().length, 1);
  assert.equal(ctx.visits().length, 1);
  assert.ok(ctx.ledger().length > 0);

  const eligibility = memberships.bookingEligibility(contract, { now });
  assert.equal(eligibility.ok, false);
  assert.equal(eligibility.code, 'canceled');
});

// ── Visits and credits ─────────────────────────────────────────────────────

test('a membership visit needs 48 hours of notice', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await sellAndPay(ctx, [line()], { now });
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
  await sellAndPay(ctx, [line()], { now });
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
  await sellAndPay(ctx, [line()], { now });
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
  await sellAndPay(ctx, [line()], { now });
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
  const sold = await sellAndPay(ctx, [line('membresia-2x', 'sedan')], { now });
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

  // The renewal restores the allowance and booking works again.
  const renewalAt = now + 30 * DAY;
  await memberships.handleEvent(fixtures.invoicePaid({
    invoiceId: 'in_renew2', subscriptionId: sold.subscriptionId, customerId: sold.customerId,
    periodStartMs: renewalAt, periodEndMs: renewalAt + 30 * DAY
  }), { now: renewalAt });
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
  await sellAndPay(ctx, [line('membresia-4x', 'sedan')], { now });
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

test('only a webhook-verified paid cycle can confirm a held visit', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  // Sold but NOT paid: no invoice.paid webhook has arrived.
  await sell(ctx, [line()], { now });
  const contract = ctx.contracts()[0];
  assert.equal(contract.status, 'pending');
  assert.equal(contract.activatedByEventId, null);

  await assert.rejects(
    memberships.bookVisit({ contractId: contract.id, date: nextWeekday(7), startTime: '09:00', now }),
    /has not been paid for yet/
  );

  // Pay it, and the same booking works.
  await memberships.handleEvent(fixtures.invoicePaid({
    invoiceId: 'in_late', subscriptionId: contract.stripeSubscriptionId, customerId: 'cus_0001',
    periodStartMs: now, periodEndMs: now + 30 * DAY
  }), { now });

  const booked = await memberships.bookVisit({ contractId: contract.id, date: nextWeekday(7), startTime: '09:00', now });
  const confirmed = await memberships.confirmVisit({ visitId: booked.visit.id, now });
  assert.equal(confirmed.visit.status, 'confirmed');
  assert.ok(confirmed.parentBookingId);
});

// ── Notifications ──────────────────────────────────────────────────────────

test('a confirmed parent booking produces exactly one notification, however often it is retried', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await sellAndPay(ctx, [line()], { now });
  const contractId = ctx.contracts()[0].id;
  const booked = await memberships.bookVisit({ contractId, date: nextWeekday(7), startTime: '09:00', now });

  const first = await memberships.confirmVisit({ visitId: booked.visit.id, now });
  // Re-confirming (a retry, a double click, a redelivered upstream call).
  await memberships.confirmVisit({ visitId: booked.visit.id, now });
  await memberships.confirmVisit({ visitId: booked.visit.id, now });

  const confirmations = ctx.notifications().filter(row => row.template === 'booking_confirmed');
  assert.equal(confirmations.length, 1, 'one message per parent booking');
  assert.equal(confirmations[0].dedupeKey, `booking:${first.parentBookingId}:confirmed`);

  // And exactly one workflow post actually left the building.
  const posts = ctx.workflowPosts.filter(post => post.body.template === 'booking_confirmed');
  assert.equal(posts.length, 1);
});

test('a notification with no configured endpoint is recorded rather than lost', async t => {
  const ctx = setupMemberships({ env: { GHL_WORKFLOW_SMS_URL: '' } });
  t.after(() => ctx.restore());

  const now = Date.now();
  await sellAndPay(ctx, [line()], { now });

  const row = ctx.notifications().find(entry => entry.template === 'membership_activated');
  assert.ok(row, 'the message is still recorded');
  assert.equal(row.status, 'failed');
  assert.equal(ctx.workflowPosts.length, 0);
});

test('a workflow that fails does not break the webhook, and never double-sends', async t => {
  const ctx = setupMemberships({ workflowFails: true });
  t.after(() => ctx.restore());

  const now = Date.now();
  // The activation SMS fails to deliver, but the payment still applies.
  const sold = await sellAndPay(ctx, [line()], { now });
  assert.equal(ctx.contracts()[0].status, 'active');
  assert.equal(ctx.contracts()[0].creditsRemaining, 2);

  const row = ctx.notifications().find(entry => entry.template === 'membership_activated');
  assert.equal(row.status, 'failed');

  // A redelivery of the invoice does not retry the message either: the claim is
  // already taken, which is the point — one message per fact, even a failed one.
  await memberships.handleEvent(fixtures.invoicePaid({
    invoiceId: 'in_0001', subscriptionId: sold.subscriptionId, customerId: sold.customerId,
    periodStartMs: now, periodEndMs: now + 30 * DAY, eventId: 'evt_other'
  }), { now });
  assert.equal(ctx.notifications().filter(entry => entry.template === 'membership_activated').length, 1);
});

// ── Webhook endpoint ───────────────────────────────────────────────────────

test('the Stripe webhook endpoint verifies the signature before doing anything', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const webhookHandler = require('../api/webhooks/stripe.js');
  const stripeLib = require('../api/_lib/stripe.js');
  const event = fixtures.stripeEvent('invoice.paid', { id: 'in_x', subscription: 'sub_x' });
  const raw = JSON.stringify(event);

  function signed(body, secret = 'whsec_harness', timestamp = Math.floor(Date.now() / 1000)) {
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  const res = await callHandler(webhookHandler, raw, {
    headers: { 'stripe-signature': signed(raw) }
  });
  // Unknown subscription, but it got past the signature check and was recorded.
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.repository.__store().membership.stripeEvents.length, 1);

  // A forged signature is rejected outright.
  const forged = await callHandler(webhookHandler, JSON.stringify({ ...event, id: 'evt_forged' }), {
    headers: { 'stripe-signature': 't=1,v1=deadbeef' }
  });
  assert.equal(forged.statusCode, 400);
  assert.equal(ctx.repository.__store().membership.stripeEvents.length, 1, 'nothing was recorded');

  // A stale-but-correctly-signed payload cannot be replayed tomorrow.
  const old = Math.floor(Date.now() / 1000) - 3600;
  const replayed = await callHandler(webhookHandler, raw, {
    headers: { 'stripe-signature': signed(raw, 'whsec_harness', old) }
  });
  assert.equal(replayed.statusCode, 400);

  // And a body we cannot see raw is refused rather than trusted.
  assert.throws(() => stripeLib.verifyWebhookSignature(raw, '', 'whsec_harness'), /Invalid Stripe signature/);
});

test('a livemode mismatch is acknowledged but never acted on', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const webhookHandler = require('../api/webhooks/stripe.js');
  // A live event arriving at a test-key endpoint.
  const event = { ...fixtures.stripeEvent('invoice.paid', { id: 'in_live' }), livemode: true };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', 'whsec_harness').update(`${timestamp}.${raw}`).digest('hex');

  const res = await callHandler(webhookHandler, raw, {
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(res.body.reason, 'livemode_mismatch');
  assert.equal(ctx.repository.__store().membership.stripeEvents.length, 0);
});

// ── HighLevel sync ─────────────────────────────────────────────────────────

test('HighLevel gets one contact and one opportunity per vehicle, once', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const now = Date.now();
  await sellAndPay(ctx, [
    line('membresia-2x', 'sedan', 'Camry'),
    line('membresia-4x', 'truck', 'F150')
  ], { now });

  const contactCalls = ctx.ghl.calls.filter(call => call.path === '/contacts/upsert');
  const opportunityCreates = ctx.ghl.created.filter(entry => entry.kind === 'opportunity');
  assert.equal(contactCalls.length, 1, 'one contact for the account holder');
  assert.equal(opportunityCreates.length, 2, 'one opportunity per vehicle contract');

  const sync = ctx.repository.__store().membership.highlevelSync;
  assert.equal(sync.filter(row => row.entityType === 'contact').length, 1);
  assert.equal(sync.filter(row => row.entityType === 'membership_opportunity').length, 2);

  // Contracts remember their opportunity, so a later sync updates instead of
  // creating a second one.
  ctx.contracts().forEach(contract => assert.ok(contract.ghlOpportunityId));
});
