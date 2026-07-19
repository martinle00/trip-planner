// ============================================================================
// FROZEN CONTRACT — Auto-plan public API.
// The Auto-plan specialist implements the body of `autoPlan` (plus helpers in
// ./geo.ts). The frontend renders the config panel + draft preview against
// these types. The store's `applyAutoPlan(plan)` consumes a DayPlan[].
//
// Keep the exported signature and types stable. Implementation detail (the
// clustering + ordering algorithm) lives behind this boundary.
// ============================================================================

import type { Place, Day, ID } from '../data/schema';
import type { GeoPoint } from './geo';
import { haversineMeters, centroid, squaredDist } from './geo';

/** User-tunable knobs shown in the Auto-plan config panel. */
export interface AutoPlanConfig {
  /** Hard cap on stops assigned to a single day. */
  maxStopsPerDay: number;
  /** Day start time, "HH:MM" 24h — first stop begins here. */
  dayStartTime: string;
  /** Average minutes spent at each stop (drives generated start times). */
  avgMinutesPerStop: number;
  /** Optional travel buffer added between stops, in minutes. Default 0. */
  travelBufferMin?: number;
}

export const DEFAULT_AUTOPLAN_CONFIG: AutoPlanConfig = {
  maxStopsPerDay: 4,
  dayStartTime: '09:00',
  avgMinutesPerStop: 90,
  travelBufferMin: 30,
};

/** A single proposed stop within a generated day. */
export interface PlannedStop {
  placeId: ID;
  /** 0-based order within the day. */
  order: number;
  /** Generated "HH:MM" start time. */
  startTime: string;
  durationMin: number;
}

/** A generated day: a geographic cluster of stops assigned to a real Day. */
export interface DayPlan {
  /** The Day this cluster is assigned to. */
  dayId: ID;
  /** ISO date (YYYY-MM-DD) of that day, for display. */
  date: string;
  city: string;
  stops: PlannedStop[];
}

/**
 * Group the given places into an efficient day-by-day plan.
 *
 * Contract:
 *  - Only considers places with real coordinates. Places are partitioned by
 *    `place.city`, which is matched against `day.city` (day-trip cities match
 *    their own name, e.g. a Wulong place → the Wulong day).
 *  - Each city's places are clustered into as many groups as that city has
 *    days in `days`, respecting `config.maxStopsPerDay`, using straight-line
 *    (haversine) distance as the travel-cost proxy — no external routing API.
 *  - Clusters are assigned to that city's dates and stops ordered within each
 *    day; start times are generated from `config`.
 *  - Returns one DayPlan per day that received stops. Pure & deterministic:
 *    same inputs → same output. Does not mutate its arguments or persist.
 *
 * The result is a *recommendation*; the caller previews it and may Accept
 * (→ store.applyAutoPlan) or Regenerate with tweaked config.
 */
export function autoPlan(
  _places: Place[],
  _days: Day[],
  _config: AutoPlanConfig = DEFAULT_AUTOPLAN_CONFIG,
): DayPlan[] {
  const config = _config;

  const validPlaces = _places.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
  );

  // Partition places by city, preserving first-seen order (deterministic).
  const placesByCity = new Map<string, Place[]>();
  for (const p of validPlaces) {
    const existing = placesByCity.get(p.city);
    if (existing) existing.push(p);
    else placesByCity.set(p.city, [p]);
  }

  // Partition days by city.
  const daysByCity = new Map<string, Day[]>();
  for (const d of _days) {
    const existing = daysByCity.get(d.city);
    if (existing) existing.push(d);
    else daysByCity.set(d.city, [d]);
  }

  const results: DayPlan[] = [];
  for (const [cityName, cityPlaces] of placesByCity) {
    const cityDays = daysByCity.get(cityName);
    if (!cityDays || cityDays.length === 0) continue; // no day to place this city on
    results.push(...planCity(cityPlaces, cityDays, config));
  }

  // Stable overall ordering: chronological by date, then by day id.
  results.sort((a, b) => a.date.localeCompare(b.date) || a.dayId.localeCompare(b.dayId));
  return results;
}

// ============================================================================
// Implementation details below — not part of the public contract.
// ============================================================================

/** Plan a single city's places onto that city's days. */
function planCity(cityPlaces: Place[], cityDays: Day[], config: AutoPlanConfig): DayPlan[] {
  const sortedDays = [...cityDays].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  );
  const k = sortedDays.length;
  const n = cityPlaces.length;
  if (k === 0 || n === 0) return [];

  const points: GeoPoint[] = cityPlaces.map((p) => ({ lat: p.lat, lng: p.lng }));
  const { assignment, k: kEff } = balancedKMeans(points, k, config.maxStopsPerDay);

  // Group places/points into their assigned clusters (0..kEff-1).
  const clusterPlaces: Place[][] = Array.from({ length: kEff }, () => []);
  const clusterPoints: GeoPoint[][] = Array.from({ length: kEff }, () => []);
  for (let i = 0; i < n; i++) {
    const c = assignment[i];
    clusterPlaces[c].push(cityPlaces[i]);
    clusterPoints[c].push(points[i]);
  }

  // Order clusters geographically (longitude, then latitude) so nearby
  // clusters map to consecutive days in a sensible west-to-east-ish sweep.
  const clusterOrder = clusterPoints
    .map((pts, idx) => ({ idx, c: centroid(pts) }))
    .sort((a, b) => a.c.lng - b.c.lng || a.c.lat - b.c.lat || a.idx - b.idx)
    .map((x) => x.idx);

  const stepMinutes = config.avgMinutesPerStop + (config.travelBufferMin ?? 0);
  const plans: DayPlan[] = [];
  const slots = Math.min(clusterOrder.length, sortedDays.length);
  for (let slot = 0; slot < slots; slot++) {
    const clusterIdx = clusterOrder[slot];
    const day = sortedDays[slot];
    const pts = clusterPoints[clusterIdx];
    const pls = clusterPlaces[clusterIdx];
    const localOrder = orderStops(pts);

    const stops: PlannedStop[] = localOrder.map((localIdx, orderIdx) => ({
      placeId: pls[localIdx].id,
      order: orderIdx,
      startTime: addMinutes(config.dayStartTime, orderIdx * stepMinutes),
      durationMin: config.avgMinutesPerStop,
    }));

    plans.push({ dayId: day.id, date: day.date, city: day.city, stops });
  }
  return plans;
}

// ---- Balanced k-means -------------------------------------------------

/** Fixed seed so clustering is 100% reproducible across runs. */
const KMEANS_SEED = 0x5eed42;

/** Deterministic seeded PRNG (mulberry32), returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means++ seeding: spreads initial centers out, weighted by distance^2. */
function kMeansPlusPlusSeeds(points: GeoPoint[], k: number, rng: () => number): GeoPoint[] {
  const centers: GeoPoint[] = [];
  const firstIdx = Math.floor(rng() * points.length) % points.length;
  centers.push({ ...points[firstIdx] });

  while (centers.length < k) {
    const dists = points.map((p) => {
      let best = Infinity;
      for (const c of centers) best = Math.min(best, squaredDist(p, c));
      return best;
    });
    const total = dists.reduce((s, d) => s + d, 0);

    if (total === 0) {
      // All points coincide with existing centers; pick the next one deterministically.
      centers.push({ ...points[centers.length % points.length] });
      continue;
    }

    let r = rng() * total;
    let chosen = points.length - 1;
    for (let i = 0; i < points.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    centers.push({ ...points[chosen] });
  }
  return centers;
}

/**
 * Balanced per-cluster capacities that sum to exactly `n`:
 *  - if the cap can hold everyone (n <= k*cap), distribute as evenly as
 *    possible (base / base+1), which always stays within cap.
 *  - otherwise overflow is unavoidable; dump the excess onto a single
 *    cluster rather than spreading a small overage across every day.
 */
function computeCapacities(n: number, k: number, cap: number): number[] {
  const capacities = new Array<number>(k).fill(cap);
  const totalCap = k * cap;
  if (n <= totalCap) {
    const base = Math.floor(n / k);
    const rem = n % k;
    return capacities.map((_, i) => (i < rem ? base + 1 : base));
  }
  const overflow = n - totalCap;
  capacities[k - 1] += overflow;
  return capacities;
}

/** Assign every point to the nearest cluster that still has capacity. */
function assignPoints(points: GeoPoint[], centers: GeoPoint[], capacities: number[]): number[] {
  const n = points.length;
  const sizes = new Array<number>(centers.length).fill(0);
  const assignment = new Array<number>(n).fill(0);

  // Process points "farthest-from-any-center first" so outliers claim their
  // preferred cluster before capacity runs out; deterministic index tie-break.
  const order = points
    .map((p, i) => {
      let best = Infinity;
      for (const c of centers) best = Math.min(best, squaredDist(p, c));
      return { i, best };
    })
    .sort((a, b) => b.best - a.best || a.i - b.i)
    .map((o) => o.i);

  for (const i of order) {
    const p = points[i];
    const ranked = centers
      .map((c, ci) => ({ ci, d: squaredDist(p, c) }))
      .sort((a, b) => a.d - b.d || a.ci - b.ci);

    let chosen = -1;
    for (const r of ranked) {
      if (sizes[r.ci] < capacities[r.ci]) {
        chosen = r.ci;
        break;
      }
    }
    if (chosen === -1) {
      // Defensive fallback (should be unreachable: capacities sum to n) —
      // pick the least-full cluster.
      chosen = ranked[0].ci;
      for (const r of ranked) if (sizes[r.ci] < sizes[chosen]) chosen = r.ci;
    }
    sizes[chosen] += 1;
    assignment[i] = chosen;
  }
  return assignment;
}

/**
 * Balanced k-means: k-means++ seeding + Lloyd iteration with a hard
 * per-cluster capacity. Deterministic for a given input (fixed RNG seed).
 * Returns the cluster index per point plus the effective cluster count
 * (kEff = min(k, n) — no empty clusters are ever produced).
 */
function balancedKMeans(
  points: GeoPoint[],
  k: number,
  cap: number,
): { assignment: number[]; k: number } {
  const n = points.length;
  if (n === 0) return { assignment: [], k: 0 };

  const kEff = Math.max(1, Math.min(k, n));
  if (kEff === 1) return { assignment: points.map(() => 0), k: 1 };

  const rng = mulberry32(KMEANS_SEED);
  let centers = kMeansPlusPlusSeeds(points, kEff, rng);
  const capacities = computeCapacities(n, kEff, cap);

  let assignment = new Array<number>(n).fill(-1);
  const maxIterations = 15;
  for (let iter = 0; iter < maxIterations; iter++) {
    const newAssignment = assignPoints(points, centers, capacities);
    const changed = newAssignment.some((c, i) => c !== assignment[i]);
    assignment = newAssignment;

    const sums = Array.from({ length: kEff }, () => ({ lat: 0, lng: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
      const c = assignment[i];
      sums[c].lat += points[i].lat;
      sums[c].lng += points[i].lng;
      sums[c].count += 1;
    }
    centers = sums.map((s, idx) => (s.count > 0 ? { lat: s.lat / s.count, lng: s.lng / s.count } : centers[idx]));

    if (!changed) break;
  }
  return { assignment, k: kEff };
}

// ---- Within-day ordering: nearest-neighbor + 2-opt --------------------

/**
 * Order a cluster's points into a visiting sequence: nearest-neighbor
 * starting from the point farthest from the cluster centroid (the
 * "outermost" point), then locally improved with 2-opt.
 * Returns indices into `pts` in visiting order.
 */
function orderStops(pts: GeoPoint[]): number[] {
  const n = pts.length;
  if (n <= 1) return pts.map((_, i) => i);

  const center = centroid(pts);
  let startIdx = 0;
  let maxD = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = haversineMeters(pts[i], center);
    if (d > maxD) {
      maxD = d;
      startIdx = i;
    }
  }

  const visited = new Array<boolean>(n).fill(false);
  const order: number[] = [startIdx];
  visited[startIdx] = true;
  for (let step = 1; step < n; step++) {
    const last = order[order.length - 1];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const d = haversineMeters(pts[last], pts[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    order.push(best);
    visited[best] = true;
  }

  return twoOpt(order, pts);
}

/** Standard open-path 2-opt local search over haversine distance. */
function twoOpt(initial: number[], pts: GeoPoint[]): number[] {
  let order = [...initial];
  const n = order.length;
  if (n < 4) return order;

  let improved = true;
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard++;
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        const a = order[i];
        const b = order[i + 1];
        const c = order[j];
        const d = order[j + 1];
        const before = haversineMeters(pts[a], pts[b]) + haversineMeters(pts[c], pts[d]);
        const after = haversineMeters(pts[a], pts[c]) + haversineMeters(pts[b], pts[d]);
        if (after + 1e-9 < before) {
          const reversed = order.slice(i + 1, j + 1).reverse();
          order = [...order.slice(0, i + 1), ...reversed, ...order.slice(j + 1)];
          improved = true;
        }
      }
    }
  }
  return order;
}

// ---- Time helpers -------------------------------------------------------

/** Add `minutes` to an "HH:MM" 24h time string. */
function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
