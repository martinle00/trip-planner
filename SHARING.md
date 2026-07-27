# Sharing the trip with companions — design

**Status: not started.** This is the "my partner signs in and sees *this*
trip" feature. Deploy first (`DEPLOY.md` Phase 1); this builds on a
deployment whose auth and RLS have actually been exercised.

Estimate: a phase of work, not an afternoon. The single-owner assumption is
load-bearing in the database, the RLS policies, the remote repository and the
bootstrap flow.

---

## What's in the way

1. **`trips_user_id_unique`** (`0001_init.sql`) — one trip per account, at the
   DB level. A second member cannot be an owner of the same trip row, and the
   index must be dropped for the membership model to exist at all.

2. **Every RLS policy** is `trips.user_id = auth.uid()`. All five tables need
   rewriting to "…is a member of this trip". `itinerary` joins through
   `days → trips`, so its policy is the awkward one.

3. **`SupabaseTripRepository.getTrip()`** selects `.eq('user_id', this.userId)`.
   An invited member has no such row and would see *no trip* — then
   `seedIfEmpty()` would helpfully create them their own. Membership lookup
   has to replace the `user_id` filter.

4. **`import_trip_snapshot`** inserts `auth.uid()` as the trip's `user_id`.
   If a member imports a JSON backup, they silently **take ownership** of the
   trip. Needs to preserve the existing owner and be member-gated.

5. **`bootstrapMigration.ts`** pushes local Dexie up when the remote is empty.
   For an invited member on a device that already has a seeded local trip,
   "remote is empty" must mean "and I'm not a member of anyone's trip" — or
   they'll overwrite the shared trip with their own seed data. This is the
   most destructive failure mode in the whole feature.

6. **No conflict resolution, by design** (`CLAUDE.md`). Today that's fine —
   one person, last write wins. With two people editing simultaneously it
   becomes a real product question: two people editing the same day's stops
   will silently clobber each other. Only the prose fields (About / My review)
   append-merge; everything else is last-write-wins.

7. **Naming collision.** `TripMember` already exists in `schema.ts` — it's a
   *travel companion for expense splitting* (Phase 5, "Paid by"), with no
   account behind it. The new concept is an *access grant tied to an auth
   user*. Do not reuse the name: call the table `trip_collaborators`.
   Conflating them will produce a bug where deleting a budget companion
   revokes someone's access, or worse.

---

## Proposed shape

### Migration `0005_trip_collaborators.sql`

```sql
create table public.trip_collaborators (
  trip_id text not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor','viewer')),
  invited_email text,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

drop index public.trips_user_id_unique;   -- one trip per account no longer holds
```

Backfill the current owner as a collaborator, then every policy becomes a
membership test. Use a `security definer` helper so the policies don't
recurse (a policy on `trips` that queries `trip_collaborators`, which itself
has a policy that queries `trips`, is an infinite loop — this is the classic
Supabase RLS footgun):

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

Writes should additionally check the role isn't `viewer` — worth deciding
early whether viewers exist at all, since "editor-only" removes an entire
axis of policy complexity.

### Invite flow

Simplest that works, in order of increasing effort:

1. **Manual** — you add a row to `trip_collaborators` in the dashboard with
   their user id after they've signed up once. Zero code. Ugly, fine for two
   people, and a legitimate answer for a private trip planner.
2. **Invite by email** — a `pending_invites` table keyed on email; on sign-in,
   claim any invite matching the session's email and convert it to a
   collaborator row. Needs a claim step somewhere in `AuthGate`.
3. **Invite link with a token** — a share URL carrying a single-use token.
   Nicest UX, most surface area, needs an edge function to redeem safely.

Start at 1. It's honestly enough for a partner and a parent, and it lets the
RLS work be verified independently of an invite UI.

### Client changes

- `getTrip()` → membership lookup rather than `user_id`.
- `seedIfEmpty()` → must not seed when the user is a collaborator on a trip.
- `bootstrapMigration` → membership check before any push-local-up.
- `importSnapshot` / `import_trip_snapshot` → preserve owner, gate on membership.
- Some UI for "who else is on this trip" — and it must not be confused with
  the Budget tab's existing companions list (see item 7).

### Test plan

The mocked tests can't cover any of the above. This needs two real accounts
against the live project:

- B sees A's trip; a third account C sees neither.
- B's edit appears for A.
- B's local Dexie seed does **not** overwrite the shared trip on first sign-in
  (item 5 — test this deliberately, with a device that has local data).
- B importing a JSON backup does not transfer ownership (item 4).
- Removing B revokes access immediately.

---

## Cheaper alternative worth considering

If the actual need is "my family can *see* the plan", a **read-only published
snapshot** is dramatically less work and has no RLS rewrite: export the trip
to static JSON at publish time and render it at a `/share/<id>` route with no
auth. No live sync, no conflicts, no ownership questions — and it's the
version that keeps working when Supabase isn't reachable from China.

Worth a deliberate decision before committing to full collaboration.
