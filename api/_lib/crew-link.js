'use strict';

// The crew's standing link, signed rather than stored.
//
// Each van gets one URL its crew keeps on their phone. There is no login: usernames
// and passwords are a subsystem (registration, recovery, sessions) and the owner
// asked to keep this simple. What replaces it is an HMAC over the van's key, so the
// server can verify a link it never stored.
//
// What this deliberately does NOT do:
//
//   · expire. It is a standing link, like a shared calendar URL. A link that expired
//     mid-shift would be worse than useless.
//   · support revoking ONE van. Without storage there is nowhere to record that a
//     single token is dead, so the only revocation is rotating CREW_LINK_SECRET,
//     which invalidates all four at once. That is the documented trade-off; if
//     per-van revocation is ever needed, bump the van's `generation` below.
//
// The capability a leaked link grants is bounded by the route, not by the token:
// today only, that van only, and only the two actions the crew needs. It can never
// read another van's day, another date, or a customer's payment details.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');

// Bumped per van to invalidate just that van's link without touching the others.
// Rotating CREW_LINK_SECRET remains the blunt instrument that kills all of them.
const GENERATIONS = Object.freeze({});

function secret() {
  const value = String(process.env.CREW_LINK_SECRET || '').trim();
  // Refused rather than defaulted. A default would mean every deployment of this
  // code shares a signing key, so a token minted anywhere would open this account.
  if (value.length < 32) {
    throw new RequestError('Crew links are not configured', 503, 'CREW_LINK_NOT_CONFIGURED');
  }
  return value;
}

function generationFor(resourceKey) {
  return String(GENERATIONS[resourceKey] || 1);
}

function payloadFor(resourceKey) {
  return `crew:v1:${resourceKey}:${generationFor(resourceKey)}`;
}

// base64url so the token survives a URL, a QR code and a WhatsApp message intact.
function sign(resourceKey) {
  const digest = crypto.createHmac('sha256', secret()).update(payloadFor(resourceKey)).digest('base64url');
  return `${resourceKey}.${digest}`;
}

// Returns the van's key, or throws. Constant-time compare so a wrong token cannot
// be refined one character at a time by timing the response.
function verify(token) {
  const raw = String(token || '');
  const separator = raw.lastIndexOf('.');
  if (separator <= 0) throw new RequestError('Invalid crew link', 403, 'CREW_LINK_INVALID');

  const resourceKey = raw.slice(0, separator);
  // Bound the key before it reaches an HMAC or a comparison, so a huge or oddly
  // shaped value cannot be used to probe the endpoint.
  if (!/^[a-z0-9_]{3,32}$/.test(resourceKey)) throw new RequestError('Invalid crew link', 403, 'CREW_LINK_INVALID');

  const expected = Buffer.from(sign(resourceKey));
  const supplied = Buffer.from(raw);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw new RequestError('Invalid crew link', 403, 'CREW_LINK_INVALID');
  }
  return resourceKey;
}

// Every van's link, for the operator to hand out once. Never exposed by an endpoint
// the crew can reach: printing a link mints a capability, so this is for a local
// terminal and the CRM, not for the web.
function allLinks(resources, baseUrl = 'https://lybelitewash.com') {
  return resources.map(resource => ({
    resourceKey: resource.key,
    url: `${baseUrl.replace(/\/$/, '')}/cuadrilla.html?t=${encodeURIComponent(sign(resource.key))}`
  }));
}

module.exports = { sign, verify, allLinks };
