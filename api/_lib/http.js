'use strict';

const { RequestError } = require('./errors.js');

const MAX_BODY_BYTES = 32 * 1024;
// RFC-ish shape for Idempotency-Key: opaque, printable, bounded.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  const length = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new RequestError('Request body is too large', 413);
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (error) { throw new RequestError('Invalid JSON'); }
  }
  throw new RequestError('A JSON body is required');
}

function assertSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  const host = req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
  if (!origin || !host) throw new RequestError('Origin is required', 403);
  let originHost;
  try { originHost = new URL(origin).host; } catch (error) { throw new RequestError('Invalid origin', 403); }
  if (originHost !== host) throw new RequestError('Origin not allowed', 403);
}

function assertMethod(req, res, method) {
  if (req.method === method) return true;
  res.setHeader('Allow', method);
  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  return false;
}

// The key that makes a hold retry-safe. Required rather than optional: without
// it a dropped response leaves the browser unable to retry without risking a
// second hold on a second set of vans.
function requireIdempotencyKey(req) {
  const header = req.headers && (req.headers['idempotency-key'] || req.headers['Idempotency-Key']);
  const key = typeof header === 'string' ? header.trim() : '';
  if (!key) throw new RequestError('Idempotency-Key header is required', 400);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw new RequestError('Idempotency-Key header is invalid', 400);
  return key;
}

module.exports = {
  MAX_BODY_BYTES,
  sendJson,
  readBody,
  assertSameOrigin,
  assertMethod,
  requireIdempotencyKey
};
