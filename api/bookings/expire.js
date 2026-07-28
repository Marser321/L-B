'use strict';

// POST/GET /api/bookings/expire
//
// Releases holds whose 15 minutes ran out: the vans go back on the market and
// their block slots are removed from HighLevel. An abandoned checkout costs the
// business one quarter of an hour of capacity, not the rest of the day.
//
// Meant to be called by the Vercel cron entry in vercel.json (which arrives with
// an `Authorization: Bearer $CRON_SECRET` header) and safe to call by hand: the
// sweep claims rows with `for update skip locked`, so two runs never release the
// same hold twice.

const crypto = require('node:crypto');

const { RequestError } = require('../_lib/errors.js');
const { sendJson } = require('../_lib/http.js');
const ghl = require('../_lib/ghl.js');
const agenda = require('../_lib/agenda.js');

function assertAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  // Fail closed: without a configured secret this endpoint would let anyone
  // release live holds.
  if (!secret) throw new RequestError('Sweeper is not configured', 503);
  const header = String((req.headers && req.headers.authorization) || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new RequestError('Not authorized', 401);
  }
}

async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'POST, GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    assertAuthorized(req);
    // The GHL config is optional here: without it the rows are still released,
    // they just leave their block slots behind for the next run to clear.
    let config = null;
    try { config = ghl.getConfig(); } catch (error) { console.error('[expire] CRM not configured, releasing rows only'); }
    const result = await agenda.releaseExpiredHolds({ config });
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    const statusCode = error instanceof RequestError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'Sweep failed';
    if (statusCode >= 500) console.error('[expire]', error.name || 'Error', statusCode);
    return sendJson(res, statusCode, { ok: false, error: publicMessage });
  }
}

module.exports = handler;
module.exports._test = { assertAuthorized };
