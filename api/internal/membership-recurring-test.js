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

function scheduleId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw new RequestError('scheduleId is invalid', 422, 'MEMBERSHIP_TEST_SCHEDULE_INVALID');
  return id;
}

function summary(schedule) {
  const raw = schedule && (schedule.schedule || {});
  const rrule = raw.rrule || {};
  // This route is protected, but even its operator response intentionally
  // excludes customer, product, price, invoice, and CRM identifiers.
  return {
    status: String(schedule && schedule.status || ''),
    liveMode: Boolean(schedule && schedule.liveMode),
    invoiceCount: Array.isArray(schedule && schedule.invoices) ? schedule.invoices.length : 0,
    schedule: {
      executeAt: typeof raw.executeAt === 'string' ? raw.executeAt : '',
      rrule: {
        intervalType: String(rrule.intervalType || ''),
        interval: Number(rrule.interval || 0),
        startDate: String(rrule.startDate || ''),
        startTime: String(rrule.startTime || ''),
        dayOfMonth: Number(rrule.dayOfMonth || 0),
        daysBefore: Number(rrule.daysBefore || 0),
        useStartAsPrimaryUserAccepted: Boolean(rrule.useStartAsPrimaryUserAccepted),
        endType: String(rrule.endType || '')
      }
    }
  };
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;
  const requestId = crypto.randomUUID();
  try {
    assertAuthorized(req);
    const body = readBody(req) || {};
    if (body.action === 'inspect') {
      const id = scheduleId(body.scheduleId);
      const config = ghl.getPaymentsConfig();
      const result = await ghl.ghlRequest(config, `/invoices/schedule/${encodeURIComponent(id)}?${new URLSearchParams({ locationId: config.locationId })}`, {
        // HighLevel's create-schedule API is pinned to 2023-02-21, whereas
        // the read endpoint is currently served under v3.
        version: 'v3'
      });
      return sendJson(res, 200, { ok: true, ...summary(result) });
    }
    const lines = validateLines(body);
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
    if (statusCode >= 500) {
      console.error('[membership-recurring-test]', requestId, error.name || 'Error', statusCode, error.code || '', error.upstreamHint || '');
    }
    return sendJson(res, statusCode, {
      ok: false,
      error: error instanceof RequestError ? error.message : 'CRM recurring membership test failed',
      code: error.code || 'CRM_MEMBERSHIP_TEST_FAILED',
      // Only this Bearer-protected test route can emit the redacted provider
      // validation text. It is intentionally absent from application logs.
      ...(error instanceof HighLevelError && error.diagnosticMessage ? { diagnostic: error.diagnosticMessage } : {})
    });
  }
}

module.exports = handler;
module.exports._test = { assertAuthorized, validateLines, scheduleId, summary, timingSafeEquals };
module.exports.config = { maxDuration: 30 };
