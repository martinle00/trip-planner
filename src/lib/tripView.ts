// ============================================================================
// View-model helpers: pure functions that turn the store's flat data
// (trip.cities, days, places, itineraryByDay) into the groupings/labels the
// mockup shows (day colors, "Day N · Mon 10 Nov" labels, per-city sections,
// itinerary nesting for day-trip legs). Frontend-owned; reads store types
// only, never mutates them.
// ============================================================================

import type { City, Day, ID, Place, Trip } from '../data/schema';
import { fmtRange, fmtWeekdayDayMonth } from './dates';
import { centroid } from './geo';
import type { GeoPoint } from './geo';

/** Categorical per-day palette (grey is reserved for "unassigned"). */
export const DAY_PALETTE = [
  '--d-blue', '--d-amber', '--d-moss', '--d-plum',
  '--d-teal', '--d-terra', '--d-indigo', '--d-olive',
];
export const UNASSIGNED_COLOR = 'var(--d-grey)';

/** Stable color per day, assigned in chronological order across the whole trip. */
export function buildDayColorMap(days: Day[]): Map<ID, string> {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const map = new Map<ID, string>();
  sorted.forEach((d, i) => map.set(d.id, `var(${DAY_PALETTE[i % DAY_PALETTE.length]})`));
  return map;
}

export function dayColor(dayId: ID | undefined, colorMap: Map<ID, string>): string {
  if (!dayId) return UNASSIGNED_COLOR;
  return colorMap.get(dayId) ?? UNASSIGNED_COLOR;
}

/** Days belonging to a given city name (exact `Day.city` match), sorted by date. */
export function daysForCity(days: Day[], cityName: string): Day[] {
  return days
    .filter((d) => d.city === cityName)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function dayOrdinal(day: Day, cityDays: Day[]): number {
  return cityDays.findIndex((d) => d.id === day.id) + 1;
}

/**
 * Human label for a day, consistent across Map chips / Itinerary headers /
 * pin details:
 *  - a day-trip leg (parentCity set) → "Day trip · Mon 10 Nov"
 *  - a city with >1 calendar day → "Day 2 · Mon 10 Nov" (ordinal within that city)
 *  - a single-day city → "Mon 10 Nov"
 */
export function dayLabel(day: Day, cityDays: Day[]): string {
  const dm = fmtWeekdayDayMonth(day.date);
  if (day.parentCity) return `Day trip · ${dm}`;
  if (cityDays.length > 1) return `Day ${dayOrdinal(day, cityDays)} · ${dm}`;
  return dm;
}

export interface CityGroup {
  city: City;
  places: Place[];
}

/** Places grouped by every trip leg (incl. day-trip legs), in `City.order`. */
export function groupPlacesByCity(places: Place[], cities: City[]): CityGroup[] {
  const ordered = [...cities].sort((a, b) => a.order - b.order);
  return ordered.map((city) => ({
    city,
    places: places.filter((p) => p.city === city.name),
  }));
}

export interface ItineraryDayRow {
  day: Day;
  nested: boolean;
}

export interface ItineraryCitySection {
  city: City;
  range: string;
  days: ItineraryDayRow[];
  /** This city's own (non-day-trip) days — used to compute "Day N" ordinals. */
  ownDays: Day[];
}

/**
 * Group days for the Itinerary tab: one section per *base* leg (cities
 * without `parentCity`), with any day-trip days whose `Day.parentCity`
 * points at that leg nested inline at the correct date position.
 */
export function buildItinerarySections(trip: Trip, days: Day[]): ItineraryCitySection[] {
  const baseCities = trip.cities.filter((c) => !c.parentCity).sort((a, b) => a.order - b.order);
  return baseCities.map((city) => {
    const ownDays = days
      .filter((d) => d.city === city.name && !d.parentCity)
      .sort((a, b) => a.date.localeCompare(b.date));
    const childDays = days.filter((d) => d.parentCity === city.name);
    const merged: ItineraryDayRow[] = [
      ...ownDays.map((day) => ({ day, nested: false })),
      ...childDays.map((day) => ({ day, nested: true })),
    ].sort((a, b) => a.day.date.localeCompare(b.day.date));
    return { city, range: fmtRange(city.arrive, city.depart), days: merged, ownDays };
  });
}

/** All city names in trip order (used for the map/route-strip city chips). */
export function orderedCities(trip: Trip | undefined): City[] {
  if (!trip) return [];
  return [...trip.cities].sort((a, b) => a.order - b.order);
}

const CATEGORY_ICON: Record<string, string> = {
  landmark: 'cat-landmark',
  sightseeing: 'cat-landmark',
  garden: 'cat-garden',
  museum: 'cat-museum',
  market: 'cat-market',
  'street / market': 'cat-market',
  shopping: 'cat-shopping',
  nature: 'cat-nature',
  wildlife: 'cat-nature',
  'theme park': 'cat-entertainment',
  entertainment: 'cat-entertainment',
  food: 'cat-food',
};

export function categoryIcon(category?: string): string {
  if (!category) return 'pin';
  return CATEGORY_ICON[category.toLowerCase()] ?? 'pin';
}

/** Canonical-8 icon name -> canonical category label (inverse of the subset
 * of `CATEGORY_ICON` that maps onto a canonical category). */
const ICON_TO_CANONICAL_CATEGORY: Record<string, string> = {
  'cat-landmark': 'Landmark',
  'cat-garden': 'Garden',
  'cat-museum': 'Museum',
  'cat-market': 'Street / Market',
  'cat-shopping': 'Shopping',
  'cat-nature': 'Nature',
  'cat-entertainment': 'Entertainment',
  'cat-food': 'Food',
};

/**
 * Canonical category group for a (possibly legacy/free-text) place category,
 * via the same icon-alias mapping `categoryIcon` uses — e.g. 'Sightseeing'
 * and 'Wildlife' group under 'Landmark' and 'Nature' respectively. Lets the
 * Places-tab category filter (which only offers the canonical 8) still match
 * pre-canonical seeded/imported data instead of silently omitting it.
 * Returns undefined for a missing or unrecognized category (never matches a
 * specific filter chip, same as `categoryIcon`'s 'pin' fallback).
 */
export function categoryGroup(category?: string): string | undefined {
  if (!category) return undefined;
  const icon = CATEGORY_ICON[category.toLowerCase()];
  return icon ? ICON_TO_CANONICAL_CATEGORY[icon] : undefined;
}

/** The canonical 8 place categories offered anywhere the user picks one (the
 * Add Place modal, the Places-tab category filter). Older seeded/imported
 * places may carry a free-text category outside this list (e.g.
 * 'Sightseeing', 'Wildlife') — `categoryIcon` still resolves an icon for
 * those via aliasing, they just won't match a specific filter chip. */
export const PLACE_CATEGORIES = [
  'Landmark', 'Nature', 'Garden', 'Museum', 'Street / Market', 'Shopping', 'Food', 'Entertainment',
];

/** Per-city accent palette for the Places tab (section left-border + dot),
 * distinct from the per-day palette so the two color vocabularies never
 * collide. Cycled by `City.order` across however many legs render. */
export const CITY_ACCENT_PALETTE = [
  '--d-rose', '--d-blue', '--d-sky', '--d-terra', '--d-moss', '--d-plum', '--d-indigo', '--d-violet',
];

/** Stable accent color for a city section, keyed by its `City.order`. */
export function cityAccentColor(order: number): string {
  const idx = ((order - 1) % CITY_ACCENT_PALETTE.length + CITY_ACCENT_PALETTE.length) % CITY_ACCENT_PALETTE.length;
  return `var(${CITY_ACCENT_PALETTE[idx]})`;
}

export const EXPENSE_CATEGORIES = [
  'Accommodation', 'Transport', 'Food', 'Attractions', 'Shopping', 'Other',
];

// Singapore is the only non-China leg of this trip; every other city on the
// itinerary pays in the trip's own currency (`Trip.tripCurrency`, e.g.
// 'CNY'). Falls back to the trip's home currency for "Whole trip" expenses
// (flights, etc.) or a city that isn't in the trip.
const CITY_CURRENCY_OVERRIDES: Record<string, string> = { Singapore: 'SGD' };

/** Default expense currency for the given city — the Budget tab's
 *  add-expense form defaults to what you'd actually pay in at that city
 *  (not the trip's home currency, since almost every expense here is paid
 *  in the trip currency or SGD), while staying freely overridable. */
export function defaultCurrencyForCity(city: string | undefined, trip: Trip): string {
  if (!city) return trip.homeCurrency;
  if (city in CITY_CURRENCY_OVERRIDES) return CITY_CURRENCY_OVERRIDES[city];
  const isTripCity = trip.cities.some((c) => c.name === city);
  return isTripCity ? trip.tripCurrency : trip.homeCurrency;
}

/** Rough city-center fallbacks for the ten trip legs — used only when a place
 * is added without picking a spot on the map (e.g. the Places-tab quick-add
 * form) and that city has no existing pins to center on instead. */
const CITY_FALLBACK_CENTER: Record<string, GeoPoint> = {
  Singapore: { lat: 1.2899, lng: 103.8519 },
  Shanghai: { lat: 31.2304, lng: 121.4737 },
  Suzhou: { lat: 31.2989, lng: 120.5853 },
  Changsha: { lat: 28.2282, lng: 112.9388 },
  Zhangjiajie: { lat: 29.1274, lng: 110.4795 },
  Chongqing: { lat: 29.563, lng: 106.5516 },
  Wulong: { lat: 29.3226, lng: 107.759 },
  Chengdu: { lat: 30.5728, lng: 104.0668 },
  Guangzhou: { lat: 23.1291, lng: 113.2644 },
  Shenzhen: { lat: 22.5431, lng: 114.0579 },
};

/**
 * Best-guess coordinates for a newly added place that wasn't dropped on the
 * map: the centroid of that city's existing pins, or a static per-city
 * fallback. Lets the Places-tab quick-add form skip asking for lat/lng.
 */
export function suggestPlaceLocation(cityName: string, places: Place[]): GeoPoint {
  const existing = places.filter((p) => p.city === cityName);
  if (existing.length > 0) return centroid(existing.map((p) => ({ lat: p.lat, lng: p.lng })));
  return CITY_FALLBACK_CENTER[cityName] ?? { lat: 30, lng: 110 };
}

/** Best-effort city inference from a geocode result's formatted address
 * (e.g. "...Nanjing Rd, Huangpu District, Shanghai, China" -> "Shanghai"),
 * so the Add Place modal's City field pre-fills sensibly and stays editable.
 * Returns undefined if none of `cityNames` appear in the address text. */
export function inferCityFromAddress(address: string, cityNames: string[]): string | undefined {
  const lower = address.toLowerCase();
  return cityNames.find((name) => lower.includes(name.toLowerCase()));
}
