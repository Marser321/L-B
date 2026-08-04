'use strict';

// The CRM catalog: what gets provisioned, and — more importantly — what does not.

const test = require('node:test');
const assert = require('node:assert/strict');

const crmCatalog = require('../api/_lib/crm-catalog.js');
const provisioning = require('../api/_lib/crm-catalog-provisioning.js');
const catalog = require('../api/_lib/catalog.js');
const pricing = require('../api/_lib/pricing.js');
const membershipCatalog = require('../api/_lib/membership-catalog.js');

const config = { locationId: 'loc-1' };

// The deposit products the sub-account actually holds, copied from what a dry run
// against the live location returned on 28 Jul 2026. They are NOT called "Booking
// Deposit": HighLevel created them from the calendar payment settings, hence the
// "(via calendars)" suffix, and they carry an EMPTY description — so there is no
// marker of ours anywhere near them.
//
// Using the real shapes matters: an empty description is the case most likely to
// break a marker check written carelessly.
const UNMARKED_DEPOSITS = [
  { _id: 'prod_cal_cars', name: 'Cars (via calendars)', description: '', productType: 'DIGITAL', locationId: 'loc-1' },
  { _id: 'prod_cal_trucks', name: 'Trucks (via calendars)', description: '', productType: 'DIGITAL', locationId: 'loc-1' },
  { _id: 'prod_cal_marine', name: 'Marine (via calendars)', description: '', productType: 'DIGITAL', locationId: 'loc-1' },
  { _id: 'prod_cal_mh', name: 'Mobile Homes (via calendars)', description: '', productType: 'DIGITAL', locationId: 'loc-1' }
];

// A fake CRM. `products` is what it already contains; every write is recorded.
function createCrm({ products = [], prices = {} } = {}) {
  const state = { products: [...products], prices: { ...prices }, writes: [], reads: [] };
  let nextId = 1;

  const request = async (cfg, path, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const [route] = path.split('?');
    if (method === 'GET') state.reads.push(route); else state.writes.push({ method, route, body: options.body });

    if (method === 'GET' && route === '/products/') {
      const offset = Number(new URLSearchParams(path.split('?')[1] || '').get('offset') || 0);
      return { products: state.products.slice(offset, offset + provisioning.PAGE_SIZE) };
    }
    if (method === 'POST' && route === '/products/') {
      const product = { _id: `prod_${nextId++}`, ...options.body };
      state.products.push(product);
      return { product };
    }
    const priceList = route.match(/^\/products\/([^/]+)\/price$/);
    if (priceList && method === 'GET') return { prices: state.prices[priceList[1]] || [] };
    if (priceList && method === 'POST') {
      const productId = priceList[1];
      const price = { _id: `price_${nextId++}`, ...options.body, priceType: options.body.type };
      state.prices[productId] = (state.prices[productId] || []).concat([price]);
      return { price };
    }
    const priceUpdate = route.match(/^\/products\/([^/]+)\/price\/([^/]+)$/);
    if (priceUpdate && method === 'PUT') return { price: { _id: priceUpdate[2], ...options.body } };

    throw new Error(`unexpected CRM call: ${method} ${route}`);
  };

  return { state, request };
}

// ── The catalog itself ─────────────────────────────────────────────────────

test('the catalog covers everything sellable, one product per thing', () => {
  const summary = crmCatalog.summary();
  assert.equal(summary.byKind.service.products, 23);
  assert.equal(summary.byKind.service.prices, 61);
  assert.equal(summary.byKind.deposit.products, 2);
  assert.equal(summary.byKind.membership.products, 17);
  assert.equal(summary.byKind.membership.prices, 33);
  // 47 add-ons exist; the custom-quote one is deliberately not sold as a product.
  assert.equal(summary.byKind.addon.products, 46);
  assert.equal(summary.products, 88);
  assert.equal(summary.prices, 142);
});

test('prices come from the same source the quote endpoint uses', () => {
  const drift = [];
  for (const item of crmCatalog.items({ kinds: ['service'] })) {
    for (const price of item.prices) {
      const expected = Math.round(pricing.packagePriceBounds(price.packageId, price.sizeId).min * 100);
      if (price.amountCents !== expected) drift.push(`${price.priceKey}: ${price.amountCents} ≠ ${expected}`);
    }
  }
  assert.deepEqual(drift, []);
});

test('a custom-quote add-on is never given a product', () => {
  // pulido-tanques has no amount. A $0 product in a payment link would let a
  // customer add aluminium tank polishing for free.
  const addonKeys = crmCatalog.items({ kinds: ['addon'] }).map(item => item.productKey);
  assert.equal(addonKeys.includes('pulido-tanques'), false);
  assert.equal(pricing.addonPriceBounds('pulido-tanques').custom, true);
  // Everything else that is offered does have one.
  const offered = new Set();
  for (const addons of Object.values(catalog.ADDONS_BY_CATEGORY)) for (const id of addons) offered.add(id);
  assert.equal(addonKeys.length, offered.size - 1);
});

test('retired package ids get no product, and memberships keep their original marker', () => {
  const serviceKeys = crmCatalog.items({ kinds: ['service'] }).map(item => item.productKey);
  for (const retired of membershipCatalog.RETIRED_MEMBERSHIP_IDS) {
    assert.equal(serviceKeys.includes(retired), false, retired);
  }
  // Identical to what the membership-only provisioner wrote, so an already
  // provisioned location is recognised instead of getting a second set of 17.
  assert.equal(
    crmCatalog.productMarker('membership', 'membresia-2x'),
    `lyb-membership-catalog:v${membershipCatalog.CATALOG_VERSION}:membresia-2x`
  );
  assert.equal(crmCatalog.productMarker('service', 'premium-detail'), 'lyb-catalog:v1:service:premium-detail');
});

test('prices are named for a human reading a dropdown', () => {
  const premium = crmCatalog.items({ kinds: ['service'] }).find(item => item.productKey === 'premium-detail');
  assert.equal(premium.label, 'Premium Detail');
  assert.ok(premium.prices.some(price => price.name === 'Premium Detail · SUV & Small Truck'));
  // No identifier leaks into what the office sees.
  assert.equal(premium.prices.some(price => /premium-detail|\bsuv\b/.test(price.name)), false);
});

// ── Provisioning ───────────────────────────────────────────────────────────

test('a dry run plans the whole catalog and writes nothing', async () => {
  const crm = createCrm();
  const summary = await provisioning.provision({ config, request: crm.request, apply: false });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.plan.filter(entry => entry.action === 'create-product').length, 88);
  assert.equal(summary.plan.filter(entry => entry.action === 'create-price').length, 142);
  assert.equal(crm.state.writes.length, 0, 'a dry run must not write');
});

test('applying creates the catalog, and re-running creates nothing', async () => {
  const crm = createCrm();
  const first = await provisioning.provision({ config, request: crm.request, apply: true });
  assert.equal(first.totals.productsCreated, 88);
  assert.equal(first.totals.pricesCreated, 142);

  const second = await provisioning.provision({ config, request: crm.request, apply: true });
  assert.equal(second.totals.productsCreated, 0);
  assert.equal(second.totals.productsReused, 88);
  assert.equal(second.totals.pricesCreated, 0);
  assert.equal(second.totals.pricesReused, 142);
});

test('the existing $30/$50 deposit products are never read, reused or edited', async () => {
  const crm = createCrm({ products: UNMARKED_DEPOSITS });
  const summary = await provisioning.provision({ config, request: crm.request, apply: true });

  // All four calendar-created products are still there, untouched.
  const legacy = crm.state.products.filter(product => String(product._id || '').startsWith('prod_cal_'));
  assert.equal(legacy.length, 4);
  assert.equal(legacy.every(product => product.name.includes('(via calendars)')), true);

  // Nothing was written against them.
  const touched = crm.state.writes.filter(write => write.route.includes('prod_cal_'));
  assert.deepEqual(touched, []);

  // And our own deposit products were created alongside, marked as ours.
  assert.equal(summary.byKind.deposit.productsCreated, 2);
  const ours = crm.state.products.filter(product =>
    String(product.description || '').includes('lyb-catalog:v1:deposit')
  );
  assert.equal(ours.length, 2);
});

test('a price whose amount drifted is corrected, and only ours can be', async () => {
  const crm = createCrm();
  await provisioning.provision({ config, request: crm.request, apply: true });

  // Someone edited an amount in the CRM dashboard.
  const productId = crm.state.products.find(product =>
    String(product.description || '').includes('lyb-catalog:v1:service:premium-detail')
  )._id;
  crm.state.prices[productId][0].amount = 1;

  crm.state.writes.length = 0;
  const summary = await provisioning.provision({ config, request: crm.request, apply: true });
  assert.equal(summary.totals.pricesUpdated, 1);
  const updates = crm.state.writes.filter(write => write.method === 'PUT');
  assert.equal(updates.length, 1);
  // Corrected back to the catalog amount, not to whatever was in the CRM.
  assert.equal(updates[0].body.amount, 185);
});

test('provisioning can be narrowed to one kind', async () => {
  const crm = createCrm();
  const summary = await provisioning.provision({ config, request: crm.request, apply: true, kinds: ['deposit'] });
  assert.equal(summary.totals.productsCreated, 2);
  assert.equal(crm.state.products.length, 2);

  await assert.rejects(
    provisioning.provision({ config, request: crm.request, kinds: ['nonsense'] }),
    /Unknown catalog kind/
  );
});

test('the mapping names a CRM product and price for every catalog identifier', async () => {
  const crm = createCrm();
  const summary = await provisioning.provision({ config, request: crm.request, apply: true });

  assert.equal(summary.mapping.length, 142);
  assert.equal(summary.mapping.every(row => row.crmProductId && row.crmPriceId), true);

  const premiumSuv = summary.mapping.find(row => row.priceKey === 'premium-detail:suv');
  assert.equal(premiumSuv.kind, 'service');
  assert.equal(premiumSuv.amountCents, 21500);
  assert.equal(premiumSuv.type, 'one_time');

  const membership = summary.mapping.find(row => row.priceKey === 'membresia-2x:sedan');
  assert.equal(membership.type, 'recurring');
  assert.equal(membership.amountCents, 15000);
});

test('amounts reach the CRM in dollars, never cents', async () => {
  const crm = createCrm();
  await provisioning.provision({ config, request: crm.request, apply: true, kinds: ['membership'] });
  const posted = crm.state.writes.filter(write => write.method === 'POST' && write.route.endsWith('/price'));
  const amounts = posted.map(write => write.body.amount);
  // $150, not 15000 — the difference between a membership and a house payment.
  assert.ok(amounts.includes(150));
  assert.equal(amounts.some(amount => amount > 1000), false);
  assert.equal(provisioning.majorUnits(13000), 130);
});

test('a CRM larger than the pager can read is refused rather than duplicated', async () => {
  // Every page comes back full, so the tool can never be sure it saw everything.
  const request = async (cfg, path) => {
    if (path.startsWith('/products/?')) {
      return { products: Array.from({ length: provisioning.PAGE_SIZE }, (unused, i) => ({ _id: `p${i}`, description: '' })) };
    }
    return { prices: [] };
  };
  await assert.rejects(
    provisioning.provision({ config, request, apply: true }),
    /more products than this tool can page through/
  );
});
