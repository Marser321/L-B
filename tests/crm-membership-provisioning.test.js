'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../api/_lib/membership-catalog.js');
const provisioner = require('../api/_lib/crm-membership-provisioning.js');

function fakeCrm() {
  const products = [{ _id: 'deposit-30', name: 'Cars deposit', description: 'legacy deposit' }];
  const prices = new Map();
  const calls = [];
  let id = 0;
  const request = async (_config, path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body || null });
    if (path.startsWith('/products/?')) return { products };
    if (path === '/products/' && options.method === 'POST') {
      const product = { _id: `product-${++id}`, ...options.body };
      products.push(product);
      prices.set(product._id, []);
      return product;
    }
    const match = path.match(/^\/products\/([^/]+)\/price(?:\?|$)/);
    if (match && !options.method) return { prices: prices.get(match[1]) || [] };
    if (match && options.method === 'POST') {
      const price = { _id: `price-${++id}`, ...options.body };
      const bucket = prices.get(match[1]) || [];
      bucket.push(price);
      prices.set(match[1], bucket);
      return price;
    }
    throw new Error(`Unexpected request ${options.method || 'GET'} ${path}`);
  };
  return { products, prices, calls, request };
}

test('CRM provisioner creates only the 17 marked membership products and 33 recurring prices', async () => {
  const crm = fakeCrm();
  const result = await provisioner.provision({ config: { locationId: 'test-location' }, request: crm.request, apply: true });

  assert.equal(result.productsCreated, 17);
  assert.equal(result.pricesCreated, 33);
  assert.equal(result.productsReused, 0);
  assert.equal(result.pricesReused, 0);
  assert.equal(crm.products.filter(product => product._id === 'deposit-30').length, 1);
  assert.equal(crm.calls.filter(call => call.method === 'POST' && call.path === '/products/').length, 17);
  const priceWrites = crm.calls.filter(call => call.method === 'POST' && /\/price$/.test(call.path));
  assert.equal(priceWrites.length, 33);
  assert.ok(priceWrites.every(call => call.body.priceType === 'recurring'));
  assert.ok(priceWrites.every(call => call.body.recurring.interval === 'month' && call.body.recurring.intervalCount === 1));
  assert.deepEqual(priceWrites.map(call => call.body.amount).sort((a, b) => a - b), catalog.entries().map(entry => entry.monthlyCents).sort((a, b) => a - b));
});

test('CRM provisioner is idempotent and detects an edited membership price', async () => {
  const crm = fakeCrm();
  await provisioner.provision({ config: { locationId: 'test-location' }, request: crm.request, apply: true });
  const callsBefore = crm.calls.length;
  const second = await provisioner.provision({ config: { locationId: 'test-location' }, request: crm.request, apply: true });
  assert.equal(second.productsCreated, 0);
  assert.equal(second.pricesCreated, 0);
  assert.equal(second.productsReused, 17);
  assert.equal(second.pricesReused, 33);
  assert.equal(crm.calls.slice(callsBefore).filter(call => call.method === 'POST').length, 0);

  const firstPrice = [...crm.prices.values()].find(bucket => bucket.length)[0];
  firstPrice.amount += 1;
  await assert.rejects(
    () => provisioner.provision({ config: { locationId: 'test-location' }, request: crm.request, apply: true }),
    error => error && error.code === 'CRM_MEMBERSHIP_PRICE_OUT_OF_SYNC'
  );
});
