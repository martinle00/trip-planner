// ============================================================================
// Dexie (IndexedDB) database definition.
// Owned by the Backend/data specialist. The rest of the app talks to
// `TripRepository` (dexieTripRepository.ts) — never to this file directly.
// ============================================================================

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Day, Expense, ID, ItineraryItem, Place, Trip } from './schema';
import { migrateExpenseV1ToV2, migratePlaceV2ToV3, migrateTripV1ToV2 } from './exportImport';
import type { ExpenseV1, PlaceV2, TripV1 } from './exportImport';

/**
 * A place's WIP free-text draft (`description`/`selfReview`), local-only and
 * NEVER synced to Supabase — see `data/draftRepository.ts`, the only module
 * that touches this table. Kept here (rather than in schema.ts, which is the
 * synced-domain-model contract) because it isn't part of `TripSnapshot`/
 * `TripRepository` at all.
 */
export interface PlaceDraft {
  placeId: ID;
  description?: string;
  selfReview?: string;
  /** The `Place.updatedAt` this draft was started/last rebased against —
   *  used for append-both conflict detection on commit (see
   *  `useTripStore.commitPlaceDraft`). */
  baseUpdatedAt: string;
  /** ISO date-time of the most recent local draft save. */
  savedAt: string;
}

/**
 * A staged (not-yet-saved) Map day reassignment, local-only and NEVER synced
 * to Supabase — see `data/stagedAssignmentRepository.ts`, the only module
 * that touches this table. Mirrors `PlaceDraft` above: it exists purely so
 * an in-progress Map edit survives a city switch/reload/offline before the
 * user explicitly hits Save (see `useTripStore.ts`'s `stagePlaceAssignment`/
 * `saveStagedAssignments`/`discardStagedAssignmentsForCity`). Kept here
 * (rather than in schema.ts, the synced-domain-model contract) because it
 * isn't part of `TripSnapshot`/`TripRepository` at all.
 */
export interface StagedAssignment {
  placeId: ID;
  /** The staged target day; `undefined` stages "unassign" (back to
   *  wishlist). Compared against the place's current SAVED `dayId` by
   *  `stagePlaceAssignment` -- if they end up equal, the staged row is
   *  deleted instead of written (nothing left to commit). */
  dayId?: ID;
  /** The place's `City.name` at staging time -- lets discard/count-by-city
   *  scope correctly without cross-referencing the live places list. */
  city: string;
  /** ISO date-time this staged row was last written. Informational only --
   *  staging never syncs, so there is no remote copy for it to race. */
  stagedAt: string;
}

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
  placeDrafts!: Table<PlaceDraft, string>;
  stagedAssignments!: Table<StagedAssignment, string>;

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

    // v3 (Phase 4 — place description/selfReview/updatedAt): folds
    // Place.note into `description` (concatenating if `description`
    // somehow already exists — defensive), drops `note`, and backfills
    // `updatedAt`. Also introduces the local-only `placeDrafts` table (new
    // in this version, hence the `.stores()` change — everything else keeps
    // its v1/v2 index layout unchanged since none of the new fields are
    // queried directly).
    //
    // Reuses `migratePlaceV2ToV3` (exported from exportImport.ts) so this
    // in-place upgrade and the JSON import path (`parseSnapshot`'s v2->v3
    // migration) can't drift out of sync with each other — same pattern as
    // the v2 upgrade above.
    this.version(3)
      .stores({ ...STORES, placeDrafts: 'placeId' })
      .upgrade(async (tx) => {
        const fallbackUpdatedAt = new Date().toISOString();
        await tx
          .table('places')
          .toCollection()
          .modify((raw: Record<string, unknown>) => {
            const alreadyMigrated = !('note' in raw) && typeof raw.updatedAt === 'string';
            if (alreadyMigrated) return;
            const migrated = migratePlaceV2ToV3(raw as unknown as PlaceV2, fallbackUpdatedAt);
            Object.assign(raw, migrated);
            delete raw.note;
          });
      });

    // v4 (Map "Save changes" staging model): introduces the local-only
    // `stagedAssignments` table (see `StagedAssignment` above / the
    // `data/stagedAssignmentRepository.ts` module that owns it). No upgrade
    // function needed -- it's a brand new table, so Dexie just creates it
    // empty; there is no existing data of this shape to migrate. Indexed on
    // `city` (in addition to the primary key `placeId`) so
    // `discardStagedAssignmentsForCity`/per-city counts can query by it
    // directly rather than scanning every row.
    this.version(4).stores({
      ...STORES,
      placeDrafts: 'placeId',
      stagedAssignments: 'placeId, city',
    });
  }
}

/** Singleton database instance used by the Dexie-backed repository. */
export const db = new TripDatabase();

/** Wipes the local cache. Call on sign-out so a previous account's trip data
 *  (including any unsaved place-prose drafts, which are local-only and never
 *  synced) isn't left readable offline on a shared/public device. */
export async function clearLocalCache(): Promise<void> {
  // Tables passed as an ARRAY, not varargs: Dexie's `transaction()` only has
  // explicit overloads up to 5 named tables, and adding `placeDrafts` in v3
  // made 6 (now 7 with `stagedAssignments` in v4). The varargs form stops
  // typechecking at that point.
  await db.transaction(
    'rw',
    [db.trips, db.days, db.places, db.itinerary, db.expenses, db.placeDrafts, db.stagedAssignments],
    async () => {
      await Promise.all([
        db.trips.clear(),
        db.days.clear(),
        db.places.clear(),
        db.itinerary.clear(),
        db.expenses.clear(),
        db.placeDrafts.clear(),
        db.stagedAssignments.clear(),
      ]);
    },
  );
}
