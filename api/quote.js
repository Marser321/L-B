'use strict';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const PIPELINE_NAME = 'Website Quotes';
const PIPELINE_STAGE_NAME = 'New Quote';
const MAX_BODY_BYTES = 32 * 1024;

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
const TIME_WINDOWS = new Set(['morning', 'afternoon', 'evening']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SUBMISSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

const OPPORTUNITY_FIELDS = Object.freeze({
  category: 'Website Quote - Category',
  servicePackage: 'Website Quote - Package',
  size: 'Website Quote - Size or Quantity',
  addons: 'Website Quote - Add-ons',
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
  submissionId: 'Website Quote - Submission ID'
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
  constructor(statusCode) {
    super(`HighLevel request failed (${statusCode})`);
    this.name = 'HighLevelError';
    this.statusCode = statusCode;
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
  if (!origin || !host) return;
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

function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  const submissionId = text(body.submissionId, 'submissionId', 8, 100);
  if (!SUBMISSION_PATTERN.test(submissionId)) throw new RequestError('submissionId is invalid');
  if (body.policyAccepted !== true) throw new RequestError('Service policies must be accepted');
  if (!['en', 'es'].includes(body.language)) throw new RequestError('language is invalid');

  const customer = body.customer || {};
  const vehicle = body.vehicle || {};
  const selection = body.selection || {};
  const estimate = body.estimate || {};
  const schedule = body.schedule || {};

  const category = validateNamedSelection(selection.category, 'selection.category');
  if (!CATEGORY_IDS.has(category.id)) throw new RequestError('selection.category.id is invalid');
  const servicePackage = validateNamedSelection(selection.package, 'selection.package');
  if (!PACKAGES_BY_CATEGORY[category.id].has(servicePackage.id)) throw new RequestError('selection.package.id is invalid for this category');
  const size = validateNamedSelection(selection.size, 'selection.size');
  const addonsInput = Array.isArray(selection.addons) ? selection.addons : [];
  if (addonsInput.length > 30) throw new RequestError('selection.addons is invalid');
  const addons = addonsInput.map((addon, index) => {
    const named = validateNamedSelection(addon, `selection.addons[${index}]`);
    return { ...named, price: optionalText(addon.price, `selection.addons[${index}].price`, 60) };
  });

  const year = Number(vehicle.year);
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < 1900 || year > maxYear) throw new RequestError('vehicle.year is invalid');

  const min = Number(estimate.min);
  const max = Number(estimate.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > 100000) {
    throw new RequestError('estimate is invalid');
  }

  const date = text(schedule.date, 'schedule.date', 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new RequestError('schedule.date is invalid');
  }
  if (date < new Date().toISOString().slice(0, 10)) throw new RequestError('schedule.date is in the past');
  const timeWindow = text(schedule.timeWindow, 'schedule.timeWindow', 1, 20);
  if (!TIME_WINDOWS.has(timeWindow)) throw new RequestError('schedule.timeWindow is invalid');

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
    vehicle: {
      make: text(vehicle.make, 'vehicle.make', 2, 60),
      model: text(vehicle.model, 'vehicle.model', 2, 60),
      year,
      color: optionalText(vehicle.color, 'vehicle.color', 40),
      plate: optionalText(vehicle.plate, 'vehicle.plate', 16)
    },
    selection: { category, package: servicePackage, size, addons },
    estimate: {
      min,
      max,
      label: text(estimate.label, 'estimate.label', 1, 80),
      custom: Boolean(estimate.custom),
      isRange: Boolean(estimate.isRange)
    },
    schedule: {
      date,
      timeWindow,
      timeLabel: text(schedule.timeLabel, 'schedule.timeLabel', 1, 80),
      notes: optionalText(schedule.notes, 'schedule.notes', 1000)
    }
  };
}

function getConfig() {
  const token = process.env.GHL_PRIVATE_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) throw new RequestError('CRM is not configured', 503);
  return {
    token,
    locationId,
    pipelineId: process.env.GHL_PIPELINE_ID || '',
    pipelineStageId: process.env.GHL_PIPELINE_STAGE_ID || ''
  };
}

async function ghlRequest(config, path, options = {}) {
  const response = await fetch(`${GHL_BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.token}`,
      Version: options.version || 'v3',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new HighLevelError(response.status);
  return data;
}

async function resolveMetadata(config) {
  if (!metadataPromise) {
    metadataPromise = (async () => {
      let pipelineId = config.pipelineId;
      let pipelineStageId = config.pipelineStageId;
      if (!pipelineId || !pipelineStageId) {
        const pipelineData = await ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`);
        const pipelines = pipelineData.pipelines || [];
        const pipeline = pipelines.find(item => String(item.name || '').toLowerCase() === PIPELINE_NAME.toLowerCase());
        const stage = pipeline && (pipeline.stages || []).find(item => String(item.name || '').toLowerCase() === PIPELINE_STAGE_NAME.toLowerCase());
        if (!pipeline || !stage) throw new RequestError('Website Quotes pipeline is not configured', 503);
        pipelineId = pipeline.id;
        pipelineStageId = stage.id;
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
      return { pipelineId, pipelineStageId, fieldIds };
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

function opportunityValues(payload) {
  const { customer, vehicle, selection, estimate, schedule } = payload;
  return {
    category: selection.category.name,
    servicePackage: selection.package.name,
    size: selection.size.name,
    addons: selection.addons.length ? selection.addons.map(item => `${item.name}${item.price ? ` (${item.price})` : ''}`).join(', ') : 'None',
    vehicleMake: vehicle.make,
    vehicleModel: vehicle.model,
    vehicleYear: String(vehicle.year),
    vehicleColor: vehicle.color,
    vehiclePlate: vehicle.plate,
    serviceAddress: [customer.address, customer.unit, customer.city, customer.zip].filter(Boolean).join(', '),
    preferredDate: schedule.date,
    preferredTime: schedule.timeLabel,
    estimate: estimate.label,
    notes: schedule.notes,
    language: payload.language,
    policyAcceptedAt: payload.policyAcceptedAt,
    submissionId: payload.submissionId
  };
}

async function createQuoteInHighLevel(config, metadata, payload) {
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
    source: 'L&B Website Quote',
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

  const values = opportunityValues(payload);
  const customFields = Object.entries(values)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => ({ id: metadata.fieldIds[key], fieldValue: String(value) }));
  const vehicleLabel = `${payload.vehicle.year} ${payload.vehicle.make} ${payload.vehicle.model}`;

  await ghlRequest(config, '/opportunities/', {
    method: 'POST',
    version: 'v3',
    body: {
      pipelineId: metadata.pipelineId,
      pipelineStageId: metadata.pipelineStageId,
      locationId: config.locationId,
      contactId: contact.id,
      name: `Web Quote - ${payload.customer.name} - ${vehicleLabel}`.slice(0, 160),
      status: 'open',
      monetaryValue: Math.round(payload.estimate.min),
      customFields
    }
  });
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
    await createQuoteInHighLevel(config, metadata, payload);
    return sendJson(res, 200, { ok: true, submissionId: payload.submissionId });
  } catch (error) {
    const statusCode = error instanceof RequestError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'CRM temporarily unavailable';
    console.error('[quote]', submissionId, error.name || 'Error', error.statusCode || statusCode);
    return sendJson(res, statusCode, { ok: false, error: publicMessage });
  }
}

module.exports = handler;
module.exports._test = {
  OPPORTUNITY_FIELDS,
  RequestError,
  normalizePhone,
  splitName,
  validatePayload,
  opportunityValues,
  resetMetadataCache: () => { metadataPromise = null; }
};
