// Unit tests for SupabaseTripRepository against a hand-rolled fake
// SupabaseClient (in-memory tables keyed by name) -- no real network/project
// involved. Verifies row<->domain mapping round-trips and that filter args
// (user_id/trip_id/day_id) are actually passed, mirroring the coverage
// persistence.test.ts gives the Dexie implementation.

import { describe, expect, it } from 'vitest';
import { SupabaseTripRepository } from './supabaseTripRepository';
import type { Day, Expense, ItineraryItem, Place, Trip, TripMember } from './schema';

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
      limit(n: number) {
        filtered = filtered.slice(0, n);
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
            return Promise.resolve({ data: apply(), error: null });
          },
          // Awaiting the chain WITHOUT .select() executes it too — that's how
          // PostgREST behaves, and how saveTrip calls it.
          then(resolve: (v: { data: null; error: null }) => void) {
            apply();
            resolve({ data: null, error: null });
          },
        };
        function apply(): Row[] {
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
          return updatedRows;
        }
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

/** The one shared trip, as it exists in the database before any client
 *  touches it. Clients never create trips (migration 0005) — saveTrip is an
 *  update — so anything round-tripping the trip has to start from a row that
 *  is already there. user_id is deliberately a DIFFERENT account: the
 *  repository must neither filter on it nor overwrite it. */
const OTHER_OWNER = 'user-who-created-the-trip';
function existingTripRow(overrides: Record<string, unknown> = {}) {
  return {
    trips: [
      {
        id: baseTrip.id,
        user_id: OTHER_OWNER,
        name: baseTrip.name,
        start_date: baseTrip.startDate,
        end_date: baseTrip.endDate,
        home_currency: baseTrip.homeCurrency,
        trip_currency: baseTrip.tripCurrency,
        rates: baseTrip.rates,
        rates_updated_at: null,
        rates_base: null,
        cities: baseTrip.cities,
        members: null,
        ...overrides,
      },
    ],
  };
}

describe('SupabaseTripRepository', () => {
  it('getTrip returns undefined when there is no trip row at all', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    expect(await repo.getTrip()).toBeUndefined();
  });

  // The single trip is shared by every account (migration 0005) and RLS is
  // what scopes visibility. Filtering on user_id here would hide it from
  // everyone but whoever created it — the bug that made a second account
  // conclude no trip existed, try to create one, and 409 on trips_pkey.
  it('getTrip does NOT filter by user_id, so a collaborator sees the shared trip', async () => {
    const { client, calls } = makeFakeClient(existingTripRow());
    const repo = new SupabaseTripRepository(client, USER_ID);
    const trip = await repo.getTrip();
    expect(trip).toEqual(baseTrip);
    expect(calls.some((c) => c.table === 'trips' && c.op === 'eq' && c.args[0] === 'user_id')).toBe(false);
  });

  it('saveTrip leaves user_id alone — editing must not transfer the trip to the editor', async () => {
    const { client, tables } = makeFakeClient(existingTripRow());
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.saveTrip({ ...baseTrip, name: 'Renamed by a collaborator' });
    expect(tables.trips[0].name).toBe('Renamed by a collaborator');
    expect(tables.trips[0].user_id).toBe(OTHER_OWNER);
  });

  it('saveTrip then getTrip round-trips the trip, mapping snake_case rows back to camelCase', async () => {
    const { client } = makeFakeClient(existingTripRow());
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.saveTrip(baseTrip);
    const trip = await repo.getTrip();
    expect(trip).toEqual(baseTrip);
  });

  // Phase 5 trap #1 — `Trip.members`/`Expense.note`/`Expense.paidBy` must
  // move through the Supabase row<->domain mappers in lockstep with every
  // other layer (Dexie, exportImport). Neither field appears in `baseTrip`
  // above, so the existing round-trip tests never actually exercised
  // `tripFromRow`/`tripToRow`'s `members` handling or `expenseFromRow`/
  // `expenseToRow`'s `note`/`paid_by` handling — added explicitly here.
  it('saveTrip then getTrip round-trips Trip.members (Phase 5)', async () => {
    const { client } = makeFakeClient(existingTripRow());
    const repo = new SupabaseTripRepository(client, USER_ID);
    const members: TripMember[] = [
      { id: 'member-1', name: 'Alex' },
      { id: 'member-2', name: 'Priya' },
    ];
    await repo.saveTrip({ ...baseTrip, members });
    const trip = await repo.getTrip();
    expect(trip?.members).toEqual(members);
  });

  it('a trip with no members maps back to `members: undefined`, not an empty-array lie (Phase 5)', async () => {
    const { client } = makeFakeClient(existingTripRow());
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.saveTrip(baseTrip);
    const trip = await repo.getTrip();
    expect(trip?.members).toBeUndefined();
  });

  it('upsertExpense/listExpenses round-trips Expense.note and Expense.paidBy (Phase 5)', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    const expense: Expense = {
      id: 'expense-notes',
      tripId: baseTrip.id,
      category: 'Food',
      label: 'Dinner',
      amount: 120,
      currency: 'CNY',
      paid: true,
      note: 'Split three ways',
      paidBy: 'member-1',
    };
    await repo.upsertExpense(expense);
    const expenses = await repo.listExpenses(baseTrip.id);
    expect(expenses).toEqual([expense]);
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

  // Phase 6 — `Expense.city` (replaces `dayId`) and `Expense.coversMemberIds`
  // must move through the row<->domain mappers the same lockstep way Phase
  // 5's note/paidBy did (see the trap #1 comment above).
  it('upsertExpense/listExpenses round-trips Expense.city and Expense.coversMemberIds (Phase 6)', async () => {
    const { client } = makeFakeClient();
    const repo = new SupabaseTripRepository(client, USER_ID);
    const expense: Expense = {
      id: 'expense-city-covers',
      tripId: baseTrip.id,
      category: 'Food',
      label: 'Dinner',
      amount: 120,
      currency: 'CNY',
      paid: true,
      city: 'Shanghai',
      coversMemberIds: ['member-1', 'member-2'],
    };
    await repo.upsertExpense(expense);
    const expenses = await repo.listExpenses(baseTrip.id);
    expect(expenses).toEqual([expense]);
  });

  it('saveTrip/getTrip round-trips TripMember.color (Phase 6)', async () => {
    const { client } = makeFakeClient(existingTripRow());
    const repo = new SupabaseTripRepository(client, USER_ID);
    const tripWithColouredMember: Trip = {
      ...baseTrip,
      members: [{ id: 'member-1', name: 'Alex', color: 'm-denim' }],
    };
    await repo.saveTrip(tripWithColouredMember);
    const trip = await repo.getTrip();
    expect(trip?.members).toEqual([{ id: 'member-1', name: 'Alex', color: 'm-denim' }]);
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
    const snapshot = { version: 5 as const, trip: baseTrip, days: [], places: [], itinerary: [], expenses: [] };
    await repo.importSnapshot(snapshot);
    expect(rpcCalls).toEqual([{ fn: 'import_trip_snapshot', args: { snapshot } }]);
  });

  // There is ONE trip, shared by every account (migration 0005), and it
  // already exists. A client that seeds remotely is the exact code path that
  // produced `409 duplicate key value violates unique constraint
  // "trips_pkey"` for every account that wasn't its creator — `trips.id` is a
  // global primary key and ACTIVE_TRIP_ID is a constant. Not seeing a trip
  // means "not a collaborator yet", never "create one".
  it('seedIfEmpty never writes remotely, even when this account can see no trip', async () => {
    const rpcCalls: unknown[] = [];
    const { client: fake, tables } = makeFakeClient();
    const client = {
      from: fake.from,
      async rpc(fn: string, args: unknown) {
        rpcCalls.push({ fn, args });
        return { data: null, error: null };
      },
    } as unknown as import('@supabase/supabase-js').SupabaseClient;
    const repo = new SupabaseTripRepository(client, USER_ID);

    await repo.seedIfEmpty();

    expect(rpcCalls).toHaveLength(0);
    expect(tables.trips ?? []).toHaveLength(0);
  });

  it('seedIfEmpty leaves an existing shared trip untouched', async () => {
    const { client, tables } = makeFakeClient(existingTripRow());
    const repo = new SupabaseTripRepository(client, USER_ID);
    await repo.seedIfEmpty();
    expect(tables.trips).toHaveLength(1);
    expect((await repo.getTrip())?.id).toBe(baseTrip.id);
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
