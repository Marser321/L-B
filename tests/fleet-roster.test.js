'use strict';

// Turning a van on and off from the CRM.
//
// The four vans are configured in the environment and that does not change day to day.
// Whether a van is WORKING is an operational decision — a driver is sick, the business
// opens with one van and adds the rest as volume grows — and it belongs to the office,
// in HighLevel, with no developer and no redeploy. Deactivating a van's calendar is
// that switch.
//
// What these tests pin down is the blast radius: an inactive van stops being SOLD, and
// nothing else about it changes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupAgenda, callHandler, nextWeekday, CALENDARS } = require('./support/harness.js');

const holdsHandler = require('../api/bookings/holds.js');
const availabilityHandler = require('../api/availability.js');
const ghl = require('../api/_lib/ghl.js');

const DATE = nextWeekday(7);

function car(index = 0) {
  return {
    packageId: 'premium-detail', sizeId: 'sedan', addonIds: [],
    vehicle: { make: 'Toyota', model: `Camry${index}`, year: 2024 }
  };
}

function holdRequest({ startTime = '09:00' } = {}) {
  return {
    date: DATE,
    startTime,
    vehicles: [car()],
    customer: {
      name: 'Jane Driver',
      phone: '(239) 555-0100',
      email: 'jane@example.com',
      address: '1234 Palm Ave',
      city: 'Fort Myers',
      zip: '33901'
    }
  };
}

test('a van switched off in the CRM is never sold', async t => {
  // The opening-day configuration: one van working, three waiting for volume.
  const ctx = setupAgenda({ inactiveCalendars: CALENDARS.slice(0, 3) });
  t.after(() => ctx.restore());

  const res = await callHandler(holdsHandler, holdRequest(), { headers: { 'idempotency-key': 'roster-000000001' } });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.assignments[0].resource, 'camioneta_4');
  const appointments = ctx.ghl.created.filter(entry => entry.kind === 'appointment');
  assert.equal(appointments.length, 1);
  assert.equal(appointments[0].calendarId, CALENDARS[3], 'the only working van took the visit');
});

test('switching vans off shrinks capacity — the second customer at that hour is refused, not double-booked', async t => {
  const ctx = setupAgenda({ inactiveCalendars: CALENDARS.slice(0, 3) });
  t.after(() => ctx.restore());

  const first = await callHandler(holdsHandler, holdRequest(), { headers: { 'idempotency-key': 'roster-000000002' } });
  assert.equal(first.statusCode, 201);

  // With four vans this is a routine second booking. With one, there is nowhere to put
  // it, and the customer has to be told so.
  const second = await callHandler(holdsHandler, holdRequest(), { headers: { 'idempotency-key': 'roster-000000003' } });
  assert.equal(second.statusCode, 409);
  assert.equal(ctx.ghl.created.filter(entry => entry.kind === 'appointment').length, 1);
});

test('with every van switched off the calendar is simply empty, and a hold is a clean refusal', async t => {
  const ctx = setupAgenda({ inactiveCalendars: CALENDARS });
  t.after(() => ctx.restore());

  const availability = await callHandler(availabilityHandler, {
    from: DATE, to: DATE, vehicles: [{ packageId: 'premium-detail' }]
  });

  // Not an error: a week with nobody working looks exactly like a week that sold out.
  assert.equal(availability.statusCode, 200);
  const offered = (availability.body.dates || []).reduce((total, day) => total + day.slots.length, 0);
  assert.equal(offered, 0, 'no van working means no start times on offer');

  const res = await callHandler(holdsHandler, holdRequest(), { headers: { 'idempotency-key': 'roster-000000004' } });
  assert.equal(res.statusCode, 409, 'refused, not a 500');
  assert.equal(ctx.ghl.created.length, 0);
});

test('an unreadable roster keeps the WHOLE fleet in play', async t => {
  // Failing closed here would stop the business dead while every dashboard looks
  // healthy — the failure nobody notices until the day is over. So a CRM read error
  // means "assume everyone is working", which at worst books a van that is off and at
  // best changes nothing.
  const ctx = setupAgenda({ failures: { 'GET /calendars/': 502 } });
  t.after(() => ctx.restore());

  const res = await callHandler(holdsHandler, holdRequest(), { headers: { 'idempotency-key': 'roster-000000005' } });

  assert.equal(res.statusCode, 201);
  assert.ok(CALENDARS.includes(ctx.ghl.created.find(entry => entry.kind === 'appointment').calendarId));
});

test('the roster filters what is offered without editing the caller config', async t => {
  // Membership credits are counted from appointments across the WHOLE fleet, including
  // vans switched off since the visit happened. That only stays true while filtering
  // returns a new config instead of mutating the shared one.
  const ctx = setupAgenda({ inactiveCalendars: [CALENDARS[1]] });
  t.after(() => ctx.restore());

  const config = ghl.getConfig();
  const filtered = await ghl.withActiveResources(config);

  assert.equal(config.resources.length, 4, 'the caller still sees every configured van');
  assert.deepEqual(filtered.resources.map(resource => resource.key), [
    'camioneta_1', 'camioneta_3', 'camioneta_4'
  ]);
});
