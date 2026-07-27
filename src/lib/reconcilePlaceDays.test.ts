// The itinerary is the source of truth for what's planned on which day; a
// place's `dayId` is a copy of that, and when they disagree the place is the
// one that's wrong. See reconcilePlaceDays.ts.

import { describe, expect, it } from 'vitest';
import { reconcilePlaceDaysToItinerary } from './reconcilePlaceDays';
import type { Day, ItineraryItem, Place } from '../data/schema';

const DAYS: Day[] = [
  { id: 'day-1', tripId: 't', date: '2026-11-20', city: 'Chongqing' },
  { id: 'day-2', tripId: 't', date: '2026-11-22', city: 'Chongqing' },
];

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: 'p1',
    tripId: 't',
    name: 'Hongya Cave',
    city: 'Chongqing',
    lat: 29.56,
    lng: 106.57,
    status: 'wishlist',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function stop(overrides: Partial<ItineraryItem> = {}): ItineraryItem {
  return { id: 'i1', dayId: 'day-1', title: 'Hongya Cave', order: 0, ...overrides };
}

describe('reconcilePlaceDaysToItinerary', () => {
  it('unassigns a place whose stop is gone — the pin goes back to grey', () => {
    const stale = place({ dayId: 'day-1', status: 'planned' });
    const { places, corrected } = reconcilePlaceDaysToItinerary([stale], [], DAYS);

    expect(places[0].dayId).toBeUndefined();
    expect(places[0].status).toBe('wishlist');
    expect(corrected).toHaveLength(1);
  });

  it('moves a place to the day it actually has a stop on', () => {
    const stale = place({ dayId: 'day-1', status: 'planned' });
    const { places } = reconcilePlaceDaysToItinerary(
      [stale],
      [stop({ placeId: 'p1', dayId: 'day-2' })],
      DAYS,
    );

    expect(places[0].dayId).toBe('day-2');
    expect(places[0].status).toBe('planned');
  });

  it('leaves an already-agreeing place untouched, by identity', () => {
    const agreed = place({ dayId: 'day-1', status: 'planned' });
    const { places, corrected } = reconcilePlaceDaysToItinerary(
      [agreed],
      [stop({ placeId: 'p1', dayId: 'day-1' })],
      DAYS,
    );

    expect(corrected).toHaveLength(0);
    expect(places[0]).toBe(agreed);
  });

  it('fixes the status even when the day is already right', () => {
    const wrongStatus = place({ dayId: 'day-1', status: 'wishlist' });
    const { places, corrected } = reconcilePlaceDaysToItinerary(
      [wrongStatus],
      [stop({ placeId: 'p1', dayId: 'day-1' })],
      DAYS,
    );

    expect(places[0].status).toBe('planned');
    expect(corrected).toHaveLength(1);
  });

  it('keeps the current day when a place has stops on several', () => {
    const onTwo = place({ dayId: 'day-2', status: 'planned' });
    const { places, corrected } = reconcilePlaceDaysToItinerary(
      [onTwo],
      [stop({ id: 'i1', placeId: 'p1', dayId: 'day-1' }), stop({ id: 'i2', placeId: 'p1', dayId: 'day-2' })],
      DAYS,
    );

    expect(places[0].dayId).toBe('day-2');
    expect(corrected).toHaveLength(0);
  });

  it('picks the earliest day, not whichever came first in the array', () => {
    const unassigned = place();
    const later = [stop({ id: 'i1', placeId: 'p1', dayId: 'day-2' }), stop({ id: 'i2', placeId: 'p1', dayId: 'day-1' })];
    const earlier = [...later].reverse();

    expect(reconcilePlaceDaysToItinerary([unassigned], later, DAYS).places[0].dayId).toBe('day-1');
    expect(reconcilePlaceDaysToItinerary([unassigned], earlier, DAYS).places[0].dayId).toBe('day-1');
  });

  it('assigns a place that has a stop but claims no day', () => {
    const { places } = reconcilePlaceDaysToItinerary(
      [place()],
      [stop({ placeId: 'p1', dayId: 'day-1' })],
      DAYS,
    );
    expect(places[0].dayId).toBe('day-1');
  });

  it('ignores hand-written stops that link to no place', () => {
    const wishlist = place();
    const { places, corrected } = reconcilePlaceDaysToItinerary([wishlist], [stop({ title: 'Coffee' })], DAYS);

    expect(places[0]).toBe(wishlist);
    expect(corrected).toHaveLength(0);
  });

  it('does not touch updatedAt — this repairs a wrong field, it is not a user edit', () => {
    const stale = place({ dayId: 'day-1', status: 'planned' });
    const { places } = reconcilePlaceDaysToItinerary([stale], [], DAYS);
    expect(places[0].updatedAt).toBe(stale.updatedAt);
  });
});
