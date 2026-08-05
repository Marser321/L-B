'use strict';

// A membership, read from the CRM and nothing else.
//
// The contract is an OPPORTUNITY in the `Memberships` pipeline — that already exists in
// the sub-account, with the five stages the state machine needs (Pending Payment,
// Active, Past Due, Cancel at Period End, Canceled) and the custom fields Membership
// Plan / Vehicle / Status / Cycle Ends.
//
// THE CREDITS ARE DERIVED, NOT STORED. There is no "washes used" field, on purpose:
//
//   washes used this cycle = appointments for this contract
//                            with status `showed`
//                            starting on or after the cycle start
//
// A counter in a custom field can be corrupted — two writers read 1 and both write 2 —
// and a stored number cannot explain itself. Counting delivered appointments has
// nothing to desynchronise, and "why do I have one left?" is answered by looking at the
// calendar. The crew panel marking `showed` is what feeds it (api/crew.js).
//
// The rule that makes this safe against races is ONE OPEN VISIT PER CONTRACT: a member
// cannot hold two future washes at once, so to book the second the first must already
// be delivered. There is no window in which two bookings could each see a spare credit.

const { RequestError } = require('./errors.js');
const catalog = require('./catalog.js');
const membershipCatalog = require('./membership-catalog.js');
const ghl = require('./ghl.js');
const time = require('./time.js');

// Marks an appointment as belonging to a membership contract. Written into the
// appointment's notes when the visit is booked, and matched when credits are counted —
// which is the whole reason the count can be derived.
const CONTRACT_TAG = 'membresia';

function contractTag(contractId) {
  return `${CONTRACT_TAG}:${contractId}`;
}

function hasContractTag(event, contractId) {
  return String(event.notes || event.description || '').includes(contractTag(contractId));
}

// Statuses that SPEND the cycle's credit. `showed` is what the crew panel sets;
// HighLevel also allows `completed`, which the office may pick by hand.
//
// `noshow` is in here for a commercial reason rather than a technical one: the van
// drove to the address and the slot is gone, so the credit is spent exactly as if the
// wash had happened (DISENO-SIN-BASE-DE-DATOS.md §2, "cancelación tardía y no-show que
// lo gastan igual"). A CANCELLED visit is deliberately absent — cancelling is free and
// hands the credit back.
const SPENDS_CREDIT = new Set(['showed', 'completed', 'noshow']);
// Kept under its old name because it is exported and read elsewhere as "was this
// delivered"; the set now answers the broader question the balance actually asks.
const DELIVERED = SPENDS_CREDIT;
// A visit still owed to the member: booked, not yet delivered.
const OPEN = new Set(['new', 'confirmed']);

// ── Reading the contract ───────────────────────────────────────────────────

function fieldValue(opportunity, fieldId) {
  const field = (opportunity.customFields || []).find(entry => entry.id === fieldId);
  if (!field) return '';
  const value = field.fieldValue ?? field.value ?? field.fieldValueString;
  return value == null ? '' : String(value);
}

// The contract as the member page needs it. Throws when the opportunity is not a
// membership, so a signed link to some other opportunity opens nothing.
// Stage name → the status the rest of the code branches on. Matched on the NAME so a
// renamed or re-created pipeline keeps working, and unknown stages fall through to the
// field rather than being guessed at.
const STAGE_STATUS = Object.freeze({
  'pending payment': 'pending_payment',
  active: 'active',
  'past due': 'past_due',
  // Still entitled to the cycle already paid for, so it books like an active member.
  // The difference is only that it will not renew.
  'cancel at period end': 'active',
  canceled: 'canceled'
});

function stageStatus(opportunity, stages) {
  const stageId = opportunity.pipelineStageId || opportunity.stageId || '';
  const name = String((stages || {})[stageId] || '').trim().toLowerCase();
  return STAGE_STATUS[name] || '';
}

function readContract(opportunity, fieldIds, stages = {}) {
  if (!opportunity || !opportunity.id) throw new RequestError('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');

  const packageId = fieldValue(opportunity, fieldIds.plan).trim();
  if (!packageId || !membershipCatalog.isSellableMembership(packageId)) {
    throw new RequestError('That link is not a membership', 404, 'MEMBERSHIP_NOT_FOUND');
  }

  // The STATUS COMES FROM THE PIPELINE STAGE, not from a field.
  //
  // The Memberships pipeline already has exactly the five states this needs — Pending
  // Payment, Active, Past Due, Cancel at Period End, Canceled — and the office works by
  // dragging cards. Reading the stage means moving a card IS the state change: there is
  // no field to keep in sync with it and no workflow needed to copy one to the other.
  //
  // It also covers a gap that cannot be automated: HighLevel emits no "invoice payment
  // failed" event (its invoice webhooks are Create/Sent/Paid/PartiallyPaid/Void/Update/
  // Delete), so `past_due` could never arrive by webhook. Dragging the card is how it
  // arrives, and that works today with nothing built.
  //
  // The custom field is still read as a fallback, for an opportunity that predates this
  // or lives outside the pipeline.
  const status = (stageStatus(opportunity, stages) || fieldValue(opportunity, fieldIds.status) || 'active')
    .trim().toLowerCase();
  const cycleEnds = fieldValue(opportunity, fieldIds.cycleEnds).trim();
  const cycleEndsMs = cycleEnds ? Date.parse(cycleEnds) : NaN;

  return {
    contractId: opportunity.id,
    contactId: (opportunity.contact && opportunity.contact.id) || opportunity.contactId || '',
    packageId,
    vehicleLabel: fieldValue(opportunity, fieldIds.vehicle).trim() || packageId,
    status,
    creditsPerCycle: membershipCatalog.creditsForPackage(packageId),
    // A cycle with no end date is treated as open rather than expired: refusing a
    // member because the office has not filled a field yet is the wrong failure.
    cycleEndsMs: Number.isFinite(cycleEndsMs) ? cycleEndsMs : null
  };
}

// The window credits are counted over. Starts one cycle before the end date, because
// what the CRM records is when the paid cycle RUNS OUT.
function cycleWindow(contract, now = Date.now()) {
  const end = contract.cycleEndsMs;
  if (!end) {
    // No end date: count the last 31 days, which is the longest a monthly cycle runs.
    return { startMs: now - 31 * 24 * 60 * 60 * 1000, endMs: now + 31 * 24 * 60 * 60 * 1000 };
  }
  return { startMs: end - 31 * 24 * 60 * 60 * 1000, endMs: end };
}

// ── Deriving the balance ───────────────────────────────────────────────────

// Every appointment for this contract across the fleet, in the window. Four calendar
// reads; the fleet is four vans and a member's visits can land on any of them.
async function contractAppointments(config, contract, { fromMs, toMs }) {
  const perVan = await Promise.all(config.resources.map(async resource => {
    const events = await ghl.calendarEventsForCalendar(config, resource.calendarId, fromMs, toMs);
    return events
      .filter(event => hasContractTag(event, contract.contractId))
      .map(event => ({
        appointmentId: event.id,
        resourceKey: resource.key,
        status: String(event.appointmentStatus || ''),
        startMs: Date.parse(event.startTime),
        endMs: Date.parse(event.endTime)
      }));
  }));
  return perVan.flat().filter(entry => Number.isFinite(entry.startMs));
}

// What the member has left, and what they already have booked.
async function balanceFor(config, contract, now = Date.now()) {
  const cycle = cycleWindow(contract, now);
  // Read wide enough to see both the cycle's delivered washes and anything booked
  // ahead of today, which may sit past the cycle end.
  const appointments = await contractAppointments(config, contract, {
    fromMs: cycle.startMs,
    toMs: Math.max(cycle.endMs, now + 62 * 24 * 60 * 60 * 1000)
  });

  const used = appointments.filter(entry =>
    SPENDS_CREDIT.has(entry.status) && entry.startMs >= cycle.startMs && entry.startMs <= cycle.endMs
  ).length;

  const openVisit = appointments
    .filter(entry => OPEN.has(entry.status) && entry.endMs > now)
    .sort((a, b) => a.startMs - b.startMs)[0] || null;

  return {
    creditsPerCycle: contract.creditsPerCycle,
    used,
    // An open visit is a credit already committed, so it counts against the balance
    // even though it has not been delivered. Otherwise a member could book, see a
    // spare credit, and book again.
    remaining: Math.max(0, contract.creditsPerCycle - used - (openVisit ? 1 : 0)),
    openVisit,
    cycleEndsMs: contract.cycleEndsMs
  };
}

// ── Whether a wash may be booked ───────────────────────────────────────────

// Every reason a member may not book right now, as a code the page can render. Order
// matters: the most specific, most actionable reason wins.
function eligibility(contract, balance, { now = Date.now(), startMs = null } = {}) {
  if (contract.status === 'canceled') return { ok: false, code: 'canceled' };
  if (contract.status === 'past_due') return { ok: false, code: 'past_due' };
  if (contract.status === 'pending payment' || contract.status === 'pending_payment') {
    return { ok: false, code: 'pending_payment' };
  }
  if (balance.openVisit) return { ok: false, code: 'visit_already_booked' };
  if (balance.remaining <= 0) return { ok: false, code: 'no_credits' };

  if (startMs != null) {
    // The same 48 hours every membership booking has always required, computed here
    // rather than stored anywhere — it never needed a database.
    if (startMs < now + catalog.MEMBERSHIP_BOOKING_NOTICE_MS) return { ok: false, code: 'too_soon' };
    // A wash cannot be scheduled past the cycle that paid for it.
    if (contract.cycleEndsMs && startMs > contract.cycleEndsMs) return { ok: false, code: 'after_cycle_end' };
  }
  return { ok: true, code: 'ok' };
}

// ── Booking, with the CRM as the only store ────────────────────────────────

// Start times that fit the working day for this plan's single vehicle, from the grid
// the rest of the site uses.
function candidateStartTimes(packageId) {
  return time.gridStartTimes(catalog.visitDurationMinutes([packageId]));
}

// Books the member's wash by trying the vans in turn and letting HighLevel arbitrate.
//
// There is no availability computation and no lock. The appointment is created with
// slot validation ON, so HighLevel refuses a van that is busy (400) and serializes
// concurrent attempts — verified against the live sub-account. The first van that
// accepts is the one that goes. That is the whole allocation algorithm, and it needs no
// database.
//
// Status is `confirmed` immediately, not `new`: the cycle is already paid, so there is
// nothing to wait for. That is the one way a membership visit differs from a website
// booking.
// What the appointment says about itself. Split out of bookVisit because the caller
// has to be able to REWRITE it: if the online add-on invoice fails to go out, the
// same add-ons become collectable on site and the crew's panel reads this text.
//
// The distinction that matters is `total`. api/crew.js derives the balance the crew is
// told to collect from `total` minus `deposito`, so `total` must only ever hold money
// that is still uncollected AT THE DOOR. Add-ons billed online are already invoiced,
// and putting them here would have the crew collect them a second time in cash.
function visitDescription(contract, { startTime, addons = [], addonTotal = 0, addonPayment = 'cash' }) {
  const collectableOnSite = addonPayment === 'cash' ? addonTotal : 0;
  return [
    contractTag(contract.contractId),
    `plan ${contract.packageId}`,
    `orden: ${startTime} ${contract.packageId}`,
    addons.length ? `extras: ${addons.map(addon => addon.name).join(', ')}` : 'extras: ninguno',
    `extras_pago: ${addons.length ? addonPayment : 'ninguno'}`,
    // Deliberately NOT called `extras_total`: the crew panel finds the collectable
    // amount by looking for `total:`, and a key ending in that word would be picked up
    // as the balance to charge.
    `extras_monto: $${addonTotal}`,
    `total: $${collectableOnSite}`,
    'deposito: $0'
  ].join(' · ');
}

// The add-on invoice never reached the customer, so the money has to be taken at the
// door instead. Rewrites the appointment so the crew's panel shows the balance.
async function markAddonsPayableOnSite(config, contract, appointmentId, { startTime, addons, addonTotal }) {
  await ghl.updateCalendarEvent(config, appointmentId, {
    description: visitDescription(contract, { startTime, addons, addonTotal, addonPayment: 'cash' })
  });
}

async function bookVisit(config, contract, { date, startTime, now = Date.now(), addons = [], addonTotal = 0, addonPayment = 'cash' }) {
  const timezone = time.bookingTimezone();
  const serviceMinutes = catalog.vehicleServiceMinutes(contract.packageId);
  const visitMinutes = catalog.visitDurationMinutes([contract.packageId]);

  const startMs = time.zonedDateTimeToMs(date, startTime, timezone);
  const endMs = startMs + visitMinutes * 60000;

  // Rotate the starting van by date so consecutive bookings spread across the fleet
  // without a stored cursor.
  const offset = Math.abs(Number(date.replace(/-/g, ''))) % config.resources.length;

  let lastRefusal = null;
  for (let attempt = 0; attempt < config.resources.length; attempt += 1) {
    const resource = config.resources[(offset + attempt) % config.resources.length];
    try {
      const appointment = await ghl.createHoldAppointment(config, {
        calendarId: resource.calendarId,
        contactId: contract.contactId,
        title: `MEMBRESIA — ${contract.vehicleLabel}`.slice(0, 160),
        // The tag is what makes the credit count possible; the rest is for the crew.
        description: visitDescription(contract, { startTime, addons, addonTotal, addonPayment }),
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString()
      });
      // Paid by the cycle, so it is confirmed the moment it is created.
      await ghl.updateCalendarEvent(config, appointment.id, { status: 'confirmed' });
      return {
        appointmentId: appointment.id,
        resourceKey: resource.key,
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(endMs).toISOString(),
        serviceMinutes
      };
    } catch (error) {
      // Only a slot conflict is worth trying the next van for. Anything else is a real
      // failure and must not be retried three more times.
      if (!ghl.isSlotTakenError(error)) throw error;
      lastRefusal = error;
    }
  }
  throw new RequestError('No hay camioneta disponible en ese horario', 409, 'SLOT_UNAVAILABLE');
}

// ── Finding the contract an invoice belongs to ─────────────────────────────

// The name a membership product carries on an invoice line, per plan+size, so a line
// can be matched back to a contract without relying on ids the CRM may have renamed.
function planMatchesInvoice(contract, invoice) {
  const lines = (invoice.invoiceItems || invoice.items || [])
    .map(item => String(item.name || '').toLowerCase())
    .join(' | ');
  if (!lines) return false;
  const label = String((membershipCatalog.MEMBERSHIP_PACKAGES[contract.packageId] || {}).label || '').toLowerCase();
  return Boolean(label) && lines.includes(label);
}

// Which contract a paid invoice pays for.
//
// The workflow only knows the invoice, so the contact, the plan and the date all come
// from the invoice itself. One customer can hold several contracts — a car and a truck —
// which is exactly why the workflow could not carry a contract id: it is contact-scoped
// and would have had to guess.
//
// Ambiguity is REFUSED, never guessed. Granting a cycle to the wrong vehicle would give
// one member two months and leave the other unpaid, and nothing downstream would ever
// contradict it. A 409 puts it in front of the office instead.
async function findContractForInvoice(config, fieldIds, stages, invoice, { pipelineId = '' } = {}) {
  const contactId = (invoice.contactDetails && invoice.contactDetails.id) || invoice.contactId || '';
  if (!contactId) throw new RequestError('That invoice has no contact', 422, 'MEMBERSHIP_INVOICE_NO_CONTACT');

  const opportunities = await ghl.opportunitiesForContact(config, { contactId, pipelineId });
  const contracts = opportunities
    .map(opportunity => {
      try { return readContract(opportunity, fieldIds, stages); } catch { return null; }
    })
    .filter(Boolean);

  if (!contracts.length) {
    throw new RequestError('No membership contract for that invoice', 404, 'MEMBERSHIP_NOT_FOUND');
  }
  if (contracts.length === 1) return contracts[0];

  // Several contracts on one contact: the invoice's own product lines say which.
  const matching = contracts.filter(contract => planMatchesInvoice(contract, invoice));
  if (matching.length === 1) return matching[0];

  throw new RequestError(
    `That invoice matches ${matching.length || contracts.length} membership contracts; set the cycle by hand`,
    409,
    'MEMBERSHIP_AMBIGUOUS'
  );
}

// ── Granting a cycle ───────────────────────────────────────────────────────

// One month on from a cycle start, clamped to the end of a shorter month so the 31st
// does not silently become the 1st of the month after next.
function addOneMonth(ms) {
  const start = new Date(ms);
  const day = start.getUTCDate();
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

// A paid cycle, written onto the contract.
//
// THE CYCLE END IS WHAT RESETS THE BALANCE. There is no balance field to clear: credits
// are counted inside the cycle window (see cycleWindow), so moving the window forward
// is the reset. That is the whole renewal rule — "credits do not roll over" — expressed
// as one date.
//
// Idempotent BY CONSTRUCTION when the caller passes the invoice's own date: the same
// invoice always computes the same cycle end, so a redelivered webhook writes the same
// value instead of pushing the cycle out a second month. A caller that passes nothing
// falls back to now, which is NOT idempotent — hence the workflow is configured to send
// the invoice date.
async function grantCycle(config, fieldIds, contractId, { cycleStartMs = Date.now(), activeStageId = '', portalUrl = '' } = {}) {
  const cycleEndsMs = addOneMonth(cycleStartMs);
  const reminderMs = cycleEndsMs - 3 * 24 * 60 * 60 * 1000;
  const fields = [
    { id: fieldIds.status, value: 'active' },
    { id: fieldIds.cycleEnds, value: new Date(cycleEndsMs).toISOString() }
    // The card is moved to Active in the same call (see updateOpportunityFields), so the
    // office sees the payment land without doing anything.
  ];
  if (portalUrl && fieldIds.portalUrl) fields.push({ id: fieldIds.portalUrl, value: portalUrl });
  if (fieldIds.reminderDate) fields.push({ id: fieldIds.reminderDate, value: new Date(reminderMs).toISOString() });
  await ghl.updateOpportunityFields(config, contractId, fields, { pipelineStageId: activeStageId });
  return { status: 'active', cycleEndsAt: new Date(cycleEndsMs).toISOString() };
}

// A failed renewal. The contract stops accepting NEW bookings (see eligibility) and
// nothing touches a visit already booked inside the cycle the customer did pay for.
async function markPastDue(config, fieldIds, contractId) {
  await ghl.updateOpportunityFields(config, contractId, [{ id: fieldIds.status, value: 'past_due' }]);
  return { status: 'past_due' };
}

async function markCanceled(config, fieldIds, contractId) {
  await ghl.updateOpportunityFields(config, contractId, [{ id: fieldIds.status, value: 'canceled' }]);
  return { status: 'canceled' };
}

module.exports = {
  planMatchesInvoice,
  findContractForInvoice,
  STAGE_STATUS,
  stageStatus,
  addOneMonth,
  grantCycle,
  markPastDue,
  markCanceled,
  CONTRACT_TAG,
  DELIVERED,
  SPENDS_CREDIT,
  OPEN,
  contractTag,
  hasContractTag,
  readContract,
  cycleWindow,
  contractAppointments,
  balanceFor,
  eligibility,
  candidateStartTimes,
  visitDescription,
  markAddonsPayableOnSite,
  bookVisit
};
