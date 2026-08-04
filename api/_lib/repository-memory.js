'use strict';

// In-process implementation of the same repository contract as repository-pg.js.
//
// Why it exists: the agenda's hard guarantees (one winner per van, 409 for the
// loser, full compensation, 15-minute expiry) have to be provable on every
// machine, including one with no Postgres installed. All the decision logic lives
// in agenda.js and runs unchanged against either repository, so a test against
// this store is testing the real algorithm — only the storage underneath differs.
//
// It models the four Postgres behaviours the agenda actually leans on:
//
//   1. Transactions are atomic. A transaction that throws leaves nothing behind.
//   2. Transactions that take the same advisory lock run one after another.
//      (This store serializes ALL transactions, which is stricter than Postgres
//      but never weaker, so a test can't pass here and fail in production.)
//   3. Unique constraints reject duplicates with code 23505.
//   4. The van-overlap exclusion constraint rejects with code 23P01.
//
// What it deliberately does NOT prove is that the SQL in repository-pg.js is
// correct — that needs a real server, which is what tests/agenda-pg.test.js does
// when DATABASE_URL is set.

const { membershipApi, emptyMembershipStore } = require('./repository-memory-memberships.js');

class ConstraintError extends Error {
  constructor(code, constraint) {
    super(`memory repository constraint violation (${constraint})`);
    this.name = 'ConstraintError';
    this.code = code;
    this.constraint = constraint;
  }
}

const LIVE_ASSIGNMENT_STATUSES = new Set(['held', 'confirmed']);

function emptyStore() {
  return {
    holds: [],
    allocations: [],
    bookings: [],
    assignments: [],
    paymentEvents: [],
    ledger: [],
    rotation: { vans: 0 },
    membership: emptyMembershipStore()
  };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return bStart < aEnd && aStart < bEnd;
}

function createMemoryRepository(options = {}) {
  let store = emptyStore();
  // A single queue: every transaction waits for the previous one. See note 2 above.
  let queue = Promise.resolve();
  // Test seam: called with the transaction API just before commit, so a test can
  // simulate another writer landing a conflicting row mid-flight and exercise the
  // exclusion-constraint path.
  let beforeCommit = options.beforeCommit || null;

  function assertUnique(rows, predicate, constraint) {
    if (rows.some(predicate)) throw new ConstraintError('23505', constraint);
  }

  function assertNoOverlap(assignments, candidate) {
    const clash = assignments.some(assignment =>
      assignment.id !== candidate.id &&
      assignment.resourceKey === candidate.resourceKey &&
      LIVE_ASSIGNMENT_STATUSES.has(assignment.status) &&
      LIVE_ASSIGNMENT_STATUSES.has(candidate.status) &&
      overlaps(candidate.startsAtMs, candidate.endsAtMs, assignment.startsAtMs, assignment.endsAtMs)
    );
    if (clash) throw new ConstraintError('23P01', 'no_overlapping_assignments');
  }

  function busyAssignmentsIn(state, { fromMs, toMs }) {
    return state.assignments
      .filter(assignment => LIVE_ASSIGNMENT_STATUSES.has(assignment.status))
      .filter(assignment => assignment.startsAtMs < toMs && assignment.endsAtMs > fromMs)
      .map(assignment => ({
        resourceKey: assignment.resourceKey,
        start: assignment.startsAtMs,
        end: assignment.endsAtMs
      }));
  }

  function api(state) {
    const bookingsOf = parentBookingId =>
      state.bookings.filter(booking => booking.id === parentBookingId || booking.parentBookingId === parentBookingId);

    return {
      kind: 'memory',
      // Membership operations share this transaction, so a webhook that activates
      // a contract and grants its credits either does both or neither.
      ...membershipApi(state),

      busyAssignments: async range => busyAssignmentsIn(state, range),

      findHoldByIdempotencyKey: async key =>
        state.holds.find(hold => hold.idempotencyKey === key) || null,

      allocationsForHold: async holdId =>
        state.allocations.filter(allocation => allocation.holdId === holdId)
          .sort((a, b) => a.vehicleIndex - b.vehicleIndex),

      assignmentsForParent: async parentBookingId =>
        state.assignments.filter(assignment => assignment.parentBookingId === parentBookingId)
          .sort((a, b) => a.vehicleIndex - b.vehicleIndex),

      getHold: async holdId => state.holds.find(hold => hold.id === holdId) || null,

      getBooking: async bookingId => state.bookings.find(booking => booking.id === bookingId) || null,

      childBookings: async parentBookingId =>
        state.bookings.filter(booking => booking.parentBookingId === parentBookingId)
          .sort((a, b) => a.vehicleIndex - b.vehicleIndex),

      rotationCursorForUpdate: async (id = 'vans') => state.rotation[id] || 0,

      setRotationCursor: async (value, id = 'vans') => { state.rotation[id] = value; },

      async createHoldBundle({ hold, parent, children }) {
        assertUnique(state.holds, row => row.idempotencyKey === hold.idempotencyKey, 'booking_holds_idempotency_key_key');
        if (parent.idempotencyKey) {
          assertUnique(state.bookings, row => row.idempotencyKey === parent.idempotencyKey, 'bookings_idempotency_key_key');
        }

        state.holds.push({ ...hold, parentBookingId: parent.id, failureReason: null });
        state.bookings.push({
          ...parent,
          parentBookingId: null,
          holdId: hold.id,
          vehicleIndex: null,
          submissionId: null,
          contactId: null,
          opportunityId: null,
          customer: null
        });

        for (const { child, assignment, allocation } of children) {
          assertUnique(
            state.bookings,
            row => row.parentBookingId === parent.id && row.vehicleIndex === child.vehicleIndex,
            'bookings_child_vehicle_idx'
          );
          // Written first so a child with no assignment still lands.
          state.bookings.push({ ...child, parentBookingId: parent.id, holdId: hold.id });
          // Only the first child carries the assignment: one van at one address is
          // busy for ONE contiguous block, so a visit has one assignment row, not one
          // per vehicle.
          if (!assignment) continue;
          assertUnique(
            state.assignments,
            row => row.parentBookingId === parent.id && row.vehicleIndex === assignment.vehicleIndex,
            'booking_assignments_vehicle_unique'
          );
          // This constraint is STILL IN THE PRODUCTION DATABASE and migration 004 is
          // not being applied, so the fake must keep enforcing it — a fake that is
          // more permissive than production is how a booking passes 174 tests and
          // then fails for a customer. One assignment row per visit satisfies it by
          // construction; one row per vehicle is what used to violate it.
          assertUnique(
            state.assignments,
            row => row.parentBookingId === parent.id && row.resourceKey === assignment.resourceKey,
            'booking_assignments_resource_unique'
          );
          assertUnique(
            state.allocations,
            row => row.holdId === hold.id && row.vehicleIndex === allocation.vehicleIndex,
            'hold_allocations_vehicle_unique'
          );

          const assignmentRow = {
            ...assignment,
            bookingId: child.id,
            parentBookingId: parent.id,
            externalEventId: null,
            externalCalendarId: null
          };
          assertNoOverlap(state.assignments, assignmentRow);

          state.assignments.push(assignmentRow);
          state.allocations.push({
            ...allocation,
            holdId: hold.id,
            assignmentId: assignment.id,
            externalEventId: null
          });
        }

        return { holdId: hold.id, parentBookingId: parent.id };
      },

      async markHoldStatus(holdId, status, { failureReason = null } = {}) {
        const hold = state.holds.find(row => row.id === holdId);
        if (!hold) return;
        hold.status = status;
        if (failureReason) hold.failureReason = failureReason;
      },

      async markAllocationsStatus(holdId, status) {
        state.allocations.filter(row => row.holdId === holdId).forEach(row => { row.status = status; });
      },

      async markAssignmentsStatus(parentBookingId, status) {
        state.assignments
          .filter(row => row.parentBookingId === parentBookingId)
          .forEach(row => { row.status = status; });
      },

      async setAllocationExternalEvent(allocationId, externalEventId, status = 'active') {
        const allocation = state.allocations.find(row => row.id === allocationId);
        if (!allocation) return;
        allocation.externalEventId = externalEventId;
        allocation.status = status;
      },

      async setAssignmentExternalEvent(assignmentId, externalEventId, externalCalendarId) {
        const assignment = state.assignments.find(row => row.id === assignmentId);
        if (!assignment) return;
        assignment.externalEventId = externalEventId;
        assignment.externalCalendarId = externalCalendarId;
      },

      async setBookingTreeStatus(parentBookingId, status, { confirmedAtMs = null, cancelledAtMs = null, cancelReason = null } = {}) {
        bookingsOf(parentBookingId).forEach(booking => {
          booking.status = status;
          if (confirmedAtMs != null) booking.confirmedAtMs = confirmedAtMs;
          if (cancelledAtMs != null) booking.cancelledAtMs = cancelledAtMs;
          if (cancelReason != null) booking.cancelReason = cancelReason;
        });
      },

      async attachCustomer(parentBookingId, { submissionId, contactId, opportunityId, customer, status }) {
        bookingsOf(parentBookingId).forEach(booking => {
          booking.submissionId = submissionId;
          booking.contactId = contactId;
          if (opportunityId) booking.opportunityId = opportunityId;
          if (customer) booking.customer = customer;
          if (status) booking.status = status;
        });
      },

      async findParentBookingBySubmission(submissionId) {
        return state.bookings
          .filter(booking => booking.submissionId === submissionId && !booking.parentBookingId)
          .slice(-1)[0] || null;
      },

      async insertPaymentEvent(event) {
        const exists = state.paymentEvents.some(row =>
          row.provider === event.provider && row.externalEventId === event.externalEventId
        );
        if (exists) return { inserted: false };
        state.paymentEvents.push({ ...event, processedAtMs: event.processedAtMs || Date.now() });
        return { inserted: true };
      },

      async appendMembershipCredits(entries) {
        let inserted = 0;
        for (const entry of entries) {
          if (state.ledger.some(row => row.idempotencyKey === entry.idempotencyKey)) continue;
          state.ledger.push({ ...entry });
          inserted += 1;
        }
        return inserted;
      },

      async membershipCreditBalance(contactId) {
        return state.ledger
          .filter(row => row.contactId === contactId)
          .reduce((total, row) => total + row.delta, 0);
      },

      async claimExpiredHolds(nowMs, limit = 25) {
        return state.holds
          .filter(hold => ['active', 'converted'].includes(hold.status) && hold.expiresAtMs <= nowMs)
          .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
          .slice(0, limit)
          .map(hold => ({ ...hold }));
      }
    };
  }

  async function transaction(lockKeys, fn) {
    // Chain onto the queue so transactions never interleave, then let the next one
    // start regardless of how this one ended.
    const run = queue.then(async () => {
      const snapshot = structuredClone(store);
      try {
        const tx = api(store);
        const result = await fn(tx);
        if (beforeCommit) await beforeCommit(tx, store);
        return result;
      } catch (error) {
        store = snapshot;
        throw error;
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  const readOnly = () => api(store);

  return {
    kind: 'memory',
    isConfigured: () => true,
    busyAssignments: range => readOnly().busyAssignments(range),
    findHoldByIdempotencyKey: key => readOnly().findHoldByIdempotencyKey(key),
    allocationsForHold: holdId => readOnly().allocationsForHold(holdId),
    assignmentsForParent: parentBookingId => readOnly().assignmentsForParent(parentBookingId),
    getHold: holdId => readOnly().getHold(holdId),
    getBooking: bookingId => readOnly().getBooking(bookingId),
    childBookings: parentBookingId => readOnly().childBookings(parentBookingId),
    findParentBookingBySubmission: submissionId => readOnly().findParentBookingBySubmission(submissionId),
    membershipCreditBalance: contactId => readOnly().membershipCreditBalance(contactId),
    // Membership reads outside a transaction. The writes are transaction-only on
    // purpose: activating a contract, granting credits and recording the event
    // must not be separable.
    getPriceMapEntry: (...args) => readOnly().getPriceMapEntry(...args),
    listPriceMap: (...args) => readOnly().listPriceMap(...args),
    getCustomerById: id => readOnly().getCustomerById(id),
    getCustomerByStripeId: id => readOnly().getCustomerByStripeId(id),
    findCustomerByEmail: (email, livemode) => readOnly().findCustomerByEmail(email, livemode),
    getCheckoutSessionByStripeId: id => readOnly().getCheckoutSessionByStripeId(id),
    getContract: id => readOnly().getContract(id),
    getContractsBySubscription: id => readOnly().getContractsBySubscription(id),
    getContractsByCheckoutSession: id => readOnly().getContractsByCheckoutSession(id),
    getOpenVisitForContract: contractId => readOnly().getOpenVisitForContract(contractId),
    getVisit: id => readOnly().getVisit(id),
    getVisitsByParentBooking: id => readOnly().getVisitsByParentBooking(id),
    creditBalanceForContract: contractId => readOnly().creditBalanceForContract(contractId),
    getStripeEvent: id => readOnly().getStripeEvent(id),
    getNotification: dedupeKey => readOnly().getNotification(dedupeKey),
    listNotifications: () => readOnly().listNotifications(),
    getHighLevelSync: (entityType, localKey) => readOnly().getHighLevelSync(entityType, localKey),
    findCrmPrice: query => readOnly().findCrmPrice(query),
    listCrmPriceMap: livemode => readOnly().listCrmPriceMap(livemode),
    getPaymentLinkByKey: key => readOnly().getPaymentLinkByKey(key),
    transaction,
    isUniqueViolation: error => Boolean(error) && error.code === '23505',
    isOverlapViolation: error => Boolean(error) && error.code === '23P01',
    close: async () => {},

    // Test-only helpers.
    __store: () => store,
    __reset: () => { store = emptyStore(); queue = Promise.resolve(); beforeCommit = options.beforeCommit || null; },
    __onBeforeCommit: hook => { beforeCommit = hook; },
    ConstraintError
  };
}

module.exports = { createMemoryRepository, ConstraintError };
