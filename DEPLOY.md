# Deploying the China Trip Planner

Target: **Cloudflare Pages** (static build) + the existing **Supabase** project.

Chosen for China reachability — you'll be using this inside mainland China in
Nov 2026, and Cloudflare's CDN is the least-blocked of the free static hosts.
Nothing here is Cloudflare-specific beyond §3: `npm run build` produces plain
static files in `dist/`, so the host is swappable.

This document covers **Phase 1: get it live for you**. Sharing the trip with
companions is a separate project — see `SHARING.md`, and read §0 before
assuming it's a small step.

---

## 0. Read this first — the thing that will bite

The app currently enforces **one trip per account** at the database level
(`trips_user_id_unique`, `supabase/migrations/0001_init.sql`). Every RLS
policy is written as "this row belongs to a trip whose `user_id` is me".

That means: **anyone who signs in today gets their own empty trip, not
yours.** Inviting your partner to the deployed URL will not show them the
China trip — it will seed them a fresh one. Making them see *your* trip is a
schema + RLS + repository change (`SHARING.md`), not a config toggle.

Phase 1 is still the right first step: you cannot debug collaboration on top
of a deployment whose auth and RLS have never been exercised in a browser.

---

## 1. Pre-flight (do these before touching the host)

### 1.1 Apply the outstanding migrations — highest-risk item

> **Verified 2026-07-27: 0001–0004 are all applied**, `import_trip_snapshot`
> exists, RLS is on for all five tables with 5 policies. Re-run the checks
> below after any future migration; leave the rest of this section as the
> record of what was actually checked.

`0001` is applied. **Verify `0002`, `0003` and `0004`.** Until `0004` runs,
`import_trip_snapshot` silently drops fields on JSON import with **no error at
all** — the worst failure mode in the system, because it looks like success.

Check what's actually live (Supabase dashboard → SQL editor):

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'places'
  and column_name in ('description', 'self_review');      -- 0002

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'expenses'
  and column_name in ('note', 'paid_by', 'covers_member_ids');  -- 0003 / 0004

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'trips'
  and column_name = 'members';                            -- 0003
```

Any missing → run that migration's file, in order, from the SQL editor.
Re-run the checks after. Migrations are written to be idempotent-safe to
read, but **do not** re-run one that's already applied without reading it.

### 1.2 Verify RLS actually works — release gate

RLS has never been tested against the live project. Mocked tests cannot cover
it, and **it fails silently in both directions**: enabled-with-no-policy denies
everything; never-enabled is wide open with no error anywhere.

> **Verified 2026-07-27:** RLS enabled on all five tables, 5 policies present.
> That proves the switch is on and policies exist — it does **not** prove they
> scope correctly. The two-account test at the end of this section is still
> outstanding and is still the release gate.

Confirm every table has RLS on and at least one policy:

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('trips','days','places','itinerary','expenses');
-- relrowsecurity must be true for all five

select tablename, policyname, cmd from pg_policies where schemaname = 'public';
-- expect one "own trip …" policy per table
```

Then the real test, after §4 (needs the deployed URL):

1. Sign in as you. Note your trip has data.
2. Sign in as a second account (a different email) in a private window.
3. The second account must see an **empty, freshly seeded trip** — never your
   places. If it sees your data, stop and fix RLS before going further.

### 1.3 Local build sanity

```bash
npm ci
npm run lint
npm test
npm run build
npm run preview        # serves dist/ at http://localhost:4173
```

All four must pass. `npm run build` runs `tsc -b` first, so a type error is a
build failure, not a warning.

---

## 2. Supabase configuration

### 2.1 Get the publishable key

Dashboard → Project Settings → API Keys. Newer projects show
**Publishable** / **Secret** rather than anon / service_role.
**Publishable** is the client-safe one — that's `VITE_SUPABASE_ANON_KEY`.

Never put the Secret key anywhere near this repo: it bypasses RLS.

### 2.2 Redirect URLs — the single most common thing that breaks

Dashboard → Authentication → URL Configuration.

- **Site URL**: your production URL (e.g. `https://china-trip-planner.pages.dev`,
  or your custom domain once §5 is done).
- **Redirect URLs**: add every origin the app is opened from, each with `/**`:
  ```
  http://localhost:5173/**
  https://china-trip-planner.pages.dev/**
  https://<your-custom-domain>/**
  ```

Cloudflare Pages also gives every deployment a unique preview URL
(`<hash>.china-trip-planner.pages.dev`). Magic links **will not work** from
those unless you add a wildcard — either add `https://*.china-trip-planner.pages.dev/**`
or accept that only the production URL can sign in. Prefer the latter: a
wildcard on a shared `pages.dev` subdomain is a wider grant than it looks.

### 2.3 Email rate limits

Supabase's built-in SMTP is heavily rate-limited (a handful of emails per
hour) and is explicitly not for production. That's survivable for one or two
users; it is not if you later invite people (`SHARING.md`). Custom SMTP is
configured under Authentication → Emails.

---

## 3. Cloudflare Pages setup

1. Push the repo to GitHub (see §7 — nothing is committed yet).
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Pick the repo. Settings:
   - **Framework preset**: None (or Vite)
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: `/`
4. **Environment variables** (Production *and* Preview both):
   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | the publishable key from §2.1 |
   | `NODE_VERSION` | `22` |

   These are **build-time** variables — Vite inlines them into the bundle.
   Changing one requires a redeploy, not just a save. `src/lib/supabaseClient.ts`
   throws a clear error if either is missing, so a misconfigured build fails
   loudly at first paint rather than silently half-working.
5. Deploy.

Already in the repo for this:
- `public/_redirects` — `/* /index.html 200`, so a deep link or a refresh
  serves the app instead of a 404.
- `public/_headers` — security headers, plus `no-cache` on `sw.js` /
  `index.html` and immutable caching for fingerprinted `/assets/*`. Getting
  this wrong is how a PWA pins itself to an old build.

---

## 4. Verify the deployment

In order. Each one has failed for a real reason before:

- [ ] Production URL loads; no console errors about missing env vars.
- [ ] **Magic link**: request one, receive it, click it, land back signed in.
      If it errors, it's §2.2 nine times out of ten.
- [ ] Trip data loads after sign-in (not the empty seed).
- [ ] **RLS two-account check** (§1.2) — the release gate.
- [ ] Change something on one device; confirm it appears on another after a
      reload. This is the first real test of the write-through sync model.
- [ ] Switch tabs and back: the Budget tab survives, the active tab persists
      across a full reload (`sessionStorage`).
- [ ] **Install as a PWA on iOS**, then background it and reopen — installed
      iOS PWAs get reloaded from scratch, which is exactly what the tab
      persistence exists for.
- [ ] Turn airplane mode on: the offline banner shows, Places/Itinerary/Budget
      still read. **Then try to edit something.** Writes require the network
      by design and will fail — confirm the failure is visible and not silent.
      This UX is documented as unfinished; find out how bad it is before the
      trip, not during it.

---

## 5. Custom domain (optional)

Pages → your project → Custom domains. If the domain is already on
Cloudflare, it's a click; otherwise point the CNAME as instructed. **Then go
back and add it to Supabase's redirect URLs (§2.2)** — this is the step people
forget, and sign-in breaks the moment you start using the new domain.

---

## 6. Rollback

Cloudflare keeps every deployment. Pages → Deployments → pick the last good
one → "Rollback to this deployment". Takes effect in seconds.

Caveats that make rollback less complete than it looks:
- **Service worker**: `registerType: 'autoUpdate'`, so clients pick up the
  rollback on next load — but an already-open tab may hold the newer worker
  until it's closed. The `no-cache` headers in `public/_headers` are what keep
  this from being much worse.
- **Database changes do not roll back.** A migration applied in §1.1 stays
  applied. Rolling back the front end to a build that predates a schema change
  is not safe; write a forward migration instead.

---

## 7. Committing

Nothing is committed yet — the working tree holds the tail of Phase 4 through
all of Phase 6 plus this session's work. Before connecting the repo to
Cloudflare:

```bash
git checkout -b deploy-prep      # currently on master
git add -A
git commit -m "..."
git push -u origin deploy-prep
```

`gh` is not installed; plain `git push` to
`origin` (github.com/martinle00/trip-planner) works — Git Credential Manager
is configured. **Confirm `.env.local` is gitignored and not staged** before
the first push.

---

## 8. China-specific reality check

Do this *before* you fly, not on landing:

- **Supabase reachability.** The app is useless-for-writes if
  `*.supabase.co` is unreachable from your network there. Test from a China
  network if you can beg one; otherwise treat it as unverified and know that
  the local Dexie cache keeps reads working.
- **OSM tiles** (`tile.openstreetmap.org`) are deliberately not cached
  (online-only map, per spec). If they're slow or blocked, the map is blank
  while Places/Itinerary/Budget keep working.
- **Roaming and captive portals** break magic links in ways that look like app
  bugs. Sign in before you go; sessions persist in localStorage.
