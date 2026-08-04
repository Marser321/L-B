'use strict';

// What the Stripe provisioner would do, without a Stripe account.

const test = require('node:test');
const assert = require('node:assert/strict');

const provisioning = require('../api/_lib/stripe-provisioning.js');
const membershipCatalog = require('../api/_lib/membership-catalog.js');
const pricing = require('../api/_lib/pricing.js');

// The deposit products this sub-account already has, exactly as they appear in
// Stripe today: no membership metadata, no lookup key of ours.
const DEPOSIT_OBJECTS = {
  products: [
    { id: 'prod_deposit_small', name: 'Booking Deposit', metadata: {} },
    { id: 'prod_deposit_large', name: 'Booking Deposit (Large)', metadata: { note: 'legacy' } }
  ],
  prices: [
    { id: 'price_dep_30', product: 'prod_deposit_small', unit_amount: 3000, lookup_key: null, metadata: {} },
    { id: 'price_dep_50', product: 'prod_deposit_large', unit_amount: 5000, lookup_key: null, metadata: {} }
  ]
};

function provisioned() {
  const products = membershipCatalog.products().map((entry, index) => ({
    id: `prod_m_${index}`,
    name: entry.label,
    metadata: membershipCatalog.metadataFor({ packageId: entry.packageId })
  }));
  const prices = membershipCatalog.entries().map((entry, index) => ({
    id: `price_m_${index}`,
    product: `prod_m_${index}`,
    unit_amount: entry.monthlyCents,
    lookup_key: entry.lookupKey,
    metadata: membershipCatalog.metadataFor(entry)
  }));
  return { products, prices };
}

test('an empty account plans 17 products and 33 prices', () => {
  const { productPlan, pricePlan, summary } = provisioning.plan({ products: [], prices: [] });
  assert.equal(summary.products.total, 17);
  assert.equal(summary.products.create, 17);
  assert.equal(summary.prices.total, 33);
  assert.equal(summary.prices.create, 33);
  assert.equal(productPlan.every(item => item.action === 'create'), true);
  assert.equal(pricePlan.every(item => item.action === 'create'), true);
  // $10,520 a month if one of each were sold — the sum of the published list.
  assert.equal(summary.totalMonthlyCents, 1052000);
});

test('the existing $30/$50 deposit products are never read, reused or edited', () => {
  const { productPlan, pricePlan, summary } = provisioning.plan(DEPOSIT_OBJECTS);

  // The deposit objects are invisible to the planner: everything is still "create".
  assert.equal(summary.products.create, 17);
  assert.equal(summary.prices.create, 33);

  const touched = [...productPlan, ...pricePlan].filter(item =>
    item.stripeProductId === 'prod_deposit_small' || item.stripeProductId === 'prod_deposit_large' ||
    item.stripePriceId === 'price_dep_30' || item.stripePriceId === 'price_dep_50'
  );
  assert.deepEqual(touched, [], 'no plan item points at a deposit object');

  // And no membership price is priced at a deposit amount by coincidence of naming.
  const lookupKeys = pricePlan.map(item => item.lookupKey);
  assert.equal(new Set(lookupKeys).size, 33, 'every lookup key is distinct');
  assert.equal(lookupKeys.every(key => key.startsWith('lyb_membership_v')), true);
});

test('re-running against a provisioned account creates nothing', () => {
  const { summary } = provisioning.plan(provisioned());
  assert.equal(summary.products.create, 0);
  assert.equal(summary.prices.create, 0);
  assert.equal(summary.products.reuse, 17);
  assert.equal(summary.prices.reuse, 33);
});

test('an unmarked object wearing our identifiers stops the run', () => {
  // Someone created a product by hand and typed one of our package ids into its
  // metadata. Adopting it silently could point a live subscription at the wrong
  // product, so this must fail loudly.
  assert.throws(() => provisioning.plan({
    products: [{ id: 'prod_impostor', name: 'Handmade', metadata: { lyb_package_id: 'membresia-2x' } }],
    prices: []
  }), provisioning.ProvisioningError);

  assert.throws(() => provisioning.plan({
    products: [],
    prices: [{
      id: 'price_impostor', unit_amount: 13000, metadata: {},
      lookup_key: membershipCatalog.entries()[0].lookupKey
    }]
  }), /not marked as a membership object/);
});

test('a price whose amount drifted from the catalog stops the run', () => {
  const account = provisioned();
  // Someone edited the amount in the dashboard — or the catalog changed without a
  // version bump. Stripe prices are immutable, so continuing would leave old and
  // new subscribers on different amounts with no record of why.
  account.prices[0] = { ...account.prices[0], unit_amount: 9999 };
  assert.throws(() => provisioning.plan(account), /bump CATALOG_VERSION/);
});

test('every provisioned price matches the public catalog the customer is shown', () => {
  // The membership module and the marketing site must quote the same number.
  const drift = membershipCatalog.entries().filter(entry => {
    const shown = pricing.packagePriceBounds(entry.packageId, entry.sizeId);
    return shown.min * 100 !== entry.monthlyCents;
  });
  assert.deepEqual(drift, [], 'membership prices must match catalog-prices.json');
});

test('metadata marks every object as ours, and isOurs rejects anything else', () => {
  const entry = membershipCatalog.entries()[0];
  const metadata = membershipCatalog.metadataFor(entry);
  assert.equal(metadata.lyb_object, 'lyb_membership');
  assert.equal(metadata.lyb_package_id, entry.packageId);
  assert.equal(metadata.lyb_catalog_version, String(membershipCatalog.CATALOG_VERSION));

  assert.equal(membershipCatalog.isOurs({ metadata }), true);
  assert.equal(membershipCatalog.isOurs({ metadata: {} }), false);
  assert.equal(membershipCatalog.isOurs(DEPOSIT_OBJECTS.products[0]), false);
  assert.equal(membershipCatalog.isOurs(null), false);
});

test('the retired graphite ids are not sellable as memberships', () => {
  // They match the membership NAME pattern used elsewhere, but were never sold as
  // memberships and have no monthly price.
  for (const packageId of membershipCatalog.RETIRED_MEMBERSHIP_IDS) {
    assert.equal(membershipCatalog.isSellableMembership(packageId), false);
    assert.throws(() => membershipCatalog.priceFor(packageId, 'standard'), /not a membership/);
  }
  assert.equal(membershipCatalog.entries().some(entry => entry.packageId.includes('graphite')), false);
});
