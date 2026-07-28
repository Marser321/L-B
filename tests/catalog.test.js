'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const catalogHandler = require('../api/catalog.js');
const { callHandler } = require('./support/harness.js');

test('public catalog exposes server-owned ids, prices, membership flags, and the four-vehicle cap', async () => {
  const res = await callHandler(catalogHandler, undefined, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.maxVehicles, 4);
  assert.match(res.body.version, /^[a-f0-9]{12}$/);

  const cars = res.body.categories.find(category => category.id === 'cars');
  const membership = cars.packages.find(pkg => pkg.id === 'membresia-2x');
  const premiumPackage = cars.packages.find(pkg => pkg.id === 'premium-detail');
  assert.equal(membership.isMembership, true);
  assert.equal(premiumPackage.isMembership, false);
  assert.equal(premiumPackage.displayPrices.sedan.en, '$125');
  assert.equal(premiumPackage.displayFrom.es, 'Desde $125');
});

test('public catalog remains read-only', async () => {
  const res = await callHandler(catalogHandler, {}, { method: 'POST' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.code, 'METHOD_NOT_ALLOWED');
});
