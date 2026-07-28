'use strict';

// The server prices every booking itself, from catalog-prices.json.
//
// The browser posts ids (package, size, add-ons) and the server looks up what
// they cost. Any `estimate`, `price`, `deposit` or `duration` field that arrives
// in a request body is IGNORED — accepted for backwards compatibility with tabs
// that still send it, never read. A tampered frontend can therefore change what
// it *displays*, but not what the CRM records or what the deposit invoice charges.
//
// The arithmetic below mirrors estimateFor/packagePriceBounds/addonPriceBounds in
// script.js on purpose: both sides must agree, or the customer sees one number
// and gets charged another. catalog-prices.json is generated from the same
// SERVICES_DATA literal the frontend reads (scripts/extract-catalog.mjs), and
// tests/pricing.test.js pins a handful of known totals so a drift shows up.

const { RequestError } = require('./errors.js');
const catalogPrices = require('./catalog-prices.json');

const FROM_PRICE_EXTRA_IDS = new Set(['motor-pesado', 'rines-aluminio', 'boat-cera-marina', 'boat-pulido']);

const PACKAGE_PRICES = new Map();
const ADDON_PRICES = new Map();

// "$30 - $60" → { min: 30, max: 60 }; "Desde $50" → { min: 50, max: 50, from: true }
function parsePriceText(text) {
  const str = String(text || '');
  const nums = (str.match(/\d[\d,]*/g) || []).map(value => parseInt(value.replace(/,/g, ''), 10)).filter(Number.isFinite);
  const custom = /custom quote|cotiz/i.test(str) && nums.length === 0;
  if (!nums.length) return { min: 0, max: 0, from: false, custom };
  return {
    min: nums[0],
    max: nums.length > 1 ? nums[1] : nums[0],
    from: /\b(from|desde)\b/i.test(str),
    custom: false
  };
}

for (const category of catalogPrices.categories) {
  for (const pkg of category.packages) {
    const bounds = {};
    for (const [sizeId, price] of Object.entries(pkg.prices || {})) {
      const base = Number(price) || 0;
      bounds[sizeId] = { min: base, max: base, from: false, custom: false };
    }
    // A priceRanges entry overrides the flat price for that size.
    for (const [sizeId, text] of Object.entries(pkg.priceRanges || {})) {
      bounds[sizeId] = parsePriceText(text);
    }
    PACKAGE_PRICES.set(pkg.id, bounds);
  }
  for (const addon of category.addons) {
    const parsed = addon.range ? parsePriceText(addon.range) : null;
    const base = Number(addon.price || 0);
    ADDON_PRICES.set(addon.id, {
      min: parsed && !parsed.custom ? parsed.min : base,
      max: parsed && !parsed.custom ? parsed.max : base,
      from: Boolean((parsed && parsed.from) || FROM_PRICE_EXTRA_IDS.has(addon.id)),
      custom: Boolean(parsed && parsed.custom)
    });
  }
}

// TODO(remove-graphite): the three car-hauler-graphite-* packages were retired
// when graphite became the `lubricante-grafito` add-on, so SERVICES_DATA (and
// therefore the generated catalog) no longer prices them — but catalog.js still
// ACCEPTS them during the transition window, so a long-lived open tab can still
// submit one. Price them as what they became: the plain car-hauler package plus
// the graphite add-on. Delete this block together with the retired ids.
const RETIRED_PACKAGE_EQUIVALENTS = Object.freeze({
  'car-hauler-graphite-wash': { packageId: 'car-hauler-wash', addonIds: ['lubricante-grafito'] },
  'car-hauler-graphite-2x': { packageId: 'car-hauler-2x', addonIds: ['lubricante-grafito'] },
  'car-hauler-graphite-4x': { packageId: 'car-hauler-4x', addonIds: ['lubricante-grafito'] }
});

for (const [retiredId, equivalent] of Object.entries(RETIRED_PACKAGE_EQUIVALENTS)) {
  const replacement = PACKAGE_PRICES.get(equivalent.packageId);
  if (!replacement) continue;
  const extra = equivalent.addonIds.reduce((total, addonId) => {
    const bounds = ADDON_PRICES.get(addonId) || { min: 0, max: 0 };
    return { min: total.min + bounds.min, max: total.max + bounds.max };
  }, { min: 0, max: 0 });
  PACKAGE_PRICES.set(retiredId, Object.fromEntries(Object.entries(replacement).map(([sizeId, bounds]) => [
    sizeId,
    { ...bounds, min: bounds.min + extra.min, max: bounds.max + extra.max }
  ])));
}

function money(amount) {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function packagePriceBounds(packageId, sizeId) {
  const bounds = PACKAGE_PRICES.get(packageId);
  const forSize = bounds && bounds[sizeId];
  // Reached only if catalog-prices.json is stale relative to the validation
  // tables in catalog.js — a deploy bug, not something a request can trigger.
  if (!forSize) throw new RequestError('Service pricing is not configured', 503);
  return forSize;
}

function addonPriceBounds(addonId) {
  return ADDON_PRICES.get(addonId) || { min: 0, max: 0, from: false, custom: false };
}

function formatEstimate({ min, max, isRange, isFrom, custom }, language = 'en') {
  const from = language === 'es' ? 'Desde' : 'From';
  const customSuffix = language === 'es' ? '+ Cotización personalizada' : '+ Custom Quote';
  let label = isRange ? `${money(min)} - ${money(max)}` : (isFrom ? `${from} ${money(min)}` : money(min));
  if (custom) label += ` ${customSuffix}`;
  return label;
}

// The authoritative estimate for one vehicle: its package at its size, plus its
// add-ons. `addonIds` must already be validated against the package.
function estimateForVehicle({ packageId, sizeId, addonIds = [] }, language = 'en') {
  const base = packagePriceBounds(packageId, sizeId);
  let min = base.min;
  let max = base.max;
  let isRange = base.max > base.min;
  let isFrom = base.from;
  let custom = false;

  for (const addonId of addonIds) {
    const bounds = addonPriceBounds(addonId);
    // Custom-quote add-ons (e.g. aluminium tank polishing) add no number; the
    // office quotes them by hand, and the label says so.
    if (bounds.custom) { custom = true; continue; }
    min += bounds.min;
    max += bounds.max;
    if (bounds.max > bounds.min) isRange = true;
    if (bounds.from) isFrom = true;
  }

  const showRange = isRange && max > min;
  const estimate = { min, max, isRange: showRange, isFrom, custom };
  return { ...estimate, label: formatEstimate(estimate, language) };
}

// Cart total: every vehicle's own estimate added up. Money does add up across a
// cart — only DURATION doesn't, because the vans work in parallel.
function estimateForVehicles(vehicles, language = 'en') {
  const parts = vehicles.map(vehicle => estimateForVehicle(vehicle, language));
  const total = parts.reduce((accumulator, part) => ({
    min: accumulator.min + part.min,
    max: accumulator.max + part.max,
    isRange: accumulator.isRange || part.isRange,
    isFrom: accumulator.isFrom || part.isFrom,
    custom: accumulator.custom || part.custom
  }), { min: 0, max: 0, isRange: false, isFrom: false, custom: false });
  const showRange = total.isRange && total.max > total.min;
  const estimate = { ...total, isRange: showRange };
  return { ...estimate, label: formatEstimate(estimate, language), perVehicle: parts };
}

module.exports = {
  parsePriceText,
  money,
  packagePriceBounds,
  addonPriceBounds,
  formatEstimate,
  estimateForVehicle,
  estimateForVehicles,
  // Exposed so a test can assert the generated catalog still covers every
  // package/size pair the validation tables accept.
  PACKAGE_PRICES,
  ADDON_PRICES
};
