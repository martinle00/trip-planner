import { describe, expect, it } from 'vitest';
import { buildSeed } from '../data/seed';
import type { Day } from '../data/schema';
import {
  PLACE_CATEGORIES,
  categoryGroup,
  categoryIcon,
  buildItinerarySections,
  cityAccentColor,
  dayLabel,
  daysForCity,
  daysForLeg,
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

// A day trip doesn't pause the leg it belongs to: you slept in Chongqing on
// the 21st too, so the 22nd is that leg's third day. Counting only the
// parent city's own days renumbered everything after the day trip.
describe('dayLabel — day numbering across a day trip', () => {
  const CHONGQING_LEG: Day[] = [
    { id: 'd1', tripId: 't', date: '2026-11-20', city: 'Chongqing' },
    { id: 'd2', tripId: 't', date: '2026-11-21', city: 'Wulong', parentCity: 'Chongqing' },
    { id: 'd3', tripId: 't', date: '2026-11-22', city: 'Chongqing' },
    { id: 'd4', tripId: 't', date: '2026-11-23', city: 'Chongqing' },
  ];

  it('daysForLeg includes the day-trip day; daysForCity deliberately does not', () => {
    expect(daysForLeg(CHONGQING_LEG, 'Chongqing').map((d) => d.id)).toEqual(['d1', 'd2', 'd3', 'd4']);
    expect(daysForCity(CHONGQING_LEG, 'Chongqing').map((d) => d.id)).toEqual(['d1', 'd3', 'd4']);
  });

  it('numbers the days after a day trip by their position in the leg', () => {
    const legDays = daysForLeg(CHONGQING_LEG, 'Chongqing');
    expect(dayLabel(CHONGQING_LEG[0], legDays)).toMatch(/^Day 1 · /);
    expect(dayLabel(CHONGQING_LEG[2], legDays)).toMatch(/^Day 3 · /);
    expect(dayLabel(CHONGQING_LEG[3], legDays)).toMatch(/^Day 4 · /);
  });

  it('the day-trip day itself still reads "Day trip", consuming its slot without a number', () => {
    const legDays = daysForLeg(CHONGQING_LEG, 'Chongqing');
    expect(dayLabel(CHONGQING_LEG[1], legDays)).toBe('Day trip · Sat 21 Nov');
  });

  it('buildItinerarySections exposes legDays covering own + day-trip days, in date order', () => {
    const seed = buildSeed();
    const sections = buildItinerarySections(seed.trip, seed.days);
    const chongqing = sections.find((s) => s.city.name === 'Chongqing')!;

    expect(chongqing.legDays.map((d) => d.date)).toEqual(
      [...chongqing.legDays].sort((a, b) => a.date.localeCompare(b.date)).map((d) => d.date),
    );
    expect(chongqing.legDays.some((d) => d.city === 'Wulong')).toBe(true);
    expect(chongqing.legDays.length).toBe(chongqing.ownDays.length + 1);

    // The seed's real Chongqing leg: 20th, Wulong on the 21st, then the 22nd.
    const twentySecond = chongqing.legDays.find((d) => d.date === '2026-11-22')!;
    expect(dayLabel(twentySecond, chongqing.legDays)).toMatch(/^Day 3 · /);
  });
});

describe('dayLabel — naming the day trip destination', () => {
  const WULONG: Day = {
    id: 'd2',
    tripId: 't',
    date: '2026-11-21',
    city: 'Wulong',
    parentCity: 'Chongqing',
  };

  it('names the city when asked — the Itinerary nests these under the parent city', () => {
    expect(dayLabel(WULONG, [], { withDayTripCity: true })).toBe('Day trip · Wulong · Sat 21 Nov');
  });

  it('omits it by default — on the Map the day-trip city is already the selected one', () => {
    expect(dayLabel(WULONG, [])).toBe('Day trip · Sat 21 Nov');
  });

  it('the option changes nothing for an ordinary day', () => {
    const day: Day = { id: 'd1', tripId: 't', date: '2026-11-20', city: 'Chongqing' };
    expect(dayLabel(day, [day], { withDayTripCity: true })).toBe(dayLabel(day, [day]));
  });
});
