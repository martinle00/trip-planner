# Sharing the trip — design

**Status: not started.**

The model, decided 2026-07-27: **there is exactly one trip.** Everyone who
signs in is a member of it. Nobody creates trips, nobody has their own trip,
there is no trip picker. This is an internal tool for one household's trip.

That constraint removes most of what a general "multi-tenant trips app" would
need. Do not reintroduce per-user trips, per-user trip ids, or an
invite-creates-a-trip flow — an earlier draft of this document assumed them
and they were all unnecessary.

---

## The bug this has to fix

A second account signing in today gets, from `import_trip_snapshot`:

```
409  duplicate key value violates unique constraint "trips_pkey"
```

`ACTIVE_TRIP_ID` (`'trip-china-2026'`) is a hardcoded constant, and `trips.id`
is the primary key across the whole project — so the trip belongs to whoever
seeded first. A second account's `seedIfEmpty()` (or `bootstrapMigration`'s
push) tries to insert that same row and collides. And because
`import_trip_snapshot` is `security invoker`, its opening
`delete from trips where id = ...` is RLS-filtered to rows *that* account
owns, so it deletes nothing and can't clear the way for its own insert.

**The shared id is not the problem** — with one global trip it's correct.
The problem is that a second account tries to create a trip at all.

(The endless spinner this produced on the device is fixed separately:
`AuthGate` now surfaces a failed bootstrap instead of hanging on it.)

---

## What actually has to change

Smaller than it looks, because "one trip, many members" removes the
ownership questions.

### 1. Migration `0005_trip_members.sql`

```sql
create table public.trip_collaborators (
  trip_id text not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
```

Backfill the current owner. Drop `trips_user_id_unique` — with membership,
`trips.user_id` stops meaning "the only person who can see this" and becomes
just "who created it".

**Naming:** `trip_collaborators`, NOT `trip_members`. `TripMember` already
exists in `schema.ts` and means *a travel companion for expense splitting*
(Phase 5, "Paid by") with no account behind it. Conflating the two produces a
bug where deleting a budget companion revokes someone's sign-in access.

**Roles: skip them.** Everyone who's in, is in — editor for all. Adding
`role` later is additive; adding it now doubles the policy surface for a
household of three.

### 2. RLS — five policies rewritten

Each policy's `trips.user_id = auth.uid()` becomes a membership test, via a
`security definer` helper so the policies don't recurse (a policy on `trips`
that queries `trip_collaborators`, whose own policy queries `trips`, is an
infinite loop — the classic Supabase RLS footgun):

```sql
create or replace function public.is_trip_member(p_trip_id text)
returns boolean language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.trip_collaborators
    where trip_id = p_trip_id and user_id = auth.uid()
  );
$$;
```

`itinerary` still joins through `days → trips`, so its policy stays the
awkward one.

### 3. Client: stop creating trips

- **`SupabaseTripRepository.getTrip()`** — drop `.eq('user_id', this.userId)`.
  RLS already scopes what's visible, so a member simply gets the trip. This is
  *simpler* than today's code, not more complex.
- **`SupabaseTripRepository.seedIfEmpty()`** — make it a no-op. The trip
  exists; no client should ever create one again. Seeding remotely is the
  thing that 409s, and in this model it is never correct.
- **`bootstrapMigration`** — must not push local up either. For a non-owner it
  can only collide, and it's the exact path that failed on the phone. In this
  model there is nothing to migrate: the remote trip is authoritative from the
  start.
- **Empty state** — if `getTrip()` returns nothing, the user is signed in but
  not a member. That needs a real screen ("you're not on this trip yet"), not
  a silent empty trip and not a spinner.

### 4. Adding people

Start manual: add a row to `trip_collaborators` in the dashboard with their
user id once they've signed in once. Zero code, and honest for a household.

An invite flow (`pending_invites` keyed on email, claimed on first sign-in) is
worth building only if manual becomes annoying. Note §2.3 of `DEPLOY.md`
first: the built-in email provider allows **2 emails per hour**, so any invite
flow needs custom SMTP before it's usable.

---

## What this does NOT fix

**Concurrent editing.** The app has no merge or conflict resolution, by
design (`CLAUDE.md`) — and with several people editing, last-write-wins stops
being a theoretical caveat. Two people reordering the same day will silently
clobber each other; only About / My review append-merge. Worth deciding
whether that's acceptable (it may well be, for a household planning together)
rather than discovering it mid-trip.

---

## Test plan

None of this is coverable by the mocked tests. It needs two real accounts
against the live project:

- B sees the trip; C (not a collaborator) sees the "not on this trip" screen,
  never the data.
- B's edit shows up for A.
- B signing in on a device with existing local Dexie data does **not**
  overwrite the shared trip.
- Removing B revokes access immediately.
- `DEPLOY.md` §1.2's two-account RLS test needs rewriting: it currently
  expects the second account to see "an empty, freshly seeded trip", which
  will no longer be true (and is what 409s today).
