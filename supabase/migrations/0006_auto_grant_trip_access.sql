-- ============================================================================
-- Auto-enrol every new account onto the shared trip.
--
-- 0005 made access depend on a row in `trip_collaborators`, which left a
-- manual step behind every new device/account: the person signs in fine
-- (auth.users has them), sees "You're not on this trip yet", and someone has
-- to go run an INSERT by hand. This automates that.
--
-- SAFETY PRECONDITION — this migration is only safe with public sign-ups
-- DISABLED (Supabase dashboard -> Authentication -> Sign In / Providers ->
-- "Allow new users to sign up" = off). With it on, a row in auth.users can be
-- created by anyone who types an email into the sign-in form, and this trigger
-- would hand them edit access to the trip. With it off, the only way a row
-- lands in auth.users is you inviting someone from the dashboard, so "new
-- user" and "invited to the trip" mean the same thing — which is exactly what
-- makes a blanket grant correct here.
-- ============================================================================

-- The single shared trip. Mirrors ACTIVE_TRIP_ID in
-- src/data/tripRepository.ts:81 — the one place these two must agree.
-- Deliberately a literal rather than "the only row in trips": if a second trip
-- ever exists, a silent wrong guess is worse than a no-op.
create or replace function public.grant_shared_trip_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- `where exists` rather than a bare insert: trip_collaborators.trip_id is a
  -- FK, and this trigger runs inside the transaction that creates the user.
  -- A violation here would abort the *signup itself*, so a missing trip row
  -- (fresh project, trip not created yet) must degrade to a no-op, not to an
  -- account that can't be created at all.
  insert into public.trip_collaborators (trip_id, user_id)
  select 'trip-china-2026', new.id
  where exists (select 1 from public.trips where id = 'trip-china-2026')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_grant_trip on auth.users;
create trigger on_auth_user_created_grant_trip
  after insert on auth.users
  for each row execute function public.grant_shared_trip_access();

-- Backfill: accounts that already exist but never got a collaborator row —
-- i.e. everyone currently stuck on "You're not on this trip yet".
insert into public.trip_collaborators (trip_id, user_id)
select 'trip-china-2026', u.id
from auth.users u
where exists (select 1 from public.trips where id = 'trip-china-2026')
on conflict do nothing;
