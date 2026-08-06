'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const catalogHandler = require('../api/catalog.js');
const catalog = require('../api/_lib/catalog.js');
const { callHandler } = require('./support/harness.js');

test('public catalog exposes server-owned ids, display metadata, membership policy, and the four-vehicle cap', async () => {
  const res = await callHandler(catalogHandler, undefined, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.maxVehicles, 4);
  assert.equal(res.body.membershipNoticeHours, 48);
  assert.equal(res.body.locationTimeZone, 'America/New_York');
  assert.match(res.body.version, /^[a-f0-9]{12}$/);
  assert.ok(res.body.categories.every(category => category.packages.every(pkg => typeof pkg.isMembership === 'boolean')));

  const cars = res.body.categories.find(category => category.id === 'cars');
  const membership = cars.packages.find(pkg => pkg.id === 'membresia-2x');
  const premiumPackage = cars.packages.find(pkg => pkg.id === 'premium-detail');
  assert.equal(membership.isMembership, true);
  assert.equal(premiumPackage.isMembership, false);
  assert.equal(premiumPackage.displayPrices.sedan.en, '$185');
  assert.equal(premiumPackage.displayFrom.es, 'Desde $185');
});

test('public catalog remains read-only', async () => {
  const res = await callHandler(catalogHandler, {}, { method: 'POST' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.code, 'METHOD_NOT_ALLOWED');
});

// ── Scheduling invariants ──────────────────────────────────────────────────

test('every sellable package occupies real time on a van', () => {
  // A package that computes to zero minutes produces a booking whose start equals
  // its end. Postgres rejects that (`duration_minutes > 0`, `ends_at > starts_at`)
  // and the customer sees a 502 on an otherwise valid service — which is exactly
  // what paint-enhancement did while it was missing from FULL_DAY_PACKAGES and its
  // category duration was {service: 0, buffer: 0}.
  const broken = [];
  for (const packageId of Object.keys(catalog.SIZES_BY_PACKAGE)) {
    try {
      const minutes = catalog.vehicleServiceMinutes(packageId);
      if (!Number.isFinite(minutes) || minutes <= 0) broken.push(`${packageId} → ${minutes}`);
    } catch (error) {
      broken.push(`${packageId} → ${error.message}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('a catalog entry that would schedule zero minutes throws instead of booking', () => {
  // The guard itself. An UNKNOWN package is not the dangerous case — it falls back
  // to the cars duration and books fine. The dangerous case is a category whose own
  // duration sums to zero, which is how paint_correction shipped, so that is what
  // is asserted here.
  assert.throws(() => catalog.assertSchedulableMinutes(0, 'paint-enhancement'), /must occupy real time/);
  assert.throws(() => catalog.assertSchedulableMinutes(-30, 'whatever'), /must occupy real time/);
  assert.throws(() => catalog.assertSchedulableMinutes(NaN, 'whatever'), /must occupy real time/);
  assert.equal(catalog.assertSchedulableMinutes(90, 'premium-detail'), 90);
  // An unknown package still schedules, on the cars fallback (60 of service).
  assert.equal(catalog.vehicleServiceMinutes('not-a-real-package'), 60);
  // And a whole visit made of it is that service plus the cars buffer.
  assert.equal(catalog.visitDurationMinutes(['not-a-real-package']), 90);
});

test('all three paint tiers hold the van for the working day', () => {
  for (const packageId of ['paint-enhancement', 'paint-correction', 'ceramic-protection']) {
    assert.equal(catalog.bookingModeForPackage(packageId), 'full_day', packageId);
    assert.ok(catalog.vehicleServiceMinutes(packageId) > 0, packageId);
    // Paint work keeps the larger deposit and its own category, which is what
    // makes it safe to DISPLAY it inside cars without moving it there.
    assert.equal(catalog.depositForPackages([packageId]), 50, packageId);
    assert.equal(catalog.categoryForPackage(packageId), 'paint_correction', packageId);
  }
});

test('a full-day service caps the cart at one vehicle, so a paint cart never books', () => {
  // The regression this exists for: a cart of paint + anything passed every check
  // and then produced ZERO bookable start times on every date in the window, with
  // no explanation. The cap is what turns that silence into a sentence.
  assert.equal(catalog.maxVehiclesForPackages(['paint-correction']), 1);
  assert.equal(catalog.maxVehiclesForPackages(['paint-correction', 'basico-premium']), 1);
  assert.equal(catalog.maxVehiclesForPackages(['basico-premium', 'ceramic-protection']), 1);
  // The strictest cap wins, and full-day is stricter than marine.
  assert.equal(catalog.maxVehiclesForPackages(['boat-premium', 'paint-enhancement']), 1);
  // Everything else is unchanged.
  assert.equal(catalog.maxVehiclesForPackages(['basico-premium', 'vip']), 4);
  assert.equal(catalog.maxVehiclesForPackages(['boat-premium']), 2);
});

test('the public catalog tells the browser which packages take the whole day', async () => {
  const res = await callHandler(catalogHandler, undefined, { method: 'GET' });
  const paint = res.body.categories.find(category => category.id === 'paint_correction');
  const cars = res.body.categories.find(category => category.id === 'cars');
  assert.ok(paint.packages.every(pkg => pkg.fullDay === true));
  assert.ok(cars.packages.every(pkg => pkg.fullDay === false));
});
