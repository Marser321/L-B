-- Memberships and recurring billing.
--
-- Stripe moves the money; this database decides what is true. A subscription in
-- Stripe is a billing arrangement — it does not know what a "vehicle" is, that a
-- 2x plan is two washes a month, or that a wash booked but not delivered still
-- owes the customer a credit. All of that lives here.
--
-- The shape follows one rule from the business: **a contract is per vehicle.**
-- One checkout can carry several recurring lines for the same account holder, and
-- each of those lines becomes its own contract, with its own balance and its own
-- next visit. Two identical vehicles share a Stripe subscription item with
-- quantity 2 (Stripe rejects duplicate prices in one checkout), which is why the
-- contract key is (subscription_item_id, line_index) and not the item alone.

-- Versioned packageId + sizeId → Stripe price. Versioned because a price change
-- must not re-price a subscription that was already sold: the old row keeps
-- pointing at the old Stripe price, new checkouts read the current version.
create table if not exists membership_price_map (
  id                  uuid primary key,
  catalog_version     integer not null,
  package_id          text not null,
  size_id             text not null,
  monthly_cents       integer not null check (monthly_cents > 0),
  currency            text not null default 'usd',
  credits_per_cycle   integer not null check (credits_per_cycle > 0),
  stripe_product_id   text not null,
  stripe_price_id     text not null,
  lookup_key          text not null,
  livemode            boolean not null,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint membership_price_map_unique unique (catalog_version, package_id, size_id, livemode)
);

create index if not exists membership_price_map_lookup_idx
  on membership_price_map (package_id, size_id, livemode, active);
create unique index if not exists membership_price_map_price_idx
  on membership_price_map (stripe_price_id, livemode);

-- The account holder. One Stripe customer per person, reused across checkouts, so
-- a second membership lands on the same card and the same invoice history.
create table if not exists membership_customers (
  id                    uuid primary key,
  stripe_customer_id    text not null,
  livemode              boolean not null,
  contact_id            text,
  email                 text,
  phone                 text,
  name                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint membership_customers_stripe_unique unique (stripe_customer_id)
);

create index if not exists membership_customers_contact_idx on membership_customers (contact_id);
create index if not exists membership_customers_email_idx on membership_customers (lower(email));

-- What the browser asked for, priced by the server, stored before the customer is
-- sent to Stripe. The webhook rebuilds the vehicle→line mapping from this row
-- rather than from anything in the Stripe payload, which is what makes "each line
-- maps to a contract per vehicle" deterministic even for two identical vehicles.
create table if not exists membership_checkout_sessions (
  id                        uuid primary key,
  stripe_session_id         text not null,
  stripe_customer_id        text not null,
  customer_id               uuid references membership_customers (id),
  livemode                  boolean not null,
  catalog_version           integer not null,
  -- [{ vehicleIndex, packageId, sizeId, stripePriceId, monthlyCents, vehicle }]
  lines                     jsonb not null,
  total_monthly_cents       integer not null,
  status                    text not null default 'open'
                              check (status in ('open', 'completed', 'expired')),
  created_at                timestamptz not null default now(),
  completed_at              timestamptz,
  constraint membership_checkout_sessions_stripe_unique unique (stripe_session_id)
);

-- One vehicle, one contract, one balance, one next visit.
create table if not exists membership_contracts (
  id                            uuid primary key,
  customer_id                   uuid not null references membership_customers (id),
  checkout_session_id           uuid references membership_checkout_sessions (id),
  stripe_subscription_id        text,
  stripe_subscription_item_id   text,
  stripe_price_id               text not null,
  line_index                    integer not null,
  package_id                    text not null,
  size_id                       text not null,
  monthly_cents                 integer not null,
  credits_per_cycle             integer not null check (credits_per_cycle > 0),
  credits_remaining             integer not null default 0 check (credits_remaining >= 0),
  -- pending: sold, not yet paid. Only invoice.paid moves it to active.
  status                        text not null default 'pending'
                                  check (status in ('pending', 'active', 'past_due', 'canceled', 'incomplete')),
  cancel_at_period_end          boolean not null default false,
  current_period_start          timestamptz,
  current_period_end            timestamptz,
  -- Proof that a verified webhook — not a request — paid for the current cycle.
  -- A hold can only become a confirmed visit when this is set and still current.
  activated_by_event_id         text,
  paid_invoice_id               text,
  vehicle                       jsonb not null,
  vehicle_label                 text,
  ghl_opportunity_id            text,
  canceled_at                   timestamptz,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- Two identical vehicles share one subscription item; the line index separates them.
  constraint membership_contracts_line_unique unique (stripe_subscription_item_id, line_index)
);

create index if not exists membership_contracts_subscription_idx on membership_contracts (stripe_subscription_id);
create index if not exists membership_contracts_customer_idx on membership_contracts (customer_id, status);

-- A visit booked against a contract, tied to the agenda's booking rows.
create table if not exists membership_visits (
  id                    uuid primary key,
  contract_id           uuid not null references membership_contracts (id),
  hold_id               uuid references booking_holds (id),
  parent_booking_id     uuid references bookings (id),
  booking_id            uuid references bookings (id),
  cycle_start           timestamptz,
  cycle_end             timestamptz,
  scheduled_start       timestamptz not null,
  scheduled_end         timestamptz not null,
  status                text not null
                          check (status in ('held', 'confirmed', 'completed', 'cancelled', 'no_show')),
  -- Set once the credit is actually spent: on completion, on a late cancellation,
  -- or on a no-show. An early cancellation leaves it null and costs nothing.
  credit_consumed_at    timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint membership_visits_window check (scheduled_end > scheduled_start)
);

-- **Only one future visit per contract.** A membership is a standing arrangement,
-- not a way to reserve the whole month up front, so the database refuses a second
-- open visit rather than relying on the booking flow to remember.
create unique index if not exists membership_visits_one_open
  on membership_visits (contract_id)
  where status in ('held', 'confirmed');

create index if not exists membership_visits_contract_idx on membership_visits (contract_id, status);
create index if not exists membership_visits_booking_idx on membership_visits (parent_booking_id);

-- Credits are an append-only ledger, so a balance is always explainable: +2 when a
-- cycle is paid, -1 when a wash is delivered, -1 when it is cancelled too late or
-- missed. Migration 001 created this table for the deposit flow; memberships add
-- the contract and cycle it belongs to.
alter table membership_credit_ledger add column if not exists contract_id uuid references membership_contracts (id);
alter table membership_credit_ledger add column if not exists cycle_start timestamptz;
alter table membership_credit_ledger add column if not exists visit_id uuid references membership_visits (id);
alter table membership_credit_ledger alter column contact_id drop not null;

create index if not exists membership_credit_contract_idx on membership_credit_ledger (contract_id, created_at);

-- Every Stripe event we have seen. The primary key is Stripe's own event id, so a
-- redelivery — and Stripe redelivers generously — is a no-op rather than a second
-- membership, a second credit grant, or a second SMS.
create table if not exists stripe_events (
  id              text primary key,
  type            text not null,
  livemode        boolean,
  api_version     text,
  payload         jsonb,
  status          text not null default 'received'
                    check (status in ('received', 'processed', 'ignored', 'failed')),
  error           text,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);

create index if not exists stripe_events_type_idx on stripe_events (type, received_at);

-- Every outbound message, keyed by what it is about rather than by when it was
-- sent. `dedupe_key` is unique, so a Stripe redelivery, a HighLevel retry, or two
-- concurrent workers can never produce two SMS, two emails or two internal
-- notices for the same fact.
create table if not exists notification_deliveries (
  id              uuid primary key,
  dedupe_key      text not null,
  channel         text not null check (channel in ('sms', 'email', 'internal', 'webhook')),
  template        text not null,
  recipient       text,
  context         jsonb,
  status          text not null default 'pending'
                    check (status in ('pending', 'sent', 'failed', 'suppressed')),
  provider_ref    text,
  attempts        integer not null default 0,
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint notification_deliveries_dedupe_unique unique (dedupe_key)
);

create index if not exists notification_deliveries_status_idx on notification_deliveries (status, created_at);

-- What we have already pushed to HighLevel, and the hash of what we pushed. A
-- re-run with identical content skips the call; a re-run with changed content
-- updates in place. Either way there is exactly one contact, one membership
-- opportunity per vehicle, and one calendar event per confirmed parent booking.
create table if not exists highlevel_sync_state (
  id              uuid primary key,
  entity_type     text not null
                    check (entity_type in ('contact', 'membership_opportunity', 'contract_status', 'parent_booking_event')),
  local_key       text not null,
  external_id     text,
  payload_hash    text,
  synced_at       timestamptz not null default now(),
  constraint highlevel_sync_unique unique (entity_type, local_key)
);
