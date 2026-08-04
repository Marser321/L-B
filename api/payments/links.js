'use strict';

// POST /api/payments/links
//
// Issues a payment link from catalog identifiers. This is the manual path the
// office asked for: pick what the customer is buying, send them a payable link,
// with no booking involved and no amount typed by hand.
//
// Requires OFFICE_API_TOKEN. It is not a customer-facing endpoint — the website
// gets its deposit link through the booking flow, which calls the same module.
//
// The request names ids only. Sending `amount`, `price` or a CRM `priceId` has no
// effect: every number is resolved from the server catalog, exactly as in the
// quote endpoint. There is therefore no way to talk this endpoint into charging
// less than the service costs.

const crypto = require('node:crypto');

const { RequestError, HighLevelError } = require('../_lib/errors.js');
const { sendJson, readBody, assertMethod } = require('../_lib/http.js');
const { text, optionalText, normalizePhone, validateEmail, validateId } = require('../_lib/validate.js');
const catalog = require('../_lib/catalog.js');
const membershipCatalog = require('../_lib/membership-catalog.js');
const paymentLinks = require('../_lib/payment-links.js');
const ghl = require('../_lib/ghl.js');

function assertOfficeToken(req) {
  const secret = String(process.env.OFFICE_API_TOKEN || '').trim();
  if (!secret) throw new RequestError('Office actions are not configured', 503, 'OFFICE_TOKEN_NOT_CONFIGURED');
  const header = String((req.headers && req.headers.authorization) || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new RequestError('Not authorized', 401, 'UNAUTHORIZED');
  }
}

function validateVehicleLine(entry, index) {
  const field = `vehicles[${index}]`;
  if (!entry || typeof entry !== 'object') throw new RequestError(`${field} is required`);
  const packageId = validateId(entry.packageId, `${field}.packageId`);
  if (!catalog.isKnownPackage(packageId)) throw new RequestError(`${field}.packageId is invalid`, 422);
  if (membershipCatalog.isSellableMembership(packageId)) {
    // A membership is a recurring contract, not a one-off line. Sending one here
    // would charge a single month and create no contract, no credits and no
    // renewal — a customer who thinks they joined and did not.
    throw new RequestError(`${field}.packageId is a membership; use purpose "membership"`, 422, 'PAYMENT_LINK_INVALID');
  }
  const sizeId = validateId(entry.sizeId, `${field}.sizeId`);
  if (!catalog.SIZES_BY_PACKAGE[packageId].has(sizeId)) {
    throw new RequestError(`${field}.sizeId is invalid for this package`, 422);
  }
  const categoryId = catalog.categoryForPackage(packageId);
  const addonIds = (Array.isArray(entry.addonIds) ? entry.addonIds : []).map((value, position) => {
    const addonId = validateId(value, `${field}.addonIds[${position}]`);
    if (!catalog.ADDONS_BY_CATEGORY[categoryId].has(addonId)) {
      throw new RequestError(`${field}.addonIds[${position}] is invalid for this category`, 422);
    }
    if (!catalog.addonAppliesToPackage(addonId, packageId)) {
      throw new RequestError(`${field}.addonIds[${position}] is invalid for this package`, 422);
    }
    return addonId;
  });
  return { packageId, sizeId, addonIds };
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  const purpose = text(body.purpose, 'purpose', 1, 24);
  if (!paymentLinks.PURPOSES.includes(purpose)) throw new RequestError('purpose is invalid', 400, 'PAYMENT_LINK_INVALID');

  const customer = body.customer || {};
  const contact = {
    id: text(customer.contactId, 'customer.contactId', 3, 64),
    name: text(customer.name, 'customer.name', 2, 100),
    email: validateEmail(customer.email),
    phone: customer.phone ? normalizePhone(customer.phone) : ''
  };

  const vehicles = (Array.isArray(body.vehicles) ? body.vehicles : []).map(validateVehicleLine);
  if (vehicles.length > catalog.MAX_VEHICLES) {
    throw new RequestError(`A link can cover at most ${catalog.MAX_VEHICLES} vehicles`, 422, 'MAX_VEHICLES_EXCEEDED');
  }

  // The deposit is a flag, not an amount: the server decides which of the two it
  // is from the vehicles on the link.
  const includeDeposit = body.deposit === true;
  const deposit = includeDeposit
    ? { amount: catalog.depositForPackages(vehicles.map(vehicle => vehicle.packageId)) }
    : null;

  if (purpose !== 'membership' && !vehicles.length && !deposit) {
    throw new RequestError('Send at least one vehicle, or deposit: true', 400, 'PAYMENT_LINK_EMPTY');
  }

  // Idempotency is the caller's declaration of what this link is FOR. A reference
  // is required so a double click cannot bill the customer twice.
  const reference = text(body.reference, 'reference', 4, 120);

  return {
    purpose,
    contact,
    vehicles,
    deposit,
    reference,
    contractId: optionalText(body.contractId, 'contractId', 64) || null,
    holdId: optionalText(body.holdId, 'holdId', 64) || null,
    createdBy: optionalText(body.createdBy, 'createdBy', 80) || 'office'
  };
}

async function handler(req, res) {
  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    assertOfficeToken(req);
    const input = validateRequest(readBody(req));
    const config = ghl.getConfig();

    let contract = null;
    if (input.purpose === 'membership') {
      if (!input.contractId) throw new RequestError('contractId is required for a membership link', 400, 'PAYMENT_LINK_INVALID');
      const { getRepository } = require('../_lib/repository.js');
      contract = await getRepository().getContract(input.contractId);
      if (!contract) throw new RequestError('Membership contract not found', 404, 'CONTRACT_NOT_FOUND');
    }

    const lines = await paymentLinks.buildLines({
      purpose: input.purpose,
      vehicles: input.vehicles,
      deposit: input.deposit,
      contract,
      livemode: Boolean(config.depositPaymentsLiveMode)
    });

    const link = await paymentLinks.issuePaymentLink({
      // Derived from the caller's own reference, so retrying is safe and two
      // different quotes never collide.
      idempotencyKey: `office:${input.purpose}:${input.reference}`,
      purpose: input.purpose,
      origin: 'office',
      contact: input.contact,
      lines,
      holdId: input.holdId,
      contractId: input.contractId,
      createdBy: input.createdBy,
      config
    });

    return sendJson(res, link.duplicate ? 200 : 201, {
      ok: true,
      url: link.url,
      amount: link.amount,
      status: link.status,
      duplicate: link.duplicate,
      // Echoed so the operator can read back what the customer will see.
      lines: lines.map(line => ({ name: line.name, amount: line.amountCents / 100, linked: Boolean(line.crmPriceId) }))
    });
  } catch (error) {
    const statusCode = error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : 502;
    const message = error instanceof RequestError ? error.message : 'Could not create the payment link';
    if (statusCode >= 500) console.error('[payment-links]', error.name || 'Error', error.code || '', statusCode);
    return sendJson(res, statusCode, { ok: false, error: message, code: error.code || 'PAYMENT_LINK_FAILED' });
  }
}

module.exports = handler;
module.exports._test = { validateRequest, validateVehicleLine, assertOfficeToken };
