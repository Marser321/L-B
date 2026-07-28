'use strict';

// POST /api/webhooks/stripe
//
// The only thing that can activate a membership, grant credits, or mark an account
// past due. Three defences, in order:
//
//   1. The raw body is read before anything parses it, and the signature is
//      checked against STRIPE_WEBHOOK_SECRET. No signature, no processing —
//      there is no "trusted network" fallback.
//   2. The event id is inserted into stripe_events. Stripe retries generously;
//      the second delivery of an event never reaches a handler.
//   3. Handlers are transactional, so an event either applies completely or not
//      at all and can be safely retried.
//
// Answers 2xx for anything it has handled, ignored, or already seen, and 5xx only
// when a retry might actually help.

const { RequestError } = require('../_lib/errors.js');
const { sendJson, assertMethod } = require('../_lib/http.js');
const stripeClient = require('../_lib/stripe.js');
const ghl = require('../_lib/ghl.js');
const memberships = require('../_lib/memberships.js');

// Vercel parses JSON bodies by default, which destroys the bytes the signature
// covers. This turns that off so readRawBody sees what Stripe actually sent.
const config = { api: { bodyParser: false } };

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  let event;
  try {
    const stripe = stripeClient.getStripeConfig();
    const rawBody = await stripeClient.readRawBody(req);
    const signature = req.headers && (req.headers['stripe-signature'] || req.headers['Stripe-Signature']);
    stripeClient.verifyWebhookSignature(rawBody, signature, stripe.webhookSecret);

    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      throw new RequestError('Invalid JSON payload', 400);
    }

    // A test-mode event arriving at a live endpoint (or the reverse) means the
    // dashboard is wired to the wrong environment. Acknowledge it so Stripe stops
    // retrying, but never act on it.
    if (Boolean(event.livemode) !== stripe.livemode) {
      console.error('[stripe-webhook] livemode mismatch', event.id, event.livemode, stripe.livemode);
      return sendJson(res, 200, { ok: true, ignored: true, reason: 'livemode_mismatch' });
    }

    let ghlConfig = null;
    try { ghlConfig = ghl.getConfig(); } catch (error) {
      console.error('[stripe-webhook] CRM not configured; skipping HighLevel sync');
    }

    const result = await memberships.handleEvent(event, { config: ghlConfig, stripeConfig: stripe });
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    // A signature or payload problem is the caller's fault and retrying will not
    // fix it — 400, so Stripe gives up and the failure is visible in the
    // dashboard. Anything else may be transient: 5xx asks for a retry.
    const statusCode = error instanceof RequestError ? error.statusCode : 500;
    if (statusCode >= 500) {
      console.error('[stripe-webhook]', event && event.id, event && event.type, error.message);
    } else {
      console.error('[stripe-webhook] rejected', error.message);
    }
    return sendJson(res, statusCode, { ok: false, error: error instanceof RequestError ? error.message : 'Webhook processing failed' });
  }
}

module.exports = handler;
module.exports.config = config;
