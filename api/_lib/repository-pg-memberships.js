'use strict';

// Membership half of the Postgres repository. Same contract as
// repository-memory-memberships.js, same rule as the agenda repository: dumb
// storage only. Every business decision lives in memberships.js.

function ms(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function mapPrice(row) {
  if (!row) return null;
  return {
    id: row.id,
    catalogVersion: row.catalog_version,
    packageId: row.package_id,
    sizeId: row.size_id,
    monthlyCents: row.monthly_cents,
    currency: row.currency,
    creditsPerCycle: row.credits_per_cycle,
    stripeProductId: row.stripe_product_id,
    stripePriceId: row.stripe_price_id,
    lookupKey: row.lookup_key,
    livemode: row.livemode,
    active: row.active
  };
}

function mapCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    stripeCustomerId: row.stripe_customer_id,
    livemode: row.livemode,
    contactId: row.contact_id,
    email: row.email,
    phone: row.phone,
    name: row.name
  };
}

function mapCheckoutSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    stripeSessionId: row.stripe_session_id,
    stripeCustomerId: row.stripe_customer_id,
    customerId: row.customer_id,
    livemode: row.livemode,
    catalogVersion: row.catalog_version,
    lines: row.lines,
    totalMonthlyCents: row.total_monthly_cents,
    status: row.status,
    completedAtMs: ms(row.completed_at)
  };
}

function mapContract(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    checkoutSessionId: row.checkout_session_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeSubscriptionItemId: row.stripe_subscription_item_id,
    stripePriceId: row.stripe_price_id,
    lineIndex: row.line_index,
    packageId: row.package_id,
    sizeId: row.size_id,
    monthlyCents: row.monthly_cents,
    creditsPerCycle: row.credits_per_cycle,
    creditsRemaining: row.credits_remaining,
    status: row.status,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    currentPeriodStartMs: ms(row.current_period_start),
    currentPeriodEndMs: ms(row.current_period_end),
    activatedByEventId: row.activated_by_event_id,
    paidInvoiceId: row.paid_invoice_id,
    vehicle: row.vehicle,
    vehicleLabel: row.vehicle_label,
    ghlOpportunityId: row.ghl_opportunity_id,
    canceledAtMs: ms(row.canceled_at)
  };
}

function mapCrmPrice(row) {
  if (!row) return null;
  return {
    id: row.id,
    catalogVersion: row.catalog_version,
    kind: row.kind,
    productKey: row.product_key,
    priceKey: row.price_key,
    packageId: row.package_id,
    sizeId: row.size_id,
    addonId: row.addon_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    priceType: row.price_type,
    crmProductId: row.crm_product_id,
    crmPriceId: row.crm_price_id,
    livemode: row.livemode,
    active: row.active
  };
}

function mapPaymentLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    purpose: row.purpose,
    origin: row.origin,
    holdId: row.hold_id,
    parentBookingId: row.parent_booking_id,
    contractId: row.contract_id,
    contactId: row.contact_id,
    lines: row.lines,
    amountCents: row.amount_cents,
    currency: row.currency,
    crmInvoiceId: row.crm_invoice_id,
    url: row.url,
    status: row.status,
    failureReason: row.failure_reason,
    createdBy: row.created_by,
    paidAtMs: ms(row.paid_at)
  };
}

function mapVisit(row) {
  if (!row) return null;
  return {
    id: row.id,
    contractId: row.contract_id,
    holdId: row.hold_id,
    parentBookingId: row.parent_booking_id,
    bookingId: row.booking_id,
    cycleStartMs: ms(row.cycle_start),
    cycleEndMs: ms(row.cycle_end),
    scheduledStartMs: ms(row.scheduled_start),
    scheduledEndMs: ms(row.scheduled_end),
    status: row.status,
    creditConsumedAtMs: ms(row.credit_consumed_at),
    cancelledAtMs: ms(row.cancelled_at),
    cancelReason: row.cancel_reason
  };
}

// Column whitelist for the partial updaters. Anything not listed cannot be
// written through updateContract/updateVisit, so a typo becomes an error instead
// of a silently dropped field.
const CONTRACT_COLUMNS = Object.freeze({
  stripeSubscriptionId: 'stripe_subscription_id',
  stripeSubscriptionItemId: 'stripe_subscription_item_id',
  stripePriceId: 'stripe_price_id',
  creditsPerCycle: 'credits_per_cycle',
  creditsRemaining: 'credits_remaining',
  status: 'status',
  cancelAtPeriodEnd: 'cancel_at_period_end',
  currentPeriodStartMs: 'current_period_start',
  currentPeriodEndMs: 'current_period_end',
  activatedByEventId: 'activated_by_event_id',
  paidInvoiceId: 'paid_invoice_id',
  ghlOpportunityId: 'ghl_opportunity_id',
  canceledAtMs: 'canceled_at'
});

const VISIT_COLUMNS = Object.freeze({
  holdId: 'hold_id',
  parentBookingId: 'parent_booking_id',
  bookingId: 'booking_id',
  // Writable so a visit can be MOVED rather than cancelled and rebooked.
  scheduledStartMs: 'scheduled_start',
  scheduledEndMs: 'scheduled_end',
  status: 'status',
  creditConsumedAtMs: 'credit_consumed_at',
  cancelledAtMs: 'cancelled_at',
  cancelReason: 'cancel_reason'
});

const TIMESTAMP_KEYS = new Set([
  'currentPeriodStartMs', 'currentPeriodEndMs', 'canceledAtMs',
  'creditConsumedAtMs', 'cancelledAtMs', 'scheduledStartMs', 'scheduledEndMs'
]);

function buildUpdate(table, columns, id, fields) {
  const sets = [];
  const params = [id];
  for (const [key, value] of Object.entries(fields)) {
    const column = columns[key];
    if (!column) throw new Error(`${table}: unknown column for field "${key}"`);
    params.push(TIMESTAMP_KEYS.has(key) ? iso(value) : value);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return null;
  return { text: `update ${table} set ${sets.join(', ')}, updated_at = now() where id = $1`, params };
}

function membershipReads(executor) {
  return {
    async getPriceMapEntry(packageId, sizeId, livemode, catalogVersion = null) {
      const { rows } = await executor.query(
        `select * from membership_price_map
          where package_id = $1 and size_id = $2 and livemode = $3 and active
            and ($4::int is null or catalog_version = $4)
          order by catalog_version desc limit 1`,
        [packageId, sizeId, livemode, catalogVersion]
      );
      return mapPrice(rows[0]);
    },

    async listPriceMap(livemode, catalogVersion = null) {
      const { rows } = await executor.query(
        `select * from membership_price_map
          where livemode = $1 and ($2::int is null or catalog_version = $2)
          order by package_id, size_id`,
        [livemode, catalogVersion]
      );
      return rows.map(mapPrice);
    },

    async getCustomerById(id) {
      if (!id) return null;
      const { rows } = await executor.query('select * from membership_customers where id = $1', [id]);
      return mapCustomer(rows[0]);
    },

    async getCustomerByStripeId(stripeCustomerId) {
      const { rows } = await executor.query(
        'select * from membership_customers where stripe_customer_id = $1',
        [stripeCustomerId]
      );
      return mapCustomer(rows[0]);
    },

    async findCustomerByEmail(email, livemode) {
      if (!email) return null;
      const { rows } = await executor.query(
        'select * from membership_customers where lower(email) = lower($1) and livemode = $2 order by created_at limit 1',
        [email, livemode]
      );
      return mapCustomer(rows[0]);
    },

    async getCheckoutSessionByStripeId(stripeSessionId) {
      const { rows } = await executor.query(
        'select * from membership_checkout_sessions where stripe_session_id = $1',
        [stripeSessionId]
      );
      return mapCheckoutSession(rows[0]);
    },

    async getContract(id) {
      const { rows } = await executor.query('select * from membership_contracts where id = $1', [id]);
      return mapContract(rows[0]);
    },

    async getContractsBySubscription(subscriptionId) {
      const { rows } = await executor.query(
        'select * from membership_contracts where stripe_subscription_id = $1 order by line_index',
        [subscriptionId]
      );
      return rows.map(mapContract);
    },

    async getContractsByCheckoutSession(checkoutSessionId) {
      const { rows } = await executor.query(
        'select * from membership_contracts where checkout_session_id = $1 order by line_index',
        [checkoutSessionId]
      );
      return rows.map(mapContract);
    },

    async getOpenVisitForContract(contractId) {
      const { rows } = await executor.query(
        `select * from membership_visits
          where contract_id = $1 and status in ('held', 'confirmed')
          order by scheduled_start limit 1`,
        [contractId]
      );
      return mapVisit(rows[0]);
    },

    async getVisit(id) {
      const { rows } = await executor.query('select * from membership_visits where id = $1', [id]);
      return mapVisit(rows[0]);
    },

    async getVisitsByParentBooking(parentBookingId) {
      const { rows } = await executor.query(
        'select * from membership_visits where parent_booking_id = $1 order by created_at',
        [parentBookingId]
      );
      return rows.map(mapVisit);
    },

    async creditBalanceForContract(contractId) {
      const { rows } = await executor.query(
        'select coalesce(sum(delta), 0)::int as balance from membership_credit_ledger where contract_id = $1',
        [contractId]
      );
      return rows[0].balance;
    },

    async getStripeEvent(id) {
      const { rows } = await executor.query('select * from stripe_events where id = $1', [id]);
      const row = rows[0];
      return row ? { id: row.id, type: row.type, status: row.status, receivedAtMs: ms(row.received_at) } : null;
    },

    async getNotification(dedupeKey) {
      const { rows } = await executor.query(
        'select * from notification_deliveries where dedupe_key = $1',
        [dedupeKey]
      );
      const row = rows[0];
      return row ? {
        id: row.id, dedupeKey: row.dedupe_key, channel: row.channel, template: row.template,
        status: row.status, providerRef: row.provider_ref, attempts: row.attempts
      } : null;
    },

    async listNotifications() {
      const { rows } = await executor.query('select * from notification_deliveries order by created_at');
      return rows.map(row => ({
        id: row.id, dedupeKey: row.dedupe_key, channel: row.channel, template: row.template,
        recipient: row.recipient, status: row.status, context: row.context
      }));
    },

    // ── CRM catalog map and payment links ──
    async findCrmPrice({ kind, packageId = null, sizeId = null, addonId = null, productKey = null, livemode }) {
      const { rows } = await executor.query(
        `select * from crm_price_map
          where kind = $1 and livemode = $2 and active
            and ($3::text is null or package_id = $3)
            and ($4::text is null or size_id = $4)
            and ($5::text is null or addon_id = $5)
            and ($6::text is null or product_key = $6)
          order by catalog_version desc limit 1`,
        [kind, livemode, packageId, sizeId, addonId, productKey]
      );
      return mapCrmPrice(rows[0]);
    },

    async listCrmPriceMap(livemode) {
      const { rows } = await executor.query(
        'select * from crm_price_map where livemode = $1 and active order by kind, product_key, price_key',
        [livemode]
      );
      return rows.map(mapCrmPrice);
    },

    async getPaymentLinkByKey(idempotencyKey) {
      const { rows } = await executor.query('select * from payment_links where idempotency_key = $1', [idempotencyKey]);
      return mapPaymentLink(rows[0]);
    },

    async getHighLevelSync(entityType, localKey) {
      const { rows } = await executor.query(
        'select * from highlevel_sync_state where entity_type = $1 and local_key = $2',
        [entityType, localKey]
      );
      const row = rows[0];
      return row ? { entityType: row.entity_type, localKey: row.local_key, externalId: row.external_id, payloadHash: row.payload_hash } : null;
    }
  };
}

function membershipWrites(client) {
  return {
    async upsertPriceMapEntries(entries) {
      for (const entry of entries) {
        await client.query(
          `insert into membership_price_map (
             id, catalog_version, package_id, size_id, monthly_cents, currency, credits_per_cycle,
             stripe_product_id, stripe_price_id, lookup_key, livemode, active
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
           on conflict (catalog_version, package_id, size_id, livemode) do update
             set stripe_product_id = excluded.stripe_product_id,
                 stripe_price_id = excluded.stripe_price_id,
                 monthly_cents = excluded.monthly_cents,
                 credits_per_cycle = excluded.credits_per_cycle,
                 lookup_key = excluded.lookup_key,
                 active = true,
                 updated_at = now()`,
          [
            entry.id, entry.catalogVersion, entry.packageId, entry.sizeId, entry.monthlyCents,
            entry.currency, entry.creditsPerCycle, entry.stripeProductId, entry.stripePriceId,
            entry.lookupKey, entry.livemode
          ]
        );
      }
      return entries.length;
    },

    async insertCustomer(row) {
      const { rows } = await client.query(
        `insert into membership_customers (id, stripe_customer_id, livemode, contact_id, email, phone, name)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (stripe_customer_id) do update
           set contact_id = coalesce(excluded.contact_id, membership_customers.contact_id),
               email = coalesce(excluded.email, membership_customers.email),
               phone = coalesce(excluded.phone, membership_customers.phone),
               name = coalesce(excluded.name, membership_customers.name),
               updated_at = now()
         returning *`,
        [row.id, row.stripeCustomerId, row.livemode, row.contactId, row.email, row.phone, row.name]
      );
      return mapCustomer(rows[0]);
    },

    async insertCheckoutSession(row) {
      const { rows } = await client.query(
        `insert into membership_checkout_sessions (
           id, stripe_session_id, stripe_customer_id, customer_id, livemode,
           catalog_version, lines, total_monthly_cents, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'open')
         on conflict (stripe_session_id) do nothing
         returning *`,
        [
          row.id, row.stripeSessionId, row.stripeCustomerId, row.customerId, row.livemode,
          row.catalogVersion, JSON.stringify(row.lines), row.totalMonthlyCents
        ]
      );
      return mapCheckoutSession(rows[0]);
    },

    async markCheckoutSessionCompleted(id, atMs) {
      await client.query(
        "update membership_checkout_sessions set status = 'completed', completed_at = $2 where id = $1",
        [id, iso(atMs)]
      );
    },

    async insertContract(row) {
      const { rows } = await client.query(
        `insert into membership_contracts (
           id, customer_id, checkout_session_id, stripe_subscription_id, stripe_subscription_item_id,
           stripe_price_id, line_index, package_id, size_id, monthly_cents, credits_per_cycle,
           credits_remaining, status, vehicle, vehicle_label
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         on conflict (stripe_subscription_item_id, line_index) do nothing
         returning *`,
        [
          row.id, row.customerId, row.checkoutSessionId, row.stripeSubscriptionId,
          row.stripeSubscriptionItemId, row.stripePriceId, row.lineIndex, row.packageId, row.sizeId,
          row.monthlyCents, row.creditsPerCycle, row.creditsRemaining || 0, row.status || 'pending',
          JSON.stringify(row.vehicle || {}), row.vehicleLabel
        ]
      );
      return mapContract(rows[0]);
    },

    async updateContract(id, fields) {
      const update = buildUpdate('membership_contracts', CONTRACT_COLUMNS, id, fields);
      if (!update) return;
      await client.query(update.text, update.params);
    },

    async insertVisit(row) {
      const { rows } = await client.query(
        `insert into membership_visits (
           id, contract_id, hold_id, parent_booking_id, booking_id, cycle_start, cycle_end,
           scheduled_start, scheduled_end, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [
          row.id, row.contractId, row.holdId, row.parentBookingId, row.bookingId,
          iso(row.cycleStartMs), iso(row.cycleEndMs), iso(row.scheduledStartMs), iso(row.scheduledEndMs),
          row.status
        ]
      );
      return mapVisit(rows[0]);
    },

    async updateVisit(id, fields) {
      const update = buildUpdate('membership_visits', VISIT_COLUMNS, id, fields);
      if (!update) return;
      await client.query(update.text, update.params);
    },

    // Returns { inserted: false } for an event id we have already stored, which is
    // the whole idempotency story for Stripe redeliveries.
    async insertStripeEvent(event) {
      const { rows } = await client.query(
        `insert into stripe_events (id, type, livemode, api_version, payload, status)
         values ($1,$2,$3,$4,$5,'received')
         on conflict (id) do nothing
         returning id`,
        [event.id, event.type, event.livemode, event.apiVersion, JSON.stringify(event.payload || {})]
      );
      return { inserted: rows.length > 0 };
    },

    async markStripeEvent(id, status, error = null) {
      await client.query(
        'update stripe_events set status = $2, error = $3, processed_at = now() where id = $1',
        [id, status, error]
      );
    },

    async insertNotification(row) {
      const { rows } = await client.query(
        `insert into notification_deliveries (id, dedupe_key, channel, template, recipient, context, status)
         values ($1,$2,$3,$4,$5,$6,'pending')
         on conflict (dedupe_key) do nothing
         returning id`,
        [row.id, row.dedupeKey, row.channel, row.template, row.recipient, JSON.stringify(row.context || {})]
      );
      return { inserted: rows.length > 0 };
    },

    async markNotificationSent(dedupeKey, providerRef) {
      await client.query(
        `update notification_deliveries
            set status = 'sent', provider_ref = $2, sent_at = now(), attempts = attempts + 1
          where dedupe_key = $1`,
        [dedupeKey, providerRef]
      );
    },

    async markNotificationFailed(dedupeKey, error) {
      await client.query(
        `update notification_deliveries
            set status = 'failed', last_error = $2, attempts = attempts + 1
          where dedupe_key = $1`,
        [dedupeKey, String(error).slice(0, 500)]
      );
    },

    // { inserted } for a first sync, { changed } when the payload differs from what
    // we last pushed. Both false means HighLevel is already up to date and the
    // caller can skip the network entirely.
    async upsertCrmPriceMap(rows) {
      for (const row of rows) {
        await client.query(
          `insert into crm_price_map (
             id, catalog_version, kind, product_key, price_key, package_id, size_id, addon_id,
             amount_cents, currency, price_type, crm_product_id, crm_price_id, livemode, active
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'usd',$10,$11,$12,$13,true)
           on conflict (catalog_version, kind, price_key, livemode) do update
             set crm_product_id = excluded.crm_product_id,
                 crm_price_id = excluded.crm_price_id,
                 amount_cents = excluded.amount_cents,
                 price_type = excluded.price_type,
                 active = true,
                 updated_at = now()`,
          [
            row.id, row.catalogVersion, row.kind, row.productKey, row.priceKey, row.packageId,
            row.sizeId, row.addonId, row.amountCents, row.type || row.priceType,
            row.crmProductId, row.crmPriceId, row.livemode
          ]
        );
      }
      return rows.length;
    },

    // Claims the key and returns { inserted }. A second click, or a retry after a
    // timeout, finds the row already there and reuses the link instead of issuing
    // a second invoice for the same thing.
    async insertPaymentLink(row) {
      const { rows } = await client.query(
        `insert into payment_links (
           id, idempotency_key, purpose, origin, hold_id, parent_booking_id, contract_id,
           contact_id, lines, amount_cents, created_by, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
         on conflict (idempotency_key) do nothing
         returning *`,
        [
          row.id, row.idempotencyKey, row.purpose, row.origin, row.holdId, row.parentBookingId,
          row.contractId, row.contactId, JSON.stringify(row.lines || []), row.amountCents, row.createdBy
        ]
      );
      return { inserted: rows.length > 0, link: mapPaymentLink(rows[0]) };
    },

    async markPaymentLinkIssued(idempotencyKey, { crmInvoiceId, url }) {
      await client.query(
        `update payment_links set status = 'issued', crm_invoice_id = $2, url = $3, updated_at = now()
          where idempotency_key = $1`,
        [idempotencyKey, crmInvoiceId, url]
      );
    },

    async markPaymentLinkFailed(idempotencyKey, reason) {
      await client.query(
        `update payment_links set status = 'failed', failure_reason = $2, updated_at = now()
          where idempotency_key = $1`,
        [idempotencyKey, String(reason).slice(0, 500)]
      );
    },

    async markPaymentLinkPaid(crmInvoiceId, atMs) {
      await client.query(
        `update payment_links set status = 'paid', paid_at = $2, updated_at = now()
          where crm_invoice_id = $1`,
        [crmInvoiceId, iso(atMs)]
      );
    },

    async getPaymentLinkByKey(idempotencyKey) {
      const { rows } = await client.query('select * from payment_links where idempotency_key = $1', [idempotencyKey]);
      return mapPaymentLink(rows[0]);
    },

    async upsertHighLevelSync(entityType, localKey, { externalId = null, payloadHash = null } = {}) {
      const { rows: existing } = await client.query(
        'select * from highlevel_sync_state where entity_type = $1 and local_key = $2',
        [entityType, localKey]
      );
      if (!existing.length) {
        await client.query(
          `insert into highlevel_sync_state (id, entity_type, local_key, external_id, payload_hash)
           values ($5, $1, $2, $3, $4)
           on conflict (entity_type, local_key) do nothing`,
          // Ids are generated in Node everywhere else in this codebase; doing the
          // same here keeps the schema free of a uuid-extension dependency.
          [entityType, localKey, externalId, payloadHash, require('node:crypto').randomUUID()]
        );
        return { inserted: true, changed: true, externalId };
      }
      const row = existing[0];
      const changed = row.payload_hash !== payloadHash;
      if (changed || (externalId && externalId !== row.external_id)) {
        await client.query(
          `update highlevel_sync_state
              set external_id = coalesce($3, external_id), payload_hash = $4, synced_at = now()
            where entity_type = $1 and local_key = $2`,
          [entityType, localKey, externalId, payloadHash]
        );
      }
      return { inserted: false, changed, externalId: externalId || row.external_id };
    }
  };
}

module.exports = {
  membershipReads,
  membershipWrites,
  mapPrice,
  mapCustomer,
  mapCheckoutSession,
  mapContract,
  mapVisit
};
