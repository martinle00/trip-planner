# PHASE 9 — Offline maps (PLAN, not yet implemented)

Phase 8 made the *data* work offline. The map still doesn't: `MapPanel.tsx:205`
swaps Leaflet for a "You're offline" placeholder, `vite.config.ts:33-38` explicitly
leaves OSM tiles out of the precache ("online-only map, per spec"), and the offline
banner says "The live map needs a connection."

For a trip spent somewhere the network is unreachable for a day at a time, that
means: on the ground you have your itinerary, your budget and your notes — and a
grey box where the pins are. This phase closes that.

> **STATUS: PLAN ONLY.** Nothing below is implemented. The tile-source decision in
> §1 must be settled before any code is written; it determines most of the rest.

---

## 1. The blocker that shapes everything: OSM's tile policy

The [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
defines bulk downloading as *"any pre-emptive fetching of tiles other than those a
user is actively viewing"* and names **"Download city/country for offline use"** as a
prohibited feature on `tile.openstreetmap.org`.

So the obvious implementation — keep the current `TileLayer`, add a "download this
city" button — is against the policy of the server we currently point at. It would
also plausibly get the origin blocked ("access may be blocked, without notice, if
your usage degrades the service"), which would break the map *online* too.

The policy does explicitly permit caching what you actually viewed: *"Cache tiles
locally according to HTTP caching headers (or at least 7 days)."* That's the seam
between the two options.

### Option A — opportunistic cache (raster, stay on OSM)

Cache tiles as they're viewed via a Workbox `CacheFirst` runtime rule; offline, the
map renders whatever's in the cache and greys the rest.

- **Cost:** ~a day. A `runtimeCaching` block in `vite.config.ts`, deleting the
  `online ?` branch in `MapPanel.tsx`, and a "showing cached area only" indicator.
- **Policy:** compliant, as long as nothing pre-fetches.
- **Fatal weakness:** coverage is invisible and accidental. You find out what you
  have when you're standing in Chongqing and it's grey. Any UI that fixes that
  ("warm up this city") is bulk downloading with extra steps — worth being honest
  about rather than shipping under a different name.

### Option B — Protomaps PMTiles, self-hosted (RECOMMENDED)

[Protomaps](https://docs.protomaps.com/guide/getting-started) publishes an
OSM-derived planet basemap as `.pmtiles` — a single-file tile archive. The
[`pmtiles` CLI](https://docs.protomaps.com/pmtiles/cli) extracts a bbox out of it
without downloading the planet:

```
pmtiles extract https://build.protomaps.com/<date>.pmtiles chongqing.pmtiles \
  --bbox=106.35,29.42,106.75,29.70
```

Ten small archives (one per leg), served from the existing Cloudflare Workers
assets deploy or an R2 bucket. The client downloads a leg's archive on demand and
renders it with [`protomaps-leaflet`](https://github.com/protomaps/protomaps-leaflet),
which reads PMTiles directly.

- **Policy:** no tile-server policy applies — we host it. ODbL attribution is still
  required and the existing attribution line covers it (update the wording).
- **Deterministic:** "Chongqing · 8 MB · Downloaded ✓" is a fact, not a hope. That
  determinism *is* the feature — Option A's coverage gamble fails exactly when the
  map matters.
- **Costs:** vector rendering, so the basemap will not look like today's raster OSM
  and needs a style pass against `DESIGN-SYSTEM.md`. `protomaps-leaflet` is
  **in maintenance mode** per its README — it works and is stable, but it is not
  actively developed. Accept that or move the map to MapLibre GL, which is a much
  larger change and out of scope here.

### Option C — a commercial raster provider that permits offline

MapTiler/Stadia/Thunderforest. Offline packs are paid tiers, and it adds an API key
to a client bundle. Mentioned for completeness; not recommended given a free
self-hosted path exists.

### Recommendation

**Option B, staged** — §2 ships the plumbing that both options need and is useful on
its own; §3 swaps the tile source. Stage 1 is not throwaway: removing the
online-only gate, the storage/quota work, the Settings surface and the offline map
states are all needed either way.

---

## 2. Stage 1 — make the map render at all offline

Independent of tile source. Ships value in about a day.

1. **Delete the `online ?` branch** in `MapPanel.tsx:205-236`. The map renders
   always; missing tiles are the empty state, not a replaced component.
2. **Pins are the point, and they don't need tiles.** Markers are DOM elements over
   a canvas — with no basemap the map still shows relative positions, the day
   colouring, the tap-to-open-detail flow and the fit-to-bounds framing. A blank
   graticule with pins on it is meaningfully better than the current grey box, and
   it is the honest fallback for an area that was never downloaded.
3. **A map-state chip** in place of the current `.map-badge`, following the Phase 8
   pill's vocabulary: `Offline · showing downloaded map` / `Offline · no map for
   this area`. Same rule as the sync pill — state the fact, don't claim more.
4. **`navigator.storage.persist()`** on first load — see the trap in §5. This one
   is worth doing regardless of whether the rest of the phase happens.
5. **Workbox runtime cache** for tiles (`CacheFirst`, 30-day expiry, capped entry
   count). Under Option A this *is* the feature; under Option B it becomes the
   online-session cache in front of the PMTiles fetches. Either way it's the same
   config block.

## 3. Stage 2 — per-leg downloads (Option B)

### Asset pipeline

An `npm run maps:build` script (not part of `npm run build` — it is slow and its
output changes maybe twice a year):

- Reads the leg list and computes a bbox per leg: the union of that leg's saved
  places plus `CITY_FALLBACK_CENTER` (`src/lib/tripView.ts:241`), buffered ~5 km.
  Day-trip legs (Wulong, Shenzhen) have `nights: 0` and typically no saved places —
  they fall back to the centre point, which is exactly the case that currently makes
  those legs look broken on the map.
- Runs `pmtiles extract` per leg at z0–15 and writes to `public/maps/<slug>.pmtiles`
  plus a `manifest.json` (slug, bbox, byte size, build date).
- **Sizes to expect:** roughly 5–15 MB per leg, ~60–100 MB for all ten. Shanghai and
  Guangzhou dominate; Zhangjiajie and Wulong are small. The manifest carries the real
  numbers so the UI never guesses.

Serve from the existing `dist/` assets deploy. If total size becomes awkward for the
Workers assets limit, move to R2 — the client only needs a URL either way.

### Client

- Download a leg's archive on demand, store the blob (Cache Storage keyed by leg
  slug; Dexie is the alternative but blobs of this size belong in Cache Storage).
- Render via `protomaps-leaflet` over a `FileSource` wrapping the stored blob, so
  rendering is identical online and offline — there is no second code path to keep
  in sync, which is the mistake the current `online ?` branch makes.
- Fall back to the live remote PMTiles URL (range requests) when a leg isn't
  downloaded and we're online.

### UI — `SettingsModal.tsx`, an "Offline maps" section

The download must happen **before departure**, on home wifi. That makes Settings the
right home, not the Map tab: it is a trip-preparation action, not a map action.

- One row per leg: name, size, and a state — `Download` / `Downloading… 40%` /
  `Downloaded ✓` with a remove control.
- A `Download all · 84 MB` action, and a total-used line from
  `navigator.storage.estimate()`.
- **Never auto-download.** Same rule Phase 8 settled for the outbox: 84 MB on
  roaming data is a worse outcome than a grey map. Downloads are user-tapped only,
  and the sheet should warn if the connection is metered where detectable.
- A pre-trip nudge is tempting and should wait for a second pass. It needs a
  "don't show again" and a sense of the trip start date; getting it wrong is a
  nag on every launch for four months.

---

## 4. What this does NOT do

- **No routing, no search offline.** Geocoding still goes to Nominatim, so Add Place
  by search remains online-only. Add-by-pin works offline and becomes the primary
  path on the ground — worth a hint in `AddPlaceModal` when offline.
- **No offline place metadata** (opening hours, admission). Separate idea, separate
  data problem.
- **No day-route polylines.** Adjacent idea; don't couple it to this.
- **No change to `TripRepository` or the sync model.** This phase touches tiles and
  Settings only. If it starts editing the persistence seam, something has gone wrong.

---

## 5. Traps

- **Opaque responses break `CacheFirst` silently.** Cross-origin tiles fetched
  `no-cors` come back with `status: 0`, and Workbox's default cacheability check
  drops them. Needs `cacheableResponse: { statuses: [0, 200] }`, or the cache stays
  empty and everything looks like it works until you go offline. This is the single
  easiest way to ship a broken version of this feature.
- **Safari evicts non-persisted storage after ~7 days of non-use.** A map downloaded
  in October for a November trip could simply be gone. `navigator.storage.persist()`
  is the mitigation, and installed PWAs are treated more favourably — but this must
  be **verified on the actual iOS device**, not assumed. **This already affects the
  Phase 8 outbox and the Dexie cache**, which is why §2 does it first and
  unconditionally.
- **Quota is not the number you think.** `estimate()` reports origin quota, which on
  iOS is a fraction of free disk and can shrink. Check available space *before*
  starting a download and fail with a real message, never a half-written archive.
- **A partial download must not present as complete.** Write to a staging key and
  only publish the leg as `Downloaded` once the blob is whole and its size matches
  the manifest. Otherwise a dropped connection produces a leg that claims to be
  available and renders nothing — the worst possible failure for this feature.
- **`FitToPlaces` (`MapPanel.tsx:378`) assumes tiles exist for wherever it flies to.**
  With a downloaded leg it must not fit to bounds outside that leg's bbox, or the
  user lands on blank canvas and reads it as broken. Clamp to the downloaded bbox.
- **The mocked test setup hides all of this.** `MapPanel.test.tsx:30` mocks out
  `react-leaflet` entirely, so no test in this repo has ever rendered a tile. Tests
  here cover the *state logic* (which leg is downloaded, what the chip says, quota
  refusal); the rendering has to be verified by hand.

---

## 6. Verification

```bash
npm test && npm run build && npm run lint
```

New tests: manifest/bbox computation from legs + places (pure, easy to cover
properly); the download state machine incl. partial-write rejection and quota
refusal; the Settings rows; the map-state chip matrix.

**Manual, and this is the part that actually matters** — mocked tests cannot cover
any of it:

1. Download one leg on wifi. DevTools → Offline. Reload. Map renders with the
   basemap, pins in the right places.
2. Pan to a leg that was *not* downloaded — confirm the blank-with-pins state and
   the correct chip, not a crash or a spinner.
3. Kill the network mid-download; confirm the leg reverts to `Download`, not
   `Downloaded`.
4. Install to the iOS home screen, download, leave it a week, reopen — the Safari
   eviction check. Nothing else substitutes for this one.
5. Confirm total storage after all ten legs against `estimate()` on the real device.

---

## 7. Sequencing

Stage 1 is a day and is worth doing on its own merits. Stage 2 is the larger piece
and its first real task is a spike: extract one leg (Chongqing), render it with
`protomaps-leaflet`, and look at it. If the vector basemap can't be styled to sit
next to the existing design tokens without a fight, that's the moment to reconsider
Option A or C — before the asset pipeline and Settings UI are built on top of it.
