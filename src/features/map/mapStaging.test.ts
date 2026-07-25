import { describe, expect, it } from 'vitest';
import { citiesWithPendingChanges, crossCityHint, isPlacePending } from './mapStaging';

describe('isPlacePending', () => {
  it('is true only for a place with a staged entry', () => {
    expect(isPlacePending('place-1', { 'place-1': { dayId: 'd', city: 'Shanghai' } })).toBe(true);
    expect(isPlacePending('place-2', { 'place-1': { dayId: 'd', city: 'Shanghai' } })).toBe(false);
  });
});

describe('citiesWithPendingChanges', () => {
  it('returns the distinct set of cities with something staged', () => {
    const staged = {
      p1: { dayId: 'd1', city: 'Shanghai' },
      p2: { dayId: 'd2', city: 'Suzhou' },
      p3: { dayId: 'd3', city: 'Suzhou' },
    };
    expect(citiesWithPendingChanges(staged)).toEqual(new Set(['Shanghai', 'Suzhou']));
  });

  it('is empty when nothing is staged', () => {
    expect(citiesWithPendingChanges({})).toEqual(new Set());
  });
});

describe('crossCityHint', () => {
  it('returns null when nothing is staged anywhere else', () => {
    const staged = { p1: { dayId: 'd1', city: 'Shanghai' } };
    expect(crossCityHint(staged, 'Shanghai')).toBeNull();
  });

  it('returns null when nothing is staged anywhere', () => {
    expect(crossCityHint({}, 'Shanghai')).toBeNull();
  });

  it('returns "All changes are in X" when the current city has none of its own', () => {
    const staged = { p1: { dayId: 'd1', city: 'Suzhou' } };
    expect(crossCityHint(staged, 'Shanghai')).toBe('All changes are in Suzhou');
  });

  it('returns "+N more in X" when the current city also has some staged', () => {
    const staged = {
      p1: { dayId: 'd1', city: 'Shanghai' },
      p2: { dayId: 'd2', city: 'Suzhou' },
    };
    expect(crossCityHint(staged, 'Shanghai')).toBe('+1 more in Suzhou');
  });

  it('summarizes as "N other cities" when more than one other city has staged changes', () => {
    const staged = {
      p1: { dayId: 'd1', city: 'Suzhou' },
      p2: { dayId: 'd2', city: 'Beijing' },
    };
    expect(crossCityHint(staged, 'Shanghai')).toBe('All changes are in 2 other cities');
  });

  it('uses the "+N more" phrasing when the current city ALSO has staged changes across multiple other cities', () => {
    const staged = {
      p0: { dayId: 'd0', city: 'Shanghai' },
      p1: { dayId: 'd1', city: 'Suzhou' },
      p2: { dayId: 'd2', city: 'Beijing' },
    };
    expect(crossCityHint(staged, 'Shanghai')).toBe('+2 more in 2 other cities');
  });
});
