# China Trip Planner

A local-first, single-user PWA for planning the **Nov 2026 China trip** — a mini local Wanderlog with a map, places wishlist, day-by-day itinerary, and budget. All data lives in your browser (IndexedDB); there's no server.

Built with React 19 + TypeScript + Vite, Zustand (state), Dexie/IndexedDB (persistence), and Leaflet (map).

## Getting started

Install dependencies (first time, or after pulling changes):

```powershell
npm install
```

Start the dev server with hot-reload:

```powershell
npm run dev
```

Then open the URL it prints (typically **http://localhost:5173**).

## Environment variables

Cloud sync and sign-in need Supabase credentials. `.env.local` is gitignored, so it
does **not** come with the repo — create it yourself in the project root on each new
machine:

```powershell
ni .env.local
```

Then put these two lines in it:

```
VITE_SUPABASE_URL=https://kqvrrxtnvcywreewnesk.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable key>
```

Get the publishable key from the [Supabase dashboard](https://supabase.com/dashboard)
→ your project → **Project Settings → API Keys**. Newer projects label the keys
"Publishable" and "Secret" rather than the old anon/service_role JWTs — **Publishable**
is the client-safe one. Never commit the Secret key or put it in a `VITE_`-prefixed
variable; anything with that prefix is bundled into the browser build.

Restart `npm run dev` after creating or editing the file — Vite only reads env files
at startup. If either variable is missing the app throws a clear error on boot.

> Signing in from a new origin also needs that origin added under Supabase →
> **Authentication → URL Configuration → Redirect URLs** (e.g.
> `http://localhost:5173/**`), otherwise the magic link won't come back to your app.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server with hot-reload |
| `npm run build` | Production build (`tsc -b && vite build`) |
| `npm run preview` | Serve the production build locally — use this to test the PWA/offline behavior, since the service worker only runs on a real build |
| `npm test` | Run the Vitest test suite |
| `npm run lint` | Lint with oxlint |

## Testing on a phone

Both Vite servers bind to `localhost` only by default, so a phone on the same Wi-Fi
can't reach them. Add `--host` and Vite prints a **Network:** URL alongside the local
one — open that on the phone:

```powershell
npm run dev -- --host        # hot-reload, for iterating
npm run preview -- --host    # production build, for PWA/offline/install testing
```

Use `preview` for anything involving the service worker, install-to-homescreen, or
offline behaviour — none of that runs under `dev`.

> Sign-in from the phone needs that LAN origin added under Supabase →
> **Authentication → URL Configuration → Redirect URLs** (e.g.
> `http://192.168.1.42:5173/**`), same as any other new origin. Your router may hand
> the machine a different IP later, in which case the entry needs updating.
>
> Or skip that entirely — see below.

### Skipping the magic link locally

The magic-link flow is painful on a phone: the origin needs whitelisting per LAN IP,
the link arrives in a mail client, and tapping it opens your **default browser** rather
than the installed standalone PWA — so the session lands in the wrong browsing context
and the thing you were trying to test never signs in.

Set two extra variables in `.env.local`:

```
DEV_AUTH_EMAIL=you@example.com
DEV_AUTH_PASSWORD=<password>
```

> **No `VITE_` prefix, deliberately** — see "Why it can't reach production" below. Adding
> one would defeat the whole guard.

Then build with the dedicated script and serve it:

```powershell
npm run build:local -- --host   # production build, WITH credentials embedded
npm run preview -- --host
```

`npm run build:local` prints a warning naming the account whose credentials it just
embedded. **Plain `npm run build` ignores these variables entirely** — that's the point,
and it means you must use `build:local` for this to work. Credentials are baked in at
build time, so editing `.env.local` has no effect until you rebuild.

**One-time Supabase setup.** Enable **Authentication → Sign In / Providers → Email →
Password** (magic links keep working alongside it), then create a **dedicated dev
account** — don't reuse your own.

The dashboard has **no "set password" action for an existing user** (only *Send password
recovery* / *Send magic link*, both email round-trips), so an account you've only ever
used via magic link can't be given a password from the UI. A *new* user can:
**Authentication → Users → Add user → Create new user**, which takes an email and
password directly. Turn *Auto Confirm* on.

Access is membership-based (`trip_collaborators`, see `SHARING.md`), so give the new
account the same trip and it sees the same data — you lose nothing by not using your own
account, and a leaked build exposes a throwaway rather than your primary address:

```sql
insert into public.trip_collaborators (trip_id, user_id)
select 'trip-china-2026', id from auth.users where email = 'dev@example.com'
on conflict do nothing;
```

Sign in **before** running that and you should see the "You're not on this trip yet"
screen — which is the RLS check from `SHARING.md`'s test plan, for free.

Supabase enforces a **minimum password length of 6** by default; a shorter one is
rejected at user creation and you'll get `Invalid login credentials` at sign-in.

This is a **real session**, not a mock: RLS, the outbox and the synced repository all
behave exactly as in production. Only the email round-trip is skipped — which also makes
it the easiest way to exercise the two-account RLS check. If sign-in fails the app falls
back to the normal magic-link form and logs the reason to the console.

#### Why it can't reach production

Two independent guards, both required (`src/features/auth/devAutoSignIn.ts`):

1. **Credentials, at build time.** Vite only auto-inlines `VITE_`-prefixed variables, so
   these can never reach a bundle on their own. They get in solely through an explicit
   `define` in `vite.config.ts` that runs for the dev server and `--mode localdev` only.
   `npm run build` — the artifact `npx wrangler deploy` ships — cannot carry them
   whatever is in `.env.local`. The failure mode of any mistake is "no credentials",
   not "leaked credentials".
2. **Origin, at runtime**: `localhost`, loopback, `*.local`, or an RFC 1918 LAN address.
   This is what remains if a credential-carrying build ever escapes anyway — e.g. someone
   deploying `build:local` output by hand. A public hostname refuses.

Guard 2 stops the *auto-login* firing on a public site, but it cannot stop someone
reading a credential out of a published bundle and using it against Supabase directly —
which is why guard 1 exists and why `build:local` output must never be deployed.

### Viewing the mockup on a phone

`mockup/mockup.html` is fully self-contained — no external scripts, stylesheets or
`fetch` calls — so it renders correctly straight off the filesystem. AirDrop it to the
phone (or drop it in iCloud Drive) and tap it; iOS Safari opens it from `file://`.

That shortcut only works because the file has no external dependencies. A `file://`
origin is opaque, so `<script type="module">`, `fetch`, and service workers all fail
silently there. If a mockup ever grows one of those, serve it over the LAN instead:

```powershell
npx serve mockup
```
