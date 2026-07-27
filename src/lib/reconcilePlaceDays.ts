// The itinerary is the source of truth for what's planned on which day.
//
// A place carries a `dayId` too, and that copy is what colours its map pin
// and fills the day dropdown on its card — but it only ever means "an
// itinerary stop put me here". When the two disagree, the itinerary wins and
// the place is corrected, never the other way round.
//
// They drift because the two sides are written by different actions and some
// of those used to update only one side (a deleted stop left its place still
// assigned; a stop moved to another day left its place on the old one). Those
// write paths are fixed, but data written before they were — or by an older
// build on another device — is still out there, so every load reconciles
// what it reads rather than trusting it.

import type { Day, ID, ItineraryItem, Place } from '../data/schema';

export interface ReconcileResult {
  /** Every place, with `dayId`/`status` agreeing with the itinerary. */
  places: Place[];
  /** Only those that actually had to change — what's worth writing back. */
  corrected: Place[];
}

/**
 * Bring `places` into agreement with `itinerary`.
 *
 * - A place with no linked stop is unassigned, whatever `dayId` it claims.
 * - A place whose `dayId` names a day it has no stop on is moved to the day
 *   it does have one on.
 * - A place with stops on several days keeps the one it already points at if
 *   that's among them; otherwise it takes the earliest (by date, falling back
 *   to a stable id order when a day is unknown), so the result never depends
 *   on object iteration order.
 *
 * `updatedAt` is deliberately left alone: this is a repair of a field that
 * was already wrong, not a user edit, and bumping it would make every device
 * that heals the same row look like it made a concurrent change.
 */
export function reconcilePlaceDaysToItinerary(
  places: Place[],
  itinerary: ItineraryItem[],
  days: Day[] = [],
): ReconcileResult {
  const dateOf = new Map(days.map((d) => [d.id, d.date]));
  const dayIdsByPlace = new Map<ID, ID[]>();
  for (const item of itinerary) {
    if (!item.placeId) continue;
    const list = dayIdsByPlace.get(item.placeId);
    if (list) list.push(item.dayId);
    else dayIdsByPlace.set(item.placeId, [item.dayId]);
  }

  const corrected: Place[] = [];
  const reconciled = places.map((place) => {
    const linked = dayIdsByPlace.get(place.id);
    let dayId: ID | undefined;
    if (linked && linked.length > 0) {
      dayId = linked.includes(place.dayId ?? '')
        ? place.dayId
        : [...linked].sort(
            (a, b) => (dateOf.get(a) ?? '').localeCompare(dateOf.get(b) ?? '') || a.localeCompare(b),
          )[0];
    }

    const status: Place['status'] = dayId ? 'planned' : 'wishlist';
    if (place.dayId === dayId && place.status === status) return place;

    const fixed: Place = { ...place, dayId, status };
    corrected.push(fixed);
    return fixed;
  });

  return { places: reconciled, corrected };
}
