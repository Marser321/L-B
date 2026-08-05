'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const recurring = require('../api/_lib/crm-recurring-memberships.js');
const webhook = require('../api/payments/webhook.js');
const member = require('../api/member.js');
const redemption = require('../api/_lib/redemption-token.js');
const { installEnv } = require('./support/harness.js');

function payload(overrides = {}) {
  return {
    submissionId: '123e4567-e89b-12d3-a456-426614174000',
    customer: {
      name: 'Test Member', phone: '(239) 555-0100', email: 'member@example.test',
      address: '123 Main St', city: 'Naples', zip: '34120'
    },
    items: [{
      packageId: 'membresia-2x', sizeId: 'sedan', amount: 1, priceId: 'attacker-price',
      vehicle: { year: 2024, make: 'Toyota', model: 'Camry', color: 'White', plate: 'TEST1' }
    }],
    ...overrides
  };
}

test('membership enrollment accepts exactly one server-priced vehicle', () => {
  const result = member._test.validateEnrollment(payload());
  assert.equal(result.packageId, 'membresia-2x');
  assert.equal(result.sizeId, 'sedan');
  assert.equal(result.vehicleLabel, '2024 Toyota Camry White (TEST1)');
  assert.equal(Object.hasOwn(result, 'amount'), false);
  assert.equal(Object.hasOwn(result, 'priceId'), false);

  assert.throws(
    () => member._test.validateEnrollment(payload({ items: [payload().items[0], payload().items[0]] })),
    error => error.code === 'MEMBERSHIP_ONE_PER_CHECKOUT' && error.statusCode === 422
  );
  assert.throws(
    () => member._test.validateEnrollment(payload({ items: [{ ...payload().items[0], packageId: 'premium-detail' }] })),
    error => error.statusCode === 422
  );
});

// Every assertion below was written FROM a live 422, not from the docs. The enrollment
// had four separate contract errors and each one only surfaced by actually calling the
// API — which is exactly why these are pinned here now.
test('the invoice line carries a name, because HighLevel rejects the schedule without one', async () => {
  const item = await recurring.resolveItem({
    config: { locationId: 'loc-1' },
    request: async (config, path) => (path.startsWith('/products/?')
      ? { products: [{ _id: 'prod-1', description: require('../api/_lib/crm-membership-provisioning.js').productDescription('membresia-2x') }] }
      : { prices: [{ _id: 'price-1', name: 'Membresía 2x — Cars & SUVs · Sedan', amount: 150, type: 'recurring', currency: 'usd', recurring: { interval: 'month', intervalCount: 1 } }] }),
    packageId: 'membresia-2x', sizeId: 'sedan', vehicleLabel: 'Camry'
  });

  // The bug: `entry.label` does not exist on a membership catalog entry, so `name` was
  // undefined, JSON.stringify dropped the key, and the live API answered
  // 422 "items.0.name should not be empty". A missing key is invisible until it is sent.
  assert.equal(typeof item.name, 'string');
  assert.ok(item.name.length > 0, 'la línea de factura no puede ir sin nombre');
  assert.equal(item.name, 'Membresía 2x — Cars & SUVs · Sedan');
  assert.equal(item.description, 'Camry');
  assert.equal(item.amount, 150);
});

test('the schedule id is read from the top level, where HighLevel actually puts it', () => {
  // The real create response, trimmed. Note it HAS a `schedule` key — holding the
  // rrule, not the schedule object. Descending into it found no id, so the caller
  // concluded nothing had been created while an orphan subscription sat in the CRM.
  const real = { _id: 'sched-1', status: 'draft', schedule: { rrule: { intervalType: 'monthly' } }, items: [], name: 'L&B Membership — c1' };
  assert.equal(recurring.scheduleIdFrom(real), 'sched-1');

  // Envelopes that other HighLevel endpoints use still work.
  assert.equal(recurring.scheduleIdFrom({ invoiceSchedule: { _id: 'sched-2' } }), 'sched-2');
  assert.equal(recurring.scheduleIdFrom({ data: { id: 'sched-3' } }), 'sched-3');
  // And nothing is invented out of a response that carries no id.
  assert.equal(recurring.scheduleIdFrom({ schedule: { rrule: {} } }), '');
  assert.equal(recurring.scheduleIdFrom(null), '');
});

test('recurring schedule owns amount and monthly cadence', () => {
  const body = recurring.schedulePayload({
    config: { locationId: 'loc-1' },
    contact: { id: 'contact-1', name: 'Test Member', phone: '+12395550100', email: 'member@example.test' },
    item: { name: 'Membership', productId: 'product-1', priceId: 'price-1', currency: 'USD', amount: 150, qty: 1, type: 'recurring' },
    reference: 'contract-1', now: Date.UTC(2026, 7, 4, 12), liveMode: false, timeZone: 'America/New_York'
  });
  assert.equal(body.liveMode, false);
  assert.equal(body.items[0].amount, 150);
  assert.equal(body.schedule.rrule.intervalType, 'monthly');
  assert.equal(body.schedule.rrule.interval, 1);
  assert.equal(body.schedule.rrule.daysBefore, 0);
  assert.equal(body.schedule.rrule.endType, 'never');
});

test('booking identifiers take precedence over an invoice id in payment events', () => {
  const event = webhook._test.validateRequest({
    type: 'InvoicePaid', id: 'event-1', invoiceId: 'invoice-123',
    submissionId: '123e4567-e89b-12d3-a456-426614174000', amountPaid: 30
  });
  assert.equal(event.kind, 'booking');
  assert.equal(event.submissionId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(event.amountCents, 3000);
});

test('standard nested HighLevel payment data can identify a deposit invoice', () => {
  const event = webhook._test.validateRequest({
    type: 'InvoicePaid', kind: 'booking', payment: { id: 'txn-1', invoiceId: 'invoice-123', amount: 30 }
  });
  assert.equal(event.kind, 'booking');
  assert.equal(event.externalEventId, 'txn-1');
  assert.equal(event.invoiceId, 'invoice-123');
  assert.equal(event.amountCents, 3000);
});

test('payable URL extraction never exposes CRM ids or arbitrary strings', () => {
  assert.equal(recurring.payableUrl({ invoice: { _id: 'secret-id', paymentUrl: 'https://pay.example/invoice' } }), 'https://pay.example/invoice');
  assert.equal(recurring.payableUrl({ invoice: { _id: 'secret-id', note: 'https://not-a-link.example' } }), '');
});

test('redemption tokens are opaque, expire, and do not expose the contract id', () => {
  installEnv({ MEMBER_LINK_SECRET: 'x'.repeat(40) });
  const contractId = 'opp-membership-opaque';
  const token = redemption.issue(contractId, 60_000);
  assert.equal(redemption.verify(token), contractId);
  assert.equal(token.includes(contractId), false);

  // Corrupt BYTES, not the last base64url character. That character can carry padding
  // bits, so several different characters decode to the same bytes — swapping it left
  // the token intact often enough to make this test fail roughly one run in four.
  const corrupt = (index, label) => {
    const bytes = Buffer.from(token, 'base64url');
    bytes[index] ^= 0xff;
    assert.throws(
      () => redemption.verify(bytes.toString('base64url')),
      error => error.code === 'MEMBERSHIP_REDEMPTION_INVALID',
      label
    );
  };
  corrupt(2, 'IV alterado');
  corrupt(20, 'tag de autenticación alterado');
  corrupt(Buffer.from(token, 'base64url').length - 1, 'texto cifrado alterado');
});

// ── One contract, at most one recurring schedule ───────────────────────────
//
// This is the failure that costs the customer real money every month, so the decision
// table gets tested directly rather than through a happy-path booking.

const ghl = require('../api/_lib/ghl.js');
const membershipCrm = require('../api/_lib/membership-crm.js');

const SCHEDULE_META = { fields: { scheduleId: 'field-schedule', portalUrl: 'field-portal' } };

// Awaits `run` before restoring. Restoring synchronously would put the real modules
// back while the call under test was still in flight, and the assertions would then be
// made against a live HighLevel client instead of the stubs.
async function withStubs(stubs, run) {
  const originals = stubs.map(([target, name]) => [target, name, target[name]]);
  stubs.forEach(([target, name, replacement]) => { target[name] = replacement; });
  try { return await run(); } finally { originals.forEach(([target, name, original]) => { target[name] = original; }); }
}

function contractWith(scheduleValue) {
  return {
    id: 'opp-1',
    customFields: scheduleValue === undefined ? [] : [{ id: 'field-schedule', fieldValue: scheduleValue }]
  };
}

test('a contract that already has a schedule reuses it instead of subscribing twice', async () => {
  const writes = [];
  let created = 0;
  await withStubs([
    [ghl, 'updateOpportunityFields', async (config, id, fields) => { writes.push(fields); }],
    [recurring, 'scheduleUrl', async () => 'https://pay.example/existing'],
    [recurring, 'createAndSchedule', async () => { created += 1; return { scheduleId: 'sched-new' }; }]
  ], async () => {
    const result = await member._test.ensureRecurringSchedule(
      { locationId: 'loc-1' }, SCHEDULE_META, contractWith('sched-existing'), { id: 'contact-1' }, { submissionId: 'sub-1' }
    );
    assert.equal(result.scheduleId, 'sched-existing');
    assert.equal(result.reused, true);
    assert.equal(result.url, 'https://pay.example/existing');
  });
  // The whole point: no second monthly charge, and nothing rewritten.
  assert.equal(created, 0);
  assert.equal(writes.length, 0);
});

test('an attempt whose outcome is unknown adopts the orphan schedule if it exists', async () => {
  let created = 0;
  const writes = [];
  await withStubs([
    [ghl, 'updateOpportunityFields', async (config, id, fields) => { writes.push(fields[0]); }],
    [recurring, 'findScheduleByReference', async () => 'sched-orphan'],
    [recurring, 'scheduleUrl', async () => 'https://pay.example/orphan'],
    [recurring, 'createAndSchedule', async () => { created += 1; return { scheduleId: 'sched-new' }; }]
  ], async () => {
    const result = await member._test.ensureRecurringSchedule(
      { locationId: 'loc-1' }, SCHEDULE_META,
      contractWith(`${member._test.ATTEMPT_PREFIX}sub-1`), { id: 'contact-1' }, { submissionId: 'sub-1' }
    );
    assert.equal(result.scheduleId, 'sched-orphan');
  });
  assert.equal(created, 0);
  // The marker is replaced by the real id, so the next retry takes the cheap path.
  assert.deepEqual(writes[0], { id: 'field-schedule', value: 'sched-orphan' });
});

test('an attempt in doubt refuses rather than risking a second monthly charge', async () => {
  let created = 0;
  await withStubs([
    [ghl, 'updateOpportunityFields', async () => {}],
    [recurring, 'findScheduleByReference', async () => ''],
    [recurring, 'createAndSchedule', async () => { created += 1; return { scheduleId: 'sched-new' }; }]
  ], async () => {
    await assert.rejects(
      () => member._test.ensureRecurringSchedule(
        { locationId: 'loc-1' }, SCHEDULE_META,
        contractWith(`${member._test.ATTEMPT_PREFIX}sub-1`), { id: 'contact-1' }, { submissionId: 'sub-1' }
      ),
      error => error.code === 'MEMBERSHIP_SCHEDULE_IN_DOUBT' && error.statusCode === 409
    );
  });
  // Failing closed: a membership the office finishes by hand beats billing twice.
  assert.equal(created, 0);
});

test('a fresh contract marks the attempt BEFORE creating, then records the real id', async () => {
  const writes = [];
  await withStubs([
    [ghl, 'updateOpportunityFields', async (config, id, fields) => { writes.push(fields[0]); }],
    [recurring, 'createAndSchedule', async () => {
      // By the time HighLevel is asked, the marker must already be on the contract —
      // otherwise a crash here leaves no trace that a schedule may exist.
      assert.deepEqual(writes[0], { id: 'field-schedule', value: `${member._test.ATTEMPT_PREFIX}sub-1` });
      return { scheduleId: 'sched-new', url: 'https://pay.example/new' };
    }]
  ], async () => {
    const result = await member._test.ensureRecurringSchedule(
      { locationId: 'loc-1' }, SCHEDULE_META, contractWith(undefined), { id: 'contact-1' }, { submissionId: 'sub-1' }
    );
    assert.equal(result.scheduleId, 'sched-new');
    assert.equal(result.reused, false);
  });
  assert.deepEqual(writes[1], { id: 'field-schedule', value: 'sched-new' });
});

test('the schedule is found again by the same name it was created with', async () => {
  const reference = 'opp-abc';
  const payload = recurring.schedulePayload({
    config: { locationId: 'loc-1' }, contact: { id: 'c1', name: 'A', phone: '+1' },
    item: { name: 'M', amount: 150 }, reference, now: Date.UTC(2026, 7, 4), liveMode: false, timeZone: 'UTC'
  });
  assert.equal(payload.name, recurring.scheduleName(reference));

  // Tolerant about the envelope on purpose: the exact shape of this endpoint is still
  // being pinned down, and a lookup that throws would push the caller towards creating
  // a duplicate instead of refusing.
  for (const listed of [
    { schedules: [{ _id: 'sched-1', name: recurring.scheduleName(reference) }] },
    { data: [{ id: 'sched-1', name: recurring.scheduleName(reference) }] },
    [{ _id: 'sched-1', name: recurring.scheduleName(reference) }]
  ]) {
    const found = await recurring.findScheduleByReference({
      config: { locationId: 'loc-1' }, request: async () => listed, reference
    });
    assert.equal(found, 'sched-1');
  }

  // A different contract's schedule is never adopted, and a failing lookup says "no".
  assert.equal(await recurring.findScheduleByReference({
    config: { locationId: 'loc-1' }, request: async () => ({ schedules: [{ _id: 'x', name: recurring.scheduleName('other') }] }), reference
  }), '');
  assert.equal(await recurring.findScheduleByReference({
    config: { locationId: 'loc-1' }, request: async () => { throw new Error('502'); }, reference
  }), '');
});

// ── Turning the membership into a real recurring charge ────────────────────

test('auto-payment is only attempted once a saved card exists, and never breaks the cycle', async () => {
  const config = { locationId: 'loc-1' };

  // No schedule on the contract yet: nothing to turn on.
  assert.deepEqual(
    await recurring.enableAutoPayment({ config, request: async () => ({}), scheduleId: '' }),
    { enabled: false, reason: 'no-schedule' }
  );

  // A member who has not paid yet has no Stripe customer or payment method. HighLevel's
  // only autoPayment.type is `saved_card`, so there is simply nothing to enable — and
  // that is the NORMAL state at enrolment, not an error.
  assert.deepEqual(
    await recurring.enableAutoPayment({ config, request: async () => ({ data: [] }), scheduleId: 'sched-1' }),
    { enabled: false, reason: 'no-saved-card' }
  );

  // Once the first invoice is paid, the ids can be mined from what it left behind.
  const withCard = async (config_, path) => (path.startsWith('/invoices/')
    ? { _id: 'inv-1', payment: { customerId: 'cus_live', paymentMethodId: 'pm_live' } }
    : { data: [] });
  let sent = null;
  const request = async (config_, path, options) => {
    if (options && options.method === 'POST') { sent = { path, body: options.body }; return { ok: true }; }
    return withCard(config_, path);
  };
  assert.deepEqual(
    await recurring.enableAutoPayment({ config, request, scheduleId: 'sched-1', invoiceId: 'inv-1' }),
    { enabled: true }
  );
  assert.match(sent.path, /\/invoices\/schedule\/sched-1\/auto-payment$/);
  assert.deepEqual(sent.body.autoPayment, {
    enable: true, type: 'saved_card', customerId: 'cus_live', paymentMethodId: 'pm_live'
  });

  // A rejection is swallowed: the member already paid for this cycle and must get it.
  const rejecting = async (config_, path, options) => {
    if (options && options.method === 'POST') { const error = new Error('nope'); error.statusCode = 500; throw error; }
    return withCard(config_, path);
  };
  const result = await recurring.enableAutoPayment({ config, request: rejecting, scheduleId: 'sched-1', invoiceId: 'inv-1' });
  assert.equal(result.enabled, false);
  assert.match(result.reason, /^rejected-/);
});

test('a pending attempt marker is never mistaken for a schedule id', async () => {
  const membershipCrm = require('../api/_lib/membership-crm.js');
  const fieldIds = { scheduleId: 'field-schedule' };
  const contractWith = value => async () => ({ opportunity: { id: 'opp-1', customFields: [{ id: 'field-schedule', fieldValue: value }] } });

  const original = ghl.ghlRequest;
  try {
    ghl.ghlRequest = contractWith('sched-real');
    assert.equal(await membershipCrm.readScheduleId({}, fieldIds, 'opp-1'), 'sched-real');
    // The marker names an ATTEMPT. Acting on it would aim a request at something that
    // may never have been created.
    ghl.ghlRequest = contractWith('pending:sub-1');
    assert.equal(await membershipCrm.readScheduleId({}, fieldIds, 'opp-1'), '');
  } finally { ghl.ghlRequest = original; }
});

// ── What the crew is told to collect ───────────────────────────────────────

test('add-ons billed online are never shown to the crew as an outstanding balance', () => {
  const crew = require('../api/crew.js');
  const contract = { contractId: 'opp-1', packageId: 'membresia-2x' };
  const addons = [{ id: 'motor', name: 'Limpieza de motor', amount: 40 }];

  const online = membershipCrm.visitDescription(contract, { startTime: '09:00', addons, addonTotal: 40, addonPayment: 'online' });
  // The invoice is already out, so there is nothing to take at the door. Leaving the
  // amount in `total` had the crew collect the same $40 a second time, in cash.
  assert.equal(crew._test.moneyFromDescription(online).balance, 0);
  // The amount is still on the record, just not as something to collect on site.
  assert.match(online, /extras_monto: \$40/);

  const cash = membershipCrm.visitDescription(contract, { startTime: '09:00', addons, addonTotal: 40, addonPayment: 'cash' });
  assert.equal(crew._test.moneyFromDescription(cash).balance, 40);

  // A membership wash with no add-ons owes nothing either way.
  const plain = membershipCrm.visitDescription(contract, { startTime: '09:00' });
  assert.equal(crew._test.moneyFromDescription(plain).balance, 0);
});

test('member add-ons are package-scoped and priced only by the server catalog', () => {
  const contract = { packageId: 'membresia-2x' };
  const available = member._test.availableAddons(contract);
  assert.ok(available.length > 0);
  const selected = member._test.selectedAddons(contract, [available[0].id]);
  assert.equal(selected[0].amount, available[0].amount);
  assert.throws(() => member._test.selectedAddons(contract, ['not-a-real-addon']), error => error.code === 'MEMBERSHIP_ADDON_INVALID');
});
