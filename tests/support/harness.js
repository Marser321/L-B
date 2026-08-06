'use strict';

// Shared test scaffolding: a configured environment, a fake HighLevel, and a
// fresh in-memory agenda repository per test.

const { createMemoryRepository } = require('../../api/_lib/repository-memory.js');
const { setRepositoryForTests } = require('../../api/_lib/repository.js');

const CALENDARS = ['cal-van-1', 'cal-van-2', 'cal-van-3', 'cal-van-4'];

// One team member per van calendar, mirroring the live sub-account. Only this user
// may be named as assignedUserId on that calendar; the office user cannot.
const CALENDAR_TEAM_MEMBER = Object.freeze(Object.fromEntries(
  CALENDARS.map((calendarId, index) => [calendarId, `van-user-${index + 1}`])
));

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
    invoices: [],
    appointmentFailsAt: options.appointmentFailsAt ?? null,
    deleteFails: options.deleteFails || false,
    contactId: options.contactId || 'contact-1',
    opportunityId: options.opportunityId || 'opp-1',
    opportunities: options.opportunities || [],
    customFields: options.customFields || null,
    // Per-id contract overrides for the member tests: an object replaces the default,
    // null makes the id a 404.
    contracts: options.contracts || {},
    contactContracts: options.contactContracts || null,
    invoicesById: options.invoicesById || {},
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
      // HighLevel honours the requested window; so must the fake, or a test that
      // asserts "yesterday is invisible" passes for the wrong reason.
      const fromMs = Number(params.get('startTime'));
      const toMs = Number(params.get('endTime'));
      const events = (state.calendarEvents[calendarId] || [])
        .filter(event => !Number.isFinite(fromMs) || !Number.isFinite(toMs) || (event.start < toMs && event.end > fromMs))
        .map((event, index) => ({
          id: event.id || `manual-${calendarId}-${index}`,
          startTime: new Date(event.start).toISOString(),
          endTime: new Date(event.end).toISOString(),
          appointmentStatus: event.status || 'confirmed',
          // Passed through because the crew panel reads them. Dropping them here made
          // the fake narrower than the real API, which is how a screen that works in
          // tests renders blank in a driveway.
          ...(event.title ? { title: event.title } : {}),
          ...(event.address ? { address: event.address } : {}),
          ...(event.notes ? { notes: event.notes } : {}),
          ...(event.contactId ? { contactId: event.contactId } : {})
        }));
      return json({ events });
    }

    // Block slots are gone from the agenda: the real sub-account answers 400 "The
    // calendar is not an event calendar." on every van, because the vans are Personal
    // calendars. The fake says the same thing so nothing can quietly start using them
    // again and pass its tests.
    if (method === 'POST' && path === '/calendars/events/block-slots') {
      return json({ message: 'The calendar is not an event calendar.', statusCode: 400 }, 400);
    }

    if (method === 'POST' && path === '/calendars/events/appointments') {
      // Each van has its own PERSONAL calendar with exactly one team member. Assigning
      // an appointment on it to anybody else is 422 "The user id not part of calendar
      // team." — the real failure that took every hold down in production, because the
      // hold code inherited the office user id from the block-slot call it replaced.
      // Modelled here so nothing can put that field back and still pass its tests.
      if (body.assignedUserId && body.assignedUserId !== CALENDAR_TEAM_MEMBER[body.calendarId]) {
        return json({ message: 'The user id not part of calendar team.', statusCode: 422 }, 422);
      }
      const index = state.created.filter(entry => entry.kind === 'appointment').length;
      if (state.appointmentFailsAt != null && index >= state.appointmentFailsAt) {
        return json({ message: 'calendar unavailable' }, 500);
      }
      // HighLevel's own slot validation, which the agenda now relies on instead of
      // block slots. Verified against the live sub-account on 2026-08-04: an
      // overlapping appointment is refused with this exact message, and concurrent
      // attempts serialize so only one wins. `ignoreFreeSlotValidation: true` waives
      // it — that is how a status update on an existing appointment gets through.
      if (body.ignoreFreeSlotValidation !== true) {
        const start = Date.parse(body.startTime);
        const end = Date.parse(body.endTime);
        const clash = state.created.some(entry =>
          entry.kind === 'appointment' &&
          !state.deleted.includes(entry.id) &&
          entry.calendarId === body.calendarId &&
          Date.parse(entry.body.startTime) < end &&
          start < Date.parse(entry.body.endTime)
        ) || (state.calendarEvents[body.calendarId] || []).some(event =>
          event.start < end && start < event.end
        );
        if (clash) {
          return json({ message: 'The slot you have selected is no longer available.', statusCode: 400 }, 400);
        }
      }
      const id = `appt-${index + 1}`;
      state.created.push({ kind: 'appointment', id, calendarId: body.calendarId, body });
      return json({ id, ...body });
    }

    // Status/label updates on an existing appointment. Confirming a booking is now a
    // PUT rather than a create-then-delete, so the fake has to answer it — without
    // this, every confirmation logged a failure and the tests still passed because
    // they only inspected the recorded call.
    if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) {
      const id = decodeURIComponent(path.split('/').pop());
      const existing = state.created.find(entry => entry.kind === 'appointment' && entry.id === id);
      if (existing) {
        existing.body = { ...existing.body, ...body };
        return json({ id, ...existing.body });
      }
      // Appointments seeded straight onto a calendar (the office booked them by hand,
      // or a test is describing a day that already existed) are editable too.
      for (const events of Object.values(state.calendarEvents)) {
        const seeded = events.find(event => event.id === id);
        if (seeded) {
          if (body.appointmentStatus) seeded.status = body.appointmentStatus;
          if (body.title) seeded.title = body.title;
          return json({ id, ...body });
        }
      }
      return json({ message: 'Appointment not found' }, 404);
    }

    // ── Invoices ─────────────────────────────────────────────────────────────
    // Listing, which upstream searches the NAME as a fuzzy contains. Modelled that
    // way on purpose: it is what makes an exact-match caller (ghl.findInvoiceByName)
    // meaningful rather than a formality.
    if (method === 'GET' && path.startsWith('/invoices/?')) {
      const search = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('search') || '';
      const invoices = state.created
        .filter(entry => entry.kind === 'invoice' && String(entry.body.name || '').includes(search))
        .map((entry, index) => ({ _id: `inv-${index + 1}`, name: entry.body.name, invoiceUrl: state.invoiceUrl }));
      return json({ invoices, total: invoices.length });
    }

    if (method === 'GET' && /^\/invoices\/[^/]+/.test(path) && !/record-payment/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2].split('?')[0]);
      const seeded = (state.invoicesById || {})[id];
      if (seeded === null) return json({ message: 'Not found' }, 404);
      return json({
        _id: id,
        status: 'paid',
        issueDate: '2026-08-04',
        contactDetails: { id: state.contactId },
        invoiceItems: [{ name: 'Membresía 2x — Cars & SUVs · Sedan', amount: 150, qty: 1 }],
        ...(seeded || {})
      });
    }

    if (method === 'POST' && path === '/invoices/') {
      const id = `inv-${state.invoices.length + 1}`;
      state.invoices.push({ id, body, payments: [] });
      return json({ _id: id, ...body });
    }

    if (method === 'POST' && /^\/invoices\/[^/]+\/record-payment$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2]);
      const invoice = state.invoices.find(entry => entry.id === id);
      if (!invoice) return json({ message: 'Invoice not found' }, 404);
      invoice.payments.push(body);
      return json({ success: true, invoice: { _id: id, status: 'paid' } });
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

    if (method === 'GET' && /^\/contacts\/[^/?]+/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2].split('?')[0]);
      return json({ contact: { id, name: 'Jane Driver', email: 'jane@example.test', phone: '+12395550100' } });
    }

    if (method === 'GET' && path.startsWith('/opportunities/pipelines')) {
      if (state.membershipsPipeline !== false) {
        return json({
          pipelines: [
            {
              id: 'pipe-1',
              name: 'Pipeline de Servicios',
              stages: [
                { id: 'stage-pending', name: 'Pendiente de Información' },
                { id: 'stage-confirmed', name: 'Cita Confirmada' }
              ]
            },
            {
              id: 'pipe-memberships',
              name: 'Memberships',
              stages: [
                { id: 'stage-mem-pending', name: 'Pending Payment' },
                { id: 'stage-mem-active', name: 'Active' },
                { id: 'stage-mem-past', name: 'Past Due' },
                { id: 'stage-mem-cancel-end', name: 'Cancel at Period End' },
                { id: 'stage-mem-canceled', name: 'Canceled' }
              ]
            }
          ]
        });
      }
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
      const quoteFields = Object.entries(OPPORTUNITY_FIELDS).map(([key, name]) => ({
        id: `field-${key}`, name, model: 'opportunity'
      }));
      // The membership contract fields the sub-account really has, so the member link
      // resolves them by name the way it does in production.
      const membershipFields = [
        { id: 'field-mem-plan', name: 'Membership Plan', model: 'opportunity' },
        { id: 'field-mem-vehicle', name: 'Membership Vehicle', model: 'opportunity' },
        { id: 'field-mem-status', name: 'Membership Status', model: 'opportunity' },
        { id: 'field-mem-cycle', name: 'Membership Cycle Ends', model: 'opportunity' }
      ];
      const customFields = state.customFields || [...quoteFields, ...membershipFields];
      return json({ customFields });
    }

    // One opportunity by id — how the member link loads its contract. `opp-membership-*`
    // is a membership; anything else is deliberately not, so a signed link to some
    // other opportunity can be shown to open nothing.
    if (method === 'GET' && /^\/opportunities\/[^/]+$/.test(path) && !path.startsWith('/opportunities/search')) {
      const id = decodeURIComponent(path.split('/')[2]);
      const override = (state.contracts || {})[id];
      if (override === null) return json({ message: 'Not found' }, 404);
      if (override) return json({ opportunity: { id, ...override } });
      const isMembership = id.startsWith('opp-membership');
      return json({
        opportunity: {
          id,
          contact: { id: state.contactId },
          // The status is read from the STAGE, so the fake has to name one.
          pipelineStageId: 'stage-mem-active',
          customFields: isMembership ? [
            { id: 'field-mem-plan', fieldValue: 'membresia-2x' },
            { id: 'field-mem-vehicle', fieldValue: '2024 Toyota Camry' },
            { id: 'field-mem-status', fieldValue: 'active' },
            // Twenty days out, so "inside the cycle" and "past the cycle" are both
            // reachable from a test.
            { id: 'field-mem-cycle', fieldValue: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString() }
          ] : []
        }
      });
    }

    if (method === 'GET' && path.startsWith('/opportunities/search')) {
      // The member/webhook path searches a contact's membership contracts. A test seeds
      // them explicitly; everything else keeps the old single-opportunity behaviour.
      if (state.contactContracts) return json({ opportunities: state.contactContracts });
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

// Everything setupAgenda gives you, plus fake notification workflows and a way to
// put an ACTIVE membership contract in the store.
//
// There is no payment provider here. Stripe was removed on 2026-08-04 and the
// HighLevel replacement does not exist yet, so a test that needs a member creates the
// contract directly with `activateContract`. That is how these tests should always
// have worked: what they exercise is the membership RULES — notice, credits, late
// cancels, no-shows — and none of those depend on who moved the money.
// A date offset from today IN THE BUSINESS TIMEZONE, which is the only "today" the code
// knows. Building it from UTC instead makes every test that seeds "today" fail between
// 8pm and midnight in Naples, when UTC has already rolled over — a suite that breaks four
// hours a day is worse than no suite.
function businessDate(offsetDays = 0) {
  const time = require('../../api/_lib/time.js');
  const zone = time.bookingTimezone();
  return time.addDays(time.todayInZone(Date.now(), zone), offsetDays);
}

// The same, skipping Sundays forward — the crew does not work then.
function businessWeekday(offsetDays = 0) {
  let date = businessDate(offsetDays);
  const time = require('../../api/_lib/time.js');
  while (time.isSunday(date)) date = time.addDays(date, 1);
  return date;
}

function setupMemberships(options = {}) {
  const ctx = setupAgenda({
    ...options,
    env: {
      GHL_WORKFLOW_SMS_URL: 'https://hooks.lyb.test/sms',
      GHL_WORKFLOW_EMAIL_URL: 'https://hooks.lyb.test/email',
      GHL_WORKFLOW_INTERNAL_URL: 'https://hooks.lyb.test/internal',
      OFFICE_API_TOKEN: 'office-token',
      ...(options.env || {})
    }
  });

  // Messages the notification module actually posted to a workflow endpoint.
  const workflowPosts = [];
  const ghlFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('https://hooks.lyb.test/')) {
      if (options.workflowFails) return { ok: false, status: 500, json: async () => ({}) };
      workflowPosts.push({ url: target, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return ghlFetch(url, init);
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  // An active contract with a paid cycle and its credits granted, written straight to
  // the store. `credits` defaults to the plan's allowance.
  async function activateContract({
    packageId = 'membresia-2x',
    sizeId = 'sedan',
    contactId = 'contact-1',
    vehicleLabel = '2024 Toyota Camry',
    credits = null,
    status = 'active',
    now = Date.now(),
    periodStartMs = null,
    periodEndMs = null,
    cancelAtPeriodEnd = false
  } = {}) {
    const membershipCatalog = require('../../api/_lib/membership-catalog.js');
    const allowance = credits == null ? membershipCatalog.creditsForPackage(packageId) : credits;
    const contractId = `contract-${Math.random().toString(36).slice(2, 10)}`;
    await ctx.repository.transaction(['seed'], async tx => {
      await tx.insertContract({
        id: contractId,
        contactId,
        packageId,
        sizeId,
        vehicleLabel,
        status,
        creditsPerCycle: membershipCatalog.creditsForPackage(packageId),
        creditsRemaining: allowance,
        currentPeriodStartMs: periodStartMs == null ? now - DAY_MS : periodStartMs,
        currentPeriodEndMs: periodEndMs == null ? now + 29 * DAY_MS : periodEndMs,
        cancelAtPeriodEnd,
        // The dedupe key still carries a Stripe name in the schema. Renaming a column
        // needs a migration and the tables are on their way out, so it is left alone
        // and simply given a unique value here.
        stripeSubscriptionItemId: `seed-item-${contractId}`,
        lineIndex: 0,
        // Stands in for the paid-cycle proof a payment provider used to write. The
        // HighLevel implementation will put its paid invoice id here.
        activatedByEventId: `seed-${contractId}`
      });
    });
    return contractId;
  }

  return {
    ...ctx,
    workflowPosts,
    activateContract,
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
  businessDate,
  businessWeekday,
  mockRequest,
  mockResponse,
  callHandler,
  isoAt,
  nextWeekday
};
