'use strict';

// Read-only dependency diagnostics. This module deliberately reports booleans,
// counts and safe modes only: it must never disclose credentials, connection
// strings, customer data or calendar identifiers.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');
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


async function dependencyStatus() {
  const calendarVars = ghl.RESOURCE_ENV_VARS;
  const configuredCalendars = calendarVars.filter(hasEnv);
  const values = calendarVars.map(name => String(process.env[name] || '').trim()).filter(Boolean);
  let timezone = { configured: hasEnv('BOOKING_TIMEZONE'), valid: true, value: '' };
  try { timezone.value = time.bookingTimezone(); } catch (error) { timezone.valid = false; }

  return {
    // No `database` key any more, and its absence is the answer: the agenda, the
    // holds and the membership credits all live in HighLevel now. A reader that used
    // to check `database.reachable` was checking a dependency that no longer exists.
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
    // No payment-provider key of our own: billing runs on HighLevel's invoices, so what
    // matters is which of Stripe's two modes they are issued against. The sub-account has
    // BOTH live and test enabled (verified 5 ago 2026), so these booleans are the only
    // thing deciding whether money is real.
    //
    // Reported here because it is the only way to read them from PRODUCTION: they are
    // marked Sensitive in Vercel, so `vercel env pull` returns them empty, and a local
    // script can only ever report its own environment.
    payments: {
      depositsEnabled: String(process.env.GHL_DEPOSIT_PAYMENTS || '').trim() === 'on',
      depositLiveMode: String(process.env.GHL_DEPOSIT_LIVE_MODE || '').trim() === 'true',
      membershipLiveMode: String(process.env.GHL_MEMBERSHIP_LIVE_MODE || '').trim() === 'true',
      // Kept under the old name so an existing caller does not break.
      liveMode: String(process.env.GHL_DEPOSIT_LIVE_MODE || '').trim() === 'true'
    },
    cron: { configured: hasEnv('CRON_SECRET') }
  };
}

module.exports = { requireOfficeToken, dependencyStatus };
