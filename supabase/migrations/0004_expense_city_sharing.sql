-- Phase 6: Expense.city (replaces the dropped Expense.dayId), the dropped
-- Expense.itemId, Expense.coversMemberIds, and Trip.members[].color. Mirrors
-- src/data/schema.ts's shape after the v4 -> v5 TripSnapshot migration.
--
-- `Expense.dayId` is DROPPED, not deprecated -- a deliberate non-additive
-- break decided by the user (see PHASE6.md's Decisions and trap #5's full
-- enumerated blast radius). `Expense.itemId` is dropped in the same sweep --
-- a dead field nothing in the app has ever read or written. `city` matches a
-- `City.name` (same convention as `Place.city`); absent/null means "whole
-- trip". `covers_member_ids` is a nullable jsonb array of member ids;
-- absent/null means "everyone" (see schema.ts's `Expense.coversMemberIds` doc
-- comment) -- so, unlike `city`, it needs no backfill at all: every existing
-- row is already valid with this column simply null.
--
-- `Trip.members[].color` needs NO column change here: `members` is already a
-- jsonb column (0003), and `color` is just a new optional key inside each
-- array element -- exactly how `Place.description`/`selfReview` etc. never
-- needed special-casing beyond the column that already held the parent
-- object.
--
-- The identical per-row transform (derive `city` from `day_id`) is applied by
-- TWO other code paths that must stay in lockstep with this one:
--   - src/data/exportImport.ts's `migrateExpenseV4ToV5` (JSON import path)
--   - src/data/db.ts's Dexie `version(5).upgrade()` (local IndexedDB path)

alter table public.expenses
  add column if not exists city text,
  add column if not exists covers_member_ids jsonb;

-- Backfill `city` from the referenced day's city before `day_id` is dropped.
-- A `day_id` that doesn't resolve to any (remaining) day -- shouldn't happen
-- given the `references public.days(id) on delete set null` FK, but
-- defensive regardless -- simply leaves `city` null ("whole trip"), never
-- fails the migration.
update public.expenses e
set city = d.city
from public.days d
where e.day_id = d.id and e.city is null;

alter table public.expenses
  drop column if exists day_id,
  drop column if exists item_id;

-- create or replace redefines the ENTIRE function body -- 0002's and 0003's
-- own header comments both flag this exact hazard. Every column 0001-0003
-- added is carried forward here (description/self_review/updated_at on
-- places; members on trips; note/paid_by on expenses), alongside this
-- migration's own change: the expenses insert now reads `city`/
-- `coversMemberIds` from the snapshot instead of `dayId`/`itemId`.
create or replace function public.import_trip_snapshot(snapshot jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  v_trip_id text := snapshot->'trip'->>'id';
begin
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
    auth.uid(),
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

  insert into public.expenses (
    id, trip_id, category, label, amount, currency, paid, note, paid_by, city, covers_member_ids
  )
  select
    e->>'id', v_trip_id, e->>'category', e->>'label',
    (e->>'amount')::double precision, e->>'currency', (e->>'paid')::boolean,
    e->>'note', e->>'paidBy', e->>'city', e->'coversMemberIds'
  from jsonb_array_elements(coalesce(snapshot->'expenses', '[]'::jsonb)) as e;
end;
$$;
