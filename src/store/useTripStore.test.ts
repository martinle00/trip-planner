// Store-level tests for assignPlaceToDay's itinerary-linking behavior
// (see useTripStore.ts). Uses fake-indexeddb (same pattern as
// data/persistence.test.ts) so the store's repository-backed actions run
// against a real (in-memory) IndexedDB with no browser required.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { useTripStore } from './useTripStore';
import type { DayPlan } from '../lib/autoplan';

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
