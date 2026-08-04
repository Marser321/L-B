'use strict';

// Creates the whole sellable catalog in HighLevel: services, add-ons, deposits and
// memberships. Generalises the membership-only provisioner and keeps its two
// safety properties, which matter more than anything else this file does:
//
//   1. **It only ever touches objects it created.** Products are matched on a
//      marker embedded in their description; prices on a name that belongs to our
//      catalog. The sub-account's pre-existing $30/$50 deposit products carry no
//      marker, so the planner cannot see them, let alone reuse or edit them.
//   2. **Dry run is the default.** Nothing is written unless `apply` is true.
//
// It is also safe to resume: every object that succeeded carries its marker, so a
// re-run finds it and moves on. Membership markers are deliberately unchanged from
// the first provisioner, so a location that already ran it is recognised rather
// than given a second set of 17 products.

const { RequestError } = require('./errors.js');
const crmCatalog = require('./crm-catalog.js');
const membershipProvisioning = require('./crm-membership-provisioning.js');

const FAILURE_CODE = 'CRM_CATALOG_PROVISION_FAILED';
// HighLevel pages at 100. With 88 products a single unpaginated read would
// silently miss the tail and re-create what it could not see.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function idOf(record) {
  return String((record && (record._id || record.id)) || '').trim();
}

function listFrom(response, key) {
  return Array.isArray(response && response[key]) ? response[key] : [];
}

// HighLevel's Products API speaks major currency units. The catalog keeps money in
// cents on purpose, so the conversion happens exactly once, here. Sending cents
// would turn a $130 membership into $13,000.
function majorUnits(amountCents) {
  return amountCents / 100;
}

function productPayload(item, locationId) {
  return {
    name: item.label,
    locationId,
    description: crmCatalog.productDescription(item.kind, item.productKey, item.note),
    productType: 'SERVICE',
    availableInStore: false,
    isTaxesEnabled: false,
    taxInclusive: false
  };
}

function pricePayload(price, locationId) {
  return {
    name: price.name,
    locationId,
    // The creation endpoint calls this `type`; `priceType` only comes back on
    // reads and webhooks and is not writable.
    type: price.type,
    currency: 'USD',
    amount: majorUnits(price.amountCents),
    ...(price.type === 'recurring'
      ? { recurring: { interval: price.interval || 'month', intervalCount: 1 } }
      : {})
  };
}

// The marker occupies its own line and is compared EXACTLY.
//
// A substring test looks equivalent and is not: `…:addon:limpieza-asiento` is a
// prefix of `…:addon:limpieza-asientos`, so `includes()` makes the jet-ski seat
// cleaning product match the car one. On every re-run one of the two would be
// "reused" as the other and the loser re-created, quietly duplicating products in
// the live CRM. Marker generation already puts it on the first line, so existing
// provisioned objects still match.
function hasProductMarker(product, item) {
  const marker = crmCatalog.productMarker(item.kind, item.productKey);
  return String((product && product.description) || '')
    .split('\n')
    .some(line => line.trim() === marker);
}

// Membership prices provisioned by the first version of the tool were named with a
// marker string before the names were made customer-readable. Both are accepted so
// that catalog is migrated rather than duplicated.
function hasPriceName(price, item, expected) {
  const name = String((price && price.name) || '');
  if (name === expected.name) return true;
  if (item.kind !== 'membership') return false;
  const legacy = membershipProvisioning.priceMarker({ packageId: expected.packageId, sizeId: expected.sizeId });
  return name === legacy;
}

function priceMatches(price, expected) {
  const type = String(price.priceType || price.type || '').toLowerCase();
  if (type !== expected.type) return false;
  if (Number(price.amount) !== majorUnits(expected.amountCents)) return false;
  if (String(price.currency || '').toLowerCase() !== 'usd') return false;
  if (expected.type !== 'recurring') return true;
  const recurring = price.recurring || {};
  return String(recurring.interval || '').toLowerCase() === (expected.interval || 'month') &&
    Number(recurring.intervalCount) === 1;
}

async function listAllProducts(config, request) {
  const products = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      locationId: config.locationId,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE)
    });
    const response = await request(config, `/products/?${query}`);
    const batch = listFrom(response, 'products');
    products.push(...batch);
    if (batch.length < PAGE_SIZE) return products;
  }
  // Refuse rather than provision against a partial view: creating duplicates of
  // products we simply could not see is worse than stopping.
  throw new RequestError('CRM returned more products than this tool can page through', 502, FAILURE_CODE);
}

async function mapWithConcurrency(list, limit, mapper) {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), list.length || 1) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
}

function emptyCounts() {
  return { productsCreated: 0, productsReused: 0, pricesCreated: 0, pricesUpdated: 0, pricesReused: 0 };
}

// `request` is `ghlRequest(config, path, options)`, injected so this logic is
// testable without a CRM account.
async function provision({ config, request, apply = false, kinds = crmCatalog.KINDS, concurrency = 4 }) {
  if (!config || !config.locationId) throw new RequestError('CRM is not configured', 503, 'GHL_CRM_NOT_CONFIGURED');
  if (typeof request !== 'function') throw new TypeError('request is required');

  const unknown = kinds.filter(kind => !crmCatalog.KINDS.includes(kind));
  if (unknown.length) throw new RequestError(`Unknown catalog kind: ${unknown.join(', ')}`, 400, FAILURE_CODE);

  const wanted = crmCatalog.items({ kinds });
  const existing = await listAllProducts(config, request);

  const summary = {
    catalogVersion: crmCatalog.CRM_CATALOG_VERSION,
    dryRun: !apply,
    kinds: [...kinds],
    totals: emptyCounts(),
    byKind: Object.fromEntries(kinds.map(kind => [kind, emptyCounts()])),
    // Named so an operator reading a dry run can see what would be created.
    plan: []
  };

  function count(kind, field, amount = 1) {
    summary.totals[field] += amount;
    summary.byKind[kind][field] += amount;
  }

  const productIdByKey = new Map();
  // priceKey → CRM price id, so the caller can persist a map that actually points
  // at something. Without this a payment link would know the product but not which
  // price to charge.
  const priceIdByKey = new Map();

  await mapWithConcurrency(wanted, concurrency, async item => {
    const found = existing.find(candidate => hasProductMarker(candidate, item));
    if (found) {
      const id = idOf(found);
      if (!id) throw new RequestError('CRM returned a product without an id', 502, FAILURE_CODE);
      productIdByKey.set(item.productKey, id);
      count(item.kind, 'productsReused');
      return;
    }
    summary.plan.push({ action: 'create-product', kind: item.kind, key: item.productKey, label: item.label });
    if (!apply) return;
    const created = await request(config, '/products/', { method: 'POST', body: productPayload(item, config.locationId) });
    const id = idOf(created && (created.product || created));
    if (!id) throw new RequestError('CRM did not return a product id', 502, FAILURE_CODE);
    productIdByKey.set(item.productKey, id);
    count(item.kind, 'productsCreated');
  });

  await mapWithConcurrency(wanted, concurrency, async item => {
    const productId = productIdByKey.get(item.productKey);
    // In a dry run a product that does not exist yet has no id, so its prices are
    // reported as planned rather than compared against nothing.
    if (!productId) {
      item.prices.forEach(price => summary.plan.push({
        action: 'create-price', kind: item.kind, key: price.priceKey, label: price.name,
        amount: majorUnits(price.amountCents), type: price.type
      }));
      return;
    }

    const query = new URLSearchParams({ locationId: config.locationId, limit: String(PAGE_SIZE) });
    const listed = await request(config, `/products/${encodeURIComponent(productId)}/price?${query}`);
    const currentPrices = listFrom(listed, 'prices');

    for (const price of item.prices) {
      const found = currentPrices.find(candidate => hasPriceName(candidate, item, price));
      if (!found) {
        summary.plan.push({
          action: 'create-price', kind: item.kind, key: price.priceKey, label: price.name,
          amount: majorUnits(price.amountCents), type: price.type
        });
        if (!apply) continue;
        const created = await request(config, `/products/${encodeURIComponent(productId)}/price`, {
          method: 'POST', body: pricePayload(price, config.locationId)
        });
        const createdId = idOf(created && (created.price || created));
        if (!createdId) throw new RequestError('CRM did not return a price id', 502, FAILURE_CODE);
        priceIdByKey.set(price.priceKey, createdId);
        count(item.kind, 'pricesCreated');
        continue;
      }
      priceIdByKey.set(price.priceKey, idOf(found));
      if (priceMatches(found, price)) {
        count(item.kind, 'pricesReused');
        continue;
      }
      const priceId = idOf(found);
      if (!priceId) throw new RequestError('CRM returned a price without an id', 502, FAILURE_CODE);
      summary.plan.push({
        action: 'update-price', kind: item.kind, key: price.priceKey, label: price.name,
        amount: majorUnits(price.amountCents), type: price.type
      });
      if (!apply) continue;
      // Only a price already carrying one of our names reaches this branch, so an
      // update can never rewrite a deposit or anything the office made by hand.
      await request(config, `/products/${encodeURIComponent(productId)}/price/${encodeURIComponent(priceId)}`, {
        method: 'PUT', body: pricePayload(price, config.locationId)
      });
      count(item.kind, 'pricesUpdated');
    }
  });

  // What a caller needs to persist the map afterwards: which CRM ids back which
  // catalog identifiers.
  summary.mapping = wanted.flatMap(item => item.prices.map(price => ({
    kind: item.kind,
    productKey: item.productKey,
    priceKey: price.priceKey,
    packageId: price.packageId || null,
    sizeId: price.sizeId || null,
    addonId: price.addonId || null,
    amountCents: price.amountCents,
    type: price.type,
    crmProductId: productIdByKey.get(item.productKey) || null,
    crmPriceId: priceIdByKey.get(price.priceKey) || null
  })));

  return summary;
}

module.exports = {
  FAILURE_CODE,
  PAGE_SIZE,
  majorUnits,
  productPayload,
  pricePayload,
  hasProductMarker,
  hasPriceName,
  priceMatches,
  listAllProducts,
  mapWithConcurrency,
  provision
};
