-- ============================================================================
-- One trip, many accounts.
--
-- Until now every policy read "this row belongs to a trip whose user_id is
-- me", and `trips_user_id_unique` enforced one trip per account. That model
-- has exactly one seat: a second account can't see the trip, concludes none
-- exists, tries to create one, and collides with the global primary key —
--
--   409  duplicate key value violates unique constraint "trips_pkey"
--
-- This migration replaces ownership with membership. `trips.user_id` stops
-- meaning "the only person who can see this" and becomes just "who created
-- it"; `trip_collaborators` decides access.
--
-- Deliberately NOT included: roles. Everyone who's in is an editor. Adding a
-- role column later is additive; adding it now doubles the policy surface for
-- a household.
--
-- NAMING: `trip_collaborators`, not `trip_members`. `TripMember` already
-- exists in src/data/schema.ts and means a travel companion for expense
-- splitting (Phase 5, "Paid by") with no account behind it. Conflating them
-- would make deleting a budget companion revoke someone's sign-in.
-- ============================================================================

create table if not exists public.trip_collaborators (
  trip_id text not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

-- Backfill every existing trip's creator as a collaborator. This must land
-- before the policies below start relying on membership, or the current owner
-- loses access to their own trip. Same migration, same transaction — but keep
-- these statements in this order if this file is ever split.
insert into public.trip_collaborators (trip_id, user_id)
select id, user_id from public.trips
on conflict do nothing;

-- One trip per account no longer holds: several accounts share one trip, and
-- the creator's row is the only one carrying a user_id at all.
drop index if exists public.trips_user_id_unique;

-- ---------------------------------------------------------------------------
-- Membership test.
--
-- `security definer` is load-bearing: a policy on `trips` that queries
-- `trip_collaborators`, whose own policy queries `trips`, recurses forever.
-- Running the lookup as the definer bypasses RLS inside the function and
-- breaks that cycle. `set search_path` keeps it from being hijacked by a
-- caller-controlled path.
-- ---------------------------------------------------------------------------
create or replace function public.is_trip_member(p_trip_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.trip_collaborators
    where trip_id = p_trip_id and user_id = auth.uid()
  );
$$;

revoke all on function public.is_trip_member(text) from public;
grant execute on function public.is_trip_member(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Policies: ownership -> membership. Both USING and WITH CHECK on every one,
-- so a row still can't be reassigned into a trip the caller isn't part of.
-- ---------------------------------------------------------------------------
alter table public.trip_collaborators enable row level security;

drop policy if exists "own trip" on public.trips;
drop policy if exists "own trip days" on public.days;
drop policy if exists "own trip places" on public.places;
drop policy if exists "own trip itinerary" on public.itinerary;
drop policy if exists "own trip expenses" on public.expenses;

create policy "member trip" on public.trips
  for all using (public.is_trip_member(id)) with check (public.is_trip_member(id));

create policy "member trip days" on public.days
  for all using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

create policy "member trip places" on public.places
  for all using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

-- itinerary has no trip_id — it reaches the trip through days.
create policy "member trip itinerary" on public.itinerary
  for all using (
    exists (select 1 from public.days d where d.id = day_id and public.is_trip_member(d.trip_id))
  )
  with check (
    exists (select 1 from public.days d where d.id = day_id and public.is_trip_member(d.trip_id))
  );

create policy "member trip expenses" on public.expenses
  for all using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

-- Members can see who else is on the trip. Deliberately read-only from the
-- client: collaborators are added from the dashboard, so there is no path
-- for a signed-in user to grant themselves access.
drop policy if exists "read own collaborations" on public.trip_collaborators;
create policy "read own collaborations" on public.trip_collaborators
  for select using (user_id = auth.uid() or public.is_trip_member(trip_id));

-- ---------------------------------------------------------------------------
-- import_trip_snapshot: preserve the trip's creator.
--
-- The original inserted `auth.uid()` as user_id, so a member importing a JSON
-- backup silently took ownership. With membership that no longer controls
-- access, but it still rewrites a field that should be stable — and it would
-- quietly matter again the moment anything keys off the creator.
--
-- Everything else is unchanged from 0001/0004.
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
