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

/**
 * A travel companion, referenced by id from `Expense.paidBy`. Deliberately an
 * `{id,name}` object rather than a bare name string — a rename shouldn't
 * strand `paidBy` references, and stable ids make reliable per-person
 * rollups possible (Phase 5). Embedded on `Trip.members`, exactly like
 * `cities`/`rates` — never a separate table.
 */
export interface TripMember {
  id: ID;
  name: string;
  /**
   * Avatar ring / member chip colour (Phase 6, item 8) — one of a small
   * FIXED set of `--m-*` design tokens (see `mockup/DESIGN-SYSTEM.md`'s
   * "Member colour palette" section), never a free/arbitrary colour value —
   * only a constrained swatch set can be pre-verified for `-soft-ink`
   * contrast in both themes. Stored as the BARE token family name, without
   * the leading `--` (e.g. `'m-denim'`, `'m-chartreuse'`), so a consumer
   * builds the actual CSS custom properties itself (`var(--${color})`,
   * `var(--${color}-soft)`, `var(--${color}-soft-ink)`) without having to
   * strip a prefix first. `undefined` means "no colour assigned" — render
   * with the neutral default ring, never a guessed/random swatch. The
   * By-person budget bar itself stays jade regardless of this field (see
   * PHASE6.md item 8) — this only colours the avatar/chip, never the bar fill.
   */
  color?: string;
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
  /**
   * Trip members/travel companions, managed from the Budget tab (Phase 5).
   * Optional/absent means "no members defined yet" — treat the same as an
   * empty array, never throw. Referenced by id from `Expense.paidBy`.
   */
  members?: TripMember[];
}

/**
 * A place the user wants to visit — a map pin.
 *
 * v2 -> v3: the single free-text `note` field was removed and split into two
 * purpose-built fields — `description` (pre-visit notes) and `selfReview`
 * (post-visit, blog-style reflection) — and a required `updatedAt` was
 * added. This is the one deliberate exception to the "additive only" rule
 * this contract otherwise holds itself to (see the file header): every
 * layer (Dexie, Supabase, export/import, store, seed) migrates in lockstep —
 * see `migratePlaceV2ToV3` in `exportImport.ts` for the shared per-record
 * transform (an old `note` is folded into `description`).
 */
export interface Place {
  id: ID;
  tripId: ID;
  name: string;
  /** Free-text pre-visit notes (e.g. things to remember before visiting). */
  description?: string;
  /** Free-text, blog-style reflection written after visiting. */
  selfReview?: string;
  /** Free-text category, e.g. 'Sightseeing', 'Food', 'Museum'. The PRIMARY
   *  category (its icon is the place's icon). Always mirrors `categories[0]`
   *  when `categories` is set — kept so older builds and pre-v7 exports,
   *  which only know this field, still read something sensible. Read both
   *  through `placeCategories`, write both through `withCategories`. */
  category?: string;
  /** Every category the place falls under, primary first (a hotel with a
   *  rooftop bar is Hotel + Food). Absent on places saved before multiple
   *  categories existed — `placeCategories` falls back to `category`. */
  categories?: string[];
  /**
   * WGS-84 position, or undefined when the place has no location yet.
   *
   * A place is deliberately allowed to exist without coordinates: a chain
   * with several branches in one city is worth capturing as a single place
   * (with the candidate branches written into `description`) and pinning
   * later, once the itinerary says which branch to actually visit. Nothing
   * fabricates a stand-in coordinate for it — a city-centroid guess would
   * put a wrong pin on the map that reads exactly like a real one.
   *
   * Consumers must treat the pair as all-or-nothing: the map skips these
   * places, `autoplan` already filters on `Number.isFinite`, and the Places
   * tab flags them as needing a location.
   */
  lat?: number;
  lng?: number;
  /** City name this place belongs to (matches a City.name, incl. day-trip cities). */
  city: string;
  status: PlaceStatus;
  /** The place's PRIMARY day: one of the days it has an itinerary stop on
   *  (the earliest, unless it was already pointing at another of them).
   *  A place can span several days — the full set is derived from the
   *  itinerary (`buildPlaceDayIndex` in lib/placeDays.ts), never stored here.
   *  This copy exists for the pin colour and is kept in step by the store. */
  dayId?: ID;
  /** Optional pasted reference URL (not scraped). */
  sourceUrl?: string;
  /** Optional formatted address, typically filled in from a geocode search
   *  result (`GeocodeResult.address` in `lib/geocode.ts`). */
  address?: string;
  /**
   * ISO date-time of the last write to this place row. Every place-mutating
   * store action refreshes this on save — it is NOT scoped only to
   * `description`/`selfReview`. Used for optimistic-concurrency conflict
   * detection when two devices sharing one account edit the same place (see
   * `TripRepository.updatePlaceIfUnchanged` and `useTripStore`'s
   * `commitPlaceDraft`, which append-merges free text on a detected
   * conflict rather than silently overwriting or prompting a merge UI).
   */
  updatedAt: string;
}

/** A `Place` known to carry coordinates — what the map, bounds fitting and
 *  any distance maths can consume without re-checking. */
export type LocatedPlace = Place & { lat: number; lng: number };

/**
 * Whether a place has a usable position. Coordinates are ALL-OR-NOTHING:
 * a half-set pair is treated as no location at all, so nothing downstream
 * ever has to reason about a place that is pinned in one axis only.
 *
 * The one predicate every consumer should use — a bare `place.lat !== undefined`
 * misses NaN, which is what a malformed import or a `Number(null)` produces.
 */
export function hasLocation(place: Place): place is LocatedPlace {
  return Number.isFinite(place.lat) && Number.isFinite(place.lng);
}

/**
 * Every category a place falls under, primary first, de-duplicated. The one
 * reader everyone should use: a place saved before `categories` existed only
 * carries `category`, and a bare `place.categories` would read as none.
 */
export function placeCategories(place: Pick<Place, 'category' | 'categories'>): string[] {
  const list = place.categories && place.categories.length > 0 ? place.categories : place.category ? [place.category] : [];
  return [...new Set(list.map((c) => c.trim()).filter(Boolean))];
}

/** Returns `place` with both category fields set from `categories` (primary
 *  first), so `category` can never disagree with `categories[0]`. */
export function withCategories<T extends object>(
  place: T,
  categories: string[],
): Omit<T, 'category' | 'categories'> & Pick<Place, 'category' | 'categories'> {
  const list = placeCategories({ categories });
  return { ...place, category: list[0], categories: list.length > 0 ? list : undefined };
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

/**
 * A trip expense, tracked in whatever currency it was actually paid in.
 *
 * v4 -> v5 (Phase 6 — expense sharing + attach-to-city): `dayId` and `itemId`
 * are REMOVED (a deliberate non-additive break, decided by the user — see
 * PHASE6.md's Decisions and trap #5's full enumerated blast radius) and
 * replaced by the coarser `city`. Nothing in the app ever queried expenses by
 * day (`DexieTripRepository` only ever filters `where('tripId')`) and nothing
 * has ever read/written `itemId` at all, so both are dropped in the same
 * sweep rather than kept as a dead/deprecated field.
 */
export interface Expense {
  id: ID;
  tripId: ID;
  category: string;
  label: string;
  /** Amount in `currency` (not necessarily the trip's home currency). */
  amount: number;
  /** ISO 4217 currency code the amount was logged in, e.g. 'CNY', 'SGD', 'AUD'. */
  currency: string;
  paid: boolean;
  /** Free-text note on the expense (Phase 5), e.g. what it was for. */
  note?: string;
  /**
   * The `TripMember.id` who paid, if tracked (Phase 5). Deliberately
   * orphan-tolerant: if the referenced member is later removed from
   * `Trip.members`, this id is left dangling rather than cascade-deleted or
   * rewritten — callers must treat a `paidBy` that no longer resolves to a
   * member as simply "unset" and render it as such (e.g. "—"), never throw.
   */
  paidBy?: ID;
  /**
   * City name this expense is attached to (Phase 6) — matches a `City.name`,
   * exactly like `Place.city`. `undefined`/absent means "Whole trip" — the
   * coarse "attach to" replacement for the removed per-day `dayId`. Same
   * orphan tolerance as `Place.city`/`paidBy`: a `city` that no longer
   * matches any current `Trip.cities` entry (e.g. the city was renamed/
   * removed) is never a hard error, just an unresolvable label.
   */
  city?: string;
  /**
   * The `TripMember.id`s this expense is shared across (Phase 6).
   * `undefined`/absent means "everyone" — so every pre-Phase-6 (v4) row is
   * already valid v5 data with this field simply absent; this is NOT the
   * same as an explicit empty array. An explicit `coversMemberIds: []` is a
   * degenerate "covers nobody" that the UI can't itself produce (deselecting
   * the last person snaps back to "everyone"), but a hand-edited or
   * externally-produced JSON import could still carry one — `parseSnapshot`
   * (exportImport.ts) normalises any such `[]` to `undefined` on import, the
   * single choke point for this rule, so no downstream reader (the By-person
   * rollup, an expense row, a future split calculation) has to defend
   * against the degenerate case independently.
   *
   * Orphan-tolerant exactly like `paidBy`: an id in this array that no
   * longer resolves to a current `Trip.members` entry is simply ignored by
   * readers, never throws, never cascade-deletes the expense or rewrites the
   * array. Removing a member must leave this field exactly as it was.
   */
  coversMemberIds?: ID[];
  /**
   * Marks this row as a REPAYMENT between two companions rather than a trip
   * cost (Phase 11). Absent/`false` = an ordinary expense, so every
   * pre-Phase-11 row is already valid data with this field simply absent.
   *
   * A transfer is written by the Settle-up card's "Mark paid" button and is
   * shaped exactly like any other expense — `paidBy` is the person who handed
   * the money over, `coversMemberIds` is the single person who received it,
   * `amount` is in the trip's home currency and `paid` is always `true`. That
   * is what makes it settle the debt with no special maths: the payer's
   * "fronted" total goes up and the recipient's "share" goes up by the same
   * amount, so the pair nets to zero through the ordinary balance formula in
   * `lib/settlement.ts`.
   *
   * THE ONE RULE EVERY OTHER READER MUST FOLLOW: a transfer is **not spending**
   * and must be excluded from every cost total — the trip total, paid/to-pay,
   * By-category, By-person, the per-currency subtotals and the expense list
   * itself. Money moving from one companion to another is not money the trip
   * consumed, and counting it would inflate the trip's spend by the size of
   * the debt. The Budget tab enforces this at a single choke point
   * (`costExpenses`) rather than in each total separately; anything new that
   * sums expenses must filter on this field too.
   *
   * Deliberately a flag on `Expense` rather than a separate `settlements`
   * table: it rides the existing repository, outbox, sync and export/import
   * paths unchanged — no new entity to queue, order on replay, or add RLS
   * policies for. See PHASE11.md.
   */
  isTransfer?: boolean;
}

/**
 * The full trip snapshot — the shape of an export/import `trip.json`.
 *
 * v1 -> v2: `Expense.amountCny` became `amount` + `currency`; `Trip.
 * cnyToHomeRate` became the multi-currency `rates` table (+ `ratesUpdatedAt`/
 * `ratesBase`).
 *
 * v2 -> v3: `Place.note` was removed in favor of `description` + `selfReview`,
 * and `Place.updatedAt` became required (see `Place`'s doc comment above).
 *
 * v3 -> v4 (Phase 5 — richer expenses): purely additive, no per-record
 * transform needed. Adds `Expense.note`, `Expense.paidBy`, and `Trip.members`
 * (`TripMember[]`) — all optional, so a v3 record is already valid v4 data
 * with those fields simply absent.
 *
 * v4 -> v5 (Phase 6 — expense sharing + attach-to-city): adds
 * `TripMember.color` (purely additive) and `Expense.coversMemberIds` (purely
 * additive — absent means "everyone", so a v4 expense is already valid v5
 * data). NOT purely additive: `Expense.dayId`/`Expense.itemId` are REMOVED
 * and replaced by `Expense.city`, which the per-record transform
 * (`migrateExpenseV4ToV5` in exportImport.ts) derives from `dayId` by
 * looking it up against the snapshot's own `days` array — a `dayId` that
 * doesn't resolve to any day in the snapshot degrades to `city: undefined`
 * ("Whole trip"), never throws.
 *
 * v5 -> v6 (Phase 11 — settle up): purely additive. Adds
 * `Expense.isTransfer` (optional, absent = an ordinary expense), so a v5
 * record is already valid v6 data with the field simply absent — no
 * per-record transform needed.
 *
 * `parseSnapshot` (exportImport.ts) accepts and migrates v1, v2, v3, v4 and
 * v5 snapshots on import (chaining v1 -> ... -> v6 for a very old export);
 * exports always write v6. `parseSnapshot` also normalises an explicit
 * `Expense.coversMemberIds: []` to `undefined` on every import, regardless of
 * the snapshot's original version — see `Expense`'s doc comment above.
 */
export interface TripSnapshot {
  version: 6;
  trip: Trip;
  days: Day[];
  places: Place[];
  itinerary: ItineraryItem[];
  expenses: Expense[];
}
