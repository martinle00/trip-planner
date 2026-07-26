-- Phase 5: richer expenses -- Expense.note, Expense.paidBy, and a Trip.members
-- list of travel companions. Mirrors src/data/schema.ts's shape after the
-- v3 -> v4 TripSnapshot migration. All three additions are optional/additive
-- (see schema.ts's TripSnapshot doc comment) -- this migration is a pure
-- "add nullable column" no-op for existing rows, no backfill/transform
-- needed (unlike 0002's note -> description fold).
--
-- The identical shape is produced by TWO other code paths that must stay in
-- lockstep with this one:
--   - src/data/exportImport.ts's `migrateSnapshotV3ToV4` (JSON import path)
--   - src/data/supabaseTripRepository.ts's row <-> domain mappers
--     (tripFromRow/tripToRow, expenseFromRow/expenseToRow)
--
-- `trip_members` is deliberately NOT a separate table: Trip.members is an
-- embedded array on the Trip domain type (like `cities`/`rates`), so it's
-- stored the exact same way -- a JSONB column on `trips`. `expenses.paid_by`
-- is therefore a plain nullable text column (the member id), not a foreign
-- key into a members table -- member deletion is deliberately orphan-
-- tolerant (see schema.ts's `Expense.paidBy` doc comment): removing a member
-- must not cascade-delete or fail to delete because of a still-referencing
-- expense, so there is intentionally no FK constraint to enforce here.
--
-- *** NOT YET APPLIED to the live Supabase project as of writing (same
-- *** caveat as 0002). Apply manually (SQL editor or `supabase db push`)
-- *** before shipping the Phase 5 UI.

alter table public.expenses
  add column if not exists note text,
  add column if not exists paid_by text;

alter table public.trips
  add column if not exists members jsonb;

-- create or replace redefines the ENTIRE function body -- see 0002's note on
-- why this is easy to miss. Extends the trips insert's column list with
-- `members`, and the expenses insert's column list with `note`/`paid_by`.
-- Without this, a JSON import via `import_trip_snapshot` would silently
-- drop members/note/paidBy with no error at all -- the old function body
-- simply never referenced those jsonb keys.
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
    id, trip_id, day_id, item_id, category, label, amount, currency, paid, note, paid_by
  )
  select
    e->>'id', v_trip_id, e->>'dayId', e->>'itemId', e->>'category', e->>'label',
    (e->>'amount')::double precision, e->>'currency', (e->>'paid')::boolean,
    e->>'note', e->>'paidBy'
  from jsonb_array_elements(coalesce(snapshot->'expenses', '[]'::jsonb)) as e;
end;
$$;
