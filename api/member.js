'use strict';

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
const { sendJson, readBody, assertMethod } = require('./_lib/http.js');
const { text, optionalText } = require('./_lib/validate.js');
const { isValidDateOnly, START_TIME_PATTERN } = require('./_lib/time.js');
const catalog = require('./_lib/catalog.js');
const ghl = require('./_lib/ghl.js');
const time = require('./_lib/time.js');
const signedLink = require('./_lib/signed-link.js');
const membershipCrm = require('./_lib/membership-crm.js');

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

async function loadContract(config, token) {
  const contractId = signedLink.verify('member', token);
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
        noticeHours: catalog.MEMBERSHIP_BOOKING_NOTICE_MS / (60 * 60 * 1000),
        range: bookableRange(contract),
        // Only when a day was asked for.
        ...(date && eligibility.ok ? { date, slots: await slotsForDate(config, contract, date) } : {})
      });
    } catch (error) {
      const statusCode = statusCodeFor(error, 502);
      if (statusCode >= 500) console.error('[member-status]', error.name || 'Error', statusCode);
      return sendJson(res, statusCode, publicError(error, 'MEMBERSHIP_UNAVAILABLE'));
    }
  }

  if (!assertMethod(req, res, 'POST')) return undefined;

  try {
    const body = readBody(req);
    const config = ghl.getConfig();
    const contract = await loadContract(config, tokenFrom(req, body));

    const date = text(body && body.date, 'date', 10, 10);
    if (!isValidDateOnly(date)) throw new RequestError('date is invalid', 422);
    const startTime = text(body && body.startTime, 'startTime', 4, 5);
    if (!START_TIME_PATTERN.test(startTime)) throw new RequestError('startTime is invalid', 422);
    if (time.isSunday(date)) throw new RequestError('The crew does not work on Sundays', 422, 'CLOSED_DAY');

    const now = Date.now();
    const startMs = time.zonedDateTimeToMs(date, startTime, time.bookingTimezone());

    // Re-checked here, not merely on the page: the balance is derived from the calendar
    // and may have changed since the page loaded.
    const balance = await membershipCrm.balanceFor(config, contract, now);
    const eligibility = membershipCrm.eligibility(contract, balance, { now, startMs });
    if (!eligibility.ok) {
      throw new RequestError(`No se puede agendar: ${eligibility.code}`, 409, `MEMBERSHIP_${eligibility.code.toUpperCase()}`);
    }

    const visit = await membershipCrm.bookVisit(config, contract, { date, startTime, now });
    console.log('[member] booked', contract.contractId, visit.appointmentId, visit.resourceKey);
    return sendJson(res, 201, { ok: true, ...visit, remaining: Math.max(0, balance.remaining - 1) });
  } catch (error) {
    const statusCode = statusCodeFor(error, 502);
    if (statusCode >= 500) console.error('[member-book]', error.name || 'Error', statusCode);
    return sendJson(res, statusCode, publicError(error, 'MEMBERSHIP_BOOKING_UNAVAILABLE'));
  }
}

module.exports = handler;
module.exports._test = { FIELD_NAMES, PIPELINE_NAME, bookableRange, resetFieldCache: () => { fieldCache = null; stageCache = null; } };
