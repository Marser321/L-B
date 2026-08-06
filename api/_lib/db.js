'use strict';

const { RequestError } = require('./errors.js');
const { databaseConnectionString } = require('./database-url.js');

// Thin Postgres access layer.
//
// `pg` is required LAZILY, and only when DATABASE_URL is set. That keeps the test
// suite (which runs against the in-memory repository) and any deployment that has
// not been pointed at a database yet from needing node_modules at all, while a
// configured deployment gets a real pooled connection.

let pool = null;
let pgModule = null;

function isConfigured() {
  return Boolean(String(process.env.DATABASE_URL || '').trim());
}

function requirePg() {
  if (pgModule) return pgModule;
  try {
    pgModule = require('pg');
  } catch (error) {
    throw new RequestError('Database driver is not installed', 503);
  }
  return pgModule;
}

function getPool() {
  if (pool) return pool;
  if (!isConfigured()) throw new RequestError('Booking database is not configured', 503, 'DATABASE_NOT_CONFIGURED');
  const { Pool } = requirePg();
  pool = new Pool({
    connectionString: databaseConnectionString(),
    // A serverless invocation runs one request; a small pool is plenty and keeps
    // us well under the provider's connection ceiling when many instances are warm.
    max: Number(process.env.DATABASE_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // Statement-level ceiling so a lock we failed to release can't wedge an
    // instance for the whole function timeout.
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 8_000)
  });
  pool.on('error', error => console.error('[db-pool]', error.name || 'Error', error.message));
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

// Runs `fn` inside a single transaction. `lockKeys` are taken with
// pg_advisory_xact_lock BEFORE any reads, in sorted order so two transactions
// that need the same pair of keys can never deadlock against each other. The lock
// is released by COMMIT/ROLLBACK — there is no path that leaks it.
async function withTransaction(lockKeys, fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const key of [...lockKeys].sort()) {
      await client.query("select pg_advisory_xact_lock(hashtext('lyb:agenda'), hashtext($1))", [key]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('[db-rollback]', rollbackError.name || 'Error', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

// Postgres error codes we translate into domain outcomes.
const PG_UNIQUE_VIOLATION = '23505';
const PG_EXCLUSION_VIOLATION = '23P01';
const PG_UNDEFINED_TABLE = '42P01';

function isUniqueViolation(error) {
  return Boolean(error) && error.code === PG_UNIQUE_VIOLATION;
}

// Raised by the no_overlapping_assignments exclusion constraint: another
// transaction took this van for an overlapping window. Always a lost race, never
// a bug in the caller's input.
function isOverlapViolation(error) {
  return Boolean(error) && error.code === PG_EXCLUSION_VIOLATION;
}

// The table this query needs does not exist — the schema is behind the code.
//
// It is called out separately because one feature is allowed to survive it. The
// payment-link ledger is a convenience (idempotency and an audit row), not the
// thing that takes the money, and treating its absence as a hard failure is what
// silently removed the deposit link from every website booking after migration 003
// shipped but was never applied: the customer finished the wizard and was told
// payment was unavailable. See payment-links.issuePaymentLink.
function isUndefinedTable(error) {
  return Boolean(error) && error.code === PG_UNDEFINED_TABLE;
}

async function close() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end().catch(error => console.error('[db-close]', error.message));
}

module.exports = {
  isConfigured,
  getPool,
  query,
  withTransaction,
  isUniqueViolation,
  isOverlapViolation,
  isUndefinedTable,
  PG_UNIQUE_VIOLATION,
  PG_EXCLUSION_VIOLATION,
  PG_UNDEFINED_TABLE,
  close
};
