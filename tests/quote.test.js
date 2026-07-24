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
  durationForPackages,
  visitDurationMinutes,
  depositForPackages,
  noticeMsForPackages,
  isMembershipPackage,
  resetMetadataCache
} = quoteHandler._test;

// Bookings must land inside the rolling 60-day window, so the fixtures are
// relative to today rather than pinned to a calendar date that eventually
// falls outside it.
function isoAt(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function nextDayOfWeek(weekday, minOffset) {
  for (let offset = minOffset; offset < minOffset + 7; offset += 1) {
    if (new Date(`${isoAt(offset)}T00:00:00Z`).getUTCDay() === weekday) return isoAt(offset);
  }
  return isoAt(minOffset);
}

// Anchored on one Tuesday so the range TUESDAY→SUNDAY always reads forwards.
const TUESDAY_OFFSET = new Date(`${nextDayOfWeek(2, 7)}T00:00:00Z`).getTime();
const dayAfterTuesday = days => new Date(TUESDAY_OFFSET + days * 86400000).toISOString().slice(0, 10);
const TUESDAY = dayAfterTuesday(0);
const SUNDAY = dayAfterTuesday(5);
const WEDNESDAY = dayAfterTuesday(8);

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
    schedule: { date: TUESDAY, timeWindow: '08:00', timeLabel: 'Forged client label', notes: 'Gate 4' },
    ...overrides
  };
}

// Paint work is the only service left that reserves the whole working day.
function fullDayPayload(overrides = {}) {
  return payload({
    selection: {
      category: { id: 'paint_correction', name: 'Paint Correction' },
      package: { id: 'paint-correction', name: 'Paint Correction' },
      size: { id: 'sedan', name: 'Sedan / Coupe' },
      addons: []
    },
    schedule: { date: WEDNESDAY, timeWindow: 'full_day', timeLabel: 'Full day', notes: '' },
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

function setTestEnv(extra = {}) {
  const keys = [
    'GHL_PRIVATE_TOKEN', 'GHL_LOCATION_ID', 'GHL_PIPELINE_ID', 'GHL_PIPELINE_STAGE_ID',
    'GHL_CONFIRMED_PIPELINE_STAGE_ID', 'GHL_CALENDAR_ID', 'GHL_ASSIGNED_USER_ID', 'GHL_CREW_USER_IDS',
    'GHL_DEPOSIT_PAYMENTS', 'GHL_DEPOSIT_LIVE_MODE'
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  Object.assign(process.env, {
    GHL_PRIVATE_TOKEN: 'test-token',
    GHL_LOCATION_ID: 'location-1',
    GHL_PIPELINE_ID: 'pipeline-1',
    GHL_PIPELINE_STAGE_ID: 'stage-pending',
    GHL_CONFIRMED_PIPELINE_STAGE_ID: 'stage-confirmed',
    GHL_CALENDAR_ID: 'calendar-1',
    GHL_ASSIGNED_USER_ID: 'user-1',
    ...extra
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
  const invoices = [];
  const fields = Object.values(OPPORTUNITY_FIELDS).map((name, index) => ({
    id: `field-${index}`, name, model: 'opportunity', dataType: 'TEXT'
  }));
  const fieldId = key => `field-${Object.keys(OPPORTUNITY_FIELDS).indexOf(key)}`;

  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (url.includes('/customFields')) return new Response(JSON.stringify({ customFields: fields }), { status: 200 });
    if (url.endsWith('/contacts/upsert')) return new Response(JSON.stringify({ contact: { id: 'contact-1' } }), { status: 200 });
    if (url.includes('/opportunities/search?')) return new Response(JSON.stringify({ opportunities }), { status: 200 });
    if (/\/calendars\/events\?/.test(url)) {
      // Availability asks per crew; the duplicate lookup asks for the calendar.
      const userId = new URL(url).searchParams.get('userId');
      const events = userId ? appointments.filter(event => event.assignedUserId === userId) : appointments;
      return new Response(JSON.stringify({ events }), { status: 200 });
    }
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
      const overlap = appointments.some(event =>
        event.assignedUserId === body.assignedUserId &&
        Date.parse(event.startTime) < Date.parse(body.endTime) &&
        Date.parse(event.endTime) > Date.parse(body.startTime)
      );
      if (overlap) return new Response('{}', { status: 409 });
      const appointment = { id: `appointment-${appointments.length + 1}`, ...body };
      appointments.push(appointment);
      return new Response(JSON.stringify(appointment), { status: 200 });
    }
    if (url.endsWith('/invoices/text2pay') && options.method === 'POST') {
      const invoice = { _id: `invoice-${invoices.length + 1}`, ...body };
      invoices.push(invoice);
      return new Response(JSON.stringify({
        invoice: { _id: invoice._id },
        invoiceUrl: `https://pay.example.com/invoice/${invoice._id}`
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  return { fetch, requests, opportunities, appointments, invoices, fieldId };
}

test('validates, normalizes, and derives trusted booking labels', () => {
  const result = validatePayload(payload());
  assert.equal(result.customer.phone, '+12395550100');
  // The client-supplied label is ignored; the server derives it from the cart.
  assert.equal(result.schedule.timeLabel, '8am–9:30am');
  assert.equal(result.schedule.durationMinutes, 90);
  assert.equal(bookingModeForPackage('premium-detail'), 'slot');
  assert.equal(bookingModeForPackage('paint-correction'), 'full_day');
  assert.equal(bookingModeForPackage('boat-detail'), 'slot');
  assert.throws(() => validatePayload(fullDayPayload({ schedule: { ...payload().schedule, date: WEDNESDAY } })), /full_day/i);
});

test('derives visit length, deposit, and notice from the cart', () => {
  // "1h service + 30min" for a car, "1:30h + 30min" for a truck, and so on.
  assert.equal(durationForPackages(['premium-detail']), 90);
  assert.equal(durationForPackages(['semi-truck-wash']), 120);
  assert.equal(durationForPackages(['boat-detail']), 180);
  assert.equal(durationForPackages(['golf-premium']), 60);
  assert.equal(durationForPackages(['mobile-home-basico']), 120);
  assert.equal(durationForPackages(['driveway-basico']), 150);
  // A cart is washed one vehicle after another, so the visit is the sum.
  assert.equal(durationForPackages(['premium-detail', 'premium-detail']), 180);
  assert.equal(durationForPackages(['premium-detail', 'semi-truck-wash']), 210);
  // Paint work ignores the per-category math and takes the working day.
  assert.equal(visitDurationMinutes(['paint-correction']), 600);
  assert.equal(visitDurationMinutes(['premium-detail', 'ceramic-protection']), 600);

  assert.equal(depositForPackages(['premium-detail']), 30);
  assert.equal(depositForPackages(['golf-premium']), 30);
  assert.equal(depositForPackages(['semi-truck-wash']), 50);
  assert.equal(depositForPackages(['boat-detail']), 50);
  // One deposit per booking: the largest any line requires.
  assert.equal(depositForPackages(['premium-detail', 'semi-truck-wash']), 50);

  assert.equal(isMembershipPackage('membresia-2x'), true);
  assert.equal(isMembershipPackage('box-truck-4x'), true);
  assert.equal(isMembershipPackage('premium-detail'), false);
  assert.equal(noticeMsForPackages(['premium-detail']), 60 * 60 * 1000);
  assert.equal(noticeMsForPackages(['premium-detail', 'membresia-2x']), 48 * 60 * 60 * 1000);
});

test('validates availability range and exact timezone conversion across DST', () => {
  assert.deepEqual(validateAvailabilityRequest({ packageIds: ['premium-detail'], from: TUESDAY, to: WEDNESDAY }), {
    packageIds: ['premium-detail'], from: TUESDAY, to: WEDNESDAY
  });
  // A single packageId is still accepted for one-service lookups.
  assert.deepEqual(validateAvailabilityRequest({ packageId: 'premium-detail', from: TUESDAY, to: WEDNESDAY }).packageIds, ['premium-detail']);
  assert.equal(zonedDateTimeToIso('2026-07-15', '08:00'), '2026-07-15T12:00:00.000Z');
  assert.equal(zonedDateTimeToIso('2026-12-01', '08:00'), '2026-12-01T13:00:00.000Z');
  assert.throws(() => validateAvailabilityRequest({ packageId: 'forged', from: TUESDAY, to: WEDNESDAY }), /packageIds/i);
});

test('rejects start times off the grid or past the end of the working day', () => {
  assert.throws(() => validatePayload(payload({ schedule: { date: TUESDAY, timeWindow: '08:20', timeLabel: '', notes: '' } })), /timeWindow is invalid/i);
  assert.throws(() => validatePayload(payload({ schedule: { date: TUESDAY, timeWindow: '25:00', timeLabel: '', notes: '' } })), /timeWindow is invalid/i);
  // A 90-minute car wash cannot start at 5pm and finish before 6pm.
  assert.throws(() => validatePayload(payload({ schedule: { date: TUESDAY, timeWindow: '17:00', timeLabel: '', notes: '' } })), /working day/i);
  assert.equal(validatePayload(payload({ schedule: { date: TUESDAY, timeWindow: '16:30', timeLabel: '', notes: '' } })).schedule.timeWindow, '16:30');
  assert.throws(() => validatePayload(payload({ schedule: { date: isoAt(120), timeWindow: '08:00', timeLabel: '', notes: '' } })), /too far ahead/i);
  // TODO(remove-legacy-windows): open tabs still post the retired named windows.
  assert.equal(validatePayload(payload({ schedule: { date: TUESDAY, timeWindow: 'morning', timeLabel: '', notes: '' } })).schedule.timeWindow, '08:00');
});

test('accepts car hauler packages as duration-based bookings', () => {
  const packageIds = [
    'car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x',
    // TODO(remove-graphite): retired ids accepted during the transition window;
    // flip these to assert.throws when the window closes.
    'car-hauler-graphite-wash', 'car-hauler-graphite-2x', 'car-hauler-graphite-4x'
  ];
  for (const packageId of packageIds) {
    const result = validatePayload(payload({
      selection: {
        category: { id: 'heavy_trucks', name: 'Heavy Trucks' },
        package: { id: packageId, name: 'Car Hauler' },
        size: { id: 'standard', name: 'Standard Size' },
        addons: []
      }
    }));
    assert.equal(result.selection.package.id, packageId);
    assert.equal(result.schedule.durationMinutes, 120);
  }
});

test('restricts the lubricante-grafito add-on to car hauler packages', () => {
  const carHaulerSelection = (packageId, addons) => payload({
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

function paintItem(overrides = {}) {
  return cartItem({
    category: { id: 'paint_correction', name: 'Paint Correction' },
    package: { id: 'paint-correction', name: 'Paint Correction' },
    size: { id: 'sedan', name: 'Sedan / Coupe' },
    estimate: { min: 600, max: 600, label: '$600', custom: false, isRange: false },
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
  assert.equal(result.schedule.durationMinutes, 180);
  assert.equal(result.deposit, 30);
  assert.equal(result.estimate.min, 90);
  assert.equal(result.selection.package.id, 'basico-exterior'); // first-item alias

  // A car plus a trailer is one visit long enough for both, and the larger deposit.
  const mixed = validatePayload(cartPayload([cartItem(), trailerItem()], {
    estimate: { min: 245, max: 245, label: '$245', custom: false, isRange: false }
  }));
  assert.equal(quoteHandler._test.bookingModeForItems(mixed.items), 'slot');
  assert.equal(mixed.schedule.durationMinutes, 210);
  assert.equal(mixed.deposit, 50);

  // A cart carrying paint work still books the whole day.
  const withPaint = cartPayload([cartItem(), paintItem()], {
    estimate: { min: 645, max: 645, label: '$645', custom: false, isRange: false },
    schedule: { date: WEDNESDAY, timeWindow: 'full_day', timeLabel: '', notes: '' }
  });
  const paintResult = validatePayload(withPaint);
  assert.equal(quoteHandler._test.bookingModeForItems(paintResult.items), 'full_day');
  assert.equal(quoteHandler._test.representativeItem(paintResult.items).package.id, 'paint-correction');
  assert.throws(
    () => validatePayload(cartPayload([cartItem(), paintItem()], {
      estimate: { min: 645, max: 645, label: '$645', custom: false, isRange: false }
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
  assert.equal(values.deposit, '$30');
  assert.equal(values.duration, '1h 30m');
});

test('books a two-item cart as one appointment with a serialized breakdown', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const body = cartPayload([trailerItem(), trailerItem({ vehicle: { make: 'Great Dane', model: 'Everest', year: 2019, color: 'White', plate: '' } })], {
    estimate: { min: 400, max: 400, label: '$400', custom: false, isRange: false },
    schedule: { date: WEDNESDAY, timeWindow: '08:00', timeLabel: '', notes: '' }
  });
  const result = await invoke(quoteHandler, body);
  assert.equal(result.status, 200);
  assert.equal(crm.appointments.length, 1);
  assert.equal(crm.opportunities.length, 1);
  // Two trailers at 2h each occupy a single four-hour visit.
  assert.equal(crm.appointments[0].startTime, zonedDateTimeToIso(WEDNESDAY, '08:00'));
  assert.equal(crm.appointments[0].endTime, zonedDateTimeToIso(WEDNESDAY, '12:00'));
  assert.match(crm.appointments[0].title, /\+1 more/);
  assert.match(crm.appointments[0].description, /Services \(2\):/);
  assert.match(crm.appointments[0].description, /1\) Trailer Wash/);
  assert.match(crm.appointments[0].description, /2\) Trailer Wash/);
  const fieldValue = key => crm.opportunities[0].customFields.find(field => field.id === crm.fieldId(key)).fieldValueString;
  assert.equal(fieldValue('itemCount'), '2');
  assert.equal(fieldValue('servicePackage'), '2× Trailer Wash (Reefer / Dry Van)');
  assert.match(fieldValue('items'), /Utility 3000R/);
  assert.match(fieldValue('items'), /Great Dane Everest/);
  assert.equal(fieldValue('bookingMode'), 'slot');
  assert.equal(fieldValue('deposit'), '$50');
  assert.equal(fieldValue('duration'), '4h 0m');
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

test('availability offers a 30-minute grid, full days, and never exposes Sunday', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const slots = await invoke(availabilityHandler, { packageIds: ['premium-detail'], from: TUESDAY, to: SUNDAY });
  const fullDay = await invoke(availabilityHandler, { packageIds: ['paint-correction'], from: TUESDAY, to: SUNDAY });
  assert.equal(slots.status, 200);
  assert.equal(slots.body.durationMinutes, 90);
  assert.equal(slots.body.deposit, 30);
  const tuesday = slots.body.dates.find(day => day.date === TUESDAY).slots;
  // 8:00 through 16:30 every half hour: the last 90-minute wash ends at 6pm.
  assert.equal(tuesday[0], '08:00');
  assert.equal(tuesday[1], '08:30');
  assert.equal(tuesday[tuesday.length - 1], '16:30');
  assert.equal(tuesday.length, 18);
  assert.equal(slots.body.dates.some(day => day.date === SUNDAY), false);
  assert.deepEqual(fullDay.body.dates.find(day => day.date === TUESDAY).slots, ['full_day']);
  assert.equal(fullDay.body.durationMinutes, 600);

  // A longer cart offers fewer start times, because it has to finish by 6pm.
  const longCart = await invoke(availabilityHandler, { packageIds: ['boat-detail', 'boat-detail'], from: TUESDAY, to: TUESDAY });
  assert.equal(longCart.body.durationMinutes, 360);
  assert.deepEqual(longCart.body.dates[0].slots, ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00']);

  global.fetch = oldFetch;
  restoreEnv();
});

test('membership carts require 48 hours of notice', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const today = isoAt(0);
  const tomorrow = isoAt(1);
  const oneTime = await invoke(availabilityHandler, { packageIds: ['basico-exterior'], from: today, to: tomorrow });
  const membership = await invoke(availabilityHandler, { packageIds: ['membresia-2x'], from: today, to: tomorrow });
  const membershipDates = membership.body.dates.map(day => day.date);
  // Neither today nor tomorrow clears the 48-hour membership window.
  assert.equal(membershipDates.includes(today), false);
  assert.equal(membershipDates.includes(tomorrow), false);
  // A one-time wash only needs an hour, so tomorrow is fully open.
  assert.equal(oneTime.body.dates.some(day => day.date === tomorrow && day.slots.length), true);

  global.fetch = oldFetch;
  restoreEnv();
});

test('a second crew doubles capacity for the same start time', async () => {
  const restoreEnv = setTestEnv({ GHL_CREW_USER_IDS: 'user-1,user-2' });
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const first = await invoke(quoteHandler, payload());
  const second = await invoke(quoteHandler, payload({ submissionId: '223e4567-e89b-12d3-a456-426614174111' }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(crm.appointments.length, 2);
  // The same 8am slot goes to two different vans.
  assert.equal(crm.appointments[0].assignedUserId, 'user-1');
  assert.equal(crm.appointments[1].assignedUserId, 'user-2');
  assert.equal(crm.appointments[0].startTime, crm.appointments[1].startTime);

  // With both crews busy the slot disappears and a third booking is refused.
  const availability = await invoke(availabilityHandler, { packageIds: ['premium-detail'], from: TUESDAY, to: TUESDAY });
  assert.equal(availability.body.dates[0].slots.includes('08:00'), false);
  const third = await invoke(quoteHandler, payload({ submissionId: '323e4567-e89b-12d3-a456-426614174222' }));
  assert.equal(third.status, 409);
  assert.equal(crm.appointments.length, 2);

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
  assert.equal(appointmentRequest.startTime, requestedPeriod(TUESDAY, '08:00', 90).startTime);
  assert.equal(appointmentRequest.endTime, zonedDateTimeToIso(TUESDAY, '09:30'));

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
  assert.equal(crm.appointments[0].startTime, zonedDateTimeToIso(WEDNESDAY, '08:00'));
  assert.equal(crm.appointments[0].endTime, zonedDateTimeToIso(WEDNESDAY, '18:00'));

  const availability = await invoke(availabilityHandler, { packageIds: ['premium-detail'], from: WEDNESDAY, to: WEDNESDAY });
  assert.deepEqual(availability.body.dates, []);

  global.fetch = oldFetch;
  restoreEnv();
});

test('an existing booking only blocks the hours it actually occupies', async () => {
  const restoreEnv = setTestEnv();
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  await invoke(quoteHandler, payload()); // 8:00–9:30
  const availability = await invoke(availabilityHandler, { packageIds: ['premium-detail'], from: TUESDAY, to: TUESDAY });
  const slots = availability.body.dates[0].slots;
  assert.equal(slots.includes('08:00'), false);
  assert.equal(slots.includes('08:30'), false);
  assert.equal(slots.includes('09:00'), false);
  // The next wash can start the moment the buffer ends.
  assert.equal(slots.includes('09:30'), true);

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

// ──────────────────────────────────────────────
// PHASE B: online deposit collection (GHL_DEPOSIT_PAYMENTS)
// ──────────────────────────────────────────────

test('Phase B off: no payment call, no depositUrl, no deposit fields written', async () => {
  const restoreEnv = setTestEnv(); // flag unset -> off
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const result = await invoke(quoteHandler, payload());
  assert.equal(result.status, 200);
  assert.equal(result.body.appointmentStatus, 'confirmed');
  assert.equal('depositUrl' in result.body, false);
  assert.equal(crm.invoices.length, 0);
  assert.equal(crm.requests.some(item => item.url.endsWith('/invoices/text2pay')), false);
  const opp = crm.opportunities[0];
  assert.equal(opp.customFields.some(field => field.id === crm.fieldId('depositStatus')), false);
  assert.equal(opp.customFields.some(field => field.id === crm.fieldId('depositLink')), false);

  global.fetch = oldFetch;
  restoreEnv();
});

test('Phase B off: byte-for-byte parity even if HighLevel has not been provisioned with the new deposit fields yet', async () => {
  const restoreEnv = setTestEnv(); // flag unset -> off
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  // Simulate a sub-account that hasn't re-run scripts/setup-ghl.mjs yet: strip
  // the two Phase-B-only custom fields from what HighLevel returns.
  global.fetch = async (url, options) => {
    if (url.includes('/customFields')) {
      const filtered = Object.values(OPPORTUNITY_FIELDS)
        .map((name, index) => ({ id: `field-${index}`, name, model: 'opportunity', dataType: 'TEXT' }))
        .filter(field => field.name !== OPPORTUNITY_FIELDS.depositStatus && field.name !== OPPORTUNITY_FIELDS.depositLink);
      return new Response(JSON.stringify({ customFields: filtered }), { status: 200 });
    }
    return crm.fetch(url, options);
  };

  const result = await invoke(quoteHandler, payload());
  assert.equal(result.status, 200);
  assert.equal(result.body.appointmentStatus, 'confirmed');

  global.fetch = oldFetch;
  restoreEnv();
});

test('Phase B on: creates a text2pay invoice with the correct amount and returns depositUrl', async () => {
  const restoreEnv = setTestEnv({ GHL_DEPOSIT_PAYMENTS: 'on' });
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  const result = await invoke(quoteHandler, payload()); // premium-detail -> $30 deposit
  assert.equal(result.status, 200);
  assert.equal(crm.invoices.length, 1);
  assert.equal(crm.invoices[0].items[0].amount, 30);
  assert.equal(crm.invoices[0].liveMode, false); // GHL_DEPOSIT_LIVE_MODE unset -> Stripe test mode
  assert.equal(crm.invoices[0].contactDetails.id, 'contact-1');
  assert.equal(result.body.depositUrl, `https://pay.example.com/invoice/${crm.invoices[0]._id}`);
  const opp = crm.opportunities[0];
  const fieldValue = key => opp.customFields.find(field => field.id === crm.fieldId(key)).fieldValueString;
  assert.equal(fieldValue('depositStatus'), 'unpaid');
  assert.equal(fieldValue('depositLink'), result.body.depositUrl);
  // The rest of the opportunity's fields must survive the follow-up update.
  assert.equal(fieldValue('servicePackage'), 'Premium Detail');

  // A retry of the same submission must not mint a second invoice.
  const retry = await invoke(quoteHandler, payload());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal('depositUrl' in retry.body, false);
  assert.equal(crm.invoices.length, 1);

  global.fetch = oldFetch;
  restoreEnv();
});

test('Phase B on: GHL_DEPOSIT_LIVE_MODE=true charges through Stripe live mode', async () => {
  const restoreEnv = setTestEnv({ GHL_DEPOSIT_PAYMENTS: 'on', GHL_DEPOSIT_LIVE_MODE: 'true' });
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = crm.fetch;

  await invoke(quoteHandler, payload());
  assert.equal(crm.invoices[0].liveMode, true);

  global.fetch = oldFetch;
  restoreEnv();
});

test('Phase B on: a failed deposit payment call never breaks a confirmed booking', async () => {
  const restoreEnv = setTestEnv({ GHL_DEPOSIT_PAYMENTS: 'on' });
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  const originalConsoleError = console.error;
  const loggedErrors = [];
  console.error = (...args) => { loggedErrors.push(args); };
  global.fetch = async (url, options) => {
    if (url.endsWith('/invoices/text2pay')) return new Response('{}', { status: 500 });
    return crm.fetch(url, options);
  };

  const result = await invoke(quoteHandler, payload());
  assert.equal(result.status, 200);
  assert.equal(result.body.appointmentStatus, 'confirmed');
  assert.equal('depositUrl' in result.body, false);
  assert.equal(loggedErrors.some(args => args[0] === '[quote] deposit payment failed'), true);
  const opp = crm.opportunities[0];
  assert.equal(opp.customFields.some(field => field.id === crm.fieldId('depositStatus')), false);

  console.error = originalConsoleError;
  global.fetch = oldFetch;
  restoreEnv();
});

test('Phase B on without provisioning the deposit fields fails safely and never confirms a booking', async () => {
  const restoreEnv = setTestEnv({ GHL_DEPOSIT_PAYMENTS: 'on' });
  const oldFetch = global.fetch;
  const crm = makeCrmMock();
  global.fetch = async (url, options) => {
    if (url.includes('/customFields')) {
      const filtered = Object.values(OPPORTUNITY_FIELDS)
        .map((name, index) => ({ id: `field-${index}`, name, model: 'opportunity', dataType: 'TEXT' }))
        .filter(field => field.name !== OPPORTUNITY_FIELDS.depositStatus && field.name !== OPPORTUNITY_FIELDS.depositLink);
      return new Response(JSON.stringify({ customFields: filtered }), { status: 200 });
    }
    return crm.fetch(url, options);
  };

  const result = await invoke(quoteHandler, payload());
  assert.equal(result.status, 503);
  assert.equal(crm.appointments.length, 0);
  assert.equal(crm.opportunities.length, 0);

  global.fetch = oldFetch;
  restoreEnv();
});
