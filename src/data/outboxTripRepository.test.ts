// @vitest-environment jsdom
//
// Unit tests for the offline-write layer. The single highest-risk piece of
// logic in this feature is the failure CLASSIFICATION -- "the network dropped"
// (queue it, tell the user it saved) vs "the server refused it" (surface it).
// Get that wrong in the permissive direction and the app cheerfully reports
// success for writes that can never land, forever. Most of what's below
// exists to pin that split down.
//
// Real Dexie via fake-indexeddb, because the outbox itself is the thing under
// test; the repository either side is an in-memory fake (same approach as
// syncedTripRepository.test.ts).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { OutboxTripRepository, applyOutboxEntry, isConnectivityFailure } from './outboxTripRepository';
import { outboxRepository } from './outboxRepository';
import type { TripRepository } from './tripRepository';
import type { Place, Trip } from './schema';

const trip: Trip = {
  id: 'trip-1',
  name: 'Test Trip',
  startDate: '2026-11-07',
  endDate: '2026-11-30',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1 },
  cities: [],
};

function place(id: string, name = 'Yu Garden'): Place {
  return {
    id,
    tripId: 'trip-1',
    name,
    city: 'Shanghai',
    lat: 31.2,
    lng: 121.4,
    status: 'wishlist',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeFakeRepo(overrides: Partial<TripRepository> = {}): TripRepository {
  return {
    async seedIfEmpty() {},
    async getTrip() {
      return trip;
    },
    async saveTrip() {},
    async listPlaces() {
      return [];
    },
    async upsertPlace(p) {
      return p;
    },
    async deletePlace() {},
    async updatePlaceIfUnchanged(p) {
      return { place: p, conflict: false };
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
      return { version: 5, trip, days: [], places: [], itinerary: [], expenses: [] };
    },
    async importSnapshot() {},
    ...overrides,
  };
}

/** What supabase-js surfaces for a DB-level refusal: a plain object with a
 *  Postgrest code, no network semantics whatsoever. */
const RLS_DENIAL = { message: 'new row violates row-level security policy', code: '42501' };

beforeEach(async () => {
  await outboxRepository.clearAll();
});

afterEach(async () => {
  await outboxRepository.clearAll();
  await Dexie.delete('china-trip-planner');
});

describe('isConnectivityFailure — the queue/surface split', () => {
  it('recognises the transport failures the three engines actually produce', () => {
    // Chrome, Safari and Firefox each word a dropped request differently, and
    // all three happen on a phone that lost signal mid-write.
    expect(isConnectivityFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isConnectivityFailure(new Error('Load failed'))).toBe(true);
    expect(isConnectivityFailure(new Error('NetworkError when attempting to fetch resource'))).toBe(
      true,
    );
    expect(isConnectivityFailure({ message: 'TypeError: Failed to fetch' })).toBe(true);
  });

  it('does NOT treat a server refusal as a connectivity problem', () => {
    // The whole feature turns on this. Queued, an RLS denial would be retried
    // against a server that will never accept it while the UI claims success.
    expect(isConnectivityFailure(RLS_DENIAL)).toBe(false);
    expect(isConnectivityFailure(new Error('JWT expired'))).toBe(false);
    expect(isConnectivityFailure(new Error('duplicate key value violates unique constraint'))).toBe(
      false,
    );
    expect(isConnectivityFailure(undefined)).toBe(false);
  });
});

describe('OutboxTripRepository — writes', () => {
  it('queues and mirrors locally when the network drops, without throwing', async () => {
    const cached: Place[] = [];
    const repo = new OutboxTripRepository(
      makeFakeRepo({
        async upsertPlace() {
          throw new TypeError('Failed to fetch');
        },
      }),
      makeFakeRepo({
        async upsertPlace(p) {
          cached.push(p);
          return p;
        },
      }),
    );

    // The caller must see a normal success — that's the entire point.
    await expect(repo.upsertPlace(place('p1'))).resolves.toMatchObject({ id: 'p1' });
    expect(cached).toHaveLength(1);
    expect(await outboxRepository.count()).toBe(1);
  });

  it('rethrows a server refusal and queues nothing', async () => {
    const cached: Place[] = [];
    const repo = new OutboxTripRepository(
      makeFakeRepo({
        async upsertPlace() {
          throw RLS_DENIAL;
        },
      }),
      makeFakeRepo({
        async upsertPlace(p) {
          cached.push(p);
          return p;
        },
      }),
    );

    await expect(repo.upsertPlace(place('p1'))).rejects.toBeDefined();
    expect(cached).toHaveLength(0);
    expect(await outboxRepository.count()).toBe(0);
  });

  it('queues a delete with no payload', async () => {
    const repo = new OutboxTripRepository(
      makeFakeRepo({
        async deleteExpense() {
          throw new TypeError('Failed to fetch');
        },
      }),
      makeFakeRepo(),
    );

    await repo.deleteExpense('e1');
    const [entry] = await outboxRepository.list();
    expect(entry).toMatchObject({ entity: 'expense', op: 'delete', recordId: 'e1' });
    expect(entry.payload).toBeUndefined();
  });

  it('never queues a conditional place write', async () => {
    // updatePlaceIfUnchanged exists to compare against the CURRENT remote row;
    // replaying it a day later would compare against something ancient and
    // either spuriously conflict or blindly clobber.
    const repo = new OutboxTripRepository(
      makeFakeRepo({
        async updatePlaceIfUnchanged() {
          throw new TypeError('Failed to fetch');
        },
      }),
      makeFakeRepo(),
    );

    await expect(repo.updatePlaceIfUnchanged(place('p1'), 'base')).rejects.toBeDefined();
    expect(await outboxRepository.count()).toBe(0);
  });

  it('never queues a whole-trip import', async () => {
    // A destructive replace sitting in a queue for a day would wipe out
    // everything a collaborator did in the meantime.
    const repo = new OutboxTripRepository(
      makeFakeRepo({
        async importSnapshot() {
          throw new TypeError('Failed to fetch');
        },
      }),
      makeFakeRepo(),
    );

    await expect(
      repo.importSnapshot({ version: 5, trip, days: [], places: [], itinerary: [], expenses: [] }),
    ).rejects.toBeDefined();
    expect(await outboxRepository.count()).toBe(0);
  });
});

describe('OutboxTripRepository — reads', () => {
  it('goes remote while the queue is empty, and local once anything is queued', async () => {
    const remotePlaces = [place('remote', 'From server')];
    const cachedPlaces = [place('cached', 'From device')];
    const repo = new OutboxTripRepository(
      makeFakeRepo({
        async listPlaces() {
          return remotePlaces;
        },
      }),
      makeFakeRepo({
        async listPlaces() {
          return cachedPlaces;
        },
      }),
    );

    expect(await repo.listPlaces('trip-1')).toEqual(remotePlaces);

    await outboxRepository.append({
      entity: 'place',
      op: 'upsert',
      recordId: 'p9',
      payload: place('p9'),
      queuedAt: new Date().toISOString(),
    });

    // Correctness, not optimisation: the remote is MISSING the queued change,
    // so reading it would hand the store older data than what's on screen and
    // revert the user's own offline edits in front of them.
    expect(await repo.listPlaces('trip-1')).toEqual(cachedPlaces);
  });
});

describe('applyOutboxEntry', () => {
  it('routes each entity/op pair to the right repository call', async () => {
    const calls: string[] = [];
    const target = makeFakeRepo({
      async saveTrip() {
        calls.push('saveTrip');
      },
      async upsertPlace(p) {
        calls.push('upsertPlace');
        return p;
      },
      async deleteItineraryItem() {
        calls.push('deleteItineraryItem');
      },
      async deleteExpense() {
        calls.push('deleteExpense');
      },
    });

    await applyOutboxEntry(target, { entity: 'trip', op: 'upsert', recordId: 't', payload: trip });
    await applyOutboxEntry(target, {
      entity: 'place',
      op: 'upsert',
      recordId: 'p',
      payload: place('p'),
    });
    await applyOutboxEntry(target, { entity: 'itinerary', op: 'delete', recordId: 'i' });
    await applyOutboxEntry(target, { entity: 'expense', op: 'delete', recordId: 'e' });

    expect(calls).toEqual(['saveTrip', 'upsertPlace', 'deleteItineraryItem', 'deleteExpense']);
  });
});
