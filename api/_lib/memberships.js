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
const membershipCatalog = require('./membership-catalog.js');
const stripeClient = require('./stripe.js');
const notifications = require('./notifications.js');
const highlevel = require('./highlevel-sync.js');
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

// ── Checkout ───────────────────────────────────────────────────────────────

function validateCheckoutLine(line, index) {
  if (!line || typeof line !== 'object') throw new RequestError(`lines[${index}] is required`);
  const packageId = String(line.packageId || '').trim();
  const sizeId = String(line.sizeId || '').trim();
  if (!membershipCatalog.isSellableMembership(packageId)) {
    throw new RequestError(`lines[${index}].packageId is not a membership`, 422);
  }
  // The price comes from the catalog, keyed by ids. Nothing in the request can
  // influence the amount — that is the whole point of this lookup.
  const price = membershipCatalog.priceFor(packageId, sizeId);

  const vehicle = line.vehicle || {};
  const year = Number(vehicle.year);
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < 1900 || year > maxYear) {
    throw new RequestError(`lines[${index}].vehicle.year is invalid`);
  }
  const make = String(vehicle.make || '').trim();
  const model = String(vehicle.model || '').trim();
  if (make.length < 2 || model.length < 2) throw new RequestError(`lines[${index}].vehicle is invalid`);

  return {
    vehicleIndex: index,
    packageId,
    sizeId,
    monthlyCents: price.monthlyCents,
    creditsPerCycle: price.creditsPerCycle,
    label: price.label,
    vehicle: {
      make, model, year,
      color: String(vehicle.color || '').trim().slice(0, 40),
      plate: String(vehicle.plate || '').trim().slice(0, 16)
    },
    vehicleLabel: `${year} ${make} ${model}`.trim()
  };
}

function validateCheckoutRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request body');
  const customer = body.customer || {};
  const name = String(customer.name || '').trim();
  const email = String(customer.email || '').trim().toLowerCase();
  const phone = String(customer.phone || '').trim();
  if (name.length < 2) throw new RequestError('customer.name is required');
  // Stripe needs somewhere to send the receipt, and we need a stable key for
  // reusing the customer across checkouts.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RequestError('customer.email is required');

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw new RequestError('lines must contain at least one membership');
  if (lines.length > MAX_CHECKOUT_LINES) throw new RequestError(`lines must contain at most ${MAX_CHECKOUT_LINES} memberships`, 422);

  return {
    customer: { name, email, phone, contactId: String(customer.contactId || '').trim() || null },
    lines: lines.map(validateCheckoutLine)
  };
}

// Creates (or reuses) the Stripe customer and opens a subscription checkout.
//
// Stripe rejects two line items with the same price in one session, so two
// identical vehicles become one line with quantity 2. The vehicle→line mapping is
// stored here, before the redirect, and the webhook rebuilds contracts from it —
// which is how quantity 2 still yields two contracts with two balances.
async function createCheckout({ customer, lines, config = null, stripeConfig = null, now = Date.now() }) {
  const repository = getRepository();
  const stripe = stripeConfig || stripeClient.getStripeConfig();

  const priced = [];
  for (const line of lines) {
    const entry = await repository.getPriceMapEntry(line.packageId, line.sizeId, stripe.livemode);
    if (!entry) {
      // The catalog knows the price but Stripe has never been provisioned with it.
      // Refuse rather than invent a price on the fly.
      throw new RequestError(
        `Membership ${line.packageId}/${line.sizeId} is not available for purchase yet`,
        503
      );
    }
    // Defence in depth: the provisioned Stripe price must still agree with the
    // catalog. If someone edited the price in the Stripe dashboard, stop.
    if (entry.monthlyCents !== line.monthlyCents) {
      throw new RequestError('Membership pricing is out of sync; contact the office', 503);
    }
    priced.push({ ...line, stripePriceId: entry.stripePriceId, stripeProductId: entry.stripeProductId });
  }

  // Reuse the Stripe customer so a second membership lands on the same card.
  let stripeCustomerId = null;
  const known = await repository.findCustomerByEmail(customer.email, stripe.livemode);
  if (known) {
    stripeCustomerId = known.stripeCustomerId;
  } else {
    const existing = await stripeClient.findCustomerByEmail(stripe, customer.email);
    if (existing) {
      stripeCustomerId = existing.id;
    } else {
      const created = await stripeClient.createCustomer(stripe, {
        email: customer.email,
        name: customer.name,
        phone: customer.phone || undefined,
        metadata: { lyb_object: 'lyb_membership_customer', ...(customer.contactId ? { lyb_contact_id: customer.contactId } : {}) }
      }, `customer:${customer.email}`);
      stripeCustomerId = created.id;
    }
  }

  // One Stripe line per distinct price, quantity = how many vehicles want it.
  const byPrice = new Map();
  priced.forEach(line => {
    const entry = byPrice.get(line.stripePriceId) || { price: line.stripePriceId, quantity: 0 };
    entry.quantity += 1;
    byPrice.set(line.stripePriceId, entry);
  });

  const totalMonthlyCents = priced.reduce((total, line) => total + line.monthlyCents, 0);
  const localSessionId = newId();

  const session = await stripeClient.createCheckoutSession(stripe, {
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [...byPrice.values()],
    success_url: stripe.successUrl || 'https://lybelitewash.com/membership/thanks?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: stripe.cancelUrl || 'https://lybelitewash.com/membership',
    // The webhook finds our row by session id; the local id is carried along so a
    // human reading Stripe can trace it back.
    client_reference_id: localSessionId,
    metadata: {
      lyb_object: 'lyb_membership_checkout',
      lyb_local_session_id: localSessionId,
      lyb_line_count: String(priced.length)
    },
    subscription_data: {
      metadata: {
        lyb_object: 'lyb_membership_subscription',
        lyb_local_session_id: localSessionId
      }
    }
  }, `checkout:${localSessionId}`);

  const customerRow = await repository.transaction([`membership:${stripeCustomerId}`], async tx => {
    const stored = await tx.insertCustomer({
      id: newId(),
      stripeCustomerId,
      livemode: stripe.livemode,
      contactId: customer.contactId,
      email: customer.email,
      phone: customer.phone,
      name: customer.name
    });
    await tx.insertCheckoutSession({
      id: localSessionId,
      stripeSessionId: session.id,
      stripeCustomerId,
      customerId: stored.id,
      livemode: stripe.livemode,
      catalogVersion: membershipCatalog.CATALOG_VERSION,
      lines: priced,
      totalMonthlyCents
    });
    return stored;
  });

  return {
    checkoutUrl: session.url,
    stripeSessionId: session.id,
    localSessionId,
    customerId: customerRow.id,
    totalMonthlyCents,
    lineCount: priced.length
  };
}

// ── Webhook dispatch ───────────────────────────────────────────────────────

// Records the event and runs its handler exactly once.
//
// The event id is the primary key of stripe_events, so the second delivery of the
// same event does not even reach the handler. That is the only thing standing
// between Stripe's retry policy and a customer being granted credits five times.
async function handleEvent(event, { config = null, stripeConfig = null, now = Date.now() } = {}) {
  const repository = getRepository();

  const claimed = await repository.transaction([`stripe-event:${event.id}`], async tx => tx.insertStripeEvent({
    id: event.id,
    type: event.type,
    livemode: Boolean(event.livemode),
    apiVersion: event.api_version || null,
    payload: event,
    receivedAtMs: now
  }));

  if (!claimed.inserted) {
    // Already seen. Normally that means "handled, do nothing" — but an event whose
    // handler THREW is recorded as failed, and Stripe is retrying it precisely
    // because we asked it to. Treating that as a duplicate would swallow the retry
    // and lose the event for good, so a failed event is allowed through again.
    const previous = await repository.getStripeEvent(event.id);
    if (!previous || previous.status !== 'failed') return { duplicate: true, type: event.type };
  }
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    await repository.transaction([`stripe-event:${event.id}`], async tx => tx.markStripeEvent(event.id, 'ignored'));
    return { ignored: true, type: event.type };
  }

  try {
    const result = await dispatch(event, { config, stripeConfig, now });
    await repository.transaction([`stripe-event:${event.id}`], async tx => tx.markStripeEvent(event.id, 'processed'));
    return { ...result, type: event.type, duplicate: false };
  } catch (error) {
    // Recorded as failed, and rethrown so the endpoint answers 5xx and Stripe
    // retries. The event row stays, but a failed row does not block the retry —
    // see the status check in the endpoint.
    await repository.transaction([`stripe-event:${event.id}`], async tx =>
      tx.markStripeEvent(event.id, 'failed', String(error.message).slice(0, 500))
    );
    throw error;
  }
}

function dispatch(event, context) {
  const object = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': return onCheckoutCompleted(event, object, context);
    case 'invoice.paid': return onInvoicePaid(event, object, context);
    case 'invoice.payment_failed': return onInvoicePaymentFailed(event, object, context);
    case 'customer.subscription.updated': return onSubscriptionUpdated(event, object, context);
    case 'customer.subscription.deleted': return onSubscriptionDeleted(event, object, context);
    default: return Promise.resolve({ ignored: true });
  }
}

// ── checkout.session.completed ─────────────────────────────────────────────

// Turns the stored line plan into one contract per vehicle. Contracts start
// `pending`: the session being completed means the customer finished checkout,
// not that the first invoice cleared. invoice.paid is what activates them.
async function onCheckoutCompleted(event, session, { config, stripeConfig, now }) {
  const repository = getRepository();
  const stored = await repository.getCheckoutSessionByStripeId(session.id);
  if (!stored) {
    // A session we did not create (or one from another environment). Nothing to do.
    return { skipped: 'unknown_session' };
  }

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription && session.subscription.id);
  if (!subscriptionId) return { skipped: 'no_subscription' };

  // Subscription items tell us which item id carries which price; the stored plan
  // tells us which vehicle wanted which price. Together they map vehicles to items.
  let items = [];
  const inlineItems = session.subscription && session.subscription.items && session.subscription.items.data;
  if (Array.isArray(inlineItems)) {
    items = inlineItems;
  } else {
    const stripe = stripeConfig || stripeClient.getStripeConfig();
    const subscription = await stripeClient.getSubscription(stripe, subscriptionId);
    items = (subscription.items && subscription.items.data) || [];
  }

  const itemByPrice = new Map();
  items.forEach(item => {
    const priceId = typeof item.price === 'string' ? item.price : (item.price && item.price.id);
    if (priceId) itemByPrice.set(priceId, item.id);
  });

  const created = await repository.transaction([`membership:${stored.stripeCustomerId}`], async tx => {
    const contracts = [];
    // Line index counts WITHIN a price, so two identical vehicles on one
    // quantity-2 item become lines 0 and 1 of that item.
    const seenPerPrice = new Map();
    for (const line of stored.lines) {
      const itemId = itemByPrice.get(line.stripePriceId);
      if (!itemId) continue;
      const lineIndex = seenPerPrice.get(line.stripePriceId) || 0;
      seenPerPrice.set(line.stripePriceId, lineIndex + 1);

      const contract = await tx.insertContract({
        id: newId(),
        customerId: stored.customerId,
        checkoutSessionId: stored.id,
        stripeSubscriptionId: subscriptionId,
        stripeSubscriptionItemId: itemId,
        stripePriceId: line.stripePriceId,
        lineIndex,
        packageId: line.packageId,
        sizeId: line.sizeId,
        monthlyCents: line.monthlyCents,
        creditsPerCycle: line.creditsPerCycle,
        creditsRemaining: 0,
        status: 'pending',
        vehicle: line.vehicle,
        vehicleLabel: line.vehicleLabel
      });
      // null means the contract already existed — a redelivered event.
      if (contract) contracts.push(contract);
    }
    await tx.markCheckoutSessionCompleted(stored.id, now);
    return contracts;
  });

  if (created.length) {
    const customer = await repository.getCustomerByStripeId(stored.stripeCustomerId);
    await highlevel.syncMembership({ customer, contracts: created, config });
  }

  return { contractsCreated: created.length, subscriptionId };
}

// ── invoice.paid ───────────────────────────────────────────────────────────

// Reads the cycle this invoice paid for. Prefers the subscription line's own
// period, which is the authoritative one for a renewal.
function periodFromInvoice(invoice) {
  const line = ((invoice.lines && invoice.lines.data) || []).find(entry => entry.period) || null;
  const start = line && line.period ? secondsToMs(line.period.start) : secondsToMs(invoice.period_start);
  const end = line && line.period ? secondsToMs(line.period.end) : secondsToMs(invoice.period_end);
  return { start, end };
}

// A paid cycle activates the contracts and resets their balance.
//
// The grant is written as a RESET, not an addition: `delta = allowance - balance`.
// That keeps the ledger's running total equal to the balance the customer can
// actually spend, and encodes the rule that unused washes do not roll over.
async function onInvoicePaid(event, invoice, { config, now }) {
  const repository = getRepository();
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : (invoice.subscription && invoice.subscription.id);
  if (!subscriptionId) return { skipped: 'no_subscription' };

  const contracts = await repository.getContractsBySubscription(subscriptionId);
  if (!contracts.length) return { skipped: 'unknown_subscription' };

  const period = periodFromInvoice(invoice);
  const renewals = [];
  const activations = [];

  await repository.transaction([`subscription:${subscriptionId}`], async tx => {
    for (const contract of contracts) {
      const current = await tx.getContract(contract.id);
      const wasActivated = Boolean(current.activatedByEventId);

      const balance = await tx.creditBalanceForContract(current.id);
      const delta = current.creditsPerCycle - balance;
      if (delta !== 0) {
        await tx.appendMembershipCredits([{
          id: newId(),
          contactId: null,
          contractId: current.id,
          parentBookingId: null,
          packageId: current.packageId,
          delta,
          reason: wasActivated ? 'cycle_renewed' : 'cycle_granted',
          cycleStartMs: period.start,
          // Derived from the invoice, so the same invoice can never grant twice.
          idempotencyKey: `${current.id}:invoice:${invoice.id}:cycle`
        }]);
      }

      await tx.updateContract(current.id, {
        status: 'active',
        creditsRemaining: current.creditsPerCycle,
        currentPeriodStartMs: period.start,
        currentPeriodEndMs: period.end,
        // The proof that a verified webhook paid for this cycle. Confirming a
        // membership visit checks exactly this.
        activatedByEventId: event.id,
        paidInvoiceId: invoice.id
      });

      (wasActivated ? renewals : activations).push(current);
    }
  });

  for (const contract of activations) {
    await notifications.notify({
      dedupeKey: notifications.keys.membershipActivated(contract.id),
      channel: 'sms',
      template: 'membership_activated',
      context: { contractId: contract.id, packageId: contract.packageId, vehicle: contract.vehicleLabel }
    });
  }
  for (const contract of renewals) {
    await notifications.notify({
      dedupeKey: notifications.keys.membershipRenewed(contract.id, invoice.id),
      channel: 'email',
      template: 'membership_renewed',
      context: { contractId: contract.id, credits: contract.creditsPerCycle, periodEnd: period.end }
    });
  }

  // Push the new balance and renewal date to the CRM from the freshly written
  // rows, so the office sees "2 of 2, renews 12 Sep" rather than yesterday's state.
  const refreshed = await repository.getContractsBySubscription(subscriptionId);
  const owner = refreshed.length ? await repository.getCustomerById(refreshed[0].customerId) : null;
  if (owner) await highlevel.syncMembership({ customer: owner, contracts: refreshed, config });

  return { activated: activations.length, renewed: renewals.length, subscriptionId };
}

// ── invoice.payment_failed ─────────────────────────────────────────────────

// past_due blocks NEW bookings. It deliberately does not touch a visit that is
// already booked inside a cycle the customer paid for: they bought that wash, and
// a card failing for next month does not take it away.
async function onInvoicePaymentFailed(event, invoice, { config, now }) {
  const repository = getRepository();
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : (invoice.subscription && invoice.subscription.id);
  if (!subscriptionId) return { skipped: 'no_subscription' };

  const contracts = await repository.getContractsBySubscription(subscriptionId);
  if (!contracts.length) return { skipped: 'unknown_subscription' };

  await repository.transaction([`subscription:${subscriptionId}`], async tx => {
    for (const contract of contracts) {
      await tx.updateContract(contract.id, { status: 'past_due' });
    }
  });

  for (const contract of contracts) {
    await notifications.notify({
      dedupeKey: notifications.keys.membershipPaymentFailed(contract.id, invoice.id),
      channel: 'sms',
      template: 'membership_payment_failed',
      context: { contractId: contract.id, vehicle: contract.vehicleLabel, invoiceId: invoice.id }
    });
  }

  return { pastDue: contracts.length, subscriptionId };
}

// ── customer.subscription.updated / deleted ────────────────────────────────

// Maps Stripe's subscription status onto ours. `incomplete_expired` and `unpaid`
// both mean nothing more will be collected, so they read as canceled.
function contractStatusFor(stripeStatus, current) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing': return 'active';
    case 'past_due': return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired': return 'canceled';
    case 'incomplete': return 'incomplete';
    default: return current;
  }
}

// cancel_at_period_end keeps the current cycle exactly as it is — the customer
// paid for it — and only stops the renewal.
async function onSubscriptionUpdated(event, subscription, { config, now }) {
  const repository = getRepository();
  const contracts = await repository.getContractsBySubscription(subscription.id);
  if (!contracts.length) return { skipped: 'unknown_subscription' };

  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end);
  const periodStart = secondsToMs(subscription.current_period_start);
  const periodEnd = secondsToMs(subscription.current_period_end);

  await repository.transaction([`subscription:${subscription.id}`], async tx => {
    for (const contract of contracts) {
      const current = await tx.getContract(contract.id);
      const status = contractStatusFor(subscription.status, current.status);
      await tx.updateContract(current.id, {
        status,
        cancelAtPeriodEnd,
        ...(periodStart ? { currentPeriodStartMs: periodStart } : {}),
        ...(periodEnd ? { currentPeriodEndMs: periodEnd } : {}),
        ...(status === 'canceled' ? { canceledAtMs: now } : {})
      });
    }
  });

  if (cancelAtPeriodEnd) {
    for (const contract of contracts) {
      await notifications.notify({
        dedupeKey: notifications.keys.membershipCancelScheduled(contract.id, periodEnd || 0),
        channel: 'email',
        template: 'membership_cancel_scheduled',
        context: { contractId: contract.id, periodEnd, vehicle: contract.vehicleLabel }
      });
    }
  }

  return { updated: contracts.length, cancelAtPeriodEnd, status: subscription.status };
}

// Canceled blocks future bookings. History — contracts, visits, ledger — is
// updated, never deleted: the office still needs to answer "what did they have?".
async function onSubscriptionDeleted(event, subscription, { config, now }) {
  const repository = getRepository();
  const contracts = await repository.getContractsBySubscription(subscription.id);
  if (!contracts.length) return { skipped: 'unknown_subscription' };

  await repository.transaction([`subscription:${subscription.id}`], async tx => {
    for (const contract of contracts) {
      await tx.updateContract(contract.id, {
        status: 'canceled',
        cancelAtPeriodEnd: false,
        canceledAtMs: now
      });
    }
  });

  for (const contract of contracts) {
    await notifications.notify({
      dedupeKey: notifications.keys.membershipCanceled(contract.id),
      channel: 'email',
      template: 'membership_canceled',
      context: { contractId: contract.id, vehicle: contract.vehicleLabel }
    });
  }

  return { canceled: contracts.length };
}

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
      durationMinutes: catalog.vehicleDurationMinutes(contract.packageId),
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
  MAX_CHECKOUT_LINES,
  HANDLED_EVENT_TYPES,
  validateCheckoutRequest,
  validateCheckoutLine,
  createCheckout,
  handleEvent,
  contractStatusFor,
  periodFromInvoice,
  bookingEligibility,
  bookVisit,
  confirmVisit,
  completeVisit,
  cancelVisit,
  markNoShow
};
