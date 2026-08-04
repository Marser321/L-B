'use strict';

// Membership half of the in-memory repository. Mirrors
// repository-pg-memberships.js operation for operation, and enforces the same
// constraints the migration declares — including the two that carry business
// meaning rather than mere hygiene:
//
//   * membership_visits_one_open — one future visit per contract;
//   * notification_deliveries_dedupe_unique — one message per fact.
//
// Getting those wrong here would make a test pass that production would fail, so
// they are checked explicitly rather than assumed.

class ConstraintError extends Error {
  constructor(code, constraint) {
    super(`memory repository constraint violation (${constraint})`);
    this.name = 'ConstraintError';
    this.code = code;
    this.constraint = constraint;
  }
}

const OPEN_VISIT_STATUSES = new Set(['held', 'confirmed']);

function emptyMembershipStore() {
  return {
    priceMap: [],
    customers: [],
    checkoutSessions: [],
    contracts: [],
    visits: [],
    stripeEvents: [],
    notifications: [],
    highlevelSync: [],
    crmPriceMap: [],
    paymentLinks: []
  };
}

function membershipApi(state) {
  // The agenda store and the membership store share one object; these live under
  // their own keys so a truncation of one never disturbs the other.
  const store = state.membership;

  return {
    // ── reads ──
    async getPriceMapEntry(packageId, sizeId, livemode, catalogVersion = null) {
      return store.priceMap
        .filter(row => row.packageId === packageId && row.sizeId === sizeId &&
          row.livemode === livemode && row.active !== false &&
          (catalogVersion == null || row.catalogVersion === catalogVersion))
        .sort((a, b) => b.catalogVersion - a.catalogVersion)[0] || null;
    },

    async listPriceMap(livemode, catalogVersion = null) {
      return store.priceMap
        .filter(row => row.livemode === livemode && (catalogVersion == null || row.catalogVersion === catalogVersion))
        .sort((a, b) => a.packageId.localeCompare(b.packageId) || a.sizeId.localeCompare(b.sizeId));
    },

    async getCustomerById(id) {
      return store.customers.find(row => row.id === id) || null;
    },

    async getCustomerByStripeId(stripeCustomerId) {
      return store.customers.find(row => row.stripeCustomerId === stripeCustomerId) || null;
    },

    async findCustomerByEmail(email, livemode) {
      if (!email) return null;
      return store.customers.find(row =>
        row.livemode === livemode && String(row.email || '').toLowerCase() === String(email).toLowerCase()
      ) || null;
    },

    async getCheckoutSessionByStripeId(stripeSessionId) {
      return store.checkoutSessions.find(row => row.stripeSessionId === stripeSessionId) || null;
    },

    async getContract(id) {
      return store.contracts.find(row => row.id === id) || null;
    },

    async getContractsBySubscription(subscriptionId) {
      return store.contracts
        .filter(row => row.stripeSubscriptionId === subscriptionId)
        .sort((a, b) => a.lineIndex - b.lineIndex);
    },

    async getContractsByCheckoutSession(checkoutSessionId) {
      return store.contracts
        .filter(row => row.checkoutSessionId === checkoutSessionId)
        .sort((a, b) => a.lineIndex - b.lineIndex);
    },

    async getOpenVisitForContract(contractId) {
      return store.visits
        .filter(row => row.contractId === contractId && OPEN_VISIT_STATUSES.has(row.status))
        .sort((a, b) => a.scheduledStartMs - b.scheduledStartMs)[0] || null;
    },

    async getVisit(id) {
      return store.visits.find(row => row.id === id) || null;
    },

    async getVisitsByParentBooking(parentBookingId) {
      return store.visits.filter(row => row.parentBookingId === parentBookingId);
    },

    async creditBalanceForContract(contractId) {
      return state.ledger
        .filter(row => row.contractId === contractId)
        .reduce((total, row) => total + row.delta, 0);
    },

    async getStripeEvent(id) {
      return store.stripeEvents.find(row => row.id === id) || null;
    },

    async getNotification(dedupeKey) {
      return store.notifications.find(row => row.dedupeKey === dedupeKey) || null;
    },

    async listNotifications() {
      return [...store.notifications];
    },

    async getHighLevelSync(entityType, localKey) {
      return store.highlevelSync.find(row => row.entityType === entityType && row.localKey === localKey) || null;
    },

    // ── CRM catalog map and payment links ──
    async findCrmPrice({ kind, packageId = null, sizeId = null, addonId = null, productKey = null, livemode }) {
      return store.crmPriceMap
        .filter(row => row.kind === kind && row.livemode === livemode && row.active !== false)
        .filter(row => packageId == null || row.packageId === packageId)
        .filter(row => sizeId == null || row.sizeId === sizeId)
        .filter(row => addonId == null || row.addonId === addonId)
        .filter(row => productKey == null || row.productKey === productKey)
        .sort((a, b) => b.catalogVersion - a.catalogVersion)[0] || null;
    },

    async listCrmPriceMap(livemode) {
      return store.crmPriceMap.filter(row => row.livemode === livemode && row.active !== false);
    },

    async upsertCrmPriceMap(rows) {
      for (const row of rows) {
        const index = store.crmPriceMap.findIndex(entry =>
          entry.catalogVersion === row.catalogVersion && entry.kind === row.kind &&
          entry.priceKey === row.priceKey && entry.livemode === row.livemode
        );
        const normalized = { ...row, priceType: row.priceType || row.type, active: true };
        if (index === -1) store.crmPriceMap.push(normalized);
        else store.crmPriceMap[index] = { ...store.crmPriceMap[index], ...normalized };
      }
      return rows.length;
    },

    async insertPaymentLink(row) {
      if (store.paymentLinks.some(entry => entry.idempotencyKey === row.idempotencyKey)) {
        return { inserted: false, link: null };
      }
      const created = { ...row, status: 'pending', crmInvoiceId: null, url: null, paidAtMs: null };
      store.paymentLinks.push(created);
      return { inserted: true, link: created };
    },

    async markPaymentLinkIssued(idempotencyKey, { crmInvoiceId, url }) {
      const link = store.paymentLinks.find(row => row.idempotencyKey === idempotencyKey);
      if (!link) return;
      link.status = 'issued';
      link.crmInvoiceId = crmInvoiceId;
      link.url = url;
    },

    async markPaymentLinkFailed(idempotencyKey, reason) {
      const link = store.paymentLinks.find(row => row.idempotencyKey === idempotencyKey);
      if (!link) return;
      link.status = 'failed';
      link.failureReason = String(reason).slice(0, 500);
    },

    async markPaymentLinkPaid(crmInvoiceId, atMs) {
      store.paymentLinks
        .filter(row => row.crmInvoiceId === crmInvoiceId)
        .forEach(row => { row.status = 'paid'; row.paidAtMs = atMs; });
    },

    async getPaymentLinkByKey(idempotencyKey) {
      return store.paymentLinks.find(row => row.idempotencyKey === idempotencyKey) || null;
    },

    // ── writes ──
    async upsertPriceMapEntries(entries) {
      for (const entry of entries) {
        const index = store.priceMap.findIndex(row =>
          row.catalogVersion === entry.catalogVersion && row.packageId === entry.packageId &&
          row.sizeId === entry.sizeId && row.livemode === entry.livemode
        );
        if (index === -1) store.priceMap.push({ ...entry, active: true });
        else store.priceMap[index] = { ...store.priceMap[index], ...entry, active: true };
      }
      return entries.length;
    },

    async insertCustomer(row) {
      const existing = store.customers.find(entry => entry.stripeCustomerId === row.stripeCustomerId);
      if (existing) {
        Object.assign(existing, {
          contactId: row.contactId || existing.contactId,
          email: row.email || existing.email,
          phone: row.phone || existing.phone,
          name: row.name || existing.name
        });
        return existing;
      }
      const created = { ...row };
      store.customers.push(created);
      return created;
    },

    async insertCheckoutSession(row) {
      if (store.checkoutSessions.some(entry => entry.stripeSessionId === row.stripeSessionId)) return null;
      const created = { ...row, status: 'open', completedAtMs: null };
      store.checkoutSessions.push(created);
      return created;
    },

    async markCheckoutSessionCompleted(id, atMs) {
      const session = store.checkoutSessions.find(entry => entry.id === id);
      if (!session) return;
      session.status = 'completed';
      session.completedAtMs = atMs;
    },

    async insertContract(row) {
      const duplicate = store.contracts.some(entry =>
        entry.stripeSubscriptionItemId === row.stripeSubscriptionItemId && entry.lineIndex === row.lineIndex
      );
      // `on conflict do nothing` in the pg version: a redelivered webhook must not
      // create a second contract for the same line.
      if (duplicate) return null;
      const created = {
        creditsRemaining: 0,
        status: 'pending',
        cancelAtPeriodEnd: false,
        currentPeriodStartMs: null,
        currentPeriodEndMs: null,
        activatedByEventId: null,
        paidInvoiceId: null,
        ghlOpportunityId: null,
        canceledAtMs: null,
        ...row
      };
      store.contracts.push(created);
      return created;
    },

    async updateContract(id, fields) {
      const contract = store.contracts.find(row => row.id === id);
      if (!contract) return;
      Object.assign(contract, fields);
    },

    async insertVisit(row) {
      if (OPEN_VISIT_STATUSES.has(row.status)) {
        const openExists = store.visits.some(entry =>
          entry.contractId === row.contractId && OPEN_VISIT_STATUSES.has(entry.status)
        );
        // membership_visits_one_open: only one future visit per contract.
        if (openExists) throw new ConstraintError('23505', 'membership_visits_one_open');
      }
      const created = { creditConsumedAtMs: null, cancelledAtMs: null, cancelReason: null, ...row };
      store.visits.push(created);
      return created;
    },

    async updateVisit(id, fields) {
      const visit = store.visits.find(row => row.id === id);
      if (!visit) return;
      if (fields.status && OPEN_VISIT_STATUSES.has(fields.status) && !OPEN_VISIT_STATUSES.has(visit.status)) {
        const openExists = store.visits.some(entry =>
          entry.id !== id && entry.contractId === visit.contractId && OPEN_VISIT_STATUSES.has(entry.status)
        );
        if (openExists) throw new ConstraintError('23505', 'membership_visits_one_open');
      }
      Object.assign(visit, fields);
    },

    async insertStripeEvent(event) {
      if (store.stripeEvents.some(row => row.id === event.id)) return { inserted: false };
      store.stripeEvents.push({ ...event, status: 'received', receivedAtMs: event.receivedAtMs || null });
      return { inserted: true };
    },

    async markStripeEvent(id, status, error = null) {
      const event = store.stripeEvents.find(row => row.id === id);
      if (!event) return;
      event.status = status;
      event.error = error;
    },

    async insertNotification(row) {
      if (store.notifications.some(entry => entry.dedupeKey === row.dedupeKey)) return { inserted: false };
      store.notifications.push({ ...row, status: 'pending', attempts: 0, providerRef: null });
      return { inserted: true };
    },

    async markNotificationSent(dedupeKey, providerRef) {
      const notification = store.notifications.find(row => row.dedupeKey === dedupeKey);
      if (!notification) return;
      notification.status = 'sent';
      notification.providerRef = providerRef;
      notification.attempts += 1;
    },

    async markNotificationFailed(dedupeKey, error) {
      const notification = store.notifications.find(row => row.dedupeKey === dedupeKey);
      if (!notification) return;
      notification.status = 'failed';
      notification.lastError = String(error).slice(0, 500);
      notification.attempts += 1;
    },

    async upsertHighLevelSync(entityType, localKey, { externalId = null, payloadHash = null } = {}) {
      const existing = store.highlevelSync.find(row => row.entityType === entityType && row.localKey === localKey);
      if (!existing) {
        store.highlevelSync.push({ entityType, localKey, externalId, payloadHash });
        return { inserted: true, changed: true, externalId };
      }
      const changed = existing.payloadHash !== payloadHash;
      if (externalId) existing.externalId = externalId;
      existing.payloadHash = payloadHash;
      return { inserted: false, changed, externalId: existing.externalId };
    }
  };
}

module.exports = { membershipApi, emptyMembershipStore, ConstraintError, OPEN_VISIT_STATUSES };
