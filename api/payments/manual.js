'use strict';

// POST /api/payments/manual
//
// Records a payment taken outside the website — cash at the door, Zelle, a card
// run by hand — and lets it confirm the booking.
//
// This path already existed in a sense: an operator who knew PAYMENT_WEBHOOK_SECRET
// could hand-craft a call to the payment webhook. That is not a flow, it is a
// workaround, and it left no record of WHO took the money or HOW. This endpoint
// does the same confirmation through the same verified-payment path, and writes
// down the method, the reference and the operator.
//
// The amount is still checked against the deposit the server computed: recording
// $5 against a $50 deposit does not confirm anything.

const crypto = require('node:crypto');

const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody, assertMethod } = require('../_lib/http.js');
const { text, optionalText } = require('../_lib/validate.js');
const ghl = require('../_lib/ghl.js');
const agenda = require('../_lib/agenda.js');

// Methods the office can record. An open text field here would make the payment
// report useless within a month.
const METHODS = Object.freeze(['cash', 'zelle', 'card_terminal', 'check', 'other']);

function assertOfficeToken(req) {
  const secret = String(process.env.OFFICE_API_TOKEN || '').trim();
  if (!secret) throw new RequestError('Office actions are not configured', 503, 'OFFICE_TOKEN_NOT_CONFIGURED');
  const header = String((req.headers && req.headers.authorization) || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new RequestError('Not authorized', 401, 'UNAUTHORIZED');
  }
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');

  const holdId = optionalText(body.holdId, 'holdId', 64);
  const submissionId = optionalText(body.submissionId, 'submissionId', 100);
  if (!holdId && !submissionId) throw new RequestError('holdId or submissionId is required');

  const method = text(body.method, 'method', 2, 20);
  if (!METHODS.includes(method)) throw new RequestError(`method must be one of: ${METHODS.join(', ')}`);

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new RequestError('amount is invalid');

  // The reference is what makes this idempotent: a receipt number, a Zelle
  // confirmation, the initials and the time. Recording the same one twice
  // confirms once.
  const reference = text(body.reference, 'reference', 3, 120);
  const takenBy = text(body.takenBy, 'takenBy', 2, 80);

  return { holdId, submissionId, method, amountCents: Math.round(amount * 100), reference, takenBy };
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    assertOfficeToken(req);
    const input = validateRequest(readBody(req));

    let config = null;
    try { config = ghl.getConfig(); } catch (error) { console.error('[payments-manual] CRM not configured; confirming rows only'); }

    const holdId = input.holdId || await agenda.resolveHoldIdBySubmission(input.submissionId);
    if (!holdId) throw new RequestError('No reservation matches that reference', 404, 'RESERVATION_NOT_FOUND');

    // Same path a Stripe or HighLevel webhook takes, so a manually collected
    // payment confirms exactly like an online one — including the underpayment
    // check and the once-only guarantee.
    const result = await agenda.confirmPayment({
      provider: 'office',
      externalEventId: `office:${input.method}:${input.reference}`,
      eventType: 'manual_payment',
      outcome: 'paid',
      holdId,
      amountCents: input.amountCents,
      currency: 'USD',
      payload: { method: input.method, reference: input.reference, takenBy: input.takenBy },
      config
    });

    return sendJson(res, 200, {
      ok: true,
      holdId,
      ...result,
      // Says plainly what happened, so the operator does not have to interpret it.
      message: result.confirmed ? 'Booking confirmed.'
        : result.alreadyProcessed ? 'Already recorded — nothing changed.'
        : result.conflict ? `Not confirmed (${result.reason || result.status}). Refund or rebook by hand.`
        : 'Recorded.'
    });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const message = error instanceof RequestError ? error.message : 'Could not record the payment';
    if (statusCode >= 500) console.error('[payments-manual]', error.name || 'Error', statusCode);
    return sendJson(res, statusCode, { ok: false, error: message, code: error.code || 'MANUAL_PAYMENT_FAILED' });
  }
}

module.exports = handler;
module.exports._test = { METHODS, validateRequest, assertOfficeToken };
