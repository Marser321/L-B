'use strict';

// Payment links, now that the CRM is the only store.
//
// What these tests used to cover and no longer can: the office endpoint
// (api/payments/links.js) and the `payment_links` / `crm_price_map` tables. Both are
// gone with Postgres — the endpoint could never deploy anyway (it was excluded to fit
// the 12-function budget, and it read a table that was never applied to production).
//
// What is left is the part production actually ran: the server prices every line, and
// the INVOICE is what makes issuing idempotent.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupAgenda } = require('./support/harness.js');
const paymentLinks = require('../api/_lib/payment-links.js');

const CONTACT = { id: 'contact-1', name: 'Jane Driver', email: 'jane@example.com', phone: '+12395550100' };

function depositLink(ctx, holdId, amount = 30) {
  const lines = paymentLinks.buildLines({ purpose: 'booking_deposit', deposit: { amount } });
  return paymentLinks.issuePaymentLink({
    idempotencyKey: `deposit:${holdId}`,
    purpose: 'booking_deposit',
    origin: 'web',
    contact: CONTACT,
    lines,
    holdId
  });
}

test('every line is priced by the server, from catalog ids alone', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const lines = paymentLinks.buildLines({
    purpose: 'service',
    vehicles: [{ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [] }]
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].amountCents, 18500);
  assert.equal(lines[0].kind, 'service');
  // The caller named a package and a size. It could not name a price.
  assert.equal(lines[0].packageId, 'premium-detail');
});

test('a custom-quote add-on is never charged automatically', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const lines = paymentLinks.buildLines({
    purpose: 'service',
    vehicles: [{ packageId: 'semi-truck-wash', sizeId: 'standard', addonIds: ['pulido-tanques', 'rines-aluminio'] }]
  });

  // The aluminium tank polishing has no price; the office quotes it by hand.
  assert.equal(lines.some(line => line.addonId === 'pulido-tanques'), false);
  assert.equal(lines.some(line => line.addonId === 'rines-aluminio'), true);
});

test('the deposit line is chosen by the server, not asked for by name', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const small = paymentLinks.buildLines({ purpose: 'booking_deposit', deposit: { amount: 30 } });
  const large = paymentLinks.buildLines({ purpose: 'booking_deposit', deposit: { amount: 50 } });

  assert.equal(small[0].amountCents, 3000);
  assert.match(small[0].name, /Standard/);
  assert.equal(large[0].amountCents, 5000);
  assert.match(large[0].name, /Large Vehicle/);
});

test('a membership line needs the contract it is billing for', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  assert.throws(
    () => paymentLinks.buildLines({ purpose: 'membership' }),
    error => error.code === 'PAYMENT_LINK_INVALID'
  );

  const lines = paymentLinks.buildLines({
    purpose: 'membership',
    contract: { packageId: 'membresia-2x', sizeId: 'sedan' }
  });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].amountCents > 0);
});

test('the invoice sends dollars and never cents', () => {
  const payload = paymentLinks.invoicePayload({
    config: { locationId: 'loc-1', assignedUserId: 'user-1' },
    contact: CONTACT,
    lines: [{ name: 'Premium Detail · Sedan', amountCents: 12500, quantity: 1 }],
    name: 'Service — hold:abc',
    liveMode: false
  });
  assert.equal(payload.items[0].amount, 125);
  assert.equal(payload.liveMode, false);
  // A draft returns a URL whose page reads "Draft invoice cannot be paid".
  assert.equal(payload.action, 'send');
});

test('the invoice itself keeps issuing idempotent', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  const first = await depositLink(ctx, 'appt-00000001', 50);
  const second = await depositLink(ctx, 'appt-00000001', 50);

  assert.equal(first.duplicate, false);
  assert.match(first.url, /^https:\/\//);
  // The name is deterministic ("Booking Deposit — hold:<id>"), so the CRM answers
  // "already invoiced" — there is no second ledger that could disagree with it.
  assert.equal(second.duplicate, true);
  assert.equal(second.url, first.url);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 1);
});

test('a different reservation gets its own invoice', async t => {
  const ctx = setupAgenda();
  t.after(() => ctx.restore());

  await depositLink(ctx, 'appt-00000001');
  const other = await depositLink(ctx, 'appt-00000002');

  assert.equal(other.duplicate, false);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 2);
});

test('a CRM failure is reported, and leaves no invoice behind to be paid twice', async t => {
  const ctx = setupAgenda({ failures: { 'POST /invoices/text2pay': 500 } });
  t.after(() => ctx.restore());

  await assert.rejects(
    () => depositLink(ctx, 'appt-00000009'),
    error => error.code === 'PAYMENT_LINK_FAILED'
  );
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 0);
});
