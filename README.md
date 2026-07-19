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

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server with hot-reload |
| `npm run build` | Production build (`tsc -b && vite build`) |
| `npm run preview` | Serve the production build locally — use this to test the PWA/offline behavior, since the service worker only runs on a real build |
| `npm test` | Run the Vitest test suite |
| `npm run lint` | Lint with oxlint |
