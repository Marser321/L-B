'use strict';

// Protected test-only probe for the CRM's native recurring invoice contract.
// It creates a non-deliverable DND contact and an UNSCHEDULED HighLevel draft
// with `liveMode: false`; it does not create a booking, hold, payment link,
// Stripe session, or customer-facing message.

const crypto = require('node:crypto');

const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody, assertMethod } = require('../_lib/http.js');
const ghl = require('../_lib/ghl.js');
const memberships = require('../_lib/memberships.js');
const crmRecurring = require('../_lib/crm-recurring-memberships.js');

function timingSafeEquals(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertAuthorized(req) {
  const expected = String(process.env.MEMBERSHIP_TEST_SECRET || '').trim();
  const header = String((req.headers || {}).authorization || '');
  const received = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!expected) throw new RequestError('Membership test is not configured', 503, 'MEMBERSHIP_TEST_NOT_CONFIGURED');
  if (!received || !timingSafeEquals(received, expected)) throw new RequestError('Not authorized', 401, 'UNAUTHORIZED');
}

function validateLines(body) {
  const lines = Array.isArray(body && body.lines) ? body.lines : [];
  if (!lines.length || lines.length > 4) throw new RequestError('lines must contain between 1 and 4 memberships', 422, 'MEMBERSHIP_TEST_LINES_INVALID');
  return lines.map((line, index) => memberships.validateCheckoutLine(line, index));
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;
  const requestId = crypto.randomUUID();
  try {
    assertAuthorized(req);
    const lines = validateLines(readBody(req));
    const result = await crmRecurring.createRecurringDraft({
      config: ghl.getPaymentsConfig(),
      request: ghl.ghlRequest,
      lines,
      timeZone: process.env.BOOKING_TIMEZONE || 'America/New_York'
    });
    // This endpoint is operator-only. Return the draft id needed to inspect or
    // delete the test artifact, never the synthetic contact or payment details.
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    if (statusCode >= 500) console.error('[membership-recurring-test]', requestId, error.name || 'Error', statusCode, error.code || '');
    return sendJson(res, statusCode, {
      ok: false,
      error: error instanceof RequestError ? error.message : 'CRM recurring membership test failed',
      code: error.code || 'CRM_MEMBERSHIP_TEST_FAILED'
    });
  }
}

module.exports = handler;
module.exports._test = { assertAuthorized, validateLines, timingSafeEquals };
module.exports.config = { maxDuration: 30 };
