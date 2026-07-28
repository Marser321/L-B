'use strict';

// Chooses the repository the agenda runs against.
//
// Production always gets Postgres. There is no fallback to a memory store, and no
// fallback to reading availability straight off HighLevel: if DATABASE_URL is not
// set, the booking endpoints fail with 503 rather than pretending the calendar is
// a source of truth. A wrong "yes, that slot is yours" is worse than a clear
// "booking is temporarily unavailable".

const { RequestError } = require('./errors.js');
const { createPgRepository } = require('./repository-pg.js');

let override = null;
let cached = null;

function getRepository() {
  if (override) return override;
  const db = require('./db.js');
  if (!db.isConfigured()) throw new RequestError('Booking database is not configured', 503, 'DATABASE_NOT_CONFIGURED');
  if (!cached) cached = createPgRepository();
  return cached;
}

// Test seam. Passing null restores the real repository.
function setRepositoryForTests(repository) {
  override = repository;
  return repository;
}

function isRepositoryConfigured() {
  if (override) return true;
  return require('./db.js').isConfigured();
}

module.exports = { getRepository, setRepositoryForTests, isRepositoryConfigured };
