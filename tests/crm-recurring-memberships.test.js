'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const memberships = require('../api/_lib/memberships.js');
const membershipCatalog = require('../api/_lib/membership-catalog.js');
const provisioning = require('../api/_lib/crm-membership-provisioning.js');
const recurring = require('../api/_lib/crm-recurring-memberships.js');
const ghl = require('../api/_lib/ghl.js');
const testEndpoint = require('../api/internal/membership-recurring-test.js');

function line(packageId, sizeId, model) {
  return memberships.validateCheckoutLine({
    packageId,
    sizeId,
    // Fields below are deliberately hostile. The builder must use only the
    // catalogue lookup and omit these from its CRM request.
    amount: 1,
    monthlyCents: 1,
    priceId: 'attacker-price',
    vehicle: { make: 'Toyota', model, year: 2024, plate: 'TEST123' }
  }, 0);
}

function price(entry, id) {
  return {
    _id: id,
    name: entry.priceLabel,
    priceType: 'recurring',
    amount: entry.monthlyCents / 100,
    currency: 'usd',
    recurring: { interval: 'month', intervalCount: 1 }
  };
}

function requestStub() {
  const entryA = membershipCatalog.entries().find(entry => entry.packageId === 'membresia-2x' && entry.sizeId === 'sedan');
  const entryB = membershipCatalog.entries().find(entry => entry.packageId === 'membresia-4x' && entry.sizeId === 'truck');
  const products = [
    { _id: 'product-a', description: provisioning.productDescription(entryA.packageId) },
    { _id: 'product-b', description: provisioning.productDescription(entryB.packageId) }
  ];
  const calls = [];
  const request = async (_config, path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/products/?')) return { products };
    if (path.startsWith('/products/product-a/price')) return { prices: [price(entryA, 'price-a')] };
    if (path.startsWith('/products/product-b/price')) return { prices: [price(entryB, 'price-b')] };
    if (path === '/contacts/upsert') return { contact: { id: 'test-contact' } };
    if (path === '/invoices/schedule') return { _id: 'test-schedule', status: 'draft', liveMode: false };
    throw new Error(`unexpected request ${path}`);
  };
  return { request, calls };
}

test('CRM recurring test draft resolves marked CRM prices and is always Stripe test mode', async () => {
  const { request, calls } = requestStub();
  const result = await recurring.createRecurringDraft({
    config: { locationId: 'loc-test' },
    request,
    now: Date.UTC(2026, 6, 28, 16),
    timeZone: 'America/New_York',
    lines: [line('membresia-2x', 'sedan', 'Camry'), line('membresia-4x', 'truck', 'F-150')],
    reference: 'crm-recurring-test-unit'
  });

  assert.deepEqual(result, {
    reference: 'crm-recurring-test-unit',
    scheduleId: 'test-schedule',
    status: 'draft',
    liveMode: false,
    lineCount: 2,
    monthlyTotal: 450
  });
  const contactCall = calls.find(call => call.path === '/contacts/upsert');
  assert.equal(contactCall.options.body.dnd, true);
  assert.match(contactCall.options.body.email, /@example\.test$/);

  const invoiceCall = calls.find(call => call.path === '/invoices/schedule');
  assert.equal(invoiceCall.options.version, '2023-02-21');
  assert.equal(invoiceCall.options.body.liveMode, false);
  assert.equal(invoiceCall.options.body.schedule.rrule.intervalType, 'monthly');
  assert.equal(invoiceCall.options.body.schedule.rrule.interval, 1);
  assert.equal(invoiceCall.options.body.schedule.rrule.daysBefore, 0);
  assert.equal(invoiceCall.options.body.schedule.rrule.endType, 'never');
  assert.deepEqual(invoiceCall.options.body.items.map(item => ({
    productId: item.productId, priceId: item.priceId, amount: item.amount, qty: item.qty, type: item.type
  })), [
    { productId: 'product-a', priceId: 'price-a', amount: 130, qty: 1, type: 'recurring' },
    { productId: 'product-b', priceId: 'price-b', amount: 320, qty: 1, type: 'recurring' }
  ]);
  assert.equal(calls.some(call => /\/schedule\/[^/]+\/schedule$/.test(call.path)), false, 'draft is never scheduled or sent');
});

test('CRM recurring draft refuses live mode before any CRM request', async () => {
  const { request, calls } = requestStub();
  await assert.rejects(
    recurring.createRecurringDraft({
      config: { locationId: 'loc-test' }, request, liveMode: true,
      lines: [line('membresia-2x', 'sedan', 'Camry')]
    }),
    error => error.code === 'CRM_MEMBERSHIP_TEST_MODE_REQUIRED' && error.statusCode === 422
  );
  assert.equal(calls.length, 0);
});

test('missing or stale CRM membership price cannot be substituted with client input', async () => {
  const { request, calls } = requestStub();
  const original = request;
  const noPrice = async (...args) => {
    const response = await original(...args);
    return args[1].startsWith('/products/product-a/price') ? { prices: [] } : response;
  };
  await assert.rejects(
    recurring.createRecurringDraft({
      config: { locationId: 'loc-test' }, request: noPrice,
      lines: [line('membresia-2x', 'sedan', 'Camry')]
    }),
    error => error.code === 'CRM_MEMBERSHIP_CATALOG_UNAVAILABLE' && error.statusCode === 503
  );
  assert.equal(calls.some(call => call.path === '/invoices/schedule'), false);
});

test('upstream diagnostics keep only schema field names, never error values', () => {
  const hint = ghl.safeDiagnosticHint({
    message: 'contactDetails.email test@example.test is invalid for schedule. liveMode=false'
  });
  assert.equal(hint, 'contactdetails,livemode,schedule');
  assert.doesNotMatch(hint, /example|invalid|@/);
});

test('the protected test status strips CRM contact, product, price, and invoice identifiers', () => {
  const output = testEndpoint._test.summary({
    _id: 'schedule-secret',
    status: 'draft',
    liveMode: false,
    contactDetails: { email: 'customer@example.test' },
    invoices: [{ _id: 'invoice-secret', invoiceItems: [{ productId: 'product-secret', priceId: 'price-secret' }] }],
    schedule: {
      executeAt: '2026-07-30T00:00:00.000Z',
      rrule: {
        intervalType: 'monthly', interval: 1, startDate: '2026-07-30',
        startTime: '00:00:00', dayOfMonth: 1, daysBefore: 0,
        useStartAsPrimaryUserAccepted: true, endType: 'never'
      }
    }
  });
  assert.deepEqual(output, {
    status: 'draft', liveMode: false, invoiceCount: 1,
    schedule: {
      executeAt: '2026-07-30T00:00:00.000Z',
      rrule: {
        intervalType: 'monthly', interval: 1, startDate: '2026-07-30',
        startTime: '00:00:00', dayOfMonth: 1, daysBefore: 0,
        useStartAsPrimaryUserAccepted: true, endType: 'never'
      }
    }
  });
  assert.equal(JSON.stringify(output).includes('secret'), false);
  assert.equal(JSON.stringify(output).includes('example'), false);
});
