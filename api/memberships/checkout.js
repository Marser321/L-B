'use strict';

// POST /api/memberships/checkout
//
// Opens a Stripe subscription checkout for one or more memberships belonging to
// the same account holder. One line per vehicle; each line becomes its own
// contract once the first invoice is paid.
//
// The request names packages and sizes. It cannot name a price, an amount, a
// discount or a Stripe price id — those come from membership-catalog.js and the
// provisioned price map, so a tampered frontend can pick a different PLAN but
// never a different PRICE for the plan it picked.

const { RequestError } = require('../_lib/errors.js');
const { StripeError } = require('../_lib/stripe.js');
const { sendJson, readBody, assertSameOrigin, assertMethod } = require('../_lib/http.js');
const memberships = require('../_lib/memberships.js');

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    assertSameOrigin(req);
    const input = memberships.validateCheckoutRequest(readBody(req));
    const result = await memberships.createCheckout(input);
    return sendJson(res, 200, {
      ok: true,
      checkoutUrl: result.checkoutUrl,
      sessionId: result.stripeSessionId,
      lineCount: result.lineCount,
      // Echoed so the page can show the total it is about to charge. This is the
      // server's number; the page never computed it.
      monthlyTotal: result.totalMonthlyCents / 100
    });
  } catch (error) {
    const statusCode = error instanceof RequestError ? error.statusCode
      : (error instanceof StripeError ? error.statusCode : 502);
    const publicMessage = error instanceof RequestError ? error.message : 'Checkout is temporarily unavailable';
    if (statusCode >= 500) console.error('[membership-checkout]', error.name || 'Error', error.message);
    return sendJson(res, statusCode, { ok: false, error: publicMessage });
  }
}

module.exports = handler;
