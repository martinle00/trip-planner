// Unit tests for SupabaseTripRepository against a hand-rolled fake
// SupabaseClient (in-memory tables keyed by name) -- no real network/project
// involved. Verifies row<->domain mapping round-trips and that filter args
// (user_id/trip_id/day_id) are actually passed, mirroring the coverage
// persistence.test.ts gives the Dexie implementation.

import { describe, expect, it } from 'vitest';
import { SupabaseTripRepository } from './supabaseTripRepository';
import type { Day, Expense, ItineraryItem, Place, Trip } from './schema';

type Row = Record<string, unknown>;

/** Minimal fake mimicking the subset of the supabase-js query builder this
 *  repository actually calls: .from().select/upsert/delete/rpc, chained with
 *  .eq/.in/.order/.maybeSingle. */
function makeFakeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { ...seed };
  const calls: { table: string; op: string; args: unknown[] }[] = [];

  function from(table: string) {
    if (!tables[table]) tables[table] = [];
    let rows = tables[table];
    let filtered = rows;

    const builder = {
      select(_cols: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        calls.push({ table, op: 'eq', args: [col, val] });
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        calls.push({ table, op: 'in', args: [col, vals] });
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      order(_col: string, _opts?: unknown) {
        return builder;
      },
      async maybeSingle() {
        return { data: filtered[0] ?? null, error: null };
      },
      async upsert(row: Row) {
        const idx = rows.findIndex((r) => r.id === row.id);
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
        return { data: row, error: null };
      },
      delete() {
        return {
          async eq(col: string, val: unknown) {
            tables[table] = rows.filter((r) => r[col] !== val);
            return { data: null, error: null };
          },
        };
      },
      // Minimal conditional-update chain: .update(partial).eq(...).eq(...).select()
      // Mimics a real WHERE-clause conditional update — only rows matching
      // EVERY chained .eq() get written; .select() resolves with the rows
      // that were actually updated (empty array if none matched).
      update(partial: Row) {
        let matchFiltered = rows;
        const updateBuilder = {
          eq(col: string, val: unknown) {
            calls.push({ table, op: 'update.eq', args: [col, val] });
            matchFiltered = matchFiltered.filter((r) => r[col] === val);
            return updateBuilder;
          },
          select() {
            const matchedIds = new Set(matchFiltered.map((r) => r.id));
            const updatedRows: Row[] = [];
            tables[table] = rows.map((r) => {
              if (matchedIds.has(r.id)) {
                const merged = { ...r, ...partial };
                updatedRows.push(merged);
                return merged;
              }
              return r;
            });
            rows = tables[table];
            return Promise.resolve({ data: updatedRows, error: null });
          },
        };
        return updateBuilder;
      },
      // select() without a terminal call resolves as a thenable returning all filtered rows
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: filtered, error: null });
      },
    };
    return builder;
  }

  return {
    client: {
      from,
      async rpc(_fn: string, _args: unknown) {
        return { data: null, error: null };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient,
    tables,
    calls,
  };
}

const USER_ID = 'user-1';

const baseTrip: Trip = {
  id: 'trip-china-2026',
  name: 'China 2026',
  startDate: '2026-11-01',
  endDate: '2026-11-10',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { CNY: 0.2, AUD: 1 },
  cities: [],
};

describe('SupabaseTripRepository', () => {
  it('getTrip returns undefined when no row exists for the user, filtered by user_id', () => {
    const { client, calls } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    return repo.getTrip().then((trip) => {
      expect(trip).toBeUndefined();
      expect(calls.some((c) => c.table === 'trips' && c.op === 'eq' && c.args[0] === 'user_id' && c.args[1] === USER_ID)).toBe(true);
    });
  });

  it('saveTrip then getTrip round-trips the trip, mapping snake_case rows back to camelCase', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.saveTrip(baseTrip);
    const trip = await repo.getTrip();
    expect(trip).toEqual(baseTrip);
  });

  it('upsertPlace/listPlaces round-trips a place including optional fields', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    const place: Place = {
      id: 'place-1',
      tripId: baseTrip.id,
      name: 'The Bund',
      city: 'Shanghai',
      lat: 31.2,
      lng: 121.5,
      status: 'wishlist',
      description: 'Go at sunset',
      address: 'The Bund, Shanghai',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await repo.upsertPlace(place);
    const places = await repo.listPlaces(baseTrip.id);
    expect(places).toEqual([place]);
  });

  it('deletePlace removes the row', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    const place: Place = {
      id: 'place-1',
      tripId: baseTrip.id,
      name: 'The Bund',
      city: 'Shanghai',
      lat: 31.2,
      lng: 121.5,
      status: 'wishlist',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await repo.upsertPlace(place);
    await repo.deletePlace(place.id);
    expect(await repo.listPlaces(baseTrip.id)).toEqual([]);
  });

  it('upsertItineraryItem/listAllItinerary round-trips via the days join', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    const day: Day = { id: 'day-1', tripId: baseTrip.id, date: '2026-11-01', city: 'Shanghai' };
    await client.from('days').upsert({
      id: day.id,
      trip_id: day.tripId,
      date: day.date,
      city: day.city,
      parent_city: null,
    });
    const item: ItineraryItem = { id: 'item-1', dayId: day.id, title: 'Visit the Bund', order: 0 };
    await repo.upsertItineraryItem(item);
    const items = await repo.listAllItinerary(baseTrip.id);
    expect(items).toEqual([item]);
  });

  it('upsertExpense/listExpenses round-trips an expense', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    const expense: Expense = {
      id: 'expense-1',
      tripId: baseTrip.id,
      category: 'Food',
      label: 'Dinner',
      amount: 120,
      currency: 'CNY',
      paid: true,
    };
    await repo.upsertExpense(expense);
    const expenses = await repo.listExpenses(baseTrip.id);
    expect(expenses).toEqual([expense]);
  });

  it('importSnapshot calls the import_trip_snapshot RPC with the raw snapshot payload', async () => {
    const rpcCalls: unknown[] = [];
    const client = {
      from: makeFakeClient().client.from,
      async rpc(fn: string, args: unknown) {
        rpcCalls.push({ fn, args });
        return { data: null, error: null };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseTripRepository(client, USER_ID);
    const snapshot = { version: 3 as const, trip: baseTrip, days: [], places: [], itinerary: [], expenses: [] };
    await repo.importSnapshot(snapshot);
    expect(rpcCalls).toEqual([{ fn: 'import_trip_snapshot', args: { snapshot } }]);
  });

  it('seedIfEmpty seeds via importSnapshot when no trip exists for the user', async () => {
    const rpcCalls: unknown[] = [];
    const client = {
      from: makeFakeClient().client.from,
      async rpc(fn: string, args: unknown) {
        rpcCalls.push({ fn, args });
        return { data: null, error: null };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.seedIfEmpty();
    expect(rpcCalls).toHaveLength(1);
    expect((rpcCalls[0] as { fn: string }).fn).toBe('import_trip_snapshot');
  });

  it('seedIfEmpty is a no-op when a trip already exists for the user', async () => {
    const { client } = makeFakeClient({
      trips: [
        {
          id: baseTrip.id,
          user_id: USER_ID,
          name: baseTrip.name,
          start_date: baseTrip.startDate,
          end_date: baseTrip.endDate,
          home_currency: baseTrip.homeCurrency,
          trip_currency: baseTrip.tripCurrency,
          rates: baseTrip.rates,
          rates_updated_at: null,
          rates_base: null,
          cities: baseTrip.cities,
        },
      ],
    });
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.seedIfEmpty();
    const trip = await repo.getTrip();
    expect(trip?.id).toBe(baseTrip.id);
  });
});

describe('SupabaseTripRepository — updatePlaceIfUnchanged (conflict detection)', () => {
  const place: Place = {
    id: 'place-cond-1',
    tripId: baseTrip.id,
    name: 'Original',
    city: 'Shanghai',
    lat: 1,
    lng: 2,
    status: 'wishlist',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('writes and returns the place when baseUpdatedAt matches the stored row', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.upsertPlace(place);

    const updated: Place = { ...place, description: 'A note', updatedAt: '2026-01-02T00:00:00.000Z' };
    const result = await repo.updatePlaceIfUnchanged(updated, '2026-01-01T00:00:00.000Z');

    expect(result.conflict).toBe(false);
    expect(result.place).toEqual(updated);
    const stored = await repo.listPlaces(baseTrip.id);
    expect(stored.find((p) => p.id === 'place-cond-1')?.description).toBe('A note');
  });

  it('rejects the write and returns the CURRENT stored place when baseUpdatedAt is stale', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.upsertPlace(place);
    const remoteWrite: Place = {
      ...place,
      description: 'From another device',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    await repo.upsertPlace(remoteWrite);

    const attempted: Place = { ...place, description: 'My edit', updatedAt: '2026-01-03T00:00:00.000Z' };
    const result = await repo.updatePlaceIfUnchanged(attempted, '2026-01-01T00:00:00.000Z');

    expect(result.conflict).toBe(true);
    expect(result.place).toEqual(remoteWrite);
    const stored = await repo.listPlaces(baseTrip.id);
    expect(stored.find((p) => p.id === 'place-cond-1')?.description).toBe('From another device');
  });

  it('throws when the place does not exist', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    const ghost: Place = { ...place, id: 'no-such-place' };
    await expect(repo.updatePlaceIfUnchanged(ghost, '2026-01-01T00:00:00.000Z')).rejects.toThrow(
      'no place with id no-such-place',
    );
  });
});
