// Store-level tests for `editJourney` — the action that makes the trip's
// legs and dates editable. Runs against a real (in-memory) IndexedDB via
// fake-indexeddb, same pattern as useTripStore.test.ts, so the day diff, the
// cascade and the persisted rows are all exercised together rather than
// mocked apart.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { useTripStore } from './useTripStore';
import { db } from '../data/db';
import { removeLeg, setLegNights, setTripStart, totalNights } from '../lib/journey';
import { sortForReplay } from '../data/outboxTripRepository';

beforeEach(async () => {
  await Dexie.delete('china-trip-planner');
  await useTripStore.getState().init();
});

afterEach(async () => {
  await Dexie.delete('china-trip-planner');
});

function state() {
  return useTripStore.getState();
}

function daysOfLeg(name: string) {
  return state().days.filter((d) => (d.parentCity ?? d.city) === name);
}

/** Put a stop on every Chongqing day and assign a place to the first one, so
 *  a removal has something real to cascade through. */
async function planSomeChongqing() {
  const { places } = state();
  const chongqingDays = daysOfLeg('Chongqing');
  const place = places.find((p) => p.city === 'Chongqing')!;
  await state().assignPlaceToDay(place.id, chongqingDays[0].id);
  await state().addItineraryItem({ dayId: chongqingDays[1].id, title: 'Hotpot' });
  return { place, chongqingDays };
}

describe('editJourney — removing a leg', () => {
  it('drops the leg, its days and its stops, and shortens the trip', async () => {
    const { chongqingDays } = await planSomeChongqing();
    const before = state().days.length;

    await state().editJourney(removeLeg(state().trip!.cities, 'Chongqing'));

    const s = state();
    expect(s.trip!.cities.map((c) => c.name)).not.toContain('Chongqing');
    expect(s.trip!.cities.map((c) => c.name)).not.toContain('Wulong');
    expect(s.days).toHaveLength(before - 3);
    expect(daysOfLeg('Chongqing')).toHaveLength(0);
    for (const day of chongqingDays) {
      expect(s.itineraryByDay[day.id]).toBeUndefined();
    }
  });

  it('unassigns the places that lost their day instead of deleting them', async () => {
    const { place } = await planSomeChongqing();

    await state().editJourney(removeLeg(state().trip!.cities, 'Chongqing'));

    const after = state().places.find((p) => p.id === place.id);
    expect(after).toBeDefined();
    expect(after).toMatchObject({ dayId: undefined, status: 'wishlist', city: 'Chongqing' });
  });

  it('cascades in the store AND in the database, leaving no orphan rows', async () => {
    const { chongqingDays } = await planSomeChongqing();

    await state().editJourney(removeLeg(state().trip!.cities, 'Chongqing'));

    // Dexie has no foreign keys, so if the store didn't delete these
    // explicitly they'd still be sitting here — and `listAllItinerary`
    // filters by day id, so nothing in the UI would ever have shown it.
    const dayIds = chongqingDays.map((d) => d.id);
    expect(await db.days.bulkGet(dayIds)).toEqual([undefined, undefined, undefined]);
    const strayStops = await db.itinerary.where('dayId').anyOf(dayIds).toArray();
    expect(strayStops).toEqual([]);
    const strayAssignments = await db.places.filter((p) => dayIds.includes(p.dayId ?? '')).toArray();
    expect(strayAssignments).toEqual([]);
  });

  it('recomputes the trip span from the surviving legs', async () => {
    await state().editJourney(removeLeg(state().trip!.cities, 'Chongqing'));
    const s = state();
    expect(s.trip!.startDate).toBe('2026-11-07');
    expect(s.trip!.endDate).toBe('2026-11-27');
    expect(totalNights(s.trip!.cities)).toBe(20);
  });

  it('persists across a reload', async () => {
    await state().editJourney(removeLeg(state().trip!.cities, 'Chongqing'));
    await state().init();
    const s = state();
    expect(s.trip!.cities.map((c) => c.name)).not.toContain('Chongqing');
    expect(s.trip!.endDate).toBe('2026-11-27');
    expect(daysOfLeg('Chongqing')).toHaveLength(0);
  });
});

describe('editJourney — resizing and shifting', () => {
  it('keeps the surviving days\' ids, and their stops, when later legs shift', async () => {
    const suzhouDays = daysOfLeg('Suzhou');
    await state().addItineraryItem({ dayId: suzhouDays[0].id, title: 'Tiger Hill' });
    const shanghaiIds = daysOfLeg('Shanghai').map((d) => d.id);

    await state().editJourney(setLegNights(state().trip!.cities, 'Shanghai', 4));

    const s = state();
    // Suzhou moved two days earlier but is the same row, still holding its stop.
    const movedSuzhou = s.days.find((d) => d.id === suzhouDays[0].id);
    expect(movedSuzhou?.date).toBe('2026-11-13');
    expect(s.itineraryByDay[suzhouDays[0].id]).toHaveLength(1);
    // Shanghai lost its last two days and kept the first four, by id.
    expect(daysOfLeg('Shanghai').map((d) => d.id)).toEqual(shanghaiIds.slice(0, 4));
  });

  it('lengthening a leg adds empty days without disturbing the rest', async () => {
    const before = state().days.length;
    const suzhouIds = daysOfLeg('Suzhou').map((d) => d.id);

    await state().editJourney(setLegNights(state().trip!.cities, 'Suzhou', 4));

    const s = state();
    expect(s.days).toHaveLength(before + 2);
    const suzhou = daysOfLeg('Suzhou');
    expect(suzhou).toHaveLength(4);
    expect(suzhou.slice(0, 2).map((d) => d.id)).toEqual(suzhouIds);
    // The two new days exist in the store as empty itineraries, not as holes.
    for (const day of suzhou.slice(2)) {
      expect(s.itineraryByDay[day.id]).toEqual([]);
    }
  });

  it('shifts every day when the trip start moves, creating and deleting none', async () => {
    const beforeIds = state().days.map((d) => d.id);
    const firstId = beforeIds[0];

    const plan = await state().editJourney(setTripStart(state().trip!.cities, '2026-11-10'));

    const s = state();
    expect(s.trip!.startDate).toBe('2026-11-10');
    expect(s.trip!.endDate).toBe('2026-12-03');
    expect(s.days.find((d) => d.id === firstId)?.date).toBe('2026-11-10');
    // Every single day moved date and not one was recreated — the property a
    // date-keyed diff would have destroyed.
    expect(s.days.map((d) => d.id)).toEqual(beforeIds);
    expect(plan.days.create).toEqual([]);
    expect(plan.days.delete).toEqual([]);
    expect(plan.days.update).toHaveLength(beforeIds.length);
  });

  it('is a no-op when the leg list is unchanged', async () => {
    const before = state().days.map((d) => `${d.id}:${d.date}`);
    const plan = await state().editJourney(state().trip!.cities);
    expect(plan.days).toEqual({ create: [], update: [], delete: [] });
    expect(state().days.map((d) => `${d.id}:${d.date}`)).toEqual(before);
  });
});

describe('previewJourneyEdit', () => {
  it('reports the blast radius without changing anything', async () => {
    await planSomeChongqing();
    const before = JSON.stringify(state().days);

    const plan = state().previewJourneyEdit(removeLeg(state().trip!.cities, 'Chongqing'));

    expect(plan.days.delete).toHaveLength(3);
    expect(plan.itineraryToDelete).toHaveLength(2);
    expect(plan.placesToUnassign).toHaveLength(1);
    // Every Chongqing/Wulong place is orphaned, not deleted.
    expect(plan.orphanedPlaces.map((p) => p.city).sort()).toEqual(['Chongqing', 'Wulong']);
    expect(JSON.stringify(state().days)).toBe(before);
    expect(state().trip!.cities.map((c) => c.name)).toContain('Chongqing');
  });
});

describe('outbox replay order', () => {
  it('writes a day before anything that can reference it', () => {
    // The case this exists for: coalescing moves a re-edited record to the
    // BACK of the queue, so a day created early and edited late ends up
    // behind the place that points at it. In queue order that replays as a
    // place insert against a day that doesn't exist remotely yet.
    const queued = [
      { entity: 'place', op: 'upsert', seq: 1 },
      { entity: 'itinerary', op: 'upsert', seq: 2 },
      { entity: 'day', op: 'upsert', seq: 3 },
      { entity: 'trip', op: 'upsert', seq: 4 },
    ];
    expect(sortForReplay(queued).map((e) => e.entity)).toEqual([
      'trip', 'day', 'place', 'itinerary',
    ]);
  });

  it('deletes children before their parent day', () => {
    const queued = [
      { entity: 'day', op: 'delete', seq: 1 },
      { entity: 'itinerary', op: 'delete', seq: 2 },
      { entity: 'place', op: 'delete', seq: 3 },
    ];
    expect(sortForReplay(queued).map((e) => e.entity)).toEqual([
      'itinerary', 'place', 'day',
    ]);
  });

  it('preserves queue order within a rank, and is stable across re-runs', () => {
    const queued = [
      { entity: 'place', op: 'upsert', seq: 9 },
      { entity: 'place', op: 'upsert', seq: 2 },
      { entity: 'place', op: 'upsert', seq: 5 },
    ];
    const once = sortForReplay(queued).map((e) => e.seq);
    expect(once).toEqual([2, 5, 9]);
    // A drain that stopped half-way resumes in the same order.
    expect(sortForReplay(sortForReplay(queued)).map((e) => e.seq)).toEqual(once);
  });
});
