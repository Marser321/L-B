'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const diagnosticsHandler = require('../api/internal/dependencies.js');
const { installEnv, callHandler } = require('./support/harness.js');

test('dependency diagnostics require an office token and never return secret values', async () => {
  installEnv({ OFFICE_API_TOKEN: 'diagnostic-token', GHL_DEPOSIT_PAYMENTS: 'on' });

  const rejected = await callHandler(diagnosticsHandler, undefined, { method: 'GET' });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.body.code, 'DIAGNOSTICS_UNAUTHORIZED');

  const accepted = await callHandler(diagnosticsHandler, undefined, {
    method: 'GET', headers: { authorization: 'Bearer diagnostic-token' }
  });
  assert.equal(accepted.statusCode, 200);
  // There is no `database` key any more: the agenda, the holds and the credits live in
  // HighLevel. Its absence is the assertion.
  assert.equal(accepted.body.dependencies.database, undefined);
  assert.equal(accepted.body.dependencies.highLevel.crewCalendars.configured, 4);
  // No payment-provider key of our own since Stripe was removed; what the runbook
  // reports is whether deposit collection is on and in which mode.
  assert.equal(accepted.body.dependencies.payments.depositsEnabled, true);
  assert.equal(accepted.body.dependencies.payments.liveMode, false);
  const serialized = JSON.stringify(accepted.body);
  assert.equal(serialized.includes('diagnostic-token'), false);
  assert.equal(serialized.includes('sk_test_harness'), false);
  assert.equal(serialized.includes('whsec_harness'), false);
});
