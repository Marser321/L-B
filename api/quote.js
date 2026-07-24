'use strict';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const PIPELINE_NAME = 'Pipeline de Servicios';
const PIPELINE_STAGE_NAME = 'Pendiente de Información';
const CONFIRMED_PIPELINE_STAGE_NAME = 'Cita Confirmada';
const BOOKING_TIMEZONE = 'America/New_York';
const BOOKING_WINDOW_DAYS = 60;
// One hour of notice for a normal booking; memberships must be booked 48h out.
const MIN_BOOKING_NOTICE_MS = 60 * 60 * 1000;
const MEMBERSHIP_BOOKING_NOTICE_MS = 48 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const GHL_REQUEST_TIMEOUT_MS = 10 * 1000;
const BOOKING_WEBHOOK_TIMEOUT_MS = 4 * 1000;
const DEPOSIT_PAYMENT_TIMEOUT_MS = 6 * 1000;

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
  'volteo-aluminio': new Set(['dump-truck-wash', 'dump-truck-2x', 'dump-truck-4x']),
  'car-hauler-second-deck': new Set([
    'car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x',
    // TODO(remove-graphite): retired packages, transition window only.
    'car-hauler-graphite-wash', 'car-hauler-graphite-2x', 'car-hauler-graphite-4x'
  ]),
  'lubricante-grafito': new Set(['car-hauler-wash', 'car-hauler-2x', 'car-hauler-4x'])
});
// Crew working hours and the grid of start times offered to customers.
const BUSINESS_DAY = Object.freeze({ start: '08:00', end: '18:00' });
const SLOT_GRID_MINUTES = 30;
const START_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
// TODO(remove-legacy-windows): retired named windows, transition window only.
const LEGACY_TIME_WINDOWS = Object.freeze({ morning: '08:00', afternoon: '12:00', evening: '16:00' });

// Per-category block length: the service itself plus the travel/setup buffer
// the crew needs afterwards. An appointment reserves service + buffer, so two
// bookings can never be scheduled back to back without the gap.
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
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SUBMISSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

// Multi-vehicle cart rules (mirrored by the frontend wizard):
// - Memberships and one-time washes may share a cart freely.
// - Duplicate lines are allowed (two trailers = two identical items).
// - Every item shares one visit: same date, time window, and address → one appointment.
// - Restricted add-ons are validated per item against that item's package.
// - The visit books the full day when ANY item is a full-day package.
const CART_RULES = Object.freeze({
  MAX_ITEMS: 6
});

const OPPORTUNITY_FIELDS = Object.freeze({
  category: 'Website Quote - Category',
  servicePackage: 'Website Quote - Package',
  size: 'Website Quote - Size or Quantity',
  addons: 'Website Quote - Add-ons',
  items: 'Website Quote - Items',
  itemCount: 'Website Quote - Item Count',
  vehicleMake: 'Website Quote - Vehicle Make',
  vehicleModel: 'Website Quote - Vehicle Model',
  vehicleYear: 'Website Quote - Vehicle Year',
  vehicleColor: 'Website Quote - Vehicle Color',
  vehiclePlate: 'Website Quote - License Plate',
  serviceAddress: 'Website Quote - Service Address',
  preferredDate: 'Website Quote - Preferred Date',
  preferredTime: 'Website Quote - Preferred Time',
  estimate: 'Website Quote - Estimate',
  deposit: 'Website Quote - Deposit Due',
  duration: 'Website Quote - Service Duration',
  notes: 'Website Quote - Customer Notes',
  language: 'Website Quote - Language',
  policyAcceptedAt: 'Website Quote - Policy Accepted At',
  submissionId: 'Website Quote - Submission ID',
  appointmentId: 'Website Quote - Appointment ID',
  bookingMode: 'Website Quote - Booking Mode',
  confirmedStart: 'Website Quote - Confirmed Start',
  confirmedEnd: 'Website Quote - Confirmed End',
  bookingStatus: 'Website Quote - Booking Status',
  depositStatus: 'Website Quote - Deposit Status',
  depositLink: 'Website Quote - Deposit Link'
});

// Custom fields that only need to exist in HighLevel once online deposit
// payments are turned on. Keeping them optional otherwise means Phase B can
// ship without forcing an immediate re-run of scripts/setup-ghl.mjs, and a
// flag left off behaves byte-for-byte like Phase A even if the fields are
// still missing upstream.
const DEPOSIT_PAYMENT_ONLY_FIELDS = new Set(['depositStatus', 'depositLink']);

let metadataPromise = null;

class RequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'RequestError';
    this.statusCode = statusCode;
  }
}

class HighLevelError extends Error {
  constructor(upstreamStatus, statusCode = 502) {
    super(`HighLevel request failed (${upstreamStatus})`);
    this.name = 'HighLevelError';
    this.statusCode = statusCode;
    this.upstreamStatus = upstreamStatus;
  }
}

class SlotUnavailableError extends RequestError {
  constructor() {
    super('The selected appointment is no longer available', 409);
    this.name = 'SlotUnavailableError';
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  const length = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new RequestError('Request body is too large', 413);
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (error) { throw new RequestError('Invalid JSON'); }
  }
  throw new RequestError('A JSON body is required');
}

function assertSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  const host = req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
  if (!origin || !host) throw new RequestError('Origin is required', 403);
  let originHost;
  try { originHost = new URL(origin).host; } catch (error) { throw new RequestError('Invalid origin', 403); }
  if (originHost !== host) throw new RequestError('Origin not allowed', 403);
}

function text(value, field, min = 0, max = 160) {
  if (typeof value !== 'string') throw new RequestError(`${field} must be text`);
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) throw new RequestError(`${field} is invalid`);
  return cleaned;
}

function optionalText(value, field, max = 160) {
  if (value == null || value === '') return '';
  return text(value, field, 0, max);
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  throw new RequestError('customer.phone is invalid');
}

function validateEmail(value) {
  const email = optionalText(value, 'customer.email', 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RequestError('customer.email is invalid');
  return email;
}

function validateId(value, field) {
  const id = text(value, field, 1, 80);
  if (!ID_PATTERN.test(id)) throw new RequestError(`${field} is invalid`);
  return id;
}

function validateNamedSelection(value, field) {
  if (!value || typeof value !== 'object') throw new RequestError(`${field} is required`);
  return { id: validateId(value.id, `${field}.id`), name: text(value.name, `${field}.name`, 1, 120) };
}

function validateEstimate(estimate, field) {
  const min = Number(estimate.min);
  const max = Number(estimate.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 100000) {
    throw new RequestError(`${field} is invalid`);
  }
  return {
    min,
    max,
    label: text(estimate.label, `${field}.label`, 1, 80),
    custom: Boolean(estimate.custom),
    isRange: Boolean(estimate.isRange)
  };
}

// One cart line: a service selection plus the vehicle it applies to.
function validateItem(item, field) {
  if (!item || typeof item !== 'object') throw new RequestError(`${field} is required`);
  const vehicle = item.vehicle || {};
  const estimate = item.estimate || {};

  const category = validateNamedSelection(item.category, `${field}.category`);
  if (!CATEGORY_IDS.has(category.id)) throw new RequestError(`${field}.category.id is invalid`);
  const servicePackage = validateNamedSelection(item.package, `${field}.package`);
  if (!PACKAGES_BY_CATEGORY[category.id].has(servicePackage.id)) throw new RequestError(`${field}.package.id is invalid for this category`);
  const size = validateNamedSelection(item.size, `${field}.size`);
  if (!SIZES_BY_PACKAGE[servicePackage.id] || !SIZES_BY_PACKAGE[servicePackage.id].has(size.id)) {
    throw new RequestError(`${field}.size.id is invalid for this package`);
  }
  const addonsInput = Array.isArray(item.addons) ? item.addons : [];
  if (addonsInput.length > 30) throw new RequestError(`${field}.addons is invalid`);
  const addons = addonsInput.map((addon, index) => {
    const named = validateNamedSelection(addon, `${field}.addons[${index}]`);
    if (!ADDONS_BY_CATEGORY[category.id].has(named.id)) {
      throw new RequestError(`${field}.addons[${index}].id is invalid for this category`);
    }
    const allowedPackages = PACKAGES_BY_RESTRICTED_ADDON[named.id];
    if (allowedPackages && !allowedPackages.has(servicePackage.id)) {
      throw new RequestError(`${field}.addons[${index}].id is invalid for this package`);
    }
    return { ...named, price: optionalText(addon.price, `${field}.addons[${index}].price`, 60) };
  });

  const year = Number(vehicle.year);
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < 1900 || year > maxYear) throw new RequestError(`${field}.vehicle.year is invalid`);

  return {
    category,
    package: servicePackage,
    size,
    addons,
    vehicle: {
      make: text(vehicle.make, `${field}.vehicle.make`, 2, 60),
      model: text(vehicle.model, `${field}.vehicle.model`, 2, 60),
      year,
      color: optionalText(vehicle.color, `${field}.vehicle.color`, 40),
      plate: optionalText(vehicle.plate, `${field}.vehicle.plate`, 16)
    },
    estimate: validateEstimate(estimate, `${field}.estimate`)
  };
}

function bookingModeForItems(items) {
  return items.some(item => bookingModeForPackage(item.package.id) === 'full_day') ? 'full_day' : 'slot';
}

// The item whose package decides the calendar mode for the whole visit.
function representativeItem(items) {
  return items.find(item => bookingModeForPackage(item.package.id) === 'full_day') || items[0];
}

function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  const submissionId = text(body.submissionId, 'submissionId', 8, 100);
  if (!SUBMISSION_PATTERN.test(submissionId)) throw new RequestError('submissionId is invalid');
  if (body.policyAccepted !== true) throw new RequestError('Service policies must be accepted');
  if (!['en', 'es'].includes(body.language)) throw new RequestError('language is invalid');

  const customer = body.customer || {};
  const schedule = body.schedule || {};

  // v2 payloads carry a cart in items[]; legacy payloads (long-lived open tabs)
  // carry a single selection/vehicle/estimate trio and normalize to one item.
  // TODO(remove-legacy-payload): drop the legacy branch when the window closes.
  let itemsInput;
  if (Array.isArray(body.items)) {
    if (body.items.length < 1 || body.items.length > CART_RULES.MAX_ITEMS) {
      throw new RequestError(`items must contain between 1 and ${CART_RULES.MAX_ITEMS} services`);
    }
    itemsInput = body.items;
  } else {
    const selection = body.selection || {};
    itemsInput = [{ ...selection, vehicle: body.vehicle || {}, estimate: body.estimate || {} }];
  }
  const items = itemsInput.map((item, index) => validateItem(item, `items[${index}]`));

  const date = text(schedule.date, 'schedule.date', 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new RequestError('schedule.date is invalid');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (date < today) throw new RequestError('schedule.date is in the past');
  if (date > addDays(today, BOOKING_WINDOW_DAYS)) throw new RequestError('schedule.date is too far ahead');
  const requestedWindow = text(schedule.timeWindow, 'schedule.timeWindow', 1, 20);
  // TODO(remove-legacy-windows): long-lived open tabs still post the retired
  // morning/afternoon/evening keys; map them onto the new start-time grid.
  const timeWindow = LEGACY_TIME_WINDOWS[requestedWindow] || requestedWindow;
  const packageIds = packageIdsOf(items);
  const bookingMode = bookingModeForItems(items);
  const durationMinutes = visitDurationMinutes(packageIds);
  if (bookingMode === 'full_day' && timeWindow !== 'full_day') {
    throw new RequestError('schedule.timeWindow must be full_day for this booking');
  }
  if (bookingMode === 'slot') {
    if (timeWindow === 'full_day') throw new RequestError('schedule.timeWindow is invalid for this booking');
    if (!START_TIME_PATTERN.test(timeWindow)) throw new RequestError('schedule.timeWindow is invalid');
    if (minutesFromTime(timeWindow) % SLOT_GRID_MINUTES !== 0) throw new RequestError('schedule.timeWindow is invalid');
    // Surfaces a start time that cannot finish before the crew's day ends.
    requestedPeriod(date, timeWindow, durationMinutes);
  }

  const policyAcceptedAt = text(body.policyAcceptedAt, 'policyAcceptedAt', 20, 40);
  if (Number.isNaN(Date.parse(policyAcceptedAt))) throw new RequestError('policyAcceptedAt is invalid');
  const zip = optionalText(customer.zip, 'customer.zip', 10);
  if (zip && !/^\d{5}$/.test(zip)) throw new RequestError('customer.zip is invalid');

  return {
    submissionId,
    language: body.language,
    policyAcceptedAt,
    website: optionalText(body.website, 'website', 200),
    customer: {
      name: text(customer.name, 'customer.name', 2, 100),
      phone: normalizePhone(customer.phone),
      email: validateEmail(customer.email),
      address: text(customer.address, 'customer.address', 4, 160),
      unit: optionalText(customer.unit, 'customer.unit', 40),
      city: text(customer.city, 'customer.city', 2, 80),
      zip
    },
    items,
    // Aliases for the first item, kept so single-item consumers and tests
    // keep working while the cart rollout completes.
    vehicle: items[0].vehicle,
    selection: { category: items[0].category, package: items[0].package, size: items[0].size, addons: items[0].addons },
    estimate: validateEstimate(body.estimate || {}, 'estimate'),
    schedule: {
      date,
      timeWindow,
      timeLabel: bookingLabel(timeWindow, body.language, durationMinutes),
      durationMinutes,
      notes: optionalText(schedule.notes, 'schedule.notes', 1000)
    },
    deposit: depositForPackages(packageIds)
  };
}

function getConfig() {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  const calendarId = process.env.GHL_CALENDAR_ID;
  const assignedUserId = process.env.GHL_ASSIGNED_USER_ID;
  if (!token || !locationId || !calendarId || !assignedUserId) throw new RequestError('CRM is not configured', 503);
  // The crews that can actually take a website booking today. Adding a van is a
  // matter of appending its user id here — no code change.
  const crewUserIds = String(process.env.GHL_CREW_USER_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return {
    token,
    locationId,
    calendarId,
    assignedUserId,
    crewUserIds: crewUserIds.length ? crewUserIds : [assignedUserId],
    pipelineId: process.env.GHL_PIPELINE_ID || '',
    pipelineStageId: process.env.GHL_PIPELINE_STAGE_ID || '',
    confirmedPipelineStageId: process.env.GHL_CONFIRMED_PIPELINE_STAGE_ID || '',
    // Phase B: online deposit collection. Off unless explicitly turned on, and
    // no other env var below is required unless it is.
    depositPaymentsEnabled: process.env.GHL_DEPOSIT_PAYMENTS === 'on',
    // Stripe is connected in both test and live mode on the sub-account; default
    // to test mode so turning the flag on can never move real money by accident.
    depositPaymentsLiveMode: process.env.GHL_DEPOSIT_LIVE_MODE === 'true'
  };
}

async function ghlRequest(config, path, options = {}) {
  let response;
  try {
    response = await fetch(`${GHL_BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        Version: options.version || 'v3',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal || AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new HighLevelError('timeout', 504);
    }
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const statusCode = response.status === 401 || response.status === 403 || response.status === 429 ? 503 : 502;
    // Server-side diagnostics: which GHL call failed and the upstream envelope.
    console.error('[ghl-fail]', options.method || 'GET', path, response.status, JSON.stringify(data).slice(0, 400));
    throw new HighLevelError(response.status, statusCode);
  }
  return data;
}

async function resolveMetadata(config) {
  if (!metadataPromise) {
    metadataPromise = (async () => {
      let pipelineId = config.pipelineId;
      let pipelineStageId = config.pipelineStageId;
      let confirmedPipelineStageId = config.confirmedPipelineStageId;
      if (!pipelineId || !pipelineStageId || !confirmedPipelineStageId) {
        const pipelineData = await ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`);
        const pipelines = pipelineData.pipelines || [];
        const pipeline = pipelines.find(item => String(item.name || '').toLowerCase() === PIPELINE_NAME.toLowerCase());
        const stages = pipeline && (pipeline.stages || []);
        const stage = stages && stages.find(item => String(item.name || '').toLowerCase() === PIPELINE_STAGE_NAME.toLowerCase());
        const confirmedStage = stages && stages.find(item => String(item.name || '').toLowerCase() === CONFIRMED_PIPELINE_STAGE_NAME.toLowerCase());
        if (!pipeline || !stage || !confirmedStage) throw new RequestError('Website booking pipeline is not configured', 503);
        pipelineId = pipeline.id;
        pipelineStageId = stage.id;
        confirmedPipelineStageId = confirmedStage.id;
      }

      const customFieldData = await ghlRequest(
        config,
        `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`
      );
      const fields = customFieldData.customFields || [];
      const fieldIds = {};
      const missing = [];
      Object.entries(OPPORTUNITY_FIELDS).forEach(([key, name]) => {
        const match = fields.find(field => field.model === 'opportunity' && String(field.name || '').toLowerCase() === name.toLowerCase());
        if (match) fieldIds[key] = match.id;
        // Deposit-payment fields are only required once the flag is on; a
        // location that hasn't re-run setup-ghl.mjs yet must still book normally.
        else if (config.depositPaymentsEnabled || !DEPOSIT_PAYMENT_ONLY_FIELDS.has(key)) missing.push(name);
      });
      if (missing.length) throw new RequestError('Website quote custom fields are not configured', 503);
      return { pipelineId, pipelineStageId, confirmedPipelineStageId, fieldIds };
    })().catch(error => {
      metadataPromise = null;
      throw error;
    });
  }
  return metadataPromise;
}

function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function bookingModeForPackage(packageId) {
  return FULL_DAY_PACKAGES.has(packageId) ? 'full_day' : 'slot';
}

function minutesFromTime(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function isMembershipPackage(packageId) {
  return MEMBERSHIP_PACKAGE_PATTERN.test(packageId);
}

function durationForPackage(packageId) {
  const duration = CATEGORY_DURATIONS[CATEGORY_BY_PACKAGE[packageId]];
  return duration || CATEGORY_DURATIONS.cars;
}

// Total minutes a cart occupies: every line's service time plus its buffer.
// Two vehicles in one visit are washed one after the other by the same crew.
function durationForPackages(packageIds) {
  return packageIds.reduce((total, packageId) => {
    const duration = durationForPackage(packageId);
    return total + duration.service + duration.buffer;
  }, 0);
}

function packageIdsOf(items) {
  return items.map(item => item.package.id);
}

// One deposit per booking: the largest one any line in the cart requires.
function depositForPackages(packageIds) {
  return packageIds.reduce(
    (amount, packageId) => Math.max(amount, DEPOSIT_BY_CATEGORY[CATEGORY_BY_PACKAGE[packageId]] || DEPOSIT_SMALL),
    0
  );
}

function noticeMsForPackages(packageIds) {
  return packageIds.some(isMembershipPackage) ? MEMBERSHIP_BOOKING_NOTICE_MS : MIN_BOOKING_NOTICE_MS;
}

function bookingLabel(timeWindow, language = 'en', durationMinutes = 0) {
  if (timeWindow === 'full_day') {
    return language === 'es' ? 'Día completo (8am–6pm)' : 'Full day (8am–6pm)';
  }
  if (!START_TIME_PATTERN.test(timeWindow || '')) return '';
  const start = minutesFromTime(timeWindow);
  const end = start + durationMinutes;
  const clock = minutes => {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const suffix = hour >= 12 ? 'pm' : 'am';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return minute ? `${hour12}:${String(minute).padStart(2, '0')}${suffix}` : `${hour12}${suffix}`;
  };
  return durationMinutes ? `${clock(start)}–${clock(end)}` : clock(start);
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function datesBetween(from, to) {
  const values = [];
  for (let date = from; date <= to; date = addDays(date, 1)) values.push(date);
  return values;
}

function zonedParts(timestamp, timezone = BOOKING_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

function zonedDateTimeToIso(date, time, timezone = BOOKING_TIMEZONE) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zonedParts(guess, timezone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
    guess += desired - represented;
  }
  return new Date(guess).toISOString();
}

function requestedPeriod(date, timeWindow, durationMinutes) {
  if (timeWindow === 'full_day') {
    return {
      startTime: zonedDateTimeToIso(date, BUSINESS_DAY.start),
      endTime: zonedDateTimeToIso(date, BUSINESS_DAY.end)
    };
  }
  if (!START_TIME_PATTERN.test(timeWindow || '')) throw new RequestError('schedule.timeWindow is invalid');
  const start = minutesFromTime(timeWindow);
  const end = start + durationMinutes;
  if (start < minutesFromTime(BUSINESS_DAY.start) || end > minutesFromTime(BUSINESS_DAY.end)) {
    throw new RequestError('schedule.timeWindow does not fit in the working day');
  }
  return {
    startTime: zonedDateTimeToIso(date, timeWindow),
    endTime: zonedDateTimeToIso(date, timeFromMinutes(end))
  };
}

function validateAvailabilityRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  // v2 asks for the whole cart so the grid reflects the combined duration;
  // a single packageId is still accepted for one-service lookups.
  const input = Array.isArray(body.packageIds) ? body.packageIds : [body.packageId];
  if (!input.length || input.length > CART_RULES.MAX_ITEMS) throw new RequestError('packageIds is invalid');
  const packageIds = input.map((value, index) => {
    const packageId = validateId(value, `packageIds[${index}]`);
    if (!SIZES_BY_PACKAGE[packageId]) throw new RequestError(`packageIds[${index}] is invalid`);
    return packageId;
  });
  const from = text(body.from, 'from', 10, 10);
  const to = text(body.to, 'to', 10, 10);
  if (!isValidDateOnly(from) || !isValidDateOnly(to) || to < from) throw new RequestError('date range is invalid');
  if (datesBetween(from, to).length > BOOKING_WINDOW_DAYS) throw new RequestError('date range is too large');
  return { packageIds, from, to };
}

// Every commitment already on a crew's calendar, including appointments booked
// by hand in HighLevel, so the website never offers a time the crew is out.
async function busyIntervalsByCrew(config, from, to) {
  const startTime = Date.parse(zonedDateTimeToIso(from, '00:00'));
  const endTime = Date.parse(zonedDateTimeToIso(addDays(to, 1), '00:00')) - 1;
  return Promise.all(config.crewUserIds.map(async userId => {
    const query = new URLSearchParams({
      locationId: config.locationId,
      userId,
      startTime: String(startTime),
      endTime: String(endTime)
    });
    const data = await ghlRequest(config, `/calendars/events?${query}`, { version: '2021-07-28' });
    return (data.events || [])
      .filter(event => !event.deleted && String(event.appointmentStatus || '') !== 'cancelled')
      .map(event => ({ start: Date.parse(event.startTime), end: Date.parse(event.endTime) }))
      .filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end));
  }));
}

function crewIsFree(intervals, start, end) {
  return !intervals.some(interval => interval.start < end && start < interval.end);
}

function bookingModeForPackages(packageIds) {
  return packageIds.some(id => bookingModeForPackage(id) === 'full_day') ? 'full_day' : 'slot';
}

function visitDurationMinutes(packageIds) {
  return bookingModeForPackages(packageIds) === 'full_day'
    ? minutesFromTime(BUSINESS_DAY.end) - minutesFromTime(BUSINESS_DAY.start)
    : durationForPackages(packageIds);
}

// Start times on a 30-minute grid that still finish inside the working day and
// that at least one crew can take. A visit is one crew from start to finish.
async function availabilityForCart(config, packageIds, from, to, now = Date.now()) {
  const bookingMode = bookingModeForPackages(packageIds);
  const durationMinutes = visitDurationMinutes(packageIds);
  const noticeMs = noticeMsForPackages(packageIds);
  const crews = await busyIntervalsByCrew(config, from, to);
  const dayStart = minutesFromTime(BUSINESS_DAY.start);
  const dayEnd = minutesFromTime(BUSINESS_DAY.end);
  const dates = [];

  for (const date of datesBetween(from, to)) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    const slots = [];
    for (let start = dayStart; start + durationMinutes <= dayEnd; start += SLOT_GRID_MINUTES) {
      const time = timeFromMinutes(start);
      const startsAt = Date.parse(zonedDateTimeToIso(date, time));
      if (startsAt < now + noticeMs) continue;
      const endsAt = Date.parse(zonedDateTimeToIso(date, timeFromMinutes(start + durationMinutes)));
      if (crews.some(intervals => crewIsFree(intervals, startsAt, endsAt))) {
        slots.push(bookingMode === 'full_day' ? 'full_day' : time);
      }
    }
    if (slots.length) dates.push({ date, slots });
  }

  return {
    timezone: BOOKING_TIMEZONE,
    bookingMode,
    durationMinutes,
    deposit: depositForPackages(packageIds),
    dates
  };
}

// GHL custom fields are single-value TEXT; keep serialized cart values bounded.
function truncateField(value, max = 450) {
  const str = String(value);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function uniqueJoin(values) {
  return [...new Set(values.filter(Boolean))].join('; ');
}

function addonsText(item) {
  return item.addons.length ? item.addons.map(addon => `${addon.name}${addon.price ? ` (${addon.price})` : ''}`).join(', ') : 'None';
}

// "2× Trailer Wash; 1× Car Hauler Basic Wash"
function packagesSummary(items) {
  const counts = new Map();
  items.forEach(item => counts.set(item.package.name, (counts.get(item.package.name) || 0) + 1));
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${count}× ${name}` : name)).join('; ');
}

function vehicleText(vehicle) {
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.color ? ` ${vehicle.color}` : ''}${vehicle.plate ? ` (${vehicle.plate})` : ''}`;
}

// Numbered one-line-per-item breakdown for the Items custom field and notes.
function itemsBreakdown(items) {
  return items.map((item, index) =>
    `${index + 1}) ${item.package.name} — ${item.size.name} — ${item.estimate.label} — ${vehicleText(item.vehicle)} — Add-ons: ${addonsText(item)}`
  ).join('\n');
}

// depositPayment is only ever passed on the follow-up update issued right
// after a deposit invoice link is created (see recordDepositPayment); every
// other caller leaves it null, so depositStatus/depositLink stay '' and no
// custom-field value is written when Phase B's flag is off.
function opportunityValues(payload, appointment = null, depositPayment = null) {
  const { customer, items, estimate, schedule } = payload;
  const single = items.length === 1;
  const values = {
    category: uniqueJoin(items.map(item => item.category.name)),
    servicePackage: packagesSummary(items),
    size: single ? items[0].size.name : items.map(item => item.size.name).join('; '),
    addons: single ? addonsText(items[0]) : items.map((item, index) => `${index + 1}) ${addonsText(item)}`).join('; '),
    items: itemsBreakdown(items),
    itemCount: String(items.length),
    vehicleMake: uniqueJoin(items.map(item => item.vehicle.make)),
    vehicleModel: uniqueJoin(items.map(item => item.vehicle.model)),
    vehicleYear: uniqueJoin(items.map(item => String(item.vehicle.year))),
    vehicleColor: uniqueJoin(items.map(item => item.vehicle.color)),
    vehiclePlate: uniqueJoin(items.map(item => item.vehicle.plate)),
    serviceAddress: [customer.address, customer.unit, customer.city, customer.zip].filter(Boolean).join(', '),
    preferredDate: schedule.date,
    preferredTime: schedule.timeLabel,
    estimate: estimate.label,
    deposit: `$${payload.deposit}`,
    duration: `${Math.floor(schedule.durationMinutes / 60)}h ${schedule.durationMinutes % 60}m`,
    notes: schedule.notes,
    language: payload.language,
    policyAcceptedAt: payload.policyAcceptedAt,
    submissionId: payload.submissionId,
    appointmentId: appointment ? appointment.id : '',
    bookingMode: bookingModeForItems(items),
    confirmedStart: appointment ? appointment.startTime : '',
    confirmedEnd: appointment ? appointment.endTime : '',
    bookingStatus: appointment ? 'confirmed' : 'pending',
    depositStatus: depositPayment ? 'unpaid' : '',
    depositLink: depositPayment && depositPayment.depositUrl ? depositPayment.depositUrl : ''
  };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, truncateField(value)]));
}

function opportunityCustomFieldValue(field) {
  if (!field || typeof field !== 'object') return '';
  if (field.fieldValue != null) return field.fieldValue;
  if (field.fieldValueString != null) return field.fieldValueString;
  return '';
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findOpportunityBySubmission(config, metadata, contactId, submissionId) {
  const searchParams = new URLSearchParams({
    locationId: config.locationId,
    pipelineId: metadata.pipelineId,
    contactId,
    status: 'all',
    limit: '100'
  });
  const existingData = await ghlRequest(config, `/opportunities/search?${searchParams}`);
  return (existingData.opportunities || []).find(opportunity =>
    (opportunity.customFields || []).some(field =>
      field.id === metadata.fieldIds.submissionId && String(opportunityCustomFieldValue(field)) === submissionId
    )
  );
}

function customFieldsForValues(metadata, values) {
  return Object.entries(values)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => ({ id: metadata.fieldIds[key], fieldValue: String(value) }));
}

function opportunityFieldValue(opportunity, fieldId) {
  const field = (opportunity.customFields || []).find(item => item.id === fieldId);
  return String(opportunityCustomFieldValue(field) || '');
}

async function upsertContact(config, payload) {
  const names = splitName(payload.customer.name);
  const contactBody = {
    locationId: config.locationId,
    name: payload.customer.name,
    firstName: names.firstName,
    lastName: names.lastName,
    phone: payload.customer.phone,
    address1: payload.customer.address,
    city: payload.customer.city,
    postalCode: payload.customer.zip,
    country: 'US',
    source: 'L&B Website Booking',
    assignedTo: config.assignedUserId,
    createNewIfDuplicateAllowed: false
  };
  if (payload.customer.email) contactBody.email = payload.customer.email;

  const contactResult = await ghlRequest(config, '/contacts/upsert', {
    method: 'POST',
    version: '2021-07-28',
    body: contactBody
  });
  const contact = contactResult.contact || contactResult;
  if (!contact || !contact.id) throw new HighLevelError(502);
  return contact;
}

async function createPendingOpportunity(config, metadata, contact, payload) {
  const values = opportunityValues(payload);
  const customFields = customFieldsForValues(metadata, values);
  const vehicleLabel = payload.items.length === 1
    ? `${payload.vehicle.year} ${payload.vehicle.make} ${payload.vehicle.model}`
    : `${payload.items.length} services`;

  let opportunityResult;
  try {
    opportunityResult = await ghlRequest(config, '/opportunities/', {
      method: 'POST',
      version: 'v3',
      body: {
        pipelineId: metadata.pipelineId,
        pipelineStageId: metadata.pipelineStageId,
        locationId: config.locationId,
        contactId: contact.id,
        name: `Web Booking - ${payload.customer.name} - ${vehicleLabel}`.slice(0, 160),
        status: 'open',
        assignedTo: config.assignedUserId,
        monetaryValue: Math.round(payload.estimate.min),
        customFields
      }
    });
  } catch (error) {
    // HighLevel's opportunity search index is eventually consistent. If a
    // retry arrives immediately, creation may reject the duplicate before the
    // first search can see it. Recheck briefly before returning an error.
    if (error instanceof HighLevelError && [400, 409, 422].includes(error.upstreamStatus)) {
      for (const delayMs of [250, 500, 1000]) {
        await wait(delayMs);
        const indexedOpportunity = await findOpportunityBySubmission(
          config, metadata, contact.id, payload.submissionId
        );
        if (indexedOpportunity) return indexedOpportunity;
      }
    }
    throw error;
  }
  const opportunity = opportunityResult.opportunity || opportunityResult;
  if (!opportunity || !opportunity.id) throw new HighLevelError(502);
  return opportunity;
}

function appointmentDescription(payload) {
  const lines = [`[Submission ID: ${payload.submissionId}]`];
  if (payload.items.length === 1) {
    const item = payload.items[0];
    lines.push(
      `Service: ${item.package.name}`,
      `Category: ${item.category.name}`,
      `Size / quantity: ${item.size.name}`,
      `Add-ons: ${addonsText(item)}`,
      `Estimate: ${payload.estimate.label}`,
      `Vehicle: ${item.vehicle.year} ${item.vehicle.make} ${item.vehicle.model} ${item.vehicle.color}`.trim(),
      `Plate: ${item.vehicle.plate || 'Not provided'}`
    );
  } else {
    lines.push(`Services (${payload.items.length}):`, itemsBreakdown(payload.items), `Total estimate: ${payload.estimate.label}`);
  }
  lines.push(
    `Address: ${[payload.customer.address, payload.customer.unit, payload.customer.city, payload.customer.zip].filter(Boolean).join(', ')}`,
    `Customer notes: ${payload.schedule.notes || 'None'}`,
    `Language: ${payload.language}`
  );
  return lines.join('\n');
}

async function findAppointmentBySubmission(config, payload, contactId) {
  const startTime = Date.parse(zonedDateTimeToIso(payload.schedule.date, '00:00'));
  const endTime = Date.parse(zonedDateTimeToIso(addDays(payload.schedule.date, 1), '00:00')) - 1;
  const query = new URLSearchParams({
    locationId: config.locationId,
    calendarId: config.calendarId,
    startTime: String(startTime),
    endTime: String(endTime)
  });
  const data = await ghlRequest(config, `/calendars/events?${query}`, { version: '2021-07-28' });
  const marker = `[Submission ID: ${payload.submissionId}]`;
  return (data.events || []).find(event =>
    event.contactId === contactId && !event.deleted && String(event.description || '').includes(marker)
  );
}

// Re-checks the requested period right before booking and returns the crew that
// will take it. Throws when the visit no longer fits anywhere.
async function assignCrewForVisit(config, payload) {
  const period = requestedPeriod(payload.schedule.date, payload.schedule.timeWindow, payload.schedule.durationMinutes);
  const startsAt = Date.parse(period.startTime);
  const endsAt = Date.parse(period.endTime);
  if (startsAt < Date.now() + noticeMsForPackages(packageIdsOf(payload.items))) throw new SlotUnavailableError();

  const crews = await busyIntervalsByCrew(config, payload.schedule.date, payload.schedule.date);
  const index = crews.findIndex(intervals => crewIsFree(intervals, startsAt, endsAt));
  if (index === -1) throw new SlotUnavailableError();
  return config.crewUserIds[index];
}

async function createAppointment(config, payload, contact, crewUserId) {
  const period = requestedPeriod(payload.schedule.date, payload.schedule.timeWindow, payload.schedule.durationMinutes);
  let result;
  try {
    result = await ghlRequest(config, '/calendars/events/appointments', {
      method: 'POST',
      version: '2021-07-28',
      body: {
        calendarId: config.calendarId,
        locationId: config.locationId,
        contactId: contact.id,
        assignedUserId: crewUserId,
        title: `${payload.items[0].package.name}${payload.items.length > 1 ? ` +${payload.items.length - 1} more` : ''} — ${payload.customer.name}`.slice(0, 160),
        appointmentStatus: 'confirmed',
        description: appointmentDescription(payload),
        address: [payload.customer.address, payload.customer.unit, payload.customer.city, payload.customer.zip].filter(Boolean).join(', '),
        meetingLocationType: 'address',
        overrideLocationConfig: true,
        startTime: period.startTime,
        endTime: period.endTime,
        // The website owns the grid now: start times sit on a 30-minute grid and
        // the length varies per cart, neither of which HighLevel's own slot
        // validation can express. assignCrewForVisit re-checks the crew instead.
        ignoreDateRange: true,
        ignoreFreeSlotValidation: true,
        toNotify: true
      }
    });
  } catch (error) {
    if (error instanceof HighLevelError && [400, 409, 422].includes(error.upstreamStatus)) throw new SlotUnavailableError();
    throw error;
  }
  const appointment = result.appointment || result;
  if (!appointment || !appointment.id) throw new HighLevelError(502);
  return { ...appointment, startTime: appointment.startTime || period.startTime, endTime: appointment.endTime || period.endTime };
}

async function finalizeOpportunity(config, metadata, opportunity, payload, appointment) {
  const customFields = customFieldsForValues(metadata, opportunityValues(payload, appointment));
  let result;
  for (const delayMs of [0, 250, 750]) {
    if (delayMs) await wait(delayMs);
    try {
      result = await ghlRequest(config, `/opportunities/${encodeURIComponent(opportunity.id)}`, {
        method: 'PUT',
        version: 'v3',
        body: {
          pipelineStageId: metadata.confirmedPipelineStageId,
          assignedTo: config.assignedUserId,
          monetaryValue: Math.round(payload.estimate.min),
          customFields
        }
      });
      break;
    } catch (error) {
      if (delayMs === 750) throw error;
    }
  }
  return (result && (result.opportunity || result)) || opportunity;
}

async function finalizeOpportunitySafely(config, metadata, opportunity, payload, appointment) {
  try {
    const updated = await finalizeOpportunity(config, metadata, opportunity, payload, appointment);
    return { opportunity: updated, syncPending: false };
  } catch (error) {
    console.error('[booking-sync]', payload.submissionId, error.name || 'Error', error.statusCode || 502);
    return { opportunity, syncPending: true };
  }
}

async function createBookingInHighLevel(config, metadata, payload) {
  const contact = await upsertContact(config, payload);
  let opportunity = await findOpportunityBySubmission(config, metadata, contact.id, payload.submissionId);

  if (opportunity) {
    const appointmentId = opportunityFieldValue(opportunity, metadata.fieldIds.appointmentId);
    if (appointmentId) {
      return { contactId: contact.id, opportunityId: opportunity.id, appointmentId, duplicate: true };
    }
    const existingAppointment = await findAppointmentBySubmission(config, payload, contact.id);
    if (existingAppointment) {
      const finalized = await finalizeOpportunitySafely(config, metadata, opportunity, payload, existingAppointment);
      return {
        contactId: contact.id,
        opportunityId: finalized.opportunity.id,
        appointmentId: existingAppointment.id,
        duplicate: true,
        syncPending: finalized.syncPending
      };
    }
  } else {
    opportunity = await createPendingOpportunity(config, metadata, contact, payload);
  }

  const crewUserId = await assignCrewForVisit(config, payload);
  const appointment = await createAppointment(config, payload, contact, crewUserId);
  const finalized = await finalizeOpportunitySafely(config, metadata, opportunity, payload, appointment);
  return {
    contactId: contact.id,
    opportunityId: finalized.opportunity.id,
    appointmentId: appointment.id,
    // Kept only on a freshly-created booking so a follow-up deposit-link update
    // (see recordDepositPayment) can resend the full custom-field set without
    // re-fetching the appointment. Duplicate/retry branches above never set
    // this, which is what keeps deposit-payment creation from being retried.
    appointment,
    duplicate: false,
    syncPending: finalized.syncPending
  };
}

// The opportunity is created straight into the confirmed stage, so HighLevel's
// "pipeline stage changed" triggers never fire for a website booking. This posts
// to an Inbound Webhook trigger instead, which a workflow can listen to.
// The booking already succeeded by this point: a failed notification is logged
// and swallowed so it can never turn a confirmed booking into an error.
async function notifyBookingWebhook(payload, booking) {
  const url = process.env.GHL_BOOKING_WEBHOOK_URL;
  if (!url) return;

  const lines = payload.items.map((item, index) => {
    const vehicle = `${item.vehicle.year} ${item.vehicle.make} ${item.vehicle.model}`;
    const addons = item.addons.length ? item.addons.map(addon => addon.name).join(', ') : 'None';
    return `${index + 1}) ${item.package.name} — ${item.size.name} — ${item.estimate.label} — ${vehicle} — Add-ons: ${addons}`;
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOKING_WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        submissionId: payload.submissionId,
        name: payload.customer.name,
        email: payload.customer.email,
        phone: payload.customer.phone,
        address: payload.customer.address,
        itemCount: payload.items.length,
        items: lines.join('\n'),
        estimate: payload.estimate.label,
        date: payload.schedule.date,
        timeLabel: payload.schedule.timeLabel,
        opportunityId: booking.opportunityId,
        appointmentId: booking.appointmentId
      })
    });
  } catch (error) {
    console.error('[quote] booking webhook failed', payload.submissionId, error.name || 'Error');
  } finally {
    clearTimeout(timer);
  }
}

// PHASE B — online deposit collection (see PHASE-B-DECISIONS.md).
//
// CONFIRM-THEN-PAY: the appointment is already confirmed by the time this
// runs, so a failure here can never downgrade a confirmed booking. It creates
// a GHL "text2pay" invoice for the deposit and returns its hosted payment URL,
// the same primitive the CRM's own Payments UI uses to text/email a paylink.
// Entirely gated behind GHL_DEPOSIT_PAYMENTS=on; callers must not invoke this
// when the flag is off.
async function createDepositPayment(config, payload, booking) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEPOSIT_PAYMENT_TIMEOUT_MS);
  try {
    const email = payload.customer.email;
    const result = await ghlRequest(config, '/invoices/text2pay', {
      method: 'POST',
      version: 'v3',
      signal: controller.signal,
      body: {
        altId: config.locationId,
        altType: 'location',
        name: `Booking Deposit — ${payload.submissionId}`.slice(0, 160),
        currency: 'USD',
        items: [{ name: 'Booking Deposit', currency: 'USD', amount: payload.deposit, qty: 1 }],
        contactDetails: {
          id: booking.contactId,
          name: payload.customer.name,
          phoneNo: payload.customer.phone,
          email
        },
        issueDate: new Date().toISOString().slice(0, 10),
        sentTo: { email: email ? [email] : [] },
        liveMode: config.depositPaymentsLiveMode,
        // 'send' publishes the invoice so the hosted link is actually payable.
        // ('draft' returns a URL but the page reads "Draft invoice cannot be
        // paid" — verified against the live sub-account.) Trade-off: GHL also
        // emails/SMSes the invoice to the customer on top of the booking's own
        // confirmation. Accepted because a non-payable link is worse.
        action: 'send',
        userId: config.assignedUserId
      }
    });
    const depositUrl = result && typeof result.invoiceUrl === 'string' ? result.invoiceUrl : '';
    const depositRef = result && result.invoice && result.invoice._id ? String(result.invoice._id) : '';
    if (!depositUrl) return null;
    return { depositUrl, depositRef };
  } catch (error) {
    console.error('[quote] deposit payment failed', payload.submissionId, error.name || 'Error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The deposit link only exists after createDepositPayment resolves, which is
// after the opportunity was already finalized once (see
// finalizeOpportunitySafely). This resends the full custom-field set — the
// same shape finalizeOpportunity used — rather than a partial patch, since a
// partial customFields array would otherwise overwrite the fields already
// stored on the opportunity. A failure here is logged and swallowed: the
// booking and its confirmation already succeeded.
async function recordDepositPayment(config, metadata, booking, payload, depositPayment) {
  try {
    const customFields = customFieldsForValues(metadata, opportunityValues(payload, booking.appointment, depositPayment));
    await ghlRequest(config, `/opportunities/${encodeURIComponent(booking.opportunityId)}`, {
      method: 'PUT',
      version: 'v3',
      body: {
        pipelineStageId: metadata.confirmedPipelineStageId,
        assignedTo: config.assignedUserId,
        monetaryValue: Math.round(payload.estimate.min),
        customFields
      }
    });
  } catch (error) {
    console.error('[quote] deposit field update failed', payload.submissionId, error.name || 'Error');
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  let submissionId = 'unknown';
  try {
    assertSameOrigin(req);
    const body = readBody(req);
    submissionId = typeof body.submissionId === 'string' ? body.submissionId.slice(0, 100) : 'unknown';
    const payload = validatePayload(body);

    // Silently accept honeypot submissions without creating CRM records.
    if (payload.website) return sendJson(res, 200, { ok: true, submissionId: payload.submissionId });

    const config = getConfig();
    const metadata = await resolveMetadata(config);
    const booking = await createBookingInHighLevel(config, metadata, payload);
    await notifyBookingWebhook(payload, booking);

    // Phase B: create a deposit payment link only for a freshly-confirmed
    // booking (never on a duplicate/retry, which would mint a second invoice
    // for the same appointment) and only when the flag is on.
    let depositUrl;
    if (config.depositPaymentsEnabled && !booking.duplicate) {
      const depositPayment = await createDepositPayment(config, payload, booking);
      if (depositPayment) {
        depositUrl = depositPayment.depositUrl;
        await recordDepositPayment(config, metadata, booking, payload, depositPayment);
      }
    }

    return sendJson(res, 200, {
      ok: true,
      submissionId: payload.submissionId,
      appointmentId: booking.appointmentId,
      opportunityId: booking.opportunityId,
      appointmentStatus: 'confirmed',
      duplicate: booking.duplicate,
      syncPending: Boolean(booking.syncPending),
      schedule: {
        date: payload.schedule.date,
        timeWindow: payload.schedule.timeWindow,
        timeLabel: payload.schedule.timeLabel
      },
      ...(depositUrl ? { depositUrl } : {})
    });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'CRM temporarily unavailable';
    if (statusCode >= 500) {
      console.error('[quote]', submissionId, error.name || 'Error', error.statusCode || statusCode);
    }
    return sendJson(res, statusCode, { ok: false, error: publicMessage });
  }
}

module.exports = handler;
module.exports._test = {
  OPPORTUNITY_FIELDS,
  BUSINESS_DAY,
  SLOT_GRID_MINUTES,
  CATEGORY_DURATIONS,
  DEPOSIT_BY_CATEGORY,
  FULL_DAY_PACKAGES,
  RequestError,
  HighLevelError,
  SlotUnavailableError,
  normalizePhone,
  splitName,
  validatePayload,
  validateAvailabilityRequest,
  bookingModeForPackage,
  bookingModeForItems,
  representativeItem,
  CART_RULES,
  bookingLabel,
  zonedDateTimeToIso,
  requestedPeriod,
  durationForPackages,
  visitDurationMinutes,
  depositForPackages,
  noticeMsForPackages,
  isMembershipPackage,
  availabilityForCart,
  opportunityValues,
  opportunityCustomFieldValue,
  getConfig,
  ghlRequest,
  assertSameOrigin,
  readBody,
  sendJson,
  createDepositPayment,
  recordDepositPayment,
  resetMetadataCache: () => { metadataPromise = null; }
};
