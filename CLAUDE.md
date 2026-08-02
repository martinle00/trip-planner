# CLAUDE.md

Working notes for the China Trip Planner. Read this before making changes.

## Project

Local-first PWA for planning a Nov 2026 China trip: Map, Places, Itinerary and Budget
tabs plus an Auto-plan feature. Single user, single trip. Recently gained Supabase
auth + cloud sync so the trip follows the user across devices.

**Stack:** React 19 + TypeScript, Vite 8, Zustand 5 (state), Dexie 4 / IndexedDB
(local cache), Leaflet + react-leaflet (map), `@supabase/supabase-js` (remote),
vite-plugin-pwa, hand-written CSS with design tokens (no Tailwind). Vitest + oxlint.

## Commands

```bash
npm run dev      # vite dev server (port 5173)
npm run build    # tsc -b && vite build  — must pass before shipping
npm run lint     # oxlint
npm test         # vitest run  (584 tests as of this writing)

npm run changeset          # write an intent file for a change you just made
npm run changeset:status   # what's pending for the next version
npm run changeset:version  # roll pending changesets into CHANGELOG.md + bump package.json
```

## Versioning

`@changesets/cli`. The package is `private` and never published — changesets is used
purely for the changelog and the version number.

**Write the changeset as part of the change, not at release time.** That's the whole
point of the tool over a hand-edited `CHANGELOG.md`: the note is written while you still
remember why. `npm run changeset` prompts for the bump type and a summary, and drops a
file in `.changeset/`; commit it alongside the code.

- **patch** — a fix to existing behaviour.
- **minor** — new capability, or a deliberate change to how something already worked.
  This app has no external API, so almost everything user-visible is minor.
- **major** — reserved. Nothing here has consumers to break.

`npm run changeset:version` consumes every pending file, rewrites `CHANGELOG.md` and
bumps `package.json`. Run it once per release, not per change — **or let CI do it**.

### Releasing

`.github/workflows/release.yml` (changesets/action) on push to `master`:

1. Push a commit carrying a changeset → the workflow opens/updates a **"Version
   Packages" PR** that runs `changeset:version` for you.
2. Merge that PR → the workflow finds no pending changesets, runs `npm run release`
   (`changeset tag`), and the action turns the new tag into a **GitHub Release** with
   the changelog entry as the body.

So a Release is never cut from an unreviewed push; it takes the deliberate act of
merging the version PR. `npm run build` and `npm test` both gate it.

- Tag format is **`v0.8.0`** — single-package repos tag `v{version}` (a monorepo would
  get `{name}@{version}`).
- `changeset tag`, **not** `changeset publish`: the package is `private` and has never
  been on npm. The release artifact is the Cloudflare deploy, not a package.
- The repo needs **Settings → Actions → General → "Allow GitHub Actions to create and
  approve pull requests"** enabled, or step 1 fails with a permissions error.
- Deployment is still separate — this workflow tags and releases, it does not deploy.

Baseline: **0.7.0** = the app through Phase 7 (retroactive — the repo sat at `0.0.0`
until Phase 8). **0.8.0** = Phase 8.

Changeset summaries are the user-facing record; `PHASE*.md` holds the reasoning and the
traps. Don't duplicate one into the other — link.

`src/components/RouteStrip.tsx` has one pre-existing `only-export-components` lint
warning. It is expected — don't chase it.

## Architecture

### Frozen contracts

These files carry `FROZEN CONTRACT` headers and are depended on across the codebase.
Don't reshape them without deliberately coordinating the change everywhere:

- `src/data/schema.ts` — `Trip`, `City`, `Place`, `Day`, `ItineraryItem`, `Expense`,
  `TripSnapshot`. All ids are client-generated strings (`crypto.randomUUID()`).
  `Trip.cities` and `Trip.rates` are embedded objects, never queried by sub-field.
- `src/data/tripRepository.ts` — the `TripRepository` interface. This is the only
  seam a storage backend has to implement. Also exports `ACTIVE_TRIP_ID`.
- `src/data/seed.ts`, `src/store/useTripStore.ts`, `src/lib/autoplan.ts`.

UI talks to the Zustand store; the store talks to a `TripRepository`. **Components
never touch Dexie or Supabase directly.**

### Persistence seam

`src/data/tripRepositoryInstance.ts` holds a mutable current-repository singleton
behind a Proxy, so call sites (`tripRepository.upsertPlace(...)`) keep working when
the implementation is swapped at runtime:

- `DexieTripRepository` (`dexieTripRepository.ts`) — local IndexedDB. The default
  before sign-in.
- `SupabaseTripRepository` (`supabaseTripRepository.ts`) — remote Postgres via
  supabase-js. Maps camelCase domain types ↔ snake_case rows.
- `SyncedTripRepository` (`syncedTripRepository.ts`) — composes the two.
- `OutboxTripRepository` (`outboxTripRepository.ts`) — wraps the synced one and queues
  writes the network couldn't take. This is what `AuthGate` installs once a session
  exists; see the sync model below.

### Sync model: queued writes, cloud is source of truth

Still **no merge/conflict-resolution logic**, and still not getting any — every write
is last-write-wins, matching the app's pre-existing behaviour. What changed in Phase 8
is *when* a write is allowed to reach the server.

Three layers, composed in `AuthGate.tsx`:

```
OutboxTripRepository( SyncedTripRepository( Supabase, Dexie ), Dexie )
```

- **`SyncedTripRepository` (unchanged, inner):** write-through. Remote first, cache
  mirrored only on success. Reads remote, mirrors down, falls back to cache only when
  genuinely offline. An RLS/auth error surfaces as a real error.
- **`OutboxTripRepository` (outer):** the offline layer, and the one that **inverts the
  old "no silent divergence" rule** — deliberately. The trip this app exists for is
  spent somewhere Supabase is unreachable for a day at a time, so a failed write can't
  just be thrown at the user.
  - A **connectivity** failure writes the local cache, appends to the `outbox` Dexie
    table, and returns success. See `isConnectivityFailure` — it defaults to **false**,
    so anything unrecognised (RLS, expired JWT, constraint violation) still throws.
    Widening that predicate carelessly is how this feature would start silently eating
    writes that can never land.
  - **Never queued:** `importSnapshot` (a destructive whole-trip replace — queued, it
    would wipe out a day of a collaborator's work) and `updatePlaceIfUnchanged` (a
    conditional write whose `baseUpdatedAt` is meaningless hours later; the prose stays
    safe in `draftRepository` instead).
  - The queue **coalesces per record**, so `pendingCount` means "records changed".
  - **Reads bypass the remote entirely while the queue is non-empty.** Not an
    optimisation — the remote is missing every queued change, so reading it would paint
    older data over the user's own offline edits.

**`init()` is cache-first (stale-while-revalidate)** — paints from local Dexie
instantly, then reconciles in the background. `loading` is only true for a genuine
first-ever load with nothing cached.

> **Trap:** that background revalidation is **skipped entirely while the outbox is
> non-empty**, and `syncOutbox()` re-runs `init()` after a clean drain. Without this,
> the remote's older snapshot silently reverts the queued edits on screen. This is not
> the race `mutationVersion`/`domainDataInitPatch` guard — that read is legitimately
> complete, just legitimately stale.

**Uploading is user-gated.** `syncOutbox()` only ever runs from an explicit tap; there
is no auto-push and no retry loop. It stops at the first failure (a dead network breaks
the next 30 too) leaving the remainder queued, and is safe to re-run because every
replayed write is idempotent by id. The topbar pill shows the pending count — including
while offline, which does **not** break the old "never say syncing and offline at once"
rule: a count of unsaved work is a different fact from a claim to be syncing. The sync
sheet **never opens by itself**; see `App.tsx`.

**Sign-out refuses while changes are queued.** `clearLocalCache()` drops the outbox
along with everything else (a queued write is only permitted to the account that made
it), so signing out with pending work would destroy it.

### Supabase schema

`supabase/migrations/0001_init.sql` — **already applied** to the live project.
5 tables (`trips`, `days`, `places`, `itinerary`, `expenses`) mirroring the Dexie
tables; `cities`/`rates` are JSONB columns on `trips`. Later migrations add
prose fields, expense members/sharing, and collaborators.

**Access is membership, not ownership** (`0005_trip_collaborators.sql`): every
policy asks `is_trip_member(trip_id)`, so an account with no row in
`trip_collaborators` sees zero rows and no error — the app renders "You're not
on this trip yet" (`App.tsx`). `trips.user_id` now only records who created it;
`trips_user_id_unique` is gone.

`0006_auto_grant_trip_access.sql` adds a trigger on `auth.users` that enrols
every new account automatically. **It is only safe with public sign-ups turned
off** (Supabase → Authentication → Sign In / Providers → "Allow new users to
sign up"). Leave that off; adding someone = inviting them from the dashboard.

- **RLS** is on for all 5 tables. `trips` checks `auth.uid() = user_id` directly;
  `days`/`places`/`expenses` join back via `trip_id`; `itinerary` joins through
  `days` → `trips` (it has no `trip_id` column). Both `using` and `with check`, so a
  row can't be reassigned to another user's data.
- **`import_trip_snapshot(jsonb)` RPC** does whole-trip replace atomically.
  PostgREST has no cross-statement transaction, and plain upserts wouldn't delete
  rows dropped from the snapshot — hence the function.

## Auth

Supabase magic link (passwordless email). `src/features/auth/AuthGate.tsx` wraps
`<App/>` in `main.tsx`.

- Session persistence is handled by supabase-js itself (localStorage).
- `bootstrapMigration.ts` runs **once per user per device** (guarded by a
  `trip-planner:bootstrapped:<userId>` localStorage flag): if local Dexie has a trip
  and the remote is empty, it pushes local up. If the remote already has a trip,
  remote wins and local is treated as a stale cache. Never merges.
- Sign-out (`App.tsx handleSignOut`) resets the store, repoints the repository at a
  fresh `DexieTripRepository`, clears the Dexie cache, then signs out. Order matters.
- `devAutoSignIn.ts` swaps the magic link for `signInWithPassword` when testing on a
  phone over the LAN. **Two independent guards, both required:** credentials injected
  at build time *and* a local/RFC-1918 hostname at runtime. It produces a **real**
  session; nothing downstream is mocked. Don't relax either guard to make it work
  somewhere new — that's a different threat model, not a wider regex.
  - `DEV_AUTH_EMAIL`/`DEV_AUTH_PASSWORD` carry **no `VITE_` prefix on purpose**, so
    Vite cannot auto-inline them. They reach the bundle only via the `__DEV_AUTH__`
    `define` in `vite.config.ts`, which populates it for the dev server and
    `--mode localdev` (`npm run build:local`) and nothing else. **Plain `npm run build`
    structurally cannot carry them** — which matters because that build *is* the
    deploy artifact (`npx wrangler deploy` straight from `dist/`, see DEPLOY.md).
    Re-adding the prefix would publish a working Supabase password. `mode !== 'test'`
    is also excluded, so the suite never depends on a developer's `.env.local`.
  - Credentials are **build-time**: editing `.env.local` does nothing until a rebuild.
    This is the first thing to check when "the bypass isn't working".
  - Its `AuthGate` wiring is a deliberately isolated fire-and-forget effect that writes
    none of the gate's state (see the invariant below) — deleting it leaves the gate
    exactly as it was. README documents the Supabase-side setup.

### AuthGate: the invariant that keeps biting

**The gate's render state is DERIVED, never imperatively assigned:**

```
ready  ⟺  the repository is wired for the currently signed-in user
        (wiredUserId === userId)
```

This has caused two production bugs already; both traced to the same root cause — an
imperative state machine with several writers racing each other. Specifically:

1. supabase-js fires `TOKEN_REFRESHED` **on every tab focus**. Re-gating on that
   unmounted `<App/>` and wiped its local state (active tab, selected city, modals).
2. A late-resolving `getSession()` reset the gate to `checking-session` *after* the
   repository effect had settled it to `ready`. Because that effect is keyed on an
   unchanged `userId`, it never re-ran — the app hung on "Loading…" forever.

Keeping the state derived makes both impossible: no event ordering can knock the gate
backwards, because nothing writes the render state. **Do not reintroduce a
`setState`-driven gate state.** `AuthGate.test.tsx` guards all of this.

### Other UI state notes

- Active tab is persisted in `sessionStorage` (`trip-planner:activeTab`) so it
  survives a full reload — installed PWAs (iOS especially) get reloaded from scratch
  on backgrounding. Tests that render `<App/>` must `sessionStorage.clear()` between
  cases or tab state bleeds across them.
- The sync pill and offline banner are mutually exclusive — the pill is forced hidden
  when `!online` so the user is never told "syncing" and "offline" at once.

## Setup on a new device

1. `npm install`
2. Create `.env.local` (gitignored, so it does **not** transfer with the repo):
   ```
   VITE_SUPABASE_URL=https://kqvrrxtnvcywreewnesk.supabase.co
   VITE_SUPABASE_ANON_KEY=<publishable key>
   ```
   Get the publishable key from the Supabase dashboard → Project Settings → API Keys.
   (Newer Supabase projects show "Publishable"/"Secret" instead of the old
   anon/service_role JWTs — Publishable is the client-safe one. Never ship the Secret
   key.) `src/lib/supabaseClient.ts` throws a clear error if either var is missing.
3. The DB migration is already applied — no need to re-run it.
4. **Add the new origin to Supabase → Authentication → URL Configuration → Redirect
   URLs** before testing magic-link sign-in from that machine (e.g.
   `http://localhost:5173/**`). This is the single most common thing that breaks.

## Design / mockup workflow

**`mockup/DESIGN-SYSTEM.md` is the design reference** — tokens and what each one means,
the semantic colour vocabulary (jade = paid/done, gold = owed/pending, accent = primary
action), the mandatory `-soft-ink` contrast rule, component patterns, breakpoints and
the a11y floor. Read it before any UI work so you don't re-derive it from the CSS.
`src/index.css` stays the source of truth; if the doc drifts from it, fix the doc.

`mockup/mockup.html` is a self-contained static mockup that acts as the visual spec
the React app is built to match; design tokens in `src/index.css` are ported from it.
`.claude/agents/` defines a pipeline: ux-designer → ux-reviewer → frontend-engineer /
backend-impl → code-reviewer → qa-tester. Non-trivial UI work is expected to go
through mockup + review before implementation.

## Status / next steps

**Phase 8 (offline writes + the By-person split) — see `PHASE8.md`.**

**⚠️ Phase 4 is mid-flight — see `PHASE4.md` before touching anything.** It carries the
full scope (9 items), the decisions and their rationale, four documented traps, and the
workstream state. The working tree may not compile: removing `Place.note` was
deliberately landed without fixing its three UI consumers.

Working and verified by tests + build: schema, both repositories, the synced
write-through wrapper, magic-link auth, bootstrap migration, cache-first boot, sync
indicator, tab persistence.

Not yet done:

- **End-to-end sign-in has not been exercised in a real browser yet.** Everything so
  far is verified by unit tests, typecheck and build only. Worth confirming: magic
  link arrives and redirects back, trip loads, a change on one device shows on
  another, and the Budget tab survives a tab switch.
- **RLS has never been verified against the live project.** Mocked tests can't cover
  it. Do the two-user check once before trusting it: sign in as A, confirm a second
  account can't read A's rows. Note RLS misconfiguration fails silently in *both*
  directions — enabled-with-no-policy denies everything, never-enabled is wide open.
- No test coverage for `AuthGate`'s bootstrap-flag skip path against a real
  supabase-js client (it's mocked).
