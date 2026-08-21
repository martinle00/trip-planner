-- ---------------------------------------------------------------------------
-- 0007 — a place may have no location yet.
--
-- `places.lat`/`lng` were `not null` because every place used to get a
-- coordinate one way or another: a search result, a tapped pin, or — when the
-- user supplied none — a city-centroid guess made at save time. That guess is
-- gone (see `Place.lat` in src/data/schema.ts): a chain with four branches in
-- one city is one place worth capturing early, and four identical fake pins in
-- the middle of the city is worse than no pin at all.
--
-- So the pair becomes nullable, and the client treats it as all-or-nothing
-- (`hasLocation`). No backfill or data change is needed — every existing row
-- has real coordinates and keeps them.
--
-- `import_trip_snapshot` needs no change: it already casts
-- `(p->>'lat')::double precision`, which yields NULL for an absent key.
-- ---------------------------------------------------------------------------

alter table public.places alter column lat drop not null;
alter table public.places alter column lng drop not null;

-- Both or neither — a place pinned in one axis only is meaningless, and this
-- keeps the server honest about the invariant the client already enforces.
alter table public.places
  drop constraint if exists places_location_complete;
alter table public.places
  add constraint places_location_complete
  check ((lat is null) = (lng is null));
