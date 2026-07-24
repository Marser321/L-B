# Phase B — Online Deposit Collection: Decisions & Open Items

Status: implemented behind `GHL_DEPOSIT_PAYMENTS`, off by default, not deployed.
Companion doc: `HIGHLEVEL-WORKFLOW.md` (§ "Fase B — cobro online del depósito").

## 1. Chosen model: CONFIRM-THEN-PAY

The appointment is confirmed exactly like Phase A — same validation, same
crew-availability check, same "confirmed" pipeline stage — **before** any
payment API call happens. Only after the booking has fully succeeded does the
site attempt to create a deposit payment link. This preserves the guarantee
that already exists today: a customer who completes the booking form gets a
real, confirmed appointment, full stop.

Flow:
1. `createBookingInHighLevel` runs exactly as in Phase A (contact → opportunity
   → crew assignment → appointment → confirmed-stage opportunity update).
2. `notifyBookingWebhook` fires as before.
3. Only if `GHL_DEPOSIT_PAYMENTS=on` **and** this is not a duplicate/retry:
   `createDepositPayment` calls HighLevel's invoices `text2pay` endpoint to
   create a deposit invoice tied to the contact and get back a hosted payment
   URL (`invoiceUrl`).
4. If that succeeds, `recordDepositPayment` re-sends the opportunity's full
   custom-field set (same shape as the Phase A confirm-update) with
   `Website Quote - Deposit Status = unpaid` and
   `Website Quote - Deposit Link = <url>` added in.
5. The success response includes `depositUrl` only when step 3 produced one.
   `script.js` renders a "Pay $X deposit" button on the success screen when
   present; otherwise the success screen is unchanged from Phase A.

Any failure in steps 3–4 is caught, logged (`[quote] deposit payment failed …`
/ `[quote] deposit field update failed …`), and swallowed — the booking
response is still `200` / `confirmed`. The deposit can always still be
invoiced by hand from the CRM, exactly as it is today; this feature is a
convenience layer on top of that, not a replacement for it.

Duplicates/retries of the same `submissionId` never attempt to create a
second deposit invoice (`!booking.duplicate` gate), so a flaky network retry
from the browser can't mint multiple Stripe invoices for one appointment.

## 2. Deferred alternative: PAY-FIRST (hold → pay → confirm via webhook)

Not implemented. Would mean: tentatively hold the slot, send the customer to
pay the deposit, and only create/confirm the appointment once a HighLevel
payment webhook (`InvoicePaid` — present in
`GoHighLevel/highlevel-api-docs/docs/webhook events/InvoicePaid.md`) confirms
the charge went through.

Deferred because it requires, at minimum:
- A slot-hold mechanism with an expiry (the site currently has no concept of
  a "tentative" hold — availability is computed live from the calendar on
  every request, and a hold would need its own storage/TTL and would have to
  be factored into `busyIntervalsByCrew`).
- A public webhook receiver endpoint (new attack surface, needs its own
  signature verification — this codebase's `api/` has no webhook receiver
  today, only outbound calls).
- Handling the abandoned-cart case: what happens to the held slot if the
  customer never pays? Needs a cleanup/expiry job.
- It also changes the core guarantee the site currently makes ("submit the
  form and your appointment is confirmed") to "submit and pay to confirm,"
  which is a product/business decision, not just an engineering one.

**This is explicitly an owner decision, not something this change makes for
you.** Confirm-then-pay was chosen as the default because it's the smallest
change that doesn't touch the existing confirmation guarantee; pay-first is a
larger, separate project if the owner decides an unpaid-but-confirmed
appointment is a problem worth solving differently.

## 3. GHL endpoint used, and confidence level

**Endpoint:** `POST https://services.leadconnectorhq.com/invoices/text2pay`
**Version header:** `Version: v3` (the only value the endpoint's schema
allows)
**Required scope:** `invoices.write`
**Request body (Text2PayDto):**
```json
{
  "altId": "<locationId>",
  "altType": "location",
  "name": "Booking Deposit — <submissionId>",
  "currency": "USD",
  "items": [{ "name": "Booking Deposit", "currency": "USD", "amount": 30, "qty": 1 }],
  "contactDetails": { "id": "<contactId>", "name": "...", "phoneNo": "+1...", "email": "..." },
  "issueDate": "YYYY-MM-DD",
  "sentTo": { "email": ["..."] },
  "liveMode": false,
  "action": "draft",
  "userId": "<assignedUserId>"
}
```
**Response (Text2PayInvoiceResponseDto):** `{ invoice: { _id, ... }, invoiceUrl }`
— `invoiceUrl` is the hosted payment page URL returned to the site.

**How this was verified:** HighLevel's marketplace docs pages
(`marketplace.gohighlevel.com/docs/ghl/invoices/...`) render client-side and
did not yield the request/response schema through automated fetches. Instead
I cloned HighLevel's own public OpenAPI source of truth,
[`GoHighLevel/highlevel-api-docs`](https://github.com/GoHighLevel/highlevel-api-docs)
(the repo those marketplace docs are generated from), and read
`apps/v3/invoices-v3.json` directly — the path, method, required `Version`
header, required scope, and both DTOs above are copied from that file's
`paths['/invoices/text2pay']` and `components.schemas.Text2PayDto` /
`Text2PayInvoiceResponseDto`.

**Alternatives evaluated and rejected:**
- **Payments/Orders/Transactions API** (`apps/v3/payments-v3.json`): only
  exposes `GET` on `/payments/orders`, `/payments/transactions`,
  `/payments/subscriptions`, plus `record-payment` (manually logging a
  payment that already happened elsewhere) and `custom-provider/*` (for
  building your own payment gateway integration). Nothing in this API creates
  a customer-facing hosted payment page. Ruled out.
- **A dedicated "Payment Links" API**: does not exist as a separate app in
  the public API surface (no `payment-links.json` or similar among the ~44
  app spec files in the repo). The in-app "Payment Links" feature
  (`help.gohighlevel.com/.../payment-links`) appears to be UI-only / not
  exposed via the public REST API. Ruled out.
- Plain `POST /invoices/` (`create-invoice`) + a separate `send-invoice` call:
  works, but is two calls instead of one and (per the schema) doesn't itself
  return a payment URL from creation — `text2pay` is the purpose-built
  single-call primitive for "create + get a payment link," so it was
  preferred.

**Confidence: medium-high on shape, unverified against the live API.**
Specifically uncertain, and **must be verified against the real sub-account
before this goes live**:
- Whether `invoiceUrl` is populated when `action: "draft"` (chosen to avoid
  GHL's own invoice email/SMS firing on top of the booking's own confirmation
  messages) — the schema marks `invoiceUrl` as always required in the
  response, but I could not confirm this behaviorally against a running
  location. If `draft` invoices don't get a URL, switch `action` to `"send"`
  (at the cost of GHL also emailing/texting the customer directly).
- Whether `items[].amount` is whole dollars (assumed, consistent with how
  `monetaryValue` is used elsewhere in this codebase, e.g.
  `Math.round(payload.estimate.min)`) or cents. Test with a small deposit
  amount (e.g. $1) in Stripe test mode and confirm the charged amount before
  enabling for real.
- Whether `sentTo.email: []` (no email on file for the customer) is accepted,
  or whether it needs at least one entry / a phone number instead. Some
  customers book with phone only.
- General plumbing: token scope in the sub-account's Private Integration
  actually includes `invoices.write` (not currently listed in
  `HIGHLEVEL-WORKFLOW.md`'s scope list — now added, but the live token needs
  the scope granted).

## 4. New environment variables

| Variable | Required? | Default behavior | Purpose |
|---|---|---|---|
| `GHL_DEPOSIT_PAYMENTS` | No | Off (any value other than the literal string `on`, including unset) | Master switch for the entire feature. Off = byte-for-byte Phase A behavior: no `/invoices/text2pay` call, no `depositUrl` in the response, no `Deposit Status`/`Deposit Link` custom-field values written, no UI change. |
| `GHL_DEPOSIT_LIVE_MODE` | No | Test mode (any value other than the literal string `true`, including unset) | Whether the deposit invoice is created in Stripe **live** mode or **test** mode. Defaults to test mode so turning `GHL_DEPOSIT_PAYMENTS` on can never move real money without a second, explicit opt-in. |

Both documented in `.env.example`.

## 5. New opportunity custom fields

- `Website Quote - Deposit Status` — set to `unpaid` when a deposit link is
  created. (Nothing currently flips it to `paid`; see open item below.)
- `Website Quote - Deposit Link` — the hosted payment URL.

Both are declared in `OPPORTUNITY_FIELDS` in `api/quote.js`, so
`scripts/setup-ghl.mjs` (which reads that same object) will create them
automatically on its next run — **no script changes were needed or made**.
They are treated as **optional** in `resolveMetadata` when
`GHL_DEPOSIT_PAYMENTS` is off, so a location that hasn't re-run the setup
script yet keeps booking normally; they become **required** (booking fails
with 503 `Website quote custom fields are not configured` rather than
silently skipping deposit tracking) the moment the flag is turned on, exactly
mirroring how every other Phase A custom field already behaves.

## 6. Setup steps required before this can go live

1. Confirm the GHL Private Integration Token's scopes include `invoices.write`
   (see updated list in `HIGHLEVEL-WORKFLOW.md`). Grant it if missing.
2. Re-run `node scripts/setup-ghl.mjs` against the target sub-account to
   create `Website Quote - Deposit Status` and `Website Quote - Deposit Link`
   (it will also re-verify the Phase A fields already exist). **Not run by
   this change** per the task's guardrails.
3. Manually create one test invoice via `text2pay` in Stripe **test** mode
   (`GHL_DEPOSIT_LIVE_MODE` unset) — book a test appointment on staging with
   `GHL_DEPOSIT_PAYMENTS=on`, click the "Pay $X deposit" button, and confirm:
   - the invoice amount matches the deposit shown on the site,
   - the Stripe checkout page actually opens and completes a test charge,
   - the opportunity's `Deposit Status` / `Deposit Link` fields populated
     correctly in HighLevel.
4. Only after that passes, set `GHL_DEPOSIT_LIVE_MODE=true` in the same
   environment where `GHL_DEPOSIT_PAYMENTS=on` is set, and repeat the test
   with a small real deposit before rolling out broadly.
5. Set both env vars in Vercel Production (per the existing deploy process —
   not done by this change; deploy remains blocked pending explicit approval
   per this task's guardrails).

## 7. Open items for the owner

1. **Confirm the endpoint choice.** I'm confident `text2pay` is the right
   HighLevel primitive (see § 3), but this was verified by reading HighLevel's
   own OpenAPI spec, not by calling the live API. Please have someone with
   sub-account access do the smoke test in § 6 step 3 before flipping the
   flag on in production.
2. **Confirm CONFIRM-THEN-PAY vs. PAY-FIRST.** Confirm-then-pay is
   implemented and is the default; pay-first (§ 2) is a larger, separate
   project. Decide whether an unpaid-but-confirmed appointment is acceptable
   business risk, or whether holding the slot until payment is worth the
   added complexity.
3. **No-show / non-payment policy.** Since the appointment is confirmed
   before payment, decide what happens if the customer never pays the
   deposit (nothing currently reminds them beyond the one-time button on the
   success screen — no follow-up SMS/email sequence, no automatic
   cancellation). This is a workflow/automation decision for HighLevel, not
   a code change.
4. **Marking a deposit as paid.** `Deposit Status` is only ever written as
   `unpaid` by this change. Nothing currently listens for HighLevel's
   `InvoicePaid` webhook to flip it to `paid`. If that status field is meant
   to be trustworthy (e.g. for a dispatcher dashboard or a workflow
   condition), a follow-up webhook receiver is needed — out of scope here.
5. **`action: "draft"` vs `"send"`** — see the uncertainty noted in § 3.
   Draft avoids double-notifying the customer (the site already shows the
   pay button) but its `invoiceUrl` behavior is unverified.
6. **Customers with no email.** `contactDetails.email` and `sentTo.email` are
   sent as empty when the customer didn't provide an email at booking time.
   Unverified whether HighLevel accepts that for `text2pay`; if it rejects
   it, those bookings will simply fail to get a deposit link (silently, by
   design — booking still confirms) until this is checked against the live
   API.
7. **Rate/cost of Stripe fees on deposits.** Not evaluated here — confirm the
   sub-account's Stripe processing fee settings for how they apply to a
   `text2pay` invoice versus however deposits are collected manually today.
