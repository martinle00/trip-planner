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
    expect(metro).toMatchObject({ amount: 0, currency: 'CNY', dayId: 'day-1', paid: false });
    expect((metro as unknown as { amountCny?: number })?.amountCny).toBeUndefined();
  });

  it('a migrated trip converts correctly via convert() immediately after upgrade (no crash)', async () => {
    await seedV1Database();

    const repo = new DexieTripRepository();
    const trip = await repo.getTrip();
    expect(trip).toBeDefined();
    expect(convert(100, 'CNY', trip!)).toBeCloseTo(21, 6);
    expect(convert(50, 'AUD', trip!)).toBe(50);
  });

  it('exportSnapshot on a migrated database produces a valid, self-consistent v2 snapshot', async () => {
    await seedV1Database();

    const repo = new DexieTripRepository();
    const snapshot = await repo.exportSnapshot();

    expect(snapshot.version).toBe(2);
    expect(snapshot.trip.rates).toEqual({ CNY: 0.21, AUD: 1 });
    expect(snapshot.expenses.find((e) => e.id === 'exp-v1')).toMatchObject({ amount: 38, currency: 'CNY' });
  });

  it('a fresh (never-v1) database is seeded directly at v2 with no upgrade side effects', async () => {
    // No seedV1Database() call — sanity check that the normal first-run path
    // (seedIfEmpty against an empty DB) still works unaffected by the new
    // version(2).upgrade() being declared.
    const repo = new DexieTripRepository();
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();
    expect(trip?.rates).toBeDefined();
    expect((trip as unknown as { cnyToHomeRate?: number })?.cnyToHomeRate).toBeUndefined();
  });
});
