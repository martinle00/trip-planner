// @vitest-environment jsdom
//
// Unit tests for SyncedTripRepository's write-through/offline-fallback logic,
// using two trivial in-memory fake TripRepository implementations (not real
// Dexie or Supabase) so the test isolates just the wrapper's own behavior.
// jsdom environment needed so `navigator.onLine` can be stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncedTripRepository } from './syncedTripRepository';
import type { TripRepository } from './tripRepository';
import type { Trip } from './schema';

function makeFakeRepo(overrides: Partial<TripRepository> = {}): TripRepository & {
  saveTripCalls: Trip[];
} {
  const saveTripCalls: Trip[] = [];
  return {
    saveTripCalls,
    async seedIfEmpty() {},
    async getTrip() {
      return undefined;
    },
    async saveTrip(trip: Trip) {
      saveTripCalls.push(trip);
    },
    async listPlaces() {
      return [];
    },
    async upsertPlace(place) {
      return place;
    },
    async deletePlace() {},
    async listDays() {
      return [];
    },
    async listItinerary() {
      return [];
    },
    async listAllItinerary() {
      return [];
    },
    async upsertItineraryItem(item) {
      return item;
    },
    async deleteItineraryItem() {},
    async listExpenses() {
      return [];
    },
    async upsertExpense(expense) {
      return expense;
    },
    async deleteExpense() {},
    async exportSnapshot() {
      return { version: 2, trip: undefined as unknown as Trip, days: [], places: [], itinerary: [], expenses: [] };
    },
    async importSnapshot() {},
    ...overrides,
  };
}

const trip: Trip = {
  id: 'trip-1',
  name: 'Test Trip',
  startDate: '2026-01-01',
  endDate: '2026-01-05',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1 },
  cities: [],
};

describe('SyncedTripRepository', () => {
  const originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');

  function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
  }

  beforeEach(() => {
    setOnline(true);
  });

  afterEach(() => {
    if (originalOnLine) Object.defineProperty(window.navigator, 'onLine', originalOnLine);
  });

  it('saveTrip writes remote first, then mirrors into the cache', async () => {
    const order: string[] = [];
    const remote = makeFakeRepo({
      async saveTrip() {
        order.push('remote');
      },
    });
    const cache = makeFakeRepo({
      async saveTrip() {
        order.push('cache');
      },
    });
    const repo = new SyncedTripRepository(remote, cache);
    await repo.saveTrip(trip);
    expect(order).toEqual(['remote', 'cache']);
  });

  it('does not mirror to the cache when the remote write fails', async () => {
    const remote = makeFakeRepo({
      async saveTrip() {
        throw new Error('network down');
      },
    });
    const cache = makeFakeRepo();
    const repo = new SyncedTripRepository(remote, cache);
    await expect(repo.saveTrip(trip)).rejects.toThrow('network down');
    expect(cache.saveTripCalls).toHaveLength(0);
  });

  it('getTrip falls back to the cache when offline and the remote call fails', async () => {
    setOnline(false);
    const remote = makeFakeRepo({
      async getTrip() {
        throw new Error('offline');
      },
    });
    const cache = makeFakeRepo({
      async getTrip() {
        return trip;
      },
    });
    const repo = new SyncedTripRepository(remote, cache);
    const result = await repo.getTrip();
    expect(result).toEqual(trip);
  });

  it('getTrip rethrows (does not fall back) when online and the remote call fails', async () => {
    setOnline(true);
    const remote = makeFakeRepo({
      async getTrip() {
        throw new Error('rls denied');
      },
    });
    const cache = makeFakeRepo({
      async getTrip() {
        return trip;
      },
    });
    const repo = new SyncedTripRepository(remote, cache);
    await expect(repo.getTrip()).rejects.toThrow('rls denied');
  });

  it('getTrip mirrors a successful remote read into the cache', async () => {
    const remote = makeFakeRepo({
      async getTrip() {
        return trip;
      },
    });
    const cacheSaveTrip = vi.fn(async () => {});
    const cache = makeFakeRepo({ saveTrip: cacheSaveTrip });
    const repo = new SyncedTripRepository(remote, cache);
    await repo.getTrip();
    expect(cacheSaveTrip).toHaveBeenCalledWith(trip);
  });
});
