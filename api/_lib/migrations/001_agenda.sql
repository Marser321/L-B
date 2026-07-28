-- Transactional agenda for the L&B quote flow.
--
-- Postgres is the ONLY source of truth for what van is busy when. HighLevel is a
-- downstream mirror the office looks at (and can book into by hand), never the
-- authority; nothing about a reservation lives in memory, in a cookie, or in
-- localStorage.
--
-- The guarantee this schema enforces, with the database rather than with
-- application code: one van cannot hold two overlapping jobs. That is the
-- `no_overlapping_assignments` exclusion constraint at the bottom. Even if two
-- requests raced past every check in agenda.js, Postgres would reject the second
-- one.

create extension if not exists btree_gist;

-- The fleet. One row per van, in rotation order. The HighLevel calendar id is NOT
-- stored here: it comes from GHL_CALENDAR_CAMIONETA_<n> on every request, so
-- re-pointing a van at a different calendar is an env change, not a migration.
-- Each assignment snapshots the calendar id it actually wrote to, so a later env
-- change can never orphan an event we still need to delete.
create table if not exists resources (
  key         text primary key,
  position    integer not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into resources (key, position) values
  ('camioneta_1', 1),
  ('camioneta_2', 2),
  ('camioneta_3', 3),
  ('camioneta_4', 4)
on conflict (key) do nothing;

-- Persistent round-robin cursor. Read FOR UPDATE and advanced inside the very
-- same transaction that allocates the vans, so two concurrent holds cannot both
-- start their search at the same van.
create table if not exists resource_rotation (
  id                text primary key,
  cursor_position   integer not null,
  updated_at        timestamptz not null default now()
);

insert into resource_rotation (id, cursor_position) values ('vans', 0)
on conflict (id) do nothing;

-- A 15-minute claim on a set of vans, created before the customer pays.
-- `request_fingerprint` is what makes Idempotency-Key safe: replaying a key with
-- the same body returns the same hold, replaying it with a DIFFERENT body is a
-- 409 rather than a second hold on a second set of vans.
create table if not exists booking_holds (
  id                    uuid primary key,
  idempotency_key       text not null unique,
  request_fingerprint   text not null,
  status                text not null default 'active'
                          check (status in ('active', 'converted', 'confirmed', 'expired', 'released', 'failed')),
  slot_date             date not null,
  slot_start            timestamptz not null,
  slot_end              timestamptz not null,
  timezone              text not null,
  booking_mode          text not null check (booking_mode in ('slot', 'full_day')),
  vehicle_count         integer not null check (vehicle_count between 1 and 4),
  -- The server-computed quote: per-vehicle package, size, add-ons, duration and
  -- price. Whatever the browser posted is not in here.
  quote                 jsonb not null,
  deposit_cents         integer not null check (deposit_cents >= 0),
  expires_at            timestamptz not null,
  parent_booking_id     uuid,
  failure_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists booking_holds_sweep_idx on booking_holds (status, expires_at);
create index if not exists booking_holds_slot_idx on booking_holds (slot_date, status);

-- The parent reservation and its per-vehicle children. A four-vehicle booking is
-- one parent row (parent_booking_id null) plus four child rows, each with its own
-- vehicle_index. Duration is NEVER summed across the cart: every child carries
-- its own window, and the parent's slot_end is the latest child end.
create table if not exists bookings (
  id                    uuid primary key,
  parent_booking_id     uuid references bookings (id) on delete cascade,
  hold_id               uuid references booking_holds (id),
  idempotency_key       text unique,
  status                text not null
                          check (status in ('held', 'pending_payment', 'confirmed', 'cancelled', 'expired', 'failed')),
  submission_id         text,
  contact_id            text,
  opportunity_id        text,
  vehicle_index         integer,
  vehicle_label         text,
  package_id            text,
  slot_start            timestamptz not null,
  slot_end              timestamptz not null,
  timezone              text not null,
  vehicle_count         integer,
  deposit_cents         integer,
  estimate_min_cents    integer,
  estimate_max_cents    integer,
  customer              jsonb,
  quote                 jsonb,
  confirmed_at          timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- A parent has no vehicle_index; a child always has one, unique within its parent.
  constraint bookings_parent_shape check (
    (parent_booking_id is null and vehicle_index is null) or
    (parent_booking_id is not null and vehicle_index is not null)
  )
);

create unique index if not exists bookings_child_vehicle_idx
  on bookings (parent_booking_id, vehicle_index)
  where parent_booking_id is not null;
create index if not exists bookings_submission_idx on bookings (submission_id);
create index if not exists bookings_status_idx on bookings (status, slot_start);

-- One van assigned to one vehicle for one window, plus the external appointment
-- that blocks the van's HighLevel calendar. This is the table that reserves van
-- time; hold_allocations below is hold-lifecycle bookkeeping on top of it.
create table if not exists booking_assignments (
  id                      uuid primary key,
  booking_id              uuid not null unique references bookings (id) on delete cascade,
  parent_booking_id       uuid not null references bookings (id) on delete cascade,
  resource_key            text not null references resources (key),
  vehicle_index           integer not null,
  vehicle_label           text not null,
  package_id              text not null,
  duration_minutes        integer not null check (duration_minutes > 0),
  starts_at               timestamptz not null,
  ends_at                 timestamptz not null,
  calendar_id             text not null,
  external_event_id       text,
  external_calendar_id    text,
  status                  text not null
                            check (status in ('held', 'confirmed', 'released', 'failed')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint booking_assignments_window check (ends_at > starts_at),
  constraint booking_assignments_vehicle_unique unique (parent_booking_id, vehicle_index),
  -- Two vehicles of the same booking must land on DIFFERENT vans.
  constraint booking_assignments_resource_unique unique (parent_booking_id, resource_key)
);

create index if not exists booking_assignments_resource_idx
  on booking_assignments (resource_key, starts_at, ends_at)
  where status in ('held', 'confirmed');
create index if not exists booking_assignments_external_idx on booking_assignments (external_event_id);

-- THE guarantee: a van can hold at most one live job per instant. Application
-- code checks this first and returns a clean 409; this constraint is what makes
-- the check impossible to lose to a race, a bug, or a manual SQL insert.
alter table booking_assignments drop constraint if exists no_overlapping_assignments;
alter table booking_assignments add constraint no_overlapping_assignments
  exclude using gist (
    resource_key with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('held', 'confirmed'));

-- Per-van rows of a hold, 1:1 with the assignments above. Kept as its own table
-- because a hold's lifecycle (15 minutes, then expired or converted) is not the
-- assignment's lifecycle (released or confirmed), and the compensation path needs
-- to know which external events a *hold* created.
create table if not exists hold_allocations (
  id                      uuid primary key,
  hold_id                 uuid not null references booking_holds (id) on delete cascade,
  assignment_id           uuid references booking_assignments (id) on delete set null,
  resource_key            text not null references resources (key),
  vehicle_index           integer not null,
  calendar_id             text not null,
  starts_at               timestamptz not null,
  ends_at                 timestamptz not null,
  external_event_id       text,
  status                  text not null default 'pending'
                            check (status in ('pending', 'active', 'released', 'failed')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint hold_allocations_vehicle_unique unique (hold_id, vehicle_index),
  constraint hold_allocations_resource_unique unique (hold_id, resource_key)
);

create index if not exists hold_allocations_hold_idx on hold_allocations (hold_id, status);

-- Verified payment events. A booking is confirmed by a row landing here and
-- nothing else. `unique (provider, external_event_id)` makes a webhook that
-- fires three times confirm exactly once.
create table if not exists payment_events (
  id                    uuid primary key,
  provider              text not null,
  external_event_id     text not null,
  event_type            text not null,
  outcome               text not null check (outcome in ('paid', 'failed', 'refunded')),
  hold_id               uuid references booking_holds (id),
  parent_booking_id     uuid references bookings (id),
  submission_id         text,
  amount_cents          integer,
  currency              text,
  payload               jsonb,
  processed_at          timestamptz,
  created_at            timestamptz not null default now(),
  constraint payment_events_external_unique unique (provider, external_event_id)
);

create index if not exists payment_events_booking_idx on payment_events (parent_booking_id);

-- Membership credits, append-only. `idempotency_key` is derived from the booking
-- and the reason, so replaying a confirmation (or a webhook) can never grant the
-- same wash twice, and a refund posts one compensating row rather than editing
-- history.
create table if not exists membership_credit_ledger (
  id                    uuid primary key,
  contact_id            text not null,
  parent_booking_id     uuid references bookings (id),
  package_id            text not null,
  delta                 integer not null,
  reason                text not null,
  idempotency_key       text not null unique,
  created_at            timestamptz not null default now()
);

create index if not exists membership_credit_contact_idx on membership_credit_ledger (contact_id, created_at);
