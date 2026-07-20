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
npm test         # vitest run  (215 tests as of this writing)
```

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
- `SyncedTripRepository` (`syncedTripRepository.ts`) — composes the two. Installed
  by `AuthGate` once a session exists.

### Sync model: write-through, cloud is source of truth

Deliberate choice — the app has **no merge/conflict-resolution logic** and isn't
getting any. Matches its pre-existing last-write-wins behaviour.

- **Writes:** remote first; the local Dexie cache is mirrored **only after the remote
  succeeds**. If the remote write fails, the cache is *not* written — no silent
  divergence. A mutation while offline therefore fails loudly and the UI must
  surface it.
- **Reads:** remote, mirrored down into the cache on success. Falls back to the cache
  **only when genuinely offline** (`!navigator.onLine`). An RLS/auth error must
  surface as a real error, not silently read stale data.
- **`init()` is cache-first (stale-while-revalidate):** paints from local Dexie
  instantly, then reconciles with the remote in the background. `loading` is only
  true for a genuine first-ever load with nothing cached; `syncing` drives the
  topbar pill. See `useTripStore.ts`.

### Supabase schema

`supabase/migrations/0001_init.sql` — **already applied** to the live project.
5 tables (`trips`, `days`, `places`, `itinerary`, `expenses`) mirroring the Dexie
tables; `cities`/`rates` are JSONB columns on `trips`. `trips_user_id_unique`
enforces single-trip-per-account at the DB level.

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
- Offline-write UX: writes now require the network, which is a real behaviour change
  from the old fully-offline app. The error surfacing on a failed offline mutation
  hasn't been designed or verified.
- No test coverage for `AuthGate`'s bootstrap-flag skip path against a real
  supabase-js client (it's mocked).
