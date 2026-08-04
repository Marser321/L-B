'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupAgenda, callHandler, isoAt, nextWeekday, CALENDARS } = require('./support/harness.js');

const quoteHandler = require('../api/quote.js');
const {
  OPPORTUNITY_FIELDS, validatePayload, opportunityValues, resetMetadataCache, splitName, normalizePhone
} = quoteHandler._test;
const catalog = require('../api/_lib/catalog.js');
const time = require('../api/_lib/time.js');

const DATE = nextWeekday(7);

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
    schedule: { date: DATE, timeWindow: '08:00', timeLabel: 'Forged client label', notes: 'Gate 4' },
    ...overrides
  };
}

function item(packageId, sizeId, extra = {}) {
  return {
    category: { id: catalog.categoryForPackage(packageId), name: 'Category' },
    package: { id: packageId, name: packageId },
    size: { id: sizeId, name: sizeId },
    addons: [],
    vehicle: { make: 'Toyota', model: 'Camry', year: 2024 },
    ...extra
  };
}

function fresh(options) {
  resetMetadataCache();
  return setupAgenda(options);
}

// ── Validation ─────────────────────────────────────────────────────────────

test('normalizes the customer and derives its own booking label', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const result = validatePayload(payload());
  assert.equal(result.customer.phone, '+12395550100');
  // The client's label is thrown away and rebuilt from the server's own duration.
  assert.equal(result.schedule.timeLabel, '8am–9:30am');
  assert.equal(result.schedule.durationMinutes, 90);
  // 60 of hands-on service; the 90 above is that plus the travel buffer.
  assert.deepEqual(result.schedule.perVehicleDurationMinutes, [60]);
  assert.equal(result.schedule.timezone, 'America/New_York');
  assert.equal(splitName('Jane Driver').lastName, 'Driver');
  assert.equal(normalizePhone('239-555-0100'), '+12395550100');
});

test('price, duration, deposit and membership status come from the catalog, never the request', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const result = validatePayload(payload({
    // Every number below is a lie the browser told.
    estimate: { min: 1, max: 1, label: '$1', custom: false, isRange: false },
    deposit: 0,
    schedule: { date: DATE, timeWindow: '08:00', timeLabel: '5 minutes', notes: '', durationMinutes: 5 },
    items: [{
      ...item('premium-detail', 'sedan'),
      addons: [{ id: 'limpieza-motor', name: 'Engine Bay', price: '$0' }],
      price: 1, durationMinutes: 5, isMembership: false, calendarId: 'attacker-calendar'
    }]
  }));

  // premium-detail/sedan $185 + limpieza-motor "Desde $30".
  assert.equal(result.estimate.min, 215);
  assert.equal(result.estimate.label, 'From $215');
  assert.equal(result.deposit, 30);
  assert.equal(result.schedule.durationMinutes, 90);
  assert.equal(result.vehicles[0].isMembership, false);
  // Nothing the browser said about calendars survives validation.
  assert.equal(result.vehicles[0].calendarId, undefined);
  assert.equal(JSON.stringify(result).includes('attacker-calendar'), false);
});

test('canonical client payload contains identifiers and reservation data only', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const result = validatePayload(payload({
    items: [{
      packageId: 'premium-detail',
      sizeId: 'sedan',
      addonIds: ['limpieza-motor'],
      vehicle: { make: 'Toyota', model: 'Camry', year: 2024, color: 'Blue', plate: 'ABC 123' }
    }],
    schedule: { date: DATE, timeWindow: '08:00', notes: 'Gate 4' }
  }));

  assert.equal(result.estimate.min, 215);
  assert.equal(result.deposit, 30);
  assert.equal(result.schedule.durationMinutes, 90);
  assert.deepEqual(result.vehicles[0].addonIds, ['limpieza-motor']);
});

test('a membership is detected from the package id, not from a request flag', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const result = validatePayload(payload({
    items: [{ ...item('membresia-2x', 'sedan'), isMembership: false }],
    schedule: { date: isoAt(30), timeWindow: '08:00', timeLabel: '', notes: '' }
  }));
  assert.equal(result.vehicles[0].isMembership, true);
  // 48 hours for memberships only; everything else keeps its one-hour notice.
  assert.equal(catalog.noticeMsForPackages(['membresia-2x']), 48 * 60 * 60 * 1000);
  assert.equal(catalog.noticeMsForPackages(['premium-detail']), 60 * 60 * 1000);
  assert.equal(catalog.noticeMsForPackages(['premium-detail', 'membresia-2x']), 48 * 60 * 60 * 1000);
});

test('a fifth vehicle is rejected with 422 even when the frontend is tampered with', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const five = payload({ items: Array.from({ length: 5 }, () => item('premium-detail', 'sedan')) });
  assert.throws(() => validatePayload(five), error => {
    assert.equal(error.statusCode, 422);
    assert.match(error.message, /at most 4 vehicles/);
    return true;
  });

  const res = await callHandler(quoteHandler, five);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'MAX_VEHICLES_EXCEEDED');
  // Rejected before anything was written or blocked.
  assert.equal(ctx.repository.__store().holds.length, 0);
  assert.equal(ctx.ghl.created.length, 0);
  assert.equal(ctx.ghl.calls.length, 0);

  // Four is still fine.
  const four = validatePayload(payload({ items: Array.from({ length: 4 }, () => item('premium-detail', 'sedan')) }));
  assert.equal(four.vehicles.length, 4);
});

test('per-vehicle services are reported and the visit is their sum plus one buffer', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const result = validatePayload(payload({
    items: [item('premium-detail', 'sedan'), item('semi-truck-wash', 'standard'), item('golf-premium', 'standard')]
  }));
  // One van works all three at the address: 60 + 90 + 30 of service, then a single
  // 30-minute travel buffer. Not a two-hour visit — three and a half.
  assert.deepEqual(result.schedule.perVehicleDurationMinutes, [60, 90, 30]);
  assert.equal(result.schedule.durationMinutes, 210);
  assert.equal(result.deposit, 50, 'the largest deposit any vehicle requires');
});

test('rejects start times off the grid, past the working day, or outside the window', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const at = timeWindow => payload({ schedule: { date: DATE, timeWindow, timeLabel: '', notes: '' } });
  assert.throws(() => validatePayload(at('08:20')), /timeWindow is invalid/i);
  assert.throws(() => validatePayload(at('25:00')), /timeWindow is invalid/i);
  // A 90-minute wash cannot start at 5pm and finish before 6pm.
  assert.throws(() => validatePayload(at('17:00')), /working day/i);
  assert.equal(validatePayload(at('16:30')).schedule.timeWindow, '16:30');
  assert.throws(() => validatePayload(payload({
    schedule: { date: isoAt(120), timeWindow: '08:00', timeLabel: '', notes: '' }
  })), /too far ahead/i);
  // TODO(remove-legacy-windows): open tabs still post the retired named windows.
  assert.equal(validatePayload(at('morning')).schedule.timeWindow, '08:00');
});

test('full-day packages take the working day and refuse a chosen start time', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const fullDay = payload({
    items: [item('paint-correction', 'sedan')],
    schedule: { date: DATE, timeWindow: 'full_day', timeLabel: '', notes: '' }
  });
  const result = validatePayload(fullDay);
  assert.equal(result.schedule.bookingMode, 'full_day');
  assert.equal(result.schedule.durationMinutes, 600);
  assert.equal(result.schedule.timeLabel, 'Full day (8am–6pm)');

  assert.throws(() => validatePayload({
    ...fullDay,
    schedule: { date: DATE, timeWindow: '10:00', timeLabel: '', notes: '' }
  }), /full_day/i);
});

test('legacy single-selection payloads still normalize to a one-vehicle cart', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const result = validatePayload(payload());
  assert.equal(result.vehicles.length, 1);
  assert.equal(result.vehicles[0].packageId, 'premium-detail');
  assert.equal(result.vehicles[0].descriptor.plate, 'ABC 123');
});

test('restricted add-ons are validated per vehicle against that vehicle package', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const heavy = (packageId, addonId, sizeId = 'standard') => payload({
    items: [{ ...item(packageId, sizeId), addons: [{ id: addonId, name: addonId, price: '$1' }] }]
  });

  assert.equal(validatePayload(heavy('car-hauler-wash', 'lubricante-grafito')).vehicles[0].addonIds[0], 'lubricante-grafito');
  assert.throws(() => validatePayload(heavy('trailer-wash', 'lubricante-grafito')), /invalid for this package/i);
  // Trailers and car haulers are towed units — no cab to clean.
  assert.equal(validatePayload(heavy('semi-truck-wash', 'limpieza-cabina')).vehicles[0].addonIds[0], 'limpieza-cabina');
  assert.equal(validatePayload(heavy('box-truck-wash', 'limpieza-cabina', 'size_10_16')).vehicles[0].addonIds[0], 'limpieza-cabina');
  for (const packageId of ['trailer-wash', 'trailer-2x', 'car-hauler-wash']) {
    assert.throws(() => validatePayload(heavy(packageId, 'limpieza-cabina')), /invalid for this package/i);
  }
  // A towed unit has no engine, so engine cleaning cannot be sold on one.
  assert.equal(validatePayload(heavy('semi-truck-wash', 'motor-pesado')).vehicles[0].addonIds[0], 'motor-pesado');
  assert.equal(validatePayload(heavy('dump-truck-wash', 'motor-pesado')).vehicles[0].addonIds[0], 'motor-pesado');
  for (const packageId of ['trailer-wash', 'trailer-4x', 'car-hauler-wash', 'car-hauler-2x']) {
    assert.throws(() => validatePayload(heavy(packageId, 'motor-pesado')), /invalid for this package/i);
  }

  // Aluminium fuel tanks hang off the tractor and nothing else.
  assert.equal(validatePayload(heavy('semi-truck-wash', 'pulido-tanques')).vehicles[0].addonIds[0], 'pulido-tanques');
  for (const packageId of ['trailer-wash', 'garbage-truck-wash', 'dump-truck-wash', 'car-hauler-wash']) {
    assert.throws(() => validatePayload(heavy(packageId, 'pulido-tanques')), /invalid for this package/i);
  }
  assert.throws(
    () => validatePayload(heavy('box-truck-wash', 'pulido-tanques', 'size_10_16')),
    /invalid for this package/i
  );

  // Waxing is not a heavy-truck service at all: no trailer or garbage truck gets
  // waxed, so the add-on does not exist in that category.
  for (const packageId of ['semi-truck-wash', 'trailer-wash', 'garbage-truck-wash', 'car-hauler-wash']) {
    assert.throws(() => validatePayload(heavy(packageId, 'cera-rapida')), /invalid for this category/i);
  }
  // It is still sold on cars, where somebody does actually wax by hand.
  assert.equal(
    validatePayload(payload({
      items: [{ ...item('premium-detail', 'sedan'), addons: [{ id: 'cera-rapida', name: 'Wax', price: '$20' }] }]
    })).vehicles[0].addonIds[0],
    'cera-rapida'
  );

  // An add-on from another category never applies.
  assert.throws(() => validatePayload(heavy('semi-truck-wash', 'boat-teca')), /invalid for this category/i);
});

test('car hauler packages, including the retired graphite ids, stay bookable and priced', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  for (const packageId of [
    'car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x',
    // TODO(remove-graphite): retired ids accepted during the transition window;
    // flip these to assert.throws when the window closes.
    'car-hauler-graphite-wash', 'car-hauler-graphite-2x', 'car-hauler-graphite-4x'
  ]) {
    const result = validatePayload(payload({ items: [item(packageId, 'standard')] }));
    assert.equal(result.vehicles[0].packageId, packageId);
    assert.equal(result.schedule.durationMinutes, 120);
    assert.ok(result.estimate.min > 0, `${packageId} must have a server-side price`);
  }
});

// ── The booking flow ───────────────────────────────────────────────────────

test('a booking holds the vans, records the CRM, and stays pending until payment', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const res = await callHandler(quoteHandler, payload({
    items: [item('premium-detail', 'sedan'), item('car-hauler-wash', 'standard')]
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // NOT confirmed: only a verified payment does that.
  assert.equal(res.body.appointmentStatus, 'pending_payment');
  assert.ok(res.body.holdId);
  assert.ok(res.body.expiresAt);
  assert.equal(res.body.holdMinutes, 15);
  // Two vehicles, one van, worked in sequence: the crew breakdown is the running
  // order at that address, all on the same van.
  assert.equal(res.body.crew.length, 2);
  assert.equal(new Set(res.body.crew.map(entry => entry.resource)).size, 1, 'one van per address');

  // The reservation exists in Postgres as parent + children + assignments.
  const store = ctx.repository.__store();
  assert.equal(store.holds.length, 1);
  assert.equal(store.holds[0].status, 'converted');
  // One assignment for the visit; the per-vehicle detail lives on the child bookings.
  assert.equal(store.assignments.length, 1);
  assert.equal(store.bookings.filter(booking => booking.parentBookingId).length, 2);
  store.bookings.forEach(booking => {
    assert.equal(booking.status, 'pending_payment');
    assert.equal(booking.contactId, 'contact-1');
    assert.equal(booking.submissionId, '123e4567-e89b-12d3-a456-426614174000');
  });

  // The CRM got a contact, an opportunity in the PENDING stage, and the one van
  // blocked for both vehicles.
  const blocks = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
  assert.equal(blocks.length, 1, 'ONE appointment for the visit — the crew arrives once');
  assert.ok(CALENDARS.includes(blocks[0].calendarId));
  // One assignment row, which is what keeps booking_assignments_resource_unique
  // satisfied without migration 004.
  assert.equal(ctx.repository.__store().assignments.length, 1);
  const opportunity = ctx.ghl.created.find(entry => entry.kind === 'opportunity');
  assert.equal(opportunity.body.pipelineStageId, 'stage-pending');
  // The van is blocked on its own calendar, not on a round-robin calendar.
  blocks.forEach(block => assert.ok(CALENDARS.includes(block.calendarId)));
});

test('the opportunity records the server price, the hold and the crew breakdown', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  await callHandler(quoteHandler, payload());
  const update = ctx.ghl.created.filter(entry => entry.kind === 'opportunity-update').pop();
  const values = new Map(update.body.customFields.map(field => [field.id, field.fieldValue]));

  assert.equal(values.get('field-bookingStatus'), 'pending_payment');
  assert.equal(values.get('field-estimate'), 'From $215');
  assert.equal(values.get('field-deposit'), '$30');
  assert.equal(values.get('field-duration'), '1h 30m');
  assert.match(values.get('field-crewAssignments'), /#1 camioneta_\d 08:00–09:00/);
  assert.ok(values.get('field-holdId'));
});

test('a booking adopts a hold the browser already owns, and refuses a mismatched one', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const holdsHandler = require('../api/bookings/holds.js');
  const held = await callHandler(holdsHandler, {
    date: DATE,
    startTime: '08:00',
    vehicles: [{
      packageId: 'premium-detail', sizeId: 'sedan', addonIds: ['limpieza-motor'],
      vehicle: { make: 'Toyota', model: 'Camry', year: 2024 }
    }],
    // A hold is an appointment now, so it carries the contact it belongs to.
    customer: payload().customer
  }, { headers: { 'idempotency-key': 'adopt-00000001' } });
  assert.equal(held.statusCode, 201);

  const adopted = await callHandler(quoteHandler, payload({ holdId: held.body.holdId }));
  assert.equal(adopted.statusCode, 200);
  assert.equal(adopted.body.holdId, held.body.holdId);
  // Adopting must not take a second set of vans.
  assert.equal(ctx.repository.__store().assignments.length, 1);

  // Holding a cheap wash and then submitting an expensive one is refused.
  const swapped = await callHandler(quoteHandler, payload({
    holdId: held.body.holdId,
    submissionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    items: [item('boat-detail', 'boat_41_60')],
    schedule: { date: DATE, timeWindow: '08:00', timeLabel: '', notes: '' }
  }));
  assert.equal(swapped.statusCode, 409);
  assert.match(swapped.body.error, /does not match/);
});

test('a resubmitted form reuses the first hold instead of taking more vans', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const first = await callHandler(quoteHandler, payload());
  const second = await callHandler(quoteHandler, payload());

  assert.equal(first.body.holdId, second.body.holdId);
  assert.equal(ctx.repository.__store().holds.length, 1);
  assert.equal(ctx.repository.__store().assignments.length, 1);
});

test('a booking is refused when the fleet is already full at that hour', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  // All four vans are booked by hand in the CRM for the morning.
  const startMs = Date.parse(`${DATE}T12:00:00.000Z`);
  CALENDARS.forEach(calendarId => {
    ctx.ghl.calendarEvents[calendarId] = [{ start: startMs, end: startMs + 4 * 3600_000 }];
  });

  const res = await callHandler(quoteHandler, payload());
  assert.equal(res.statusCode, 409);
  assert.equal(ctx.repository.__store().holds.length, 0);
});

test('the honeypot short-circuits before any CRM or database write', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const res = await callHandler(quoteHandler, payload({ website: 'http://spam.example' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.holdId, undefined);
  assert.equal(ctx.ghl.calls.length, 0);
  assert.equal(ctx.repository.__store().holds.length, 0);
});

test('cross-origin and wrong methods fail, while CRM configuration cannot block a local quote', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const crossOrigin = await callHandler(quoteHandler, payload(), {
    headers: { origin: 'https://evil.example', host: 'lyb.test' }
  });
  assert.equal(crossOrigin.statusCode, 403);

  const wrongMethod = await callHandler(quoteHandler, payload(), { method: 'GET' });
  assert.equal(wrongMethod.statusCode, 405);

  // A missing calendar prevents holds, but a quote still returns its local
  // server-authoritative pricing instead of turning into a CRM 5xx.
  delete process.env.GHL_CALENDAR_CAMIONETA_3;
  const unconfigured = await callHandler(quoteHandler, payload());
  assert.equal(unconfigured.statusCode, 200);
  assert.equal(unconfigured.body.syncPending, true);
  assert.equal(unconfigured.body.estimate.label, 'From $215');
  assert.equal(ctx.repository.__store().holds.length, 0);
});

test('a duplicate crew calendar cannot block a local quote response', async t => {
  const ctx = fresh({ env: { GHL_CALENDAR_CAMIONETA_2: 'cal-van-1' } });
  t.after(() => ctx.restore());

  const res = await callHandler(quoteHandler, payload());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.syncPending, true);
  assert.equal(ctx.repository.__store().holds.length, 0);
});

test('upstream HighLevel failures leave a safe local quote available', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  for (const upstream of [401, 403, 429, 500]) {
    resetMetadataCache();
    ctx.ghl.failures['GET /opportunities/pipelines'] = upstream;
    // The pipeline ids are configured, so force the lookup path that fails.
    delete process.env.GHL_PIPELINE_ID;
    const res = await callHandler(quoteHandler, payload());
    assert.equal(res.statusCode, 200, `upstream ${upstream} must not block the quote`);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.syncPending, true);
    assert.equal(res.body.deposit, 30);
    process.env.GHL_PIPELINE_ID = 'pipe-1';
  }
});

test('a timed-out calendar read is retried, but a failed write never is', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  // (A) A GET that times out once is retried, so a burst of bookings survives
  // transient HighLevel slowness.
  const realFetch = globalThis.fetch;
  let calendarReads = 0;
  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    if (method === 'GET' && String(url).includes('/calendars/events?')) {
      calendarReads += 1;
      if (calendarReads === 1) {
        const timeout = new Error('simulated timeout');
        timeout.name = 'TimeoutError';
        throw timeout;
      }
    }
    return realFetch(url, options);
  };
  const ok = await callHandler(quoteHandler, payload());
  assert.equal(ok.statusCode, 200);
  assert.ok(calendarReads >= 2, 'the timed-out calendar read should have been retried');

  // (B) A write that fails is surfaced immediately: a timed-out write may already
  // have landed upstream, so retrying it could block a van twice.
  const ctx2 = fresh();
  t.after(() => ctx2.restore());
  let blockPosts = 0;
  const stubFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    // The hold reserves the van with an APPOINTMENT now, not a block slot.
    if (String(url).endsWith('/calendars/events/appointments') && (options.method || 'GET').toUpperCase() === 'POST') {
      blockPosts += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return stubFetch(url, options);
  };
  const failed = await callHandler(quoteHandler, payload());
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.body.syncPending, true);
  assert.equal(blockPosts, 1, 'a failed write must not be auto-retried');
  // And the reservation was compensated rather than left half-created.
  assert.equal(ctx2.repository.__store().holds[0].status, 'failed');
});

// ── Deposits ───────────────────────────────────────────────────────────────

test('with deposits on, the invoice charges the server-computed amount', async t => {
  const ctx = fresh({ env: { GHL_DEPOSIT_PAYMENTS: 'on' } });
  t.after(() => ctx.restore());

  const res = await callHandler(quoteHandler, payload({
    items: [item('semi-truck-wash', 'standard')],
    // A forged deposit in the body must not reach the invoice.
    deposit: 1
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.depositUrl, 'https://pay.example/invoice-1');
  const invoice = ctx.ghl.created.find(entry => entry.kind === 'invoice');
  assert.equal(invoice.body.items[0].amount, 50);
  assert.equal(invoice.body.liveMode, false, 'test mode unless GHL_DEPOSIT_LIVE_MODE=true');
  // The hold id travels with the invoice so the payment webhook can find it.
  assert.match(invoice.body.name, new RegExp(`hold:${res.body.holdId}`));
});

test('GHL_DEPOSIT_LIVE_MODE=true charges through Stripe live mode', async t => {
  const ctx = fresh({ env: { GHL_DEPOSIT_PAYMENTS: 'on', GHL_DEPOSIT_LIVE_MODE: 'true' } });
  t.after(() => ctx.restore());

  await callHandler(quoteHandler, payload());
  assert.equal(ctx.ghl.created.find(entry => entry.kind === 'invoice').body.liveMode, true);
});

test('with deposits off, no payment call is made and no deposit fields are written', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const res = await callHandler(quoteHandler, payload());
  assert.equal(res.body.depositUrl, undefined);
  assert.equal(ctx.ghl.calls.some(call => call.path === '/invoices/text2pay'), false);

  const update = ctx.ghl.created.filter(entry => entry.kind === 'opportunity-update').pop();
  const ids = update.body.customFields.map(field => field.id);
  assert.equal(ids.includes('field-depositStatus'), false);
  assert.equal(ids.includes('field-depositLink'), false);
});

test('a failed deposit invoice never destroys the reservation', async t => {
  const ctx = fresh({
    env: { GHL_DEPOSIT_PAYMENTS: 'on' },
    failures: { 'POST /invoices/text2pay': 500 }
  });
  t.after(() => ctx.restore());

  const res = await callHandler(quoteHandler, payload());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.depositUrl, undefined);
  assert.equal(res.body.appointmentStatus, 'pending_payment');
  // The vans are still held; the office can invoice by hand.
  assert.equal(ctx.repository.__store().assignments[0].status, 'held');
});

test('a location missing the deposit fields fails closed once deposits are on', async t => {
  // Simulate a sub-account that has not re-run scripts/setup-ghl.mjs.
  const withoutDepositFields = Object.entries(OPPORTUNITY_FIELDS)
    .filter(([key]) => key !== 'depositStatus' && key !== 'depositLink')
    .map(([key, name]) => ({ id: `field-${key}`, name, model: 'opportunity' }));

  const off = fresh({ customFields: withoutDepositFields });
  const stillWorks = await callHandler(quoteHandler, payload());
  assert.equal(stillWorks.statusCode, 200, 'deposits off: the missing fields are optional');
  off.restore();

  const on = fresh({ customFields: withoutDepositFields, env: { GHL_DEPOSIT_PAYMENTS: 'on' } });
  t.after(() => on.restore());
  const res = await callHandler(quoteHandler, payload());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.syncPending, true);
  assert.equal(on.repository.__store().holds.length, 0, 'no van is held when the CRM is not ready');
});

test('a valid canonical quote is local when HighLevel is unavailable', async t => {
  const ctx = fresh({ env: { GHL_PRIVATE_TOKEN: null } });
  t.after(() => ctx.restore());

  const res = await callHandler(quoteHandler, payload({
    items: [{
      packageId: 'premium-detail', sizeId: 'sedan', addonIds: ['limpieza-motor'],
      vehicle: { make: 'Toyota', model: 'Camry', year: 2024, color: 'Blue', plate: 'ABC 123' }
    }]
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.syncPending, true);
  assert.equal(res.body.estimate.label, 'From $215');
  assert.equal(res.body.deposit, 30);
  assert.equal(ctx.ghl.calls.length, 0);
});

test('empty and invalid carts return 422 before CRM or calendar initialization', async t => {
  const ctx = fresh({ env: { GHL_PRIVATE_TOKEN: null, DATABASE_URL: null } });
  t.after(() => ctx.restore());

  const empty = await callHandler(quoteHandler, payload({ items: [] }));
  assert.equal(empty.statusCode, 422);
  assert.equal(empty.body.code, 'REQUEST_INVALID');

  const invalidPackage = await callHandler(quoteHandler, payload({
    items: [{ packageId: 'not-in-catalog', sizeId: 'sedan', addonIds: [], vehicle: { make: 'Toyota', model: 'Camry', year: 2024 } }]
  }));
  assert.equal(invalidPackage.statusCode, 422);
  assert.equal(ctx.ghl.calls.length, 0);
  assert.equal(ctx.repository.__store().holds.length, 0);
});

// ── Confirmation ───────────────────────────────────────────────────────────

test('the payment webhook is the only door to a confirmed booking', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const booked = await callHandler(quoteHandler, payload());
  const webhookHandler = require('../api/payments/webhook.js');

  const unauthorized = await callHandler(webhookHandler, {
    type: 'InvoicePaid', id: 'evt-1', holdId: booked.body.holdId
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(ctx.repository.__store().holds[0].status, 'converted');

  const authorized = await callHandler(webhookHandler, {
    type: 'InvoicePaid', id: 'evt-1', holdId: booked.body.holdId, amount: 30
  }, { headers: { authorization: 'Bearer webhook-secret' } });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.body.confirmed, true);
  assert.equal(ctx.repository.__store().holds[0].status, 'confirmed');

  // An event type we do not act on is acknowledged, not retried forever.
  const ignored = await callHandler(webhookHandler, {
    type: 'ContactCreated', id: 'evt-2', holdId: booked.body.holdId
  }, { headers: { authorization: 'Bearer webhook-secret' } });
  assert.equal(ignored.statusCode, 200);
  assert.equal(ignored.body.ignored, true);
});

test('the payment webhook can find the reservation by submission id', async t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const booked = await callHandler(quoteHandler, payload());
  assert.equal(booked.body.appointmentStatus, 'pending_payment');

  const res = await callHandler(require('../api/payments/webhook.js'), {
    type: 'InvoicePaid', id: 'evt-sub', submissionId: '123e4567-e89b-12d3-a456-426614174000', amount: 30
  }, { headers: { authorization: 'Bearer webhook-secret' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.confirmed, true);
  assert.equal(ctx.repository.__store().holds[0].status, 'confirmed');
});

test('opportunityValues emits nothing for a booking that has no hold yet', t => {
  const ctx = fresh();
  t.after(() => ctx.restore());

  const values = opportunityValues(validatePayload(payload()), null);
  assert.equal(values.bookingStatus, 'pending_payment');
  assert.equal(values.holdId, '');
  assert.equal(values.confirmedStart, '');
  assert.equal(values.appointmentId, '');
});

test('the time helpers stay exact across a daylight-saving boundary', () => {
  assert.equal(time.zonedDateTimeToIso('2026-07-15', '08:00'), '2026-07-15T12:00:00.000Z');
  assert.equal(time.zonedDateTimeToIso('2026-12-01', '08:00'), '2026-12-01T13:00:00.000Z');
  assert.equal(time.minutesFromTime('09:30'), 570);
  assert.equal(time.timeFromMinutes(570), '09:30');
  assert.equal(time.isValidDateOnly('2026-02-30'), false);
});
