'use strict';

// Operator-only reader for the synthetic recurring-invoice draft. It exposes
// only the recurrence schema needed to compare HighLevel's UI with our API
// payload — never contact data, products, prices, invoice ids, or payment data.

const crypto = require('node:crypto');

const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody, assertMethod } = require('../_lib/http.js');
const ghl = require('../_lib/ghl.js');
const { INVOICE_VERSION } = require('../_lib/crm-recurring-memberships.js');

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

function scheduleId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw new RequestError('scheduleId is invalid', 422, 'MEMBERSHIP_TEST_SCHEDULE_INVALID');
  return id;
}

function summary(schedule) {
  const raw = schedule && (schedule.schedule || {});
  const rrule = raw.rrule || {};
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
  try {
    assertAuthorized(req);
    const id = scheduleId((readBody(req) || {}).scheduleId);
    const result = await ghl.ghlRequest(ghl.getPaymentsConfig(), `/invoices/schedule/${encodeURIComponent(id)}`, {
      version: INVOICE_VERSION
    });
    return sendJson(res, 200, { ok: true, ...summary(result) });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    if (statusCode >= 500) console.error('[membership-recurring-test-status]', error.name || 'Error', statusCode, error.code || '');
    return sendJson(res, statusCode, {
      ok: false,
      error: error instanceof RequestError ? error.message : 'CRM recurring membership test status failed',
      code: error.code || 'CRM_MEMBERSHIP_TEST_STATUS_FAILED'
    });
  }
}

module.exports = handler;
module.exports._test = { assertAuthorized, scheduleId, summary, timingSafeEquals };
