'use strict';

// Shared test scaffolding: a configured environment, a fake HighLevel, and a
// fresh in-memory agenda repository per test.

const { createMemoryRepository } = require('../../api/_lib/repository-memory.js');
const { setRepositoryForTests } = require('../../api/_lib/repository.js');

const CALENDARS = ['cal-van-1', 'cal-van-2', 'cal-van-3', 'cal-van-4'];

function installEnv(overrides = {}) {
  const env = {
    BOOKING_TIMEZONE: 'America/New_York',
    GHL_PRIVATE_TOKEN: 'test-token',
    GHL_LOCATION_ID: 'loc-1',
    GHL_ASSIGNED_USER_ID: 'user-1',
    GHL_PIPELINE_ID: 'pipe-1',
    GHL_PIPELINE_STAGE_ID: 'stage-pending',
    GHL_CONFIRMED_PIPELINE_STAGE_ID: 'stage-confirmed',
    GHL_CALENDAR_CAMIONETA_1: CALENDARS[0],
    GHL_CALENDAR_CAMIONETA_2: CALENDARS[1],
    GHL_CALENDAR_CAMIONETA_3: CALENDARS[2],
    GHL_CALENDAR_CAMIONETA_4: CALENDARS[3],
    GHL_DEPOSIT_PAYMENTS: '',
    GHL_DEPOSIT_LIVE_MODE: '',
    GHL_BOOKING_WEBHOOK_URL: '',
    PAYMENT_WEBHOOK_SECRET: 'webhook-secret',
    CRON_SECRET: 'cron-secret',
    DATABASE_URL: '',
    // Listed (blank) so a membership test cannot leak Stripe or workflow config
    // into an agenda test that runs after it.
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_CHECKOUT_SUCCESS_URL: '',
    STRIPE_CHECKOUT_CANCEL_URL: '',
    GHL_WORKFLOW_SMS_URL: '',
    GHL_WORKFLOW_EMAIL_URL: '',
    GHL_WORKFLOW_INTERNAL_URL: '',
    GHL_WORKFLOW_WEBHOOK_URL: '',
    OFFICE_API_TOKEN: ''
  };
  Object.entries({ ...env, ...overrides }).forEach(([key, value]) => {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  });
}

// A HighLevel stand-in. `calendarEvents` is what each van's calendar already
// holds (manual office bookings); everything the agenda creates is recorded in
// `created` so a test can assert on compensation.
function createGhlStub(options = {}) {
  const state = {
    calls: [],
    created: [],
    deleted: [],
    calendarEvents: options.calendarEvents || {},
    blockSlotFailsAt: options.blockSlotFailsAt ?? null,
    deleteFails: options.deleteFails || false,
    contactId: options.contactId || 'contact-1',
    opportunityId: options.opportunityId || 'opp-1',
    opportunities: options.opportunities || [],
    customFields: options.customFields || null,
    invoiceUrl: options.invoiceUrl || 'https://pay.example/invoice-1',
    failures: options.failures || {}
  };

  function json(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  const fetchStub = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = String(url).replace('https://services.leadconnectorhq.com', '');
    const body = init.body ? JSON.parse(init.body) : null;
    state.calls.push({ method, path, body });

    const failure = state.failures[`${method} ${path.split('?')[0]}`];
    if (failure) return json({ message: 'forced failure' }, failure);

    if (method === 'GET' && path.startsWith('/calendars/events')) {
      const params = new URLSearchParams(path.split('?')[1] || '');
      const calendarId = params.get('calendarId');
      const events = (state.calendarEvents[calendarId] || []).map((event, index) => ({
        id: event.id || `manual-${calendarId}-${index}`,
        startTime: new Date(event.start).toISOString(),
        endTime: new Date(event.end).toISOString(),
        appointmentStatus: event.status || 'confirmed'
      }));
      return json({ events });
    }

    if (method === 'POST' && path === '/calendars/events/block-slots') {
      const index = state.created.length;
      if (state.blockSlotFailsAt != null && index >= state.blockSlotFailsAt) {
        return json({ message: 'calendar unavailable' }, 500);
      }
      const id = `block-${index + 1}`;
      state.created.push({ kind: 'block', id, calendarId: body.calendarId, body });
      return json({ id, ...body });
    }

    if (method === 'POST' && path === '/calendars/events/appointments') {
      const id = `appt-${state.created.filter(entry => entry.kind === 'appointment').length + 1}`;
      state.created.push({ kind: 'appointment', id, calendarId: body.calendarId, body });
      return json({ id, ...body });
    }

    if (method === 'DELETE' && path.startsWith('/calendars/events/')) {
      const id = decodeURIComponent(path.split('/').pop());
      if (state.deleteFails) return json({ message: 'nope' }, 500);
      state.deleted.push(id);
      return json({ succeeded: true });
    }

    if (method === 'POST' && path === '/contacts/upsert') {
      return json({ contact: { id: state.contactId } });
    }

    if (method === 'GET' && path.startsWith('/opportunities/pipelines')) {
      return json({
        pipelines: [{
          id: 'pipe-1',
          name: 'Pipeline de Servicios',
          stages: [
            { id: 'stage-pending', name: 'Pendiente de Información' },
            { id: 'stage-confirmed', name: 'Cita Confirmada' }
          ]
        }]
      });
    }

    if (method === 'GET' && path.includes('/customFields')) {
      const { OPPORTUNITY_FIELDS } = require('../../api/quote.js')._test;
      const customFields = state.customFields || Object.entries(OPPORTUNITY_FIELDS).map(([key, name]) => ({
        id: `field-${key}`, name, model: 'opportunity'
      }));
      return json({ customFields });
    }

    if (method === 'GET' && path.startsWith('/opportunities/search')) {
      return json({ opportunities: state.opportunities });
    }

    if (method === 'POST' && path === '/opportunities/') {
      state.created.push({ kind: 'opportunity', id: state.opportunityId, body });
      return json({ opportunity: { id: state.opportunityId } });
    }

    if (method === 'PUT' && path.startsWith('/opportunities/')) {
      state.created.push({ kind: 'opportunity-update', body });
      return json({ opportunity: { id: state.opportunityId } });
    }

    if (method === 'POST' && path === '/invoices/text2pay') {
      state.created.push({ kind: 'invoice', body });
      return json({ invoice: { _id: 'inv-1' }, invoiceUrl: state.invoiceUrl });
    }

    // Anything not modelled is a test bug, not a silent pass.
    throw new Error(`unexpected GHL call: ${method} ${path}`);
  };

  return { state, fetchStub };
}

// Fresh repository + fake HighLevel for one test.
function setupAgenda(options = {}) {
  installEnv(options.env || {});
  const repository = createMemoryRepository();
  setRepositoryForTests(repository);
  const ghl = createGhlStub(options);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ghl.fetchStub;
  return {
    repository,
    ghl: ghl.state,
    restore() {
      globalThis.fetch = originalFetch;
      setRepositoryForTests(null);
    }
  };
}

// Everything setupAgenda gives you, plus a fake Stripe, fake notification
// workflows, and the provisioned price map already in the database.
function setupMemberships(options = {}) {
  const { createStripeStub } = require('./stripe-fixtures.js');
  const { priceMapRows } = require('./stripe-fixtures.js');

  const ctx = setupAgenda({
    ...options,
    env: {
      STRIPE_SECRET_KEY: 'sk_test_harness',
      STRIPE_WEBHOOK_SECRET: 'whsec_harness',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://lyb.test/thanks',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://lyb.test/membership',
      GHL_WORKFLOW_SMS_URL: 'https://hooks.lyb.test/sms',
      GHL_WORKFLOW_EMAIL_URL: 'https://hooks.lyb.test/email',
      GHL_WORKFLOW_INTERNAL_URL: 'https://hooks.lyb.test/internal',
      OFFICE_API_TOKEN: 'office-token',
      ...(options.env || {})
    }
  });

  const stripe = createStripeStub(options.stripe || {});
  // Messages the notification module actually posted to a workflow endpoint.
  const workflowPosts = [];
  const ghlFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.stripe.com')) return stripe.fetchStub(url, init);
    if (target.startsWith('https://hooks.lyb.test/')) {
      if (options.workflowFails) return { ok: false, status: 500, json: async () => ({}) };
      workflowPosts.push({ url: target, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return ghlFetch(url, init);
  };

  const seedPriceMap = async (livemode = false) => {
    const { setRepositoryForTests } = require('../../api/_lib/repository.js');
    void setRepositoryForTests;
    return ctx.repository.transaction(['seed'], async tx => tx.upsertPriceMapEntries(priceMapRows(livemode)));
  };

  return {
    ...ctx,
    stripe: stripe.state,
    addSubscription: stripe.addSubscription,
    workflowPosts,
    seedPriceMap,
    // Every notification row, whether or not it reached a workflow.
    notifications: () => ctx.repository.__store().membership.notifications,
    contracts: () => ctx.repository.__store().membership.contracts,
    visits: () => ctx.repository.__store().membership.visits,
    ledger: () => ctx.repository.__store().ledger,
    restore() {
      globalThis.fetch = ghlFetch;
      ctx.restore();
    }
  };
}

// A response object shaped like the one Vercel hands a serverless function.
function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; }
  };
}

function mockRequest(body, { method = 'POST', headers = {}, url = '/api/test', query } = {}) {
  return {
    method,
    headers: { origin: 'https://lyb.test', host: 'lyb.test', ...headers },
    body,
    url,
    ...(query ? { query } : {})
  };
}

async function callHandler(handler, body, options) {
  const res = mockResponse();
  await handler(mockRequest(body, options), res);
  return res;
}

// Test dates are relative so they never drift out of the 60-day booking window.
function isoAt(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function nextWeekday(minOffset = 7) {
  for (let offset = minOffset; offset < minOffset + 7; offset += 1) {
    const date = isoAt(offset);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 0) return date;
  }
  return isoAt(minOffset);
}

module.exports = {
  CALENDARS,
  installEnv,
  createGhlStub,
  setupAgenda,
  setupMemberships,
  mockRequest,
  mockResponse,
  callHandler,
  isoAt,
  nextWeekday
};
