-- A place may fall under several categories: `Place.categories` in
-- src/data/schema.ts (primary first). `category` stays, and the client keeps it
-- equal to `categories[0]`, so a build from before this migration — or a device
-- that hasn't updated — still reads a sensible single category.
--
-- Purely additive and nullable, no backfill: NULL means "only `category`",
-- which is exactly what every existing row is. Not indexed — nothing queries
-- by category server-side.
--
-- ⚠️ Until this is applied, EVERY place save fails: supabase-js sends the
-- `categories` key on every upsert, and PostgREST rejects an unknown column.
-- That is a hard error, not something the outbox queues.
--
-- Idempotent: `add column if not exists` + `create or replace function`.
--
-- NOTE lockstep paths on the client:
--   - src/data/supabaseTripRepository.ts `placeFromRow`/`placeToRow`
--   - src/data/db.ts needs NO Dexie version bump (`categories` isn't indexed)
--   - export/import needs NO snapshot version bump: the field is optional and
--     `placeCategories` reads an older place's `category` in its place.

alter table public.places
  add column if not exists categories text[];

-- ---------------------------------------------------------------------------
-- create or replace redefines the ENTIRE function body, so this is based on
-- the migration that most recently defined it — 0008 — verbatim, with ONE
-- change: the places insert also reads `categories`.
--
-- If you add another migration touching this function: diff your version
-- against the LAST file that defined it (this one), not against 0001.
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

  -- `categories` is absent on every snapshot exported before 0009 (and on a
  -- place never re-saved since), so it maps to NULL rather than `{}`: the
  -- client reads NULL as "fall back to `category`".
  insert into public.places (
    id, trip_id, name, description, self_review, category, categories, lat, lng, city,
    status, day_id, source_url, address, updated_at
  )
  select
    p->>'id', v_trip_id, p->>'name', p->>'description', p->>'selfReview', p->>'category',
    case when jsonb_typeof(p->'categories') = 'array'
      then array(select jsonb_array_elements_text(p->'categories'))
    end,
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
