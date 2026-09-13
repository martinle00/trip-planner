// A place can span several days — a theme park you go back to, a hotel you
// sleep in for a whole leg. The itinerary already allows it (one linked stop
// per day); this is the one place that turns "stops that link a place" into
// "the days that place is on", so no reader re-derives it from `Place.dayId`,
// which only ever names ONE of them (see reconcilePlaceDays.ts).

import type { Day, ID, ItineraryItem } from '../data/schema';

/**
 * placeId -> the ids of every day with a stop linked to it, sorted by date
 * (ids of days not in `days` sort last, by id), without duplicates. A place
 * with no linked stop has no entry.
 */
export function buildPlaceDayIndex(itineraryByDay: Record<ID, ItineraryItem[]>, days: Day[]): Map<ID, ID[]> {
  const dateOf = new Map(days.map((d) => [d.id, d.date]));
  const sets = new Map<ID, Set<ID>>();
  for (const [dayId, items] of Object.entries(itineraryByDay)) {
    for (const item of items) {
      if (!item.placeId) continue;
      const set = sets.get(item.placeId) ?? new Set<ID>();
      set.add(item.dayId ?? dayId);
      sets.set(item.placeId, set);
    }
  }
  const index = new Map<ID, ID[]>();
  for (const [placeId, set] of sets) index.set(placeId, sortDayIds([...set], dateOf));
  return index;
}

/** Day ids in chronological order, unknown days last. */
export function sortDayIds(dayIds: ID[], dateOf: Map<ID, string>): ID[] {
  return [...new Set(dayIds)].sort((a, b) => {
    const da = dateOf.get(a);
    const db = dateOf.get(b);
    if (da && db) return da.localeCompare(db) || a.localeCompare(b);
    if (da) return -1;
    if (db) return 1;
    return a.localeCompare(b);
  });
}

/** Whether two day-id lists name the same days, ignoring order. */
export function sameDaySet(a: ID[], b: ID[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((id) => sb.has(id));
}
