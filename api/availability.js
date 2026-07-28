'use strict';

// POST /api/availability
//
// Takes the vehicles and services in the cart and answers with the start times
// where the whole visit can actually happen: N vehicles need N vans free at the
// same moment, each van for the length of the vehicle it would take. Durations are
// computed here from the server catalog — the browser's copy is a display detail.

const { RequestError, HighLevelError, TooManyVehiclesError } = require('./_lib/errors.js');
const { sendJson, readBody, assertSameOrigin, assertMethod } = require('./_lib/http.js');
const { text, validateId } = require('./_lib/validate.js');
const { normalizeVehicles } = require('./_lib/selection.js');
const { isValidDateOnly, datesBetween } = require('./_lib/time.js');
const { BOOKING_WINDOW_DAYS, MAX_VEHICLES, isKnownPackage } = require('./_lib/catalog.js');
const agenda = require('./_lib/agenda.js');

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');

  // Preferred shape: one entry per vehicle, with the size and add-ons that decide
  // its price. `packageIds` (and a bare `packageId`) stay accepted for tabs opened
  // before the cart shipped — same scheduling, no estimate in the response.
  let vehicles;
  if (Array.isArray(body.vehicles)) {
    vehicles = normalizeVehicles(body.vehicles, { requirePricing: false, field: 'vehicles' });
  } else {
    const legacy = Array.isArray(body.packageIds) ? body.packageIds : [body.packageId];
    if (!legacy.length) throw new RequestError('vehicles is required');
    if (legacy.length > MAX_VEHICLES) throw new TooManyVehiclesError(MAX_VEHICLES);
    vehicles = normalizeVehicles(
      legacy.map((packageId, index) => {
        const id = validateId(packageId, `packageIds[${index}]`);
        if (!isKnownPackage(id)) throw new RequestError(`packageIds[${index}] is invalid`);
        return { packageId: id };
      }),
      { requirePricing: false, field: 'packageIds' }
    );
  }

  const from = text(body.from, 'from', 10, 10);
  const to = text(body.to, 'to', 10, 10);
  if (!isValidDateOnly(from) || !isValidDateOnly(to) || to < from) throw new RequestError('date range is invalid');
  if (datesBetween(from, to).length > BOOKING_WINDOW_DAYS) throw new RequestError('date range is too large');

  return {
    vehicles,
    from,
    to,
    // Availability is also the authoritative quote-preview endpoint. The
    // language controls only returned display copy; it never changes pricing.
    language: body.language === 'es' ? 'es' : 'en'
  };
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    assertSameOrigin(req);
    const input = validateRequest(readBody(req));
    const availability = await agenda.computeAvailability(input);
    return sendJson(res, 200, { ok: true, ...availability });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const publicMessage = error instanceof RequestError ? error.message : 'Calendar temporarily unavailable';
    if (statusCode >= 500) console.error('[availability]', error.name || 'Error', error.statusCode || statusCode);
    return sendJson(res, statusCode, { ok: false, error: publicMessage, code: error.code || 'AVAILABILITY_UNAVAILABLE' });
  }
}

module.exports = handler;
module.exports._test = { validateRequest };
