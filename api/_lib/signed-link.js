'use strict';

// Standing links, signed rather than stored.
//
// Two audiences need one: each van's crew, and each member. Neither gets a login —
// usernames, passwords, recovery and sessions are a subsystem, and the owner asked to
// keep this simple. What replaces it is an HMAC over the thing the link is FOR, so the
// server can verify a link it never stored.
//
// The two kinds are cryptographically distinct even though the mechanism is shared:
// each `purpose` has its own secret AND is mixed into the signed payload. A crew link
// can therefore never be replayed as a member link, and rotating one audience's secret
// leaves the other's links working.
//
// What this deliberately does NOT do:
//
//   · expire. These are standing links, like a shared calendar URL. One that died
//     mid-shift, or the week a member wanted to book, would be worse than useless.
//   · support revoking a single link. Without storage there is nowhere to record that
//     one token is dead, so revocation is per-audience: rotate that purpose's secret
//     and every link of that kind stops working.
//
// The capability a leaked link grants is bounded by the ROUTE that accepts it, never by
// the token. See api/crew.js and api/member.js for those limits.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');

const PURPOSES = Object.freeze({
  crew: { env: 'CREW_LINK_SECRET', subjectPattern: /^[a-z0-9_]{3,32}$/ },
  // A member link names the membership contract (a CRM opportunity id).
  member: { env: 'MEMBER_LINK_SECRET', subjectPattern: /^[A-Za-z0-9_-]{8,64}$/ }
});

function secretFor(purpose) {
  const spec = PURPOSES[purpose];
  if (!spec) throw new Error(`signed-link: unknown purpose ${purpose}`);
  const value = String(process.env[spec.env] || '').trim();
  // Refused rather than defaulted. A default would mean every deployment of this code
  // shares a signing key, so a token minted anywhere would open this account.
  if (value.length < 32) {
    throw new RequestError(`${purpose} links are not configured`, 503, 'SIGNED_LINK_NOT_CONFIGURED');
  }
  return value;
}

// Bumped per subject to invalidate just that one link. Rotating the purpose's secret
// remains the blunt instrument that kills all of them.
const GENERATIONS = Object.freeze({});

function payloadFor(purpose, subject) {
  const generation = GENERATIONS[`${purpose}:${subject}`] || 1;
  return `${purpose}:v1:${subject}:${generation}`;
}

// How much of the HMAC ends up in the link.
//
// A full SHA-256 is 43 base64url characters, which made a crew link long enough that
// the owner could not tell one from another at a glance. 16 characters is 96 bits:
// forging one means guessing a 96-bit value against an endpoint that answers only
// yes or no, one request at a time, over the network. There is no offline attack to
// speed that up — the secret never leaves the server — so the margin is enormous and
// the link fits on a screen.
//
// Changing this number invalidates every existing link of every purpose, exactly as
// rotating a secret does. Reissue the crew links and any member link in circulation.
const DIGEST_CHARS = 16;

// base64url so the token survives a URL, a QR code and a WhatsApp message intact.
function sign(purpose, subject) {
  const digest = crypto.createHmac('sha256', secretFor(purpose))
    .update(payloadFor(purpose, subject))
    .digest('base64url')
    .slice(0, DIGEST_CHARS);
  return `${subject}.${digest}`;
}

// Returns the subject, or throws. Constant-time compare so a wrong token cannot be
// refined one character at a time by timing the response.
function verify(purpose, token) {
  const spec = PURPOSES[purpose];
  if (!spec) throw new Error(`signed-link: unknown purpose ${purpose}`);

  const raw = String(token || '');
  const separator = raw.lastIndexOf('.');
  if (separator <= 0) throw new RequestError('Invalid link', 403, 'SIGNED_LINK_INVALID');

  const subject = raw.slice(0, separator);
  // Bound the subject before it reaches an HMAC or a comparison, so a huge or oddly
  // shaped value cannot be used to probe the endpoint.
  if (!spec.subjectPattern.test(subject)) throw new RequestError('Invalid link', 403, 'SIGNED_LINK_INVALID');

  const expected = Buffer.from(sign(purpose, subject));
  const supplied = Buffer.from(raw);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw new RequestError('Invalid link', 403, 'SIGNED_LINK_INVALID');
  }
  return subject;
}

module.exports = { sign, verify, PURPOSES, DIGEST_CHARS };
