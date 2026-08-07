'use strict';

// Payment links, built from catalog identifiers.
//
// Two things could previously not be done: the office could not send a link for a
// one-time job (the services did not exist as CRM products), and the deposit link
// the website produced was an invoice with a free-text line called "Booking
// Deposit" — impossible to report on, impossible to reuse.
//
// Both are fixed by the same rule as everywhere else in this codebase: **a request
// names ids, the server decides the money.** A caller sends `packageId` + `sizeId`
// + `addonIds`, or a deposit, or a membership contract. It cannot send an amount,
// a discount or a CRM price id. `buildLines` resolves each id against pricing.js —
// the same module the quote endpoint uses — and then attaches the CRM product and
// price that the provisioner created for it.
//
// Idempotency is the INVOICE ITSELF. Every name this module builds is deterministic
// (`Booking Deposit — hold:<id>`), so an existing invoice under the same name is the
// earlier attempt: two clicks on "send payment link", or a retry after a timeout,
// find it and return it instead of billing the customer twice.
//
// That used to be a claimed row in a `payment_links` table, with the CRM lookup as a
// fallback for when the table was missing. The fallback was the only path production
// ever took — migration 003 shipped unapplied — and it is now the only path there is.
// Asking the system that holds the money whether it already took it beats keeping a
// second ledger that can disagree with it.

const { RequestError } = require('./errors.js');
const catalog = require('./catalog.js');
const pricing = require('./pricing.js');
const membershipCatalog = require('./membership-catalog.js');
const crmCatalog = require('./crm-catalog.js');
const ghl = require('./ghl.js');

const PURPOSES = Object.freeze(['booking_deposit', 'service', 'membership', 'manual']);
const ORIGINS = Object.freeze(['web', 'office']);
const INVOICE_VERSION = '2021-07-28';
const LINK_TIMEOUT_MS = 8 * 1000;

function centsToMajor(cents) {
  return Math.round(cents) / 100;
}

// ── Line building ──────────────────────────────────────────────────────────

// One line per vehicle service, one per add-on, with amounts from pricing.js.
//
// The lines used to carry the CRM product and price backing each catalog id, read
// from a `crm_price_map` table. That mapping lived only in Postgres and was never
// applied to production, so every invoice this module has ever issued has carried our
// own names and amounts — which is what it does now, by construction. The products
// still exist in the CRM; what is gone is the second copy of the pairing.
function buildLines({ purpose, vehicles = [], deposit = null, contract = null }) {
  const lines = [];

  if (purpose === 'membership') {
    if (!contract) throw new RequestError('A membership contract is required', 400, 'PAYMENT_LINK_INVALID');
    const price = membershipCatalog.priceFor(contract.packageId, contract.sizeId);
    lines.push({
      kind: 'membership',
      name: price.label,
      amountCents: price.monthlyCents,
      quantity: 1,
      packageId: contract.packageId,
      sizeId: contract.sizeId
    });
    return lines;
  }

  for (const vehicle of vehicles) {
    const bounds = pricing.packagePriceBounds(vehicle.packageId, vehicle.sizeId);
    lines.push({
      kind: 'service',
      name: `${crmCatalog.packageName(vehicle.packageId)} · ${crmCatalog.sizeName(vehicle.sizeId)}`,
      amountCents: Math.round(bounds.min * 100),
      quantity: 1,
      packageId: vehicle.packageId,
      sizeId: vehicle.sizeId
    });

    for (const addonId of vehicle.addonIds || []) {
      const addonBounds = pricing.addonPriceBounds(addonId);
      // A custom-quote add-on has no amount and no product; it is recorded on the
      // line list so the office sees it, but it is never charged automatically.
      if (addonBounds.custom || !(addonBounds.min > 0)) continue;
      lines.push({
        kind: 'addon',
        name: crmCatalog.addonName(addonId),
        amountCents: Math.round(addonBounds.min * 100),
        quantity: 1,
        addonId
      });
    }
  }

  if (deposit) {
    const productKey = deposit.amount >= catalog.DEPOSIT_LARGE ? 'deposit-large' : 'deposit-small';
    lines.push({
      kind: 'deposit',
      // The name the CRM product carries, so `attachCrmProducts` can find it. Kept
      // here rather than looked up now: this function is pure by design.
      name: DEPOSIT_PRODUCT_NAMES[productKey],
      amountCents: Math.round(deposit.amount * 100),
      quantity: 1
    });
  }

  if (!lines.length) throw new RequestError('A payment link needs at least one line', 400, 'PAYMENT_LINK_EMPTY');
  return lines;
}

function totalCents(lines) {
  return lines.reduce((total, line) => total + line.amountCents * (line.quantity || 1), 0);
}

// ── CRM products ───────────────────────────────────────────────────────────

// The deposit line has to BE the CRM product, not merely be named after it.
//
// HighLevel's "Payment Received" trigger filters on the GLOBAL PRODUCT the payment
// was for, and the workflow that turns a paid deposit into a confirmed booking is
// built on that filter. An item sent without ids reads back with `productId: null`,
// so the trigger never matches and the webhook never fires: the customer pays and
// the hold lapses anyway. Verified against the live sub-account on 2026-08-07 — the
// same item sent WITH the ids reads them back unchanged.
//
// Resolved by name, at issue time, because the stored mapping that used to do this
// (`crm_price_map`) lived only in Postgres and went with it. The name is also what
// the office reads in the CRM, so there is nothing to keep in step.
const DEPOSIT_PRODUCT_NAMES = Object.freeze({
  'deposit-small': 'Booking Deposit (Standard)',
  'deposit-large': 'Booking Deposit (Large Vehicle)'
});
const PRODUCT_CATALOG_TTL_MS = 10 * 60 * 1000;
let productCache = null;

function resetProductCache() {
  productCache = null;
}

// Every product in the sub-account, by name. One listing serves both deposits and
// covers a renamed or re-created product within the quarter hour.
async function productsByName(config) {
  const now = Date.now();
  if (productCache && productCache.locationId === config.locationId && productCache.expiresAt > now) {
    return productCache.byName;
  }
  const query = new URLSearchParams({ locationId: config.locationId, limit: '100' });
  const data = await ghl.ghlRequest(config, `/products/?${query}`, { version: INVOICE_VERSION });
  const byName = new Map(
    (data.products || []).map(product => [String(product.name || '').trim(), String(product._id || product.id || '')])
  );
  productCache = { locationId: config.locationId, byName, expiresAt: now + PRODUCT_CATALOG_TTL_MS };
  return byName;
}

// The price on that product matching what we are charging. Matched on AMOUNT rather
// than taken first, so a product that later grows a second price cannot silently
// attach the wrong one to the invoice.
async function priceIdFor(config, productId, amountCents) {
  const query = new URLSearchParams({ locationId: config.locationId, limit: '20' });
  const data = await ghl.ghlRequest(config, `/products/${encodeURIComponent(productId)}/price?${query}`, {
    version: INVOICE_VERSION
  });
  const prices = data.prices || [];
  const match = prices.find(price => Math.round(Number(price.amount) * 100) === amountCents);
  return match ? String(match._id || match.id || '') : '';
}

// Attaches the CRM product and price to the lines that have one.
//
// **Fails OPEN.** A lookup that breaks leaves the line exactly as it was — free text,
// correct amount, payable. Losing the customer their deposit link over a product
// listing would be a far worse trade than losing the trigger on one booking, and the
// office can still confirm that booking by hand.
async function attachCrmProducts(config, lines) {
  const wanted = lines.filter(line => line.kind === 'deposit');
  if (!wanted.length) return lines;
  try {
    const byName = await productsByName(config);
    for (const line of wanted) {
      const productId = byName.get(String(line.name).trim());
      if (!productId) continue;
      line.crmProductId = productId;
      const priceId = await priceIdFor(config, productId, line.amountCents);
      if (priceId) line.crmPriceId = priceId;
    }
  } catch (error) {
    console.error('[payment-links] CRM products unresolved; invoicing by name', error.name || 'Error', error.statusCode || '');
  }
  return lines;
}

// ── Issuing ────────────────────────────────────────────────────────────────

// The CRM invoice payload. Each item carries BOTH the resolved product/price ids
// and the name and amount from our catalog: if HighLevel honours the ids the
// invoice is composed of real products and reports per product; if it ignores
// them, the amount charged is still the server-computed one. Either way the
// customer is never charged a number that came from a browser.
function invoicePayload({ config, contact, lines, name, liveMode }) {
  return {
    altId: config.locationId,
    altType: 'location',
    name: String(name).slice(0, 160),
    currency: 'USD',
    items: lines.map(line => ({
      name: line.name,
      currency: 'USD',
      amount: centsToMajor(line.amountCents),
      qty: line.quantity || 1,
      ...(line.crmProductId ? { productId: line.crmProductId } : {}),
      ...(line.crmPriceId ? { priceId: line.crmPriceId } : {})
    })),
    contactDetails: {
      id: contact.id,
      name: contact.name,
      phoneNo: contact.phone,
      email: contact.email
    },
    issueDate: new Date().toISOString().slice(0, 10),
    sentTo: { email: contact.email ? [contact.email] : [] },
    liveMode,
    // 'send' publishes the invoice so the hosted link is payable. A draft returns a
    // URL whose page reads "Draft invoice cannot be paid" — verified against the
    // live sub-account when the deposit flow was built.
    action: 'send',
    userId: config.assignedUserId
  };
}

// Creates the link, or returns the one that already exists for this key.
//
// `idempotencyKey` must describe WHAT the link is for — a hold, a contract, an
// office quote reference — never when it was requested.
async function issuePaymentLink({
  idempotencyKey,
  purpose,
  origin,
  contact,
  lines,
  holdId = null,
  parentBookingId = null,
  contractId = null,
  createdBy = null,
  config = null
}) {
  if (!PURPOSES.includes(purpose)) throw new RequestError('purpose is invalid', 400, 'PAYMENT_LINK_INVALID');
  if (!ORIGINS.includes(origin)) throw new RequestError('origin is invalid', 400, 'PAYMENT_LINK_INVALID');
  if (!contact || !contact.id) throw new RequestError('A CRM contact is required', 400, 'PAYMENT_LINK_INVALID');

  const activeConfig = config || ghl.getConfig();
  const amountCents = totalCents(lines);
  const name = paymentLinkName({ purpose, holdId, contractId, createdBy });

  // Has this already been invoiced? The name is deterministic, so an invoice under it
  // IS an earlier attempt at this same link. Asked before creating, which is what
  // makes a retry after a timeout safe: the customer gets the first invoice back
  // rather than a second one for the same job.
  const existingInvoice = await ghl.findInvoiceByName(activeConfig, name);
  const existingUrl = existingInvoice && typeof existingInvoice.invoiceUrl === 'string' ? existingInvoice.invoiceUrl : '';
  if (existingInvoice && existingUrl) {
    return {
      url: existingUrl,
      invoiceId: String(existingInvoice._id || existingInvoice.id || ''),
      amount: centsToMajor(amountCents),
      status: 'issued',
      duplicate: true
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    const result = await ghl.ghlRequest(activeConfig, '/invoices/text2pay', {
      method: 'POST',
      version: 'v3',
      signal: controller.signal,
      body: invoicePayload({
        config: activeConfig,
        contact,
        lines: await attachCrmProducts(activeConfig, lines),
        name,
        liveMode: Boolean(activeConfig.depositPaymentsLiveMode)
      })
    });
    const url = result && typeof result.invoiceUrl === 'string' ? result.invoiceUrl : '';
    const invoiceId = result && result.invoice && result.invoice._id ? String(result.invoice._id) : '';
    if (!url) throw new RequestError('The CRM did not return a payable link', 502, 'PAYMENT_LINK_FAILED');
    return { url, invoiceId, amount: centsToMajor(amountCents), status: 'issued', duplicate: false };
  } catch (error) {
    // Nothing to mark failed: an invoice that was never created leaves no trace, and
    // one that WAS created is found by the lookup above on the next attempt.
    throw error instanceof RequestError
      ? error
      : new RequestError('Could not create the payment link', 502, 'PAYMENT_LINK_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

function paymentLinkName({ purpose, holdId, contractId, createdBy }) {
  if (purpose === 'booking_deposit') return `Booking Deposit — hold:${holdId}`;
  if (purpose === 'membership') return `Membership — contract:${contractId}`;
  if (purpose === 'service') return `Service — hold:${holdId || 'quote'}`;
  return `L&B Elite Wash & Detail${createdBy ? ` — ${createdBy}` : ''}`;
}

module.exports = {
  PURPOSES,
  ORIGINS,
  INVOICE_VERSION,
  centsToMajor,
  buildLines,
  totalCents,
  invoicePayload,
  paymentLinkName,
  issuePaymentLink,
  attachCrmProducts,
  resetProductCache
};
