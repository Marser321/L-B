'use strict';

// CRM-managed recurring memberships.
//
// HighLevel owns the connected Stripe account and customer-facing payment
// screen. The browser never receives a CRM product/price id and never decides
// an amount. This module looks up the marked CRM catalogue, builds an invoice
// schedule in the requested mode, and deliberately keeps creating a draft
// separate from scheduling/sending it.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');
const membershipCatalog = require('./membership-catalog.js');
const provisioning = require('./crm-membership-provisioning.js');

const INVOICE_VERSION = '2023-02-21';
const CONTACT_VERSION = '2021-07-28';
const TEST_DRAFT_NOTICE_MS = 48 * 60 * 60 * 1000;

function idOf(value) {
  return String(value && (value._id || value.id) || '').trim();
}

function rows(value, key) {
  return Array.isArray(value && value[key]) ? value[key] : [];
}

function dateInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function testReference() {
  return `crm-recurring-test-${crypto.randomUUID().slice(0, 8)}`;
}

function makeTestCustomer(reference) {
  // A reserved .test address is intentionally non-deliverable. `dnd` is also
  // sent to the CRM, so creating the test contact cannot start communication.
  return {
    name: 'L&B CRM Billing Test',
    firstName: 'L&B',
    lastName: 'CRM Test',
    email: `${reference}@example.test`,
    phone: '+12025550199'
  };
}

function contactPayload(config, customer, reference) {
  return {
    locationId: config.locationId,
    name: customer.name,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    source: 'L&B CRM recurring billing test',
    tags: ['l-b-automated-test', reference],
    dnd: true,
    createNewIfDuplicateAllowed: false
  };
}

async function upsertTestContact({ config, request, customer, reference }) {
  const result = await request(config, '/contacts/upsert', {
    method: 'POST', version: CONTACT_VERSION, requestId: reference,
    body: contactPayload(config, customer, reference)
  });
  const contact = result && (result.contact || result);
  const id = idOf(contact);
  if (!id) throw new RequestError('CRM did not return a test contact id', 502, 'CRM_MEMBERSHIP_CONTACT_FAILED');
  return { id, ...customer };
}

function findProduct(products, packageId) {
  const product = products.find(candidate => provisioning.productDescription(packageId) === String(candidate && candidate.description || '') ||
    String(candidate && candidate.description || '').includes(provisioning.productMarker(packageId)));
  if (!product || !idOf(product)) {
    throw new RequestError('A membership is not available for purchase yet', 503, 'CRM_MEMBERSHIP_CATALOG_UNAVAILABLE');
  }
  return product;
}

function catalogPriceEntry(packageId, sizeId) {
  const entry = membershipCatalog.entries().find(candidate =>
    candidate.packageId === packageId && candidate.sizeId === sizeId
  );
  if (!entry) throw new RequestError('A membership is not available for purchase yet', 422, 'CRM_MEMBERSHIP_CATALOG_UNAVAILABLE');
  return entry;
}

async function resolveInvoiceItems({ config, request, lines, requestId }) {
  const list = await request(config, `/products/?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`, {
    requestId
  });
  const products = rows(list, 'products');
  const byPackage = new Map();
  for (const line of lines) {
    if (!byPackage.has(line.packageId)) byPackage.set(line.packageId, findProduct(products, line.packageId));
  }

  const priceLists = new Map();
  for (const [packageId, product] of byPackage) {
    const productId = idOf(product);
    const response = await request(config, `/products/${encodeURIComponent(productId)}/price?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`, {
      requestId
    });
    priceLists.set(packageId, { productId, prices: rows(response, 'prices') });
  }

  return lines.map(line => {
    // `priceFor` is intentionally the compact public quote representation;
    // the CRM adapter needs the complete authoritative recurring-price record
    // including the customer-readable HighLevel price name.
    const entry = catalogPriceEntry(line.packageId, line.sizeId);
    const resolved = priceLists.get(line.packageId);
    const price = resolved.prices.find(candidate => provisioning.matchingPrice(candidate, entry));
    const priceId = idOf(price);
    if (!priceId) {
      throw new RequestError('A membership is not available for purchase yet', 503, 'CRM_MEMBERSHIP_CATALOG_UNAVAILABLE');
    }
    return {
      name: entry.priceLabel,
      description: line.vehicleLabel,
      productId: resolved.productId,
      priceId,
      currency: entry.currency.toUpperCase(),
      amount: provisioning.crmAmount(entry),
      qty: 1,
      type: 'recurring',
      taxInclusive: false,
      taxes: []
    };
  });
}

function schedulePayload({ config, contact, items, now, liveMode, reference, timeZone }) {
  const startDate = dateInTimeZone(now, timeZone);
  return {
    altId: config.locationId,
    altType: 'location',
    name: `L&B Membership ${reference}`.slice(0, 80),
    contactDetails: {
      id: contact.id,
      name: contact.name,
      phoneNo: contact.phone,
      email: contact.email,
      address: { countryCode: 'US' },
      customFields: []
    },
    schedule: {
      // HighLevel's Schedule API stores this as an ISO instant, while its
      // rrule remains anchored to the location's calendar date below.
      executeAt: `${startDate}T00:00:00.000Z`,
      rrule: {
        intervalType: 'monthly',
        interval: 1,
        startDate,
        startTime: '00:00:00',
        // The CRM UI's monthly membership default bills on the first day of
        // the cycle. It also avoids the API's 1–28 monthly day constraint.
        dayOfMonth: 1,
        // HighLevel requires this field even when the invoice is due/sent on
        // the recurring date itself. Omitting zero produces a 400 before any
        // schedule exists.
        daysBefore: 0,
        useStartAsPrimaryUserAccepted: true,
        // A test creates a draft only. A production transition will call the
        // separate schedule endpoint after an explicit checkout approval.
        endType: 'never'
      }
    },
    liveMode: Boolean(liveMode),
    businessDetails: { name: 'L & B Elite Wash & Detail' },
    currency: 'USD',
    items,
    discount: { value: 0, type: 'percentage' },
    title: 'INVOICE',
    termsNotes: 'L&B automated CRM integration test. Do not schedule or send.',
    paymentMethods: { stripe: { enableBankDebitOnly: false } },
    automaticTaxesEnabled: false
  };
}

async function createRecurringDraft({ config, request, lines, now = Date.now(), reference = testReference(), liveMode = false, timeZone }) {
  if (liveMode) throw new RequestError('Test draft must use test payment mode', 422, 'CRM_MEMBERSHIP_TEST_MODE_REQUIRED');
  const customer = makeTestCustomer(reference);
  const contact = await upsertTestContact({ config, request, customer, reference });
  const items = await resolveInvoiceItems({ config, request, lines, requestId: reference });
  const result = await request(config, '/invoices/schedule', {
    method: 'POST', version: INVOICE_VERSION, requestId: reference, diagnostic: true,
    // HighLevel requires a future recurrence start for a draft schedule. Keep
    // the probe consistent with the server-owned 48-hour membership policy.
    body: schedulePayload({ config, contact, items, now: now + TEST_DRAFT_NOTICE_MS, liveMode: false, reference, timeZone })
  });
  const scheduleId = idOf(result && (result.schedule || result));
  if (!scheduleId) throw new RequestError('CRM did not return a recurring invoice draft', 502, 'CRM_MEMBERSHIP_DRAFT_FAILED');
  return {
    reference,
    scheduleId,
    status: String(result && result.status || 'draft'),
    liveMode: Boolean(result && result.liveMode),
    lineCount: items.length,
    monthlyTotal: items.reduce((sum, item) => sum + item.amount * item.qty, 0)
  };
}

module.exports = {
  INVOICE_VERSION,
  CONTACT_VERSION,
  TEST_DRAFT_NOTICE_MS,
  dateInTimeZone,
  makeTestCustomer,
  contactPayload,
  findProduct,
  catalogPriceEntry,
  resolveInvoiceItems,
  schedulePayload,
  createRecurringDraft
};
