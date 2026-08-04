-- The CRM catalog map: which HighLevel product and price back each thing we sell.
--
-- Migration 002 introduced `membership_price_map`, which is membership-shaped
-- (monthly_cents, credits_per_cycle, both NOT NULL). Services, add-ons and
-- deposits are one-time and have neither, so they get their own table rather than
-- forcing null-able columns onto a table whose constraints are currently doing
-- useful work. Memberships keep theirs; this one covers everything sellable,
-- including memberships, so a payment link has a single place to look.
--
-- Versioned for the same reason as the membership map: a price change must create
-- a new CRM price and leave the old rows pointing at what was already sold.

create table if not exists crm_price_map (
  id                  uuid primary key,
  catalog_version     integer not null,
  -- service | addon | deposit | membership
  kind                text not null check (kind in ('service', 'addon', 'deposit', 'membership')),
  -- The catalog identifier this price is for. `package_id` + `size_id` for a
  -- service or membership, `addon_id` for an extra, neither for a deposit.
  product_key         text not null,
  price_key           text not null,
  package_id          text,
  size_id             text,
  addon_id            text,
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null default 'usd',
  price_type          text not null check (price_type in ('one_time', 'recurring')),
  crm_product_id      text not null,
  crm_price_id        text not null,
  livemode            boolean not null,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint crm_price_map_unique unique (catalog_version, kind, price_key, livemode)
);

create index if not exists crm_price_map_lookup_idx
  on crm_price_map (kind, package_id, size_id, livemode, active);
create index if not exists crm_price_map_addon_idx
  on crm_price_map (kind, addon_id, livemode, active);
create unique index if not exists crm_price_map_price_idx
  on crm_price_map (crm_price_id, livemode);

-- Payment links issued from the catalog, so the same request cannot mint two
-- invoices and the office can see what was sent and to whom.
--
-- `idempotency_key` is derived from what the link is FOR (a hold, a contract, an
-- ad-hoc quote), never from when it was created: two clicks on "send payment link"
-- produce one link, and a retry after a timeout returns the first one.
create table if not exists payment_links (
  id                  uuid primary key,
  idempotency_key     text not null,
  -- booking_deposit | service | membership | manual
  purpose             text not null
                        check (purpose in ('booking_deposit', 'service', 'membership', 'manual')),
  -- web | office. Recorded so a sales report can tell a self-service checkout from
  -- a link an operator sent by hand.
  origin              text not null check (origin in ('web', 'office')),
  hold_id             uuid references booking_holds (id),
  parent_booking_id   uuid references bookings (id),
  contract_id         uuid references membership_contracts (id),
  contact_id          text,
  -- The priced line items, resolved server-side from catalog ids.
  lines               jsonb not null,
  amount_cents        integer not null check (amount_cents >= 0),
  currency            text not null default 'usd',
  crm_invoice_id      text,
  url                 text,
  status              text not null default 'pending'
                        check (status in ('pending', 'issued', 'paid', 'void', 'failed')),
  failure_reason      text,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  paid_at             timestamptz,
  constraint payment_links_idempotency_unique unique (idempotency_key)
);

create index if not exists payment_links_hold_idx on payment_links (hold_id);
create index if not exists payment_links_status_idx on payment_links (status, created_at);
create index if not exists payment_links_invoice_idx on payment_links (crm_invoice_id);
