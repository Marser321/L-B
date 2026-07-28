'use strict';

// GET /api/catalog
//
// A public rendering projection of the authoritative server catalog. It gives
// the browser stable package/size/add-on identifiers and display metadata, but
// does not grant it authority to price or schedule a booking: those values are
// always re-derived by selection.js, pricing.js and agenda.js on POST.

const crypto = require('node:crypto');

const { sendJson } = require('./_lib/http.js');
const catalog = require('./_lib/catalog.js');
const pricing = require('./_lib/pricing.js');
const publicCatalog = require('./_lib/catalog-public.json');
const time = require('./_lib/time.js');

function publicCatalogMetadata() {
  // Catalog rendering must remain available even if an optional runtime
  // timezone override is malformed. Availability remains responsible for
  // returning its operational configuration error when it needs that zone.
  let locationTimeZone = time.DEFAULT_BOOKING_TIMEZONE;
  try {
    locationTimeZone = time.bookingTimezone();
  } catch (error) { /* Safe public fallback; never expose environment values. */ }

  return {
    maxVehicles: catalog.MAX_VEHICLES,
    membershipNoticeHours: Math.round(catalog.MEMBERSHIP_BOOKING_NOTICE_MS / (60 * 60 * 1000)),
    locationTimeZone
  };
}

function catalogVersion(metadata) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ schema: 2, categories: publicCatalog.categories, metadata }))
    .digest('hex')
    .slice(0, 12);
}

function localizedEstimate(estimate) {
  return {
    en: pricing.formatEstimate(estimate, 'en'),
    es: pricing.formatEstimate(estimate, 'es')
  };
}

function packageDisplay(packageId, prices) {
  const entries = Object.keys(prices || {}).map(sizeId => {
    const bounds = pricing.packagePriceBounds(packageId, sizeId);
    return [sizeId, localizedEstimate({
      min: bounds.min,
      max: bounds.max,
      isRange: bounds.max > bounds.min,
      isFrom: bounds.from,
      custom: bounds.custom
    })];
  });
  const minimum = Math.min(...Object.keys(prices || {}).map(sizeId => pricing.packagePriceBounds(packageId, sizeId).min));
  return {
    displayPrices: Object.fromEntries(entries),
    displayFrom: {
      en: `From $${Math.round(minimum).toLocaleString('en-US')}`,
      es: `Desde $${Math.round(minimum).toLocaleString('en-US')}`
    }
  };
}

function addonDisplay(addonId) {
  const bounds = pricing.addonPriceBounds(addonId);
  if (bounds.custom) return { en: '+ Custom Quote', es: '+ Cotización personalizada' };
  const estimate = localizedEstimate({
    min: bounds.min,
    max: bounds.max,
    isRange: bounds.max > bounds.min,
    isFrom: bounds.from,
    custom: false
  });
  return { en: `+ ${estimate.en}`, es: `+ ${estimate.es}` };
}

function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  const metadata = publicCatalogMetadata();
  return sendJson(res, 200, {
    ok: true,
    version: catalogVersion(metadata),
    ...metadata,
    categories: publicCatalog.categories.map(category => ({
      ...category,
      packages: (category.packages || []).map(pkg => ({
        ...pkg,
        isMembership: catalog.isMembershipPackage(pkg.id),
        ...packageDisplay(pkg.id, pkg.prices)
      })),
      extras: (category.extras || []).map(extra => ({
        ...extra,
        displayPrice: addonDisplay(extra.id)
      }))
    }))
  });
}

module.exports = handler;
module.exports._test = { publicCatalogMetadata, catalogVersion };
