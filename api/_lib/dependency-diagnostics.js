'use strict';

// Read-only dependency diagnostics. This module deliberately reports booleans,
// counts and safe modes only: it must never disclose credentials, connection
// strings, customer data or calendar identifiers.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');
const db = require('./db.js');
const ghl = require('./ghl.js');
const time = require('./time.js');

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireOfficeToken(req) {
  const expected = String(process.env.OFFICE_API_TOKEN || '').trim();
  if (!expected) throw new RequestError('Dependency diagnostics are not configured', 503, 'DIAGNOSTICS_NOT_CONFIGURED');
  const header = String((req.headers && req.headers.authorization) || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !timingSafeEqual(provided, expected)) {
    throw new RequestError('Not authorized', 401, 'DIAGNOSTICS_UNAUTHORIZED');
  }
}

function hasEnv(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function stripeMode() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return 'not_configured';
  if (key.startsWith('sk_test_')) return 'test';
  if (key.startsWith('sk_live_')) return 'live';
  return 'invalid_prefix';
}

async function databaseStatus() {
  if (!db.isConfigured()) {
    return { configured: false, reachable: false, migrations: { agenda: false, memberships: false } };
  }
  try {
    const result = await db.query(
      "select to_regclass('public.booking_holds') as agenda, to_regclass('public.membership_contracts') as memberships"
    );
    const row = result.rows[0] || {};
    return {
      configured: true,
      reachable: true,
      migrations: { agenda: Boolean(row.agenda), memberships: Boolean(row.memberships) }
    };
  } catch (error) {
    // A database error code can reveal the class of failure but never the URL,
    // user, host or driver message.
    return { configured: true, reachable: false, migrations: { agenda: false, memberships: false }, errorCode: String(error.code || 'DB_UNREACHABLE').slice(0, 40) };
  }
}

async function dependencyStatus() {
  const calendarVars = ghl.RESOURCE_ENV_VARS;
  const configuredCalendars = calendarVars.filter(hasEnv);
  const values = calendarVars.map(name => String(process.env[name] || '').trim()).filter(Boolean);
  let timezone = { configured: hasEnv('BOOKING_TIMEZONE'), valid: true, value: '' };
  try { timezone.value = time.bookingTimezone(); } catch (error) { timezone.valid = false; }

  return {
    database: await databaseStatus(),
    highLevel: {
      baseUrl: ghl.GHL_BASE_URL,
      credentialsConfigured: hasEnv('GHL_PRIVATE_TOKEN'),
      locationConfigured: hasEnv('GHL_LOCATION_ID'),
      assignedUserConfigured: hasEnv('GHL_ASSIGNED_USER_ID'),
      crewCalendars: {
        required: calendarVars.length,
        configured: configuredCalendars.length,
        distinct: values.length === new Set(values).size,
        ready: configuredCalendars.length === calendarVars.length && values.length === new Set(values).size
      }
    },
    timezone,
    stripe: {
      configured: hasEnv('STRIPE_SECRET_KEY'),
      webhookConfigured: hasEnv('STRIPE_WEBHOOK_SECRET'),
      mode: stripeMode()
    },
    cron: { configured: hasEnv('CRON_SECRET') }
  };
}

module.exports = { requireOfficeToken, dependencyStatus, databaseStatus, stripeMode };
