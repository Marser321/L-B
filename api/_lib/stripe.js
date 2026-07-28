'use strict';

// Minimal Stripe client, in the same shape as ghl.js: fetch, no SDK.
//
// Two things here are security-critical and are written out rather than trusted
// to a dependency, so they can be read and audited in one sitting:
//
//   * verifyWebhookSignature — the ONLY thing standing between a stranger with
//     our webhook URL and a free membership. Constant-time compare, and a
//     timestamp tolerance so a captured payload cannot be replayed tomorrow.
//   * readRawBody — signatures are over the exact bytes Stripe sent. A body that
//     has been parsed and re-serialized will not verify, and a handler that
//     "falls back" to the parsed object is a handler with no signature check at
//     all. This one fails loudly instead.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');

const STRIPE_BASE_URL = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-06-20';
const STRIPE_REQUEST_TIMEOUT_MS = 15 * 1000;
// Stripe's own recommendation: reject signatures whose timestamp is more than
// five minutes old, so a leaked request body cannot be replayed later.
const SIGNATURE_TOLERANCE_SECONDS = 300;

class StripeError extends Error {
  constructor(status, body) {
    const detail = (body && body.error && body.error.message) || 'unknown error';
    super(`Stripe request failed (${status}): ${detail}`);
    this.name = 'StripeError';
    this.status = status;
    this.statusCode = status >= 500 ? 502 : 400;
    this.code = body && body.error && body.error.code;
    this.type = body && body.error && body.error.type;
  }
}

function getStripeConfig() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) throw new RequestError('Stripe is not configured', 503);
  return {
    secretKey,
    webhookSecret: String(process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
    // Derived from the key itself, never from a request or a config flag: a test
    // key cannot accidentally be treated as live, or the other way round.
    livemode: secretKey.startsWith('sk_live_'),
    successUrl: String(process.env.STRIPE_CHECKOUT_SUCCESS_URL || '').trim(),
    cancelUrl: String(process.env.STRIPE_CHECKOUT_CANCEL_URL || '').trim()
  };
}

// Stripe takes form-encoded bodies with bracketed paths for nested data:
// { items: [{ price: 'p' }] } → items[0][price]=p
function encodeForm(value, prefix = '', pairs = []) {
  if (value == null) return pairs;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => encodeForm(entry, `${prefix}[${index}]`, pairs));
    return pairs;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => {
      encodeForm(entry, prefix ? `${prefix}[${key}]` : key, pairs);
    });
    return pairs;
  }
  pairs.push([prefix, String(value)]);
  return pairs;
}

function toFormBody(payload) {
  return encodeForm(payload)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

async function stripeRequest(config, path, { method = 'GET', body = null, idempotencyKey = null, query = null } = {}) {
  const search = query ? `?${new URLSearchParams(query)}` : '';
  const headers = {
    Authorization: `Bearer ${config.secretKey}`,
    'Stripe-Version': STRIPE_API_VERSION,
    Accept: 'application/json'
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  // Every write carries an idempotency key so a retry — ours or the platform's —
  // cannot create a second customer, session or subscription.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(`${STRIPE_BASE_URL}${path}${search}`, {
      method,
      headers,
      body: body ? toFormBody(body) : undefined,
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new StripeError(504, { error: { message: 'timeout' } });
    }
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[stripe-fail]', method, path, response.status, JSON.stringify(data).slice(0, 400));
    throw new StripeError(response.status, data);
  }
  return data;
}

// ── Webhook verification ───────────────────────────────────────────────────

function parseSignatureHeader(header) {
  const parts = String(header || '').split(',').map(part => part.trim());
  const timestamp = parts.find(part => part.startsWith('t='));
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  return { timestamp: timestamp ? Number(timestamp.slice(2)) : NaN, signatures };
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Throws unless the body was signed by Stripe with our endpoint secret, recently.
// `rawBody` must be the exact bytes received.
function verifyWebhookSignature(rawBody, signatureHeader, secret, { toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS, now = Date.now() } = {}) {
  if (!secret) throw new RequestError('Stripe webhook secret is not configured', 503);
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
  if (!Number.isFinite(timestamp) || !signatures.length) throw new RequestError('Invalid Stripe signature header', 400);

  const ageSeconds = Math.abs(Math.floor(now / 1000) - timestamp);
  if (ageSeconds > toleranceSeconds) throw new RequestError('Stripe signature timestamp is out of tolerance', 400);

  const payload = `${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  // Stripe can send several v1 signatures during a secret rotation; any match is
  // a valid signature.
  if (!signatures.some(signature => timingSafeEqualHex(signature, expected))) {
    throw new RequestError('Stripe signature does not match', 400);
  }
  return true;
}

// The exact bytes Stripe posted. Vercel's Node runtime parses JSON bodies by
// default, which destroys the signature, so the webhook route opts out with
// `module.exports.config = { api: { bodyParser: false } }` and this reads the
// stream. If all we have is an already-parsed object we CANNOT verify anything —
// re-serialising would produce different bytes — so this throws rather than
// letting an unverifiable request through.
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req[Symbol.asyncIterator] === 'function' && !req.readableEnded) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new RequestError('Raw request body is unavailable; cannot verify the Stripe signature', 400);
}

// ── Resources used by the membership flow ──────────────────────────────────

async function findCustomerByEmail(config, email) {
  if (!email) return null;
  const result = await stripeRequest(config, '/customers', { query: { email, limit: '1' } });
  return (result.data || [])[0] || null;
}

async function createCustomer(config, { email, name, phone, metadata }, idempotencyKey) {
  return stripeRequest(config, '/customers', {
    method: 'POST',
    idempotencyKey,
    body: { email, name, phone, metadata }
  });
}

async function createCheckoutSession(config, payload, idempotencyKey) {
  return stripeRequest(config, '/checkout/sessions', { method: 'POST', idempotencyKey, body: payload });
}

async function getSubscription(config, subscriptionId) {
  return stripeRequest(config, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    query: { 'expand[]': 'items.data.price' }
  });
}

async function listProducts(config, params = {}) {
  return stripeRequest(config, '/products', { query: { limit: '100', ...params } });
}

async function listPrices(config, params = {}) {
  return stripeRequest(config, '/prices', { query: { limit: '100', ...params } });
}

async function createProduct(config, body, idempotencyKey) {
  return stripeRequest(config, '/products', { method: 'POST', idempotencyKey, body });
}

async function createPrice(config, body, idempotencyKey) {
  return stripeRequest(config, '/prices', { method: 'POST', idempotencyKey, body });
}

module.exports = {
  STRIPE_BASE_URL,
  STRIPE_API_VERSION,
  SIGNATURE_TOLERANCE_SECONDS,
  StripeError,
  getStripeConfig,
  encodeForm,
  toFormBody,
  stripeRequest,
  parseSignatureHeader,
  verifyWebhookSignature,
  readRawBody,
  findCustomerByEmail,
  createCustomer,
  createCheckoutSession,
  getSubscription,
  listProducts,
  listPrices,
  createProduct,
  createPrice
};
