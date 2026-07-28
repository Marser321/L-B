'use strict';

// POST /api/memberships/visits
//
// The lifecycle of a membership visit, in one endpoint keyed by `action`:
//
//   book     — hold the vans for this contract's next visit (48h minimum, one
//              future visit per contract, needs a credit available)
//   confirm  — turn that hold into a confirmed booking, allowed only because a
//              verified Stripe invoice paid for the current cycle
//   complete — the wash happened: spend the credit
//   cancel   — inside 24h it spends the credit anyway; earlier it is free
//   no_show  — spends the credit
//
// `book` and `confirm` are customer-facing. `complete`, `cancel` and `no_show`
// change what a customer owes, so they require the office token — a customer
// must not be able to mark their own no-show as a free cancellation, or to
// complete a wash that never happened.

const crypto = require('node:crypto');

const { RequestError } = require('../_lib/errors.js');
const { sendJson, readBody, assertSameOrigin, assertMethod } = require('../_lib/http.js');
const { text } = require('../_lib/validate.js');
const { isValidDateOnly, START_TIME_PATTERN } = require('../_lib/time.js');
const ghl = require('../_lib/ghl.js');
const memberships = require('../_lib/memberships.js');

const CUSTOMER_ACTIONS = new Set(['book', 'confirm']);
const OFFICE_ACTIONS = new Set(['complete', 'cancel', 'no_show']);

function assertOfficeToken(req) {
  const secret = String(process.env.OFFICE_API_TOKEN || '').trim();
  if (!secret) throw new RequestError('Office actions are not configured', 503);
  const header = String((req.headers && req.headers.authorization) || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new RequestError('Not authorized', 401);
  }
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    const body = readBody(req);
    const action = text(body.action, 'action', 1, 20);
    if (!CUSTOMER_ACTIONS.has(action) && !OFFICE_ACTIONS.has(action)) {
      throw new RequestError('action is invalid');
    }
    if (OFFICE_ACTIONS.has(action)) assertOfficeToken(req);
    else assertSameOrigin(req);

    let config = null;
    try { config = ghl.getConfig(); } catch (error) { /* calendars optional for state-only actions */ }

    if (action === 'book') {
      const contractId = text(body.contractId, 'contractId', 8, 64);
      const date = text(body.date, 'date', 10, 10);
      if (!isValidDateOnly(date)) throw new RequestError('date is invalid');
      const startTime = text(body.startTime, 'startTime', 4, 5);
      if (!START_TIME_PATTERN.test(startTime)) throw new RequestError('startTime is invalid');

      const result = await memberships.bookVisit({ contractId, date, startTime, config });
      return sendJson(res, 201, {
        ok: true,
        visitId: result.visit.id,
        holdId: result.hold.holdId,
        expiresAt: result.hold.expiresAt,
        startsAt: new Date(result.visit.scheduledStartMs).toISOString(),
        endsAt: new Date(result.visit.scheduledEndMs).toISOString(),
        crew: result.hold.assignments
      });
    }

    const visitId = text(body.visitId, 'visitId', 8, 64);

    if (action === 'confirm') {
      const result = await memberships.confirmVisit({ visitId, config });
      return sendJson(res, 200, {
        ok: true,
        visitId,
        status: result.visit.status,
        parentBookingId: result.parentBookingId
      });
    }
    if (action === 'complete') {
      const result = await memberships.completeVisit({ visitId });
      return sendJson(res, 200, { ok: true, visitId, status: result.visit.status, creditsRemaining: result.remaining });
    }
    if (action === 'cancel') {
      const result = await memberships.cancelVisit({ visitId, reason: body.reason, config });
      return sendJson(res, 200, {
        ok: true, visitId, status: result.visit.status,
        // Says plainly whether the wash was charged, so the office can explain it.
        creditConsumed: Boolean(result.consumed), late: Boolean(result.late)
      });
    }
    const result = await memberships.markNoShow({ visitId, config });
    return sendJson(res, 200, { ok: true, visitId, status: result.visit.status, creditConsumed: Boolean(result.consumed) });
  } catch (error) {
    const statusCode = error instanceof RequestError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'Membership visit request failed';
    if (statusCode >= 500) console.error('[membership-visits]', error.name || 'Error', error.message);
    return sendJson(res, statusCode, { ok: false, error: publicMessage });
  }
}

module.exports = handler;
module.exports._test = { assertOfficeToken, CUSTOMER_ACTIONS, OFFICE_ACTIONS };
