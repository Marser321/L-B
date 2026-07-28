'use strict';

// The membership SQL against a REAL Postgres.
//
// tests/memberships.test.js proves the business rules; this proves the schema that
// backs them — above all the two constraints that carry meaning rather than
// hygiene: one open visit per contract, and one notification per fact.
//
//   DATABASE_URL=postgres://localhost/lyb_test npm run migrate
//   DATABASE_URL=postgres://localhost/lyb_test npm test
//
// It TRUNCATEs the membership tables, so never aim it at production.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const describe = DATABASE_URL ? test : test.skip;

const { installEnv } = require('./support/harness.js');
const { priceMapRows } = require('./support/stripe-fixtures.js');

async function withPg(fn) {
  installEnv({ DATABASE_URL });
  const { setRepositoryForTests, getRepository } = require('../api/_lib/repository.js');
  setRepositoryForTests(null);
  const db = require('../api/_lib/db.js');

  await db.query(`
    truncate table
      highlevel_sync_state, notification_deliveries, stripe_events,
      membership_visits, membership_contracts, membership_checkout_sessions,
      membership_customers, membership_price_map
    restart identity cascade
  `);
  await db.query('delete from membership_credit_ledger');

  return fn({ db, repository: getRepository() });
}

describe('pg: the membership schema and its constraints exist', async () => {
  await withPg(async ({ db }) => {
    const { rows } = await db.query(`
      select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('membership_price_map','membership_customers','membership_checkout_sessions',
                            'membership_contracts','membership_visits','stripe_events',
                            'notification_deliveries','highlevel_sync_state')
    `);
    assert.equal(rows.length, 8, 'run `npm run migrate` against DATABASE_URL first');

    const indexes = await db.query(`
      select indexname from pg_indexes
       where tablename = 'membership_visits' and indexname = 'membership_visits_one_open'
    `);
    assert.equal(indexes.rows.length, 1, 'the one-open-visit index must exist');

    // Migration 002 relaxes contact_id so a membership credit (which has a
    // contract, not a contact) can be written.
    const column = await db.query(`
      select is_nullable from information_schema.columns
       where table_name = 'membership_credit_ledger' and column_name = 'contact_id'
    `);
    assert.equal(column.rows[0].is_nullable, 'YES');
  });
});

describe('pg: the price map round-trips all 33 prices', async () => {
  await withPg(async ({ db, repository }) => {
    const rows = priceMapRows(false);
    assert.equal(rows.length, 33);
    await repository.transaction(['seed'], async tx => tx.upsertPriceMapEntries(rows));

    const stored = await repository.listPriceMap(false);
    assert.equal(stored.length, 33);

    const sedan = await repository.getPriceMapEntry('membresia-2x', 'sedan', false);
    assert.equal(sedan.monthlyCents, 13000);
    assert.equal(sedan.creditsPerCycle, 2);

    // Re-running the provisioner updates in place rather than duplicating.
    await repository.transaction(['seed'], async tx => tx.upsertPriceMapEntries(rows));
    const { rows: count } = await db.query('select count(*)::int as n from membership_price_map');
    assert.equal(count[0].n, 33);
  });
});

describe('pg: Postgres itself refuses a second open visit for one contract', async () => {
  await withPg(async ({ db, repository }) => {
    const customerId = crypto.randomUUID();
    const contractId = crypto.randomUUID();
    const now = new Date();
    const later = new Date(now.getTime() + 7 * 86400000);

    await db.query(
      `insert into membership_customers (id, stripe_customer_id, livemode, email, name)
       values ($1, $2, false, 'pg@example.com', 'PG Test')`,
      [customerId, `cus_pg_${contractId.slice(0, 8)}`]
    );
    await db.query(
      `insert into membership_contracts (
         id, customer_id, stripe_subscription_id, stripe_subscription_item_id, stripe_price_id,
         line_index, package_id, size_id, monthly_cents, credits_per_cycle, credits_remaining,
         status, vehicle, vehicle_label
       ) values ($1,$2,'sub_pg','si_pg','price_pg',0,'membresia-4x','sedan',20000,4,4,'active','{}','Test Car')`,
      [contractId, customerId]
    );

    const insertVisit = status => db.query(
      `insert into membership_visits (id, contract_id, scheduled_start, scheduled_end, status)
       values ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), contractId, later, new Date(later.getTime() + 3600000), status]
    );

    await insertVisit('confirmed');
    // Four credits remain, so this is not about credits: the schema forbids a
    // second OPEN visit outright.
    await assert.rejects(insertVisit('held'), error => {
      assert.equal(error.code, '23505');
      assert.match(error.constraint || '', /membership_visits_one_open/);
      return true;
    });

    // A closed visit does not block the next booking.
    await db.query("update membership_visits set status = 'completed' where contract_id = $1", [contractId]);
    await insertVisit('held');
    const { rows } = await db.query(
      "select count(*)::int as n from membership_visits where contract_id = $1 and status in ('held','confirmed')",
      [contractId]
    );
    assert.equal(rows[0].n, 1);
  });
});

describe('pg: a notification dedupe key can only be claimed once', async () => {
  await withPg(async ({ db, repository }) => {
    const claim = () => repository.transaction(['notify'], async tx => tx.insertNotification({
      id: crypto.randomUUID(),
      dedupeKey: 'booking:pg-parent:confirmed',
      channel: 'sms',
      template: 'booking_confirmed',
      recipient: '+12395550100',
      context: { parentBookingId: 'pg-parent' }
    }));

    assert.equal((await claim()).inserted, true);
    assert.equal((await claim()).inserted, false);
    assert.equal((await claim()).inserted, false);

    const { rows } = await db.query('select count(*)::int as n from notification_deliveries');
    assert.equal(rows[0].n, 1, 'three attempts, one message');
  });
});

describe('pg: a Stripe event id can only be recorded once', async () => {
  await withPg(async ({ db, repository }) => {
    const record = () => repository.transaction(['event'], async tx => tx.insertStripeEvent({
      id: 'evt_pg_dup', type: 'invoice.paid', livemode: false, apiVersion: '2024-06-20', payload: {}
    }));
    assert.equal((await record()).inserted, true);
    assert.equal((await record()).inserted, false);
    const { rows } = await db.query('select count(*)::int as n from stripe_events');
    assert.equal(rows[0].n, 1);
  });
});

test.after(async () => {
  if (!DATABASE_URL) return;
  await require('../api/_lib/db.js').close();
});
