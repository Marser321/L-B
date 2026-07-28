'use strict';

// The same guarantees as tests/agenda.test.js, but against a REAL Postgres.
//
// tests/agenda.test.js proves the algorithm; this file proves the SQL and the
// database constraints that back it — the advisory lock, `for update`, and above
// all the `no_overlapping_assignments` exclusion constraint, which is the thing
// that makes a double-booked van impossible rather than merely unlikely.
//
// Skipped unless a throwaway database is pointed at it:
//
//   DATABASE_URL=postgres://localhost/lyb_test npm run migrate
//   DATABASE_URL=postgres://localhost/lyb_test node --test tests/
//
// It TRUNCATEs the agenda tables between tests, so never aim it at production.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const describe = DATABASE_URL ? test : test.skip;

const { installEnv, createGhlStub, callHandler, nextWeekday } = require('./support/harness.js');

const DATE = nextWeekday(7);

function vehicle(index = 0) {
  return {
    packageId: 'premium-detail', sizeId: 'sedan', addonIds: [],
    vehicle: { make: 'Toyota', model: `Camry${index}`, year: 2024 }
  };
}

async function withPg(fn) {
  // installEnv blanks DATABASE_URL for the in-memory suite; put it back first.
  installEnv({ DATABASE_URL });
  const { setRepositoryForTests } = require('../api/_lib/repository.js');
  setRepositoryForTests(null);
  const db = require('../api/_lib/db.js');

  await db.query(`
    truncate table
      membership_credit_ledger, payment_events, hold_allocations,
      booking_assignments, bookings, booking_holds
    restart identity cascade
  `);
  await db.query("update resource_rotation set cursor_position = 0 where id = 'vans'");

  const ghl = createGhlStub();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ghl.fetchStub;
  try {
    return await fn({ db, ghl: ghl.state });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('pg: the schema and its constraints are in place', async () => {
  await withPg(async ({ db }) => {
    const { rows } = await db.query(`
      select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('booking_holds','hold_allocations','bookings',
                            'booking_assignments','resource_rotation',
                            'membership_credit_ledger','payment_events','resources')
    `);
    assert.equal(rows.length, 8, 'run `npm run migrate` against DATABASE_URL first');

    const constraint = await db.query(`
      select conname from pg_constraint where conname = 'no_overlapping_assignments'
    `);
    assert.equal(constraint.rows.length, 1, 'the van-overlap exclusion constraint must exist');

    const vans = await db.query('select key from resources order by position');
    assert.deepEqual(vans.rows.map(row => row.key), ['camioneta_1', 'camioneta_2', 'camioneta_3', 'camioneta_4']);
  });
});

describe('pg: Postgres itself refuses to double-book a van', async () => {
  await withPg(async ({ db }) => {
    const holdsHandler = require('../api/bookings/holds.js');
    const held = await callHandler(holdsHandler, {
      date: DATE, startTime: '09:00', vehicles: [vehicle()]
    }, { headers: { 'idempotency-key': `pg-overlap-${crypto.randomUUID()}` } });
    assert.equal(held.statusCode, 201);

    const { rows } = await db.query('select * from booking_assignments limit 1');
    const existing = rows[0];

    // A hand-written insert that overlaps the same van by one minute must be
    // rejected by the database, not merely by the application.
    await assert.rejects(
      db.query(
        `insert into booking_assignments (
           id, booking_id, parent_booking_id, resource_key, vehicle_index, vehicle_label,
           package_id, duration_minutes, starts_at, ends_at, calendar_id, status
         ) values ($1, $2, $3, $4, 99, 'intruder', 'premium-detail', 90,
                   $5::timestamptz - interval '1 minute', $6, 'cal-x', 'held')`,
        [
          crypto.randomUUID(), crypto.randomUUID(), existing.parent_booking_id,
          existing.resource_key, existing.ends_at, existing.ends_at
        ]
      ),
      error => {
        // 23P01 = exclusion_violation, or 23503 if the fake booking_id FK trips first.
        assert.ok(['23P01', '23503'].includes(error.code), `unexpected error ${error.code}`);
        return true;
      }
    );
  });
});

describe('pg: two concurrent requests for the whole fleet leave exactly one winner', async () => {
  await withPg(async ({ db }) => {
    const holdsHandler = require('../api/bookings/holds.js');
    const request = {
      date: DATE, startTime: '10:00',
      vehicles: [vehicle(0), vehicle(1), vehicle(2), vehicle(3)]
    };

    const [first, second] = await Promise.all([
      callHandler(holdsHandler, request, { headers: { 'idempotency-key': `pg-race-a-${crypto.randomUUID()}` } }),
      callHandler(holdsHandler, request, { headers: { 'idempotency-key': `pg-race-b-${crypto.randomUUID()}` } })
    ]);

    assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);

    const assignments = await db.query("select * from booking_assignments where status = 'held'");
    assert.equal(assignments.rows.length, 4, 'the loser must leave nothing behind');
    assert.equal(new Set(assignments.rows.map(row => row.resource_key)).size, 4);

    const holds = await db.query('select status from booking_holds');
    assert.equal(holds.rows.filter(row => row.status === 'active').length, 1);
  });
});

describe('pg: the rotation cursor is persisted and advances across requests', async () => {
  await withPg(async ({ db }) => {
    const holdsHandler = require('../api/bookings/holds.js');
    const picked = [];
    for (const [index, startTime] of ['09:00', '11:00', '13:00'].entries()) {
      const res = await callHandler(holdsHandler, {
        date: DATE, startTime, vehicles: [vehicle(index)]
      }, { headers: { 'idempotency-key': `pg-rotate-${index}-${crypto.randomUUID()}` } });
      assert.equal(res.statusCode, 201);
      picked.push(res.body.assignments[0].resource);
    }

    assert.deepEqual(picked, ['camioneta_1', 'camioneta_2', 'camioneta_3']);
    const cursor = await db.query("select cursor_position from resource_rotation where id = 'vans'");
    assert.equal(cursor.rows[0].cursor_position, 3);
  });
});

describe('pg: an expired hold is released and its rows are freed', async () => {
  await withPg(async ({ db }) => {
    const agenda = require('../api/_lib/agenda.js');
    const holdsHandler = require('../api/bookings/holds.js');

    const held = await callHandler(holdsHandler, {
      date: DATE, startTime: '14:00', vehicles: [vehicle(0), vehicle(1)]
    }, { headers: { 'idempotency-key': `pg-expire-${crypto.randomUUID()}` } });
    assert.equal(held.statusCode, 201);

    const swept = await agenda.releaseExpiredHolds({
      now: Date.parse(held.body.expiresAt) + 1000,
      config: require('../api/_lib/ghl.js').getConfig()
    });
    assert.equal(swept.released, 1);

    const live = await db.query("select * from booking_assignments where status in ('held','confirmed')");
    assert.equal(live.rows.length, 0);
    const hold = await db.query('select status from booking_holds');
    assert.equal(hold.rows[0].status, 'expired');
  });
});

describe('pg: membership credits are idempotent under a replayed webhook', async () => {
  await withPg(async ({ db }) => {
    const agenda = require('../api/_lib/agenda.js');
    const holdsHandler = require('../api/bookings/holds.js');

    const held = await callHandler(holdsHandler, {
      date: nextWeekday(10), startTime: '09:00',
      vehicles: [{
        packageId: 'membresia-4x', sizeId: 'sedan', addonIds: [],
        vehicle: { make: 'Honda', model: 'Civic', year: 2023 }
      }]
    }, { headers: { 'idempotency-key': `pg-credit-${crypto.randomUUID()}` } });
    assert.equal(held.statusCode, 201);

    await agenda.attachCustomer({
      holdId: held.body.holdId, submissionId: `sub-${crypto.randomUUID()}`,
      contactId: 'contact-pg', customer: { name: 'Member' }
    });

    const eventId = `evt-${crypto.randomUUID()}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await agenda.confirmPayment({
        provider: 'highlevel', externalEventId: eventId, eventType: 'InvoicePaid',
        outcome: 'paid', holdId: held.body.holdId
      });
    }

    const ledger = await db.query('select delta from membership_credit_ledger where contact_id = $1', ['contact-pg']);
    assert.equal(ledger.rows.length, 1, 'three identical webhooks must credit once');
    assert.equal(ledger.rows[0].delta, 4);

    const events = await db.query('select * from payment_events');
    assert.equal(events.rows.length, 1);
  });
});

test.after(async () => {
  if (!DATABASE_URL) return;
  await require('../api/_lib/db.js').close();
});
