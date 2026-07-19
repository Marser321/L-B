'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quoteHandler = require('../api/quote.js');
const availabilityHandler = require('../api/availability.js');
const {
  OPPORTUNITY_FIELDS,
  validatePayload,
  validateAvailabilityRequest,
  bookingModeForPackage,
  zonedDateTimeToIso,
  requestedPeriod,
  resetMetadataCache
} = quoteHandler._test;

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
    schedule: { date: '2026-12-01', timeWindow: 'morning', timeLabel: 'Forged client label', notes: 'Gate 4' },
    ...overrides
  };
}

function fullDayPayload(overrides = {}) {
  return payload({
    selection: {
      category: { id: 'heavy_trucks', name: 'Heavy Trucks' },
      package: { id: 'semi-truck-wash', name: 'Semi Truck Wash' },
      size: { id: 'standard', name: 'Standard Size' },
      addons: []
    },
    schedule: { date: '2026-12-02', timeWindow: 'full_day', timeLabel: 'Full day', notes: '' },
    ...overrides
  });
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

async function invoke(handler, body, headers) {
  const res = response();
  await handler(request(body, headers), res);
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

function setTestEnv() {
  const keys = [
    'GHL_PRIVATE_TOKEN', 'GHL_LOCATION_ID', 'GHL_PIPELINE_ID', 'GHL_PIPELINE_STAGE_ID',
    'GHL_CONFIRMED_PIPELINE_STAGE_ID', 'GHL_CALENDAR_ID', 'GHL_ASSIGNED_USER_ID'
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    GHL_PRIVATE_TOKEN: 'test-token',
    GHL_LOCATION_ID: 'location-1',
    GHL_PIPELINE_ID: 'pipeline-1',
    GHL_PIPELINE_STAGE_ID: 'stage-pending',
    GHL_CONFIRMED_PIPELINE_STAGE_ID: 'stage-confirmed',
    GHL_CALENDAR_ID: 'calendar-1',
    GHL_ASSIGNED_USER_ID: 'user-1'
  });
  resetMetadataCache();
  return () => {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetMetadataCache();
  };
}

function makeCrmMock() {
  const requests = [];
  const opportunities = [];
  const appointments = [];
  const fields = Object.values(OPPORTUNITY_FIELDS).map((name, index) => ({
    id: `field-${index}`, name, model: 'opportunity', dataType: 'TEXT'
  }));
  const fieldId = key => `field-${Object.keys(OPPORTUNITY_FIELDS).indexOf(key)}`;

  function availableStarts(date) {
    const starts = ['08:00', '12:00', '16:00'];
    return starts.filter(time => {
      const start = Date.parse(zonedDateTimeToIso(date, time));
      const endHour = time === '08:00' ? '11:00' : (time === '12:00' ? '15:00' : '19:00');
      const end = Date.parse(zonedDateTimeToIso(date, endHour));
      return !appointments.some(event => Date.parse(event.startTime) < end && Date.parse(event.endTime) > start);
    }).map(time => zonedDateTimeToIso(date, time));
  }

  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (url.includes('/customFields')) return new Response(JSON.stringify({ customFields: fields }), { status: 200 });
    if (url.includes('/free-slots?')) {
      return new Response(JSON.stringify({
        '2026-12-01': { slots: availableStarts('2026-12-01') },
        '2026-12-02': { slots: availableStarts('2026-12-02') },
        '2026-12-06': { slots: availableStarts('2026-12-06') }
      }), { status: 200 });
    }
    if (url.endsWith('/contacts/upsert')) return new Response(JSON.stringify({ contact: { id: 'contact-1' } }), { status: 200 });
    if (url.includes('/opportunities/search?')) return new Response(JSON.stringify({ opportunities }), { status: 200 });
    if (/\/calendars\/events\?/.test(url)) return new Response(JSON.stringify({ events: appointments }), { status: 200 });
    if (url.endsWith('/opportunities/') && options.method === 'POST') {
      const opportunity = {
        id: `opp-${opportunities.length + 1}`,
        customFields: body.customFields.map(field => ({ id: field.id, fieldValueString: field.fieldValue }))
      };
      opportunities.push(opportunity);
      return new Response(JSON.stringify({ opportunity }), { status: 201 });
    }
    if (/\/opportunities\/opp-\d+$/.test(url) && options.method === 'PUT') {
      const opportunity = opportunities.find(item => url.endsWith(`/${item.id}`));
      opportunity.pipelineStageId = body.pipelineStageId;
      opportunity.assignedTo = body.assignedTo;
      opportunity.customFields = body.customFields.map(field => ({ id: field.id, fieldValueString: field.fieldValue }));
      return new Response(JSON.stringify({ opportunity }), { status: 200 });
    }
    if (url.endsWith('/calendars/events/appointments') && options.method === 'POST') {
      const overlap = appointments.some(event => Date.parse(event.startTime) < Date.parse(body.endTime) && Date.parse(event.endTime) > Date.parse(body.startTime));
      if (overlap) return new Response('{}', { status: 409 });
      const appointment = { id: `appointment-${appointments.length + 1}`, ...body };
      appointments.push(appointment);
      return new Response(JSON.stringify(appointment), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  return { fetch, requests, opportunities, appointments, fieldId };
}

test('validates, normalizes, and derives trusted booking labels', () => {
  const result = validatePayload(payload());
  assert.equal(result.customer.phone, '+12395550100');
  assert.equal(result.schedule.timeLabel, 'Morning (8am–12pm)');
  assert.equal(bookingModeForPackage('premium-detail'), 'slot');
  assert.equal(bookingModeForPackage('boat-detail'), 'full_day');
  assert.throws(() => validatePayload(fullDayPayload({ schedule: payload().schedule })), /full_day/i);
});

test('validates availability range and exact timezone conversion across DST', () => {
  assert.deepEqual(validateAvailabilityRequest({ packageId: 'premium-detail', from: '2026-12-01', to: '2026-12-10' }), {
    packageId: 'premium-detail', from: '2026-12-01', to: '2026-12-10'
  });
  assert.equal(zonedDateTimeToIso('2026-07-15', '08:00'), '2026-07-15T12:00:00.000Z');
  assert.equal(zonedDateTimeToIso('2026-12-01', '08:00'), '2026-12-01T13:00:00.000Z');
  assert.throws(() => validateAvailabilityRequest({ packageId: 'forged', from: '2026-12-01', to: '2026-12-02' }), /packageId/i);
});

test('accepts car hauler packages only as full-day bookings', () => {
  const packageIds = [
    'car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x',
    // TODO(remove-graphite): retired ids accepted during the transition window;
    // flip these to assert.throws when the window closes.
    'car-hauler-graphite-wash', 'car-hauler-graphite-2x', 'car-hauler-graphite-4x'
  ];
  for (const packageId of packageIds) {
    const result = validatePayload(fullDayPayload({
      selection: {
        category: { id: 'heavy_trucks', name: 'Heavy Trucks' },
        package: { id: packageId, name: 'Car Hauler' },
        size: { id: 'standard', name: 'Standard Size' },
        addons: []
      }
    }));
    assert.equal(result.selection.package.id, packageId);
  }
});

test('restricts the lubricante-grafito add-on to car hauler packages', () => {
  const carHaulerSelection = (packageId, addons) => fullDayPayload({
    selection: {
      category: { id: 'heavy_trucks', name: 'Heavy Trucks' },
      package: { id: packageId, name: 'Heavy Truck Package' },
      size: { id: 'standard', name: 'Standard Size' },
      addons
    }
  });
  const grafito = [{ id: 'lubricante-grafito', name: 'Dry Graphite Lubricant', price: '+$60' }];
  for (const packageId of ['car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x']) {
    const result = validatePayload(carHaulerSelection(packageId, grafito));
    assert.equal(result.selection.addons[0].id, 'lubricante-grafito');
  }
  assert.throws(() => validatePayload(carHaulerSelection('trailer-wash', grafito)), /invalid for this package/i);
});

function cartItem(overrides = {}) {
  return {
    category: { id: 'cars', name: 'Cars & SUVs' },
    package: { id: 'basico-exterior', name: 'Basic Wash' },
    size: { id: 'sedan', name: 'Sedan / Coupe' },
    addons: [],
    vehicle: { make: 'Toyota', model: 'Camry', year: 2024, color: 'Blue', plate: 'ABC 123' },
    estimate: { min: 45, max: 45, label: '$45', custom: false, isRange: false },
    ...overrides
  };
}

function trailerItem(overrides = {}) {
  return cartItem({
    category: { id: 'heavy_trucks', name: 'Heavy Trucks' },
    package: { id: 'trailer-wash', name: 'Trailer Wash (Reefer / Dry Van)' },
    size: { id: 'standard', name: 'Standard Size' },
    vehicle: { make: 'Utility', model: '3000R', year: 2020, color: '', plate: 'TRL 987' },
    estimate: { min: 200, max: 200, label: '$200', custom: false, isRange: false },
    ...overrides
  });
}

function cartPayload(items, overrides = {}) {
  const base = payload(overrides);
  delete base.selection;
  delete base.vehicle;
  base.items = items;
  return base;
}

test('validates multi-item carts: modes, totals, and limits', () => {
  const twoCars = cartPayload([cartItem(), cartItem({ vehicle: { make: 'Honda', model: 'Civic', year: 2021, color: '', plate: '' } })], {
    estimate: { min: 90, max: 90, label: '$90', custom: false, isRange: false }
  });
  const result = validatePayload(twoCars);
  assert.equal(result.items.length, 2);
  assert.equal(quoteHandler._test.bookingModeForItems(result.items), 'slot');
  assert.equal(result.estimate.min, 90);
  assert.equal(result.selection.package.id, 'basico-exterior'); // first-item alias

  // A cart mixing a slot-based car with a full-day trailer books the whole day.
  const mixed = cartPayload([cartItem(), trailerItem()], {
    estimate: { min: 245, max: 245, label: '$245', custom: false, isRange: false },
    schedule: { date: '2026-12-02', timeWindow: 'full_day', timeLabel: '', notes: '' }
  });
  const mixedResult = validatePayload(mixed);
  assert.equal(quoteHandler._test.bookingModeForItems(mixedResult.items), 'full_day');
  assert.equal(quoteHandler._test.representativeItem(mixedResult.items).package.id, 'trailer-wash');
  assert.throws(
    () => validatePayload(cartPayload([cartItem(), trailerItem()], {
      estimate: { min: 245, max: 245, label: '$245', custom: false, isRange: false }
    })),
    /full_day/i
  );

  const tooMany = cartPayload(Array.from({ length: quoteHandler._test.CART_RULES.MAX_ITEMS + 1 }, () => cartItem()));
  assert.throws(() => validatePayload(tooMany), /between 1 and/i);

  // Per-item add-on restriction: grafito on the car line is rejected even in a cart.
  assert.throws(
    () => validatePayload(cartPayload([cartItem({ addons: [{ id: 'lubricante-grafito', name: 'Graphite', price: '+$60' }] })])),
    /items\[0\]\.addons\[0\]/i
  );
});

test('legacy single-selection payload normalizes to a one-item cart', () => {
  const legacy = validatePayload(payload());
  assert.equal(legacy.items.length, 1);
  assert.equal(legacy.items[0].package.id, 'premium-detail');
  assert.equal(legacy.items[0].vehicle.make, 'Toyota');
  assert.equal(legacy.items[0].estimate.label, '$155');

  const v2 = validatePayload(cartPayload([{
    category: { id: 'cars', name: 'Cars & SUVs' },
    package: { id: 'premium-detail', name: 'Premium Detail' },
    size: { id: 'sedan', name: 'Sedan / Coupe' },
    addons: [{ id: 'limpieza-motor', name: 'Engine Bay', price: 'From $30' }],
    vehicle: { make: 'Toyota', model: 'Camry', year: 2024, color: 'Blue', plate: 'ABC 123' },
    estimate: { min: 155, max: 155, label: '$155', custom: false, isRange: false }
  }]));
  const values = quoteHandler._test.opportunityValues(legacy);
  const valuesV2 = quoteHandler._test.opportunityValues(v2);
  assert.deepEqual(values, valuesV2);
  assert.equal(values.itemCount, '1');
  assert.equal(values.servicePackage, 'Premium Detail');
});

test('books a two-item cart as one appointment with a serialized breakdown', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const body = cartPayload([trailerItem(), trailerItem({ vehicle: { make: 'Great Dane', model: 'Everest', year: 2019, color: 'White', plate: '' } })], {
    estimate: { min: 400, max: 400, label: '$400', custom: false, isRange: false },
    schedule: { date: '2026-12-02', timeWindow: 'full_day', timeLabel: '', notes: '' }
  });
  const result = await invoke(quoteHandler, body);
  assert.equal(result.status, 200);
  assert.equal(crm.appointments.length, 1);
  assert.equal(crm.opportunities.length, 1);
  assert.match(crm.appointments[0].title, /\+1 more/);
  assert.match(crm.appointments[0].description, /Services \(2\):/);
  assert.match(crm.appointments[0].description, /1\) Trailer Wash/);
  assert.match(crm.appointments[0].description, /2\) Trailer Wash/);
  const fieldValue = key => crm.opportunities[0].customFields.find(field => field.id === crm.fieldId(key)).fieldValueString;
  assert.equal(fieldValue('itemCount'), '2');
  assert.equal(fieldValue('servicePackage'), '2× Trailer Wash (Reefer / Dry Van)');
  assert.match(fieldValue('items'), /Utility 3000R/);
  assert.match(fieldValue('items'), /Great Dane Everest/);
  assert.equal(fieldValue('bookingMode'), 'full_day');
  const createRequest = crm.requests.find(item => item.url.endsWith('/opportunities/') && item.options.method === 'POST');
  assert.equal(createRequest.body.monetaryValue, 400);
  assert.match(createRequest.body.name, /2 services/);

  // Retrying the same submission is idempotent: no second appointment.
  const retry = await invoke(quoteHandler, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(crm.appointments.length, 1);

  global.fetch = oldFetch;
  restoreEnv();
});

test('availability returns live slots, full-day dates, and never exposes Sunday', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const slots = await invoke(availabilityHandler, { packageId: 'premium-detail', from: '2026-12-01', to: '2026-12-06' });
  const fullDay = await invoke(availabilityHandler, { packageId: 'boat-detail', from: '2026-12-01', to: '2026-12-06' });
  assert.equal(slots.status, 200);
  assert.deepEqual(slots.body.dates.find(day => day.date === '2026-12-01').slots, ['morning', 'afternoon', 'evening']);
  assert.equal(slots.body.dates.some(day => day.date === '2026-12-06'), false);
  assert.deepEqual(fullDay.body.dates.find(day => day.date === '2026-12-02').slots, ['full_day']);

  global.fetch = oldFetch;
  restoreEnv();
});
test('creates contact, pending opportunity, confirmed appointment, and confirmed opportunity', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const result = await invoke(quoteHandler, payload());
  assert.equal(result.status, 200);
  assert.equal(result.body.appointmentStatus, 'confirmed');
  assert.equal(crm.appointments.length, 1);
  assert.equal(crm.opportunities.length, 1);
  assert.equal(crm.opportunities[0].pipelineStageId, 'stage-confirmed');
  assert.equal(crm.opportunities[0].assignedTo, 'user-1');
  assert.equal(crm.opportunities[0].customFields.find(field => field.id === crm.fieldId('appointmentId')).fieldValueString, 'appointment-1');
  const appointmentRequest = crm.requests.find(item => item.url.endsWith('/calendars/events/appointments')).body;
  assert.equal(appointmentRequest.toNotify, true);
  assert.match(appointmentRequest.description, /Submission ID/);
  assert.equal(appointmentRequest.startTime, requestedPeriod('2026-12-01', 'morning').startTime);

  global.fetch = oldFetch;
  restoreEnv();
});

test('retries are idempotent and a full-day appointment blocks the complete date', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const first = await invoke(quoteHandler, fullDayPayload());
  const retry = await invoke(quoteHandler, fullDayPayload());
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(crm.appointments.length, 1);
  assert.equal(crm.opportunities.length, 1);
  assert.equal(crm.appointments[0].startTime, zonedDateTimeToIso('2026-12-02', '08:00'));
  assert.equal(crm.appointments[0].endTime, zonedDateTimeToIso('2026-12-02', '19:00'));

  const availability = await invoke(availabilityHandler, { packageId: 'premium-detail', from: '2026-12-02', to: '2026-12-02' });
  assert.deepEqual(availability.body.dates, []);

  global.fetch = oldFetch;
  restoreEnv();
});

test('returns 409 when another booking takes the selected slot', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  let appointmentAttempts = 0;
  global.fetch = async (url, options) => {
    if (url.endsWith('/calendars/events/appointments')) {
      appointmentAttempts += 1;
      return new Response('{}', { status: 409 });
    }
    return crm.fetch(url, options);
  };

  const result = await invoke(quoteHandler, payload());
  assert.equal(result.status, 409);
  assert.equal(result.body.ok, false);
  assert.equal(appointmentAttempts, 1);
  assert.equal(crm.appointments.length, 0);

  global.fetch = oldFetch;
  restoreEnv();
});

test('preserves a confirmed appointment when opportunity finalization temporarily fails', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  let failedUpdates = 0;
  global.fetch = async (url, options) => {
    if (/\/opportunities\/opp-\d+$/.test(url) && options && options.method === 'PUT' && failedUpdates < 3) {
      failedUpdates += 1;
      return new Response('{}', { status: 500 });
    }
    return crm.fetch(url, options);
  };

  const partial = await invoke(quoteHandler, payload());
  const retry = await invoke(quoteHandler, payload());
  assert.equal(partial.status, 200);
  assert.equal(partial.body.appointmentStatus, 'confirmed');
  assert.equal(partial.body.syncPending, true);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.syncPending, false);
  assert.equal(crm.appointments.length, 1);
  assert.equal(crm.opportunities.length, 1);

  global.fetch = oldFetch;
  restoreEnv();
});

test('honeypot bypasses CRM and missing configuration fails safely', async () => {
  const keys = ['GHL_PRIVATE_TOKEN', 'GHL_LOCATION_ID', 'GHL_CALENDAR_ID', 'GHL_ASSIGNED_USER_ID'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  const honeypot = await invoke(quoteHandler, payload({ website: 'https://spam.example' }));
  const missing = await invoke(quoteHandler, payload());
  assert.equal(honeypot.status, 200);
  assert.deepEqual(missing.body, { ok: false, error: 'CRM is not configured' });
  for (const key of keys) {
    if (old[key] == null) delete process.env[key]; else process.env[key] = old[key];
  }
});

test('rejects cross-origin requests and maps upstream failures safely', async () => {
  const crossOrigin = await invoke(quoteHandler, payload(), { origin: 'https://evil.example' });
  assert.equal(crossOrigin.status, 403);

  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  for (const [upstreamStatus, expectedStatus] of [[401, 503], [403, 503], [429, 503], [500, 502]]) {
    resetMetadataCache();
    global.fetch = async () => new Response('{}', { status: upstreamStatus });
    const result = await invoke(quoteHandler, payload());
    assert.equal(result.status, expectedStatus);
    assert.deepEqual(result.body, { ok: false, error: 'CRM temporarily unavailable' });
  }
  global.fetch = oldFetch;
  restoreEnv();
});
