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
  return String((price && price.name) || '') === priceMarker(entry);
}

function matchingPrice(price, entry) {
  return hasPriceMarker(price, entry) &&
    String(price.priceType || '').toLowerCase() === 'recurring' &&
    Number(price.amount) === entry.monthlyCents &&
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
    // The marker is intentionally the price name. It is the durable, visible
    // idempotency key in HighLevel; the human-facing product holds the label.
    name: priceMarker(entry),
    locationId,
    priceType: 'recurring',
    currency: entry.currency,
    // HighLevel product API amounts use the currency's minor unit (cents for
    // USD), matching the authoritative catalog's monthlyCents field.
    amount: entry.monthlyCents,
    recurring: { interval: entry.interval, intervalCount: 1 }
  };
}

function assertCreatedId(result, kind) {
  const id = productId(result && (result[kind] || result));
  if (!id) throw new RequestError(`CRM did not return a ${kind} id`, 502, 'CRM_MEMBERSHIP_PROVISION_FAILED');
  return id;
}

// request is `ghlRequest(config, path, options)`, injected so this business
// logic is testable without a CRM account. Sequential writes make a partial
// run safe to resume: every successful object carries its marker.
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
    pricesReused: 0,
    dryRun: !apply
  };

  for (const product of catalogProducts) {
    const found = currentProducts.find(candidate => hasProductMarker(candidate, product.packageId));
    if (found) {
      const id = productId(found);
      if (!id) throw new RequestError('CRM returned an invalid membership product', 502, 'CRM_MEMBERSHIP_PROVISION_FAILED');
      productByPackage.set(product.packageId, id);
      summary.productsReused += 1;
      continue;
    }
    if (!apply) continue;
    const created = await request(config, '/products/', { method: 'POST', body: productPayload(product, config.locationId) });
    productByPackage.set(product.packageId, assertCreatedId(created, 'product'));
    summary.productsCreated += 1;
  }

  for (const entry of catalogEntries) {
    const product = catalogProducts.find(candidate => candidate.packageId === entry.packageId);
    const id = productByPackage.get(entry.packageId);
    if (!id) continue;
    const listedPrices = await request(config, `/products/${encodeURIComponent(id)}/price?${new URLSearchParams({ locationId: config.locationId, limit: '100' })}`);
    const found = listFrom(listedPrices, 'prices').find(candidate => hasPriceMarker(candidate, entry));
    if (found) {
      if (!matchingPrice(found, entry)) {
        throw new RequestError(`CRM price is out of sync for ${entry.packageId}/${entry.sizeId}`, 409, 'CRM_MEMBERSHIP_PRICE_OUT_OF_SYNC');
      }
      summary.pricesReused += 1;
      continue;
    }
    if (!apply) continue;
    // `product` is deliberately retained in this loop as a guard against a
    // malformed authoritative catalog. A price can never be posted elsewhere.
    if (!product) throw new RequestError('Membership product is missing', 500, 'CRM_MEMBERSHIP_PROVISION_FAILED');
    await request(config, `/products/${encodeURIComponent(id)}/price`, { method: 'POST', body: pricePayload(entry, config.locationId) });
    summary.pricesCreated += 1;
  }

  return summary;
}

module.exports = {
  PRODUCT_MARKER_PREFIX,
  PRICE_MARKER_PREFIX,
  productMarker,
  priceMarker,
  productDescription,
  productPayload,
  pricePayload,
  matchingPrice,
  provision
};
