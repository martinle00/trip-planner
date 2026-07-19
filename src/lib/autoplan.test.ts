import { describe, it, expect } from 'vitest';
import { buildSeed } from '../data/seed';
import { autoPlan, DEFAULT_AUTOPLAN_CONFIG } from './autoplan';
import type { DayPlan } from './autoplan';

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
        expect(stop.startTime).toMatch(/^\d{2}:\d{2}$/);
        expect(stop.durationMin).toBe(DEFAULT_AUTOPLAN_CONFIG.avgMinutesPerStop);
        const minutes = timeToMinutes(stop.startTime);
        expect(minutes).toBeGreaterThan(prevMinutes);
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
