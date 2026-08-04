# Memberships and recurring billing

> **Stripe was removed on 2026-08-04.** Everything is kept in HighLevel so there is one
> place a sale is recorded — see `DISENO-SIN-BASE-DE-DATOS.md`. This document is now a
> **specification, not a description**: the commercial rules below are what the HighLevel
> recurring-invoice implementation has to satisfy, and the parts that describe Stripe
> checkout, webhooks and provisioning no longer exist in the code.
>
> What survives in code (`api/_lib/memberships.js`) is the SPEND side, still tested:
> 48 hours of notice, the credit spent on completion rather than on booking, a late
> cancel or a no-show spending it anyway, one open visit per contract, an exhausted
> balance refusing the next booking.
>
> What is NOT in code any more, because it only happens when a payment lands, and has
> to be rebuilt: activating a contract, setting its cycle, **resetting the balance on
> renewal (credits do not roll over)**, marking it `past_due`, and cancelling it.

## The commercial model, as code

| Rule | Where it lives |
|---|---|
| A contract is **per vehicle** — own balance, own next visit | `membership_contracts`, one row per vehicle |
| One checkout, several recurring lines, one account holder | `membership_checkout_sessions.lines` → contracts |
| Monthly, automatic, **no extra deposit** | membership visits never touch the deposit flow |
| 2x plans include 2 washes a cycle, 4x include 4 | `creditsForPackage()` in `membership-catalog.js` |
| **One future visit per contract** | partial unique index `membership_visits_one_open` |
| Membership booking needs **48 h** | `MEMBERSHIP_MIN_NOTICE_MS` |
| The credit is spent **on completion**, not on booking | `completeVisit()` → `consumeCredit()` |
| Cancel < 24 h, or no-show, spends it anyway | `LATE_CANCEL_WINDOW_MS`, idempotent ledger |
| `past_due` blocks new bookings, keeps the paid-cycle one | `bookingEligibility()`; `onInvoicePaymentFailed` touches no visit |
| `cancel_at_period_end` keeps the cycle, stops renewal | `onSubscriptionUpdated` |
| `canceled` blocks future bookings | `bookingEligibility()` → `canceled` |

### Credits do not roll over

A paid cycle **resets** the balance to the plan's allowance. The ledger records the
grant as `delta = allowance − balance`, so the running total always equals what the
customer can actually spend, and "why is my balance 2?" has an answer you can read:

```
+2  cycle_granted     first invoice paid
-1  visit_completed   wash delivered
+1  cycle_renewed     next invoice paid → back to 2, not 3
```

## Money is never client-side

The browser sends a `packageId` and a `sizeId`. Everything that follows —
the amount, the Stripe price, the number of credits — is looked up in
`api/_lib/membership-catalog.js`: **17 packages, 33 monthly prices**, in cents.

A request carrying `monthlyCents`, `price`, `amount` or `stripePriceId` is parsed
past and dropped (`validateCheckoutLine`), and checkout additionally refuses to
proceed if the provisioned Stripe price disagrees with the catalog. A tampered
frontend can pick a different *plan*; it cannot pick a different *price*.

`tests/stripe-provisioning.test.js` pins all 33 amounts against
`catalog-prices.json`, so the page and the charge cannot drift apart.

## Provisioning Stripe

```bash
node scripts/provision-stripe.mjs                                  # dry run
node scripts/provision-stripe.mjs --apply                          # test mode
node scripts/provision-stripe.mjs --apply --live --i-understand-live
```

- **Dry run is the default** — a bare run prints all 33 prices and touches nothing.
- **Live needs two extra flags.** A live secret key on its own is not consent.
- **It never touches what it did not create.** Products are matched on
  `metadata.lyb_object = lyb_membership`, prices on our own `lookup_key`. The
  existing **$30/$50 deposit products are invisible to the planner**, and an
  unmarked object wearing our identifiers stops the run instead of being adopted.
- Re-running is safe; only missing objects are created. Stripe prices are
  immutable, so a changed amount means bumping `CATALOG_VERSION` — the map is
  versioned precisely so an existing subscription keeps billing at the price it
  was sold at.

Nothing in this repo publishes a HighLevel workflow or creates a live product on
its own.

## Flow

```
POST /api/memberships/checkout   → Stripe Customer (reused) + subscription Checkout
POST /api/webhooks/stripe        → the only thing that can activate or bill
POST /api/memberships/visits     → book | confirm | complete | cancel | no_show
```

### Events handled

| Event | Effect |
|---|---|
| `checkout.session.completed` | contracts created, one per vehicle, status `pending` |
| `invoice.paid` | activates, sets the cycle, resets credits (first time or renewal) |
| `invoice.payment_failed` | `past_due`; the paid-cycle visit is untouched |
| `customer.subscription.updated` | status, `cancel_at_period_end`, period dates |
| `customer.subscription.deleted` | `canceled`; history kept |

### Two identical vehicles

Stripe rejects two line items with the same price in one session, so two identical
vehicles become **one line with quantity 2**. The vehicle→line plan is stored
before the redirect and the webhook rebuilds contracts from it, so quantity 2
still yields **two contracts with two balances** — keyed by
`(subscription_item_id, line_index)`.

## Only a verified webhook confirms anything

A membership visit is booked as an agenda hold and confirmed only when the
contract carries `activated_by_event_id` — written by `invoice.paid` and by
nothing else — and a paid cycle that still covers the visit. That is the same rule
the deposit flow follows, with the proof coming from a subscription invoice rather
than a one-off payment.

Three defences on the webhook endpoint, in order:

1. **Signature.** HMAC-SHA256 over the raw bytes, constant-time compare, 5-minute
   tolerance. The raw body is read before anything parses it (`bodyParser: false`);
   if only a parsed object is available the request is refused rather than
   trusted, because re-serialising cannot reproduce the signed bytes.
2. **Event id.** `stripe_events.id` is the primary key. Stripe retries generously;
   the second delivery never reaches a handler.
3. **Transactions.** A handler applies completely or not at all.

A live event arriving at a test-key endpoint (or the reverse) is acknowledged and
ignored — never acted on.

## One message per fact

Every outbound SMS, email and internal notice claims a row in
`notification_deliveries` keyed by **what it is about**, not when it was sent:

```
membership:<contract>:activated
membership:<contract>:renewed:<invoice>
booking:<parent-booking>:confirmed        ← one per parent booking, not per vehicle
visit:<visit>:no_show
```

`dedupe_key` is unique and claimed **before** the send, so a Stripe redelivery, a
HighLevel retry, or two workers at once produce one message. A send that fails
leaves a `failed` row that is visible and is never silently retried into a second
message. An unconfigured endpoint records the message rather than dropping it.

## HighLevel sync

Idempotent by content hash in `highlevel_sync_state`: one contact per account
holder, **one opportunity per vehicle contract**, status fields updated in place,
and exactly one calendar event per confirmed parent booking. A re-sync with
unchanged content skips the network call entirely. HighLevel failures are logged
and swallowed — the CRM being down must not make Stripe redeliver an event that
was already applied.

## Environment

See `.env.example` for the annotated list. In short: `STRIPE_SECRET_KEY` (its
prefix decides live vs test), `STRIPE_WEBHOOK_SECRET`, the checkout return URLs,
`DATABASE_URL`, the HighLevel credentials and four `GHL_CALENDAR_CAMIONETA_*`
calendar ids, the four `GHL_WORKFLOW_*_URL` endpoints, and `OFFICE_API_TOKEN` for
the actions that change what a customer owes.

## Deploying

```bash
npm install
DATABASE_URL=… npm run migrate                     # adds 002_memberships.sql
node scripts/provision-stripe.mjs                  # look first
node scripts/provision-stripe.mjs --apply          # test mode
```

Then point a Stripe webhook endpoint at `/api/webhooks/stripe` for the five event
types above and put its signing secret in `STRIPE_WEBHOOK_SECRET`.

## Not verified against live Stripe

Every Stripe interaction here is covered by a fake shaped like the real API
(`tests/support/stripe-fixtures.js`), and the request/response shapes follow the
published API — but no call in this module has been made against a real Stripe
account yet. Run the provisioner in test mode and put one test-mode subscription
through checkout → `invoice.paid` → book → complete before enabling live keys.
