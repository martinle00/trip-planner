-- Phase 11 (settle up): `Expense.isTransfer` -- a row that records a REPAYMENT
-- between two companions rather than a trip cost. Mirrors src/data/schema.ts
-- after the v5 -> v6 TripSnapshot migration.
--
-- Purely additive, and needs NO backfill: `default false` means every
-- pre-existing row is already correct as an ordinary expense. There is
-- deliberately no separate `settlements` table -- a transfer is shaped exactly
-- like any other expense (payer in `paid_by`, recipient as the single entry in
-- `covers_member_ids`, amount in the trip's home currency), which is what lets
-- it settle a debt through the ordinary balance arithmetic and ride every
-- existing path -- RLS policies, the outbox, replay ordering, export/import --
-- without a new entity anywhere.
--
-- `not null default false` rather than a nullable boolean: this column is read
-- as a filter on every cost total ("is this spending?"), and a three-valued
-- column would make each of those a `is not true` instead of a plain `not`.
-- The client still maps `false` back to `undefined` (see `expenseFromRow`) so a
-- round-trip doesn't start writing the field onto every ordinary expense.
--
-- Idempotent: `add column if not exists` + `create or replace function`. Safe
-- to re-run.
--
-- NOTE the corresponding client-side paths that must stay in lockstep:
--   - src/data/exportImport.ts's `migrateSnapshotV5ToV6` (JSON import path)
--   - src/data/db.ts needs NO Dexie version bump: `isTransfer` is not indexed,
--     and Dexie only declares indexed fields in `.stores()`. Unlike every
--     earlier expense field change, there is nothing to migrate locally --
--     absent reads as "ordinary expense" exactly as intended.

alter table public.expenses
  add column if not exists is_transfer boolean not null default false;

-- ---------------------------------------------------------------------------
-- create or replace redefines the ENTIRE function body, so this MUST be based
-- on the migration that most recently defined it -- which is 0005, NOT 0004.
--
-- This file originally rebuilt the body from 0004's version and would have
-- silently reverted the two things 0005 added: capturing `v_owner` so a member
-- importing a backup doesn't take ownership of the trip, and re-inserting the
-- `trip_collaborators` row that the trips-row delete cascaded away. Both are
-- invisible until someone imports a snapshot, at which point the importer owns
-- the trip and every other collaborator has silently lost access.
--
-- The body below is 0005's, verbatim, with ONE change: the expenses insert
-- also reads `isTransfer`. 0006 (an auth.users trigger) and 0007 (nullable
-- place lat/lng -- the existing cast already yields NULL for an absent key)
-- both leave this function alone, so 0005 is the correct base.
--
-- If you add another migration touching this function: diff your version
-- against the LAST file that defined it, not against 0001.
-- ---------------------------------------------------------------------------
create or replace function public.import_trip_snapshot(snapshot jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  v_trip_id text := snapshot->'trip'->>'id';
  v_owner uuid;
begin
  -- Captured before the delete below removes the row it lives on.
  select user_id into v_owner from public.trips where id = v_trip_id;
  if v_owner is null then
    v_owner := auth.uid();
  end if;

  delete from public.expenses where trip_id = v_trip_id;
  delete from public.itinerary where day_id in (select id from public.days where trip_id = v_trip_id);
  delete from public.places where trip_id = v_trip_id;
  delete from public.days where trip_id = v_trip_id;
  delete from public.trips where id = v_trip_id;

  insert into public.trips (
    id, user_id, name, start_date, end_date, home_currency, trip_currency,
    rates, rates_updated_at, rates_base, cities, members
  )
  select
    v_trip_id,
    v_owner,
    snapshot->'trip'->>'name',
    (snapshot->'trip'->>'startDate')::date,
    (snapshot->'trip'->>'endDate')::date,
    snapshot->'trip'->>'homeCurrency',
    snapshot->'trip'->>'tripCurrency',
    coalesce(snapshot->'trip'->'rates', '{}'::jsonb),
    nullif(snapshot->'trip'->>'ratesUpdatedAt', '')::timestamptz,
    snapshot->'trip'->>'ratesBase',
    coalesce(snapshot->'trip'->'cities', '[]'::jsonb),
    snapshot->'trip'->'members';

  -- A re-imported trip keeps its collaborators (the row above was deleted and
  -- re-inserted, and the FK cascade took them with it).
  insert into public.trip_collaborators (trip_id, user_id)
  values (v_trip_id, v_owner)
  on conflict do nothing;

  insert into public.days (id, trip_id, date, city, parent_city)
  select
    d->>'id', v_trip_id, (d->>'date')::date, d->>'city', d->>'parentCity'
  from jsonb_array_elements(coalesce(snapshot->'days', '[]'::jsonb)) as d;

  insert into public.places (
    id, trip_id, name, description, self_review, category, lat, lng, city,
    status, day_id, source_url, address, updated_at
  )
  select
    p->>'id', v_trip_id, p->>'name', p->>'description', p->>'selfReview', p->>'category',
    (p->>'lat')::double precision, (p->>'lng')::double precision,
    p->>'city', p->>'status', p->>'dayId', p->>'sourceUrl', p->>'address',
    coalesce(nullif(p->>'updatedAt', '')::timestamptz, now())
  from jsonb_array_elements(coalesce(snapshot->'places', '[]'::jsonb)) as p;

  insert into public.itinerary (id, day_id, place_id, title, start_time, duration_min, note, "order")
  select
    i->>'id', i->>'dayId', i->>'placeId', i->>'title', i->>'startTime',
    (i->>'durationMin')::integer, i->>'note', (i->>'order')::integer
  from jsonb_array_elements(coalesce(snapshot->'itinerary', '[]'::jsonb)) as i;

  -- `isTransfer` is absent on every pre-v6 snapshot and on ordinary expenses in
  -- a v6 one, so it is coalesced rather than cast directly: the column is `not
  -- null`, and `(e->>'isTransfer')::boolean` on a missing key yields null,
  -- which would fail the insert for every ordinary expense.
  insert into public.expenses (
    id, trip_id, category, label, amount, currency, paid, note, paid_by, city,
    covers_member_ids, is_transfer
  )
  select
    e->>'id', v_trip_id, e->>'category', e->>'label',
    (e->>'amount')::double precision, e->>'currency', (e->>'paid')::boolean,
    e->>'note', e->>'paidBy', e->>'city', e->'coversMemberIds',
    coalesce((e->>'isTransfer')::boolean, false)
  from jsonb_array_elements(coalesce(snapshot->'expenses', '[]'::jsonb)) as e;
end;
$$;
