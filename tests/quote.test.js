'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quoteHandler = require('../api/quote.js');
const { OPPORTUNITY_FIELDS, validatePayload, resetMetadataCache } = quoteHandler._test;

function payload(overrides = {}) {
  return {
    submissionId: '123e4567-e89b-12d3-a456-426614174000',
    language: 'en',
    website: '',
    policyAccepted: true,
    policyAcceptedAt: '2026-07-14T15:00:00.000Z',
    customer: {
      name: 'Jane Driver', phone: '(239) 555-0100', email: 'jane@example.com',
      address: '1234 Palm Ave', unit: 'Apt 2B', city: 'Fort Myers', zip: '33901'
    },
    vehicle: { make: 'Toyota', model: 'Camry', year: 2024, color: 'Blue', plate: 'ABC 123' },
    selection: {
      category: { id: 'cars', name: 'Cars & SUVs' },
      package: { id: 'premium-detail', name: 'Premium Detail' },
      size: { id: 'sedan', name: 'Sedan / Coupe' },
      addons: [{ id: 'limpieza-motor', name: 'Engine Bay', price: 'From $30' }]
    },
    estimate: { min: 155, max: 155, label: '$155', custom: false, isRange: false },
    schedule: { date: '2026-12-01', timeWindow: 'morning', timeLabel: 'Morning (8am-12pm)', notes: 'Gate 4' },
    ...overrides
  };
}

function request(body, headers = {}) {
  return {
    method: 'POST',
    body,
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json', ...headers }
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value || ''; }
  };
}

async function invoke(body, headers) {
  const res = response();
  await quoteHandler(request(body, headers), res);
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

test('validates and normalizes a complete quote', () => {
  const result = validatePayload(payload());
  assert.equal(result.customer.phone, '+12395550100');
  assert.equal(result.customer.email, 'jane@example.com');
  assert.equal(result.vehicle.year, 2024);
  assert.equal(result.selection.addons.length, 1);
});

test('rejects incomplete identity, vehicle, policy, and selection data', () => {
  assert.throws(() => validatePayload(payload({ policyAccepted: false })), /policies/i);
  assert.throws(() => validatePayload(payload({ customer: { ...payload().customer, phone: '123' } })), /phone/i);
  assert.throws(() => validatePayload(payload({ vehicle: { ...payload().vehicle, year: 1800 } })), /year/i);
  assert.throws(() => validatePayload(payload({ selection: { ...payload().selection, category: { id: 'invalid', name: 'Invalid' } } })), /category/i);
  assert.throws(() => validatePayload(payload({ selection: { ...payload().selection, size: { id: 'van_xl', name: 'XL Van' } } })), /size/i);
  assert.throws(() => validatePayload(payload({ selection: { ...payload().selection, addons: [{ id: 'forged-extra', name: 'Forged', price: '$1' }] } })), /addons/i);
});

test('honeypot requests do not require CRM configuration', async () => {
  const previous = { token: process.env.GHL_PRIVATE_TOKEN, location: process.env.GHL_LOCATION_ID };
  delete process.env.GHL_PRIVATE_TOKEN;
  delete process.env.GHL_LOCATION_ID;
  const result = await invoke(payload({ website: 'https://spam.example' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  if (previous.token) process.env.GHL_PRIVATE_TOKEN = previous.token;
  if (previous.location) process.env.GHL_LOCATION_ID = previous.location;
});

test('returns a safe configuration error when CRM secrets are absent', async () => {
  const previous = { token: process.env.GHL_PRIVATE_TOKEN, location: process.env.GHL_LOCATION_ID };
  delete process.env.GHL_PRIVATE_TOKEN;
  delete process.env.GHL_LOCATION_ID;
  const result = await invoke(payload());
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, error: 'CRM is not configured' });
  if (previous.token) process.env.GHL_PRIVATE_TOKEN = previous.token;
  if (previous.location) process.env.GHL_LOCATION_ID = previous.location;
});

test('upserts one contact, creates one opportunity per submission, and makes retries idempotent', async () => {
  const oldFetch = global.fetch;
  const oldEnv = {
    token: process.env.GHL_PRIVATE_TOKEN,
    location: process.env.GHL_LOCATION_ID,
    pipeline: process.env.GHL_PIPELINE_ID,
    stage: process.env.GHL_PIPELINE_STAGE_ID
  };
  process.env.GHL_PRIVATE_TOKEN = 'test-token';
  process.env.GHL_LOCATION_ID = 'location-1';
  process.env.GHL_PIPELINE_ID = 'pipeline-1';
  process.env.GHL_PIPELINE_STAGE_ID = 'stage-1';
  resetMetadataCache();

  const requests = [];
  const opportunities = [];
  let staleSearches = 0;
  const fields = Object.values(OPPORTUNITY_FIELDS).map((name, index) => ({
    id: `field-${index}`, name, model: 'opportunity', dataType: 'TEXT'
  }));
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes('/customFields')) return new Response(JSON.stringify({ customFields: fields }), { status: 200 });
    if (url.endsWith('/contacts/upsert')) return new Response(JSON.stringify({ contact: { id: 'contact-1' } }), { status: 200 });
    if (url.includes('/opportunities/search?')) {
      if (staleSearches > 0) {
        staleSearches -= 1;
        return new Response(JSON.stringify({ opportunities: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ opportunities }), { status: 200 });
    }
    if (url.endsWith('/opportunities/')) {
      const submissionField = requests.at(-1).body.customFields.find(field => field.id === `field-${Object.keys(OPPORTUNITY_FIELDS).indexOf('submissionId')}`);
      const duplicate = opportunities.some(opportunity => opportunity.customFields.some(field =>
        field.id === submissionField.id && field.fieldValueString === submissionField.fieldValue
      ));
      if (duplicate) return new Response('{}', { status: 400 });
      const opportunity = {
        id: `opp-${requests.length}`,
        customFields: requests.at(-1).body.customFields.map(field => ({
          id: field.id,
          type: 'string',
          fieldValueString: field.fieldValue
        }))
      };
      opportunities.push(opportunity);
      staleSearches = 1;
      return new Response(JSON.stringify({ opportunity }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  };

  const first = await invoke(payload());
  const retry = await invoke(payload());
  const second = await invoke(payload({ submissionId: '223e4567-e89b-12d3-a456-426614174001' }));
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(second.status, 200);
  assert.equal(requests.filter(item => item.url.endsWith('/contacts/upsert')).length, 3);
  assert.equal(requests.filter(item => item.url.endsWith('/opportunities/')).length, 3);
  assert.equal(opportunities.length, 2);
  const opportunity = requests.find(item => item.url.endsWith('/opportunities/')).body;
  assert.equal(opportunity.contactId, 'contact-1');
  assert.equal(opportunity.monetaryValue, 155);
  assert.equal(opportunity.customFields.length, Object.keys(OPPORTUNITY_FIELDS).length);

  global.fetch = oldFetch;
  if (oldEnv.token == null) delete process.env.GHL_PRIVATE_TOKEN; else process.env.GHL_PRIVATE_TOKEN = oldEnv.token;
  if (oldEnv.location == null) delete process.env.GHL_LOCATION_ID; else process.env.GHL_LOCATION_ID = oldEnv.location;
  if (oldEnv.pipeline == null) delete process.env.GHL_PIPELINE_ID; else process.env.GHL_PIPELINE_ID = oldEnv.pipeline;
  if (oldEnv.stage == null) delete process.env.GHL_PIPELINE_STAGE_ID; else process.env.GHL_PIPELINE_STAGE_ID = oldEnv.stage;
  resetMetadataCache();
});

test('rejects cross-origin submissions', async () => {
  const result = await invoke(payload(), { origin: 'https://evil.example' });
  assert.equal(result.status, 403);
  assert.equal(result.body.ok, false);
});

test('rejects submissions without an origin', async () => {
  const result = await invoke(payload(), { origin: undefined });
  assert.equal(result.status, 403);
  assert.equal(result.body.ok, false);
});

test('maps HighLevel authorization, rate-limit, server, and timeout failures safely', async () => {
  const oldFetch = global.fetch;
  const oldEnv = { token: process.env.GHL_PRIVATE_TOKEN, location: process.env.GHL_LOCATION_ID };
  process.env.GHL_PRIVATE_TOKEN = 'test-token';
  process.env.GHL_LOCATION_ID = 'location-1';

  for (const [upstreamStatus, expectedStatus] of [[401, 503], [403, 503], [429, 503], [500, 502]]) {
    resetMetadataCache();
    global.fetch = async () => new Response('{}', { status: upstreamStatus });
    const result = await invoke(payload());
    assert.equal(result.status, expectedStatus);
    assert.deepEqual(result.body, { ok: false, error: 'CRM temporarily unavailable' });
  }

  resetMetadataCache();
  global.fetch = async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); };
  const timeout = await invoke(payload());
  assert.equal(timeout.status, 504);
  assert.deepEqual(timeout.body, { ok: false, error: 'CRM temporarily unavailable' });

  global.fetch = oldFetch;
  if (oldEnv.token == null) delete process.env.GHL_PRIVATE_TOKEN; else process.env.GHL_PRIVATE_TOKEN = oldEnv.token;
  if (oldEnv.location == null) delete process.env.GHL_LOCATION_ID; else process.env.GHL_LOCATION_ID = oldEnv.location;
  resetMetadataCache();
});
