import { describe, expect, it } from 'vitest';
import { buildSeed } from '../data/seed';
import {
  PLACE_CATEGORIES,
  categoryGroup,
  categoryIcon,
  cityAccentColor,
  inferCityFromAddress,
  suggestPlaceLocation,
} from './tripView';

describe('categoryGroup', () => {
  it('maps every canonical category to itself', () => {
    for (const cat of PLACE_CATEGORIES) {
      expect(categoryGroup(cat)).toBe(cat);
    }
  });

  it('maps every legacy/seed category to a canonical group — none orphaned', () => {
    // Regression guard: every category actually used by the seed data must
    // resolve to one of the 8 canonical Places-tab filter chips, or a
    // seeded place silently disappears from every specific filter (only
    // matching "All categories").
    const seed = buildSeed();
    const seedCategories = new Set(seed.places.map((p) => p.category).filter(Boolean) as string[]);

    // Sanity: the seed actually exercises more than just the canonical
    // labels (i.e. this test would catch a regression, not vacuously pass).
    expect(seedCategories.size).toBeGreaterThan(0);
    const nonCanonical = [...seedCategories].filter((c) => !PLACE_CATEGORIES.includes(c));
    expect(nonCanonical.length).toBeGreaterThan(0);

    for (const category of seedCategories) {
      const group = categoryGroup(category);
      expect(group, `categoryGroup(${JSON.stringify(category)}) should not be orphaned`).toBeDefined();
      expect(PLACE_CATEGORIES).toContain(group);
    }
  });

  it('maps specific known legacy aliases explicitly', () => {
    expect(categoryGroup('Sightseeing')).toBe('Landmark');
    expect(categoryGroup('Wildlife')).toBe('Nature');
    expect(categoryGroup('Theme Park')).toBe('Entertainment');
    expect(categoryGroup('Shopping')).toBe('Shopping');
  });

  it('is case-insensitive', () => {
    expect(categoryGroup('sightseeing')).toBe('Landmark');
    expect(categoryGroup('SIGHTSEEING')).toBe('Landmark');
  });

  it('returns undefined for missing or unrecognized categories', () => {
    expect(categoryGroup(undefined)).toBeUndefined();
    expect(categoryGroup('')).toBeUndefined();
    expect(categoryGroup('Some Made Up Category')).toBeUndefined();
  });
});

describe('categoryIcon', () => {
  it('resolves an icon for every seed category (never falls through silently)', () => {
    const seed = buildSeed();
    const seedCategories = new Set(seed.places.map((p) => p.category).filter(Boolean) as string[]);
    for (const category of seedCategories) {
      expect(categoryIcon(category)).not.toBe('pin');
    }
  });

  it('falls back to the generic pin icon for unknown/missing categories', () => {
    expect(categoryIcon(undefined)).toBe('pin');
    expect(categoryIcon('Nonsense')).toBe('pin');
  });
});

describe('suggestPlaceLocation', () => {
  it('returns the centroid of existing places in that city when there are any', () => {
    const places = [
      { id: '1', tripId: 't', name: 'A', city: 'Shanghai', lat: 10, lng: 20, status: 'wishlist' as const, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', tripId: 't', name: 'B', city: 'Shanghai', lat: 20, lng: 30, status: 'wishlist' as const, updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(suggestPlaceLocation('Shanghai', places)).toEqual({ lat: 15, lng: 25 });
  });

  it('falls back to the static city center when there are no existing places', () => {
    expect(suggestPlaceLocation('Chengdu', [])).toEqual({ lat: 30.5728, lng: 104.0668 });
  });

  it('falls back to a default point for an unrecognized city with no places', () => {
    expect(suggestPlaceLocation('Nowhereville', [])).toEqual({ lat: 30, lng: 110 });
  });
});

describe('inferCityFromAddress', () => {
  const cityNames = ['Shanghai', 'Suzhou', 'Chengdu'];

  it('finds a city name contained in the address text', () => {
    expect(inferCityFromAddress('123 Nanjing Rd, Huangpu, Shanghai, China', cityNames)).toBe('Shanghai');
  });

  it('is case-insensitive', () => {
    expect(inferCityFromAddress('somewhere in SHANGHAI, china', cityNames)).toBe('Shanghai');
  });

  it('returns undefined when no known city appears in the address', () => {
    expect(inferCityFromAddress('123 Main St, Springfield', cityNames)).toBeUndefined();
  });
});

describe('cityAccentColor', () => {
  it('is stable for the same order and cycles through the palette', () => {
    expect(cityAccentColor(1)).toBe(cityAccentColor(1));
    // 8 colors in the palette — order 9 should wrap back to order 1's color.
    expect(cityAccentColor(9)).toBe(cityAccentColor(1));
  });
});
