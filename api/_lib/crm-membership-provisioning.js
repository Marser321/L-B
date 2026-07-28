'use strict';

// HighLevel/CRM membership catalog provisioner.
//
// Recurring charges live in the CRM's connected Stripe account. This module
// only creates the 17 service products and their 33 monthly CRM prices; it
// never creates a payment link, invoice, contact, subscription, or booking.
// Existing deposit products are deliberately out of scope: an object must
// carry this exact catalog marker before the provisioner can reuse it.

const membershipCatalog = require('./membership-catalog.js');
const { RequestError } = require('./errors.js');

const PRODUCT_MARKER_PREFIX = 'lyb-membership-catalog';
const PRICE_MARKER_PREFIX = 'lyb-membership-price';

function productMarker(packageId) {
  return `${PRODUCT_MARKER_PREFIX}:v${membershipCatalog.CATALOG_VERSION}:${packageId}`;
}

function priceMarker(entry) {
  return `${PRICE_MARKER_PREFIX}:v${membershipCatalog.CATALOG_VERSION}:${entry.packageId}:${entry.sizeId}`;
}

// Price names are displayed in HighLevel's payment-link picker, so they must
// remain customer-readable. `priceMarker` is kept only to recognise and safely
// migrate the first provisioned catalog revision, which used it as the name.
function priceName(entry) {
  return entry.priceLabel;
}

function productDescription(packageId) {
  return `${productMarker(packageId)}\nManaged by the L&B Elite Wash & Detail membership catalog. Do not use for one-time deposits.`;
}

function productId(product) {
  return String((product && (product._id || product.id)) || '').trim();
}

function listFrom(response, key) {
  return Array.isArray(response && response[key]) ? response[key] : [];
}

function hasProductMarker(product, packageId) {
  return String((product && product.description) || '').includes(productMarker(packageId));
}

function hasPriceMarker(price, entry) {
  const name = String((price && price.name) || '');
  return name === priceMarker(entry) || name === priceName(entry);
}

// HighLevel's Products API represents an amount in major currency units. The
// membership catalog deliberately keeps money in cents for the application and
// database, so the boundary must convert exactly once here. Sending cents to
// HighLevel would turn a $130 membership into $13,000.
function crmAmount(entry) {
  return entry.monthlyCents / 100;
}

function matchingPrice(price, entry) {
  return String((price && price.name) || '') === priceName(entry) &&
    String(price.priceType || price.type || '').toLowerCase() === 'recurring' &&
    Number(price.amount) === crmAmount(entry) &&
    String(price.currency || '').toLowerCase() === entry.currency &&
    String(price.recurring && price.recurring.interval || '').toLowerCase() === entry.interval &&
    Number(price.recurring && price.recurring.intervalCount) === 1;
}

function productPayload(product, locationId) {
  return {
    name: product.label,
    locationId,
    description: productDescription(product.packageId),
    productType: 'SERVICE',
    availableInStore: false,
    isTaxesEnabled: false,
    taxInclusive: false
  };
}

function pricePayload(entry, locationId) {
  return {
    name: priceName(entry),
    locationId,
    // HighLevel's creation endpoint calls this field `type`; `priceType` is
    // present on returned objects and webhooks, but is not a writable field.
    type: 'recurring',
    currency: entry.currency.toUpperCase(),
    // HighLevel uses major currency units, unlike the server catalog which
    // intentionally stores money in cents.
    amount: crmAmount(entry),
    recurring: { interval: entry.interval, intervalCount: 1 }
  };
}

function assertCreatedId(result, kind) {
  const id = productId(result && (result[kind] || result));
  if (!id) throw new RequestError(`CRM did not return a ${kind} id`, 502, 'CRM_MEMBERSHIP_PROVISION_FAILED');
  return id;
}

async function mapWithConcurrency(items, limit, mapper) {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await mapper(items[index]);
    }
  });
  await Promise.all(workers);
}

// request is `ghlRequest(config, path, options)`, injected so this business
// logic is testable without a CRM account. A small bounded pool keeps the
// protected serverless operation within its time budget; every successful
// object still carries its marker, so a partial run is safe to resume.
async function provision({ config, request, apply = false }) {
  if (!config || !config.locationId) throw new RequestError('CRM is not configured', 503, 'GHL_CRM_NOT_CONFIGURED');
  if (typeof request !== 'function') throw new TypeError('request is required');

  const catalogProducts = membershipCatalog.products();
  const catalogEntries = membershipCatalog.entries();
  const listed = await request(config, `/products/?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`);
  const currentProducts = listFrom(listed, 'products');
  const productByPackage = new Map();
  const summary = {
    catalogVersion: membershipCatalog.CATALOG_VERSION,
    productsCreated: 0,
    productsReused: 0,
    pricesCreated: 0,
    pricesUpdated: 0,
    pricesReused: 0,
    dryRun: !apply
  };

  await mapWithConcurrency(catalogProducts, 4, async product => {
    const found = currentProducts.find(candidate => hasProductMarker(candidate, product.packageId));
    if (found) {
      const id = productId(found);
      if (!id) throw new RequestError('CRM returned an invalid membership product', 502, 'CRM_MEMBERSHIP_PROVISION_FAILED');
      productByPackage.set(product.packageId, id);
      summary.productsReused += 1;
      return;
    }
    if (!apply) return;
    const created = await request(config, '/products/', { method: 'POST', body: productPayload(product, config.locationId) });
    productByPackage.set(product.packageId, assertCreatedId(created, 'product'));
    summary.productsCreated += 1;
  });

  await mapWithConcurrency(catalogEntries, 4, async entry => {
    const product = catalogProducts.find(candidate => candidate.packageId === entry.packageId);
    const id = productByPackage.get(entry.packageId);
    if (!id) return;
    const listedPrices = await request(config, `/products/${encodeURIComponent(id)}/price?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`);
    const found = listFrom(listedPrices, 'prices').find(candidate => hasPriceMarker(candidate, entry));
    if (found) {
      if (!matchingPrice(found, entry)) {
        const priceId = productId(found);
        if (!priceId) throw new RequestError('CRM returned an invalid membership price', 502, 'CRM_MEMBERSHIP_PROVISION_FAILED');
        if (!apply) return;
        // Only a marked membership price can reach this branch. Updating it is
        // safe to resume after a partial run and can never touch a deposit.
        await request(config, `/products/${encodeURIComponent(id)}/price/${encodeURIComponent(priceId)}`, {
          method: 'PUT',
          body: pricePayload(entry, config.locationId)
        });
        summary.pricesUpdated += 1;
        return;
      }
      summary.pricesReused += 1;
      return;
    }
    if (!apply) return;
    // `product` is deliberately retained in this loop as a guard against a
    // malformed authoritative catalog. A price can never be posted elsewhere.
    if (!product) throw new RequestError('Membership product is missing', 500, 'CRM_MEMBERSHIP_PROVISION_FAILED');
    await request(config, `/products/${encodeURIComponent(id)}/price`, { method: 'POST', body: pricePayload(entry, config.locationId) });
    summary.pricesCreated += 1;
  });

  return summary;
}

module.exports = {
  PRODUCT_MARKER_PREFIX,
  PRICE_MARKER_PREFIX,
  productMarker,
  priceMarker,
  priceName,
  productDescription,
  productPayload,
  crmAmount,
  pricePayload,
  matchingPrice,
  mapWithConcurrency,
  provision
};
