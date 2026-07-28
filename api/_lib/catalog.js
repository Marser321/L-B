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
  heavy_trucks: new Set([
    'limpieza-cabina', 'cera-rapida', 'desengrasado-profundo', 'engrasado-camion',
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
  'volteo-aluminio': new Set(['dump-truck-wash', 'dump-truck-2x', 'dump-truck-4x']),
  'car-hauler-second-deck': new Set([
    'car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x',
    // TODO(remove-graphite): retired packages, transition window only.
    'car-hauler-graphite-wash', 'car-hauler-graphite-2x', 'car-hauler-graphite-4x'
  ]),
  'lubricante-grafito': new Set(['car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x'])
});

// Per-category block length: the service itself plus the travel/setup buffer the
// crew needs afterwards. One van is busy for service + buffer, which is why two
// bookings on the same van can never be scheduled back to back without the gap.
const CATEGORY_DURATIONS = Object.freeze({
  cars: Object.freeze({ service: 60, buffer: 30 }),
  heavy_trucks: Object.freeze({ service: 90, buffer: 30 }),
  boats: Object.freeze({ service: 120, buffer: 60 }),
  jetski: Object.freeze({ service: 120, buffer: 60 }),
  mobile_home: Object.freeze({ service: 90, buffer: 30 }),
  golf_cart: Object.freeze({ service: 30, buffer: 30 }),
  atv: Object.freeze({ service: 30, buffer: 30 }),
  driveway: Object.freeze({ service: 120, buffer: 30 }),
  // Paint correction and ceramic coating take the whole day; see FULL_DAY_PACKAGES.
  paint_correction: Object.freeze({ service: 0, buffer: 0 })
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
const FULL_DAY_PACKAGES = new Set(['paint-correction', 'ceramic-protection']);

// One van per vehicle, four vans in the fleet: a single visit can never cover
// more than four vehicles at the same hour. Enforced server-side (HTTP 422) so a
// tampered frontend cannot book a fifth.
const MAX_VEHICLES = 4;

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

// How long ONE van is occupied by ONE vehicle: its own service plus its own
// buffer. This is the only duration the agenda schedules with — cart durations
// are never added together, because each vehicle is washed by a different van at
// the same time (see agenda.js).
function vehicleDurationMinutes(packageId) {
  const duration = durationForPackage(packageId);
  return duration.service + duration.buffer;
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
  MIN_BOOKING_NOTICE_MS,
  MEMBERSHIP_BOOKING_NOTICE_MS,
  BOOKING_WINDOW_DAYS,
  categoryForPackage,
  isKnownPackage,
  isMembershipPackage,
  bookingModeForPackage,
  bookingModeForPackages,
  durationForPackage,
  vehicleDurationMinutes,
  depositForPackages,
  noticeMsForPackages,
  addonAppliesToPackage
};
