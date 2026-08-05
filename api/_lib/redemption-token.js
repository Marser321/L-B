'use strict';

const crypto = require('node:crypto');
const { RequestError } = require('./errors.js');

function key() {
  const secret = String(process.env.MEMBER_LINK_SECRET || '');
  if (secret.length < 32) throw new RequestError('Member redemption is not configured', 503, 'SIGNED_LINK_NOT_CONFIGURED');
  return crypto.createHash('sha256').update(`redemption:v1:${secret}`).digest();
}

function issue(contractId, ttlMs = 10 * 60 * 1000) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const plaintext = JSON.stringify({ contractId, expiresAt: Date.now() + ttlMs });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function verify(token) {
  try {
    const bytes = Buffer.from(String(token || ''), 'base64url');
    if (bytes.length < 29 || bytes.length > 512) throw new Error('shape');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(payload.contractId) || !(payload.expiresAt > Date.now())) throw new Error('expired');
    return payload.contractId;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('Invalid or expired redemption', 403, 'MEMBERSHIP_REDEMPTION_INVALID');
  }
}

module.exports = { issue, verify };
