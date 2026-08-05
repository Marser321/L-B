'use strict';

// GET /api/internal/dependencies
//
// A protected, read-only runbook endpoint. It never calls HighLevel or Stripe,
// and it never returns a secret or an identifier that could be used to access a
// customer or calendar. Its caller must already know OFFICE_API_TOKEN.

const crypto = require('node:crypto');
const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody } = require('../_lib/http.js');
const diagnostics = require('../_lib/dependency-diagnostics.js');
const ghl = require('../_lib/ghl.js');
const provisioning = require('../_lib/crm-catalog-provisioning.js');

const MEMBERSHIP_FIELDS = Object.freeze([
  { name: 'Membership Cycle Ends', dataType: 'TEXT' },
  { name: 'Membership Portal URL', dataType: 'TEXT' },
  { name: 'Membership Checkout ID', dataType: 'TEXT' },
  // Already present in the sub-account, left over from Stripe. Listed so a fresh
  // location gets it too; on this one it is a no-op.
  { name: 'Membership Subscription ID', dataType: 'TEXT' },
  { name: 'Membership Credit Reminder Date', dataType: 'DATE' }
]);

function timingSafeEquals(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireProvisionToken(req) {
  const expected = String(process.env.MEMBERSHIP_PROVISION_SECRET || '').trim();
  const header = String((req.headers || {}).authorization || '');
  const received = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!expected) throw new RequestError('Membership provisioning is not configured', 503, 'MEMBERSHIP_PROVISION_NOT_CONFIGURED');
  if (!received || !timingSafeEquals(received, expected)) throw new RequestError('Not authorized', 401, 'UNAUTHORIZED');
}

async function ensureMembershipFields(config, apply) {
  const data = await ghl.ghlRequest(config, `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`, { version: '2021-07-28' });
  const existing = new Set((data.customFields || []).map(field => String(field.name || '').trim()));
  const missing = MEMBERSHIP_FIELDS.filter(field => !existing.has(field.name));
  if (apply) {
    for (const field of missing) await ghl.ghlRequest(config, `/locations/${encodeURIComponent(config.locationId)}/customFields`, {
      method: 'POST', version: '2021-07-28', body: { name: field.name, dataType: field.dataType, model: 'opportunity', placeholder: field.name }
    });
  }
  return { missing: missing.length, created: apply ? missing.length : 0 };
}

function throttledHighLevelRequest() {
  let lastCallAt = 0;
  return async (config, path, options) => {
    const waitMs = Math.max(0, 140 - (Date.now() - lastCallAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastCallAt = Date.now();
    return ghl.ghlRequest(config, path, options);
  };
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  try {
    if (req.method === 'POST') {
      requireProvisionToken(req);
      const body = readBody(req) || {};
      const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : ['membership'];
      const config = ghl.getConfig();
      const fields = body.setup === true ? await ensureMembershipFields(config, body.apply === true) : null;
      // HighLevel rate-limits bulk product writes. A single paced worker keeps the
      // operation resumable and below the location's write quota.
      const result = await provisioning.provision({
        config, request: throttledHighLevelRequest(), apply: body.apply === true, kinds, concurrency: 1
      });
      const { mapping, plan, ...safe } = result;
      return sendJson(res, 200, { ok: true, ...safe, ...(fields ? { fields } : {}), planned: plan.length, mapped: mapping.filter(entry => entry.crmPriceId).length });
    }
    diagnostics.requireOfficeToken(req);
    return sendJson(res, 200, { ok: true, dependencies: await diagnostics.dependencyStatus() });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const message = error instanceof RequestError ? error.message : req.method === 'POST' ? 'CRM provisioning failed' : 'Diagnostics unavailable';
    if (statusCode >= 500) console.error('[dependencies]', { cause: error.name || 'Error', code: error.code || 'DIAGNOSTICS_UNAVAILABLE', statusCode });
    return sendJson(res, statusCode, { ok: false, error: message, code: error.code || 'DIAGNOSTICS_UNAVAILABLE' });
  }
}

module.exports = handler;
module.exports._test = { ...diagnostics, timingSafeEquals, requireProvisionToken, ensureMembershipFields, throttledHighLevelRequest };
module.exports.config = { maxDuration: 60 };
