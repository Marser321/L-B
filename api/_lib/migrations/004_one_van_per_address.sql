-- One van per ADDRESS, not one van per vehicle.
--
-- The original agenda modelled a visit as N vans working at the same time, and
-- encoded that in two uniqueness constraints that forced the vehicles of a booking
-- onto different vans. The real operation is the opposite: one van drives to one
-- address and works through the vehicles in the driveway one after another. Three
-- cars is one van for three services plus one travel buffer, not three vans for
-- ninety minutes.
--
-- So both constraints have to go. What replaces them is nothing — the guarantee
-- that matters is already in place:
--
--   no_overlapping_assignments  exclude using gist (resource_key with =,
--                               tstzrange(starts_at, ends_at, '[)') with &&)
--
-- Because the ranges are half-open, back-to-back windows on one van are ADJACENT
-- rather than overlapping: 08:00–09:00 and 09:00–10:00 both insert cleanly, while a
-- genuine double-booking of the same van at the same instant is still refused by the
-- database itself. That constraint is untouched by this migration.
--
-- Safe to run against existing data. Dropping a constraint never rejects a row, and
-- every booking written under the old model (one vehicle per van) also satisfies the
-- new one — a booking whose vehicles happen to be on different vans stays valid, it
-- simply can no longer be REQUIRED.

alter table booking_assignments drop constraint if exists booking_assignments_resource_unique;
alter table hold_allocations drop constraint if exists hold_allocations_resource_unique;

-- Reading a van's day now means reading a chain of adjacent windows rather than one
-- window per booking, so the crew sheet and the availability union both scan by
-- (van, time). The existing indexes cover the time-range scans; this one makes
-- "everything van 2 does on Saturday, in order" a single ordered read.
create index if not exists booking_assignments_resource_window_idx
  on booking_assignments (resource_key, starts_at)
  where status in ('held', 'confirmed');
