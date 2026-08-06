'use strict';

const crypto = require('node:crypto');

// The member's own page: what they have left, and one button to use it.
//
// The point is that a member should not re-answer questions the contract already
// answers. Category, package, size and vehicle are all on the contract, so booking is
// choosing a time — nothing else. No cart, no price, no deposit, no payment step,
// because the cycle is already paid for.
//
// Authorisation is a signed link, not a login (api/_lib/signed-link.js). The subject of
// the token is the CONTRACT, so a link opens exactly one membership.
//
// Everything comes from the CRM. There is no database call in this file, which is the
// point: it is the first flow written entirely the way the rest is going
// (DISENO-SIN-BASE-DE-DATOS.md).
//
// What a leaked link can do is bounded here:
//
//   · read one contract's plan, vehicle, balance and next visit — no phone, no email,
//     no address, no payment identifiers, and nothing about any other member
//   · book a wash the contract is already entitled to, at least 48 hours out and
//     inside the paid cycle
//   · nothing else. It cannot cancel, reschedule, change the plan, or spend money.

const { RequestError, HighLevelError } = require('./_lib/errors.js');
const { sendJson, readBody, assertSameOrigin, assertMethod } = require('./_lib/http.js');
const { text, optionalText, normalizePhone, validateEmail, SUBMISSION_PATTERN } = require('./_lib/validate.js');
const { isValidDateOnly, START_TIME_PATTERN } = require('./_lib/time.js');
const catalog = require('./_lib/catalog.js');
const ghl = require('./_lib/ghl.js');
const time = require('./_lib/time.js');
const signedLink = require('./_lib/signed-link.js');
const membershipCrm = require('./_lib/membership-crm.js');
const redemptionToken = require('./_lib/redemption-token.js');
const pricing = require('./_lib/pricing.js');
const crmCatalog = require('./_lib/crm-catalog.js');
const membershipCatalog = require('./_lib/membership-catalog.js');
const recurring = require('./_lib/crm-recurring-memberships.js');
const { publicAppUrl } = require('./_lib/public-url.js');

// The opportunity custom fields the contract lives in. Resolved by NAME because the ids
// differ per sub-account, then cached for the life of the lambda.
const FIELD_NAMES = Object.freeze({
  plan: 'Membership Plan',
  vehicle: 'Membership Vehicle',
  status: 'Membership Status',
  // Added by scripts/setup-membership-fields.mjs. Absent is tolerated: a member is not
  // refused because the office has not filled in a field yet.
  cycleEnds: 'Membership Cycle Ends'
});

// The Memberships pipeline, resolved by name for the same reason the fields are: ids
// differ per sub-account. Cached alongside them.
const PIPELINE_NAME = 'Memberships';

const ENROLLMENT_FIELD_NAMES = Object.freeze({
  plan: 'Membership Plan', vehicle: 'Membership Vehicle', status: 'Membership Status',
  cycleEnds: 'Membership Cycle Ends', portalUrl: 'Membership Portal URL', checkoutId: 'Membership Checkout ID',
  // Holds the recurring schedule, so a contract can never acquire a second one.
  //
  // Reuses the field Stripe left behind rather than adding a seventh: it already exists
  // in the sub-account (verified 5 ago 2026), it means exactly this — the id of the
  // recurring billing agreement — and the Memberships pipeline has zero opportunities,
  // so there is no stale Stripe value anywhere for it to be confused with. Reusing it
  // is what lets this deploy without provisioning anything in the CRM first.
  scheduleId: 'Membership Subscription ID'
});

let fieldCache = null;
let stageCache = null;

async function fieldIds(config) {
  if (fieldCache) return fieldCache;
  const data = await ghl.ghlRequest(config, `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`, {
    version: '2021-07-28'
  });
  const byName = new Map((data.customFields || []).map(field => [String(field.name || '').trim(), field.id]));
  fieldCache = Object.fromEntries(
    Object.entries(FIELD_NAMES).map(([key, name]) => [key, byName.get(name) || ''])
  );
  if (!fieldCache.plan) {
    fieldCache = null;
    throw new RequestError('Memberships are not configured in the CRM', 503, 'MEMBERSHIP_FIELDS_MISSING');
  }
  return fieldCache;
}

function statusCodeFor(error, fallback) {
  return error instanceof RequestError || error instanceof HighLevelError ? error.statusCode : fallback;
}

function publicError(error, fallbackCode) {
  return {
    ok: false,
    error: error instanceof RequestError ? error.message : 'Membership temporarily unavailable',
    code: error.code || fallbackCode
  };
}

function tokenFrom(req, body) {
  const fromQuery = req.query && (req.query.t || req.query.token);
  return text(fromQuery || (body && body.t), 't', 8, 200);
}

// stageId → stage name, for the pipeline the contracts live in. An absent pipeline is
// tolerated: the status then falls back to the custom field.
async function stageNames(config) {
  if (stageCache) return stageCache;
  const data = await ghl.ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`, {
    version: '2021-07-28'
  });
  const pipeline = (data.pipelines || []).find(entry => String(entry.name || '').trim() === PIPELINE_NAME);
  stageCache = Object.fromEntries(((pipeline && pipeline.stages) || []).map(stage => [stage.id, stage.name]));
  return stageCache;
}

async function loadContract(config, token, redemption = false) {
  const contractId = redemption ? redemptionToken.verify(token) : signedLink.verify('member', token);
  const [ids, stages] = await Promise.all([fieldIds(config), stageNames(config)]);
  let data;
  try {
    data = await ghl.ghlRequest(config, `/opportunities/${encodeURIComponent(contractId)}`, {
      version: '2021-07-28'
    });
  } catch (error) {
    // A contract that no longer exists is not an outage. Left as a 502 the member would
    // read "temporarily unavailable" and retry a link that will never work again.
    if (error instanceof HighLevelError && error.upstreamStatus === 404) {
      throw new RequestError('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
    }
    throw error;
  }
  return membershipCrm.readContract(data.opportunity || data, ids, stages);
}

// The dates a member may choose: from 48 hours out to the end of the paid cycle, capped
// by the normal booking window. Computed rather than fetched.
function bookableRange(contract, now = Date.now()) {
  const timezone = time.bookingTimezone();
  const earliest = now + catalog.MEMBERSHIP_BOOKING_NOTICE_MS;
  const windowEnd = now + catalog.BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const latest = contract.cycleEndsMs ? Math.min(contract.cycleEndsMs, windowEnd) : windowEnd;
  return {
    from: time.todayInZone(earliest, timezone),
    to: time.todayInZone(Math.max(earliest, latest), timezone)
  };
}

function availableAddons(contract) {
  const categoryId = catalog.categoryForPackage(contract.packageId);
  return [...(catalog.ADDONS_BY_CATEGORY[categoryId] || [])]
    .filter(addonId => catalog.addonAppliesToPackage(addonId, contract.packageId))
    .map(addonId => ({ addonId, bounds: pricing.addonPriceBounds(addonId) }))
    .filter(entry => !entry.bounds.custom && entry.bounds.min > 0)
    .map(entry => ({ id: entry.addonId, name: crmCatalog.addonName(entry.addonId), amount: entry.bounds.min }));
}

function selectedAddons(contract, addonIds) {
  if (!Array.isArray(addonIds) || addonIds.length > 12 || new Set(addonIds).size !== addonIds.length) {
    throw new RequestError('addonIds is invalid', 422);
  }
  const allowed = new Map(availableAddons(contract).map(addon => [addon.id, addon]));
  return addonIds.map(id => {
    const addon = allowed.get(String(id));
    if (!addon) throw new RequestError('An add-on is invalid for this membership', 422, 'MEMBERSHIP_ADDON_INVALID');
    return addon;
  });
}

async function createAddonPayment(config, contract, visit, addons) {
  if (!addons.length) return null;
  const invoice = await ghl.createPayableInvoice(config, {
    contactId: contract.contactId,
    title: `Membership add-ons — ${visit.appointmentId}`,
    items: addons.map(addon => ({ name: addon.name, amount: addon.amount })),
    reference: visit.appointmentId,
    liveMode: Boolean(config.membershipPaymentsLiveMode)
  });
  return { invoiceId: invoice.id, url: invoice.url };
}

function validateEnrollment(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  if (Array.isArray(body.items) && body.items.length !== 1) throw new RequestError('One membership vehicle is required per checkout', 422, 'MEMBERSHIP_ONE_PER_CHECKOUT');
  const line = Array.isArray(body.items) ? body.items[0] : body;
  const packageId = text(line.packageId, 'packageId', 2, 80);
  const sizeId = text(line.sizeId, 'sizeId', 2, 80);
  membershipCatalog.priceFor(packageId, sizeId);
  const vehicle = line.vehicle || {};
  const year = Number(vehicle.year);
  if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear() + 1) throw new RequestError('vehicle.year is invalid');
  const make = text(vehicle.make, 'vehicle.make', 1, 60);
  const model = text(vehicle.model, 'vehicle.model', 1, 60);
  const color = optionalText(vehicle.color, 'vehicle.color', 40);
  const plate = optionalText(vehicle.plate, 'vehicle.plate', 30);
  const customer = body.customer || {};
  const submissionId = text(body.submissionId || crypto.randomUUID(), 'submissionId', 8, 100);
  if (!SUBMISSION_PATTERN.test(submissionId)) throw new RequestError('submissionId is invalid');
  return {
    submissionId, packageId, sizeId,
    vehicleLabel: [year, make, model, color, plate ? `(${plate})` : ''].filter(Boolean).join(' '),
    customer: {
      name: text(customer.name, 'customer.name', 2, 100), phone: normalizePhone(customer.phone),
      email: validateEmail(customer.email), address: optionalText(customer.address, 'customer.address', 160),
      city: optionalText(customer.city, 'customer.city', 80), zip: optionalText(customer.zip, 'customer.zip', 10)
    }
  };
}

async function enrollmentMetadata(config) {
  const [pipelinesData, fieldsData] = await Promise.all([
    ghl.ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`, { version: '2021-07-28' }),
    ghl.ghlRequest(config, `/locations/${encodeURIComponent(config.locationId)}/customFields?model=opportunity`, { version: '2021-07-28' })
  ]);
  const pipeline = (pipelinesData.pipelines || []).find(item => String(item.name || '').trim().toLowerCase() === 'memberships');
  const pending = pipeline && (pipeline.stages || []).find(item => String(item.name || '').trim().toLowerCase() === 'pending payment');
  const byName = new Map((fieldsData.customFields || []).map(field => [String(field.name || '').trim().toLowerCase(), field.id]));
  const fields = Object.fromEntries(Object.entries(ENROLLMENT_FIELD_NAMES).map(([key, name]) => [key, byName.get(name.toLowerCase()) || '']));
  if (!pipeline || !pending || Object.values(fields).some(value => !value)) throw new RequestError('Membership CRM structure is incomplete', 503, 'MEMBERSHIP_CRM_NOT_CONFIGURED');
  return { pipelineId: pipeline.id, pendingStageId: pending.id, fields };
}

async function findEnrollment(config, meta, contactId, submissionId) {
  const query = new URLSearchParams({ location_id: config.locationId, contact_id: contactId, pipeline_id: meta.pipelineId, status: 'all', limit: '100' });
  const data = await ghl.ghlRequest(config, `/opportunities/search?${query}`, { version: '2021-07-28' });
  return (data.opportunities || []).find(opportunity => (opportunity.customFields || []).some(field =>
    field.id === meta.fields.checkoutId && String(field.fieldValue ?? field.value ?? '') === submissionId
  ));
}

async function createEnrollment(config, meta, contact, input) {
  const existing = await findEnrollment(config, meta, contact.id, input.submissionId);
  if (existing) return existing;
  const customFields = [
    [meta.fields.plan, input.packageId], [meta.fields.vehicle, input.vehicleLabel],
    [meta.fields.status, 'pending_payment'], [meta.fields.checkoutId, input.submissionId]
  ].map(([id, fieldValue]) => ({ id, fieldValue }));
  const result = await ghl.ghlRequest(config, '/opportunities/', {
    method: 'POST', version: '2021-07-28', requestId: input.submissionId,
    body: {
      pipelineId: meta.pipelineId, pipelineStageId: meta.pendingStageId, locationId: config.locationId,
      contactId: contact.id, name: `Membership — ${input.customer.name} — ${input.vehicleLabel}`.slice(0, 160),
      status: 'open', assignedTo: config.assignedUserId,
      monetaryValue: membershipCatalog.priceFor(input.packageId, input.sizeId).monthlyCents / 100,
      customFields
    }
  });
  const opportunity = result.opportunity || result;
  if (!opportunity || !opportunity.id) throw new HighLevelError(502);
  return opportunity;
}

function customFieldValue(opportunity, fieldId) {
  const field = (opportunity && opportunity.customFields || []).find(entry => entry.id === fieldId);
  return field ? String(field.fieldValue ?? field.value ?? '') : '';
}

// Written into the contract BEFORE the schedule is asked for, so that a retry which
// arrives while the first attempt is still in flight — or after it died without
// reporting back — can tell "nothing was created" apart from "something may have been".
const ATTEMPT_PREFIX = 'pending:';

// The one recurring schedule this contract is allowed to have.
//
// createEnrollment is idempotent (it finds the contract by checkout id), but creating
// the SCHEDULE was not: it ran unconditionally afterwards, so a customer who pressed
// submit twice — or once, on a request whose response was lost — ended up subscribed
// twice and billed twice every month, with no endpoint able to cancel either one.
//
// The order below is chosen so that every crash point fails towards NOT billing twice:
//
//   1. a real schedule id on the contract  → reuse it, hand back the same link
//   2. an attempt marker                   → something may exist. Look for it; adopt it
//                                            if found, and REFUSE if not. A membership
//                                            the office has to finish by hand is a far
//                                            cheaper mistake than a double charge
//   3. nothing                             → mark the attempt, then create
async function ensureRecurringSchedule(config, meta, contract, contact, input) {
  const recorded = customFieldValue(contract, meta.fields.scheduleId).trim();
  const shared = {
    config, request: ghl.ghlRequest, reference: contract.id,
    liveMode: Boolean(config.membershipPaymentsLiveMode)
  };

  if (recorded && !recorded.startsWith(ATTEMPT_PREFIX)) {
    console.log('[member-enroll] reusing schedule', contract.id, recorded);
    return { scheduleId: recorded, url: await recurring.scheduleUrl({ ...shared, scheduleId: recorded }), reused: true };
  }

  if (recorded.startsWith(ATTEMPT_PREFIX)) {
    const found = await recurring.findScheduleByReference(shared);
    if (!found) {
      console.error('[member-enroll] attempt in doubt, refusing to create a second schedule', contract.id);
      throw new RequestError(
        'Tu membresía quedó a medio activar. No la volvemos a cobrar: la oficina la termina y te avisa.',
        409, 'MEMBERSHIP_SCHEDULE_IN_DOUBT'
      );
    }
    await ghl.updateOpportunityFields(config, contract.id, [{ id: meta.fields.scheduleId, value: found }]);
    console.log('[member-enroll] adopted orphan schedule', contract.id, found);
    return { scheduleId: found, url: await recurring.scheduleUrl({ ...shared, scheduleId: found }), reused: true };
  }

  await ghl.updateOpportunityFields(config, contract.id, [
    { id: meta.fields.scheduleId, value: `${ATTEMPT_PREFIX}${input.submissionId}` }
  ]);
  const billing = await recurring.createAndSchedule({
    ...shared, contact: { ...input.customer, id: contact.id }, packageId: input.packageId,
    sizeId: input.sizeId, vehicleLabel: input.vehicleLabel,
    timeZone: process.env.BOOKING_TIMEZONE || 'America/New_York'
  });
  await ghl.updateOpportunityFields(config, contract.id, [{ id: meta.fields.scheduleId, value: billing.scheduleId }]);
  return { ...billing, reused: false };
}

async function enrollMembership(body) {
  const input = validateEnrollment(body);
  const config = { ...ghl.getConfig(), ...ghl.getPaymentsConfig() };
  const meta = await enrollmentMetadata(config);
  const contact = await ghl.upsertContact(config, input.customer);
  const contract = await createEnrollment(config, meta, contact, input);
  const portalUrl = `${publicAppUrl()}/m/${encodeURIComponent(signedLink.sign('member', contract.id))}`;
  await ghl.updateOpportunityFields(config, contract.id, [{ id: meta.fields.portalUrl, value: portalUrl }]);
  const billing = await ensureRecurringSchedule(config, meta, contract, contact, input);
  return {
    ok: true, status: 'pending_payment', checkoutUrl: billing.url || null,
    delivery: billing.url ? 'redirect' : 'email', liveMode: Boolean(config.membershipPaymentsLiveMode)
  };
}

async function checkPublicEligibility(body) {
  const email = validateEmail(body.email).toLowerCase();
  const phone = normalizePhone(body.phone);
  const plate = text(body.plate, 'plate', 2, 30).replace(/[^a-z0-9]/gi, '').toLowerCase();
  const packageId = text(body.packageId, 'packageId', 2, 80);
  const config = ghl.getConfig();
  const query = new URLSearchParams({ locationId: config.locationId, email, number: phone });
  const found = await ghl.ghlRequest(config, `/contacts/search/duplicate?${query}`, { version: '2021-07-28' });
  const contact = found.contact || found;
  if (!contact.id || String(contact.email || '').toLowerCase() !== email || normalizePhone(contact.phone || '') !== phone) return { ok: true, eligible: false };
  const [ids, stages] = await Promise.all([fieldIds(config), stageNames(config)]);
  const pipelines = await ghl.ghlRequest(config, `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`, { version: '2021-07-28' });
  const pipeline = (pipelines.pipelines || []).find(item => String(item.name || '') === PIPELINE_NAME);
  const contracts = await ghl.opportunitiesForContact(config, { contactId: contact.id, pipelineId: pipeline && pipeline.id || '' });
  const match = contracts.map(opportunity => {
    try { return membershipCrm.readContract(opportunity, ids, stages); } catch { return null; }
  }).find(contract => contract && contract.packageId === packageId && contract.status === 'active' && contract.vehicleLabel.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(plate));
  if (!match) return { ok: true, eligible: false };
  return { ok: true, eligible: true, redemptionToken: redemptionToken.issue(match.contractId), remaining: (await membershipCrm.balanceFor(config, match)).remaining };
}

// Which grid times on ONE date have at least one van free. Four calendar reads, and only
// when the member is actually choosing a day — the page does not pay for this on load.
async function slotsForDate(config, contract, date, now = Date.now()) {
  const timezone = time.bookingTimezone();
  const visitMinutes = catalog.visitDurationMinutes([contract.packageId]);
  const { fromMs, toMs } = {
    fromMs: time.zonedDateTimeToMs(date, '00:00', timezone),
    toMs: time.zonedDateTimeToMs(time.addDays(date, 1), '00:00', timezone)
  };

  const busyByVan = await Promise.all(config.resources.map(async resource => {
    const events = await ghl.calendarEventsForCalendar(config, resource.calendarId, fromMs, toMs);
    return events
      .filter(event => String(event.appointmentStatus || '') !== 'cancelled')
      .map(event => ({ start: Date.parse(event.startTime), end: Date.parse(event.endTime) }))
      .filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end));
  }));

  return membershipCrm.candidateStartTimes(contract.packageId).filter(startTime => {
    const startMs = time.zonedDateTimeToMs(date, startTime, timezone);
    const endMs = startMs + visitMinutes * 60000;
    if (membershipCrm.eligibility(contract, { openVisit: null, remaining: 1 }, { now, startMs }).ok === false) return false;
    return busyByVan.some(busy => time.isFreeAcross(busy, startMs, endMs));
  });
}

async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const config = ghl.getConfig();
      const contract = await loadContract(config, tokenFrom(req, null));
      const balance = await membershipCrm.balanceFor(config, contract);
      const eligibility = membershipCrm.eligibility(contract, balance);

      const date = optionalText(req.query && req.query.date, 'date', 10);
      if (date && !isValidDateOnly(date)) throw new RequestError('date is invalid', 422);

      return sendJson(res, 200, {
        ok: true,
        plan: contract.packageId,
        vehicle: contract.vehicleLabel,
        status: contract.status,
        creditsPerCycle: balance.creditsPerCycle,
        remaining: balance.remaining,
        used: balance.used,
        cycleEndsAt: contract.cycleEndsMs ? new Date(contract.cycleEndsMs).toISOString() : null,
        nextVisit: balance.openVisit
          ? { startsAt: new Date(balance.openVisit.startMs).toISOString(), status: balance.openVisit.status }
          : null,
        canBook: eligibility.ok,
        reason: eligibility.code,
        addons: availableAddons(contract),
        noticeHours: catalog.MEMBERSHIP_BOOKING_NOTICE_MS / (60 * 60 * 1000),
        range: bookableRange(contract),
        // Only when a day was asked for.
        // Offered slots come from the vans that are switched on; the balance above is
        // counted across the whole fleet, including any van switched off since.
        ...(date && eligibility.ok ? { date, slots: await slotsForDate(await ghl.withActiveResources(config), contract, date) } : {})
      });
    } catch (error) {
      const statusCode = statusCodeFor(error, 502);
      if (statusCode >= 500) console.error('[member-status]', error.name || 'Error', statusCode);
      return sendJson(res, statusCode, publicError(error, 'MEMBERSHIP_UNAVAILABLE'));
    }
  }

  if (!assertMethod(req, res, 'POST')) return undefined;

  let publicAction = '';
  try {
    const body = readBody(req);
    publicAction = body && (body.action === 'enroll' || body.action === 'eligibility') ? body.action : '';
    if (publicAction) {
      assertSameOrigin(req);
      const result = publicAction === 'enroll' ? await enrollMembership(body) : await checkPublicEligibility(body);
      return sendJson(res, 200, result);
    }
    const config = ghl.getConfig();
    const redeeming = Boolean(body && body.redemptionToken);
    const contract = await loadContract(config, redeeming ? text(body.redemptionToken, 'redemptionToken', 20, 512) : tokenFrom(req, body), redeeming);

    const date = text(body && body.date, 'date', 10, 10);
    if (!isValidDateOnly(date)) throw new RequestError('date is invalid', 422);
    if (time.isSunday(date)) throw new RequestError('The crew does not work on Sundays', 422, 'CLOSED_DAY');

    const now = Date.now();
    // `full_day` is what the public quoter sends when availability is running in
    // full-day mode: the customer picked a DAY, not an hour, so there is no clock time
    // to validate. The member portal always sends a real one. Resolving it here rather
    // than rejecting it is what keeps the redemption path working in both modes — the
    // chosen time comes back in `startsAt`, so the member is told what it became.
    const requestedTime = text(body && body.startTime, 'startTime', 4, 10);
    let startTime = requestedTime;
    if (requestedTime === 'full_day') {
      const [earliest] = await slotsForDate(await ghl.withActiveResources(config), contract, date, now);
      if (!earliest) throw new RequestError('No hay camioneta disponible ese día', 409, 'SLOT_UNAVAILABLE');
      startTime = earliest;
    }
    if (!START_TIME_PATTERN.test(startTime)) throw new RequestError('startTime is invalid', 422);

    const startMs = time.zonedDateTimeToMs(date, startTime, time.bookingTimezone());

    // Re-checked here, not merely on the page: the balance is derived from the calendar
    // and may have changed since the page loaded.
    const balance = await membershipCrm.balanceFor(config, contract, now);
    const eligibility = membershipCrm.eligibility(contract, balance, { now, startMs });
    if (!eligibility.ok) {
      throw new RequestError(`No se puede agendar: ${eligibility.code}`, 409, `MEMBERSHIP_${eligibility.code.toUpperCase()}`);
    }

    const addons = selectedAddons(contract, body.addonIds || []);
    const addonPayment = body.addonPayment === 'online' ? 'online' : 'cash';
    const addonTotal = addons.reduce((total, addon) => total + addon.amount, 0);
    const visit = await membershipCrm.bookVisit(await ghl.withActiveResources(config), contract, {
      date, startTime, now, addons, addonTotal, addonPayment
    });
    let addonInvoice = null;
    // The visit itself is never at risk here: the base wash is paid by the cycle, so a
    // failed add-on invoice must not undo a booking the member is entitled to. It falls
    // back to collecting on site, which means REWRITING the appointment — otherwise the
    // add-ons are billed to nobody.
    let settledPayment = addonPayment;
    if (addons.length && addonPayment === 'online') {
      try {
        addonInvoice = await createAddonPayment(config, contract, visit, addons);
      } catch (error) {
        console.error('[member-addons]', visit.appointmentId, error.name || 'Error');
        settledPayment = 'cash';
        try {
          await membershipCrm.markAddonsPayableOnSite(config, contract, visit.appointmentId, { startTime, addons, addonTotal });
        } catch (patchError) {
          // Both routes to charging the add-ons are now closed. The wash stands; say so
          // loudly, because only a human can collect this.
          console.error('[member-addons-uncollectable]', visit.appointmentId, patchError.name || 'Error');
        }
      }
    }
    console.log('[member] booked', contract.contractId, visit.appointmentId, visit.resourceKey);
    return sendJson(res, 201, {
      ok: true, ...visit, remaining: Math.max(0, balance.remaining - 1),
      addons: addons.map(addon => addon.id), addonTotal, addonPayment: settledPayment,
      addonPaymentUrl: addonInvoice && addonInvoice.url || null
    });
  } catch (error) {
    const statusCode = statusCodeFor(error, 502);
    if (statusCode >= 500) console.error(`[member-${publicAction || 'book'}]`, error.name || 'Error', statusCode);
    if (publicAction === 'eligibility') return sendJson(res, statusCode >= 500 ? statusCode : 200, statusCode >= 500
      ? { ok: false, error: 'Eligibility temporarily unavailable' }
      : { ok: true, eligible: false });
    if (publicAction === 'enroll') return sendJson(res, statusCode, {
      ok: false, error: error instanceof RequestError ? error.message : 'Could not start membership checkout', ...(error.code ? { code: error.code } : {})
    });
    return sendJson(res, statusCode, publicError(error, 'MEMBERSHIP_BOOKING_UNAVAILABLE'));
  }
}

module.exports = handler;
module.exports._test = {
  FIELD_NAMES, PIPELINE_NAME, ENROLLMENT_FIELD_NAMES, ATTEMPT_PREFIX, bookableRange,
  availableAddons, selectedAddons, customFieldValue, ensureRecurringSchedule,
  validateEnrollment, enrollmentMetadata, findEnrollment, checkPublicEligibility,
  resetFieldCache: () => { fieldCache = null; stageCache = null; }
};
