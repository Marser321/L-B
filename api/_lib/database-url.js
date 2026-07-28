'use strict';

// Some managed Postgres poolers use a private/self-signed certificate. Keep
// certificate verification on by default; an operator must explicitly opt in
// to the provider-specific `no-verify` mode.
function databaseConnectionString(raw = process.env.DATABASE_URL, sslMode = process.env.DATABASE_SSL_MODE) {
  const value = String(raw || '').trim();
  if (!value || String(sslMode || '').trim().toLowerCase() !== 'no-verify') return value;

  const parsed = new URL(value);
  parsed.searchParams.set('sslmode', 'no-verify');
  return parsed.toString();
}

module.exports = { databaseConnectionString };
