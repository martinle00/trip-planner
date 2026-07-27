import { describe, it, expect } from 'vitest';
import { buildSeed } from '../data/seed';
import { autoPlan, DEFAULT_AUTOPLAN_CONFIG } from './autoplan';
import type { AutoPlanConfig, DayPlan } from './autoplan';
import type { Day, Place } from '../data/schema';

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

describe('autoPlan', () => {
  it('is deterministic: same inputs produce deeply-equal output', () => {
    const seed = buildSeed();
    const a = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);
    const b = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);
    expect(a).toEqual(b);
  });

  it('does not mutate its inputs', () => {
    const seed = buildSeed();
    const placesBefore = JSON.parse(JSON.stringify(seed.places));
    const daysBefore = JSON.parse(JSON.stringify(seed.days));
    autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);
    expect(seed.places).toEqual(placesBefore);
    expect(seed.days).toEqual(daysBefore);
  });

  it("distributes Shanghai's 5 seed pins across Shanghai's days, respecting maxStopsPerDay", () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);

    const shanghaiPlaceIds = new Set(
      seed.places.filter((p) => p.city === 'Shanghai').map((p) => p.id),
    );
    expect(shanghaiPlaceIds.size).toBe(5);

    const shanghaiDayPlans = plan.filter((dp) => dp.city === 'Shanghai');
    expect(shanghaiDayPlans.length).toBeGreaterThan(0);

    const seenPlaceIds = new Set<string>();
    for (const dp of shanghaiDayPlans) {
      expect(dp.stops.length).toBeLessThanOrEqual(DEFAULT_AUTOPLAN_CONFIG.maxStopsPerDay);
      for (const stop of dp.stops) {
        expect(shanghaiPlaceIds.has(stop.placeId)).toBe(true);
        seenPlaceIds.add(stop.placeId);
      }
    }
    // Every Shanghai place ends up placed somewhere (there are enough Shanghai days).
    expect(seenPlaceIds).toEqual(shanghaiPlaceIds);
  });

  it('gives every stop a valid, increasing startTime within its day and a durationMin', () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);

    for (const dp of plan) {
      let prevMinutes = -1;
      dp.stops.forEach((stop, idx) => {
        expect(stop.order).toBe(idx);
        expect(stop.durationMin).toBe(DEFAULT_AUTOPLAN_CONFIG.avgMinutesPerStop);
        // Under the default config every stop fits inside the day, so all of
        // them are timed. A stop that didn't fit is left untimed rather than
        // carrying an out-of-range time like "25:00".
        expect(stop.startTime).toMatch(/^\d{2}:\d{2}$/);
        const minutes = timeToMinutes(stop.startTime!);
        expect(minutes).toBeGreaterThan(prevMinutes);
        expect(minutes).toBeLessThan(24 * 60);
        prevMinutes = minutes;
      });
    }
  });

  it('every returned dayId matches a real day whose city equals the plan city', () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);
    const dayById = new Map(seed.days.map((d) => [d.id, d]));

    for (const dp of plan) {
      const day = dayById.get(dp.dayId);
      expect(day).toBeDefined();
      expect(day!.city).toBe(dp.city);
      expect(day!.date).toBe(dp.date);
    }
  });

  it('places every valid-coordinate place from a city that has at least one day', () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);
    const cityNamesWithDays = new Set(seed.days.map((d) => d.city));

    const placedIds = new Set<string>();
    for (const dp of plan) for (const s of dp.stops) placedIds.add(s.placeId);

    for (const place of seed.places) {
      if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) continue;
      if (!cityNamesWithDays.has(place.city)) continue;
      expect(placedIds.has(place.id)).toBe(true);
    }
  });

  it('handles the day-trip cities (Wulong, Shenzhen) as their own single-day plans', () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);

    const wulong = plan.find((dp) => dp.city === 'Wulong');
    expect(wulong).toBeDefined();
    expect(wulong!.stops.length).toBe(1);

    const shenzhen = plan.find((dp) => dp.city === 'Shenzhen');
    expect(shenzhen).toBeDefined();
    expect(shenzhen!.stops.length).toBe(1);
  });

  it('returns results sorted chronologically by date', () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, DEFAULT_AUTOPLAN_CONFIG);
    const dates = plan.map((dp: DayPlan) => dp.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it('returns an empty plan for empty inputs', () => {
    expect(autoPlan([], [], DEFAULT_AUTOPLAN_CONFIG)).toEqual([]);
  });

  it('ignores places with non-finite coordinates', () => {
    const seed = buildSeed();
    const badPlace = { ...seed.places[0], id: 'bad-1', lat: NaN, lng: 121.4 };
    const plan = autoPlan([...seed.places, badPlace], seed.days, DEFAULT_AUTOPLAN_CONFIG);
    const placedIds = new Set(plan.flatMap((dp) => dp.stops.map((s) => s.placeId)));
    expect(placedIds.has('bad-1')).toBe(false);
  });
});

// Regression: the scheduler used to keep adding minutes past midnight and
// emit strings like "25:00" — not a valid time at all (`<input type="time">`
// rejects it, and it reads as 1am the previous night). Reachable from the
// modal's own knobs, which allow 8 stops × 180 min with a 60 min buffer.
describe('autoPlan — start times never leave the day', () => {
  const OVERFLOWING: AutoPlanConfig = {
    maxStopsPerDay: 8,
    dayStartTime: '09:00',
    avgMinutesPerStop: 180,
    travelBufferMin: 60,
  };

  it('emits no time outside 00:00–23:59, whatever the knobs are set to', () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, OVERFLOWING);

    for (const dp of plan) {
      for (const stop of dp.stops) {
        if (stop.startTime === undefined) continue;
        expect(stop.startTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        expect(timeToMinutes(stop.startTime)).toBeLessThan(24 * 60);
      }
    }
  });

  it('keeps a stop that does not fit in the day, just without a time', () => {
    // The seed never crowds enough pins into one day to overflow, so this
    // builds the case directly: 8 places, one day, 240-minute steps.
    const day: Day = { id: 'd1', tripId: 't', date: '2026-11-27', city: 'Shenzhen' };
    const places: Place[] = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      tripId: 't',
      name: `Stop ${i}`,
      city: 'Shenzhen',
      lat: 22.54 + i * 0.01,
      lng: 114.05 + i * 0.01,
      status: 'wishlist' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));

    const [plan] = autoPlan(places, [day], OVERFLOWING);
    expect(plan.stops.length).toBe(8);

    // 09:00 + n×240: stops 0-3 fit (09:00, 13:00, 17:00, 21:00), stop 4 would
    // be 01:00 the next day, so from there on they come back untimed rather
    // than as "25:00".
    expect(plan.stops.slice(0, 4).map((s) => s.startTime)).toEqual(['09:00', '13:00', '17:00', '21:00']);
    expect(plan.stops.slice(4).every((s) => s.startTime === undefined)).toBe(true);
    // Untimed stops keep their place in the running order.
    expect(plan.stops.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('times stay strictly increasing among the stops that do fit', () => {
    const seed = buildSeed();
    const plan = autoPlan(seed.places, seed.days, OVERFLOWING);

    for (const dp of plan) {
      const timed = dp.stops.filter((s) => s.startTime !== undefined);
      const minutes = timed.map((s) => timeToMinutes(s.startTime!));
      expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
      expect(new Set(minutes).size).toBe(minutes.length);
      // Every timed stop precedes every untimed one within a day.
      const firstUntimed = dp.stops.findIndex((s) => s.startTime === undefined);
      if (firstUntimed >= 0) {
        expect(dp.stops.slice(firstUntimed).every((s) => s.startTime === undefined)).toBe(true);
      }
    }
  });
});
