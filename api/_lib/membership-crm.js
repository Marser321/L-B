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

// Statuses that mean the wash was delivered. `showed` is what the crew panel sets;
// HighLevel also allows `completed`, which the office may pick by hand.
const DELIVERED = new Set(['showed', 'completed']);
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
function readContract(opportunity, fieldIds) {
  if (!opportunity || !opportunity.id) throw new RequestError('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');

  const packageId = fieldValue(opportunity, fieldIds.plan).trim();
  if (!packageId || !membershipCatalog.isSellableMembership(packageId)) {
    throw new RequestError('That link is not a membership', 404, 'MEMBERSHIP_NOT_FOUND');
  }

  const status = (fieldValue(opportunity, fieldIds.status) || 'active').trim().toLowerCase();
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
    DELIVERED.has(entry.status) && entry.startMs >= cycle.startMs && entry.startMs <= cycle.endMs
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
async function bookVisit(config, contract, { date, startTime, now = Date.now() }) {
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
        description: [
          contractTag(contract.contractId),
          `plan ${contract.packageId}`,
          `orden: ${startTime} ${contract.packageId}`,
          'total: $0',
          'deposito: $0'
        ].join(' · '),
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

module.exports = {
  CONTRACT_TAG,
  DELIVERED,
  OPEN,
  contractTag,
  hasContractTag,
  readContract,
  cycleWindow,
  contractAppointments,
  balanceFor,
  eligibility,
  candidateStartTimes,
  bookVisit
};
