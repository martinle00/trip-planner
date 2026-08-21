// Ranking rules for the Map tab's pin search. See placeSearch.ts for why it
// spans the whole trip and why unpinned places are counted, never returned.

import { describe, expect, it } from 'vitest';
import { searchPlaces } from './placeSearch';
import type { Place } from '../../data/schema';

function place(over: Partial<Place> & { id: string; name: string; city: string }): Place {
  return {
    tripId: 'trip-1',
    status: 'wishlist',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lat: 31.2,
    lng: 121.4,
    ...over,
  } as Place;
}

const BUND = place({ id: 'p-bund', name: 'The Bund', city: 'Shanghai', category: 'Landmark' });
const BUNDLE_CAFE = place({ id: 'p-cafe', name: 'Cafe Bundle', city: 'Shanghai', category: 'Food' });
const HUMBLE = place({ id: 'p-humble', name: 'Humble Administrator’s Garden', city: 'Suzhou', category: 'Garden' });
const NO_LOC = place({ id: 'p-noloc', name: 'Bund Sightseeing Tunnel', city: 'Shanghai', lat: undefined, lng: undefined });

const ALL = [BUND, BUNDLE_CAFE, HUMBLE, NO_LOC];

describe('searchPlaces', () => {
  it('returns nothing for an empty or whitespace query', () => {
    expect(searchPlaces(ALL, '', 'Shanghai').matches).toHaveLength(0);
    expect(searchPlaces(ALL, '   ', 'Shanghai').matches).toHaveLength(0);
  });

  it('matches on name, case-insensitively', () => {
    const { matches } = searchPlaces(ALL, 'bUnD', 'Shanghai');
    expect(matches.map((m) => m.place.id)).toEqual(['p-bund', 'p-cafe']);
  });

  it('ranks a whole-word hit above a word-prefix one', () => {
    // Neither name *starts* with "bund", so the tiebreak that decides this is
    // whole word ("The Bund") over word-prefix ("Cafe Bundle") — not the
    // alphabetical fallback, which would have put Cafe first.
    const { matches } = searchPlaces([BUNDLE_CAFE, BUND], 'bund', 'Shanghai');
    expect(matches.map((m) => m.place.id)).toEqual(['p-bund', 'p-cafe']);
  });

  it('matches on category and city as a last resort', () => {
    expect(searchPlaces(ALL, 'garden', 'Shanghai').matches.map((m) => m.place.id)).toEqual(['p-humble']);
    expect(searchPlaces(ALL, 'suzhou', 'Shanghai').matches.map((m) => m.place.id)).toEqual(['p-humble']);
  });

  it('spans the whole trip but puts the city on screen first', () => {
    const suzhouBund = place({ id: 'p-sz', name: 'Bund Replica', city: 'Suzhou' });
    const { matches } = searchPlaces([suzhouBund, BUND], 'bund', 'Shanghai');
    expect(matches.map((m) => m.place.id)).toEqual(['p-bund', 'p-sz']);
    expect(matches[0].otherCity).toBe(false);
    expect(matches[1].otherCity).toBe(true);
  });

  it('counts a matching place with no coordinate instead of returning it', () => {
    const result = searchPlaces(ALL, 'bund', 'Shanghai');
    expect(result.matches.map((m) => m.place.id)).not.toContain('p-noloc');
    expect(result.unlocatedCount).toBe(1);
  });

  it('reports truncation past the limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => place({ id: `p-${i}`, name: `Bund ${i}`, city: 'Shanghai' }));
    const result = searchPlaces(many, 'bund', 'Shanghai', 3);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(searchPlaces(many, 'bund', 'Shanghai', 5).truncated).toBe(false);
  });
});
