'use strict';

// Protected, operator-only CRM catalog provisioner. This is intentionally not
// discoverable from the storefront and refuses to do anything without both a
// dedicated secret and `{ apply: true }`.

const crypto = require('node:crypto');

const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody, assertMethod } = require('../_lib/http.js');
const ghl = require('../_lib/ghl.js');
// The general catalog provisioner supersedes the membership-only one. It keeps
// the membership markers byte-for-byte, so a location provisioned by the old tool
// is recognised rather than duplicated.
const provisioning = require('../_lib/crm-catalog-provisioning.js');

function timingSafeEquals(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertAuthorized(req) {
  const expected = String(process.env.MEMBERSHIP_PROVISION_SECRET || '').trim();
  const header = String((req.headers || {}).authorization || '');
  const received = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!expected) throw new RequestError('Membership provisioning is not configured', 503, 'MEMBERSHIP_PROVISION_NOT_CONFIGURED');
  if (!received || !timingSafeEquals(received, expected)) throw new RequestError('Not authorized', 401, 'UNAUTHORIZED');
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;
  try {
    assertAuthorized(req);
    const body = readBody(req) || {};
    // Defaults to memberships so an existing runbook keeps behaving as before.
    // Pass `kinds` to provision the rest of the catalog — services, add-ons and
    // deposits — which is what makes a CRM payment link possible for a one-time
    // job. `--kinds` on scripts/provision-crm-catalog.mjs is the same switch.
    const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : ['membership'];
    const result = await provisioning.provision({
      config: ghl.getConfig(),
      request: ghl.ghlRequest,
      apply: body.apply === true,
      kinds
    });
    // No CRM ids, URLs, credentials, contacts, or payment data are returned. The
    // mapping carries ids, so it is summarised rather than echoed.
    const { mapping, plan, ...safe } = result;
    return sendJson(res, 200, {
      ok: true,
      ...safe,
      planned: plan.length,
      mapped: mapping.filter(entry => entry.crmPriceId).length
    });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    if (statusCode >= 500) console.error('[membership-provision]', error.name || 'Error', statusCode, error.code || '');
    return sendJson(res, statusCode, {
      ok: false,
      error: error instanceof RequestError ? error.message : 'CRM membership provisioning failed',
      code: error.code || 'CRM_MEMBERSHIP_PROVISION_FAILED'
    });
  }
}

module.exports = handler;
module.exports._test = { assertAuthorized, timingSafeEquals };
// Provisioning can make up to 50 CRM calls. The bounded pool in its core keeps
// it quick, and this ceiling leaves room for normal HighLevel latency.
module.exports.config = { maxDuration: 60 };
