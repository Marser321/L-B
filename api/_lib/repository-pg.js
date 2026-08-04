'use strict';

// Postgres implementation of the agenda repository.
//
// The repository is deliberately dumb: locking, atomicity, CRUD and uniqueness,
// nothing else. Every decision — which vans to pick, how the rotation advances,
// when to compensate — lives in agenda.js, so it is written once and tested once
// regardless of which repository is underneath (see repository-memory.js).

const db = require('./db.js');
const { membershipReads, membershipWrites } = require('./repository-pg-memberships.js');

function ms(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function mapHold(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    slotDate: typeof row.slot_date === 'string' ? row.slot_date : new Date(row.slot_date).toISOString().slice(0, 10),
    slotStartMs: ms(row.slot_start),
    slotEndMs: ms(row.slot_end),
    timezone: row.timezone,
    bookingMode: row.booking_mode,
    vehicleCount: row.vehicle_count,
    quote: row.quote,
    depositCents: row.deposit_cents,
    expiresAtMs: ms(row.expires_at),
    parentBookingId: row.parent_booking_id,
    failureReason: row.failure_reason
  };
}

function mapAllocation(row) {
  return {
    id: row.id,
    holdId: row.hold_id,
    assignmentId: row.assignment_id,
    resourceKey: row.resource_key,
    vehicleIndex: row.vehicle_index,
    calendarId: row.calendar_id,
    startsAtMs: ms(row.starts_at),
    endsAtMs: ms(row.ends_at),
    externalEventId: row.external_event_id,
    status: row.status
  };
}

function mapBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    parentBookingId: row.parent_booking_id,
    holdId: row.hold_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    submissionId: row.submission_id,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
    vehicleIndex: row.vehicle_index,
    vehicleLabel: row.vehicle_label,
    packageId: row.package_id,
    slotStartMs: ms(row.slot_start),
    slotEndMs: ms(row.slot_end),
    timezone: row.timezone,
    vehicleCount: row.vehicle_count,
    depositCents: row.deposit_cents,
    estimateMinCents: row.estimate_min_cents,
    estimateMaxCents: row.estimate_max_cents,
    customer: row.customer,
    quote: row.quote,
    confirmedAtMs: ms(row.confirmed_at),
    cancelledAtMs: ms(row.cancelled_at),
    cancelReason: row.cancel_reason
  };
}

function mapAssignment(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    parentBookingId: row.parent_booking_id,
    resourceKey: row.resource_key,
    vehicleIndex: row.vehicle_index,
    vehicleLabel: row.vehicle_label,
    packageId: row.package_id,
    durationMinutes: row.duration_minutes,
    startsAtMs: ms(row.starts_at),
    endsAtMs: ms(row.ends_at),
    calendarId: row.calendar_id,
    externalEventId: row.external_event_id,
    externalCalendarId: row.external_calendar_id,
    status: row.status
  };
}

const LIVE_ASSIGNMENT_STATUSES = ['held', 'confirmed'];

// Every window a van is committed to between two instants, from OUR records. The
// caller unions this with the vans' HighLevel calendars before deciding anything.
async function busyAssignments(executor, { fromMs, toMs }) {
  const { rows } = await executor.query(
    `select resource_key, starts_at, ends_at
       from booking_assignments
      where status = any($1::text[])
        and starts_at < $3
        and ends_at > $2`,
    [LIVE_ASSIGNMENT_STATUSES, iso(fromMs), iso(toMs)]
  );
  return rows.map(row => ({ resourceKey: row.resource_key, start: ms(row.starts_at), end: ms(row.ends_at) }));
}

async function findHoldByIdempotencyKey(executor, key) {
  const { rows } = await executor.query('select * from booking_holds where idempotency_key = $1', [key]);
  return mapHold(rows[0]);
}

async function allocationsForHold(executor, holdId) {
  const { rows } = await executor.query(
    'select * from hold_allocations where hold_id = $1 order by vehicle_index',
    [holdId]
  );
  return rows.map(mapAllocation);
}

async function assignmentsForParent(executor, parentBookingId) {
  const { rows } = await executor.query(
    'select * from booking_assignments where parent_booking_id = $1 order by vehicle_index',
    [parentBookingId]
  );
  return rows.map(mapAssignment);
}

function transactionApi(client) {
  return {
    kind: 'pg',
    // Membership operations share this transaction, so a webhook that activates a
    // contract and grants its credits either does both or neither.
    ...membershipReads(client),
    ...membershipWrites(client),
    busyAssignments: options => busyAssignments(client, options),
    findHoldByIdempotencyKey: key => findHoldByIdempotencyKey(client, key),
    allocationsForHold: holdId => allocationsForHold(client, holdId),
    assignmentsForParent: parentBookingId => assignmentsForParent(client, parentBookingId),

    async getHold(holdId, { forUpdate = false } = {}) {
      const { rows } = await client.query(
        `select * from booking_holds where id = $1${forUpdate ? ' for update' : ''}`,
        [holdId]
      );
      return mapHold(rows[0]);
    },

    async getBooking(bookingId, { forUpdate = false } = {}) {
      const { rows } = await client.query(
        `select * from bookings where id = $1${forUpdate ? ' for update' : ''}`,
        [bookingId]
      );
      return mapBooking(rows[0]);
    },

    async childBookings(parentBookingId) {
      const { rows } = await client.query(
        'select * from bookings where parent_booking_id = $1 order by vehicle_index',
        [parentBookingId]
      );
      return rows.map(mapBooking);
    },

    // The rotation cursor, locked for the rest of the transaction. Two concurrent
    // holds serialize here even if they touch different vans, which is exactly
    // what makes "start at the next van" a well-defined statement.
    async rotationCursorForUpdate(id = 'vans') {
      const { rows } = await client.query(
        'select cursor_position from resource_rotation where id = $1 for update',
        [id]
      );
      if (!rows.length) {
        await client.query('insert into resource_rotation (id, cursor_position) values ($1, 0)', [id]);
        return 0;
      }
      return rows[0].cursor_position;
    },

    async setRotationCursor(value, id = 'vans') {
      await client.query(
        'update resource_rotation set cursor_position = $2, updated_at = now() where id = $1',
        [id, value]
      );
    },

    // Inserts the whole reservation in one shot: the hold, the parent booking, one
    // child booking per vehicle, one assignment per child, and one allocation per
    // assignment. Any constraint rejection (including the van-overlap exclusion)
    // aborts the transaction, so a partial reservation cannot exist.
    async createHoldBundle({ hold, parent, children }) {
      await client.query(
        `insert into booking_holds (
           id, idempotency_key, request_fingerprint, status, slot_date, slot_start, slot_end,
           timezone, booking_mode, vehicle_count, quote, deposit_cents, expires_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          hold.id, hold.idempotencyKey, hold.requestFingerprint, hold.status, hold.slotDate,
          iso(hold.slotStartMs), iso(hold.slotEndMs), hold.timezone, hold.bookingMode,
          hold.vehicleCount, JSON.stringify(hold.quote), hold.depositCents, iso(hold.expiresAtMs)
        ]
      );

      await client.query(
        `insert into bookings (
           id, parent_booking_id, hold_id, idempotency_key, status, slot_start, slot_end, timezone,
           vehicle_count, deposit_cents, estimate_min_cents, estimate_max_cents, quote
         ) values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          parent.id, hold.id, parent.idempotencyKey, parent.status, iso(parent.slotStartMs),
          iso(parent.slotEndMs), parent.timezone, parent.vehicleCount, parent.depositCents,
          parent.estimateMinCents, parent.estimateMaxCents, JSON.stringify(parent.quote)
        ]
      );

      for (const { child, assignment, allocation } of children) {
        await client.query(
          `insert into bookings (
             id, parent_booking_id, hold_id, status, vehicle_index, vehicle_label, package_id,
             slot_start, slot_end, timezone, estimate_min_cents, estimate_max_cents, quote
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            child.id, parent.id, hold.id, child.status, child.vehicleIndex, child.vehicleLabel,
            child.packageId, iso(child.slotStartMs), iso(child.slotEndMs), child.timezone,
            child.estimateMinCents, child.estimateMaxCents, JSON.stringify(child.quote)
          ]
        );
        // Only the first child carries them: one van serving one address is busy for
        // ONE contiguous block, so there is one assignment and one reservation per
        // visit, not one per vehicle.
        if (!assignment) continue;
        await client.query(
          `insert into booking_assignments (
             id, booking_id, parent_booking_id, resource_key, vehicle_index, vehicle_label,
             package_id, duration_minutes, starts_at, ends_at, calendar_id, status
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            assignment.id, child.id, parent.id, assignment.resourceKey, assignment.vehicleIndex,
            assignment.vehicleLabel, assignment.packageId, assignment.durationMinutes,
            iso(assignment.startsAtMs), iso(assignment.endsAtMs), assignment.calendarId, assignment.status
          ]
        );
        await client.query(
          `insert into hold_allocations (
             id, hold_id, assignment_id, resource_key, vehicle_index, calendar_id,
             starts_at, ends_at, status
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            allocation.id, hold.id, assignment.id, allocation.resourceKey, allocation.vehicleIndex,
            allocation.calendarId, iso(allocation.startsAtMs), iso(allocation.endsAtMs), allocation.status
          ]
        );
      }

      await client.query('update booking_holds set parent_booking_id = $2, updated_at = now() where id = $1', [hold.id, parent.id]);
      return { holdId: hold.id, parentBookingId: parent.id };
    },

    async markHoldStatus(holdId, status, { failureReason = null } = {}) {
      await client.query(
        'update booking_holds set status = $2, failure_reason = coalesce($3, failure_reason), updated_at = now() where id = $1',
        [holdId, status, failureReason]
      );
    },

    async markAllocationsStatus(holdId, status) {
      await client.query(
        'update hold_allocations set status = $2, updated_at = now() where hold_id = $1',
        [holdId, status]
      );
    },

    async markAssignmentsStatus(parentBookingId, status) {
      await client.query(
        'update booking_assignments set status = $2, updated_at = now() where parent_booking_id = $1',
        [parentBookingId, status]
      );
    },

    async setAllocationExternalEvent(allocationId, externalEventId, status = 'active') {
      await client.query(
        'update hold_allocations set external_event_id = $2, status = $3, updated_at = now() where id = $1',
        [allocationId, externalEventId, status]
      );
    },

    async setAssignmentExternalEvent(assignmentId, externalEventId, externalCalendarId) {
      await client.query(
        `update booking_assignments
            set external_event_id = $2, external_calendar_id = $3, updated_at = now()
          where id = $1`,
        [assignmentId, externalEventId, externalCalendarId]
      );
    },

    // Applies to the parent and every child in one statement, so a parent can
    // never be confirmed while a child still says held.
    async setBookingTreeStatus(parentBookingId, status, { confirmedAtMs = null, cancelledAtMs = null, cancelReason = null } = {}) {
      await client.query(
        `update bookings
            set status = $2,
                confirmed_at = coalesce($3, confirmed_at),
                cancelled_at = coalesce($4, cancelled_at),
                cancel_reason = coalesce($5, cancel_reason),
                updated_at = now()
          where id = $1 or parent_booking_id = $1`,
        [parentBookingId, status, iso(confirmedAtMs), iso(cancelledAtMs), cancelReason]
      );
    },

    async attachCustomer(parentBookingId, { submissionId, contactId, opportunityId, customer, status }) {
      await client.query(
        `update bookings
            set submission_id = $2,
                contact_id = $3,
                opportunity_id = coalesce($4, opportunity_id),
                customer = coalesce($5::jsonb, customer),
                status = coalesce($6, status),
                updated_at = now()
          where id = $1 or parent_booking_id = $1`,
        [
          parentBookingId, submissionId, contactId, opportunityId,
          customer ? JSON.stringify(customer) : null, status
        ]
      );
    },

    async findParentBookingBySubmission(submissionId) {
      const { rows } = await client.query(
        `select * from bookings
          where submission_id = $1 and parent_booking_id is null
          order by created_at desc limit 1`,
        [submissionId]
      );
      return mapBooking(rows[0]);
    },

    // Returns { inserted: false } when this provider event was already recorded,
    // which is what makes a webhook that fires repeatedly confirm exactly once.
    async insertPaymentEvent(event) {
      const { rows } = await client.query(
        `insert into payment_events (
           id, provider, external_event_id, event_type, outcome, hold_id, parent_booking_id,
           submission_id, amount_cents, currency, payload, processed_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         on conflict (provider, external_event_id) do nothing
         returning id`,
        [
          event.id, event.provider, event.externalEventId, event.eventType, event.outcome,
          event.holdId, event.parentBookingId, event.submissionId, event.amountCents,
          event.currency, JSON.stringify(event.payload || {})
        ]
      );
      return { inserted: rows.length > 0 };
    },

    // Append-only and idempotent: a replayed grant, completion or no-show inserts
    // nothing the second time, because the key is derived from what happened
    // rather than from when it was processed.
    async appendMembershipCredits(entries) {
      let inserted = 0;
      for (const entry of entries) {
        const { rows } = await client.query(
          `insert into membership_credit_ledger (
             id, contact_id, parent_booking_id, package_id, delta, reason, idempotency_key,
             contract_id, visit_id, cycle_start
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (idempotency_key) do nothing
           returning id`,
          [
            entry.id, entry.contactId, entry.parentBookingId, entry.packageId, entry.delta,
            entry.reason, entry.idempotencyKey, entry.contractId || null, entry.visitId || null,
            entry.cycleStartMs ? new Date(entry.cycleStartMs).toISOString() : null
          ]
        );
        inserted += rows.length;
      }
      return inserted;
    },

    async membershipCreditBalance(contactId) {
      const { rows } = await client.query(
        'select coalesce(sum(delta), 0)::int as balance from membership_credit_ledger where contact_id = $1',
        [contactId]
      );
      return rows[0].balance;
    },

    // Claims lapsed holds so a second sweeper running at the same time cannot
    // release the same allocations twice. `for update skip locked` is what makes
    // the sweep safe to run on a schedule and on demand.
    async claimExpiredHolds(nowMs, limit = 25) {
      const { rows } = await client.query(
        `select * from booking_holds
          where status in ('active', 'converted')
            and expires_at <= $1
          order by expires_at
          limit $2
          for update skip locked`,
        [iso(nowMs), limit]
      );
      return rows.map(mapHold);
    }
  };
}

function createPgRepository() {
  const readOnly = { query: (text, params) => db.query(text, params) };
  return {
    kind: 'pg',
    isConfigured: () => db.isConfigured(),
    // Membership reads outside a transaction; the writes are transaction-only.
    ...membershipReads(readOnly),
    busyAssignments: options => busyAssignments(readOnly, options),
    findHoldByIdempotencyKey: key => findHoldByIdempotencyKey(readOnly, key),
    allocationsForHold: holdId => allocationsForHold(readOnly, holdId),
    assignmentsForParent: parentBookingId => assignmentsForParent(readOnly, parentBookingId),
    async getHold(holdId) {
      const { rows } = await db.query('select * from booking_holds where id = $1', [holdId]);
      return mapHold(rows[0]);
    },
    async getBooking(bookingId) {
      const { rows } = await db.query('select * from bookings where id = $1', [bookingId]);
      return mapBooking(rows[0]);
    },
    async childBookings(parentBookingId) {
      const { rows } = await db.query(
        'select * from bookings where parent_booking_id = $1 order by vehicle_index',
        [parentBookingId]
      );
      return rows.map(mapBooking);
    },
    async findParentBookingBySubmission(submissionId) {
      const { rows } = await db.query(
        `select * from bookings
          where submission_id = $1 and parent_booking_id is null
          order by created_at desc limit 1`,
        [submissionId]
      );
      return mapBooking(rows[0]);
    },
    async membershipCreditBalance(contactId) {
      const { rows } = await db.query(
        'select coalesce(sum(delta), 0)::int as balance from membership_credit_ledger where contact_id = $1',
        [contactId]
      );
      return rows[0].balance;
    },
    transaction: (lockKeys, fn) => db.withTransaction(lockKeys, client => fn(transactionApi(client))),
    isUniqueViolation: error => db.isUniqueViolation(error),
    isOverlapViolation: error => db.isOverlapViolation(error),
    close: () => db.close()
  };
}

module.exports = { createPgRepository, mapHold, mapAllocation, mapBooking, mapAssignment };
