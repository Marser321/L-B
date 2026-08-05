'use strict';

const { RequestError } = require('./errors.js');
const membershipCatalog = require('./membership-catalog.js');
const provisioning = require('./crm-membership-provisioning.js');

// CREATING a schedule is pinned to this dated version. READING one is not: HighLevel
// serves the read endpoints under v3, and asking for them with the dated version fails.
//
// This is not a guess. The probe endpoint that was deleted in b2a7e21 carried the note
// in its source — "HighLevel's create-schedule API is pinned to 2023-02-21, whereas the
// read endpoint is currently served under v3" — and used v3 for its own read. That
// endpoint is the only code here that was ever run against the real sub-account.
const INVOICE_VERSION = '2023-02-21';
const INVOICE_READ_VERSION = 'v3';

function idOf(value) {
  return String(value && (value._id || value.id) || '').trim();
}

function rows(value, key) {
  return Array.isArray(value && value[key]) ? value[key] : [];
}

// Where HighLevel actually puts the id of a schedule it just created: at the TOP LEVEL
// of the response, verified 5 ago 2026 against the real sub-account —
//   { _id, status, liveMode, deleted, altId, altType, templateId, name, contactDetails,
//     schedule, createdAt, ..., invoices, businessDetails, currency, items, discount }
//
// The obvious-looking `response.schedule ?? response` fallback is a trap here: this API
// DOES have a `schedule` key, but it holds the rrule, not the schedule object. Descending
// into it finds no id, so the caller concluded the CRM had not created anything — while
// it had, leaving an orphan subscription behind on every attempt.
function scheduleIdFrom(response) {
  const direct = idOf(response);
  if (direct) return direct;
  for (const key of ['invoiceSchedule', 'data', 'result']) {
    const nested = idOf(response && response[key]);
    if (nested) return nested;
  }
  return '';
}

// The invoice endpoints scope by altId/altType, NOT by locationId — passing the latter
// gets a 422. Kept in one place so a read cannot drift from a write.
function scheduleQuery(config) {
  return new URLSearchParams({ altId: config.locationId, altType: 'location' }).toString();
}

function dateInTimeZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function findProduct(products, packageId) {
  const marker = provisioning.productDescription(packageId);
  const product = products.find(candidate => marker === String(candidate && candidate.description || '') ||
    String(candidate && candidate.description || '').includes(provisioning.productMarker(packageId)));
  if (!idOf(product)) throw new RequestError('This membership is not available yet', 503, 'MEMBERSHIP_CATALOG_UNAVAILABLE');
  return product;
}

async function resolveItem({ config, request, packageId, sizeId, vehicleLabel, requestId }) {
  const entry = membershipCatalog.entries().find(candidate => candidate.packageId === packageId && candidate.sizeId === sizeId);
  if (!entry) throw new RequestError('Membership plan or size is invalid', 422, 'MEMBERSHIP_INVALID');
  const listed = await request(config, `/products/?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`, { requestId });
  const product = findProduct(rows(listed, 'products'), packageId);
  const productId = idOf(product);
  const prices = await request(config, `/products/${encodeURIComponent(productId)}/price?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`, { requestId });
  const price = rows(prices, 'prices').find(candidate => provisioning.matchingPrice(candidate, entry));
  const priceId = idOf(price);
  if (!priceId) throw new RequestError('This membership price is not available yet', 503, 'MEMBERSHIP_CATALOG_UNAVAILABLE');
  // `entry.priceLabel`, not `entry.label` — the latter does not exist on a membership
  // catalog entry, so the item went out with no name at all and HighLevel rejected the
  // whole schedule with 422 "items.0.name should not be empty". JSON.stringify drops
  // undefined keys, which is why the field vanished silently instead of erroring here.
  //
  // priceLabel is the size-specific line ("Membresía 2x — Cars & SUVs · Sedan"), which
  // is what the customer should read on a monthly invoice.
  const name = String(entry.priceLabel || entry.productLabel || '').trim();
  if (!name) throw new RequestError('This membership has no invoice label', 503, 'MEMBERSHIP_CATALOG_UNAVAILABLE');

  return {
    name,
    description: vehicleLabel,
    productId,
    priceId,
    currency: 'USD',
    amount: provisioning.crmAmount(entry),
    qty: 1,
    type: 'recurring',
    taxInclusive: false,
    taxes: []
  };
}

// The schedule's name is DERIVED from the contract, never invented. That is what makes
// it findable again: a retry that lost its response can ask the CRM "is there already a
// schedule for this contract?" instead of creating a second one that bills every month.
function scheduleName(reference) {
  return `L&B Membership — ${reference}`.slice(0, 80);
}

function schedulePayload({ config, contact, item, reference, now, liveMode, timeZone }) {
  const startDate = dateInTimeZone(now, timeZone);
  const dayOfMonth = Math.min(Number(startDate.slice(-2)), 28);
  return {
    altId: config.locationId,
    altType: 'location',
    name: scheduleName(reference),
    contactDetails: {
      id: contact.id, name: contact.name, phoneNo: contact.phone,
      email: contact.email || '', additionalEmails: [], companyName: '',
      address: { countryCode: 'US' }, customFields: []
    },
    schedule: { rrule: {
      intervalType: 'monthly', interval: 1, startDate, startTime: '00:00:00',
      dayOfMonth, daysBefore: 0, useStartAsPrimaryUserAccepted: true, endType: 'never'
    } },
    liveMode: Boolean(liveMode),
    businessDetails: {
      name: 'L & B Elite Wash & Detail', phoneNo: '+12395270770',
      address: { addressLine1: '3049 14th ave ne', city: 'Naples', state: 'FL', countryCode: 'US', postalCode: '34120' },
      website: 'https://lbelitewashd.com/', customValues: []
    },
    currency: 'USD', items: [item], automaticTaxesEnabled: false,
    discount: { value: 0, type: 'percentage', validOnProductIds: [] },
    title: 'MEMBERSHIP INVOICE',
    termsNotes: `Monthly membership. Contract ${reference}.`,
    invoiceNumberPrefix: 'MEM-', paymentMethods: { stripe: { enableBankDebitOnly: false } }
  };
}

function payableUrl(value) {
  const candidates = [];
  const visit = candidate => {
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (typeof nested === 'string' && /^(invoiceUrl|paymentUrl|checkoutUrl|hostedInvoiceUrl|url)$/i.test(key) && /^https:\/\//.test(nested)) candidates.push(nested);
      else if (nested && typeof nested === 'object') visit(nested);
    }
  };
  visit(value);
  return candidates[0] || '';
}

// Is there already a recurring schedule for this contract? Best-effort recovery for
// the one window that matters: HighLevel created the schedule and the caller never
// found out. Deliberately tolerant about the response shape — the exact envelope of
// this endpoint is still being pinned down, and a lookup that throws on an unexpected
// key would be worse than one that returns nothing, because the caller falls back to
// refusing rather than to duplicating.
async function findScheduleByReference({ config, request, reference }) {
  const query = new URLSearchParams({ altId: config.locationId, altType: 'location', limit: '100', offset: '0' });
  let listed;
  try {
    listed = await request(config, `/invoices/schedule?${query}`, { version: INVOICE_READ_VERSION, requestId: reference });
  } catch (error) {
    return '';
  }
  const candidates = [
    ...(Array.isArray(listed) ? listed : []),
    ...rows(listed, 'schedules'),
    ...rows(listed, 'data'),
    ...rows(listed, 'invoiceSchedules')
  ];
  const wanted = scheduleName(reference);
  return idOf(candidates.find(candidate => String(candidate && candidate.name || '') === wanted));
}

// The payable URL of a schedule that already exists, so a retry can hand the customer
// the same link instead of a second subscription.
async function scheduleUrl({ config, request, scheduleId, reference }) {
  try {
    const fetched = await request(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}?${scheduleQuery(config)}`, {
      version: INVOICE_READ_VERSION, requestId: reference
    });
    return payableUrl(fetched);
  } catch (error) {
    return '';
  }
}

async function createAndSchedule({ config, request, contact, packageId, sizeId, vehicleLabel, reference, now = Date.now(), timeZone }) {
  const item = await resolveItem({ config, request, packageId, sizeId, vehicleLabel, requestId: reference });
  const draft = await request(config, '/invoices/schedule', {
    method: 'POST', version: INVOICE_VERSION, requestId: reference, diagnostic: true,
    body: schedulePayload({ config, contact, item, reference, now, liveMode: config.membershipPaymentsLiveMode, timeZone })
  });
  const scheduleId = scheduleIdFrom(draft);
  if (!scheduleId) throw new RequestError('CRM did not create the recurring invoice', 502, 'MEMBERSHIP_SCHEDULE_FAILED');
  // Activation is what takes the schedule from `draft` to `active`. Without it the
  // subscription exists and bills nobody, which is what the four leftover drafts in the
  // account are. All of this was established by calling it (5 ago 2026):
  //
  //   body {}                                  → 422 naming altId, altType, liveMode
  //   + altId/altType/liveMode                 → 500 "Cannot read properties of
  //                                              undefined (reading 'enable')"
  //   + autoPayment.enable                     → 200, status draft → scheduled → active
  //
  // `enable: false` means HighLevel emails an invoice every cycle and the member pays it,
  // rather than charging a stored card automatically. That is the conservative default:
  // auto-charging needs a saved payment method that does not exist until the first
  // invoice is paid, and nothing here should ever move money without the member acting.
  const scheduled = await request(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}/schedule`, {
    method: 'POST', version: INVOICE_VERSION, requestId: reference,
    body: {
      altId: config.locationId,
      altType: 'location',
      liveMode: Boolean(config.membershipPaymentsLiveMode),
      autoPayment: { enable: false }
    }
  });
  let url = payableUrl(scheduled) || payableUrl(draft);
  if (!url) {
    const fetched = await request(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}?${scheduleQuery(config)}`, {
      version: INVOICE_READ_VERSION, requestId: reference
    });
    url = payableUrl(fetched);
  }
  return { scheduleId, url, monthlyAmount: item.amount, liveMode: Boolean(config.membershipPaymentsLiveMode) };
}

// ── Turning a membership into a real recurring CHARGE ──────────────────────
//
// A schedule is activated with `autoPayment.enable = false`, and that is not a choice:
// HighLevel's enum for `autoPayment.type` is `saved_card`, and enabling it requires a
// `customerId` and a `paymentMethodId` that DO NOT EXIST until the member has paid once.
// Verified 5 ago 2026 — every other value of `type` is rejected as an invalid enum, and
// `saved_card` without those two ids is a 422.
//
// So the first cycle is an emailed invoice the member pays by hand, and from the second
// cycle on it can be charged automatically. That upgrade is what this does, on the
// payment webhook, once a card actually exists.
//
// There is no endpoint that lists a contact's saved payment methods, so the ids are
// mined from what the payment left behind. The shape of a paid transaction could not be
// confirmed — the sub-account has never taken a payment — so this reads defensively and
// treats "not found" as normal rather than as an error.

function firstString(source, keys) {
  for (const key of keys) {
    const value = source && source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// Looks for the customer/payment-method pair a completed payment leaves behind, first on
// the invoice itself and then on the location's transactions.
async function findSavedCard({ config, request, contactId, invoiceId }) {
  const probes = [];
  if (invoiceId) {
    probes.push(() => request(config, `/invoices/${encodeURIComponent(invoiceId)}?${scheduleQuery(config)}`, { version: INVOICE_READ_VERSION }));
  }
  probes.push(() => request(
    config,
    `/payments/transactions?${new URLSearchParams({ altId: config.locationId, altType: 'location', contactId: contactId || '', limit: '20' })}`,
    { version: INVOICE_READ_VERSION }
  ));

  for (const probe of probes) {
    let data;
    try { data = await probe(); } catch (error) { continue; }
    const rows = Array.isArray(data && data.data) ? data.data : [data];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      // The ids may sit on the row or one level down, depending on the endpoint.
      for (const candidate of [row, row.payment, row.paymentMethod, row.customer, row.meta]) {
        if (!candidate || typeof candidate !== 'object') continue;
        const paymentMethodId = firstString(candidate, ['paymentMethodId', 'paymentMethod_id', 'sourceId', 'cardId']);
        const customerId = firstString(candidate, ['customerId', 'customer_id', 'stripeCustomerId']);
        if (paymentMethodId && customerId) return { customerId, paymentMethodId };
      }
    }
  }
  return null;
}

// Best effort by design: a membership whose auto-charge could not be turned on still
// bills correctly, because HighLevel keeps emailing the invoice every cycle. Failing
// here must never disturb granting the cycle the member already paid for.
async function enableAutoPayment({ config, request, scheduleId, contactId, invoiceId }) {
  if (!scheduleId) return { enabled: false, reason: 'no-schedule' };
  const card = await findSavedCard({ config, request, contactId, invoiceId });
  if (!card) return { enabled: false, reason: 'no-saved-card' };
  try {
    await request(config, `/invoices/schedule/${encodeURIComponent(scheduleId)}/auto-payment`, {
      method: 'POST', version: INVOICE_VERSION,
      body: {
        altId: config.locationId, altType: 'location',
        id: scheduleId,
        autoPayment: { enable: true, type: 'saved_card', customerId: card.customerId, paymentMethodId: card.paymentMethodId }
      }
    });
    return { enabled: true };
  } catch (error) {
    return { enabled: false, reason: `rejected-${error.statusCode || 'error'}` };
  }
}

module.exports = {
  INVOICE_VERSION, INVOICE_READ_VERSION, dateInTimeZone, resolveItem, scheduleName,
  schedulePayload, payableUrl, scheduleIdFrom, findScheduleByReference, scheduleUrl,
  createAndSchedule, findSavedCard, enableAutoPayment
};
