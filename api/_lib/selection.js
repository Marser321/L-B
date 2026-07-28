'use strict';

// Turns what the browser posted about a vehicle into what the server believes
// about it.
//
// In goes a set of catalog ids. Out comes a vehicle with its own duration, its own
// price and its own membership flag, all looked up server-side. Fields the browser
// may have sent for those values are dropped here — this is the single choke point
// that makes rule "never trust price, duration, membership status or calendar id
// from the browser" true by construction rather than by discipline.

const { RequestError, TooManyVehiclesError } = require('./errors.js');
const { text, optionalText, validateId, validateNamedSelection } = require('./validate.js');
const catalog = require('./catalog.js');
const pricing = require('./pricing.js');

// Availability only needs to know how long each vehicle takes, so it may omit
// size and add-ons; the booking endpoints require them, because they price.
function normalizeVehicle(input, field, { requirePricing = true, language = 'en' } = {}) {
  if (!input || typeof input !== 'object') throw new RequestError(`${field} is required`);

  const packageId = validateId(input.packageId ?? (input.package && input.package.id), `${field}.packageId`);
  if (!catalog.isKnownPackage(packageId)) throw new RequestError(`${field}.packageId is invalid`);
  const categoryId = catalog.categoryForPackage(packageId);

  const rawSizeId = input.sizeId ?? (input.size && input.size.id);
  let sizeId = null;
  if (rawSizeId != null && rawSizeId !== '') {
    sizeId = validateId(rawSizeId, `${field}.sizeId`);
    if (!catalog.SIZES_BY_PACKAGE[packageId].has(sizeId)) {
      throw new RequestError(`${field}.sizeId is invalid for this package`);
    }
  } else if (requirePricing) {
    throw new RequestError(`${field}.sizeId is required`);
  }

  const rawAddons = input.addonIds ?? (Array.isArray(input.addons) ? input.addons.map(addon => addon && addon.id) : []);
  const addonInput = Array.isArray(rawAddons) ? rawAddons : [];
  if (addonInput.length > 30) throw new RequestError(`${field}.addonIds is invalid`);
  const addonIds = addonInput.map((value, index) => {
    const addonId = validateId(value, `${field}.addonIds[${index}]`);
    if (!catalog.ADDONS_BY_CATEGORY[categoryId].has(addonId)) {
      throw new RequestError(`${field}.addonIds[${index}] is invalid for this category`);
    }
    if (!catalog.addonAppliesToPackage(addonId, packageId)) {
      throw new RequestError(`${field}.addonIds[${index}] is invalid for this package`);
    }
    return addonId;
  });
  // Two identical add-ons would be charged twice for one job.
  if (new Set(addonIds).size !== addonIds.length) throw new RequestError(`${field}.addonIds contains duplicates`);

  const vehicle = {
    categoryId,
    packageId,
    sizeId,
    addonIds,
    // Server-owned, every one of them.
    durationMinutes: catalog.vehicleDurationMinutes(packageId),
    bookingMode: catalog.bookingModeForPackage(packageId),
    isMembership: catalog.isMembershipPackage(packageId)
  };

  if (sizeId) {
    const estimate = pricing.estimateForVehicle({ packageId, sizeId, addonIds }, language);
    vehicle.estimate = estimate;
  }
  return vehicle;
}

// The vehicle's identity, for the CRM record and the calendar event title. Purely
// descriptive: nothing here influences scheduling or price.
function normalizeVehicleDescriptor(input, field) {
  const descriptor = (input && input.vehicle) || input || {};
  const year = Number(descriptor.year);
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < 1900 || year > maxYear) throw new RequestError(`${field}.vehicle.year is invalid`);
  return {
    make: text(descriptor.make, `${field}.vehicle.make`, 2, 60),
    model: text(descriptor.model, `${field}.vehicle.model`, 2, 60),
    year,
    color: optionalText(descriptor.color, `${field}.vehicle.color`, 40),
    plate: optionalText(descriptor.plate, `${field}.vehicle.plate`, 16)
  };
}

function vehicleLabel(descriptor) {
  return `${descriptor.year} ${descriptor.make} ${descriptor.model}`.trim();
}

// The list of vehicles in one visit. More than four is a 422 and not a 400: the
// request is perfectly well formed, there just aren't five vans.
function normalizeVehicles(input, { requirePricing = true, requireDescriptor = false, language = 'en', field = 'vehicles' } = {}) {
  if (!Array.isArray(input) || !input.length) throw new RequestError(`${field} must contain at least one vehicle`);
  if (input.length > catalog.MAX_VEHICLES) throw new TooManyVehiclesError(catalog.MAX_VEHICLES);

  return input.map((entry, index) => {
    const vehicle = normalizeVehicle(entry, `${field}[${index}]`, { requirePricing, language });
    vehicle.vehicleIndex = index;
    if (requireDescriptor) {
      vehicle.descriptor = normalizeVehicleDescriptor(entry, `${field}[${index}]`);
      vehicle.label = vehicleLabel(vehicle.descriptor);
    } else {
      vehicle.label = vehicle.packageId;
    }
    return vehicle;
  });
}

// Named { id, name } selections are only kept for CRM labels; every decision uses
// the ids validated above.
function namedLabels(entry, field) {
  return {
    category: validateNamedSelection(entry.category, `${field}.category`),
    package: validateNamedSelection(entry.package, `${field}.package`),
    size: validateNamedSelection(entry.size, `${field}.size`),
    addons: (Array.isArray(entry.addons) ? entry.addons : []).map((addon, index) =>
      validateNamedSelection(addon, `${field}.addons[${index}]`)
    )
  };
}

module.exports = {
  normalizeVehicle,
  normalizeVehicleDescriptor,
  normalizeVehicles,
  vehicleLabel,
  namedLabels
};
