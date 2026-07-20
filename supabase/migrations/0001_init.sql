-- Trip planner remote schema: mirrors src/data/schema.ts's TripSnapshot shape.
-- Single trip per account (trips_user_id_unique) — matches the app's
-- hardcoded ACTIVE_TRIP_ID, single-trip architecture (see tripRepository.ts).

create table public.trips (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  home_currency text not null,
  trip_currency text not null,
  rates jsonb not null default '{}'::jsonb,
  rates_updated_at timestamptz,
  rates_base text,
  cities jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create unique index trips_user_id_unique on public.trips(user_id);

create table public.days (
  id text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  date date not null,
  city text not null,
  parent_city text
);
create index days_trip_id_idx on public.days(trip_id);

create table public.places (
  id text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  name text not null,
  note text,
  category text,
  lat double precision not null,
  lng double precision not null,
  city text not null,
  status text not null check (status in ('wishlist', 'planned')),
  day_id text references public.days(id) on delete set null,
  source_url text,
  address text
);
create index places_trip_id_idx on public.places(trip_id);

create table public.itinerary (
  id text primary key,
  day_id text not null references public.days(id) on delete cascade,
  place_id text references public.places(id) on delete set null,
  title text not null,
  start_time text,
  duration_min integer,
  note text,
  "order" integer not null
);
create index itinerary_day_id_idx on public.itinerary(day_id);

create table public.expenses (
  id text primary key,
  trip_id text not null references public.trips(id) on delete cascade,
  day_id text references public.days(id) on delete set null,
  item_id text references public.itinerary(id) on delete set null,
  category text not null,
  label text not null,
  amount double precision not null,
  currency text not null,
  paid boolean not null default false
);
create index expenses_trip_id_idx on public.expenses(trip_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — every table scoped to the owning trip's user_id.
-- `days`/`places`/`expenses` join back to trips.user_id via trip_id;
-- `itinerary` has no trip_id column, so it joins through days -> trips.
-- Both USING and WITH CHECK are required so a row can't be reassigned
-- (e.g. day_id changed) to point at another user's data.
-- ---------------------------------------------------------------------------

alter table public.trips enable row level security;
alter table public.days enable row level security;
alter table public.places enable row level security;
alter table public.itinerary enable row level security;
alter table public.expenses enable row level security;

create policy "own trip" on public.trips
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own trip days" on public.days
  for all using (
    exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid())
  );

create policy "own trip places" on public.places
  for all using (
    exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid())
  );

create policy "own trip itinerary" on public.itinerary
  for all using (
    exists (
      select 1 from public.days d join public.trips t on t.id = d.trip_id
      where d.id = day_id and t.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.days d join public.trips t on t.id = d.trip_id
      where d.id = day_id and t.user_id = auth.uid()
    )
  );

create policy "own trip expenses" on public.expenses
  for all using (
    exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.trips t where t.id = trip_id and t.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- import_trip_snapshot: atomic whole-trip replace, mirroring
-- DexieTripRepository.importSnapshot's clear-then-bulk-put semantics.
-- PostgREST has no cross-statement client transaction, and plain sequential
-- upserts wouldn't delete rows that were removed from the snapshot (e.g. a
-- deleted place) -- this function runs as one implicit transaction and does
-- a full delete-then-insert per table, scoped to the trip and caller's uid.
-- ---------------------------------------------------------------------------

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
    id, trip_id, name, note, category, lat, lng, city, status, day_id, source_url, address
  )
  select
    p->>'id', v_trip_id, p->>'name', p->>'note', p->>'category',
    (p->>'lat')::double precision, (p->>'lng')::double precision,
    p->>'city', p->>'status', p->>'dayId', p->>'sourceUrl', p->>'address'
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
