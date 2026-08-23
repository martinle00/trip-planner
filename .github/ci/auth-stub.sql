-- Minimal stand-in for the parts of Supabase's `auth` schema that this repo's
-- migrations reference. Used ONLY by the CI job that replays the whole
-- migration chain against a throwaway Postgres — never applied to anything
-- real, and deliberately not in `supabase/migrations/` so the CLI can't pick
-- it up as a migration.
--
-- Supabase provisions all of this via GoTrue. The migrations touch four
-- things: `auth.users` (FK target for trips.user_id and the 0006 trigger),
-- `auth.uid()` (every RLS policy), `auth.role()`, and the three built-in
-- roles that policies are granted to. Nothing else is stubbed, so if a future
-- migration reaches further into `auth` CI will fail loudly here rather than
-- silently diverging from production.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Mirrors Supabase's own definition: the `sub` claim of the request's JWT,
-- NULL when unauthenticated. CI never sets the claim, so it reads NULL —
-- which is what makes RLS policies parse without granting anything.
create or replace function auth.uid() returns uuid
  language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.role() returns text
  language sql stable
as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end
$$;
