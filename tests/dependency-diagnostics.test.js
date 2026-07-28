'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const diagnosticsHandler = require('../api/internal/dependencies.js');
const { installEnv, callHandler } = require('./support/harness.js');

test('dependency diagnostics require an office token and never return secret values', async () => {
  installEnv({ OFFICE_API_TOKEN: 'diagnostic-token', STRIPE_SECRET_KEY: 'sk_test_harness', STRIPE_WEBHOOK_SECRET: 'whsec_harness' });

  const rejected = await callHandler(diagnosticsHandler, undefined, { method: 'GET' });
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.body.code, 'DIAGNOSTICS_UNAUTHORIZED');

  const accepted = await callHandler(diagnosticsHandler, undefined, {
    method: 'GET', headers: { authorization: 'Bearer diagnostic-token' }
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.dependencies.database.configured, false);
  assert.equal(accepted.body.dependencies.highLevel.crewCalendars.configured, 4);
  assert.equal(accepted.body.dependencies.stripe.mode, 'test');
  const serialized = JSON.stringify(accepted.body);
  assert.equal(serialized.includes('diagnostic-token'), false);
  assert.equal(serialized.includes('sk_test_harness'), false);
  assert.equal(serialized.includes('whsec_harness'), false);
});
