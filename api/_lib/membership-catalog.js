'use strict';

// The single source of truth for what a membership costs per month.
//
// Seventeen membership packages, thirty-three monthly prices. Amounts live here
// in CENTS and nowhere else the browser can reach: a checkout request names a
// package and a size, and the server decides what that costs. There is no code
// path that lets a request carry an amount, a price id, or a discount.
//
// Stripe was removed on 2026-08-04 — everything is kept in HighLevel so there is one
// place a sale is recorded (DISENO-SIN-BASE-DE-DATOS.md). What survives here is the
// PRICE LIST and the credits each plan includes, which the HighLevel recurring-invoice
// implementation needs exactly as much as Stripe did. tests/pricing.test.js pins these
// against the public catalog so the page and the charge can never quietly disagree.

const { RequestError } = require('./errors.js');
const catalog = require('./catalog.js');

// Bumped when the price list changes, so a provisioned recurring price can be traced
// to the amounts that produced it.
//
// It is baked into the CRM membership marker (`lyb-membership-catalog:v1:…` in
// crm-catalog.js), so bumping it makes the provisioner DUPLICATE the membership
// products HighLevel already has instead of updating them. The August 2026 car price
// update deliberately did not bump it for that reason.
const CATALOG_VERSION = 1;

const BILLING_INTERVAL = 'month';
const CURRENCY = 'usd';

// Washes included per billing cycle. Read from the package id, never from a
// request field: "-2x" is two visits a month, "-4x" is four.
const CREDITS_2X = 2;
const CREDITS_4X = 4;

function dollars(amount) {
  return Math.round(amount * 100);
}

// packageId → { label, sizes: { sizeId: monthlyDollars } }
// The labels appear on the CRM product and on the customer's invoice, so they are
// written for a human reading a bank statement.
const MEMBERSHIP_PACKAGES = Object.freeze({
  'membresia-2x': {
    label: 'Membresía 2x — Cars & SUVs',
    sizes: { sedan: 150, suv: 200, truck: 210, van_pequena: 180, van_xl: 260 }
  },
  'membresia-4x': {
    label: 'Membresía 4x — Cars & SUVs',
    sizes: { sedan: 290, suv: 390, truck: 400, van_pequena: 320, van_xl: 480 }
  },
  'box-truck-2x': {
    label: 'Membresía 2x — Box Truck',
    sizes: { size_10_16: 140, size_17_20: 170, size_21_26: 250 }
  },
  'box-truck-4x': {
    label: 'Membresía 4x — Box Truck',
    sizes: { size_10_16: 240, size_17_20: 300, size_21_26: 440 }
  },
  'semi-truck-2x': { label: 'Membresía 2x — Semi Truck', sizes: { standard: 270 } },
  'semi-truck-4x': { label: 'Membresía 4x — Semi Truck', sizes: { standard: 500 } },
  'trailer-2x': { label: 'Membresía 2x — Trailer', sizes: { standard: 370 } },
  'trailer-4x': { label: 'Membresía 4x — Trailer', sizes: { standard: 700 } },
  'car-hauler-2x': { label: 'Membresía 2x — Car Hauler', sizes: { standard: 220 } },
  'car-hauler-4x': { label: 'Membresía 4x — Car Hauler', sizes: { standard: 400 } },
  'dump-truck-2x': { label: 'Membresía 2x — Dump Truck', sizes: { standard: 320 } },
  'dump-truck-4x': { label: 'Membresía 4x — Dump Truck', sizes: { standard: 620 } },
  'garbage-truck-2x': { label: 'Membresía 2x — Garbage Truck', sizes: { standard: 370 } },
  'garbage-truck-4x': { label: 'Membresía 4x — Garbage Truck', sizes: { standard: 700 } },
  'jetski-membresia': {
    label: 'Membresía — Jet Ski',
    sizes: { qty_1: 130, qty_2: 220, qty_3: 300 }
  },
  'golf-membresia': { label: 'Membresía — Golf Cart', sizes: { standard: 130 } },
  'atv-membresia': {
    label: 'Membresía — ATV',
    sizes: { qty_1: 170, qty_2: 280, qty_3: 400 }
  }
});

// Human-readable size names for the price nickname, so the CRM dashboard reads
// "Membresía 2x — Cars & SUVs · SUV" instead of "membresia-2x/suv".
const SIZE_LABELS = Object.freeze({
  sedan: 'Sedan', suv: 'SUV', truck: 'Truck', van_pequena: 'Small Van', van_xl: 'XL Van',
  size_10_16: '10–16 ft', size_17_20: '17–20 ft', size_21_26: '21–26 ft',
  standard: 'Standard',
  qty_1: '1 unit', qty_2: '2 units', qty_3: '3 units'
});

// TODO(remove-graphite): the retired car-hauler-graphite-2x/4x ids still match the
// membership NAME pattern in catalog.js, but they were never sold as memberships
// and have no monthly price. Listing them here explicitly keeps
// `isSellableMembership` honest instead of relying on a regex that says yes.
const RETIRED_MEMBERSHIP_IDS = Object.freeze(['car-hauler-graphite-2x', 'car-hauler-graphite-4x']);

function creditsForPackage(packageId) {
  if (/4x/.test(packageId)) return CREDITS_4X;
  if (/2x/.test(packageId)) return CREDITS_2X;
  // jetski / golf / atv memberships are a single recurring visit per cycle.
  return 1;
}

function isSellableMembership(packageId) {
  return Object.hasOwn(MEMBERSHIP_PACKAGES, packageId);
}

// Every (packageId, sizeId) pair with its monthly price in cents. This is the list
// the provisioner walks: 17 products, 33 prices.
function entries() {
  return Object.entries(MEMBERSHIP_PACKAGES).flatMap(([packageId, pkg]) =>
    Object.entries(pkg.sizes).map(([sizeId, monthly]) => ({
      packageId,
      sizeId,
      productLabel: pkg.label,
      priceLabel: `${pkg.label} · ${SIZE_LABELS[sizeId] || sizeId}`,
      monthlyCents: dollars(monthly),
      currency: CURRENCY,
      interval: BILLING_INTERVAL,
      creditsPerCycle: creditsForPackage(packageId),
      // Stable, human-greppable key used as the price lookup key and as the metadata
      // marker that tells our products apart from the deposit products.
      lookupKey: `lyb_membership_v${CATALOG_VERSION}_${packageId}_${sizeId}`.replace(/-/g, '_')
    }))
  );
}

function products() {
  return Object.entries(MEMBERSHIP_PACKAGES).map(([packageId, pkg]) => ({
    packageId,
    label: pkg.label,
    lookupKey: `lyb_membership_v${CATALOG_VERSION}_${packageId}`.replace(/-/g, '_')
  }));
}

// The authoritative price for one line of a checkout. Throws rather than
// defaulting: an unknown pair means the request is wrong, and guessing an amount
// is the one thing this module exists to prevent.
function priceFor(packageId, sizeId) {
  const pkg = MEMBERSHIP_PACKAGES[packageId];
  if (!pkg) throw new RequestError(`${packageId} is not a membership`, 422);
  const monthly = pkg.sizes[sizeId];
  if (monthly == null) throw new RequestError(`${packageId} is not sold in size ${sizeId}`, 422);
  return {
    packageId,
    sizeId,
    monthlyCents: dollars(monthly),
    currency: CURRENCY,
    interval: BILLING_INTERVAL,
    creditsPerCycle: creditsForPackage(packageId),
    label: `${pkg.label} · ${SIZE_LABELS[sizeId] || sizeId}`
  };
}

// Guard for the provisioner and for anything that touches membership products: ours
// always carry this metadata, and nothing else may be edited. This is what keeps the
// existing $30/$50 deposit products out of reach.
const METADATA_NAMESPACE = 'lyb_membership';

function metadataFor(entry) {
  return {
    lyb_object: METADATA_NAMESPACE,
    lyb_catalog_version: String(CATALOG_VERSION),
    lyb_package_id: entry.packageId,
    ...(entry.sizeId ? { lyb_size_id: entry.sizeId } : {})
  };
}

function isOurs(candidate) {
  const metadata = (candidate && candidate.metadata) || {};
  return metadata.lyb_object === METADATA_NAMESPACE;
}

module.exports = {
  CATALOG_VERSION,
  CURRENCY,
  BILLING_INTERVAL,
  CREDITS_2X,
  CREDITS_4X,
  MEMBERSHIP_PACKAGES,
  SIZE_LABELS,
  RETIRED_MEMBERSHIP_IDS,
  METADATA_NAMESPACE,
  creditsForPackage,
  isSellableMembership,
  entries,
  products,
  priceFor,
  metadataFor,
  isOurs,
  // Re-exported so callers do not have to reach into two catalogs to check a size.
  sizesForPackage: packageId => catalog.SIZES_BY_PACKAGE[packageId]
};
