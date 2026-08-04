'use strict';

// Everything L&B sells, expressed as CRM products and prices.
//
// Until now only memberships existed in HighLevel. The washes, the details, the
// paint work, the add-ons and the deposits lived exclusively in the website
// catalog, which is why the office could not open the CRM, pick "Premium Detail —
// SUV" and send a payment link, and why no sales report could be broken down by
// product. This module closes that gap by projecting the authoritative server
// catalog into one uniform list the provisioner can walk.
//
// Four kinds of sellable thing, and they are NOT interchangeable:
//
//   service     one-time wash/detail/paint, priced per size        23 products / 61 prices
//   addon       an extra, priced once                              46 products / 46 prices
//   deposit     the $30 / $50 booking deposit                       2 products /  2 prices
//   membership  monthly recurring, delegated to membership-catalog  17 products / 33 prices
//
// Money still comes from pricing.js — the same function the quote endpoint uses —
// so a CRM price can never disagree with what the customer was quoted. Display
// names come from the public catalog, because a price the office reads in a
// dropdown has to say "Premium Detail · SUV", not "premium-detail/suv".

const catalog = require('./catalog.js');
const pricing = require('./pricing.js');
const membershipCatalog = require('./membership-catalog.js');
const publicCatalog = require('./catalog-public.json');

// Bumped when the SHAPE of the catalog changes (new kinds, renamed markers), not
// when a price moves. Markers embed it so a future revision can be recognised and
// migrated instead of duplicated.
const CRM_CATALOG_VERSION = 1;
const MARKER_PREFIX = 'lyb-catalog';

const KINDS = Object.freeze(['service', 'addon', 'deposit', 'membership']);

// ── Display names ──────────────────────────────────────────────────────────

const packageNames = new Map();
const sizeNames = new Map();
const addonNames = new Map();

for (const category of publicCatalog.categories) {
  for (const pkg of category.packages || []) {
    packageNames.set(pkg.id, pkg.name || pkg.id);
  }
  const sizes = Array.isArray(category.sizes) ? category.sizes : Object.values(category.sizes || {}).flat();
  for (const size of sizes) {
    if (size && size.id && !sizeNames.has(size.id)) sizeNames.set(size.id, size.name || size.id);
  }
  for (const extra of category.extras || []) {
    if (!addonNames.has(extra.id)) addonNames.set(extra.id, extra.name || extra.id);
  }
}

function packageName(packageId) {
  return packageNames.get(packageId) || packageId;
}

function sizeName(sizeId) {
  return sizeNames.get(sizeId) || sizeId;
}

function addonName(addonId) {
  return addonNames.get(addonId) || addonId;
}

// ── Markers ────────────────────────────────────────────────────────────────

// The product marker is what makes the provisioner safe: it only ever reuses or
// edits an object carrying one. The deposit products the location already has —
// four of them, created by HighLevel from the calendar payment settings and named
// "… (via calendars)", with EMPTY descriptions — carry no marker, so they are
// invisible to it. That is exactly the requirement: never reused, never modified.
//
// Memberships keep the marker they were first provisioned with, so a location that
// already ran the membership provisioner is recognised rather than duplicated.
function productMarker(kind, productKey) {
  if (kind === 'membership') return `lyb-membership-catalog:v${membershipCatalog.CATALOG_VERSION}:${productKey}`;
  return `${MARKER_PREFIX}:v${CRM_CATALOG_VERSION}:${kind}:${productKey}`;
}

function productDescription(kind, productKey, humanNote) {
  return `${productMarker(kind, productKey)}\n${humanNote}`;
}

// ── The catalog itself ─────────────────────────────────────────────────────

function toCents(dollars) {
  return Math.round(dollars * 100);
}

// One-time services: one product per package, one price per size it is sold in.
function serviceItems() {
  const items = [];
  for (const [packageId, sizes] of Object.entries(catalog.SIZES_BY_PACKAGE)) {
    if (membershipCatalog.isSellableMembership(packageId)) continue;
    // TODO(remove-graphite): retired ids are still accepted from long-lived tabs
    // but are not offered for sale, so they get no CRM product.
    if (membershipCatalog.RETIRED_MEMBERSHIP_IDS.includes(packageId)) continue;

    const label = packageName(packageId);
    const prices = [...sizes].map(sizeId => ({
      priceKey: `${packageId}:${sizeId}`,
      name: `${label} · ${sizeName(sizeId)}`,
      amountCents: toCents(pricing.packagePriceBounds(packageId, sizeId).min),
      type: 'one_time',
      packageId,
      sizeId
    }));
    items.push({
      kind: 'service',
      productKey: packageId,
      label,
      note: 'One-time service managed by the L&B website catalog.',
      prices
    });
  }
  return items;
}

// Add-ons: one product each, one price each.
//
// A custom-quote add-on (aluminium tank polishing) is deliberately skipped: it has
// no amount, and a $0 product in a payment link would let a customer add it for
// free. The office quotes those by hand, as it does today.
function addonItems() {
  const items = [];
  const seen = new Set();
  for (const addons of Object.values(catalog.ADDONS_BY_CATEGORY)) {
    for (const addonId of addons) {
      if (seen.has(addonId)) continue;
      seen.add(addonId);
      const bounds = pricing.addonPriceBounds(addonId);
      if (bounds.custom || !(bounds.min > 0)) continue;
      const label = addonName(addonId);
      items.push({
        kind: 'addon',
        productKey: addonId,
        label,
        note: 'Add-on managed by the L&B website catalog.',
        prices: [{
          priceKey: addonId,
          name: label,
          amountCents: toCents(bounds.min),
          type: 'one_time',
          addonId
        }]
      });
    }
  }
  return items;
}

// The booking deposit, as a real product instead of a free-text invoice line.
// That is what lets it appear in a payment link the office builds by hand, and in
// a sales report broken down by product.
function depositItems() {
  return [
    { key: 'deposit-small', amount: catalog.DEPOSIT_SMALL, label: 'Booking Deposit (Standard)' },
    { key: 'deposit-large', amount: catalog.DEPOSIT_LARGE, label: 'Booking Deposit (Large Vehicle)' }
  ].map(entry => ({
    kind: 'deposit',
    productKey: entry.key,
    label: entry.label,
    note: 'Booking deposit managed by the L&B website catalog. Credited to the final total.',
    prices: [{
      priceKey: entry.key,
      name: entry.label,
      amountCents: toCents(entry.amount),
      type: 'one_time',
      depositAmount: entry.amount
    }]
  }));
}

// Memberships, delegated so there is one definition of the 17 packages and their
// 33 monthly prices. Names and markers match what the membership provisioner
// already created, so re-running finds them instead of making a second set.
function membershipItems() {
  const byPackage = new Map();
  for (const entry of membershipCatalog.entries()) {
    if (!byPackage.has(entry.packageId)) {
      byPackage.set(entry.packageId, {
        kind: 'membership',
        productKey: entry.packageId,
        label: entry.productLabel,
        note: 'Managed by the L&B Elite Wash & Detail membership catalog. Do not use for one-time deposits.',
        prices: []
      });
    }
    byPackage.get(entry.packageId).prices.push({
      priceKey: `${entry.packageId}:${entry.sizeId}`,
      name: entry.priceLabel,
      amountCents: entry.monthlyCents,
      type: 'recurring',
      interval: entry.interval,
      packageId: entry.packageId,
      sizeId: entry.sizeId,
      creditsPerCycle: entry.creditsPerCycle
    });
  }
  return [...byPackage.values()];
}

// The whole sellable catalog, optionally narrowed to some kinds. Ordered so a
// dry-run reads the way the business thinks: services, then extras, then deposits,
// then memberships.
function items({ kinds = KINDS } = {}) {
  const wanted = new Set(kinds);
  return [
    ...(wanted.has('service') ? serviceItems() : []),
    ...(wanted.has('addon') ? addonItems() : []),
    ...(wanted.has('deposit') ? depositItems() : []),
    ...(wanted.has('membership') ? membershipItems() : [])
  ];
}

function summary(list = items()) {
  const counts = {};
  for (const item of list) {
    const bucket = counts[item.kind] || (counts[item.kind] = { products: 0, prices: 0, cents: 0 });
    bucket.products += 1;
    bucket.prices += item.prices.length;
    bucket.cents += item.prices.reduce((total, price) => total + price.amountCents, 0);
  }
  return {
    byKind: counts,
    products: list.length,
    prices: list.reduce((total, item) => total + item.prices.length, 0)
  };
}

module.exports = {
  CRM_CATALOG_VERSION,
  MARKER_PREFIX,
  KINDS,
  productMarker,
  productDescription,
  packageName,
  sizeName,
  addonName,
  serviceItems,
  addonItems,
  depositItems,
  membershipItems,
  items,
  summary
};
