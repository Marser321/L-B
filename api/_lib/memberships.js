'use strict';

// Memberships and recurring billing.
//
// Stripe moves the money. This module decides what the money bought.
//
// The rules it enforces, all of them business rules rather than plumbing:
//
//   * A contract is PER VEHICLE. One checkout can carry several recurring lines
//     for one account holder; each becomes a contract with its own balance and its
//     own next visit.
//   * Credits are granted when a cycle is PAID and spent when a wash is
//     DELIVERED — not when it is booked. A booking that never happens costs the
//     customer nothing unless they cancel late or miss it.
//   * Credits do not roll over. A paid cycle resets the balance to the plan's
//     allowance, which is why the grant is written as a reset rather than an
//     addition.
//   * Only one future visit per contract.
//   * Only a verified Stripe webhook can turn a hold into a confirmed visit.
//
// Everything a webhook does happens inside one transaction, keyed by the Stripe
// event id, so a redelivery is a no-op rather than a second grant.

const crypto = require('node:crypto');

const { RequestError } = require('./errors.js');
const catalog = require('./catalog.js');
const notifications = require('./notifications.js');
const agenda = require('./agenda.js');
const time = require('./time.js');
const { getRepository } = require('./repository.js');

// A membership visit must be booked at least this far out — the office builds the
// recurring route by hand. Shared with the one-off booking path so there is one
// definition of "48 hours".
const MEMBERSHIP_MIN_NOTICE_MS = catalog.MEMBERSHIP_BOOKING_NOTICE_MS;
// Cancel inside this window and the wash is spent anyway: the van and the slot
// were already committed.
const LATE_CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;
// A household can hold several memberships; this is a sanity bound on one
// checkout, not a fleet limit (that is MAX_VEHICLES, and it is about one visit).
const MAX_CHECKOUT_LINES = 20;

const HANDLED_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted'
]);

function newId() {
  return crypto.randomUUID();
}

function secondsToMs(value) {
  return Number.isFinite(Number(value)) ? Number(value) * 1000 : null;
}

// ── No payment transport here ──────────────────────────────────────────────
//
// Stripe was removed on 2026-08-04: everything is being kept in HighLevel so there
// is one place where a sale is recorded (see DISENO-SIN-BASE-DE-DATOS.md). What lived
// between here and the visit lifecycle below was the Stripe transport — checkout
// session creation and the five webhook handlers that activated a contract, set its
// cycle and granted its credits.
//
// What survives is everything BELOW: the rules about what a membership entitles you
// to. Those are the same whoever moves the money — 48 hours of notice, the credit
// spent on completion rather than on booking, a late cancel or a no-show spending it
// anyway, one open visit per contract, an exhausted balance refusing the next
// booking. They are the specification the HighLevel implementation has to satisfy,
// which is why they were kept rather than deleted with the transport.
//
// Until that implementation exists, nothing can create or activate a contract, so
// this module is dormant: the rules are here and tested, with no way in.

// ── Booking a membership visit ─────────────────────────────────────────────

// Why a contract may or may not book right now. Returned rather than thrown so
// the UI can explain the situation instead of showing a generic error.
function bookingEligibility(contract, { now = Date.now(), startMs = null } = {}) {
  if (contract.status === 'pending' || contract.status === 'incomplete') {
    return { ok: false, code: 'not_active', message: 'This membership has not been paid for yet' };
  }
  if (contract.status === 'past_due') {
    return { ok: false, code: 'past_due', message: 'This membership has an unpaid invoice' };
  }
  if (contract.status === 'canceled') {
    return { ok: false, code: 'canceled', message: 'This membership has been cancelled' };
  }
  if (!contract.activatedByEventId) {
    return { ok: false, code: 'unverified', message: 'This membership has no verified payment yet' };
  }
  if (contract.creditsRemaining <= 0) {
    return { ok: false, code: 'no_credits', message: 'No washes left in this cycle' };
  }
  if (startMs != null) {
    if (startMs < now + MEMBERSHIP_MIN_NOTICE_MS) {
      return { ok: false, code: 'too_soon', message: 'Memberships must be booked at least 48 hours in advance' };
    }
    // A cancelling membership can still use the cycle it paid for, but not book
    // past the end of it.
    if (contract.cancelAtPeriodEnd && contract.currentPeriodEndMs && startMs > contract.currentPeriodEndMs) {
      return { ok: false, code: 'after_period_end', message: 'This membership ends before that date' };
    }
  }
  return { ok: true };
}

// Books the contract's next visit: an agenda hold for the vehicle, then a
// membership_visits row tying it to the contract.
//
// The visit is created `held`. Confirming it is a separate step that checks the
// contract still has a webhook-verified paid cycle (see confirmVisit).
async function bookVisit({ contractId, date, startTime, idempotencyKey = null, now = Date.now(), config = null }) {
  const repository = getRepository();
  const contract = await repository.getContract(contractId);
  if (!contract) throw new RequestError('Membership contract not found', 404);

  const timezone = time.bookingTimezone();
  const startMs = time.zonedDateTimeToMs(date, startTime, timezone);
  const eligibility = bookingEligibility(contract, { now, startMs });
  // Every ineligibility is a 409: the request is well formed, the membership just
  // is not in a state that allows it right now.
  if (!eligibility.ok) throw new RequestError(eligibility.message, 409);

  // One future visit per contract. Checked here for a clean error, and enforced
  // by a unique index underneath in case two requests race.
  const open = await repository.getOpenVisitForContract(contractId);
  if (open) throw new RequestError('This membership already has a visit booked', 409);

  const hold = await agenda.acquireHold({
    idempotencyKey: idempotencyKey || `membership-${contractId}-${date}-${startTime}`,
    date,
    startTime,
    vehicles: [{
      vehicleIndex: 0,
      categoryId: catalog.categoryForPackage(contract.packageId),
      packageId: contract.packageId,
      sizeId: contract.sizeId,
      addonIds: [],
      durationMinutes: catalog.vehicleServiceMinutes(contract.packageId),
      bookingMode: catalog.bookingModeForPackage(contract.packageId),
      isMembership: true,
      label: contract.vehicleLabel || contract.packageId,
      descriptor: contract.vehicle
    }],
    now,
    config
  });

  const visit = await repository.transaction([`contract:${contractId}`], async tx => {
    const stillOpen = await tx.getOpenVisitForContract(contractId);
    if (stillOpen) throw new RequestError('This membership already has a visit booked', 409);
    return tx.insertVisit({
      id: newId(),
      contractId,
      holdId: hold.holdId,
      parentBookingId: null,
      bookingId: null,
      cycleStartMs: contract.currentPeriodStartMs,
      cycleEndMs: contract.currentPeriodEndMs,
      scheduledStartMs: Date.parse(hold.slotStart),
      scheduledEndMs: Date.parse(hold.slotEnd),
      status: 'held'
    });
  });

  return { visit, hold };
}

// Turns the hold into a confirmed visit.
//
// This is the membership counterpart of the deposit flow's payment webhook, and
// it enforces the same rule: a hold becomes a confirmed booking only on the
// strength of a verified Stripe webhook. Here the proof is the contract's
// `activated_by_event_id` plus a paid cycle that still covers the visit — both
// written by invoice.paid and by nothing else.
async function confirmVisit({ visitId, now = Date.now(), config = null }) {
  const repository = getRepository();
  const visit = await repository.getVisit(visitId);
  if (!visit) throw new RequestError('Visit not found', 404);
  if (visit.status === 'confirmed') return { visit, alreadyConfirmed: true };
  if (visit.status !== 'held') throw new RequestError('This visit can no longer be confirmed', 409);

  const contract = await repository.getContract(visit.contractId);
  if (!contract.activatedByEventId) {
    throw new RequestError('This membership has no verified payment yet', 409);
  }
  if (contract.status !== 'active') {
    throw new RequestError('This membership is not active', 409);
  }
  if (contract.currentPeriodEndMs && visit.scheduledStartMs > contract.currentPeriodEndMs && contract.cancelAtPeriodEnd) {
    throw new RequestError('This membership ends before that date', 409);
  }

  const confirmed = await agenda.confirmHoldForMembership({
    holdId: visit.holdId,
    // Unique per visit, so the audit row says which invoice paid for THIS visit
    // rather than colliding with the previous visit of the same cycle.
    reason: `membership:${contract.id}:${contract.paidInvoiceId || contract.activatedByEventId}:${visit.id}`,
    now,
    config
  });

  await repository.transaction([`contract:${contract.id}`], async tx => {
    await tx.updateVisit(visit.id, {
      status: 'confirmed',
      parentBookingId: confirmed.parentBookingId,
      bookingId: confirmed.childBookingId
    });
  });

  // One notification per confirmed PARENT booking, however many vehicles it
  // covers. The dedupe key is the parent booking id, so a retry is silent.
  await notifications.notify({
    dedupeKey: notifications.keys.bookingConfirmed(confirmed.parentBookingId),
    channel: 'sms',
    template: 'booking_confirmed',
    context: {
      parentBookingId: confirmed.parentBookingId,
      contractId: contract.id,
      startsAt: new Date(visit.scheduledStartMs).toISOString()
    }
  });

  return { visit: await repository.getVisit(visitId), parentBookingId: confirmed.parentBookingId };
}

// ── Consuming a credit ─────────────────────────────────────────────────────

// The one place a credit is spent, whatever the reason. Idempotent by
// (visit, reason): completing twice, or a retried no-show sweep, costs one wash.
async function consumeCredit(tx, { contract, visit, reason, now }) {
  const inserted = await tx.appendMembershipCredits([{
    id: newId(),
    contactId: null,
    contractId: contract.id,
    visitId: visit.id,
    parentBookingId: visit.parentBookingId,
    packageId: contract.packageId,
    delta: -1,
    reason,
    cycleStartMs: visit.cycleStartMs,
    idempotencyKey: `${visit.id}:${reason}`
  }]);
  if (!inserted) return { consumed: false };
  // Never below zero: the ledger is the audit trail, the counter is what the
  // booking check reads.
  const remaining = Math.max(0, contract.creditsRemaining - 1);
  await tx.updateContract(contract.id, { creditsRemaining: remaining });
  await tx.updateVisit(visit.id, { creditConsumedAtMs: now });
  return { consumed: true, remaining };
}

// The service happened: spend the wash.
async function completeVisit({ visitId, now = Date.now() }) {
  const repository = getRepository();
  const visit = await repository.getVisit(visitId);
  if (!visit) throw new RequestError('Visit not found', 404);
  if (visit.status === 'completed') return { visit, alreadyCompleted: true };
  if (!['held', 'confirmed'].includes(visit.status)) {
    throw new RequestError('This visit cannot be completed', 409);
  }

  const result = await repository.transaction([`contract:${visit.contractId}`], async tx => {
    const contract = await tx.getContract(visit.contractId);
    const spent = await consumeCredit(tx, { contract, visit, reason: 'visit_completed', now });
    await tx.updateVisit(visit.id, { status: 'completed' });
    return spent;
  });

  const contract = await repository.getContract(visit.contractId);
  if (contract.creditsRemaining === 0) {
    await notifications.notify({
      dedupeKey: notifications.keys.creditExhausted(contract.id, contract.currentPeriodStartMs || 0),
      channel: 'email',
      template: 'membership_credits_exhausted',
      context: { contractId: contract.id, periodEnd: contract.currentPeriodEndMs }
    });
  }

  return { visit: await repository.getVisit(visitId), ...result };
}

// Moves a visit to another time WITHOUT charging for it.
//
// Until now the only way to change a date was to cancel and rebook, which inside
// 24 hours spent the wash — a customer moving their appointment by one day paid as
// if they had not shown up. Rescheduling is not a no-show and must not cost a credit.
//
// The order matters: the new slot is taken FIRST. If the fleet is full at the new
// time the customer keeps the appointment they already had, instead of losing it
// while trying to move it.
async function rescheduleVisit({ visitId, date, startTime, now = Date.now(), config = null }) {
  const repository = getRepository();
  const visit = await repository.getVisit(visitId);
  if (!visit) throw new RequestError('Visit not found', 404);
  if (!['held', 'confirmed'].includes(visit.status)) {
    throw new RequestError('Only an upcoming visit can be rescheduled', 409);
  }

  const contract = await repository.getContract(visit.contractId);
  const timezone = time.bookingTimezone();
  const startMs = time.zonedDateTimeToMs(date, startTime, timezone);

  // The 48-hour rule and the cycle window apply to the NEW date, but a past_due or
  // cancelled membership can still move a visit its paid cycle already covers:
  // moving is not buying.
  if (startMs < now + MEMBERSHIP_MIN_NOTICE_MS) {
    throw new RequestError('Memberships must be booked at least 48 hours in advance', 409);
  }
  if (contract.cancelAtPeriodEnd && contract.currentPeriodEndMs && startMs > contract.currentPeriodEndMs) {
    throw new RequestError('This membership ends before that date', 409);
  }

  const wasConfirmed = visit.status === 'confirmed';
  const previousHoldId = visit.holdId;

  // Take the new slot before giving up the old one.
  const hold = await agenda.acquireHold({
    idempotencyKey: `reschedule-${visitId}-${date}-${startTime}`,
    date,
    startTime,
    vehicles: [{
      vehicleIndex: 0,
      categoryId: catalog.categoryForPackage(contract.packageId),
      packageId: contract.packageId,
      sizeId: contract.sizeId,
      addonIds: [],
      durationMinutes: catalog.vehicleServiceMinutes(contract.packageId),
      bookingMode: catalog.bookingModeForPackage(contract.packageId),
      isMembership: true,
      label: contract.vehicleLabel || contract.packageId,
      descriptor: contract.vehicle
    }],
    now,
    config
  });

  await repository.transaction([`contract:${contract.id}`], async tx => {
    await tx.updateVisit(visit.id, {
      holdId: hold.holdId,
      status: 'held',
      parentBookingId: null,
      bookingId: null,
      scheduledStartMs: Date.parse(hold.slotStart),
      scheduledEndMs: Date.parse(hold.slotEnd)
    });
  });

  // Only now is the old reservation given back.
  if (previousHoldId) {
    await agenda.releaseHold({ holdId: previousHoldId, reason: 'rescheduled', config })
      .catch(error => console.error('[membership] old hold release failed', previousHoldId, error.message));
  }

  // A visit that was already confirmed stays confirmed at its new time: the cycle
  // that paid for it has not changed, so the customer should not have to confirm again.
  if (wasConfirmed) await confirmVisit({ visitId, now, config });

  const updated = await repository.getVisit(visitId);
  return {
    visit: updated,
    hold,
    creditConsumed: false,
    startsAt: new Date(updated.scheduledStartMs).toISOString()
  };
}

// Cancelling inside 24 hours, or not being there, spends the wash anyway. Earlier
// than that and it costs nothing.
async function cancelVisit({ visitId, reason = 'customer_cancelled', now = Date.now(), config = null }) {
  const repository = getRepository();
  const visit = await repository.getVisit(visitId);
  if (!visit) throw new RequestError('Visit not found', 404);
  if (['cancelled', 'no_show', 'completed'].includes(visit.status)) {
    return { visit, alreadyClosed: true };
  }

  const late = visit.scheduledStartMs - now < LATE_CANCEL_WINDOW_MS;

  const outcome = await repository.transaction([`contract:${visit.contractId}`], async tx => {
    const contract = await tx.getContract(visit.contractId);
    let spent = { consumed: false };
    if (late) spent = await consumeCredit(tx, { contract, visit, reason: 'late_cancellation', now });
    await tx.updateVisit(visit.id, { status: 'cancelled', cancelledAtMs: now, cancelReason: reason });
    return { late, ...spent };
  });

  // Release the vans either way: the slot goes back on the market immediately.
  if (visit.holdId) {
    await agenda.releaseHold({ holdId: visit.holdId, reason: late ? 'late_cancellation' : 'cancelled', config })
      .catch(error => console.error('[membership] hold release failed', visit.holdId, error.message));
  }

  if (late) {
    await notifications.notify({
      dedupeKey: notifications.keys.visitCancelledLate(visit.id),
      channel: 'sms',
      template: 'visit_cancelled_late',
      context: { visitId: visit.id, contractId: visit.contractId }
    });
  }

  return { visit: await repository.getVisit(visitId), ...outcome };
}

// The customer was not there. Same cost as a late cancellation.
async function markNoShow({ visitId, now = Date.now(), config = null }) {
  const repository = getRepository();
  const visit = await repository.getVisit(visitId);
  if (!visit) throw new RequestError('Visit not found', 404);
  if (visit.status === 'no_show') return { visit, alreadyClosed: true };
  if (['completed', 'cancelled'].includes(visit.status)) {
    throw new RequestError('This visit is already closed', 409);
  }

  const outcome = await repository.transaction([`contract:${visit.contractId}`], async tx => {
    const contract = await tx.getContract(visit.contractId);
    const spent = await consumeCredit(tx, { contract, visit, reason: 'no_show', now });
    await tx.updateVisit(visit.id, { status: 'no_show' });
    return spent;
  });

  if (visit.holdId) {
    await agenda.releaseHold({ holdId: visit.holdId, reason: 'no_show', config })
      .catch(error => console.error('[membership] hold release failed', visit.holdId, error.message));
  }

  await notifications.notify({
    dedupeKey: notifications.keys.visitNoShow(visit.id),
    channel: 'internal',
    template: 'visit_no_show',
    context: { visitId: visit.id, contractId: visit.contractId }
  });

  return { visit: await repository.getVisit(visitId), ...outcome };
}

module.exports = {
  MEMBERSHIP_MIN_NOTICE_MS,
  LATE_CANCEL_WINDOW_MS,
  bookingEligibility,
  bookVisit,
  confirmVisit,
  rescheduleVisit,
  completeVisit,
  cancelVisit,
  markNoShow
};
