// Store-level tests for assignPlaceToDay's itinerary-linking behavior
// (see useTripStore.ts). Uses fake-indexeddb (same pattern as
// data/persistence.test.ts) so the store's repository-backed actions run
// against a real (in-memory) IndexedDB with no browser required.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import {
  useTripStore,
  resetTripStoreForSignOut,
  getEffectiveDayId,
  getStagedAssignmentCount,
  getStagedAssignmentCountForCity,
  getStagedAssignmentCountsByCity,
} from './useTripStore';
import type { DayPlan } from '../lib/autoplan';
import { setTripRepository, tripRepository } from '../data/tripRepositoryInstance';
import { DexieTripRepository } from '../data/dexieTripRepository';
import type { TripRepository } from '../data/tripRepository';
import type { Place, Trip } from '../data/schema';
import { db } from '../data/db';
import { stagedAssignmentRepository } from '../data/stagedAssignmentRepository';
import { splitMergedProse } from '../lib/proseMerge';

const fetchRatesMock = vi.fn();
vi.mock('../lib/exchangeRates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/exchangeRates')>();
  return {
    ...actual,
    fetchRates: (...args: unknown[]) => fetchRatesMock(...args),
  };
});

beforeEach(async () => {
  await Dexie.delete('china-trip-planner');
  await useTripStore.getState().init();
  fetchRatesMock.mockReset();
});

afterEach(async () => {
  await Dexie.delete('china-trip-planner');
});

function linkedItemsOn(dayId: string, placeId: string) {
  return (useTripStore.getState().itineraryByDay[dayId] ?? []).filter(
    (i) => i.placeId === placeId,
  );
}

describe('assignPlaceToDay — itinerary linking', () => {
  it('assign creates exactly one linked, untimed stop on the target day', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days[0];

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);

    const linked = linkedItemsOn(day.id, place.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].title).toBe(place.name);
    expect(linked[0].startTime).toBeUndefined();
    expect(linked[0].durationMin).toBeUndefined();

    const updatedPlace = useTripStore.getState().places.find((p) => p.id === place.id);
    expect(updatedPlace?.dayId).toBe(day.id);
    expect(updatedPlace?.status).toBe('planned');
  });

  it('the linked stop appears in itineraryByDay immediately (Map day-view / Itinerary tab source)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[1];
    const day = days[0];

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);

    const dayItems = useTripStore.getState().itineraryByDay[day.id] ?? [];
    expect(dayItems.some((i) => i.placeId === place.id && i.title === place.name)).toBe(true);
  });

  it('reassign moves the linked stop: old day ends up empty, new day has it, no duplicate', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const dayA = days[0];
    const dayB = days[1];

    await useTripStore.getState().assignPlaceToDay(place.id, dayA.id);
    const originalItemId = linkedItemsOn(dayA.id, place.id)[0].id;

    await useTripStore.getState().assignPlaceToDay(place.id, dayB.id);

    expect(linkedItemsOn(dayA.id, place.id)).toHaveLength(0);
    const onB = linkedItemsOn(dayB.id, place.id);
    expect(onB).toHaveLength(1);
    // Moved (same underlying item, relocated), not deleted+recreated.
    expect(onB[0].id).toBe(originalItemId);

    const updatedPlace = useTripStore.getState().places.find((p) => p.id === place.id);
    expect(updatedPlace?.dayId).toBe(dayB.id);
  });

  it('reassign preserves customizations (startTime/note) made on the linked item', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const dayA = days[0];
    const dayB = days[1];

    await useTripStore.getState().assignPlaceToDay(place.id, dayA.id);
    const item = linkedItemsOn(dayA.id, place.id)[0];
    await useTripStore.getState().updateItineraryItem({
      ...item,
      startTime: '10:30',
      note: 'Bring camera',
    });

    await useTripStore.getState().assignPlaceToDay(place.id, dayB.id);

    const onB = linkedItemsOn(dayB.id, place.id);
    expect(onB).toHaveLength(1);
    expect(onB[0].startTime).toBe('10:30');
    expect(onB[0].note).toBe('Bring camera');
  });

  it('unassign (dayId undefined) removes the linked stop entirely', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days[0];

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);
    expect(linkedItemsOn(day.id, place.id)).toHaveLength(1);

    await useTripStore.getState().assignPlaceToDay(place.id, undefined);

    expect(linkedItemsOn(day.id, place.id)).toHaveLength(0);
    const updatedPlace = useTripStore.getState().places.find((p) => p.id === place.id);
    expect(updatedPlace?.dayId).toBeUndefined();
    expect(updatedPlace?.status).toBe('wishlist');
  });

  it('assigning a place that auto-plan already itinerary-linked does not duplicate', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days[0];

    // Simulate what applyAutoPlan already did: place assigned + a fully
    // timed linked item created directly (not via assignPlaceToDay).
    await useTripStore.getState().addItineraryItem({
      dayId: day.id,
      placeId: place.id,
      title: place.name,
      startTime: '09:00',
      durationMin: 60,
    });

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);

    const linked = linkedItemsOn(day.id, place.id);
    expect(linked).toHaveLength(1);
    // Existing (auto-plan) item is left untouched, not overwritten.
    expect(linked[0].startTime).toBe('09:00');
    expect(linked[0].durationMin).toBe(60);
  });

  it('reassigning onto a day that already has a linked item for the place keeps that item (no duplicate)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const dayA = days[0];
    const dayB = days[1];

    await useTripStore.getState().assignPlaceToDay(place.id, dayA.id);
    // dayB already has its own (e.g. pre-existing) linked item for this place.
    await useTripStore.getState().addItineraryItem({
      dayId: dayB.id,
      placeId: place.id,
      title: place.name,
      startTime: '14:00',
    });

    await useTripStore.getState().assignPlaceToDay(place.id, dayB.id);

    expect(linkedItemsOn(dayA.id, place.id)).toHaveLength(0);
    const onB = linkedItemsOn(dayB.id, place.id);
    expect(onB).toHaveLength(1);
    expect(onB[0].startTime).toBe('14:00');
  });

  it('assigning the same day twice is a no-op (still exactly one linked item)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days[0];

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);
    await useTripStore.getState().assignPlaceToDay(place.id, day.id);

    expect(linkedItemsOn(day.id, place.id)).toHaveLength(1);
  });

  it('two truly overlapping assignPlaceToDay calls to the same place/day produce exactly one linked item (no race)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days[0];

    // Fired together (not awaited individually) — this is what an ordinary
    // rapid double-click of a day-select dropdown produces: two overlapping
    // in-flight calls, not two sequential ones.
    await Promise.all([
      useTripStore.getState().assignPlaceToDay(place.id, day.id),
      useTripStore.getState().assignPlaceToDay(place.id, day.id),
    ]);

    expect(linkedItemsOn(day.id, place.id)).toHaveLength(1);
    const updatedPlace = useTripStore.getState().places.find((p) => p.id === place.id);
    expect(updatedPlace?.dayId).toBe(day.id);
  });
});

describe('addPlace — optional dayId creates a linked stop too', () => {
  it('creating a place already assigned to a day gets a linked untimed stop', async () => {
    const day = useTripStore.getState().days[0];
    const created = await useTripStore.getState().addPlace({
      name: 'Test Pin',
      city: 'Singapore',
      lat: 1,
      lng: 103,
      dayId: day.id,
      status: 'planned',
    });

    const linked = linkedItemsOn(day.id, created.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].title).toBe('Test Pin');
    expect(linked[0].startTime).toBeUndefined();
  });

  it('creating a wishlist place (no dayId) does not create any itinerary item', async () => {
    const before = JSON.stringify(useTripStore.getState().itineraryByDay);
    await useTripStore.getState().addPlace({
      name: 'Wishlist Pin',
      city: 'Singapore',
      lat: 1,
      lng: 103,
    });
    const after = JSON.stringify(useTripStore.getState().itineraryByDay);
    expect(after).toBe(before);
  });
});

describe('applyAutoPlan', () => {
  function makePlan(dayId: string, date: string, city: string, placeIds: string[]): DayPlan[] {
    return [
      {
        dayId,
        date,
        city,
        stops: placeIds.map((placeId, i) => ({
          placeId,
          order: i,
          startTime: i === 0 ? '09:00' : '11:00',
          durationMin: 90,
        })),
      },
    ];
  }

  it('first apply writes startTime/durationMin/order and marks places planned', async () => {
    const { places, days } = useTripStore.getState();
    const [p1, p2] = places;
    const day = days[0];
    const plan = makePlan(day.id, day.date, day.city, [p1.id, p2.id]);

    await useTripStore.getState().applyAutoPlan(plan);

    const state = useTripStore.getState();
    const dayItems = (state.itineraryByDay[day.id] ?? []).filter(
      (i) => i.placeId === p1.id || i.placeId === p2.id,
    );
    expect(dayItems).toHaveLength(2);

    const item1 = dayItems.find((i) => i.placeId === p1.id);
    expect(item1?.startTime).toBe('09:00');
    expect(item1?.durationMin).toBe(90);
    expect(item1?.order).toBe(0);

    const item2 = dayItems.find((i) => i.placeId === p2.id);
    expect(item2?.startTime).toBe('11:00');
    expect(item2?.order).toBe(1);

    const place1 = state.places.find((p) => p.id === p1.id);
    expect(place1?.dayId).toBe(day.id);
    expect(place1?.status).toBe('planned');
  });

  it('re-applying the same plan (double-accept) does NOT duplicate items — updates in place', async () => {
    const { places, days } = useTripStore.getState();
    const [p1, p2] = places;
    const day = days[0];
    const plan = makePlan(day.id, day.date, day.city, [p1.id, p2.id]);

    await useTripStore.getState().applyAutoPlan(plan);
    const firstIds = (useTripStore.getState().itineraryByDay[day.id] ?? [])
      .filter((i) => i.placeId === p1.id || i.placeId === p2.id)
      .map((i) => i.id)
      .sort();

    await useTripStore.getState().applyAutoPlan(plan);

    const afterSecond = (useTripStore.getState().itineraryByDay[day.id] ?? []).filter(
      (i) => i.placeId === p1.id || i.placeId === p2.id,
    );
    expect(afterSecond).toHaveLength(2);
    // Same underlying items (updated in place), not new ones.
    expect(afterSecond.map((i) => i.id).sort()).toEqual(firstIds);
  });

  it('re-applying with tweaked config (different startTime) updates the existing linked item', async () => {
    const { places, days } = useTripStore.getState();
    const [p1] = places;
    const day = days[0];

    await useTripStore.getState().applyAutoPlan(makePlan(day.id, day.date, day.city, [p1.id]));
    const revisedPlan: DayPlan[] = [
      {
        dayId: day.id,
        date: day.date,
        city: day.city,
        stops: [{ placeId: p1.id, order: 0, startTime: '08:00', durationMin: 45 }],
      },
    ];
    await useTripStore.getState().applyAutoPlan(revisedPlan);

    const linked = (useTripStore.getState().itineraryByDay[day.id] ?? []).filter(
      (i) => i.placeId === p1.id,
    );
    expect(linked).toHaveLength(1);
    expect(linked[0].startTime).toBe('08:00');
    expect(linked[0].durationMin).toBe(45);
  });

  it('two truly overlapping applyAutoPlan calls with the same plan produce exactly one item per placeId/dayId (no race)', async () => {
    const { places, days } = useTripStore.getState();
    const [p1, p2] = places;
    const day = days[0];
    const plan = makePlan(day.id, day.date, day.city, [p1.id, p2.id]);

    // Fired together (not awaited individually) — this reproduces a rapid
    // double-click of "Accept draft" (no in-flight guard in AutoPlanModal):
    // two overlapping in-flight applyAutoPlan calls racing on the same
    // itineraryByDay read-then-write, not two sequential ones.
    await Promise.all([
      useTripStore.getState().applyAutoPlan(plan),
      useTripStore.getState().applyAutoPlan(plan),
    ]);

    const dayItems = (useTripStore.getState().itineraryByDay[day.id] ?? []).filter(
      (i) => i.placeId === p1.id || i.placeId === p2.id,
    );
    expect(dayItems).toHaveLength(2);
    expect(dayItems.filter((i) => i.placeId === p1.id)).toHaveLength(1);
    expect(dayItems.filter((i) => i.placeId === p2.id)).toHaveLength(1);
  });

  // Map "Save changes" staging model, resolved: autoplan is explicitly NOT
  // staged (see useTripStore.ts's `applyAutoPlan` doc comment and
  // CLAUDE.md) -- it keeps writing straight through the normal path, exactly
  // like assignPlaceToDay. This pins that as a regression guard: applying a
  // plan must never create a row in the local staging table nor touch
  // in-memory `stagedAssignments`, even though the two features both end up
  // setting `Place.dayId`.
  it('writes straight through immediately -- never stages -- unlike the Map pin-detail select', async () => {
    const { places, days } = useTripStore.getState();
    const [p1] = places;
    const day = days[0];

    await useTripStore.getState().applyAutoPlan(makePlan(day.id, day.date, day.city, [p1.id]));

    expect(useTripStore.getState().stagedAssignments).toEqual({});
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(0);
    const place = useTripStore.getState().places.find((p) => p.id === p1.id);
    expect(place?.dayId).toBe(day.id);
    expect(place?.status).toBe('planned');
  });
});

describe('removePlace — orphaned itinerary cleanup', () => {
  it('deleting a place also removes its linked itinerary item(s)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days[0];

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);
    expect(linkedItemsOn(day.id, place.id)).toHaveLength(1);

    await useTripStore.getState().removePlace(place.id);

    expect(linkedItemsOn(day.id, place.id)).toHaveLength(0);
    // No stray item anywhere referencing the deleted place.
    const anyOrphan = Object.values(useTripStore.getState().itineraryByDay)
      .flat()
      .some((i) => i.placeId === place.id);
    expect(anyOrphan).toBe(false);
    expect(useTripStore.getState().places.find((p) => p.id === place.id)).toBeUndefined();
  });

  it('deleting a place with no linked itinerary item leaves other days untouched', async () => {
    const { places, days } = useTripStore.getState();
    const [placeToDelete, otherPlace] = places;
    const day = days[0];
    await useTripStore.getState().assignPlaceToDay(otherPlace.id, day.id);
    const before = (useTripStore.getState().itineraryByDay[day.id] ?? []).length;

    await useTripStore.getState().removePlace(placeToDelete.id);

    expect((useTripStore.getState().itineraryByDay[day.id] ?? []).length).toBe(before);
  });
});

describe('setHomeCurrency', () => {
  it('re-bases the rates map onto the new home currency using its existing cross-rate', async () => {
    const trip = useTripStore.getState().trip!;
    // Seed rates: AUD:1, CNY:0.21, SGD:1.13, USD:1.53, HKD:0.196 (home value of 1 unit).
    await useTripStore.getState().setHomeCurrency('SGD');

    const updated = useTripStore.getState().trip!;
    expect(updated.homeCurrency).toBe('SGD');
    // rates'[C] = rates[C] / rates[SGD] (old)
    const crossRate = trip.rates.SGD;
    expect(updated.rates.SGD).toBe(1);
    expect(updated.rates.AUD).toBeCloseTo(1 / crossRate, 6);
    expect(updated.rates.CNY).toBeCloseTo(trip.rates.CNY / crossRate, 6);
    expect(updated.rates.USD).toBeCloseTo(trip.rates.USD / crossRate, 6);
  });

  it('leaves ratesUpdatedAt untouched when re-basing succeeds (not a fresh fetch)', async () => {
    // Simulate a trip that's already been through a live refresh.
    const trip = useTripStore.getState().trip!;
    useTripStore.setState({ trip: { ...trip, ratesUpdatedAt: '2026-01-01T00:00:00.000Z' } });

    await useTripStore.getState().setHomeCurrency('SGD');

    expect(useTripStore.getState().trip!.ratesUpdatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is a no-op when the new code equals the current home currency', async () => {
    const before = useTripStore.getState().trip;
    await useTripStore.getState().setHomeCurrency('AUD');
    expect(useTripStore.getState().trip).toBe(before);
  });

  it('drops to an identity-only map and clears ratesUpdatedAt when no cross-rate is known', async () => {
    const trip = useTripStore.getState().trip!;
    useTripStore.setState({ trip: { ...trip, ratesUpdatedAt: '2026-01-01T00:00:00.000Z' } });

    await useTripStore.getState().setHomeCurrency('JPY'); // not in the seed rates map

    const updated = useTripStore.getState().trip!;
    expect(updated.homeCurrency).toBe('JPY');
    expect(updated.rates).toEqual({ JPY: 1 });
    expect(updated.ratesUpdatedAt).toBeUndefined();
  });

  it('persists the change through the repository (survives a simulated reload)', async () => {
    await useTripStore.getState().setHomeCurrency('SGD');
    await useTripStore.getState().init(); // re-load from IndexedDB
    expect(useTripStore.getState().trip!.homeCurrency).toBe('SGD');
  });
});

describe('addMember / renameMember / removeMember (Phase 5 — trip members)', () => {
  it('addMember adds a member with a generated id and persists it (survives a simulated reload)', async () => {
    expect(useTripStore.getState().trip!.members ?? []).toEqual([]);

    const member = await useTripStore.getState().addMember('Alex');

    expect(member.name).toBe('Alex');
    expect(member.id).toBeTruthy();
    expect(useTripStore.getState().trip!.members).toEqual([member]);

    await useTripStore.getState().init(); // re-load from IndexedDB
    expect(useTripStore.getState().trip!.members).toEqual([member]);
  });

  it('addMember trims whitespace and rejects an empty/whitespace-only name', async () => {
    const member = await useTripStore.getState().addMember('  Sam  ');
    expect(member.name).toBe('Sam');

    await expect(useTripStore.getState().addMember('   ')).rejects.toThrow(
      'addMember: name must not be empty',
    );
    // The rejected call didn't add anything.
    expect(useTripStore.getState().trip!.members).toEqual([member]);
  });

  it('renameMember renames the matching member in place, preserving its id', async () => {
    const member = await useTripStore.getState().addMember('Alex');

    await useTripStore.getState().renameMember(member.id, 'Alexandra');

    expect(useTripStore.getState().trip!.members).toEqual([{ id: member.id, name: 'Alexandra' }]);
  });

  it('renameMember no-ops for an unknown id', async () => {
    const member = await useTripStore.getState().addMember('Alex');
    await useTripStore.getState().renameMember('no-such-id', 'Whoever');
    expect(useTripStore.getState().trip!.members).toEqual([member]);
  });

  it('renameMember no-ops (does not throw, does not change the name) for an empty/whitespace-only name', async () => {
    const member = await useTripStore.getState().addMember('Alex');
    await useTripStore.getState().renameMember(member.id, '   ');
    expect(useTripStore.getState().trip!.members).toEqual([member]);
  });

  it('addMember allows duplicate names — ids, not names, are the identity', async () => {
    const first = await useTripStore.getState().addMember('Alex');
    const second = await useTripStore.getState().addMember('Alex');

    expect(first.id).not.toBe(second.id);
    const members = useTripStore.getState().trip!.members ?? [];
    expect(members.map((m) => m.name)).toEqual(['Alex', 'Alex']);
    expect(members.map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it('addMember rejects when no trip is loaded yet', async () => {
    resetTripStoreForSignOut();
    expect(useTripStore.getState().trip).toBeUndefined();
    await expect(useTripStore.getState().addMember('Alex')).rejects.toThrow(
      'addMember: no trip loaded yet',
    );
  });

  it('renameMember/removeMember no-op (do not throw) when no trip is loaded yet', async () => {
    resetTripStoreForSignOut();
    await expect(useTripStore.getState().renameMember('any-id', 'Whoever')).resolves.toBeUndefined();
    await expect(useTripStore.getState().removeMember('any-id')).resolves.toBeUndefined();
  });

  it('removeMember removes the member from Trip.members', async () => {
    const alex = await useTripStore.getState().addMember('Alex');
    const sam = await useTripStore.getState().addMember('Sam');

    await useTripStore.getState().removeMember(alex.id);

    expect(useTripStore.getState().trip!.members).toEqual([sam]);
  });

  it('removeMember no-ops for an unknown id (trip loaded, id just does not match)', async () => {
    const member = await useTripStore.getState().addMember('Alex');
    await useTripStore.getState().removeMember('no-such-id');
    expect(useTripStore.getState().trip!.members).toEqual([member]);
  });

  it('removeMember is orphan-tolerant: an expense whose paidBy references the removed member survives untouched (dangling paidBy)', async () => {
    const alex = await useTripStore.getState().addMember('Alex');
    const expense = await useTripStore.getState().addExpense({
      category: 'Food',
      label: 'Noodles',
      amount: 38,
      currency: 'CNY',
      paid: true,
      paidBy: alex.id,
    });

    await useTripStore.getState().removeMember(alex.id);

    expect(useTripStore.getState().trip!.members).toEqual([]);
    const stillThere = useTripStore.getState().expenses.find((e) => e.id === expense.id);
    expect(stillThere).toBeDefined();
    // The reference is left dangling, not rewritten/cleared — the doc
    // contract is that a downstream renderer treats this as "unset".
    expect(stillThere?.paidBy).toBe(alex.id);
  });

  it('removeMember is orphan-tolerant for coversMemberIds too: a dangling id survives untouched', async () => {
    const alex = await useTripStore.getState().addMember('Alex');
    const sam = await useTripStore.getState().addMember('Sam');
    const expense = await useTripStore.getState().addExpense({
      category: 'Food',
      label: 'Noodles',
      amount: 38,
      currency: 'CNY',
      paid: true,
      coversMemberIds: [alex.id, sam.id],
    });

    await useTripStore.getState().removeMember(alex.id);

    expect(useTripStore.getState().trip!.members).toEqual([sam]);
    const stillThere = useTripStore.getState().expenses.find((e) => e.id === expense.id);
    expect(stillThere).toBeDefined();
    // Left exactly as-is -- not cascade-rewritten to drop the now-dangling id.
    expect(stillThere?.coversMemberIds).toEqual([alex.id, sam.id]);
  });

  it('setMemberColor sets a colour on the matching member, preserving id/name', async () => {
    const alex = await useTripStore.getState().addMember('Alex');

    await useTripStore.getState().setMemberColor(alex.id, 'm-denim');

    expect(useTripStore.getState().trip!.members).toEqual([{ ...alex, color: 'm-denim' }]);
  });

  it('setMemberColor clears a colour when passed undefined', async () => {
    const alex = await useTripStore.getState().addMember('Alex');
    await useTripStore.getState().setMemberColor(alex.id, 'm-denim');

    await useTripStore.getState().setMemberColor(alex.id, undefined);

    expect(useTripStore.getState().trip!.members).toEqual([alex]);
  });

  it('setMemberColor no-ops for an unknown id', async () => {
    const member = await useTripStore.getState().addMember('Alex');
    await useTripStore.getState().setMemberColor('no-such-id', 'm-denim');
    expect(useTripStore.getState().trip!.members).toEqual([member]);
  });

  it('setMemberColor no-ops (does not throw) when no trip is loaded yet', async () => {
    resetTripStoreForSignOut();
    await expect(useTripStore.getState().setMemberColor('any-id', 'm-denim')).resolves.toBeUndefined();
  });

  it('two truly overlapping addMember calls both land in trip.members (no lost update)', async () => {
    // Fired together, not sequentially awaited — this is what a rapid
    // double-click on "Add" in the companions form produces. Each addMember
    // call is a read-`trip`-then-`saveTrip` sequence; without
    // runMembersExclusive serializing them, both overlapping calls could
    // read the same starting `trip.members` and the second write would
    // silently clobber the first's, leaving only one member instead of two.
    const [alex, sam] = await Promise.all([
      useTripStore.getState().addMember('Alex'),
      useTripStore.getState().addMember('Sam'),
    ]);

    expect(alex.name).toBe('Alex');
    expect(sam.name).toBe('Sam');
    const names = (useTripStore.getState().trip!.members ?? []).map((m) => m.name).sort();
    expect(names).toEqual(['Alex', 'Sam']);
  });
});

describe('refreshRates', () => {
  it('fetches, stores rates/ratesBase/ratesUpdatedAt on the trip, and persists them', async () => {
    fetchRatesMock.mockResolvedValue({
      rates: { AUD: 1, CNY: 0.22, SGD: 1.1 },
      base: 'AUD',
      fetchedAt: '2026-06-01T00:00:00.000Z',
    });

    await useTripStore.getState().refreshRates();

    const trip = useTripStore.getState().trip!;
    expect(trip.rates).toEqual({ AUD: 1, CNY: 0.22, SGD: 1.1 });
    expect(trip.ratesBase).toBe('AUD');
    expect(trip.ratesUpdatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(useTripStore.getState().ratesLoading).toBe(false);
    expect(useTripStore.getState().ratesError).toBeUndefined();

    expect(fetchRatesMock).toHaveBeenCalledWith('AUD');

    await useTripStore.getState().init();
    expect(useTripStore.getState().trip!.rates).toEqual({ AUD: 1, CNY: 0.22, SGD: 1.1 });
  });

  it('sets ratesLoading true for the duration of the call', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    fetchRatesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const promise = useTripStore.getState().refreshRates();
    try {
      // refreshRates is serialized through runRatesExclusive (see
      // useTripStore.ts), which adds one microtask hop before the queued
      // call body actually starts running — flush a tick so its synchronous
      // prefix (set ratesLoading: true) has run before we assert.
      await Promise.resolve();
      expect(useTripStore.getState().ratesLoading).toBe(true);
    } finally {
      // Always resolve the mock, even if the assertion above fails — this
      // call is serialized through a write queue shared by every test in
      // this file, so leaving it permanently pending would hang every
      // subsequent refreshRates() test queued behind it.
      resolveFetch({ rates: { AUD: 1 }, base: 'AUD', fetchedAt: '2026-06-01T00:00:00.000Z' });
    }
    await promise;

    expect(useTripStore.getState().ratesLoading).toBe(false);
  });

  it('on failure, sets ratesError, clears ratesLoading, rethrows, and leaves the trip untouched', async () => {
    const before = useTripStore.getState().trip;
    fetchRatesMock.mockRejectedValue(new Error('network down'));

    await expect(useTripStore.getState().refreshRates()).rejects.toThrow('network down');

    expect(useTripStore.getState().ratesLoading).toBe(false);
    expect(useTripStore.getState().ratesError).toBe('network down');
    expect(useTripStore.getState().trip).toBe(before);
  });

  it('clears a prior ratesError at the start of a new call', async () => {
    fetchRatesMock.mockRejectedValueOnce(new Error('first failure'));
    await expect(useTripStore.getState().refreshRates()).rejects.toThrow();
    expect(useTripStore.getState().ratesError).toBe('first failure');

    fetchRatesMock.mockResolvedValueOnce({ rates: { AUD: 1 }, base: 'AUD', fetchedAt: '2026-06-01T00:00:00.000Z' });
    await useTripStore.getState().refreshRates();

    expect(useTripStore.getState().ratesError).toBeUndefined();
  });

  it('two overlapping calls are serialized — the later (queued) call wins, not whichever settles first', async () => {
    // Without serialization this would be "last-COMPLETED-wins": call2's
    // fetch resolves immediately while call1's is held open, so call2 would
    // land first and then get clobbered by call1's stale data once it
    // finally resolves. runRatesExclusive guarantees call2's body doesn't
    // even START until call1 has fully committed its write.
    let resolveFirst: (v: unknown) => void = () => {};
    const firstPending = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    fetchRatesMock
      .mockImplementationOnce(() => firstPending)
      .mockImplementationOnce(() =>
        Promise.resolve({ rates: { AUD: 1, CNY: 0.3 }, base: 'AUD', fetchedAt: '2026-06-02T00:00:00.000Z' }),
      );

    const call1 = useTripStore.getState().refreshRates();
    const call2 = useTripStore.getState().refreshRates();

    // Resolve the slow first call right away — without the queue, this
    // races against call2's already-resolved fetch.
    resolveFirst({ rates: { AUD: 1, CNY: 0.2 }, base: 'AUD', fetchedAt: '2026-06-01T00:00:00.000Z' });
    await Promise.all([call1, call2]);

    expect(fetchRatesMock).toHaveBeenCalledTimes(2);
    expect(useTripStore.getState().trip!.rates.CNY).toBe(0.3);
    expect(useTripStore.getState().trip!.ratesUpdatedAt).toBe('2026-06-02T00:00:00.000Z');
  });
});

describe('addExpense — mixed-currency math', () => {
  it('records amount + currency as given, independent of the trip rates table', async () => {
    const expense = await useTripStore.getState().addExpense({
      category: 'Food',
      label: 'Laksa',
      amount: 12,
      currency: 'SGD',
      paid: true,
    });

    expect(expense.amount).toBe(12);
    expect(expense.currency).toBe('SGD');
    expect(useTripStore.getState().expenses.find((e) => e.id === expense.id)).toEqual(expense);
  });

  it('persists mixed-currency expenses through a simulated reload', async () => {
    await useTripStore.getState().addExpense({ category: 'Food', label: 'Noodles', amount: 38, currency: 'CNY', paid: false });
    await useTripStore.getState().addExpense({ category: 'Food', label: 'Coffee', amount: 6, currency: 'SGD', paid: true });

    await useTripStore.getState().init();

    const expenses = useTripStore.getState().expenses;
    expect(expenses.find((e) => e.label === 'Noodles')).toMatchObject({ amount: 38, currency: 'CNY' });
    expect(expenses.find((e) => e.label === 'Coffee')).toMatchObject({ amount: 6, currency: 'SGD' });
  });
});

describe('updateItineraryItem — cross-day move vs. same-day edit', () => {
  it('a cross-day move is appended to the end of the target day, ignoring any caller-supplied order', async () => {
    const { days } = useTripStore.getState();
    const dayA = days[0];
    const dayB = days[1];

    const a1 = await useTripStore.getState().addItineraryItem({ dayId: dayA.id, title: 'A1' });
    const a2 = await useTripStore.getState().addItineraryItem({ dayId: dayA.id, title: 'A2' });
    const b1 = await useTripStore.getState().addItineraryItem({ dayId: dayB.id, title: 'B1' });

    // Move a2 to dayB, deliberately (and wrongly) claiming order 0 — the
    // store must ignore this and append it after b1 instead.
    await useTripStore.getState().updateItineraryItem({ ...a2, dayId: dayB.id, order: 0 });

    const stateNow = useTripStore.getState();
    expect((stateNow.itineraryByDay[dayA.id] ?? []).map((i) => i.id)).toEqual([a1.id]);
    const onB = stateNow.itineraryByDay[dayB.id] ?? [];
    expect(onB.map((i) => i.id)).toEqual([b1.id, a2.id]);
    expect(onB.find((i) => i.id === b1.id)?.order).toBe(0);
    expect(onB.find((i) => i.id === a2.id)?.order).toBe(1);
  });

  it('a same-day edit keeps the caller-supplied order untouched (no forced append)', async () => {
    const { days } = useTripStore.getState();
    const day = days[0];

    const i0 = await useTripStore.getState().addItineraryItem({ dayId: day.id, title: 'First' });
    const i1 = await useTripStore.getState().addItineraryItem({ dayId: day.id, title: 'Second' });
    const i2 = await useTripStore.getState().addItineraryItem({ dayId: day.id, title: 'Third' });

    // Edit the middle item in place (same day, same order) — must not be
    // shoved to the end of the list.
    await useTripStore.getState().updateItineraryItem({ ...i1, title: 'Second (edited)', order: 1 });

    const items = useTripStore.getState().itineraryByDay[day.id] ?? [];
    expect(items.map((i) => i.id)).toEqual([i0.id, i1.id, i2.id]);
    expect(items.find((i) => i.id === i1.id)?.title).toBe('Second (edited)');
    expect(items.find((i) => i.id === i1.id)?.order).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// init() — cache-first / stale-while-revalidate against a remote-backed
// repository (see useTripStore.ts's init()). The outer beforeEach above
// already seeded and loaded the local Dexie cache via the *default* (plain
// Dexie) repository before each of these tests runs, mirroring a real app
// that already has a cached trip on this device. Each test here then swaps
// in a fake remote-backed `TripRepository` via `setTripRepository` (the same
// seam AuthGate.tsx uses to wire up a real `SyncedTripRepository`) to
// exercise the cache-first/background-refresh path specifically.
describe('init() — cache-first / stale-while-revalidate (remote-backed repository)', () => {
  afterEach(() => {
    // Restore the default plain-Dexie repository so later tests/files aren't
    // left pointed at a fake one.
    setTripRepository(new DexieTripRepository());
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** A fake `TripRepository` that is NOT a `DexieTripRepository` instance —
   *  this is exactly what makes `init()` take the cache-first/remote-backed
   *  branch rather than the plain-Dexie fast path. */
  function makeFakeRemoteRepo(overrides: Partial<TripRepository>): TripRepository {
    return {
      async seedIfEmpty() {},
      async getTrip() {
        return undefined;
      },
      async saveTrip() {},
      async listPlaces() {
        return [];
      },
      async upsertPlace(p) {
        return p;
      },
      async deletePlace() {},
      async updatePlaceIfUnchanged(place) {
        return { place, conflict: false };
      },
      async listDays() {
        return [];
      },
      async listItinerary() {
        return [];
      },
      async listAllItinerary() {
        return [];
      },
      async upsertItineraryItem(i) {
        return i;
      },
      async deleteItineraryItem() {},
      async listExpenses() {
        return [];
      },
      async upsertExpense(e) {
        return e;
      },
      async deleteExpense() {},
      async exportSnapshot() {
        throw new Error('not used by these tests');
      },
      async importSnapshot() {},
      ...overrides,
    };
  }

  it('paints instantly from the already-cached local trip, then reconciles with the remote in the background', async () => {
    const cached = useTripStore.getState();
    const cachedTrip = cached.trip as Trip;
    const remoteTrip: Trip = { ...cachedTrip, name: 'Remote-updated trip name' };
    const gate = deferred<void>();
    let remoteGetTripCalls = 0;

    const fakeRemote = makeFakeRemoteRepo({
      async getTrip() {
        remoteGetTripCalls += 1;
        await gate.promise;
        return remoteTrip;
      },
      async listPlaces() {
        return useTripStore.getState().places;
      },
      async listDays() {
        return useTripStore.getState().days;
      },
      async listAllItinerary() {
        return Object.values(useTripStore.getState().itineraryByDay).flat();
      },
      async listExpenses() {
        return useTripStore.getState().expenses;
      },
    });
    setTripRepository(fakeRemote);

    // init() resolves quickly here: the cached trip already painted, so the
    // background remote refresh is deliberately NOT awaited before this
    // promise settles.
    await useTripStore.getState().init();

    expect(useTripStore.getState().loading).toBe(false);
    expect(useTripStore.getState().trip?.name).toBe(cachedTrip.name);
    expect(useTripStore.getState().syncing).toBe(true);

    // Let the "remote" respond.
    gate.resolve();
    await waitUntil(() => useTripStore.getState().syncing === false);

    expect(useTripStore.getState().trip?.name).toBe('Remote-updated trip name');
    expect(useTripStore.getState().syncError).toBeUndefined();
    expect(remoteGetTripCalls).toBe(1);
  });

  it('shows the blocking cold-start state (loading=true) only when there is genuinely no local cache, then resolves from the remote', async () => {
    await Dexie.delete('china-trip-planner');
    const remoteTrip: Trip = {
      id: 'trip-remote-only',
      name: 'Remote-only trip',
      startDate: '2026-01-01',
      endDate: '2026-01-05',
      homeCurrency: 'AUD',
      tripCurrency: 'CNY',
      rates: { AUD: 1 },
      cities: [],
    };
    const fakeRemote = makeFakeRemoteRepo({
      async getTrip() {
        return remoteTrip;
      },
    });
    setTripRepository(fakeRemote);

    // With no local cache at all, init() must await the background fetch
    // (there's nothing else to paint yet) before resolving.
    await useTripStore.getState().init();

    expect(useTripStore.getState().loading).toBe(false);
    expect(useTripStore.getState().syncing).toBe(false);
    expect(useTripStore.getState().trip?.id).toBe('trip-remote-only');
  });

  it('a background refresh failure sets syncError, unblocks loading, and preserves the already-cached data', async () => {
    const cachedTrip = useTripStore.getState().trip as Trip;
    const fakeRemote = makeFakeRemoteRepo({
      async getTrip() {
        throw new Error('network down');
      },
    });
    setTripRepository(fakeRemote);

    await useTripStore.getState().init();
    await waitUntil(() => useTripStore.getState().syncing === false);

    expect(useTripStore.getState().loading).toBe(false);
    expect(useTripStore.getState().syncError).toBe('network down');
    // The cached trip from before the failed refresh is left in place, not
    // cleared.
    expect(useTripStore.getState().trip?.id).toBe(cachedTrip.id);
  });

  it('an outdated init() call\'s background refresh cannot clobber a newer call\'s result (StrictMode double-invoke / rapid re-init)', async () => {
    const cachedTrip = useTripStore.getState().trip as Trip;
    const staleGate = deferred<void>();
    const staleTrip: Trip = { ...cachedTrip, name: 'Stale — from the first, outdated call' };
    const freshTrip: Trip = { ...cachedTrip, name: 'Fresh — from the second, current call' };

    let call = 0;
    const fakeRemote = makeFakeRemoteRepo({
      async getTrip() {
        call += 1;
        if (call === 1) {
          // The first call's remote fetch hangs until released below, well
          // after the second call has already completed.
          await staleGate.promise;
          return staleTrip;
        }
        return freshTrip;
      },
    });
    setTripRepository(fakeRemote);

    // The first call fully completes its local paint and kicks off its own
    // (hanging) background refresh before the second call starts — modeling
    // e.g. a component remount shortly after the first `init()`, not a
    // same-tick double-invoke.
    const firstInit = useTripStore.getState().init();
    await firstInit;
    expect(useTripStore.getState().syncing).toBe(true);
    expect(useTripStore.getState().trip?.name).toBe(cachedTrip.name);

    // The second, current call also paints from cache, then kicks off its
    // own background refresh — which (per the fake above) resolves quickly.
    const secondInit = useTripStore.getState().init();
    await secondInit;
    await waitUntil(() => useTripStore.getState().trip?.name === freshTrip.name);

    // Now let the first (outdated) call's slow "remote" respond — its result
    // must be discarded, not overwrite the second call's already-settled state.
    staleGate.resolve();
    await waitUntil(() => useTripStore.getState().syncing === false);

    expect(useTripStore.getState().trip?.name).toBe(freshTrip.name);
  });

  it('resetTripStoreForSignOut invalidates an in-flight background refresh and clears state', async () => {
    const cachedTrip = useTripStore.getState().trip as Trip;
    const gate = deferred<void>();
    const remoteTrip: Trip = { ...cachedTrip, name: 'Should never appear after sign-out' };
    const fakeRemote = makeFakeRemoteRepo({
      async getTrip() {
        await gate.promise;
        return remoteTrip;
      },
    });
    setTripRepository(fakeRemote);

    const initPromise = useTripStore.getState().init();
    // Cached trip paints and init() resolves right after kicking off its
    // background refresh (not awaiting the hung "remote").
    await initPromise;
    expect(useTripStore.getState().syncing).toBe(true);

    resetTripStoreForSignOut();
    expect(useTripStore.getState().trip).toBeUndefined();
    expect(useTripStore.getState().syncing).toBe(false);
    expect(useTripStore.getState().loading).toBe(true);

    // Let the stale refresh resolve — it must not repaint the reset state.
    gate.resolve();
    await new Promise((r) => setTimeout(r, 20));

    expect(useTripStore.getState().trip).toBeUndefined();
    expect(useTripStore.getState().loading).toBe(true);
    expect(useTripStore.getState().syncing).toBe(false);
  });

  // Coverage gap closed: the pre-auth (plain DexieTripRepository) branch of
  // init() already had a dedicated test for the `stagedAssignmentsVersion`
  // guard (see 'init() background refresh vs. a concurrent staging action'
  // below), but the signed-in, remote-backed cache-first/stale-while-
  // revalidate branch exercised here shares the exact same guard logic
  // (`stagedAssignmentsInitPatch`) against its own, separate
  // `stagedAssignmentRepository.listAll()` call in the BACKGROUND refresh
  // step -- and had no test of its own. Staged assignments are always read
  // from the local table regardless of which branch runs, so the race is
  // real here too: a local trip is already cached (this file's outer
  // `beforeEach` seeds one), so this call's background remote refresh is not
  // awaited by `init()` itself, giving a `saveStagedAssignments()` call a
  // real window to complete WHILE that refresh's own (now-stale) staged-rows
  // read is still in flight.
  it("a Save that completes staging while init()'s BACKGROUND remote refresh is mid-flight re-reading it does not get resurrected once that refresh resolves (signed-in cache-first path)", async () => {
    const place = useTripStore.getState().places.find((p) => !p.dayId)!;
    const day = useTripStore.getState().days[0];
    await useTripStore.getState().stagePlaceAssignment(place.id, day.id);

    const cachedTrip = useTripStore.getState().trip as Trip;
    const fakeRemote = makeFakeRemoteRepo({
      async getTrip() {
        return cachedTrip;
      },
      async listPlaces() {
        return useTripStore.getState().places;
      },
      async listDays() {
        return useTripStore.getState().days;
      },
      async listAllItinerary() {
        return Object.values(useTripStore.getState().itineraryByDay).flat();
      },
      async listExpenses() {
        return useTripStore.getState().expenses;
      },
    });
    setTripRepository(fakeRemote);

    // init() calls stagedAssignmentRepository.listAll() TWICE when a local
    // trip is already cached: once (awaited) in the synchronous cache-paint
    // step, and again (NOT awaited by init() itself) in the background
    // remote-refresh step. Let the first call resolve normally; hold the
    // second one open on `gate` until explicitly released, mirroring the
    // exact staleness hazard `stagedAssignmentsVersion` guards against, now
    // through the signed-in branch instead of the pre-auth one.
    let listAllCalls = 0;
    const gate = deferred<void>();
    const originalListAll = stagedAssignmentRepository.listAll.bind(stagedAssignmentRepository);
    const listAllSpy = vi.spyOn(stagedAssignmentRepository, 'listAll').mockImplementation(async () => {
      listAllCalls += 1;
      const snapshot = await originalListAll();
      if (listAllCalls === 2) await gate.promise;
      return snapshot;
    });

    try {
      const initPromise = useTripStore.getState().init();
      // Resolves once the cache-paint step lands -- the local trip was
      // already cached, so init() does not wait on the (blocked) background
      // refresh.
      await initPromise;
      expect(useTripStore.getState().syncing).toBe(true);
      expect(useTripStore.getState().stagedAssignments[place.id]).toEqual({
        dayId: day.id,
        city: place.city,
      });

      // Save runs to completion for real -- clearing staging entirely --
      // WHILE the background refresh's stale staged-rows read is still
      // pending.
      await useTripStore.getState().saveStagedAssignments();
      expect(useTripStore.getState().stagedAssignments).toEqual({});

      // Now let the background refresh's delayed (now-stale, still showing
      // the staged entry) snapshot resolve and let the call finish.
      gate.resolve();
      await waitUntil(() => useTripStore.getState().syncing === false);

      // init()'s stale snapshot must NOT resurrect the already-cleared
      // staged assignment -- the guard under test protects exactly this
      // field. (It does NOT protect `places` against this same class of
      // race -- see the dedicated `it.fails` case directly below, which
      // documents that as a separate, pre-existing gap discovered while
      // writing this test, not something this guard claims to cover.)
      expect(useTripStore.getState().stagedAssignments).toEqual({});
      expect(await stagedAssignmentRepository.listAll()).toHaveLength(0);
    } finally {
      listAllSpy.mockRestore();
    }
  });

  // DISCOVERED WHILE CLOSING THE ABOVE COVERAGE GAP -- not a regression in
  // the staged-assignments feature's own code, but a real, adjacent gap in
  // init()'s general stale-while-revalidate design that the staged-
  // assignments work made materially easier to hit: `stagedAssignmentsVersion`
  // guarded ONLY the `stagedAssignments` field of this same background
  // refresh's `set()` call. `places` (also refreshed by the very same
  // Promise.all, from the very same `listPlaces()` invocation captured
  // before the write) had no equivalent guard, so a `saveStagedAssignments()`
  // commit that completed while this background refresh's OWN `listPlaces()`
  // snapshot (dispatched before the commit, resolving after it) was still in
  // flight got its just-committed `dayId` silently reverted in memory when
  // that stale snapshot landed -- even though the remote write succeeded and
  // the staging table itself (correctly) did NOT resurrect. Fixed by
  // `mutationVersion`/`domainDataInitPatch` -- the exact same guard shape as
  // `stagedAssignmentsVersion`/`stagedAssignmentsInitPatch`, applied to
  // `places`/`days`/`itineraryByDay`/`expenses` instead. Was `it.fails` while
  // this gap was open (documenting the broken behavior without failing
  // `npm test` for unrelated changes); now a plain `it`.
  it(
    "a Save that completes while init()'s BACKGROUND refresh is mid-flight does NOT get its committed place reverted by that refresh's stale `places` snapshot",
    async () => {
      const place = useTripStore.getState().places.find((p) => !p.dayId)!;
      const day = useTripStore.getState().days[0];
      await useTripStore.getState().stagePlaceAssignment(place.id, day.id);

      const cachedTrip = useTripStore.getState().trip as Trip;
      const fakeRemote = makeFakeRemoteRepo({
        async getTrip() {
          return cachedTrip;
        },
        async listPlaces() {
          return useTripStore.getState().places;
        },
        async listDays() {
          return useTripStore.getState().days;
        },
        async listAllItinerary() {
          return Object.values(useTripStore.getState().itineraryByDay).flat();
        },
        async listExpenses() {
          return useTripStore.getState().expenses;
        },
      });
      setTripRepository(fakeRemote);

      let listAllCalls = 0;
      const gate = deferred<void>();
      const originalListAll = stagedAssignmentRepository.listAll.bind(stagedAssignmentRepository);
      const listAllSpy = vi.spyOn(stagedAssignmentRepository, 'listAll').mockImplementation(async () => {
        listAllCalls += 1;
        const snapshot = await originalListAll();
        if (listAllCalls === 2) await gate.promise;
        return snapshot;
      });

      try {
        await useTripStore.getState().init();
        await useTripStore.getState().saveStagedAssignments();
        gate.resolve();
        await waitUntil(() => useTripStore.getState().syncing === false);

        // The real, already-committed assignment survives the stale
        // background refresh (guarded by `mutationVersion`/
        // `domainDataInitPatch`).
        expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(day.id);
      } finally {
        listAllSpy.mockRestore();
      }
    },
  );

  // Coverage for the OTHER fields `mutationVersion`/`domainDataInitPatch`
  // guard -- the test above only proves `places` survives; this proves the
  // exact same background-refresh-vs-write race is also closed for
  // `itineraryByDay` and `expenses` (a single shared counter guards all
  // four fields together, so one write to either is enough to invalidate
  // the whole stale snapshot -- see `mutationVersion`'s module comment).
  it("an itinerary write AND an expense write that complete while init()'s BACKGROUND refresh is mid-flight are also not reverted by that refresh's stale snapshot", async () => {
    const day = useTripStore.getState().days[0];

    const cachedTrip = useTripStore.getState().trip as Trip;
    const gate = deferred<void>();
    const fakeRemote = makeFakeRemoteRepo({
      async getTrip() {
        return cachedTrip;
      },
      async listPlaces() {
        return useTripStore.getState().places;
      },
      async listDays() {
        return useTripStore.getState().days;
      },
      async listAllItinerary() {
        // Captured immediately (mirroring the real staleness hazard: the
        // read observes pre-write data but doesn't settle until later) --
        // this single delayed promise is enough to hold up the whole
        // refresh's `Promise.all`, so `listPlaces`/`listDays`/`listExpenses`
        // don't need their own separate delay.
        const snapshot = Object.values(useTripStore.getState().itineraryByDay).flat();
        await gate.promise;
        return snapshot;
      },
      async listExpenses() {
        return useTripStore.getState().expenses;
      },
    });
    setTripRepository(fakeRemote);

    await useTripStore.getState().init();

    // While the background refresh's now-stale itinerary/expense snapshot
    // is still in flight, commit real writes to both.
    const item = await useTripStore.getState().addItineraryItem({ dayId: day.id, title: 'Snack stop' });
    const expense = await useTripStore.getState().addExpense({
      category: 'Food',
      label: 'Snack',
      amount: 12,
      currency: 'CNY',
      paid: true,
    });

    gate.resolve();
    await waitUntil(() => useTripStore.getState().syncing === false);

    expect(useTripStore.getState().itineraryByDay[day.id]?.some((i) => i.id === item.id)).toBe(true);
    expect(useTripStore.getState().expenses.some((e) => e.id === expense.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commitPlaceDraft / savePlaceDraft / removePlace-drafts (Phase 4 items 4/5).
//
// PlaceDetailModal.test.tsx exercises the UI against a fully stubbed
// getPlaceDraft/savePlaceDraft/discardPlaceDraft/commitPlaceDraft (an
// in-memory fake keyed by placeId), which is correct for that component's own
// job but means the REAL store implementation of commitPlaceDraft — the
// conditional-update conflict-retry loop, the MAX_DRAFT_COMMIT_ATTEMPTS
// bound, and savePlaceDraft's "baseUpdatedAt held fixed for the session"
// rule — had zero test coverage anywhere else. These tests close that gap,
// running against the real Dexie-backed repository (matching this file's
// other store-level tests) except where a controlled always-conflicting
// repository is needed to force the pathological retry-exhaustion path.
// ---------------------------------------------------------------------------
describe('commitPlaceDraft — draft lifecycle against the real (Dexie) repository', () => {
  it('commits with no conflict: place updated in store + repo, draft cleared', async () => {
    const place = useTripStore.getState().places[0];
    await useTripStore.getState().savePlaceDraft(place.id, { description: 'New notes', selfReview: undefined });
    expect(await useTripStore.getState().getPlaceDraft(place.id)).toBeDefined();

    const { place: saved, merged } = await useTripStore.getState().commitPlaceDraft(place.id);

    expect(merged).toBe(false);
    expect(saved.description).toBe('New notes');
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.description).toBe('New notes');
    // The committed row is readable straight back out of the real repository too.
    const persisted = await db.places.get(place.id);
    expect(persisted?.description).toBe('New notes');
    expect(await useTripStore.getState().getPlaceDraft(place.id)).toBeUndefined();
  });

  it('detects a concurrent remote edit via baseUpdatedAt, append-merges instead of overwriting, and clears the draft', async () => {
    const place = useTripStore.getState().places[0];
    await useTripStore.getState().savePlaceDraft(place.id, { description: 'My local notes', selfReview: undefined });

    // Simulate "another device" writing directly to the underlying row
    // between the draft starting and Save being pressed — same shape a real
    // concurrent write would leave: a newer `updatedAt`, so the conditional
    // update below can no longer match the draft's `baseUpdatedAt`.
    const remoteUpdated: Place = {
      ...place,
      description: 'Remote notes from the other device',
      updatedAt: new Date(Date.parse(place.updatedAt) + 1000).toISOString(),
    };
    await db.places.put(remoteUpdated);

    const { place: saved, merged } = await useTripStore.getState().commitPlaceDraft(place.id);

    expect(merged).toBe(true);
    // Nothing discarded — both sides survive, split cleanly by the sentinel.
    expect(splitMergedProse(saved.description)).toEqual([
      'My local notes',
      'Remote notes from the other device',
    ]);
    expect(await useTripStore.getState().getPlaceDraft(place.id)).toBeUndefined();
  });
});

describe('commitPlaceDraft — pathological repeated-conflict bound (fake, always-conflicting repository)', () => {
  afterEach(() => {
    setTripRepository(new DexieTripRepository());
  });

  it('gives up after repeated conflicts, throws, and leaves the local draft intact so nothing typed is lost', async () => {
    const place = useTripStore.getState().places[0];
    await useTripStore.getState().savePlaceDraft(place.id, { description: 'My notes', selfReview: undefined });

    let calls = 0;
    const alwaysConflictRepo: TripRepository = {
      async seedIfEmpty() {},
      async getTrip() {
        return undefined;
      },
      async saveTrip() {},
      async listPlaces() {
        return [];
      },
      async upsertPlace(p) {
        return p;
      },
      async deletePlace() {},
      async updatePlaceIfUnchanged(candidate) {
        calls += 1;
        // Every attempt loses the race against a "new" remote edit, forcing
        // commitPlaceDraft's retry loop to run all the way to its bound.
        return {
          place: { ...candidate, description: `remote edit #${calls}`, updatedAt: new Date(2030, 0, calls).toISOString() },
          conflict: true,
        };
      },
      async listDays() {
        return [];
      },
      async listItinerary() {
        return [];
      },
      async listAllItinerary() {
        return [];
      },
      async upsertItineraryItem(i) {
        return i;
      },
      async deleteItineraryItem() {},
      async listExpenses() {
        return [];
      },
      async upsertExpense(e) {
        return e;
      },
      async deleteExpense() {},
      async exportSnapshot() {
        throw new Error('not used by this test');
      },
      async importSnapshot() {},
    };
    setTripRepository(alwaysConflictRepo);

    await expect(useTripStore.getState().commitPlaceDraft(place.id)).rejects.toThrow(
      /too many concurrent edits/,
    );
    // Pins MAX_DRAFT_COMMIT_ATTEMPTS's current value (5, per useTripStore.ts)
    // — a deliberate bound, so a change to it should be a conscious test
    // update, not a silent drift.
    expect(calls).toBe(5);

    // The whole point: a pathological run of bad luck must not cost the user
    // their typed text. Save is meant to just be retryable.
    const draft = await useTripStore.getState().getPlaceDraft(place.id);
    expect(draft?.description).toBe('My notes');
    // And the store's in-memory place was never clobbered by a half-applied write.
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.description).not.toBe('My notes');
  });

  it('accumulates repeated conflicts without losing any earlier text: N sentinels -> N+1 segments', async () => {
    const place = useTripStore.getState().places[0];
    await useTripStore.getState().savePlaceDraft(place.id, { description: 'My notes', selfReview: undefined });

    let calls = 0;
    // Conflicts on the first two attempts (two different concurrent remote
    // edits, e.g. two separate saves from the other device before this one
    // finally lands), then succeeds on the third.
    const twiceThenSucceeds: TripRepository = {
      async seedIfEmpty() {},
      async getTrip() {
        return undefined;
      },
      async saveTrip() {},
      async listPlaces() {
        return [];
      },
      async upsertPlace(p) {
        return p;
      },
      async deletePlace() {},
      async updatePlaceIfUnchanged(candidate, baseUpdatedAt) {
        calls += 1;
        if (calls <= 2) {
          return {
            place: { ...candidate, description: `remote edit #${calls}`, updatedAt: new Date(2030, 0, calls).toISOString() },
            conflict: true,
          };
        }
        return { place: { ...candidate, updatedAt: baseUpdatedAt }, conflict: false };
      },
      async listDays() {
        return [];
      },
      async listItinerary() {
        return [];
      },
      async listAllItinerary() {
        return [];
      },
      async upsertItineraryItem(i) {
        return i;
      },
      async deleteItineraryItem() {},
      async listExpenses() {
        return [];
      },
      async upsertExpense(e) {
        return e;
      },
      async deleteExpense() {},
      async exportSnapshot() {
        throw new Error('not used by this test');
      },
      async importSnapshot() {},
    };
    setTripRepository(twiceThenSucceeds);

    const { place: saved, merged } = await useTripStore.getState().commitPlaceDraft(place.id);

    expect(calls).toBe(3);
    expect(merged).toBe(true);
    expect(splitMergedProse(saved.description)).toEqual(['My notes', 'remote edit #1', 'remote edit #2']);
    expect(await useTripStore.getState().getPlaceDraft(place.id)).toBeUndefined();
  });
});

describe('savePlaceDraft — baseUpdatedAt held fixed across a debounced editing session', () => {
  it('does not rebase baseUpdatedAt on a second debounced save, even if the place itself changed in between', async () => {
    const place = useTripStore.getState().places[0];
    await useTripStore.getState().savePlaceDraft(place.id, { description: 'First keystroke', selfReview: undefined });
    const draft1 = await useTripStore.getState().getPlaceDraft(place.id);
    expect(draft1?.baseUpdatedAt).toBe(place.updatedAt);

    // A concurrent write lands on this exact place mid-session (e.g. the
    // other device saved first) — bumps `updatedAt` in both the repo and the
    // in-memory store, same as a real background sync would.
    const bumped: Place = { ...place, updatedAt: new Date(Date.parse(place.updatedAt) + 5000).toISOString() };
    await db.places.put(bumped);
    useTripStore.setState((s) => ({ places: s.places.map((p) => (p.id === place.id ? bumped : p)) }));

    await useTripStore.getState().savePlaceDraft(place.id, {
      description: 'First keystroke plus more',
      selfReview: undefined,
    });
    const draft2 = await useTripStore.getState().getPlaceDraft(place.id);

    // If this were re-derived from "the place's current updatedAt" on every
    // save instead of held fixed from the first save of the session, this
    // second save would silently adopt the just-bumped `updatedAt` as its
    // base — and commitPlaceDraft would then compare against the wrong
    // baseline, missing the very conflict it exists to detect.
    expect(draft2?.baseUpdatedAt).toBe(draft1?.baseUpdatedAt);
    expect(draft2?.baseUpdatedAt).not.toBe(bumped.updatedAt);
  });
});

describe('removePlace — also deletes any local draft for that place (no orphaned db.placeDrafts row)', () => {
  it('clears the draft when the place it belongs to is deleted', async () => {
    const place = useTripStore.getState().places[0];
    await useTripStore.getState().savePlaceDraft(place.id, { description: 'WIP', selfReview: undefined });
    expect(await useTripStore.getState().getPlaceDraft(place.id)).toBeDefined();

    await useTripStore.getState().removePlace(place.id);

    expect(await useTripStore.getState().getPlaceDraft(place.id)).toBeUndefined();
    expect(await db.placeDrafts.get(place.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Map "Save changes" staging model: stagePlaceAssignment /
// discardStagedAssignmentsForCity / saveStagedAssignments, plus the
// getEffectiveDayId/getStagedAssignmentCount* selector helpers. Mirrors the
// commitPlaceDraft tests above in spirit (a local-only, never-synced editing
// state that must survive a reload and never lose data on a failed commit).
// ---------------------------------------------------------------------------

describe('stagePlaceAssignment', () => {
  it('records a staged entry without touching the saved place or its itinerary', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => !p.dayId)!;
    const day = days[0];

    await useTripStore.getState().stagePlaceAssignment(place.id, day.id);

    expect(useTripStore.getState().stagedAssignments[place.id]).toEqual({
      dayId: day.id,
      city: place.city,
    });
    // Nothing committed to the saved place/itinerary yet.
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBeUndefined();
    expect(linkedItemsOn(day.id, place.id)).toHaveLength(0);
    // Persisted to the local staging table too (survives a reload — see the
    // dedicated test below).
    expect(await stagedAssignmentRepository.listAll()).toContainEqual(
      expect.objectContaining({ placeId: place.id, dayId: day.id, city: place.city }),
    );
  });

  it('staging back to the currently-saved dayId removes the staged row instead of writing a no-op change', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => !p.dayId)!; // saved dayId is undefined
    const day = days[0];

    await useTripStore.getState().stagePlaceAssignment(place.id, day.id);
    expect(useTripStore.getState().stagedAssignments[place.id]).toBeDefined();

    await useTripStore.getState().stagePlaceAssignment(place.id, undefined); // back to saved (undefined)

    expect(useTripStore.getState().stagedAssignments[place.id]).toBeUndefined();
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(0);
  });

  it('staging "unassign" on an already-assigned place IS a real staged change (not treated as a no-op)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days[0];
    await useTripStore.getState().assignPlaceToDay(place.id, day.id); // saved dayId = day.id

    await useTripStore.getState().stagePlaceAssignment(place.id, undefined);

    expect(useTripStore.getState().stagedAssignments[place.id]).toEqual({
      dayId: undefined,
      city: place.city,
    });
    // Saved place is untouched until Save.
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(day.id);
  });

  it('re-staging a place to a different day updates the existing staged row (not a second entry)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => !p.dayId)!;

    await useTripStore.getState().stagePlaceAssignment(place.id, days[0].id);
    await useTripStore.getState().stagePlaceAssignment(place.id, days[1].id);

    expect(useTripStore.getState().stagedAssignments[place.id]?.dayId).toBe(days[1].id);
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(1);
  });

  it('is a no-op for an unknown placeId', async () => {
    await expect(
      useTripStore.getState().stagePlaceAssignment('no-such-place', useTripStore.getState().days[0].id),
    ).resolves.toBeUndefined();
    expect(useTripStore.getState().stagedAssignments).toEqual({});
  });

  it('staged assignments survive a simulated reload (persisted locally, loaded by init())', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => !p.dayId)!;
    const day = days[0];
    await useTripStore.getState().stagePlaceAssignment(place.id, day.id);

    await useTripStore.getState().init(); // re-load from IndexedDB, mirrors a page reload

    expect(useTripStore.getState().stagedAssignments[place.id]).toEqual({
      dayId: day.id,
      city: place.city,
    });
  });
});

describe('discardStagedAssignmentsForCity', () => {
  it("clears only the given city's staged entries, leaving other cities untouched", async () => {
    const { places, days } = useTripStore.getState();
    const homeDay = days[0];
    const placeInHomeCity = places.find((p) => !p.dayId && p.city === homeDay.city)!;
    const placeElsewhere = places.find((p) => !p.dayId && p.city !== homeDay.city)!;
    const dayElsewhere = days.find((d) => d.city === placeElsewhere.city)!;

    await useTripStore.getState().stagePlaceAssignment(placeInHomeCity.id, homeDay.id);
    await useTripStore.getState().stagePlaceAssignment(placeElsewhere.id, dayElsewhere.id);
    expect(getStagedAssignmentCount(useTripStore.getState().stagedAssignments)).toBe(2);

    await useTripStore.getState().discardStagedAssignmentsForCity(homeDay.city);

    const staged = useTripStore.getState().stagedAssignments;
    expect(staged[placeInHomeCity.id]).toBeUndefined();
    expect(staged[placeElsewhere.id]).toEqual({ dayId: dayElsewhere.id, city: placeElsewhere.city });
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(1);
  });

  it('no-ops for a city with nothing staged', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => !p.dayId)!;
    await useTripStore.getState().stagePlaceAssignment(place.id, days[0].id);

    await useTripStore.getState().discardStagedAssignmentsForCity('A City With Nothing Staged');

    expect(getStagedAssignmentCount(useTripStore.getState().stagedAssignments)).toBe(1);
  });
});

describe('saveStagedAssignments', () => {
  afterEach(() => {
    setTripRepository(new DexieTripRepository());
  });

  it('is a no-op (resolves immediately, nothing thrown) when nothing is staged', async () => {
    await expect(useTripStore.getState().saveStagedAssignments()).resolves.toBeUndefined();
  });

  it('batch-commits every staged entry across cities via the normal write-through path, then clears staging', async () => {
    const { places, days } = useTripStore.getState();
    const homeDay = days[0];
    const placeInHomeCity = places.find((p) => !p.dayId && p.city === homeDay.city)!;
    const placeElsewhere = places.find((p) => !p.dayId && p.city !== homeDay.city)!;
    const dayElsewhere = days.find((d) => d.city === placeElsewhere.city)!;

    await useTripStore.getState().stagePlaceAssignment(placeInHomeCity.id, homeDay.id);
    await useTripStore.getState().stagePlaceAssignment(placeElsewhere.id, dayElsewhere.id);

    await useTripStore.getState().saveStagedAssignments();

    expect(getStagedAssignmentCount(useTripStore.getState().stagedAssignments)).toBe(0);
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(0);
    expect(useTripStore.getState().places.find((p) => p.id === placeInHomeCity.id)?.dayId).toBe(homeDay.id);
    expect(useTripStore.getState().places.find((p) => p.id === placeElsewhere.id)?.dayId).toBe(dayElsewhere.id);
    // assignPlaceToDay's usual itinerary-linking behavior applies -- one
    // linked (untimed) stop per newly-assigned place.
    expect(linkedItemsOn(homeDay.id, placeInHomeCity.id)).toHaveLength(1);
    expect(linkedItemsOn(dayElsewhere.id, placeElsewhere.id)).toHaveLength(1);
  });

  it('persists through a simulated reload once saved (a real commit, not just in-memory)', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => !p.dayId)!;
    await useTripStore.getState().stagePlaceAssignment(place.id, days[0].id);

    await useTripStore.getState().saveStagedAssignments();
    await useTripStore.getState().init();

    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(days[0].id);
    expect(useTripStore.getState().stagedAssignments).toEqual({});
  });

  it('offline: refuses to attempt the save, throws, and leaves staging fully intact', async () => {
    const place = useTripStore.getState().places.find((p) => !p.dayId)!;
    const day = useTripStore.getState().days[0];
    await useTripStore.getState().stagePlaceAssignment(place.id, day.id);

    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
    try {
      await expect(useTripStore.getState().saveStagedAssignments()).rejects.toThrow(/offline/i);
    } finally {
      Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
    }

    expect(useTripStore.getState().stagedAssignments[place.id]).toEqual({ dayId: day.id, city: place.city });
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(1);
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBeUndefined();
  });

  it('on a failed batch commit, stops at the first failure: the entry that already committed is cleared from staging (it is a real, committed change now), and the failing entry plus anything not yet attempted stay staged untouched', async () => {
    const { places, days } = useTripStore.getState();
    const homeDay = days[0];
    const okPlace = places.find((p) => !p.dayId && p.city === homeDay.city)!;
    const remainingWishlist = places.filter((p) => !p.dayId && p.id !== okPlace.id);
    const failingPlace = remainingWishlist[0];
    const neverAttemptedPlace = remainingWishlist[1];
    const failingDay = days.find((d) => d.city === failingPlace.city) ?? homeDay;
    const neverAttemptedDay = days.find((d) => d.city === neverAttemptedPlace.city) ?? homeDay;

    // Staged in this exact order -- saveStagedAssignments commits
    // sequentially in staged order (Object.entries preserves insertion
    // order for these non-numeric string keys), so okPlace commits first,
    // failingPlace fails second, and neverAttemptedPlace's turn never comes.
    await useTripStore.getState().stagePlaceAssignment(okPlace.id, homeDay.id);
    await useTripStore.getState().stagePlaceAssignment(failingPlace.id, failingDay.id);
    await useTripStore.getState().stagePlaceAssignment(neverAttemptedPlace.id, neverAttemptedDay.id);

    const baseRepo = new DexieTripRepository();
    const failingRepo: TripRepository = {
      seedIfEmpty: () => baseRepo.seedIfEmpty(),
      getTrip: () => baseRepo.getTrip(),
      saveTrip: (t) => baseRepo.saveTrip(t),
      listPlaces: (id) => baseRepo.listPlaces(id),
      upsertPlace: (place) =>
        place.id === failingPlace.id
          ? Promise.reject(new Error('network down'))
          : baseRepo.upsertPlace(place),
      deletePlace: (id) => baseRepo.deletePlace(id),
      updatePlaceIfUnchanged: (p, b) => baseRepo.updatePlaceIfUnchanged(p, b),
      listDays: (id) => baseRepo.listDays(id),
      listItinerary: (id) => baseRepo.listItinerary(id),
      listAllItinerary: (id) => baseRepo.listAllItinerary(id),
      upsertItineraryItem: (i) => baseRepo.upsertItineraryItem(i),
      deleteItineraryItem: (id) => baseRepo.deleteItineraryItem(id),
      listExpenses: (id) => baseRepo.listExpenses(id),
      upsertExpense: (e) => baseRepo.upsertExpense(e),
      deleteExpense: (id) => baseRepo.deleteExpense(id),
      exportSnapshot: () => baseRepo.exportSnapshot(),
      importSnapshot: (s) => baseRepo.importSnapshot(s),
    };
    setTripRepository(failingRepo);

    await expect(useTripStore.getState().saveStagedAssignments()).rejects.toThrow(/network down/);

    // okPlace: a REAL commit -- place updated (in-memory AND in the
    // repository itself, not just the store's optimistic copy), itinerary
    // linked, and no longer staged, since there is genuinely nothing left to
    // save for it.
    expect(useTripStore.getState().places.find((p) => p.id === okPlace.id)?.dayId).toBe(homeDay.id);
    expect(linkedItemsOn(homeDay.id, okPlace.id)).toHaveLength(1);
    const persistedOkPlace = (await baseRepo.listPlaces(okPlace.tripId)).find((p) => p.id === okPlace.id);
    expect(persistedOkPlace?.dayId).toBe(homeDay.id);
    expect(useTripStore.getState().stagedAssignments[okPlace.id]).toBeUndefined();
    expect(await stagedAssignmentRepository.listAll()).not.toContainEqual(
      expect.objectContaining({ placeId: okPlace.id }),
    );

    // failingPlace: genuinely failed to commit -- untouched, and still
    // staged so a retry (or Discard) has something correct to act on.
    expect(useTripStore.getState().places.find((p) => p.id === failingPlace.id)?.dayId).toBeUndefined();
    expect(useTripStore.getState().stagedAssignments[failingPlace.id]).toEqual({
      dayId: failingDay.id,
      city: failingPlace.city,
    });

    // neverAttemptedPlace: the batch stopped before its turn -- untouched,
    // still staged (NOT silently dropped just because it shared a batch
    // with a failure).
    expect(useTripStore.getState().places.find((p) => p.id === neverAttemptedPlace.id)?.dayId).toBeUndefined();
    expect(useTripStore.getState().stagedAssignments[neverAttemptedPlace.id]).toEqual({
      dayId: neverAttemptedDay.id,
      city: neverAttemptedPlace.city,
    });

    // Staging now reflects reality: exactly the two genuinely-uncommitted
    // entries remain, not all three.
    expect(getStagedAssignmentCount(useTripStore.getState().stagedAssignments)).toBe(2);
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(2);
  });
});

describe('init() background refresh vs. a concurrent staging action (stagedAssignmentsVersion guard)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a Save that completes staging while init() is mid-flight re-reading it does not get resurrected by init()\'s now-stale snapshot', async () => {
    const place = useTripStore.getState().places.find((p) => !p.dayId)!;
    const day = useTripStore.getState().days[0];
    await useTripStore.getState().stagePlaceAssignment(place.id, day.id);

    // Block init()'s staged-assignments read from RESOLVING (not from
    // reading) until the test explicitly releases it -- the snapshot is
    // captured immediately (mirroring the real staleness hazard: the read
    // was issued, and observed pre-Save data, but doesn't settle until
    // later), so saveStagedAssignments can be driven to full completion
    // WHILE init()'s Promise.all is still waiting on this one already-stale
    // result to be delivered.
    const originalListAll = stagedAssignmentRepository.listAll;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    vi.spyOn(stagedAssignmentRepository, 'listAll').mockImplementation(async () => {
      const snapshot = await originalListAll();
      await gate;
      return snapshot;
    });

    const initPromise = useTripStore.getState().init(); // starts reading staged rows; blocked on `gate`

    // While init()'s read of the (soon to be stale) staged rows is still in
    // flight, Save runs to completion for real and clears staging entirely.
    await useTripStore.getState().saveStagedAssignments();
    expect(useTripStore.getState().stagedAssignments).toEqual({});

    // Now let init()'s delayed read resolve (with the now-current, empty
    // table) and let the call finish.
    releaseGate();
    await initPromise;

    // init() must NOT resurrect the already-cleared staged assignment from
    // its stale in-flight snapshot.
    expect(useTripStore.getState().stagedAssignments).toEqual({});
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(day.id);
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(0);
  });
});

describe('getEffectiveDayId / getStagedAssignmentCount* selectors (pure helpers)', () => {
  it("getEffectiveDayId returns the staged value when present, else the place's saved dayId", () => {
    const place: Place = {
      id: 'p1',
      tripId: 't',
      name: 'X',
      lat: 0,
      lng: 0,
      city: 'Shanghai',
      status: 'wishlist',
      dayId: 'day-saved',
      updatedAt: new Date().toISOString(),
    };
    expect(getEffectiveDayId(place, {})).toBe('day-saved');
    expect(getEffectiveDayId(place, { p1: { dayId: 'day-staged', city: 'Shanghai' } })).toBe('day-staged');
    expect(getEffectiveDayId(place, { p1: { dayId: undefined, city: 'Shanghai' } })).toBeUndefined();
  });

  it('count helpers total and break down correctly by city', () => {
    const staged = {
      p1: { dayId: 'd1', city: 'Shanghai' },
      p2: { dayId: 'd2', city: 'Shanghai' },
      p3: { dayId: undefined, city: 'Suzhou' },
    };
    expect(getStagedAssignmentCount(staged)).toBe(3);
    expect(getStagedAssignmentCountForCity(staged, 'Shanghai')).toBe(2);
    expect(getStagedAssignmentCountForCity(staged, 'Suzhou')).toBe(1);
    expect(getStagedAssignmentCountForCity(staged, 'Nowhere')).toBe(0);
    expect(getStagedAssignmentCountsByCity(staged)).toEqual({ Shanghai: 2, Suzhou: 1 });
  });
});

describe('staged assignments are cleared alongside sign-out / whole-trip import', () => {
  it('resetTripStoreForSignOut clears in-memory staged assignments', async () => {
    const place = useTripStore.getState().places.find((p) => !p.dayId)!;
    await useTripStore.getState().stagePlaceAssignment(place.id, useTripStore.getState().days[0].id);
    expect(getStagedAssignmentCount(useTripStore.getState().stagedAssignments)).toBe(1);

    resetTripStoreForSignOut();

    expect(useTripStore.getState().stagedAssignments).toEqual({});
  });

  it('importJson clears any staged assignments -- old placeIds are no longer meaningful against the new snapshot', async () => {
    const place = useTripStore.getState().places.find((p) => !p.dayId)!;
    await useTripStore.getState().stagePlaceAssignment(place.id, useTripStore.getState().days[0].id);

    const json = await useTripStore.getState().exportJson();
    await useTripStore.getState().importJson(json);

    expect(useTripStore.getState().stagedAssignments).toEqual({});
    expect(await stagedAssignmentRepository.listAll()).toHaveLength(0);
  });
});

// A place is only "on" a day because a linked itinerary stop put it there —
// that assignment is what colours its map pin. Deleting the stops therefore
// has to release the places, or you get an itinerary that's empty on screen
// while the map still shows a full day of coloured pins.
describe('removeItineraryItem — releases the place it was linked to', () => {
  it('clears dayId/status so the pin goes back to unassigned grey', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days.find((d) => d.city === place.city)!;

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);
    const [linked] = linkedItemsOn(day.id, place.id);
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(day.id);

    await useTripStore.getState().removeItineraryItem(linked.id);

    const after = useTripStore.getState().places.find((p) => p.id === place.id)!;
    expect(after.dayId).toBeUndefined();
    expect(after.status).toBe('wishlist');
  });

  it('persists the release — a reload does not resurrect the assignment', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days.find((d) => d.city === place.city)!;

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);
    const [linked] = linkedItemsOn(day.id, place.id);
    await useTripStore.getState().removeItineraryItem(linked.id);

    await useTripStore.getState().init();
    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBeUndefined();
  });

  it('clearing every stop of a day leaves no place still assigned to it', async () => {
    const { places, days } = useTripStore.getState();
    const day = days[0];
    const inCity = places.filter((p) => p.city === day.city).slice(0, 3);
    expect(inCity.length).toBeGreaterThan(1);

    for (const p of inCity) await useTripStore.getState().assignPlaceToDay(p.id, day.id);
    const stops = useTripStore.getState().itineraryByDay[day.id] ?? [];
    for (const stop of stops) await useTripStore.getState().removeItineraryItem(stop.id);

    expect(useTripStore.getState().itineraryByDay[day.id] ?? []).toHaveLength(0);
    expect(useTripStore.getState().places.filter((p) => p.dayId === day.id)).toHaveLength(0);
  });

  it('leaves a place alone when it is assigned to a different day than the deleted stop', async () => {
    const { places, days } = useTripStore.getState();
    // Needs a city with at least two days.
    const place = places.find((p) => days.filter((d) => d.city === p.city).length > 1)!;
    expect(place).toBeDefined();
    const [dayA, dayB] = days.filter((d) => d.city === place.city);

    // The place lives on B; a second stop on A also references it (the shape
    // auto-plan and a moved assignment can leave behind). Deleting A's stop
    // must not undo the newer, deliberate assignment to B.
    await useTripStore.getState().assignPlaceToDay(place.id, dayB.id);
    const strayOnA = await useTripStore
      .getState()
      .addItineraryItem({ dayId: dayA.id, placeId: place.id, title: place.name });

    await useTripStore.getState().removeItineraryItem(strayOnA.id);

    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(dayB.id);
  });

  it('a hand-written stop with no linked place touches no place at all', async () => {
    const { places, days } = useTripStore.getState();
    const day = days[0];
    const before = places.map((p) => p.dayId);

    const item = await useTripStore.getState().addItineraryItem({ dayId: day.id, title: 'Coffee' });
    await useTripStore.getState().removeItineraryItem(item.id);

    expect(useTripStore.getState().places.map((p) => p.dayId)).toEqual(before);
  });
});

// The itinerary is the source of truth; a place's dayId is a copy of it.
// Data written by an older build (a deleted stop that left its place
// assigned, a moved stop that left it behind) is healed on load rather than
// trusted — that divergence is what made the Map show days the Itinerary
// didn't have.
describe('init() — reconciles place day assignments against the itinerary', () => {
  it('drops a stored dayId that no itinerary stop backs', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days.find((d) => d.city === place.city)!;

    // Write the divergence straight to the repository, behind the store's
    // back — exactly the shape an older build could leave.
    await tripRepository.upsertPlace({ ...place, dayId: day.id, status: 'planned' });
    await useTripStore.getState().init();

    const healed = useTripStore.getState().places.find((p) => p.id === place.id)!;
    expect(healed.dayId).toBeUndefined();
    expect(healed.status).toBe('wishlist');
  });

  it('persists the repair, so it does not have to be redone every load', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days.find((d) => d.city === place.city)!;

    await tripRepository.upsertPlace({ ...place, dayId: day.id, status: 'planned' });
    await useTripStore.getState().init();
    // Let the best-effort background write land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = (await tripRepository.listPlaces(place.tripId)).find((p) => p.id === place.id)!;
    expect(stored.dayId).toBeUndefined();
  });

  it('moves a place to the day its stop is actually on', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => days.filter((d) => d.city === p.city).length > 1)!;
    const [dayA, dayB] = days.filter((d) => d.city === place.city);

    await useTripStore.getState().assignPlaceToDay(place.id, dayB.id);
    // Point the place at the wrong day behind the store's back.
    const current = useTripStore.getState().places.find((p) => p.id === place.id)!;
    await tripRepository.upsertPlace({ ...current, dayId: dayA.id });
    await useTripStore.getState().init();

    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(dayB.id);
  });

  it('leaves agreeing data alone — a clean load writes nothing back', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days.find((d) => d.city === place.city)!;
    await useTripStore.getState().assignPlaceToDay(place.id, day.id);

    const before = useTripStore.getState().places.find((p) => p.id === place.id)!;
    await useTripStore.getState().init();
    const after = useTripStore.getState().places.find((p) => p.id === place.id)!;

    expect(after.dayId).toBe(day.id);
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

describe('updateItineraryItem — a moved stop takes its place with it', () => {
  it('follows the place to the new day', async () => {
    const { places, days } = useTripStore.getState();
    const place = places.find((p) => days.filter((d) => d.city === p.city).length > 1)!;
    const [dayA, dayB] = days.filter((d) => d.city === place.city);

    await useTripStore.getState().assignPlaceToDay(place.id, dayA.id);
    const [item] = linkedItemsOn(dayA.id, place.id);
    await useTripStore.getState().updateItineraryItem({ ...item, dayId: dayB.id });

    expect(useTripStore.getState().places.find((p) => p.id === place.id)?.dayId).toBe(dayB.id);
    expect(linkedItemsOn(dayB.id, place.id)).toHaveLength(1);
    expect(linkedItemsOn(dayA.id, place.id)).toHaveLength(0);
  });

  it('a same-day edit does not touch the place', async () => {
    const { places, days } = useTripStore.getState();
    const place = places[0];
    const day = days.find((d) => d.city === place.city)!;

    await useTripStore.getState().assignPlaceToDay(place.id, day.id);
    const before = useTripStore.getState().places.find((p) => p.id === place.id)!;
    const [item] = linkedItemsOn(day.id, place.id);
    await useTripStore.getState().updateItineraryItem({ ...item, startTime: '10:30' });

    expect(useTripStore.getState().places.find((p) => p.id === place.id)).toBe(before);
  });
});
