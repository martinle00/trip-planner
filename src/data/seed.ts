// ============================================================================
// FROZEN CONTRACT (data) — the Nov 2026 China trip seed.
// `buildSeed()` returns a fresh, fully-linked snapshot. The backend seeds this
// into IndexedDB on first run (repository.seedIfEmpty). Kept pure so any stream
// can import it for tests/placeholder rendering.
// ============================================================================

import type { City, Day, Place, Trip, TripSnapshot } from './schema';

const TRIP_ID = 'trip-china-2026';

/** Enumerate ISO dates in [arrive, depart). */
function datesBetween(arrive: string, depart: string): string[] {
  const out: string[] = [];
  const d = new Date(arrive + 'T00:00:00Z');
  const end = new Date(depart + 'T00:00:00Z');
  while (d < end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Legs in chronological order. Day-trip legs carry `parentCity`.
const CITIES: City[] = [
  { name: 'Singapore',   order: 1, nights: 2, arrive: '2026-11-07', depart: '2026-11-09' },
  { name: 'Shanghai',    order: 2, nights: 6, arrive: '2026-11-09', depart: '2026-11-15' },
  { name: 'Suzhou',      order: 3, nights: 2, arrive: '2026-11-15', depart: '2026-11-17' },
  { name: 'Changsha',    order: 4, nights: 2, arrive: '2026-11-17', depart: '2026-11-19' },
  { name: 'Zhangjiajie', order: 5, nights: 1, arrive: '2026-11-19', depart: '2026-11-20' },
  { name: 'Chongqing',   order: 6, nights: 3, arrive: '2026-11-20', depart: '2026-11-23' },
  { name: 'Wulong',      order: 7, nights: 0, arrive: '2026-11-21', depart: '2026-11-22', parentCity: 'Chongqing' },
  { name: 'Chengdu',     order: 8, nights: 2, arrive: '2026-11-23', depart: '2026-11-25' },
  { name: 'Guangzhou',   order: 9, nights: 5, arrive: '2026-11-25', depart: '2026-11-30' },
  { name: 'Shenzhen',    order: 10, nights: 0, arrive: '2026-11-27', depart: '2026-11-28', parentCity: 'Guangzhou' },
];

// Dates that are day trips: date -> { city, parentCity }. These override the
// base city's day on that date.
const DAY_TRIP_OVERRIDES: Record<string, { city: string; parentCity: string }> = {
  '2026-11-21': { city: 'Wulong', parentCity: 'Chongqing' },
  '2026-11-27': { city: 'Shenzhen', parentCity: 'Guangzhou' },
};

/** Fixed "authored" timestamp for every seed place's `updatedAt`. A literal
 *  constant (not `new Date().toISOString()`) so `buildSeed()` stays a pure,
 *  deterministic function per its FROZEN CONTRACT header. */
const SEED_PLACE_UPDATED_AT = '2026-01-01T00:00:00.000Z';

/** Starter wishlist places (approx. real coordinates) so the map has content. */
const SEED_PLACES: Array<Omit<Place, 'id' | 'tripId' | 'status' | 'updatedAt'>> = [
  // Singapore
  { name: 'Marina Bay Sands',   city: 'Singapore',   lat: 1.2834,  lng: 103.8607, category: 'Landmark' },
  { name: 'Gardens by the Bay', city: 'Singapore',   lat: 1.2816,  lng: 103.8636, category: 'Sightseeing' },
  // Shanghai (tight cluster — good auto-plan demo)
  { name: 'The Bund',            city: 'Shanghai',   lat: 31.2397, lng: 121.4900, category: 'Sightseeing' },
  { name: 'Yu Garden',           city: 'Shanghai',   lat: 31.2270, lng: 121.4920, category: 'Garden' },
  { name: 'Nanjing Road',        city: 'Shanghai',   lat: 31.2340, lng: 121.4750, category: 'Shopping' },
  { name: 'Shanghai Museum',     city: 'Shanghai',   lat: 31.2286, lng: 121.4757, category: 'Museum' },
  { name: 'Oriental Pearl Tower',city: 'Shanghai',   lat: 31.2397, lng: 121.4997, category: 'Landmark' },
  // Suzhou
  { name: "Humble Administrator's Garden", city: 'Suzhou', lat: 31.3255, lng: 120.6295, category: 'Garden' },
  { name: 'Tiger Hill',          city: 'Suzhou',     lat: 31.3320, lng: 120.5760, category: 'Sightseeing' },
  // Changsha
  { name: 'Orange Isle',         city: 'Changsha',   lat: 28.1800, lng: 112.9660, category: 'Sightseeing' },
  // Zhangjiajie
  { name: 'Zhangjiajie National Forest Park', city: 'Zhangjiajie', lat: 29.3150, lng: 110.4340, category: 'Nature' },
  // Chongqing + Wulong day trip
  { name: 'Hongya Cave',         city: 'Chongqing',  lat: 29.5610, lng: 106.5770, category: 'Sightseeing' },
  { name: 'Wulong Karst',        city: 'Wulong',     lat: 29.3630, lng: 107.7500, category: 'Nature' },
  // Chengdu
  { name: 'Chengdu Panda Base',  city: 'Chengdu',    lat: 30.7330, lng: 104.1450, category: 'Wildlife' },
  { name: 'Jinli Ancient Street',city: 'Chengdu',    lat: 30.6420, lng: 104.0480, category: 'Food' },
  // Guangzhou + Shenzhen day trip
  { name: 'Canton Tower',        city: 'Guangzhou',  lat: 23.1066, lng: 113.3245, category: 'Landmark' },
  { name: 'Splendid China',      city: 'Shenzhen',   lat: 22.5350, lng: 113.9720, category: 'Theme Park' },
];

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(++seq).toString(36)}`;

/** Build a fresh, fully-linked snapshot of the seed trip. */
export function buildSeed(): TripSnapshot {
  seq = 0;

  const trip: Trip = {
    id: TRIP_ID,
    name: 'China Trip — Nov 2026',
    startDate: '2026-11-07',
    endDate: '2026-11-30',
    homeCurrency: 'AUD',
    tripCurrency: 'CNY',
    // Built-in static reference rates (home value of 1 unit of each
    // currency) so the app converts sensibly on first run, before the user
    // ever calls refreshRates(). `ratesUpdatedAt` is left undefined so the
    // UI can tell "never refreshed" apart from a live fetch.
    rates: {
      AUD: 1,
      CNY: 0.21,
      SGD: 1.13,
      USD: 1.53,
      HKD: 0.196,
    },
    ratesBase: 'AUD',
    cities: CITIES,
  };

  // Build one Day per date of each *base* (non-day-trip) leg, applying overrides.
  const days: Day[] = [];
  for (const city of CITIES) {
    if (city.parentCity) continue; // day-trip legs contribute via overrides
    for (const date of datesBetween(city.arrive, city.depart)) {
      const override = DAY_TRIP_OVERRIDES[date];
      days.push({
        id: nextId('day'),
        tripId: TRIP_ID,
        date,
        city: override ? override.city : city.name,
        parentCity: override ? override.parentCity : undefined,
      });
    }
  }

  const places: Place[] = SEED_PLACES.map((p) => ({
    ...p,
    id: nextId('place'),
    tripId: TRIP_ID,
    status: 'wishlist' as const,
    updatedAt: SEED_PLACE_UPDATED_AT,
  }));

  return {
    version: 3,
    trip,
    days,
    places,
    itinerary: [],
    expenses: [],
  };
}
