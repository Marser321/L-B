# The agenda

How the website reserves crews, and why it is built this way.

Companion docs: `DISENO-SIN-BASE-DE-DATOS.md`, which is the design this implements, and
`MEMBERSHIPS.md`, for recurring billing. A membership visit uses everything below — the
same holds, the same four vans, the same rotation — but is authorised by a paid cycle on
the contract instead of a one-off deposit, and spends a credit when the wash is
delivered rather than paying per visit.

## The one idea about the operation

**A visit is ONE van at ONE address, working through the vehicles in the driveway one
after another.** The crew drives to the customer once; it does not send a separate van
per car. Every scheduling decision follows from that:

- Durations **add up**. Three sedans are 60 + 60 + 60 of service plus one travel
  buffer — a **3h30** visit, not a 1h30 one.
- The travel buffer is charged **once, at the end**. There is no drive between two cars
  parked in the same driveway. A mixed cart takes the largest buffer of the categories
  in it.
- A slot is offered only when **one van is free for the whole visit**, start to finish.
  A van free for the first two cars but busy for the third is not usable: the crew
  cannot hand the driveway to a different van halfway through.
- A booking is **one appointment for the whole visit**. The per-vehicle running order is
  derived from the visit's start plus each vehicle's offset.
- The fleet size caps how many **separate customers** can be served at the same hour.
  Four vans means **four driveways at once**, not four vehicles.
- One booking is capped at **four vehicles** (4×60 + 30 = 4h30), or **two** when the
  cart holds marine work, since each boat or jet ski is two hours of service. Over the
  cap is HTTP **422**.

## The one idea about the storage

**The reservation IS an appointment on the van's calendar, and `appointmentStatus` is
its whole state machine.**

```
new        reserved, waiting for payment   (what used to be a 15-minute hold row)
confirmed  paid
cancelled  released
showed     delivered        ← the crew panel writes this, and it spends a credit
noshow     nobody was there ← spends the credit too: the van drove out
```

There is no database. Everything the agenda needs to decide is readable from the four
calendars in one call each:

| Question | Where the answer is |
|---|---|
| What is this van busy with? | the appointments in the window |
| Is that block one of ours, and has it lapsed? | `key:` and `expira:` in the description |
| Was this exact request already held? | its `Idempotency-Key`, in the description |
| Who is this reservation for, and what did we quote? | `sub:`, `opp:`, `veh:`, `total:` |
| Was this payment already applied? | the appointment's own status |

The appointment's description is a `·`-separated list of `key: value` pairs, built and
parsed in one place (`buildDescription` / `parseHoldFields` in `api/_lib/agenda.js`). It
is a real contract: the **crew panel** reads `orden:`, `total:` and `deposito:` off the
same string to tell a crew what to do and what to collect. A `·` may therefore never
appear inside a value — that mistake once truncated a two-car stop to one car.

An appointment the **office typed in by hand** is also `new` and has none of those
fields, which is exactly what makes it untouchable: only a block with `key:` and
`expira:` is ever deleted as a lapsed hold.

## The flow

```
POST /api/availability     → start times where one van is free for the whole visit
POST /api/bookings/holds   → 15-minute claim on ONE van, as a `new` appointment
POST /api/quote            → customer + CRM records attached; status pending_payment
POST /api/payments/webhook → verified payment ⇒ confirmed          (the only door)
GET  /api/bookings/expire  → daily cron: deletes appointments whose hold lapsed
```

A booking is **never** confirmed by filling in the form. It is confirmed when a verified
payment arrives, and by nothing else. Expiry, a failed payment, or an abandoned checkout
all release the van.

## Concurrency

**HighLevel arbitrates it.** Creating an appointment over a window that is already taken
is refused with `400 "The slot you have selected is no longer available."`, and of four
identical concurrent requests exactly one wins. Verified against the live sub-account on
2026-08-04, three runs, a different winner each time. The probes in
`scripts/probe-ghl-slot-*.mjs` re-check that in ten seconds if it ever changes.

So the race for the last van is settled by the system that owns the calendar, and there
is no window in which a reservation half-exists: if the create failed, nothing was
written, and there is nothing to compensate.

Losing that race is **not** the end of the request. The van is marked refused for this
attempt and the next free one is tried, up to once per van — a customer is never sent
away from three empty vans because one was taken between our read and our write.

What this costs, honestly: the **formal** atomicity guarantee. HighLevel's behaviour is
server-side validation, not a documented transactional contract. That is the trade the
owner accepted to run without a database, and it is written down here so nobody has to
rediscover it.

## Expiry is lazy

The Hobby plan allows **one cron a day**, and a 15-minute hold cannot wait for it. So
expiry is not a sweep at all:

- **Availability** treats a `new` appointment past its own `expira` as free.
- **Booking** deletes it when it is in the way, and retries the same van once.
- The **daily cron** deletes the rest. It is tidy-up — a calendar the office can read —
  never the mechanism. A slot is free the millisecond the hold lapses, sweep or no
  sweep.

## Rotation

There is no cursor to store. The starting van is **derived**: how many visits are
already on the day's calendars, modulo the fleet size. Consecutive bookings therefore
spread across the fleet exactly as the persisted counter made them, and a retried create
counts the same appointments and picks the same van — so a retry is the same attempt,
not a second reservation somewhere else.

Availability reads the cursor as 0, because the cursor only decides WHICH free van gets
used, never WHETHER one is free.

## Idempotency

| Thing | How it is idempotent |
|---|---|
| A hold | its `Idempotency-Key` is written into the appointment; a retry finds it in that day's listing and replays it |
| A payment | the appointment's status. A webhook that fires five times confirms once |
| A deposit link | the invoice name is deterministic (`Booking Deposit — hold:<id>`); an invoice under it IS the earlier attempt |

Known limit, and it is deliberate: reusing one key for a **different day** creates a
second hold rather than answering 409, because the lookup is scoped to the day it is
already reading. The fingerprint covers the date, so a genuine retry always looks in the
right place.

## What the browser is not trusted for

Price, duration, deposit, membership status, calendar id, and timezone. The browser sends
catalog **ids**; the server looks up every value that follows from them:

- prices come from `api/_lib/catalog-prices.json`, generated from the same
  `SERVICES_DATA` in `script.js` that the frontend renders
  (`node scripts/extract-catalog.mjs`; `--check` fails when it is stale);
- durations, deposits and membership flags come from `api/_lib/catalog.js`;
- calendar ids come from `GHL_CALENDAR_CAMIONETA_1..4`;
- every timestamp is computed in `BOOKING_TIMEZONE`, the location's zone, and sent to
  the browser as an absolute instant for rendering only.

`api/_lib/selection.js` is the single choke point that does this, which is what makes it
true by construction rather than by discipline.

## Notice periods

48 hours applies to **memberships only**. Every other service keeps the one-hour notice
it has always had. A cart mixing both takes the stricter of the two, since all its
vehicles share one start time.

## Deploying

```bash
node scripts/setup-ghl.mjs                 # verifies pipeline, fields, van calendars
```

No migration, no database, no `npm install` for the API — there are no runtime
dependencies left. Required environment (see `.env.example` for the full list):

| Variable | Why |
|---|---|
| `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID`, `GHL_ASSIGNED_USER_ID` | the CRM is the store |
| `GHL_CALENDAR_CAMIONETA_1..4` | one calendar per van; all four required |
| `PAYMENT_WEBHOOK_SECRET` | authenticates `/api/payments/webhook` — the only path to a confirmed booking |
| `CRON_SECRET` | authenticates the daily tidy-up (`vercel.json` cron) |
| `BOOKING_TIMEZONE` | the location's zone; defaults to `America/New_York` |
| `PUBLIC_APP_URL` | signs the member and crew links; must be the deployment's own origin |

## Tests

```bash
npm test
```

`tests/agenda.test.js` proves the algorithm against a fake HighLevel
(`tests/support/harness.js`) that models the parts that decide behaviour: the slot
validation that refuses an overlap, the 422 when an appointment on a van's personal
calendar names anyone but its own member, the 400 on block slots, and a listing that
returns the appointments the code under test created — because the agenda now reads its
own writes back for every decision it makes.
