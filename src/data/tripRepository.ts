// ============================================================================
// FROZEN CONTRACT — persistence boundary.
// The Backend/data specialist implements `TripRepository` against Dexie
// (db.ts) and wires it into the store. This interface is the ONLY seam a
// future cloud backend needs to reimplement.
//
// The store (useTripStore) talks to a TripRepository — never to Dexie
// directly. Keep this interface stable.
// ============================================================================

import type {
  Day,
  Expense,
  ID,
  ItineraryItem,
  Place,
  Trip,
  TripSnapshot,
} from './schema';

export interface TripRepository {
  /** Seed the Nov 2026 trip (from buildSeed) if the store is empty. */
  seedIfEmpty(): Promise<void>;

  // Trip
  getTrip(): Promise<Trip | undefined>;
  saveTrip(trip: Trip): Promise<void>;

  // Places
  listPlaces(tripId: ID): Promise<Place[]>;
  upsertPlace(place: Place): Promise<Place>;
  deletePlace(id: ID): Promise<void>;
  /**
   * Conditional place write for optimistic-concurrency conflict detection
   * (see `Place.updatedAt`). Writes `place` (already carrying its intended
   * fresh `updatedAt`) ONLY IF the row currently stored under `place.id`
   * still has `updatedAt === baseUpdatedAt` — i.e. nobody has written this
   * place since the caller last read it.
   *
   * - Success: returns `{ place, conflict: false }` with exactly the place
   *   that was passed in (now persisted).
   * - Conflict: the write is REJECTED (nothing is persisted) and this
   *   returns `{ place: <current stored place>, conflict: true }` — the
   *   CURRENT row, not the caller's `place` — so the caller can inspect
   *   what changed and reconcile (see `useTripStore.commitPlaceDraft`,
   *   which append-merges free text rather than overwriting or showing a
   *   merge UI).
   * - Throws if no place with `place.id` exists at all.
   *
   * Implementations must perform this as an atomic conditional update (a
   * transactional read-check-write for Dexie; a `WHERE id = ... AND
   * updated_at = ...` conditional update for Supabase) — never a plain
   * read-compare-write from the caller's side, which would leave a race
   * window between two overlapping callers.
   */
  updatePlaceIfUnchanged(
    place: Place,
    baseUpdatedAt: string,
  ): Promise<{ place: Place; conflict: boolean }>;

  // Days
  listDays(tripId: ID): Promise<Day[]>;

  // Itinerary
  listItinerary(dayId: ID): Promise<ItineraryItem[]>;
  listAllItinerary(tripId: ID): Promise<ItineraryItem[]>;
  upsertItineraryItem(item: ItineraryItem): Promise<ItineraryItem>;
  deleteItineraryItem(id: ID): Promise<void>;

  // Expenses
  listExpenses(tripId: ID): Promise<Expense[]>;
  upsertExpense(expense: Expense): Promise<Expense>;
  deleteExpense(id: ID): Promise<void>;

  // Whole-trip import/export (trip.json portability)
  exportSnapshot(): Promise<TripSnapshot>;
  importSnapshot(snapshot: TripSnapshot): Promise<void>;
}

/** The single trip id used by this local single-trip app. */
export const ACTIVE_TRIP_ID: ID = 'trip-china-2026';
