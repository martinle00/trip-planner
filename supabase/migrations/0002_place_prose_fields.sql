-- Phase 4: Place.note -> description/selfReview, plus a required updatedAt
-- used for optimistic-concurrency conflict detection (two devices sharing
-- one account editing the same place). Mirrors src/data/schema.ts's Place
-- shape after the v2 -> v3 migration.
--
-- The identical per-place transform (fold `note` into `description`,
-- backfill `updatedAt`) is applied by TWO other code paths that must stay in
-- lockstep with this one:
--   - src/data/exportImport.ts's `migratePlaceV2ToV3` (JSON import path)
--   - src/data/db.ts's Dexie `version(3).upgrade()` (local IndexedDB path)
--
-- *** NOT YET APPLIED to the live Supabase project as of writing. Apply
-- *** manually (SQL editor or `supabase db push`) before shipping the Phase
-- *** 4 UI -- upsertPlace/updatePlaceIfUnchanged calls that reference the
-- *** new columns will fail (or a JSON import will silently drop the new
-- *** fields, see below) against the live schema until this runs.

alter table public.places
  add column if not exists description text,
  add column if not exists self_review text,
  add column if not exists updated_at timestamptz not null default now();

-- Fold any existing free-text `note` into `description` (note was always
-- pre-visit-ish free text; description now serves the same purpose).
update public.places set description = note where note is not null;

alter table public.places drop column if exists note;

-- create or replace redefines the ENTIRE function body -- Postgres has no
-- way to patch a single clause of it. Republished in full, with the place
-- insert's column list extended to `description`/`self_review`/
-- `updated_at` (dropping `note`). This is the single easiest thing to miss
-- in this migration: without it, a JSON import via `import_trip_snapshot`
-- would silently drop description/selfReview/updatedAt with no error at
-- all, since the old function body simply never referenced those jsonb
-- keys. `updated_at` falls back to `now()` for a snapshot place that
-- (defensively) doesn't carry one -- every v3 TripSnapshot should always
-- have it, but an import must not 23502 (not-null violation) on a
-- hand-edited or otherwise malformed one.
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
    rates, rates_updated_at, rates_base, cities
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
    coalesce(snapshot->'trip'->'cities', '[]'::jsonb);

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

  insert into public.expenses (id, trip_id, day_id, item_id, category, label, amount, currency, paid)
  select
    e->>'id', v_trip_id, e->>'dayId', e->>'itemId', e->>'category', e->>'label',
    (e->>'amount')::double precision, e->>'currency', (e->>'paid')::boolean
  from jsonb_array_elements(coalesce(snapshot->'expenses', '[]'::jsonb)) as e;
end;
$$;
