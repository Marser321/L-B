'use strict';

// POST /api/bookings/holds
//
// Claims N vans for 15 minutes so the customer can fill in the form and pay
// without the slot being sold underneath them. Requires an Idempotency-Key: a
// retried request returns the same hold instead of claiming a second set of vans.
//
// GET /api/bookings/holds?holdId=<uuid> returns a PII-free checkout status.
// DELETE /api/bookings/holds releases an active hold when the customer changes
// their cart or leaves checkout.
//
// 409 means the fleet cannot cover this visit at this time — and when it does, the
// transaction has already rolled back, so nothing was created.

const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody, assertSameOrigin, requireIdempotencyKey } = require('../_lib/http.js');
const { text } = require('../_lib/validate.js');
const { normalizeVehicles } = require('../_lib/selection.js');
const { isValidDateOnly, START_TIME_PATTERN, BUSINESS_DAY } = require('../_lib/time.js');
const agenda = require('../_lib/agenda.js');
const ghl = require('../_lib/ghl.js');

function requestHoldId(req) {
  const query = req.query || {};
  if (typeof query.holdId === 'string') return query.holdId;
  const url = String(req.url || '');
  const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  return new URLSearchParams(queryString).get('holdId') || '';
}

function statusCodeFor(error, fallback) {
  return error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : fallback;
}

function publicError(error, fallbackCode) {
  return {
    ok: false,
    error: error instanceof RequestError ? error.message : 'Booking temporarily unavailable',
    code: error.code || fallbackCode
  };
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');

  const date = text(body.date, 'date', 10, 10);
  if (!isValidDateOnly(date)) throw new RequestError('date is invalid');

  // 'full_day' is not a time the caller chooses: it is what a full-day package
  // forces. Accepted here so the frontend can echo back what availability said,
  // then resolved server-side from the packages in the cart.
  const rawStart = text(body.startTime, 'startTime', 3, 10);
  const startTime = rawStart === 'full_day' ? BUSINESS_DAY.start : rawStart;
  if (!START_TIME_PATTERN.test(startTime)) throw new RequestError('startTime is invalid');

  // requireDescriptor: a hold names the vehicles it is for, so the block slot on
  // each van's calendar says which vehicle it is holding.
  const vehicles = normalizeVehicles(body.vehicles, {
    requirePricing: true,
    requireDescriptor: true,
    language: body.language === 'es' ? 'es' : 'en'
  });

  return { date, startTime, vehicles };
}

async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      // Status contains no customer or vehicle data and the opaque UUID is
      // required. Do not require Origin here: browsers are allowed to omit it
      // on a same-origin GET, which would otherwise break the checkout poller.
      const holdId = text(requestHoldId(req), 'holdId', 8, 64);
      let config = null;
      try { config = ghl.getConfig(); } catch (error) { /* DB state is still useful */ }
      const status = await agenda.describeHoldStatus(holdId, { config });
      return sendJson(res, 200, { ok: true, ...status });
    } catch (error) {
      const statusCode = statusCodeFor(error, 502);
      if (statusCode >= 500) console.error('[holds-status]', error.name || 'Error', error.statusCode || statusCode);
      return sendJson(res, statusCode, publicError(error, 'HOLD_STATUS_UNAVAILABLE'));
    }
  }

  if (req.method === 'DELETE') {
    try {
      assertSameOrigin(req);
      const body = readBody(req);
      const holdId = text(body && body.holdId, 'holdId', 8, 64);
      let config = null;
      try { config = ghl.getConfig(); } catch (error) { /* release DB rows regardless */ }
      const released = await agenda.releaseHold({ holdId, reason: 'customer_changed', config });
      return sendJson(res, 200, { ok: true, status: 'released', reason: 'HOLD_RELEASED', ...released });
    } catch (error) {
      const statusCode = statusCodeFor(error, 502);
      if (statusCode >= 500) console.error('[holds-release]', error.name || 'Error', error.statusCode || statusCode);
      return sendJson(res, statusCode, publicError(error, 'HOLD_RELEASE_UNAVAILABLE'));
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    assertSameOrigin(req);
    const idempotencyKey = requireIdempotencyKey(req);
    const input = validateRequest(readBody(req));
    const hold = await agenda.acquireHold({ idempotencyKey, ...input });
    return sendJson(res, hold.replayed ? 200 : 201, { ok: true, ...hold });
  } catch (error) {
    const statusCode = statusCodeFor(error, 502);
    if (statusCode >= 500) console.error('[holds]', error.name || 'Error', error.statusCode || statusCode);
    return sendJson(res, statusCode, publicError(error, 'HOLD_UNAVAILABLE'));
  }
}

module.exports = handler;
module.exports._test = { validateRequest, requestHoldId };
