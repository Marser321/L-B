# Transactional agenda

How the website reserves crews, and why it is built this way.

Companion doc: `MEMBERSHIPS.md`, which covers recurring billing. A membership visit
uses everything below — the same holds, the same four vans, the same rotation —
but is authorised by a paid Stripe cycle instead of a one-off deposit, and spends
a credit when the wash is delivered rather than paying per visit.

## The one idea

**A visit with N vehicles is N vans working at the same time, not one van working
N times.** Every design decision below follows from that:

- Durations are never added together. Three vehicles of 90, 120 and 180 minutes
  are a **three-hour** visit, not a six-and-a-half-hour one.
- A slot is offered only when **N distinct vans** are free, each for the length of
  the vehicle it would take.
- A booking is a **parent reservation plus one child per vehicle**, and each child
  has its own van, its own window and its own calendar appointment.
- Four vans means **at most four vehicles** in one visit. A fifth is HTTP **422**.

## Source of truth

Postgres. Not memory, not `localStorage`, not HighLevel.

HighLevel is a downstream mirror the office reads and can book into by hand, so
the agenda **unions** its own records with the vans' calendars before deciding
anything: Postgres knows what the website sold, the calendar knows what the office
booked by hand, and a slot is free only when both agree.

If `DATABASE_URL` is not set, the booking endpoints return **503**. They never
fall back to reading availability off the calendar — a wrong "yes, that slot is
yours" is worse than a clear "booking is temporarily unavailable".

## The flow

```
POST /api/availability     → start times where all N vehicles can be served at once
POST /api/bookings/holds   → 15-minute claim on N vans   (Idempotency-Key required)
POST /api/quote            → customer + CRM records attached; status pending_payment
POST /api/payments/webhook → verified payment ⇒ confirmed          (the only door)
POST /api/bookings/expire  → cron: releases holds older than 15 minutes
```

A booking is **never** confirmed by filling in the form. It is confirmed when a
verified payment event arrives, and by nothing else. Expiry, a failed payment, or
an abandoned checkout all release every van the hold was holding.

> This replaces the confirm-then-pay model described in `PHASE-B-DECISIONS.md`.
> That document deferred pay-first as an owner decision; the owner has since asked
> for it, and this is it.

## Concurrency

Everything that decides who gets a van happens inside **one transaction**:

1. `pg_advisory_xact_lock` on the booking date.
2. Read what is busy — our assignments plus the vans' calendars.
3. `SELECT … FOR UPDATE` the rotation cursor.
4. Pick free vans, longest vehicle first, starting at the cursor.
5. Insert the hold, the parent, the children, the assignments and the allocations.
6. Advance the cursor.

Two requests racing for the last four vans serialize on that transaction: one
wins, the other gets **409** with nothing half-created behind it.

Underneath the application logic, the database enforces the same rule
structurally:

```sql
exclude using gist (resource_key with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status in ('held', 'confirmed'))
```

Even a hand-written `INSERT` cannot double-book a van.

**Network calls stay outside the transaction.** The vans' calendars are read
before `BEGIN` and written after `COMMIT`, because holding a row lock for as long
as HighLevel feels like taking would serialize the whole day behind one slow
request.

## Rotation

`resource_rotation` holds a persistent cursor. Each hold starts its search at the
next van and, on success, moves the cursor one past the furthest van it consumed —
so consecutive bookings spread across the fleet instead of hammering van 1. Only
free vans are ever selected, and the cursor moves inside the same transaction that
allocates them.

## Compensation

A hold blocks each van's HighLevel calendar with a **block slot** (a hold happens
before we know who the customer is, and appointments require a contact). If any of
those writes fails, every block already created for that hold is deleted again and
the hold is marked `failed` — the fleet is never left partially blocked by a
reservation that does not exist. The caller gets a 503 and can retry.

On confirmation each block becomes a real appointment: the appointment is created
**first**, then the block is deleted, so the van is never momentarily free for
someone to book into.

## What the browser is not trusted for

Price, duration, deposit, membership status, calendar id, and timezone. The
browser sends catalog **ids**; the server looks up every value that follows from
them:

- prices come from `api/_lib/catalog-prices.json`, generated from the same
  `SERVICES_DATA` in `script.js` that the frontend renders
  (`node scripts/extract-catalog.mjs`; `--check` fails when it is stale);
- durations, deposits and membership flags come from `api/_lib/catalog.js`;
- calendar ids come from `GHL_CALENDAR_CAMIONETA_1..4`;
- every timestamp is computed in `BOOKING_TIMEZONE`, the location's zone, and sent
  to the browser as an absolute instant for rendering only.

`api/_lib/selection.js` is the single choke point that does this, which is what
makes it true by construction rather than by discipline.

## Notice periods

48 hours applies to **memberships only**. Every other service keeps the one-hour
notice it has always had. A cart mixing both takes the stricter of the two, since
all its vehicles share one start time.

## Data model

| Table | What it is |
|---|---|
| `booking_holds` | a 15-minute claim; `idempotency_key`, `request_fingerprint`, `expires_at` |
| `hold_allocations` | one row per van in a hold, with the external block-slot id |
| `bookings` | parent reservation (`parent_booking_id is null`) plus one child per vehicle |
| `booking_assignments` | van + calendar + window + external appointment; carries the overlap constraint |
| `resource_rotation` | the persistent round-robin cursor |
| `payment_events` | verified payment events; `unique (provider, external_event_id)` |
| `membership_credit_ledger` | append-only credits; `unique (idempotency_key)`. Written by `MEMBERSHIPS.md`, not by this flow — paying a deposit buys one visit, not an allowance |
| `resources` | the four vans and their rotation order |

## Deploying

```bash
npm install
DATABASE_URL=postgres://… npm run migrate
node scripts/setup-ghl.mjs                 # verifies pipeline, fields, van calendars
```

Required environment (see `.env.example` for the full list with notes):

| Variable | Why |
|---|---|
| `DATABASE_URL` | source of truth; without it the booking endpoints 503 |
| `GHL_CALENDAR_CAMIONETA_1..4` | one calendar per van; all four required |
| `PAYMENT_WEBHOOK_SECRET` | authenticates `/api/payments/webhook` — the only path to a confirmed booking |
| `CRON_SECRET` | authenticates the 15-minute expiry sweep (`vercel.json` cron) |
| `BOOKING_TIMEZONE` | the location's zone; defaults to `America/New_York` |

The migration needs the `btree_gist` extension, which the exclusion constraint
depends on. It is available on Neon, Supabase and RDS; `create extension` is in
the migration itself.

## Tests

```bash
npm test                                   # in-memory repository, runs anywhere
DATABASE_URL=postgres://…/lyb_test npm run migrate && DATABASE_URL=… npm test
```

`tests/agenda.test.js` proves the algorithm against an in-memory repository that
models Postgres' transactions, locks and constraints. `tests/agenda-pg.test.js`
proves the SQL and the real constraints, and is skipped unless `DATABASE_URL` is
set — it truncates the agenda tables, so point it at a throwaway database.

## Unverified against the live sub-account

`POST /calendars/events/block-slots` (Version `2021-07-28`) is used for the hold's
footprint. The request and response shapes are modelled on HighLevel's public API
docs and covered by the fake in `tests/support/harness.js`, but this code has not
yet been exercised against the real sub-account. Confirm it with one manual hold
before turning the flow on for customers.
