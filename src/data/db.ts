// ============================================================================
// Dexie (IndexedDB) database definition.
// Owned by the Backend/data specialist. The rest of the app talks to
// `TripRepository` (dexieTripRepository.ts) — never to this file directly.
// ============================================================================

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Day, Expense, ItineraryItem, Place, Trip } from './schema';
import { migrateExpenseV1ToV2, migrateTripV1ToV2 } from './exportImport';
import type { ExpenseV1, TripV1 } from './exportImport';

// Index layout has never changed between v1 and v2 — same `.stores()` shape
// for both declared Dexie versions below.
const STORES = {
  trips: 'id',
  days: 'id, tripId, date',
  places: 'id, tripId, city, status, dayId',
  itinerary: 'id, dayId, order',
  expenses: 'id, tripId, dayId',
};

export class TripDatabase extends Dexie {
  trips!: Table<Trip, string>;
  days!: Table<Day, string>;
  places!: Table<Place, string>;
  itinerary!: Table<ItineraryItem, string>;
  expenses!: Table<Expense, string>;

  constructor() {
    super('china-trip-planner');
    this.version(1).stores(STORES);

    // v2 (Phase 3 — multi-currency budget): Trip.cnyToHomeRate -> `rates`
    // table; Expense.amountCny -> `amount` + `currency`. No index changes
    // (STORES repeated as-is) — this version bump exists to run the
    // in-place migration below against any EXISTING local IndexedDB data on
    // the user's own device (a v1 trip seeded before this phase). Without
    // it, `getTrip()` would keep returning a raw v1-shaped object typed as
    // `Trip`, and the first `convert()` call (`trip.rates[currency]`) would
    // throw — the Budget panel would simply crash on upgrade.
    //
    // Reuses the exact same per-record transform as the JSON import path
    // (`exportImport.ts`'s `parseSnapshot` v1->v2 migration, exported from
    // there as `migrateTripV1ToV2`/`migrateExpenseV1ToV2`) so the two
    // migration paths can't drift out of sync with each other.
    this.version(2)
      .stores(STORES)
      .upgrade(async (tx) => {
        await tx
          .table('trips')
          .toCollection()
          .modify((raw: Record<string, unknown>) => {
            if ('cnyToHomeRate' in raw && !('rates' in raw)) {
              const migrated = migrateTripV1ToV2(raw as unknown as TripV1);
              Object.assign(raw, migrated);
              delete raw.cnyToHomeRate;
            }
          });
        await tx
          .table('expenses')
          .toCollection()
          .modify((raw: Record<string, unknown>) => {
            if ('amountCny' in raw && !('amount' in raw)) {
              const migrated = migrateExpenseV1ToV2(raw as unknown as ExpenseV1);
              Object.assign(raw, migrated);
              delete raw.amountCny;
            }
          });
      });
  }
}

/** Singleton database instance used by the Dexie-backed repository. */
export const db = new TripDatabase();
