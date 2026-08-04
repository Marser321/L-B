'use strict';

// The server prices bookings from its own catalog. These tests guard the two ways
// that can silently go wrong: the generated catalog drifting away from the prices
// the owner edits in script.js, and the catalog not covering something the
// validation tables happily accept.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const pricing = require('../api/_lib/pricing.js');
const catalog = require('../api/_lib/catalog.js');

const siteDir = join(__dirname, '..');

test('the generated price catalog is in sync with script.js', () => {
  // `--check` re-extracts SERVICES_DATA and compares; a price edited in script.js
  // without re-running the extractor fails here rather than in production.
  execFileSync(process.execPath, [join(siteDir, 'scripts', 'extract-catalog.mjs'), '--check'], {
    cwd: siteDir, stdio: 'pipe'
  });
});

test('every package and size the API accepts has a server-side price', () => {
  const missing = [];
  for (const [packageId, sizes] of Object.entries(catalog.SIZES_BY_PACKAGE)) {
    for (const sizeId of sizes) {
      try {
        const bounds = pricing.packagePriceBounds(packageId, sizeId);
        if (!(bounds.min > 0)) missing.push(`${packageId}/${sizeId} priced at 0`);
      } catch (error) {
        missing.push(`${packageId}/${sizeId} has no price`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('every add-on the API accepts has a server-side price', () => {
  const missing = [];
  for (const [categoryId, addons] of Object.entries(catalog.ADDONS_BY_CATEGORY)) {
    for (const addonId of addons) {
      if (!pricing.ADDON_PRICES.has(addonId)) missing.push(`${categoryId}/${addonId}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('known totals are priced exactly', () => {
  // premium-detail/sedan is $185; limpieza-motor is "Desde $30", so the total is a
  // "from" price rather than a flat one.
  const car = pricing.estimateForVehicle({ packageId: 'premium-detail', sizeId: 'sedan', addonIds: ['limpieza-motor'] });
  assert.equal(car.min, 215);
  assert.equal(car.label, 'From $215');

  const plain = pricing.estimateForVehicle({ packageId: 'premium-detail', sizeId: 'sedan', addonIds: [] });
  assert.equal(plain.label, '$185');

  // Spanish labels use the same numbers.
  assert.equal(
    pricing.estimateForVehicle({ packageId: 'premium-detail', sizeId: 'sedan', addonIds: ['limpieza-motor'] }, 'es').label,
    'Desde $215'
  );
});

test('money adds up across a cart even though duration does not', () => {
  const total = pricing.estimateForVehicles([
    { packageId: 'premium-detail', sizeId: 'sedan', addonIds: [] },
    { packageId: 'car-hauler-wash', sizeId: 'standard', addonIds: [] }
  ]);
  assert.equal(total.min, 185 + 120);
  assert.equal(total.perVehicle.length, 2);
  // Two vans, in parallel: 90 and 120 minutes, so the visit is 120 — not 210.
  assert.equal(catalog.vehicleDurationMinutes('premium-detail'), 90);
  assert.equal(catalog.vehicleDurationMinutes('car-hauler-wash'), 120);
});

test('a custom-quote add-on labels the estimate instead of inventing a number', () => {
  const withCustom = pricing.estimateForVehicle({
    packageId: 'semi-truck-wash', sizeId: 'standard', addonIds: ['pulido-tanques']
  });
  assert.equal(withCustom.custom, true);
  assert.match(withCustom.label, /Custom Quote/);
  // The custom add-on adds nothing to the number itself.
  assert.equal(withCustom.min, pricing.packagePriceBounds('semi-truck-wash', 'standard').min);
});

test('price text is parsed the same way the frontend parses it', () => {
  assert.deepEqual(pricing.parsePriceText('$30 - $60'), { min: 30, max: 60, from: false, custom: false });
  assert.deepEqual(pricing.parsePriceText('Desde $50'), { min: 50, max: 50, from: true, custom: false });
  assert.deepEqual(pricing.parsePriceText('From $1,200'), { min: 1200, max: 1200, from: true, custom: false });
  assert.equal(pricing.parsePriceText('Cotización personalizada').custom, true);
});

test('per-category durations and deposits match the crew rules', () => {
  assert.equal(catalog.vehicleDurationMinutes('premium-detail'), 90);
  assert.equal(catalog.vehicleDurationMinutes('semi-truck-wash'), 120);
  assert.equal(catalog.vehicleDurationMinutes('boat-detail'), 180);
  assert.equal(catalog.vehicleDurationMinutes('golf-premium'), 60);
  assert.equal(catalog.vehicleDurationMinutes('mobile-home-basico'), 120);
  assert.equal(catalog.vehicleDurationMinutes('driveway-basico'), 150);

  assert.equal(catalog.depositForPackages(['premium-detail']), 30);
  assert.equal(catalog.depositForPackages(['semi-truck-wash']), 50);
  // One deposit per booking: the largest any vehicle requires.
  assert.equal(catalog.depositForPackages(['premium-detail', 'semi-truck-wash']), 50);

  assert.equal(catalog.isMembershipPackage('membresia-2x'), true);
  assert.equal(catalog.isMembershipPackage('box-truck-4x'), true);
  assert.equal(catalog.isMembershipPackage('premium-detail'), false);
  assert.equal(catalog.MAX_VEHICLES, 4);
});
