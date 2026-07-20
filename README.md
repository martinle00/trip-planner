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
