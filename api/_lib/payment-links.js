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
// Idempotency is a claimed row in `payment_links`, keyed by what the link is FOR.
// Two clicks on "send payment link", or a retry after a timeout, return the first
// link instead of issuing a second invoice.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');
const catalog = require('./catalog.js');
const pricing = require('./pricing.js');
const membershipCatalog = require('./membership-catalog.js');
const crmCatalog = require('./crm-catalog.js');
const ghl = require('./ghl.js');
const { getRepository } = require('./repository.js');

const PURPOSES = Object.freeze(['booking_deposit', 'service', 'membership', 'manual']);
const ORIGINS = Object.freeze(['web', 'office']);
const INVOICE_VERSION = '2021-07-28';
const LINK_TIMEOUT_MS = 8 * 1000;

function newId() {
  return crypto.randomUUID();
}

function centsToMajor(cents) {
  return Math.round(cents) / 100;
}

// Looks up the CRM product/price backing a catalog identifier. Returns null when
// the catalog has not been provisioned yet, which the caller reports as a
// configuration problem rather than silently charging an unlinked amount.
async function crmPriceFor(repository, query, livemode) {
  return repository.findCrmPrice({ ...query, livemode });
}

// ── Line building ──────────────────────────────────────────────────────────

// One line per vehicle service, one per add-on. Amounts come from pricing.js; the
// CRM ids are attached when the catalog has been provisioned, so the invoice is
// composed of real products and can be reported on by product.
async function buildLines({ purpose, vehicles = [], deposit = null, contract = null, livemode, repository = getRepository() }) {
  const lines = [];

  if (purpose === 'membership') {
    if (!contract) throw new RequestError('A membership contract is required', 400, 'PAYMENT_LINK_INVALID');
    const price = membershipCatalog.priceFor(contract.packageId, contract.sizeId);
    const crmPrice = await crmPriceFor(repository, {
      kind: 'membership', packageId: contract.packageId, sizeId: contract.sizeId
    }, livemode);
    lines.push({
      kind: 'membership',
      name: price.label,
      amountCents: price.monthlyCents,
      quantity: 1,
      packageId: contract.packageId,
      sizeId: contract.sizeId,
      crmProductId: crmPrice ? crmPrice.crmProductId : null,
      crmPriceId: crmPrice ? crmPrice.crmPriceId : null
    });
    return lines;
  }

  for (const vehicle of vehicles) {
    const bounds = pricing.packagePriceBounds(vehicle.packageId, vehicle.sizeId);
    const crmPrice = await crmPriceFor(repository, {
      kind: 'service', packageId: vehicle.packageId, sizeId: vehicle.sizeId
    }, livemode);
    lines.push({
      kind: 'service',
      name: `${crmCatalog.packageName(vehicle.packageId)} · ${crmCatalog.sizeName(vehicle.sizeId)}`,
      amountCents: Math.round(bounds.min * 100),
      quantity: 1,
      packageId: vehicle.packageId,
      sizeId: vehicle.sizeId,
      crmProductId: crmPrice ? crmPrice.crmProductId : null,
      crmPriceId: crmPrice ? crmPrice.crmPriceId : null
    });

    for (const addonId of vehicle.addonIds || []) {
      const addonBounds = pricing.addonPriceBounds(addonId);
      // A custom-quote add-on has no amount and no product; it is recorded on the
      // line list so the office sees it, but it is never charged automatically.
      if (addonBounds.custom || !(addonBounds.min > 0)) continue;
      const crmAddon = await crmPriceFor(repository, { kind: 'addon', addonId }, livemode);
      lines.push({
        kind: 'addon',
        name: crmCatalog.addonName(addonId),
        amountCents: Math.round(addonBounds.min * 100),
        quantity: 1,
        addonId,
        crmProductId: crmAddon ? crmAddon.crmProductId : null,
        crmPriceId: crmAddon ? crmAddon.crmPriceId : null
      });
    }
  }

  if (deposit) {
    const productKey = deposit.amount >= catalog.DEPOSIT_LARGE ? 'deposit-large' : 'deposit-small';
    const crmDeposit = await crmPriceFor(repository, { kind: 'deposit', productKey }, livemode);
    lines.push({
      kind: 'deposit',
      name: productKey === 'deposit-large' ? 'Booking Deposit (Large Vehicle)' : 'Booking Deposit (Standard)',
      amountCents: Math.round(deposit.amount * 100),
      quantity: 1,
      crmProductId: crmDeposit ? crmDeposit.crmProductId : null,
      crmPriceId: crmDeposit ? crmDeposit.crmPriceId : null
    });
  }

  if (!lines.length) throw new RequestError('A payment link needs at least one line', 400, 'PAYMENT_LINK_EMPTY');
  return lines;
}

function totalCents(lines) {
  return lines.reduce((total, line) => total + line.amountCents * (line.quantity || 1), 0);
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
  config = null,
  now = Date.now()
}) {
  if (!PURPOSES.includes(purpose)) throw new RequestError('purpose is invalid', 400, 'PAYMENT_LINK_INVALID');
  if (!ORIGINS.includes(origin)) throw new RequestError('origin is invalid', 400, 'PAYMENT_LINK_INVALID');
  if (!contact || !contact.id) throw new RequestError('A CRM contact is required', 400, 'PAYMENT_LINK_INVALID');

  const repository = getRepository();
  const activeConfig = config || ghl.getConfig();
  const amountCents = totalCents(lines);

  const claim = await repository.transaction([`payment-link:${idempotencyKey}`], async tx => tx.insertPaymentLink({
    id: newId(),
    idempotencyKey,
    purpose,
    origin,
    holdId,
    parentBookingId,
    contractId,
    contactId: contact.id,
    lines,
    amountCents,
    createdBy
  }));

  if (!claim.inserted) {
    // Someone already asked for this link. Hand back what they got rather than
    // billing the customer twice for the same thing.
    const existing = await repository.getPaymentLinkByKey(idempotencyKey);
    return {
      url: existing ? existing.url : null,
      invoiceId: existing ? existing.crmInvoiceId : null,
      amount: existing ? centsToMajor(existing.amountCents) : centsToMajor(amountCents),
      status: existing ? existing.status : 'pending',
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
        lines,
        name: paymentLinkName({ purpose, holdId, contractId, createdBy }),
        liveMode: Boolean(activeConfig.depositPaymentsLiveMode)
      })
    });
    const url = result && typeof result.invoiceUrl === 'string' ? result.invoiceUrl : '';
    const invoiceId = result && result.invoice && result.invoice._id ? String(result.invoice._id) : '';
    if (!url) throw new RequestError('The CRM did not return a payable link', 502, 'PAYMENT_LINK_FAILED');

    await repository.transaction([`payment-link:${idempotencyKey}`], async tx => {
      await tx.markPaymentLinkIssued(idempotencyKey, { crmInvoiceId: invoiceId, url });
    });
    return { url, invoiceId, amount: centsToMajor(amountCents), status: 'issued', duplicate: false };
  } catch (error) {
    // The claim stays, marked failed, so the failure is visible and a retry with
    // the same key does not silently create a second invoice behind it.
    await repository.transaction([`payment-link:${idempotencyKey}`], async tx => {
      await tx.markPaymentLinkFailed(idempotencyKey, error.message);
    });
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
  issuePaymentLink
};
