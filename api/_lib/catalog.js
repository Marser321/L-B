'use strict';

// The server's own copy of what can be booked, how long it takes, and what it
// costs. Nothing here is ever taken from the request body: the browser sends
// ids, and every number attached to those ids is looked up here.
//
// Prices live in catalog-prices.json, generated from script.js by
// scripts/extract-catalog.mjs (see pricing.js). Everything else — which package
// belongs to which category, which sizes a package accepts, how long a van is
// busy, which packages take the whole day — is declared below.

const CATEGORY_IDS = new Set([
  'cars', 'paint_correction', 'heavy_trucks', 'boats', 'jetski',
  'golf_cart', 'atv', 'mobile_home', 'driveway'
]);

const PACKAGES_BY_CATEGORY = Object.freeze({
  cars: new Set(['basico-exterior', 'basico-premium', 'premium-detail', 'vip', 'membresia-2x', 'membresia-4x']),
  paint_correction: new Set(['paint-enhancement', 'paint-correction', 'ceramic-protection']),
  heavy_trucks: new Set([
    'box-truck-wash', 'box-truck-2x', 'box-truck-4x',
    'semi-truck-wash', 'semi-truck-2x', 'semi-truck-4x',
    'trailer-wash', 'trailer-2x', 'trailer-4x',
    'car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x',
    // TODO(remove-graphite): retired packages (now the lubricante-grafito add-on);
    // kept during the transition window so long-lived open tabs can still submit.
    'car-hauler-graphite-wash', 'car-hauler-graphite-2x', 'car-hauler-graphite-4x',
    'dump-truck-wash', 'dump-truck-2x', 'dump-truck-4x',
    'garbage-truck-wash', 'garbage-truck-2x', 'garbage-truck-4x'
  ]),
  boats: new Set(['boat-basico', 'boat-premium', 'boat-detail']),
  jetski: new Set(['jetski-premium', 'jetski-membresia']),
  golf_cart: new Set(['golf-premium', 'golf-membresia']),
  atv: new Set(['atv-premium', 'atv-membresia']),
  mobile_home: new Set(['mobile-home-basico']),
  driveway: new Set(['driveway-basico', 'driveway-premium'])
});

const SIZES_BY_PACKAGE = Object.freeze({
  'basico-exterior': new Set(['sedan', 'suv', 'truck', 'van_pequena', 'van_xl']),
  'basico-premium': new Set(['sedan', 'suv', 'truck', 'van_pequena', 'van_xl']),
  'premium-detail': new Set(['sedan', 'suv', 'truck']),
  vip: new Set(['sedan', 'suv', 'truck']),
  'membresia-2x': new Set(['sedan', 'suv', 'truck', 'van_pequena', 'van_xl']),
  'membresia-4x': new Set(['sedan', 'suv', 'truck', 'van_pequena', 'van_xl']),
  'paint-enhancement': new Set(['sedan', 'suv', 'truck', 'van']),
  'paint-correction': new Set(['sedan', 'suv', 'truck', 'van']),
  'ceramic-protection': new Set(['sedan', 'suv', 'truck', 'van']),
  'box-truck-wash': new Set(['size_10_16', 'size_17_20', 'size_21_26']),
  'box-truck-2x': new Set(['size_10_16', 'size_17_20', 'size_21_26']),
  'box-truck-4x': new Set(['size_10_16', 'size_17_20', 'size_21_26']),
  'semi-truck-wash': new Set(['standard']),
  'semi-truck-2x': new Set(['standard']),
  'semi-truck-4x': new Set(['standard']),
  'trailer-wash': new Set(['standard']),
  'trailer-2x': new Set(['standard']),
  'trailer-4x': new Set(['standard']),
  'car-hauler-wash': new Set(['standard']),
  'car-hauler-2x': new Set(['standard']),
  'car-hauler-4x': new Set(['standard']),
  // TODO(remove-graphite): retired packages, transition window only.
  'car-hauler-graphite-wash': new Set(['standard']),
  'car-hauler-graphite-2x': new Set(['standard']),
  'car-hauler-graphite-4x': new Set(['standard']),
  'dump-truck-wash': new Set(['standard']),
  'dump-truck-2x': new Set(['standard']),
  'dump-truck-4x': new Set(['standard']),
  'garbage-truck-wash': new Set(['standard']),
  'garbage-truck-2x': new Set(['standard']),
  'garbage-truck-4x': new Set(['standard']),
  'boat-basico': new Set(['boat_16_20', 'boat_21_30', 'boat_31_40', 'boat_41_60']),
  'boat-premium': new Set(['boat_16_20', 'boat_21_30', 'boat_31_40', 'boat_41_60']),
  'boat-detail': new Set(['boat_16_20', 'boat_21_30', 'boat_31_40', 'boat_41_60']),
  'jetski-premium': new Set(['qty_1', 'qty_2', 'qty_3']),
  'jetski-membresia': new Set(['qty_1', 'qty_2', 'qty_3']),
  'golf-premium': new Set(['standard']),
  'golf-membresia': new Set(['standard']),
  'atv-premium': new Set(['qty_1', 'qty_2', 'qty_3']),
  'atv-membresia': new Set(['qty_1', 'qty_2', 'qty_3']),
  'mobile-home-basico': new Set(['single_wide', 'double_wide', 'triple_wide']),
  'driveway-basico': new Set(['standard']),
  'driveway-premium': new Set(['standard'])
});

const ADDONS_BY_CATEGORY = Object.freeze({
  cars: new Set([
    'limpieza-motor', 'cera-rapida', 'sellador-pintura', 'pelos-animal', 'eliminar-olores',
    'tratamiento-ozono', 'limpieza-asientos', 'limpieza-alfombras', 'restauracion-plasticos',
    'pulido-faros', 'descontaminacion-pintura', 'cargo-bed', 'limpieza-chasis'
  ]),
  paint_correction: new Set(['faros-recup', 'tar-sap', 'water-spots', 'engine-bay', 'ext-plastics', 'repelente-cristales']),
  // cera-rapida is deliberately absent: waxing is not a service that exists on a
  // trailer or a garbage truck, so heavy trucks do not sell it at all.
  heavy_trucks: new Set([
    'limpieza-cabina', 'desengrasado-profundo', 'engrasado-camion',
    'motor-pesado', 'volteo-aluminio', 'rines-aluminio', 'pulido-rines-llantas',
    'car-hauler-second-deck', 'lubricante-grafito', 'pulido-tanques'
  ]),
  boats: new Set([
    'boat-motor', 'boat-vinilo-uv', 'boat-cera-marina', 'boat-pulido', 'boat-oxidacion',
    'boat-ceramica', 'boat-inox', 'boat-compartimientos', 'boat-manchas-agua',
    'boat-marcas-casco', 'boat-lona-bimini', 'boat-repelente-cristales',
    'boat-olores-ozono', 'boat-teca'
  ]),
  jetski: new Set(['eliminacion-sal', 'brillo-plasticos', 'limpieza-asiento', 'ceramica-marina']),
  golf_cart: new Set(),
  atv: new Set(),
  mobile_home: new Set(),
  driveway: new Set()
});

const PACKAGES_BY_RESTRICTED_ADDON = Object.freeze({
  // Only packages that actually have a cab: trailers and car haulers are towed
  // units, and the car hauler service explicitly excludes the tractor.
  'limpieza-cabina': new Set([
    'box-truck-wash', 'box-truck-2x', 'box-truck-4x',
    'semi-truck-wash', 'semi-truck-2x', 'semi-truck-4x',
    'dump-truck-wash', 'dump-truck-2x', 'dump-truck-4x',
    'garbage-truck-wash', 'garbage-truck-2x', 'garbage-truck-4x'
  ]),
  // Same list as the cab, and for the same reason: a towed unit has no engine.
  'motor-pesado': new Set([
    'box-truck-wash', 'box-truck-2x', 'box-truck-4x',
    'semi-truck-wash', 'semi-truck-2x', 'semi-truck-4x',
    'dump-truck-wash', 'dump-truck-2x', 'dump-truck-4x',
    'garbage-truck-wash', 'garbage-truck-2x', 'garbage-truck-4x'
  ]),
  // Aluminium fuel tanks are mounted on the tractor. Nothing else has them.
  'pulido-tanques': new Set(['semi-truck-wash', 'semi-truck-2x', 'semi-truck-4x']),
  'volteo-aluminio': new Set(['dump-truck-wash', 'dump-truck-2x', 'dump-truck-4x']),
  'car-hauler-second-deck': new Set([
    'car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x',
    // TODO(remove-graphite): retired packages, transition window only.
    'car-hauler-graphite-wash', 'car-hauler-graphite-2x', 'car-hauler-graphite-4x'
  ]),
  'lubricante-grafito': new Set(['car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x'])
});

// Per-category block length, split into the two things it is made of:
//
//   service  hands-on minutes for ONE vehicle
//   buffer   the travel/setup gap the crew needs BETWEEN ADDRESSES
//
// The split matters because a visit is one van working through the vehicles at one
// address, one after another (see visitDurationMinutes). The services add up; the
// buffer is charged once, at the end, because the crew does not travel between two
// cars parked in the same driveway.
const CATEGORY_DURATIONS = Object.freeze({
  cars: Object.freeze({ service: 60, buffer: 30 }),
  heavy_trucks: Object.freeze({ service: 90, buffer: 30 }),
  boats: Object.freeze({ service: 120, buffer: 60 }),
  jetski: Object.freeze({ service: 120, buffer: 60 }),
  mobile_home: Object.freeze({ service: 90, buffer: 30 }),
  golf_cart: Object.freeze({ service: 30, buffer: 30 }),
  atv: Object.freeze({ service: 30, buffer: 30 }),
  driveway: Object.freeze({ service: 120, buffer: 30 }),
  // Paint work occupies the van for the working day (see FULL_DAY_PACKAGES), so the
  // per-category length below is only a floor. It is NOT zero: a category that
  // computes to a zero-minute block produces a booking whose start equals its end,
  // which Postgres rejects (`duration_minutes > 0`, `ends_at > starts_at`) and the
  // customer sees as a 502. That is exactly what happened to paint-enhancement
  // while it was missing from FULL_DAY_PACKAGES.
  paint_correction: Object.freeze({ service: 480, buffer: 60 })
});

// Deposit charged once per booking. Compact vehicles pay the small deposit;
// anything the crew treats as a large unit pays the larger one.
const DEPOSIT_SMALL = 30;
const DEPOSIT_LARGE = 50;
const DEPOSIT_BY_CATEGORY = Object.freeze({
  cars: DEPOSIT_SMALL,
  golf_cart: DEPOSIT_SMALL,
  atv: DEPOSIT_SMALL,
  jetski: DEPOSIT_SMALL,
  heavy_trucks: DEPOSIT_LARGE,
  boats: DEPOSIT_LARGE,
  mobile_home: DEPOSIT_LARGE,
  driveway: DEPOSIT_LARGE,
  paint_correction: DEPOSIT_LARGE
});

const CATEGORY_BY_PACKAGE = Object.freeze(Object.fromEntries(
  Object.entries(PACKAGES_BY_CATEGORY).flatMap(([categoryId, packages]) =>
    [...packages].map(packageId => [packageId, categoryId])
  )
));

const MEMBERSHIP_PACKAGE_PATTERN = /membresia|membership|-2x$|-4x$/;
// All three paint tiers hold the van for the working day. paint-enhancement was
// missing here, which combined with a zero-length paint_correction duration made
// the $299 tier unbookable — see the note on CATEGORY_DURATIONS above.
const FULL_DAY_PACKAGES = new Set(['paint-enhancement', 'paint-correction', 'ceramic-protection']);

// One van per ADDRESS, four vans in the fleet: the fleet size caps how many
// separate customers can be served at the same hour, NOT how many vehicles one
// customer may bring. A visit is one van working through the vehicles in the
// driveway one after another, so the real limit on a single booking is how much of
// the working day it consumes.
//
// Four is the cap for the compact categories: four cars is 4×60 + 30 = 4h30, which
// still leaves start times across most of the day. Marine work is capped at two
// because each unit is two hours of service — two jet skis already run 4h60, and
// four would be a nine-hour visit that swallows one van's entire day.
const MAX_VEHICLES = 4;
const MAX_VEHICLES_MARINE = 2;
const MARINE_CATEGORIES = new Set(['boats', 'jetski']);

// The cap that applies to one cart. Mixed carts take the strictest one, since all
// the vehicles share a single van and a single visit.
function maxVehiclesForPackages(packageIds) {
  const marine = packageIds.some(id => MARINE_CATEGORIES.has(CATEGORY_BY_PACKAGE[id]));
  return marine ? MAX_VEHICLES_MARINE : MAX_VEHICLES;
}

// One hour of notice for a normal booking. Memberships are the only service that
// requires 48 hours, because they are routed to a recurring plan the office has
// to set up by hand before the first visit.
const MIN_BOOKING_NOTICE_MS = 60 * 60 * 1000;
const MEMBERSHIP_BOOKING_NOTICE_MS = 48 * 60 * 60 * 1000;

const BOOKING_WINDOW_DAYS = 60;

function categoryForPackage(packageId) {
  return CATEGORY_BY_PACKAGE[packageId];
}

function isKnownPackage(packageId) {
  return Boolean(SIZES_BY_PACKAGE[packageId]);
}

function isMembershipPackage(packageId) {
  return MEMBERSHIP_PACKAGE_PATTERN.test(packageId);
}

function bookingModeForPackage(packageId) {
  return FULL_DAY_PACKAGES.has(packageId) ? 'full_day' : 'slot';
}

function durationForPackage(packageId) {
  return CATEGORY_DURATIONS[CATEGORY_BY_PACKAGE[packageId]] || CATEGORY_DURATIONS.cars;
}

// Hands-on minutes for ONE vehicle, with no buffer attached. This is what gets
// added up across a cart, because one van works through the vehicles in the
// driveway one after another.
//
// Throws rather than returning a non-positive number. A zero-minute block is not
// a scheduling edge case, it is a broken catalog: it produces a booking whose
// start equals its end, which Postgres refuses and the customer experiences as an
// unbookable service. Failing here surfaces it in the test suite instead.
function vehicleServiceMinutes(packageId) {
  return assertSchedulableMinutes(durationForPackage(packageId).service, packageId);
}

// The travel/setup gap after the visit. A mixed cart takes the largest one: the
// crew packing up after a boat needs the boat's gap, not a sedan's.
function visitBufferMinutes(packageIds) {
  return packageIds.reduce(
    (largest, packageId) => Math.max(largest, durationForPackage(packageId).buffer),
    0
  );
}

// How long ONE van is occupied by a whole visit.
//
// THIS IS THE LOAD-BEARING RULE: a visit with N vehicles is one van working N
// times at one address, so the services ADD UP. It is not N vans working at once,
// and it is not the longest vehicle — both of which this function used to return,
// which had the site quoting 1h30 for three cars that really take 3h30 and blocking
// three separate vans for one driveway.
//
// The buffer is added once, at the end. There is no travel between two cars parked
// in the same driveway, so charging a gap per vehicle would invent dead time the
// crew does not take.
function visitDurationMinutes(packageIds) {
  const ids = [...packageIds];
  if (!ids.length) throw new Error('catalog: a visit needs at least one vehicle');
  const service = ids.reduce((total, packageId) => total + vehicleServiceMinutes(packageId), 0);
  return assertSchedulableMinutes(service + visitBufferMinutes(ids), ids.join('+'));
}

// The guard, on its own so it can be tested directly. Note that an UNKNOWN package
// is not the dangerous case — it falls back to the cars duration. The dangerous
// case is a category whose own duration sums to zero, which is how
// paint_correction shipped.
function assertSchedulableMinutes(minutes, packageId) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`catalog: ${packageId} resolves to a ${minutes}-minute booking; every package must occupy real time`);
  }
  return minutes;
}

// One deposit per booking: the largest one any vehicle in the cart requires.
function depositForPackages(packageIds) {
  return packageIds.reduce(
    (amount, packageId) => Math.max(amount, DEPOSIT_BY_CATEGORY[CATEGORY_BY_PACKAGE[packageId]] || DEPOSIT_SMALL),
    0
  );
}

// 48 hours applies to memberships only; every other service keeps the one-hour
// notice it has always had. A cart that mixes both takes the stricter of the two,
// since all its vehicles share one start time.
function noticeMsForPackages(packageIds) {
  return packageIds.some(isMembershipPackage) ? MEMBERSHIP_BOOKING_NOTICE_MS : MIN_BOOKING_NOTICE_MS;
}

function bookingModeForPackages(packageIds) {
  return packageIds.some(id => bookingModeForPackage(id) === 'full_day') ? 'full_day' : 'slot';
}

function addonAppliesToPackage(addonId, packageId) {
  const allowed = PACKAGES_BY_RESTRICTED_ADDON[addonId];
  return !allowed || allowed.has(packageId);
}

module.exports = {
  CATEGORY_IDS,
  PACKAGES_BY_CATEGORY,
  SIZES_BY_PACKAGE,
  ADDONS_BY_CATEGORY,
  PACKAGES_BY_RESTRICTED_ADDON,
  CATEGORY_DURATIONS,
  CATEGORY_BY_PACKAGE,
  DEPOSIT_SMALL,
  DEPOSIT_LARGE,
  DEPOSIT_BY_CATEGORY,
  MEMBERSHIP_PACKAGE_PATTERN,
  FULL_DAY_PACKAGES,
  MAX_VEHICLES,
  MAX_VEHICLES_MARINE,
  MARINE_CATEGORIES,
  MIN_BOOKING_NOTICE_MS,
  MEMBERSHIP_BOOKING_NOTICE_MS,
  BOOKING_WINDOW_DAYS,
  categoryForPackage,
  isKnownPackage,
  isMembershipPackage,
  bookingModeForPackage,
  bookingModeForPackages,
  durationForPackage,
  vehicleServiceMinutes,
  visitBufferMinutes,
  visitDurationMinutes,
  maxVehiclesForPackages,
  assertSchedulableMinutes,
  depositForPackages,
  noticeMsForPackages,
  addonAppliesToPackage
};
