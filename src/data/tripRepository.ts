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
