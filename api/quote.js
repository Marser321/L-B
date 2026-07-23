'use strict';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const PIPELINE_NAME = 'Pipeline de Servicios';
const PIPELINE_STAGE_NAME = 'Pendiente de Información';
const CONFIRMED_PIPELINE_STAGE_NAME = 'Cita Confirmada';
const BOOKING_TIMEZONE = 'America/New_York';
const BOOKING_WINDOW_DAYS = 60;
const MIN_BOOKING_NOTICE_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const GHL_REQUEST_TIMEOUT_MS = 10 * 1000;
const BOOKING_WEBHOOK_TIMEOUT_MS = 4 * 1000;

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
const SLOT_DEFINITIONS = Object.freeze({
  morning: Object.freeze({ start: '08:00', end: '11:00', label: 'Morning (8am–12pm)' }),
  afternoon: Object.freeze({ start: '12:00', end: '15:00', label: 'Afternoon (12pm–4pm)' }),
  evening: Object.freeze({ start: '16:00', end: '19:00', label: 'Evening (4pm–7pm)' })
});
const TIME_WINDOWS = new Set([...Object.keys(SLOT_DEFINITIONS), 'full_day']);
const FULL_DAY_PACKAGES = new Set([
  ...PACKAGES_BY_CATEGORY.heavy_trucks,
  ...PACKAGES_BY_CATEGORY.boats,
  ...PACKAGES_BY_CATEGORY.mobile_home,
  ...PACKAGES_BY_CATEGORY.driveway,
  'paint-correction',
  'ceramic-protection'
]);
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
  notes: 'Website Quote - Customer Notes',
  language: 'Website Quote - Language',
  policyAcceptedAt: 'Website Quote - Policy Accepted At',
  submissionId: 'Website Quote - Submission ID',
  appointmentId: 'Website Quote - Appointment ID',
  bookingMode: 'Website Quote - Booking Mode',
  confirmedStart: 'Website Quote - Confirmed Start',
  confirmedEnd: 'Website Quote - Confirmed End',
  bookingStatus: 'Website Quote - Booking Status'
});

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
  if (date < new Date().toISOString().slice(0, 10)) throw new RequestError('schedule.date is in the past');
  const timeWindow = text(schedule.timeWindow, 'schedule.timeWindow', 1, 20);
  if (!TIME_WINDOWS.has(timeWindow)) throw new RequestError('schedule.timeWindow is invalid');
  const bookingMode = bookingModeForItems(items);
  if (bookingMode === 'full_day' && timeWindow !== 'full_day') {
    throw new RequestError('schedule.timeWindow must be full_day for this booking');
  }
  if (bookingMode === 'slot' && timeWindow === 'full_day') {
    throw new RequestError('schedule.timeWindow is invalid for this booking');
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
      timeLabel: bookingLabel(timeWindow, body.language),
      notes: optionalText(schedule.notes, 'schedule.notes', 1000)
    }
  };
}

function getConfig() {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  const calendarId = process.env.GHL_CALENDAR_ID;
  const assignedUserId = process.env.GHL_ASSIGNED_USER_ID;
  if (!token || !locationId || !calendarId || !assignedUserId) throw new RequestError('CRM is not configured', 503);
  return {
    token,
    locationId,
    calendarId,
    assignedUserId,
    pipelineId: process.env.GHL_PIPELINE_ID || '',
    pipelineStageId: process.env.GHL_PIPELINE_STAGE_ID || '',
    confirmedPipelineStageId: process.env.GHL_CONFIRMED_PIPELINE_STAGE_ID || ''
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
        else missing.push(name);
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

function bookingLabel(timeWindow, language = 'en') {
  const labels = {
    morning: { en: 'Morning (8am–12pm)', es: 'Mañana (8am–12pm)' },
    afternoon: { en: 'Afternoon (12pm–4pm)', es: 'Tarde (12pm–4pm)' },
    evening: { en: 'Evening (4pm–7pm)', es: 'Noche (4pm–7pm)' },
    full_day: { en: 'Full day (8am–7pm)', es: 'Día completo (8am–7pm)' }
  };
  return labels[timeWindow] ? labels[timeWindow][language] : '';
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

function requestedPeriod(date, timeWindow) {
  if (timeWindow === 'full_day') {
    return {
      startTime: zonedDateTimeToIso(date, '08:00'),
      endTime: zonedDateTimeToIso(date, '19:00')
    };
  }
  const definition = SLOT_DEFINITIONS[timeWindow];
  if (!definition) throw new RequestError('schedule.timeWindow is invalid');
  return {
    startTime: zonedDateTimeToIso(date, definition.start),
    endTime: zonedDateTimeToIso(date, definition.end)
  };
}

function validateAvailabilityRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  const packageId = validateId(body.packageId, 'packageId');
  if (!SIZES_BY_PACKAGE[packageId]) throw new RequestError('packageId is invalid');
  const from = text(body.from, 'from', 10, 10);
  const to = text(body.to, 'to', 10, 10);
  if (!isValidDateOnly(from) || !isValidDateOnly(to) || to < from) throw new RequestError('date range is invalid');
  if (datesBetween(from, to).length > BOOKING_WINDOW_DAYS) throw new RequestError('date range is too large');
  return { packageId, from, to };
}

function slotsForDate(response, date) {
  const day = response && (response[date] || (response.slots && response.slots[date]) || (response.availability && response.availability[date]));
  if (Array.isArray(day)) return day;
  if (day && Array.isArray(day.slots)) return day.slots;
  return [];
}

function slotStart(slot) {
  if (typeof slot === 'string') return slot;
  if (!slot || typeof slot !== 'object') return '';
  return slot.startTime || slot.start || slot.slot || '';
}

function slotKeyFromStart(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const parts = zonedParts(timestamp);
  const time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return Object.keys(SLOT_DEFINITIONS).find(key => SLOT_DEFINITIONS[key].start === time) || '';
}

async function availabilityForPackage(config, packageId, from, to, now = Date.now()) {
  const startDate = Date.parse(zonedDateTimeToIso(from, '00:00'));
  const endDate = Date.parse(zonedDateTimeToIso(addDays(to, 1), '00:00')) - 1;
  const query = new URLSearchParams({
    startDate: String(startDate),
    endDate: String(endDate),
    timezone: BOOKING_TIMEZONE,
    userId: config.assignedUserId
  });
  const freeSlotData = await ghlRequest(config, `/calendars/${encodeURIComponent(config.calendarId)}/free-slots?${query}`);
  const bookingMode = bookingModeForPackage(packageId);
  const dates = [];

  for (const date of datesBetween(from, to)) {
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue;
    const available = new Set(
      slotsForDate(freeSlotData, date)
        .map(slotStart)
        .filter(value => Date.parse(value) >= now + MIN_BOOKING_NOTICE_MS)
        .map(slotKeyFromStart)
        .filter(Boolean)
    );
    if (bookingMode === 'full_day') {
      if (Object.keys(SLOT_DEFINITIONS).every(key => available.has(key))) dates.push({ date, slots: ['full_day'] });
    } else {
      const slots = Object.keys(SLOT_DEFINITIONS).filter(key => available.has(key));
      if (slots.length) dates.push({ date, slots });
    }
  }

  return { timezone: BOOKING_TIMEZONE, bookingMode, dates };
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

function opportunityValues(payload, appointment = null) {
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
    notes: schedule.notes,
    language: payload.language,
    policyAcceptedAt: payload.policyAcceptedAt,
    submissionId: payload.submissionId,
    appointmentId: appointment ? appointment.id : '',
    bookingMode: bookingModeForItems(items),
    confirmedStart: appointment ? appointment.startTime : '',
    confirmedEnd: appointment ? appointment.endTime : '',
    bookingStatus: appointment ? 'confirmed' : 'pending'
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

async function ensureRequestedAvailability(config, payload) {
  const availability = await availabilityForPackage(
    config,
    representativeItem(payload.items).package.id,
    payload.schedule.date,
    payload.schedule.date
  );
  const day = availability.dates.find(item => item.date === payload.schedule.date);
  if (!day || !day.slots.includes(payload.schedule.timeWindow)) throw new SlotUnavailableError();
}

async function createAppointment(config, payload, contact) {
  const period = requestedPeriod(payload.schedule.date, payload.schedule.timeWindow);
  let result;
  try {
    result = await ghlRequest(config, '/calendars/events/appointments', {
      method: 'POST',
      version: '2021-07-28',
      body: {
        calendarId: config.calendarId,
        locationId: config.locationId,
        contactId: contact.id,
        // No assignedUserId on purpose: the calendar is round robin and its team
        // members are the vans, so HighLevel picks the next free one. Passing an
        // assignee here would pin every booking to one user and defeat that.
        // The contact and opportunity still belong to GHL_ASSIGNED_USER_ID.
        title: `${payload.items[0].package.name}${payload.items.length > 1 ? ` +${payload.items.length - 1} more` : ''} — ${payload.customer.name}`.slice(0, 160),
        appointmentStatus: 'confirmed',
        description: appointmentDescription(payload),
        address: [payload.customer.address, payload.customer.unit, payload.customer.city, payload.customer.zip].filter(Boolean).join(', '),
        meetingLocationType: 'address',
        overrideLocationConfig: true,
        startTime: period.startTime,
        endTime: period.endTime,
        ignoreDateRange: false,
        ignoreFreeSlotValidation: false,
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

  await ensureRequestedAvailability(config, payload);
  const appointment = await createAppointment(config, payload, contact);
  const finalized = await finalizeOpportunitySafely(config, metadata, opportunity, payload, appointment);
  return {
    contactId: contact.id,
    opportunityId: finalized.opportunity.id,
    appointmentId: appointment.id,
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
      }
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
  SLOT_DEFINITIONS,
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
  slotsForDate,
  availabilityForPackage,
  opportunityValues,
  opportunityCustomFieldValue,
  getConfig,
  ghlRequest,
  assertSameOrigin,
  readBody,
  sendJson,
  resetMetadataCache: () => { metadataPromise = null; }
};
