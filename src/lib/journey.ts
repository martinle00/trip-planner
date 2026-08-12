// ============================================================================
// The journey: the trip's legs (`Trip.cities`) and the `Day` rows derived from
// them. Pure functions only — nothing here reads or writes a repository; the
// store (`editJourney`) applies what these compute.
//
// `Day` is ALMOST a pure function of the leg list: one day per date in each
// base leg's `[arrive, depart)`, with day-trip legs overriding their parent's
// day on their own date. That is exactly what `buildSeed()` does.
//
// The part that isn't derivable is `Day.id`, and it is load-bearing — both
// `ItineraryItem.dayId` and `Place.dayId` point at it. So editing the journey
// DIFFS the days against the ones that already exist; it never rebuilds them.
// Rebuilding regenerates every id and orphans every itinerary stop in the
// trip, which is the single easiest way to ship a broken version of this.
// ============================================================================

import type { City, Day, Expense, ID, ItineraryItem, Place } from '../data/schema';
import { addDaysISO, daysBetweenISO } from './dates';

// ---------------------------------------------------------------------------
// Leg helpers
// ---------------------------------------------------------------------------

/** Base legs (the ones that consume calendar days), in trip order. */
export function baseLegs(cities: City[]): City[] {
  return cities.filter((c) => !c.parentCity).sort((a, b) => a.order - b.order);
}

/** Day-trip legs hanging off `legName`. */
export function dayTripsOf(cities: City[], legName: string): City[] {
  return cities.filter((c) => c.parentCity === legName).sort((a, b) => a.order - b.order);
}

/** `order` renumbered 1..n over the whole list, preserving relative order and
 *  keeping every day-trip leg immediately after its parent — the route strip
 *  and the Itinerary tab both render in `order`, so a day trip that drifts
 *  away from its parent reads as a separate leg of the trip. */
export function recompactOrder(cities: City[]): City[] {
  const sorted = [...cities].sort((a, b) => a.order - b.order);
  const out: City[] = [];
  for (const leg of sorted.filter((c) => !c.parentCity)) {
    out.push(leg);
    out.push(...sorted.filter((c) => c.parentCity === leg.name));
  }
  // Day trips whose parent is gone would otherwise be dropped silently here.
  // They can't survive the parent's removal (see `removeLeg`), but a
  // hand-edited import could still carry one — keep it rather than vanish it.
  for (const orphan of sorted) {
    if (!out.includes(orphan)) out.push(orphan);
  }
  return out.map((c, i) => ({ ...c, order: i + 1 }));
}

/**
 * Re-chain every leg's `arrive`/`depart` from `startDate`.
 *
 * Legs are contiguous by construction — each base leg's `depart` is the next
 * one's `arrive`, exactly as `buildSeed()` lays them out — so a leg spanning
 * N nights occupies N days and the whole trip's length is the sum of its
 * legs'. This is why the UI edits *nights* and shows dates read-only: the
 * alternative (independent per-leg dates) makes "cut the trip to 12 nights"
 * nine separate date-picker edits, most of which are briefly invalid.
 *
 * Day-trip legs consume no calendar. Each keeps its OFFSET into its parent
 * (Wulong on the parent's 2nd day stays on the parent's 2nd day) rather than
 * its absolute date, clamped into the parent's new span so shortening a leg
 * can't strand its day trip outside it. A parent with no days left keeps the
 * day trip pinned to its arrival date; `removeLeg`/`setLegNights` are what
 * stop that state being reachable from the UI.
 */
export function chainLegDates(cities: City[], startDate: string): City[] {
  const bases = baseLegs(cities);
  const rechained = new Map<string, City>();

  let cursor = startDate;
  for (const leg of bases) {
    const nights = Math.max(0, Math.floor(leg.nights));
    const arrive = cursor;
    const depart = addDaysISO(arrive, nights);
    rechained.set(leg.name, { ...leg, nights, arrive, depart });
    cursor = depart;
  }

  return cities.map((city) => {
    if (!city.parentCity) return rechained.get(city.name) ?? city;

    const oldParent = cities.find((c) => c.name === city.parentCity);
    const newParent = rechained.get(city.parentCity);
    if (!oldParent || !newParent) return city;

    const offset = daysBetweenISO(oldParent.arrive, city.arrive);
    const clamped = Math.min(Math.max(offset, 0), Math.max(newParent.nights - 1, 0));
    const arrive = addDaysISO(newParent.arrive, clamped);
    return { ...city, nights: 0, arrive, depart: addDaysISO(arrive, 1) };
  });
}

/** The trip's own `startDate`/`endDate`, which are always just the first and
 *  last base leg's edges — never stored independently of the legs. */
export function tripSpan(cities: City[], fallbackStart: string): { startDate: string; endDate: string } {
  const bases = baseLegs(cities);
  if (bases.length === 0) return { startDate: fallbackStart, endDate: fallbackStart };
  return { startDate: bases[0].arrive, endDate: bases[bases.length - 1].depart };
}

/** Total nights across every base leg (day trips contribute none). */
export function totalNights(cities: City[]): number {
  return baseLegs(cities).reduce((sum, c) => sum + c.nights, 0);
}

// ---------------------------------------------------------------------------
// Leg operations — each is `City[] -> City[]`, already re-chained
// ---------------------------------------------------------------------------

/**
 * Remove a leg. Removing a base leg takes its day trips with it — a day trip
 * is a leg OF its parent and has nowhere to hang otherwise.
 *
 * The trip's START DATE is preserved, including when the leg removed is the
 * first one: the remaining legs all shift earlier and the trip gets shorter.
 * That is the whole point of the operation — you are not also departing later
 * because you cut the first stop. "We leave three days later" is a different
 * edit, and it has its own operation (`setTripStart`).
 */
export function removeLeg(cities: City[], name: string): City[] {
  const target = cities.find((c) => c.name === name);
  if (!target) return cities;
  const start = startOf(cities);
  const doomed = new Set<string>([name]);
  if (!target.parentCity) {
    for (const child of dayTripsOf(cities, name)) doomed.add(child.name);
  }
  const kept = recompactOrder(cities.filter((c) => !doomed.has(c.name)));
  return chainLegDates(kept, start || target.arrive);
}

/**
 * Why a new leg can't be called `name`, or null if it can.
 *
 * The name is the KEY, not a label: `Day.city`, `Place.city` and `Expense.city`
 * all hold it as a plain string, and `reconcileDaysToCities` matches days by
 * `(city, ordinal)`. Two legs sharing a name would therefore share a pool of
 * days and quietly swap identities across an edit. Compared case- and
 * whitespace-insensitively because "shanghai" and "Shanghai " look identical in
 * the list and would be indistinguishable to the user, but not to the diff.
 */
export function legNameError(cities: City[], name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the city a name.';
  const key = trimmed.toLowerCase();
  if (cities.some((c) => c.name.trim().toLowerCase() === key)) {
    return `${trimmed} is already on this trip.`;
  }
  return null;
}

/**
 * Add a base leg to the end of the journey.
 *
 * **Appended, never inserted at a chosen position.** The sheet already has
 * reorder arrows, and a position picker on the add form would be a second way
 * to express the same thing — one that has to stay correct as the list it
 * refers to changes underneath it. Adding then moving is a couple of extra
 * taps at a leg count this trip will never outgrow.
 *
 * `fallbackStart` is only consulted when the journey is currently EMPTY (every
 * leg removed in the same draft), where there is no existing leg to chain from.
 *
 * Note that re-adding a leg you removed earlier re-adopts its saved places and
 * expenses — they were kept, not deleted, and match on city name. That's the
 * intended escape hatch from an accidental removal, not a coincidence.
 */
export function addLeg(
  cities: City[],
  name: string,
  nights: number,
  fallbackStart: string,
): City[] {
  const trimmed = name.trim();
  if (legNameError(cities, trimmed)) return cities;

  const start = startOf(cities) || fallbackStart;
  const added: City = {
    name: trimmed,
    order: cities.length + 1,
    nights: Math.max(0, Math.floor(nights)),
    // Placeholders — chainLegDates below computes the real span. They're never
    // observed, but a City with empty dates would be a lie if it escaped.
    arrive: start,
    depart: start,
  };
  return chainLegDates(recompactOrder([...cities, added]), start);
}

/** Set a base leg's nights, re-chaining every leg after it. Day-trip legs have
 *  no nights of their own and are left alone. */
export function setLegNights(cities: City[], name: string, nights: number): City[] {
  const target = cities.find((c) => c.name === name);
  if (!target || target.parentCity) return cities;
  const next = cities.map((c) =>
    c.name === name ? { ...c, nights: Math.max(0, Math.floor(nights)) } : c,
  );
  return chainLegDates(next, startOf(next));
}

/**
 * Move a day trip to another date within its parent leg.
 *
 * This is the ONE date in the journey the user sets directly, and it's the
 * exception that proves the rule the rest of the sheet follows: base legs are
 * contiguous, so their dates are consequences of the nights before them, but a
 * day trip consumes no calendar and floats freely inside its parent. "Wulong on
 * the Tuesday, not the Monday" is not derivable from anything else.
 *
 * CLAMPED into the parent's span rather than rejected. A date outside it is
 * silently dropped by `buildTargetDays` — no day exists to override — so the
 * day trip would vanish from the itinerary with no error anywhere. Clamping
 * turns an unreachable state into the nearest reachable one.
 */
export function setDayTripDate(cities: City[], name: string, date: string): City[] {
  const target = cities.find((c) => c.name === name);
  if (!target?.parentCity) return cities;
  const parent = cities.find((c) => c.name === target.parentCity);
  if (!parent) return cities;

  const offset = daysBetweenISO(parent.arrive, date);
  const clamped = Math.min(Math.max(offset, 0), Math.max(parent.nights - 1, 0));
  const arrive = addDaysISO(parent.arrive, clamped);
  return cities.map((c) =>
    c.name === name ? { ...c, nights: 0, arrive, depart: addDaysISO(arrive, 1) } : c,
  );
}

/** The dates a day trip hanging off `parent` is allowed to take — the parent's
 *  own days. Drives the date input's min/max so the clamp above is a backstop
 *  rather than something the user runs into. */
export function dayTripDateRange(parent: City): { min: string; max: string } {
  return { min: parent.arrive, max: addDaysISO(parent.arrive, Math.max(parent.nights - 1, 0)) };
}

/** Shift the whole trip to a new start date. */
export function setTripStart(cities: City[], startDate: string): City[] {
  return chainLegDates(cities, startDate);
}

/**
 * Move a base leg to a new position among the base legs (0-indexed). Day-trip
 * legs travel with their parent and are never reordered independently —
 * `recompactOrder` re-seats them.
 */
export function moveLeg(cities: City[], name: string, toIndex: number): City[] {
  const bases = baseLegs(cities);
  const from = bases.findIndex((c) => c.name === name);
  if (from < 0) return cities;
  const to = Math.min(Math.max(toIndex, 0), bases.length - 1);
  if (to === from) return cities;
  const start = startOf(cities);

  const reordered = [...bases];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);

  const ranked = new Map(reordered.map((c, i) => [c.name, i]));
  const next = recompactOrder(
    cities.map((c) => {
      const key = c.parentCity ?? c.name;
      // Day trips inherit their parent's rank so they sort alongside it;
      // `recompactOrder` then renumbers everything contiguously.
      return { ...c, order: (ranked.get(key) ?? 0) * 2 + (c.parentCity ? 1 : 0) };
    }),
  );
  return chainLegDates(next, start);
}

function startOf(cities: City[]): string {
  return baseLegs(cities)[0]?.arrive ?? '';
}

// ---------------------------------------------------------------------------
// The day diff
// ---------------------------------------------------------------------------

/** A day as the leg list implies it, before it's matched to a real row. */
interface TargetDay {
  date: string;
  city: string;
  parentCity?: string;
}

/** Every day the leg list calls for, ascending, with day-trip overrides
 *  applied. Mirrors `buildSeed()`'s construction exactly. */
export function buildTargetDays(cities: City[]): TargetDay[] {
  const days: TargetDay[] = [];
  for (const leg of baseLegs(cities)) {
    for (let i = 0; i < leg.nights; i++) {
      days.push({ date: addDaysISO(leg.arrive, i), city: leg.name });
    }
  }
  for (const trip of cities.filter((c) => c.parentCity)) {
    const slot = days.find((d) => d.date === trip.arrive && d.city === trip.parentCity);
    // A day trip whose date doesn't land on one of its parent's days is
    // dropped rather than inserted loose: it would otherwise create a day
    // outside every leg's span, which nothing in the UI can render.
    if (slot) {
      slot.city = trip.name;
      slot.parentCity = trip.parentCity;
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export interface DayDiff {
  create: Day[];
  update: Day[];
  delete: Day[];
}

/**
 * Match the days the leg list calls for against the ones that already exist,
 * preserving `Day.id` wherever a day survives the edit.
 *
 * **Matched by `(city, ordinal within that city)`, never by date.** Matching
 * on date looks simpler and is quietly catastrophic: shortening Shanghai by
 * two nights shifts the date of every later leg, so a date-keyed match would
 * delete and recreate every remaining day of the trip — discarding the whole
 * itinerary in an edit that was supposed to touch one leg. Ordinal matching
 * means "Chongqing day 2" keeps its id and its stops wherever it lands on the
 * calendar, which is what the user means by moving a leg.
 *
 * Keying on `city` (rather than the parent leg) also keeps a day trip attached
 * to its own stops when it slides within its parent: the Wulong day stays the
 * Wulong day instead of swapping identities with the Chongqing day it passed.
 *
 * A leg rename is NOT inferrable from this diff — under city-keyed matching it
 * reads as "every day of A deleted, every day of B created". Renaming is a
 * separate explicit operation that rewrites `Day.city` along with
 * `Place.city`/`Expense.city`; see `useTripStore.renameLeg`.
 */
export function reconcileDaysToCities(
  cities: City[],
  existingDays: Day[],
  tripId: ID,
  newId: () => ID,
): DayDiff {
  const byCity = new Map<string, Day[]>();
  for (const day of [...existingDays].sort((a, b) => a.date.localeCompare(b.date))) {
    const list = byCity.get(day.city);
    if (list) list.push(day);
    else byCity.set(day.city, [day]);
  }

  const diff: DayDiff = { create: [], update: [], delete: [] };
  const consumed = new Set<ID>();

  const targets = buildTargetDays(cities);
  const takenPerCity = new Map<string, number>();
  for (const target of targets) {
    const taken = takenPerCity.get(target.city) ?? 0;
    takenPerCity.set(target.city, taken + 1);
    const match = byCity.get(target.city)?.[taken];

    if (!match) {
      diff.create.push({ id: newId(), tripId, ...target });
      continue;
    }
    consumed.add(match.id);
    if (match.date !== target.date || match.parentCity !== target.parentCity) {
      diff.update.push({ ...match, date: target.date, parentCity: target.parentCity });
    }
  }

  for (const day of existingDays) {
    if (!consumed.has(day.id)) diff.delete.push(day);
  }
  return diff;
}

// ---------------------------------------------------------------------------
// The full edit, including what the deleted days drag with them
// ---------------------------------------------------------------------------

export interface JourneyEditPlan {
  cities: City[];
  days: DayDiff;
  /** Stops on a deleted day. Deleted EXPLICITLY, client-side — see below. */
  itineraryToDelete: ItineraryItem[];
  /** Places that were assigned to a deleted day, unassigned back to wishlist. */
  placesToUnassign: Place[];
  /** Places whose city is no longer a leg. Left exactly as they are — listed
   *  only so the confirm dialog can say how many, and so the Places tab knows
   *  to expect them in its "Not on this trip" group. */
  orphanedPlaces: Place[];
  /** Expenses whose city is no longer a leg. Also left alone — they already
   *  render as "Whole trip" (see `Expense.city`'s orphan tolerance). */
  orphanedExpenses: Expense[];
}

/**
 * Everything an edit to the leg list implies, computed in one pass so the
 * store can write it as a single batch and the UI can state the blast radius
 * before the user commits.
 *
 * The cascade is spelled out here rather than left to the database ON PURPOSE.
 * Postgres already cascades — `itinerary.day_id ... on delete cascade` and
 * `places.day_id ... on delete set null` (0001_init.sql) — and Dexie has no
 * foreign keys at all, so relying on the DB would leave the local cache and
 * the remote holding different data after the same edit, which nothing in the
 * UI would ever surface. Doing it explicitly makes the Postgres cascade a
 * no-op safety net instead of a second, invisible implementation.
 *
 * Orphaned itinerary rows are the failure mode worth naming: `listAllItinerary`
 * filters `anyOf(dayIds)`, so a stop whose day is gone doesn't error — it
 * silently never loads again while sitting in the table forever.
 */
export function planJourneyEdit(input: {
  nextCities: City[];
  tripId: ID;
  days: Day[];
  places: Place[];
  itinerary: ItineraryItem[];
  expenses: Expense[];
  newId: () => ID;
}): JourneyEditPlan {
  const { nextCities, tripId, days, places, itinerary, expenses, newId } = input;
  const cities = recompactOrder(nextCities);
  const diff = reconcileDaysToCities(cities, days, tripId, newId);

  const deletedDayIds = new Set(diff.delete.map((d) => d.id));
  const itineraryToDelete = itinerary.filter((item) => deletedDayIds.has(item.dayId));

  // A place is unassigned when the day it sits on disappears, or when the only
  // stop linking it to a day is being deleted. `status` follows `dayId` — the
  // same invariant `reconcilePlaceDaysToItinerary` maintains on load.
  const survivingStopDayIds = new Map<ID, ID>();
  for (const item of itinerary) {
    if (!item.placeId || deletedDayIds.has(item.dayId)) continue;
    if (!survivingStopDayIds.has(item.placeId)) survivingStopDayIds.set(item.placeId, item.dayId);
  }
  const placesToUnassign = places
    .filter((p) => p.dayId && deletedDayIds.has(p.dayId) && !survivingStopDayIds.has(p.id))
    .map((p) => ({ ...p, dayId: undefined, status: 'wishlist' as const }));

  const legNames = new Set(cities.map((c) => c.name));
  return {
    cities,
    days: diff,
    itineraryToDelete,
    placesToUnassign,
    orphanedPlaces: places.filter((p) => !legNames.has(p.city)),
    orphanedExpenses: expenses.filter((e) => e.city !== undefined && !legNames.has(e.city)),
  };
}
