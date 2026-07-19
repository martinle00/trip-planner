// ============================================================================
// FROZEN CONTRACT — shared data model for the China Trip Planner.
// Every specialist agent (frontend / backend / auto-plan) codes against these
// types. Do NOT change a type's shape without coordinating — other streams
// depend on it. Additive optional fields are fine.
// ============================================================================

export type ID = string;

export type PlaceStatus = 'wishlist' | 'planned';

/** A leg of the trip. Day-trip legs (e.g. Wulong, Shenzhen) set `parentCity`. */
export interface City {
  name: string;
  order: number;
  /** Nights spent (0 for a day-trip leg). */
  nights: number;
  /** ISO date (YYYY-MM-DD) of arrival. */
  arrive: string;
  /** ISO date (YYYY-MM-DD) of departure. */
  depart: string;
  /** If set, this leg is a day trip rolled up under the named base city. */
  parentCity?: string;
}

export interface Trip {
  id: ID;
  name: string;
  /** ISO date (YYYY-MM-DD). */
  startDate: string;
  /** ISO date (YYYY-MM-DD). */
  endDate: string;
  /** e.g. 'AUD'. User-configurable — see `setHomeCurrency` in useTripStore. */
  homeCurrency: string;
  /** e.g. 'CNY'. */
  tripCurrency: string;
  /**
   * Multi-currency exchange rates, keyed by ISO 4217 currency code (e.g.
   * 'CNY', 'SGD', 'USD').
   *
   * CONVENTION: `rates[C]` is the value, in `homeCurrency`, of ONE unit of
   * currency C. Converting an amount in currency C into home currency is
   * therefore always a plain multiply — no division, no picking a
   * direction:
   *
   *   homeAmount = amount * rates[C]
   *
   * `rates[homeCurrency]` is always present and equal to `1`. A currency
   * with no entry in this map has "no known rate yet" — callers (see
   * `convert()` in `lib/exchangeRates.ts`) must treat a missing key as
   * unconvertible, never silently default it to `1` or skip it in totals
   * without surfacing that.
   *
   * "Live-convert" model: this map holds only the MOST RECENT rates (built-
   * in seed reference rates until the first `refreshRates()`, then live
   * fetched rates after). Every conversion in the app is computed on demand
   * from whatever is currently stored here — there is no historical/
   * per-expense rate snapshot, so refreshing rates changes every displayed
   * total, including for past expenses.
   */
  rates: Record<string, number>;
  /**
   * ISO date-time of the last successful `refreshRates()` fetch. `undefined`
   * means the trip is still on its built-in seed reference rates and has
   * never been refreshed from a live source — the UI should surface that
   * distinctly (e.g. "using built-in reference rates").
   */
  ratesUpdatedAt?: string;
  /**
   * The home currency `rates` was computed relative to as of the last set
   * (refresh or re-base). Normally equal to `homeCurrency`; kept separately
   * so `setHomeCurrency` can tell whether the stored rates still contain a
   * usable cross-rate to re-base from when the home currency changes.
   */
  ratesBase?: string;
  cities: City[];
}

/** A place the user wants to visit — a map pin. */
export interface Place {
  id: ID;
  tripId: ID;
  name: string;
  note?: string;
  /** Free-text category, e.g. 'Sightseeing', 'Food', 'Museum'. */
  category?: string;
  lat: number;
  lng: number;
  /** City name this place belongs to (matches a City.name, incl. day-trip cities). */
  city: string;
  status: PlaceStatus;
  /** Set when the place has been assigned to a day. */
  dayId?: ID;
  /** Optional pasted reference URL (not scraped). */
  sourceUrl?: string;
  /** Optional formatted address, typically filled in from a geocode search
   *  result (`GeocodeResult.address` in `lib/geocode.ts`). */
  address?: string;
}

/** One dated day of the trip, belonging to a city. */
export interface Day {
  id: ID;
  tripId: ID;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  city: string;
  /** If set, this day is a day trip rolled up under the named base city. */
  parentCity?: string;
}

/** A time-ordered stop within a day's itinerary. */
export interface ItineraryItem {
  id: ID;
  dayId: ID;
  /** Links back to a Place when the stop came from a pin. */
  placeId?: ID;
  title: string;
  /** "HH:MM" 24h, optional. */
  startTime?: string;
  durationMin?: number;
  note?: string;
  /** Sort order within the day (ascending). */
  order: number;
}

/** A trip expense, tracked in whatever currency it was actually paid in. */
export interface Expense {
  id: ID;
  tripId: ID;
  /** Optionally attached to a day. */
  dayId?: ID;
  /** Optionally attached to a specific itinerary item. */
  itemId?: ID;
  category: string;
  label: string;
  /** Amount in `currency` (not necessarily the trip's home currency). */
  amount: number;
  /** ISO 4217 currency code the amount was logged in, e.g. 'CNY', 'SGD', 'AUD'. */
  currency: string;
  paid: boolean;
}

/**
 * The full trip snapshot — the shape of an export/import `trip.json`.
 *
 * v1 -> v2: `Expense.amountCny` became `amount` + `currency`; `Trip.
 * cnyToHomeRate` became the multi-currency `rates` table (+ `ratesUpdatedAt`/
 * `ratesBase`). `parseSnapshot` (exportImport.ts) accepts and migrates v1
 * snapshots on import; exports always write v2.
 */
export interface TripSnapshot {
  version: 2;
  trip: Trip;
  days: Day[];
  places: Place[];
  itinerary: ItineraryItem[];
  expenses: Expense[];
}
