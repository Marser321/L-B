'use strict';

const quote = require('./quote.js');

const {
  RequestError,
  HighLevelError,
  assertSameOrigin,
  readBody,
  sendJson,
  getConfig,
  validateAvailabilityRequest,
  availabilityForCart
} = quote._test;

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    assertSameOrigin(req);
    const input = validateAvailabilityRequest(readBody(req));
    const config = getConfig();
    const availability = await availabilityForCart(config, input.packageIds, input.from, input.to);
    return sendJson(res, 200, { ok: true, ...availability });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'Calendar temporarily unavailable';
    if (statusCode >= 500) console.error('[availability]', error.name || 'Error', error.statusCode || statusCode);
    return sendJson(res, statusCode, { ok: false, error: publicMessage });
  }
}

module.exports = handler;

