// Ranking for the Map tab's "find a pin" search box (MapSearch.tsx).
//
// This searches the trip's OWN saved places — it is not a geocoder. The
// geocoder lives in AddPlaceModal and answers "where is this thing in the
// world"; this answers "which of my pins did I mean", so it never touches the
// network and works offline exactly like the rest of the trip data.
//
// Two deliberate choices:
//
// - It searches the WHOLE trip, not just the city the map is showing. Picking
//   a result from another city switches the map to that city (MapPanel wires
//   that to App's `selectCity`) — otherwise the search box would answer "no
//   results" for a place the user can plainly see on the Places tab, which is
//   the most confusing possible failure.
// - Places with no coordinate are counted but never returned as matches. The
//   whole point of the box is to move the map to a pin, and an unpinned place
//   has none (see `Place.lat` in data/schema.ts). They're reported separately
//   so the UI can say so out loud instead of silently dropping them.

import type { Place, LocatedPlace } from '../../data/schema';
import { placeCategories } from '../../data/schema';
import { hasLocation } from '../../data/schema';

export const MAP_SEARCH_LIMIT = 8;

export interface PlaceSearchMatch {
  place: LocatedPlace;
  /** True when this pin lives outside the city the map is currently showing —
   *  picking it has to switch cities first, so the UI labels it. */
  otherCity: boolean;
}

export interface PlaceSearchResult {
  matches: PlaceSearchMatch[];
  /** Matched the query but has no coordinate, so the map can't go to it. */
  unlocatedCount: number;
  /** True when `matches` was cut off by `limit`. */
  truncated: boolean;
}

const EMPTY: PlaceSearchResult = { matches: [], unlocatedCount: 0, truncated: false };

/** Lower = better. The tiers exist so that typing "bund" surfaces "The Bund"
 *  above "Cafe Bundle" (whole word beats word-prefix), and so a place that
 *  merely sits in a city whose NAME contains the query lands last rather than
 *  burying the thing actually called that. */
function score(place: Place, q: string): number | null {
  const name = place.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.some((w) => w === q)) return 1;
  if (words.some((w) => w.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (placeCategories(place).some((c) => c.toLowerCase().includes(q)) || place.city.toLowerCase().includes(q)) return 4;
  return null;
}

export function searchPlaces(
  places: Place[],
  query: string,
  selectedCity: string,
  limit: number = MAP_SEARCH_LIMIT,
): PlaceSearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return EMPTY;

  const scored: { match: PlaceSearchMatch; rank: number }[] = [];
  let unlocatedCount = 0;

  for (const place of places) {
    const rank = score(place, q);
    if (rank === null) continue;
    if (!hasLocation(place)) {
      unlocatedCount++;
      continue;
    }
    scored.push({ match: { place, otherCity: place.city !== selectedCity }, rank });
  }

  scored.sort((a, b) => {
    // The city on screen first: those are the pins already in front of the
    // user, and picking one costs no city switch.
    if (a.match.otherCity !== b.match.otherCity) return a.match.otherCity ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.match.place.name.localeCompare(b.match.place.name);
  });

  return {
    matches: scored.slice(0, limit).map((s) => s.match),
    unlocatedCount,
    truncated: scored.length > limit,
  };
}
