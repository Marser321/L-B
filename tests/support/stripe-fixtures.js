'use strict';

// Stripe event fixtures and a fake Stripe API, shaped like the real payloads.
//
// The events carry only the fields the handlers actually read, but they carry them
// in the real nesting (invoice.lines.data[].period, subscription.items.data[]),
// because getting that nesting wrong is exactly the bug a fixture should catch.

const crypto = require('node:crypto');

const membershipCatalog = require('../../api/_lib/membership-catalog.js');

const SECONDS = 1;
function toSeconds(ms) {
  return Math.floor(ms / 1000) * SECONDS;
}

// A fake Stripe HTTP surface: customers, checkout sessions, subscriptions,
// products and prices, plus a record of every call for assertions.
function createStripeStub(options = {}) {
  const state = {
    calls: [],
    customers: new Map(),
    sessions: new Map(),
    subscriptions: new Map(),
    products: options.products || [],
    prices: options.prices || [],
    nextIds: { cus: 1, cs: 1, sub: 1, si: 1, prod: 1, price: 1 },
    failures: options.failures || {}
  };

  const id = prefix => `${prefix}_${String(state.nextIds[prefix]++).padStart(4, '0')}`;

  function parseForm(body) {
    const params = new URLSearchParams(body || '');
    const out = {};
    for (const [key, value] of params) out[key] = value;
    return out;
  }

  const fetchStub = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const full = String(url);
    const path = full.replace('https://api.stripe.com/v1', '').split('?')[0];
    const query = new URLSearchParams(full.split('?')[1] || '');
    const form = init.body ? parseForm(init.body) : null;
    state.calls.push({ method, path, form, idempotencyKey: init.headers && init.headers['Idempotency-Key'] });

    const failure = state.failures[`${method} ${path}`];
    if (failure) {
      return { ok: false, status: failure, json: async () => ({ error: { message: 'forced failure' } }) };
    }

    const ok = data => ({ ok: true, status: 200, json: async () => data });

    if (method === 'GET' && path === '/customers') {
      const email = query.get('email');
      const found = [...state.customers.values()].find(customer => customer.email === email);
      return ok({ data: found ? [found] : [], has_more: false });
    }
    if (method === 'POST' && path === '/customers') {
      const customerId = id('cus');
      const customer = { id: customerId, email: form.email, name: form.name, phone: form.phone };
      state.customers.set(customerId, customer);
      return ok(customer);
    }
    if (method === 'POST' && path === '/checkout/sessions') {
      const sessionId = id('cs');
      // Rebuild the line items Stripe was asked for.
      const lineItems = [];
      for (let index = 0; ; index += 1) {
        const price = form[`line_items[${index}][price]`];
        if (!price) break;
        lineItems.push({ price, quantity: Number(form[`line_items[${index}][quantity]`] || 1) });
      }
      const session = {
        id: sessionId,
        url: `https://checkout.stripe.test/${sessionId}`,
        customer: form.customer,
        mode: form.mode,
        client_reference_id: form.client_reference_id,
        lineItems
      };
      state.sessions.set(sessionId, session);
      return ok(session);
    }
    if (method === 'GET' && path.startsWith('/subscriptions/')) {
      const subscriptionId = decodeURIComponent(path.split('/').pop());
      const subscription = state.subscriptions.get(subscriptionId);
      if (!subscription) return { ok: false, status: 404, json: async () => ({ error: { message: 'no such subscription' } }) };
      return ok(subscription);
    }
    if (method === 'GET' && path === '/products') return ok({ data: state.products, has_more: false });
    if (method === 'GET' && path === '/prices') return ok({ data: state.prices, has_more: false });
    if (method === 'POST' && path === '/products') {
      const product = { id: id('prod'), name: form.name, metadata: { lyb_object: 'lyb_membership' } };
      state.products.push(product);
      return ok(product);
    }
    if (method === 'POST' && path === '/prices') {
      const price = {
        id: id('price'), product: form.product, unit_amount: Number(form.unit_amount),
        lookup_key: form.lookup_key, metadata: { lyb_object: 'lyb_membership' }
      };
      state.prices.push(price);
      return ok(price);
    }

    throw new Error(`unexpected Stripe call: ${method} ${path}`);
  };

  // Registers a subscription the webhook fixtures can refer to.
  function addSubscription({ subscriptionId, customerId, items, status = 'active', periodStartMs, periodEndMs, cancelAtPeriodEnd = false }) {
    const subscription = {
      id: subscriptionId,
      customer: customerId,
      status,
      cancel_at_period_end: cancelAtPeriodEnd,
      current_period_start: toSeconds(periodStartMs),
      current_period_end: toSeconds(periodEndMs),
      items: { data: items }
    };
    state.subscriptions.set(subscriptionId, subscription);
    return subscription;
  }

  return { state, fetchStub, addSubscription, nextId: id };
}

// ── Event fixtures ─────────────────────────────────────────────────────────

function stripeEvent(type, object, { id: eventId = null, livemode = false } = {}) {
  return {
    id: eventId || `evt_${crypto.randomUUID().slice(0, 12)}`,
    type,
    livemode,
    api_version: '2024-06-20',
    created: toSeconds(Date.now()),
    data: { object }
  };
}

function checkoutCompleted({ sessionId, subscriptionId, customerId, items }) {
  return stripeEvent('checkout.session.completed', {
    id: sessionId,
    object: 'checkout_session',
    mode: 'subscription',
    customer: customerId,
    // Inline items so the handler does not need a subscription fetch; the code
    // also supports the id-only form, which the fetch stub answers.
    subscription: { id: subscriptionId, items: { data: items } }
  });
}

function invoicePaid({ invoiceId, subscriptionId, customerId, periodStartMs, periodEndMs, amountCents = 13000, eventId = null }) {
  return stripeEvent('invoice.paid', {
    id: invoiceId,
    object: 'invoice',
    customer: customerId,
    subscription: subscriptionId,
    amount_paid: amountCents,
    period_start: toSeconds(periodStartMs),
    period_end: toSeconds(periodEndMs),
    lines: {
      data: [{
        id: `il_${invoiceId}`,
        period: { start: toSeconds(periodStartMs), end: toSeconds(periodEndMs) }
      }]
    }
  }, { id: eventId });
}

function invoicePaymentFailed({ invoiceId, subscriptionId, customerId, eventId = null }) {
  return stripeEvent('invoice.payment_failed', {
    id: invoiceId,
    object: 'invoice',
    customer: customerId,
    subscription: subscriptionId,
    attempt_count: 1
  }, { id: eventId });
}

function subscriptionUpdated({ subscriptionId, customerId, status = 'active', cancelAtPeriodEnd = false, periodStartMs, periodEndMs, eventId = null }) {
  return stripeEvent('customer.subscription.updated', {
    id: subscriptionId,
    object: 'subscription',
    customer: customerId,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    current_period_start: toSeconds(periodStartMs),
    current_period_end: toSeconds(periodEndMs)
  }, { id: eventId });
}

function subscriptionDeleted({ subscriptionId, customerId, eventId = null }) {
  return stripeEvent('customer.subscription.deleted', {
    id: subscriptionId,
    object: 'subscription',
    customer: customerId,
    status: 'canceled'
  }, { id: eventId });
}

// The provisioned price map, as the provisioner would have written it.
function priceMapRows(livemode = false) {
  return membershipCatalog.entries().map((entry, index) => ({
    id: crypto.randomUUID(),
    catalogVersion: membershipCatalog.CATALOG_VERSION,
    packageId: entry.packageId,
    sizeId: entry.sizeId,
    monthlyCents: entry.monthlyCents,
    currency: entry.currency,
    creditsPerCycle: entry.creditsPerCycle,
    stripeProductId: `prod_test_${index}`,
    stripePriceId: `price_test_${entry.packageId}_${entry.sizeId}`.replace(/-/g, '_'),
    lookupKey: entry.lookupKey,
    livemode
  }));
}

module.exports = {
  toSeconds,
  createStripeStub,
  stripeEvent,
  checkoutCompleted,
  invoicePaid,
  invoicePaymentFailed,
  subscriptionUpdated,
  subscriptionDeleted,
  priceMapRows
};
