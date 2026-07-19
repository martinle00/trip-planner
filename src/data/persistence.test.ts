// Integration tests for the store <-> DexieTripRepository <-> IndexedDB
// chain, using fake-indexeddb as an in-memory IndexedDB so these run in
// plain Node with no browser. Each test gets a clean database (the
// `china-trip-planner` DB is deleted in `beforeEach`) — a fresh
// `TripDatabase()`/`DexieTripRepository()` instance mid-test simulates a
// page reload without losing data written before that point, since
// fake-indexeddb's storage lives independently of any particular Dexie
// connection object.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { TripDatabase } from './db';
import { DexieTripRepository } from './dexieTripRepository';
import { ACTIVE_TRIP_ID } from './tripRepository';
import type { Place } from './schema';

async function freshDb(): Promise<TripDatabase> {
  await Dexie.delete('china-trip-planner');
  return new TripDatabase();
}

let db: TripDatabase;

beforeEach(async () => {
  db = await freshDb();
});

afterEach(async () => {
  db.close();
  await Dexie.delete('china-trip-planner');
});

// dexieTripRepository.ts's module-level `db` singleton is a different
// instance than the one this test manages directly, but since fake-indexeddb
// backs both by the same on-disk (in-memory) database name, a repository
// built here still observes what the singleton instance would. We construct
// `DexieTripRepository` directly since it reads/writes via the shared `db`
// module import (same singleton) — that's fine: what we're really exercising
// is the repository's own read/write/persistence contract.

describe('DexieTripRepository — seeding', () => {
  it('seedIfEmpty seeds the trip, days and places from buildSeed()', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();
    expect(trip?.id).toBe(ACTIVE_TRIP_ID);
    const places = await repo.listPlaces(ACTIVE_TRIP_ID);
    expect(places.length).toBeGreaterThan(0);
  });

  it('seedIfEmpty is a no-op when a trip already exists (no duplicate seeding)', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const before = await repo.listPlaces(ACTIVE_TRIP_ID);
    await repo.seedIfEmpty();
    const after = await repo.listPlaces(ACTIVE_TRIP_ID);
    expect(after.length).toBe(before.length);
  });
});

describe('DexieTripRepository — place persistence (incl. address)', () => {
  it('a saved place with a geocoded address survives a simulated reload', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();

    const place: Place = {
      id: 'place-test-1',
      tripId: trip!.id,
      name: 'Chengdu Research Base of Giant Panda Breeding',
      city: 'Chengdu',
      category: 'Nature',
      lat: 30.7330,
      lng: 104.1450,
      status: 'wishlist',
      address: 'Chengdu Research Base of Giant Panda Breeding, Chenghua, Chengdu, Sichuan, China',
    };
    await repo.upsertPlace(place);

    // Simulate a page reload: a brand-new repository instance backed by the
    // same underlying IndexedDB.
    const reloadedRepo = new DexieTripRepository();
    const places = await reloadedRepo.listPlaces(trip!.id);
    const found = places.find((p) => p.id === 'place-test-1');
    expect(found).toBeDefined();
    expect(found?.address).toBe(place.address);
    expect(found?.lat).toBe(place.lat);
    expect(found?.lng).toBe(place.lng);
  });

  it('a pin-dropped place with no address round-trips with address undefined', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();

    const place: Place = {
      id: 'place-test-2',
      tripId: trip!.id,
      name: 'Untitled pin',
      city: 'Chengdu',
      category: 'Landmark',
      lat: 30.1,
      lng: 104.2,
      status: 'wishlist',
    };
    await repo.upsertPlace(place);

    const places = await repo.listPlaces(trip!.id);
    const found = places.find((p) => p.id === 'place-test-2');
    expect(found?.address).toBeUndefined();
  });

  it('deletePlace removes the place permanently', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();
    const [somePlace] = await repo.listPlaces(trip!.id);
    await repo.deletePlace(somePlace.id);
    const after = await repo.listPlaces(trip!.id);
    expect(after.find((p) => p.id === somePlace.id)).toBeUndefined();
  });
});

describe('DexieTripRepository — export/import round trip', () => {
  it('exportSnapshot -> importSnapshot faithfully preserves places (incl. address) across a fresh DB', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();

    const geocodedPlace: Place = {
      id: 'place-export-1',
      tripId: trip!.id,
      name: 'The Bund',
      city: 'Shanghai',
      category: 'Landmark',
      lat: 31.2397,
      lng: 121.49,
      status: 'wishlist',
      address: 'The Bund, Huangpu, Shanghai, China',
      note: 'Go at sunset',
    };
    await repo.upsertPlace(geocodedPlace);

    const snapshot = await repo.exportSnapshot();
    expect(snapshot.version).toBe(2);
    const exportedPlace = snapshot.places.find((p) => p.id === 'place-export-1');
    expect(exportedPlace?.address).toBe(geocodedPlace.address);
    expect(exportedPlace?.note).toBe(geocodedPlace.note);

    // Import into a completely fresh database.
    await Dexie.delete('china-trip-planner');
    const importRepo = new DexieTripRepository();
    await importRepo.importSnapshot(snapshot);

    const reloadedSnapshot = await importRepo.exportSnapshot();
    expect(reloadedSnapshot.trip).toEqual(snapshot.trip);
    expect(reloadedSnapshot.days).toEqual(snapshot.days);
    expect(reloadedSnapshot.expenses).toEqual(snapshot.expenses);
    // Places compare as sets (order isn't guaranteed by IndexedDB scans).
    expect(new Set(reloadedSnapshot.places.map((p) => JSON.stringify(p)))).toEqual(
      new Set(snapshot.places.map((p) => JSON.stringify(p))),
    );
    const reimportedPlace = reloadedSnapshot.places.find((p) => p.id === 'place-export-1');
    expect(reimportedPlace?.address).toBe(geocodedPlace.address);
  });

  it('importSnapshot replaces (does not merge with) prior data', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();
    const seededPlaces = await repo.listPlaces(trip!.id);
    expect(seededPlaces.length).toBeGreaterThan(0);

    const minimalSnapshot = {
      version: 2 as const,
      trip: trip!,
      days: [],
      places: [
        {
          id: 'only-place',
          tripId: trip!.id,
          name: 'Only Place',
          city: 'Shanghai',
          lat: 1,
          lng: 2,
          status: 'wishlist' as const,
        },
      ],
      itinerary: [],
      expenses: [],
    };
    await repo.importSnapshot(minimalSnapshot);

    const after = await repo.listPlaces(trip!.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe('only-place');
  });
});
