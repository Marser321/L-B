'use strict';

// GET /api/internal/dependencies
//
// A protected, read-only runbook endpoint. It never calls HighLevel or Stripe,
// and it never returns a secret or an identifier that could be used to access a
// customer or calendar. Its caller must already know OFFICE_API_TOKEN.

const { RequestError } = require('../_lib/errors.js');
const { sendJson } = require('../_lib/http.js');
const diagnostics = require('../_lib/dependency-diagnostics.js');

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  try {
    diagnostics.requireOfficeToken(req);
    return sendJson(res, 200, { ok: true, dependencies: await diagnostics.dependencyStatus() });
  } catch (error) {
    const statusCode = error instanceof RequestError ? error.statusCode : 502;
    const message = error instanceof RequestError ? error.message : 'Diagnostics unavailable';
    if (statusCode >= 500) console.error('[dependencies]', { cause: error.name || 'Error', code: error.code || 'DIAGNOSTICS_UNAVAILABLE', statusCode });
    return sendJson(res, statusCode, { ok: false, error: message, code: error.code || 'DIAGNOSTICS_UNAVAILABLE' });
  }
}

module.exports = handler;
module.exports._test = diagnostics;
