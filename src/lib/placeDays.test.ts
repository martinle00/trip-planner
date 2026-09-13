import { describe, expect, it } from 'vitest';
import type { Day, ItineraryItem } from '../data/schema';
import { buildPlaceDayIndex, sameDaySet, sortDayIds } from './placeDays';

const day = (id: string, date: string): Day => ({ id, tripId: 't', date, city: 'Shanghai' });
const stop = (id: string, dayId: string, placeId?: string): ItineraryItem => ({ id, dayId, placeId, title: id, order: 0 });

describe('buildPlaceDayIndex', () => {
  it('lists every day a place has a stop on, by date, once each', () => {
    const days = [day('d1', '2026-11-09'), day('d2', '2026-11-10')];
    const index = buildPlaceDayIndex(
      {
        d2: [stop('a', 'd2', 'p1'), stop('b', 'd2', 'p1')],
        d1: [stop('c', 'd1', 'p1'), stop('d', 'd1')],
      },
      days,
    );
    expect(index.get('p1')).toEqual(['d1', 'd2']);
    expect(index.size).toBe(1);
  });
});

describe('sortDayIds / sameDaySet', () => {
  it('sorts known days by date and unknown ones last', () => {
    const dateOf = new Map([['d1', '2026-11-10'], ['d2', '2026-11-09']]);
    expect(sortDayIds(['zz', 'd1', 'd2', 'd1'], dateOf)).toEqual(['d2', 'd1', 'zz']);
  });

  it('compares as sets', () => {
    expect(sameDaySet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameDaySet(['a'], ['a', 'b'])).toBe(false);
  });
});
