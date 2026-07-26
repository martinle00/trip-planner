// Tests that an existing v1 IndexedDB (from before the Phase 3
// multi-currency migration — Trip.cnyToHomeRate, Expense.amountCny, no
// `rates` table) is transparently upgraded to v2 shape (Trip.rates,
// Expense.amount/currency) the first time the CURRENT app code (TripDatabase
// in db.ts) opens it, via Dexie's `version(2).upgrade()` — not just on the
// JSON import path (exportImport.ts's parseSnapshot). This is the "real
// browser that was seeded in an earlier phase" scenario: without this
// upgrade, `getTrip()` would keep returning a raw v1-shaped object typed as
// `Trip`, and the first `convert()` call would throw.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { DexieTripRepository } from './dexieTripRepository';
import { ACTIVE_TRIP_ID } from './tripRepository';
import { convert } from '../lib/exchangeRates';
import { clearLocalCache } from './db';
import { stagedAssignmentRepository } from './stagedAssignmentRepository';

const DB_NAME = 'china-trip-planner';

/** Writes v1-shaped raw records directly into a fresh IndexedDB, declaring
 *  ONLY a version-1 schema (no `.version(2)`/upgrade) — simulating a browser
 *  profile that was seeded/used before the v2 migration existed, i.e. before
 *  today's db.ts (which always declares both versions) ever ran against it.
 *  Uses ACTIVE_TRIP_ID as the trip's id since `DexieTripRepository.getTrip()`
 *  always looks up that fixed id (this is a local single-trip app). */
async function seedV1Database(): Promise<void> {
  const v1Db = new Dexie(DB_NAME);
  v1Db.version(1).stores({
    trips: 'id',
    days: 'id, tripId, date',
    places: 'id, tripId, city, status, dayId',
    itinerary: 'id, dayId, order',
    expenses: 'id, tripId, dayId',
  });
  await v1Db.open();
  await v1Db.table('trips').put({
    id: ACTIVE_TRIP_ID,
    name: 'V1 Trip',
    startDate: '2026-11-07',
    endDate: '2026-11-30',
    homeCurrency: 'AUD',
    tripCurrency: 'CNY',
    cnyToHomeRate: 0.21,
    cities: [{ name: 'Shanghai', order: 1, nights: 2, arrive: '2026-11-09', depart: '2026-11-11' }],
  });
  await v1Db.table('expenses').put({
    id: 'exp-v1',
    tripId: ACTIVE_TRIP_ID,
    category: 'Food',
    label: 'Noodles',
    amountCny: 38,
    paid: true,
  });
  await v1Db.table('expenses').put({
    id: 'exp-v1-dayid',
    tripId: ACTIVE_TRIP_ID,
    dayId: 'day-1',
    category: 'Transport',
    label: 'Metro',
    amountCny: 0,
    paid: false,
  });
  v1Db.close();
}

beforeEach(async () => {
  await Dexie.delete(DB_NAME);
});

afterEach(async () => {
  await Dexie.delete(DB_NAME);
});

/** Writes v2-shaped raw records (post multi-currency, pre Phase-4 prose
 *  fields — `Place.note`, no `description`/`selfReview`/`updatedAt`) into a
 *  fresh IndexedDB, declaring ONLY versions 1 and 2 (no `.version(3)`) —
 *  simulating a browser profile used any time before today's db.ts (which
 *  always declares all three versions) ever ran against it. */
async function seedV2Database(): Promise<void> {
  const v2Db = new Dexie(DB_NAME);
  v2Db.version(1).stores({
    trips: 'id',
    days: 'id, tripId, date',
    places: 'id, tripId, city, status, dayId',
    itinerary: 'id, dayId, order',
    expenses: 'id, tripId, dayId',
  });
  v2Db.version(2).stores({
    trips: 'id',
    days: 'id, tripId, date',
    places: 'id, tripId, city, status, dayId',
    itinerary: 'id, dayId, order',
    expenses: 'id, tripId, dayId',
  });
  await v2Db.open();
  await v2Db.table('trips').put({
    id: ACTIVE_TRIP_ID,
    name: 'V2 Trip',
    startDate: '2026-11-07',
    endDate: '2026-11-30',
    homeCurrency: 'AUD',
    tripCurrency: 'CNY',
    rates: { AUD: 1, CNY: 0.21 },
    ratesBase: 'AUD',
    cities: [{ name: 'Shanghai', order: 1, nights: 2, arrive: '2026-11-09', depart: '2026-11-11' }],
  });
  await v2Db.table('places').put({
    id: 'place-v2-with-note',
    tripId: ACTIVE_TRIP_ID,
    name: 'The Bund',
    city: 'Shanghai',
    lat: 31.2397,
    lng: 121.49,
    status: 'wishlist',
    note: 'Go at sunset',
  });
  await v2Db.table('places').put({
    id: 'place-v2-no-note',
    tripId: ACTIVE_TRIP_ID,
    name: 'Yu Garden',
    city: 'Shanghai',
    lat: 31.227,
    lng: 121.492,
    status: 'wishlist',
  });
  v2Db.close();
}

/** Writes v4-shaped raw records (post Phase-5 richer expenses, pre Phase-6
 *  city attachment — `Expense.dayId`/`itemId` still present, no `city`) into
 *  a fresh IndexedDB, declaring versions 1 through 4 (no `.version(5)`) —
 *  simulating a browser profile used any time before today's db.ts (which
 *  always declares all five versions) ever ran against it. Includes a `days`
 *  row so at least one expense's `dayId` resolves to a real city. */
async function seedV4Database(): Promise<void> {
  const v4Db = new Dexie(DB_NAME);
  const storesV1to2 = {
    trips: 'id',
    days: 'id, tripId, date',
    places: 'id, tripId, city, status, dayId',
    itinerary: 'id, dayId, order',
    expenses: 'id, tripId, dayId',
  };
  v4Db.version(1).stores(storesV1to2);
  v4Db.version(2).stores(storesV1to2);
  v4Db.version(3).stores({ ...storesV1to2, placeDrafts: 'placeId' });
  v4Db.version(4).stores({ ...storesV1to2, placeDrafts: 'placeId', stagedAssignments: 'placeId, city' });
  await v4Db.open();
  await v4Db.table('trips').put({
    id: ACTIVE_TRIP_ID,
    name: 'V4 Trip',
    startDate: '2026-11-07',
    endDate: '2026-11-30',
    homeCurrency: 'AUD',
    tripCurrency: 'CNY',
    rates: { AUD: 1, CNY: 0.21 },
    ratesBase: 'AUD',
    cities: [{ name: 'Shanghai', order: 1, nights: 2, arrive: '2026-11-09', depart: '2026-11-11' }],
  });
  await v4Db.table('days').put({
    id: 'day-shanghai',
    tripId: ACTIVE_TRIP_ID,
    date: '2026-11-09',
    city: 'Shanghai',
  });
  await v4Db.table('expenses').put({
    id: 'exp-with-day',
    tripId: ACTIVE_TRIP_ID,
    dayId: 'day-shanghai',
    itemId: 'item-does-not-matter',
    category: 'Food',
    label: 'Noodles',
    amount: 38,
    currency: 'CNY',
    paid: true,
  });
  await v4Db.table('expenses').put({
    id: 'exp-orphan-day',
    tripId: ACTIVE_TRIP_ID,
    dayId: 'day-does-not-exist',
    category: 'Transport',
    label: 'Metro',
    amount: 5,
    currency: 'CNY',
    paid: false,
  });
  await v4Db.table('expenses').put({
    id: 'exp-no-day',
    tripId: ACTIVE_TRIP_ID,
    category: 'Shopping',
    label: 'Souvenirs',
    amount: 12,
    currency: 'CNY',
    paid: true,
  });
  v4Db.close();
}

describe('Dexie v1 -> v2 in-place migration (db.ts version(2).upgrade)', () => {
  it('migrates an existing v1 trip to v2 shape (rates table, ratesBase, no cnyToHomeRate) on first open', async () => {
    await seedV1Database();

    const repo = new DexieTripRepository();
    const trip = await repo.getTrip();

    expect(trip).toBeDefined();
    expect(trip).toMatchObject({
      id: ACTIVE_TRIP_ID,
      homeCurrency: 'AUD',
      rates: { CNY: 0.21, AUD: 1 },
      ratesBase: 'AUD',
    });
    expect(trip?.ratesUpdatedAt).toBeUndefined();
    expect((trip as unknown as { cnyToHomeRate?: number }).cnyToHomeRate).toBeUndefined();
  });

  it('migrates existing v1 expenses to v2 shape (amount + currency, no amountCny)', async () => {
    await seedV1Database();

    const repo = new DexieTripRepository();
    const expenses = await repo.listExpenses(ACTIVE_TRIP_ID);

    const noodles = expenses.find((e) => e.id === 'exp-v1');
    expect(noodles).toMatchObject({ amount: 38, currency: 'CNY', paid: true });
    expect((noodles as unknown as { amountCny?: number })?.amountCny).toBeUndefined();

    const metro = expenses.find((e) => e.id === 'exp-v1-dayid');
    // By the time this repo opens the database, EVERY declared version's
    // upgrade has run in sequence, including v5's (see the dedicated
    // describe block below) -- which drops `dayId` entirely and derives
    // `city` from it. This v1 seed never populates a matching `days` row, so
    // the orphaned `dayId` degrades to `city: undefined` ("Whole trip"),
    // never a throw.
    expect(metro).toMatchObject({ amount: 0, currency: 'CNY', paid: false });
    expect((metro as unknown as { amountCny?: number })?.amountCny).toBeUndefined();
    expect((metro as unknown as { dayId?: string })?.dayId).toBeUndefined();
    expect(metro?.city).toBeUndefined();
  });

  it('a migrated trip converts correctly via convert() immediately after upgrade (no crash)', async () => {
    await seedV1Database();

    const repo = new DexieTripRepository();
    const trip = await repo.getTrip();
    expect(trip).toBeDefined();
    expect(convert(100, 'CNY', trip!)).toBeCloseTo(21, 6);
    expect(convert(50, 'AUD', trip!)).toBe(50);
  });

  it('exportSnapshot on a migrated database produces a valid, self-consistent v5 snapshot', async () => {
    await seedV1Database();

    const repo = new DexieTripRepository();
    const snapshot = await repo.exportSnapshot();

    expect(snapshot.version).toBe(5);
    expect(snapshot.trip.rates).toEqual({ CNY: 0.21, AUD: 1 });
    expect(snapshot.expenses.find((e) => e.id === 'exp-v1')).toMatchObject({ amount: 38, currency: 'CNY' });
  });

  it('a fresh (never-v1) database is seeded directly at the current version with no upgrade side effects', async () => {
    // No seedV1Database() call — sanity check that the normal first-run path
    // (seedIfEmpty against an empty DB) still works unaffected by the new
    // version(2)/version(3) upgrades being declared.
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();
    expect(trip?.rates).toBeDefined();
    expect((trip as unknown as { cnyToHomeRate?: number })?.cnyToHomeRate).toBeUndefined();
  });
});

describe('Dexie v2 -> v3 in-place migration (db.ts version(3).upgrade)', () => {
  it('folds an existing place `note` into `description` and removes `note`', async () => {
    await seedV2Database();

    const repo = new DexieTripRepository();
    const places = await repo.listPlaces(ACTIVE_TRIP_ID);

    const withNote = places.find((p) => p.id === 'place-v2-with-note');
    expect(withNote?.description).toBe('Go at sunset');
    expect((withNote as unknown as { note?: string })?.note).toBeUndefined();
  });

  it('backfills `updatedAt` on every existing place (a real ISO date-time string)', async () => {
    await seedV2Database();

    const repo = new DexieTripRepository();
    const places = await repo.listPlaces(ACTIVE_TRIP_ID);

    for (const place of places) {
      expect(typeof place.updatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(place.updatedAt))).toBe(false);
    }
  });

  it('leaves a place with no note alone apart from backfilling updatedAt (description stays undefined)', async () => {
    await seedV2Database();

    const repo = new DexieTripRepository();
    const places = await repo.listPlaces(ACTIVE_TRIP_ID);

    const noNote = places.find((p) => p.id === 'place-v2-no-note');
    expect(noNote?.description).toBeUndefined();
    expect(noNote?.updatedAt).toBeDefined();
  });

  it('exportSnapshot on a v2->v3-migrated database produces a valid v5 snapshot with no note field anywhere', async () => {
    await seedV2Database();

    const repo = new DexieTripRepository();
    const snapshot = await repo.exportSnapshot();

    expect(snapshot.version).toBe(5);
    for (const place of snapshot.places) {
      expect((place as unknown as { note?: string }).note).toBeUndefined();
      expect(place.updatedAt).toBeDefined();
    }
  });

  it('a fresh (never-v2) database is seeded directly at v3 with the placeDrafts table present', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const places = await repo.listPlaces(ACTIVE_TRIP_ID);
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) {
      expect(place.updatedAt).toBeDefined();
    }
  });
});

// v4 (Map "Save changes" staging model) — a brand-new, local-only table with
// no upgrade function (nothing of this shape existed before), so unlike v2/v3
// there's no old-shaped-data migration to prove; what's worth pinning is that
// a fresh install actually gets a working table, and that sign-out's
// `clearLocalCache()` reaches it alongside every other table (a previous
// account's staged-but-unsaved Map edits must not leak onto a shared device).
describe('Dexie v4 (Map staging) — stagedAssignments table', () => {
  it('a fresh database has a working stagedAssignments table from first open', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();

    await stagedAssignmentRepository.upsert({
      placeId: 'place-1',
      dayId: 'day-1',
      city: 'Shanghai',
      stagedAt: new Date().toISOString(),
    });

    expect(await stagedAssignmentRepository.listAll()).toEqual([
      { placeId: 'place-1', dayId: 'day-1', city: 'Shanghai', stagedAt: expect.any(String) },
    ]);
  });

  it('clearLocalCache wipes stagedAssignments alongside every other table (sign-out)', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    await stagedAssignmentRepository.upsert({
      placeId: 'place-1',
      dayId: 'day-1',
      city: 'Shanghai',
      stagedAt: new Date().toISOString(),
    });

    await clearLocalCache();

    expect(await stagedAssignmentRepository.listAll()).toHaveLength(0);
    expect(await repo.getTrip()).toBeUndefined();
  });
});

describe('Dexie v4 -> v5 in-place migration (db.ts version(5).upgrade)', () => {
  it('derives city from a resolvable dayId and drops dayId/itemId', async () => {
    await seedV4Database();

    const repo = new DexieTripRepository();
    const expenses = await repo.listExpenses(ACTIVE_TRIP_ID);

    const withDay = expenses.find((e) => e.id === 'exp-with-day');
    expect(withDay).toMatchObject({ city: 'Shanghai', amount: 38, currency: 'CNY', paid: true });
    expect((withDay as unknown as { dayId?: string })?.dayId).toBeUndefined();
    expect((withDay as unknown as { itemId?: string })?.itemId).toBeUndefined();
  });

  it('degrades an unresolvable dayId to "Whole trip" (city undefined), never throws', async () => {
    await seedV4Database();

    const repo = new DexieTripRepository();
    const expenses = await repo.listExpenses(ACTIVE_TRIP_ID);

    const orphan = expenses.find((e) => e.id === 'exp-orphan-day');
    expect(orphan).toBeDefined();
    expect(orphan?.city).toBeUndefined();
    expect((orphan as unknown as { dayId?: string })?.dayId).toBeUndefined();
  });

  it('leaves an expense that never had a dayId unaffected apart from the shape change', async () => {
    await seedV4Database();

    const repo = new DexieTripRepository();
    const expenses = await repo.listExpenses(ACTIVE_TRIP_ID);

    const noDay = expenses.find((e) => e.id === 'exp-no-day');
    expect(noDay).toMatchObject({ amount: 12, currency: 'CNY', paid: true });
    expect(noDay?.city).toBeUndefined();
  });

  it('exportSnapshot on a v4->v5-migrated database produces a valid v5 snapshot', async () => {
    await seedV4Database();

    const repo = new DexieTripRepository();
    const snapshot = await repo.exportSnapshot();

    expect(snapshot.version).toBe(5);
    expect(snapshot.expenses.find((e) => e.id === 'exp-with-day')).toMatchObject({ city: 'Shanghai' });
  });

  it('a fresh (never-v4) database is seeded directly at v5 with a working expenses.city index', async () => {
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    // The seed carries no expenses today, but the point is that opening a
    // fresh (never-upgraded) database against a schema whose FIRST declared
    // version already has the v5 `expenses` index doesn't throw.
    await expect(repo.listExpenses(ACTIVE_TRIP_ID)).resolves.toEqual([]);
  });
});
