'use strict';

// Payment links: the office path and the web path, and the guarantee that neither
// lets a caller decide the amount.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupMemberships, callHandler } = require('./support/harness.js');
const linksHandler = require('../api/payments/links.js');
const paymentLinks = require('../api/_lib/payment-links.js');
const crmCatalog = require('../api/_lib/crm-catalog.js');
const crmProvisioning = require('../api/_lib/crm-catalog-provisioning.js');

const OFFICE = { headers: { authorization: 'Bearer office-token' } };

function customer(overrides = {}) {
  return { contactId: 'contact-1', name: 'Jane Driver', email: 'jane@example.com', phone: '+12395550100', ...overrides };
}

// Provisions the CRM catalog into the in-memory price map, the way the
// provisioner script would after `--apply`.
async function seedCrmCatalog(ctx, { livemode = false, kinds = crmCatalog.KINDS } = {}) {
  const crmState = { products: [], prices: {} };
  let nextId = 1;
  const request = async (cfg, path, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const [route] = path.split('?');
    if (method === 'GET' && route === '/products/') {
      const offset = Number(new URLSearchParams(path.split('?')[1] || '').get('offset') || 0);
      return { products: crmState.products.slice(offset, offset + crmProvisioning.PAGE_SIZE) };
    }
    if (method === 'POST' && route === '/products/') {
      const product = { _id: `prod_${nextId++}`, ...options.body };
      crmState.products.push(product);
      return { product };
    }
    const list = route.match(/^\/products\/([^/]+)\/price$/);
    if (list && method === 'GET') return { prices: crmState.prices[list[1]] || [] };
    if (list && method === 'POST') {
      const price = { _id: `price_${nextId++}`, ...options.body, priceType: options.body.type };
      crmState.prices[list[1]] = (crmState.prices[list[1]] || []).concat([price]);
      return { price };
    }
    throw new Error(`unexpected CRM call ${method} ${route}`);
  };

  const summary = await crmProvisioning.provision({ config: { locationId: 'loc-1' }, request, apply: true, kinds });
  const rows = summary.mapping
    .filter(entry => entry.crmPriceId)
    .map(entry => ({
      id: `map-${entry.priceKey}`,
      catalogVersion: crmCatalog.CRM_CATALOG_VERSION,
      livemode,
      ...entry
    }));
  await ctx.repository.transaction(['seed'], async tx => tx.upsertCrmPriceMap(rows));
  return summary;
}

// ── The office path ────────────────────────────────────────────────────────

test('the office can send a link for a one-time job, priced by the server', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await seedCrmCatalog(ctx);

  const res = await callHandler(linksHandler, {
    purpose: 'service',
    reference: 'quote-4471',
    customer: customer(),
    vehicles: [{ packageId: 'premium-detail', sizeId: 'suv', addonIds: ['limpieza-motor'] }],
    deposit: false
  }, OFFICE);

  assert.equal(res.statusCode, 201);
  // premium-detail/suv $215 + limpieza-motor $30.
  assert.equal(res.body.amount, 245);
  assert.deepEqual(res.body.lines.map(line => line.amount), [215, 30]);
  // Both lines are backed by a real CRM product, which is what makes the sale
  // reportable per product.
  assert.ok(res.body.lines.every(line => line.linked));
  assert.match(res.body.url, /^https:\/\//);
});

test('an amount in the request is ignored', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await seedCrmCatalog(ctx);

  const res = await callHandler(linksHandler, {
    purpose: 'service',
    reference: 'quote-tampered',
    customer: customer(),
    // Every one of these is a lie and none of them reaches the invoice.
    amount: 1, total: 1, discount: 99,
    vehicles: [{ packageId: 'premium-detail', sizeId: 'suv', addonIds: [], amount: 1, priceId: 'price_attacker' }]
  }, OFFICE);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.amount, 215);

  const invoice = ctx.ghl.created.find(entry => entry.kind === 'invoice');
  assert.equal(invoice.body.items[0].amount, 215);
  assert.equal(JSON.stringify(invoice.body).includes('price_attacker'), false);
});

test('the same reference issues one link, however many times it is clicked', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await seedCrmCatalog(ctx);

  const body = {
    purpose: 'service', reference: 'quote-double-click', customer: customer(),
    vehicles: [{ packageId: 'basico-exterior', sizeId: 'sedan', addonIds: [] }]
  };
  const first = await callHandler(linksHandler, body, OFFICE);
  const second = await callHandler(linksHandler, body, OFFICE);
  const third = await callHandler(linksHandler, body, OFFICE);

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(third.body.duplicate, true);
  assert.equal(second.body.url, first.body.url);

  // One invoice in the CRM, not three.
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 1);
});

test('the endpoint is closed to anyone without the office token', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  const anonymous = await callHandler(linksHandler, { purpose: 'service', reference: 'x-1234' });
  assert.equal(anonymous.statusCode, 401);

  const wrong = await callHandler(linksHandler, { purpose: 'service', reference: 'x-1234' }, {
    headers: { authorization: 'Bearer nope' }
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 0);
});

test('a membership cannot be sold as a one-time line', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await seedCrmCatalog(ctx);

  // Charging a membership once would take the money and create no contract, no
  // credits and no renewal: a customer who believes they joined and did not.
  const res = await callHandler(linksHandler, {
    purpose: 'service', reference: 'bad-membership', customer: customer(),
    vehicles: [{ packageId: 'membresia-2x', sizeId: 'sedan', addonIds: [] }]
  }, OFFICE);

  assert.equal(res.statusCode, 422);
  assert.match(res.body.error, /use purpose "membership"/);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 0);
});

test('the deposit is a flag, and the server picks which one', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await seedCrmCatalog(ctx);

  const small = await callHandler(linksHandler, {
    purpose: 'booking_deposit', reference: 'dep-small', customer: customer(),
    vehicles: [{ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [] }], deposit: true
  }, OFFICE);
  // $185 service + $30 standard deposit.
  assert.equal(small.body.amount, 215);
  assert.ok(small.body.lines.some(line => line.name.includes('Standard') && line.amount === 30));

  const large = await callHandler(linksHandler, {
    purpose: 'booking_deposit', reference: 'dep-large', customer: customer(),
    vehicles: [{ packageId: 'semi-truck-wash', sizeId: 'standard', addonIds: [] }], deposit: true
  }, OFFICE);
  assert.ok(large.body.lines.some(line => line.name.includes('Large Vehicle') && line.amount === 50));
});

// ── Line building ──────────────────────────────────────────────────────────

test('lines carry the CRM product only once the catalog is provisioned', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());

  // Before provisioning: priced correctly, but not linked to a CRM product.
  const before = await paymentLinks.buildLines({
    purpose: 'service',
    vehicles: [{ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [] }],
    livemode: false,
    repository: ctx.repository
  });
  assert.equal(before[0].amountCents, 18500);
  assert.equal(before[0].crmPriceId, null);

  await seedCrmCatalog(ctx);
  const after = await paymentLinks.buildLines({
    purpose: 'service',
    vehicles: [{ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [] }],
    livemode: false,
    repository: ctx.repository
  });
  assert.equal(after[0].amountCents, 18500);
  assert.match(after[0].crmPriceId, /^price_/);
});

test('a custom-quote add-on is never charged automatically', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  await seedCrmCatalog(ctx);

  const lines = await paymentLinks.buildLines({
    purpose: 'service',
    vehicles: [{ packageId: 'semi-truck-wash', sizeId: 'standard', addonIds: ['pulido-tanques', 'rines-aluminio'] }],
    livemode: false,
    repository: ctx.repository
  });

  // The aluminium tank polishing has no price; the office quotes it by hand.
  assert.equal(lines.some(line => line.addonId === 'pulido-tanques'), false);
  assert.equal(lines.some(line => line.addonId === 'rines-aluminio'), true);
});

test('the invoice sends dollars and never cents', () => {
  const payload = paymentLinks.invoicePayload({
    config: { locationId: 'loc-1', assignedUserId: 'user-1' },
    contact: { id: 'contact-1', name: 'Jane', email: 'jane@example.com', phone: '+1' },
    lines: [{ name: 'Premium Detail · Sedan', amountCents: 12500, quantity: 1, crmProductId: 'prod_1', crmPriceId: 'price_1' }],
    name: 'Service — hold:abc',
    liveMode: false
  });
  assert.equal(payload.items[0].amount, 125);
  assert.equal(payload.items[0].productId, 'prod_1');
  assert.equal(payload.items[0].priceId, 'price_1');
  assert.equal(payload.liveMode, false);
  assert.equal(payload.action, 'send');
});

test('a CRM failure marks the link failed instead of leaving a phantom claim', async t => {
  const ctx = setupMemberships({ failures: { 'POST /invoices/text2pay': 500 } });
  t.after(() => ctx.restore());
  await seedCrmCatalog(ctx);

  const res = await callHandler(linksHandler, {
    purpose: 'service', reference: 'will-fail', customer: customer(),
    vehicles: [{ packageId: 'basico-exterior', sizeId: 'sedan', addonIds: [] }]
  }, OFFICE);

  assert.equal(res.statusCode >= 400, true);
  const stored = await ctx.repository.getPaymentLinkByKey('office:service:will-fail');
  assert.equal(stored.status, 'failed');
  assert.ok(stored.failureReason);
});

// ── When the ledger table is not there ─────────────────────────────────────

// Simulates production on 2026-08-06: migration 003 had shipped in the code but was
// never applied, so every query against payment_links / crm_price_map came back
// 42P01. The deposit link disappeared from every website booking and the customer
// was shown "payment unavailable" — a booking nobody could pay for.
function withoutPaymentTables(ctx) {
  const undefinedTable = () => Object.assign(new Error('relation "payment_links" does not exist'), { code: '42P01' });
  const realTransaction = ctx.repository.transaction.bind(ctx.repository);
  ctx.repository.transaction = async (keys, fn) => {
    if (keys.some(key => String(key).startsWith('payment-link:'))) throw undefinedTable();
    return realTransaction(keys, fn);
  };
  ctx.repository.findCrmPrice = async () => { throw undefinedTable(); };
}

test('a missing payment ledger costs the audit row, never the customer\'s ability to pay', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  withoutPaymentTables(ctx);

  const lines = await paymentLinks.buildLines({ purpose: 'booking_deposit', deposit: { amount: 30 }, livemode: false });
  // No price map, so no CRM product ids — but the amount is still the server's.
  assert.equal(lines.length, 1);
  assert.equal(lines[0].amountCents, 3000);
  assert.equal(lines[0].crmProductId, null);

  const link = await paymentLinks.issuePaymentLink({
    idempotencyKey: 'deposit:hold-no-ledger',
    purpose: 'booking_deposit',
    origin: 'web',
    contact: { id: 'contact-1', name: 'Jane Driver', email: 'jane@example.com', phone: '+12395550100' },
    lines,
    holdId: 'hold-no-ledger',
    config: ctx.config
  });

  assert.match(link.url, /^https:\/\//);
  assert.equal(link.degraded, true);
  const invoice = ctx.ghl.created.find(entry => entry.kind === 'invoice');
  assert.equal(invoice.body.items[0].amount, 30);
});

test('without the ledger, the CRM itself keeps the link idempotent', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  withoutPaymentTables(ctx);

  const lines = await paymentLinks.buildLines({ purpose: 'booking_deposit', deposit: { amount: 50 }, livemode: false });
  const request = () => paymentLinks.issuePaymentLink({
    idempotencyKey: 'deposit:hold-retry',
    purpose: 'booking_deposit',
    origin: 'web',
    contact: { id: 'contact-1', name: 'Jane Driver', email: 'jane@example.com', phone: '+12395550100' },
    lines,
    holdId: 'hold-retry',
    config: ctx.config
  });

  const first = await request();
  const second = await request();

  assert.equal(first.duplicate, false);
  // The name is deterministic ("Booking Deposit — hold:<id>"), so the CRM can answer
  // "already invoiced" in place of the row we could not write.
  assert.equal(second.duplicate, true);
  assert.equal(second.url, first.url);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 1);
});

test('a hold with a different id still gets its own invoice', async t => {
  const ctx = setupMemberships();
  t.after(() => ctx.restore());
  withoutPaymentTables(ctx);

  const lines = await paymentLinks.buildLines({ purpose: 'booking_deposit', deposit: { amount: 30 }, livemode: false });
  const forHold = holdId => paymentLinks.issuePaymentLink({
    idempotencyKey: `deposit:${holdId}`,
    purpose: 'booking_deposit',
    origin: 'web',
    contact: { id: 'contact-1', name: 'Jane Driver', email: 'jane@example.com', phone: '+12395550100' },
    lines,
    holdId,
    config: ctx.config
  });

  await forHold('hold-aaa');
  const other = await forHold('hold-bbb');
  assert.equal(other.duplicate, false);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'invoice').length, 2);
});
