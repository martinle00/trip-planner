// ============================================================================
// Dexie-backed implementation of the frozen `TripRepository` interface.
// Owned by the Backend/data specialist.
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
import type { TripRepository } from './tripRepository';
import { ACTIVE_TRIP_ID } from './tripRepository';
import { buildSeed } from './seed';
import { db } from './db';

export class DexieTripRepository implements TripRepository {
  async seedIfEmpty(): Promise<void> {
    const existing = await db.trips.get(ACTIVE_TRIP_ID);
    if (existing) return;

    const snapshot = buildSeed();
    await db.transaction(
      'rw',
      db.trips,
      db.days,
      db.places,
      db.itinerary,
      db.expenses,
      async () => {
        await db.trips.put(snapshot.trip);
        await db.days.bulkPut(snapshot.days);
        await db.places.bulkPut(snapshot.places);
        await db.itinerary.bulkPut(snapshot.itinerary);
        await db.expenses.bulkPut(snapshot.expenses);
      },
    );
  }

  // ---- Trip ----

  async getTrip(): Promise<Trip | undefined> {
    return db.trips.get(ACTIVE_TRIP_ID);
  }

  async saveTrip(trip: Trip): Promise<void> {
    await db.trips.put(trip);
  }

  // ---- Places ----

  async listPlaces(tripId: ID): Promise<Place[]> {
    return db.places.where('tripId').equals(tripId).toArray();
  }

  async upsertPlace(place: Place): Promise<Place> {
    await db.places.put(place);
    return place;
  }

  async deletePlace(id: ID): Promise<void> {
    await db.places.delete(id);
  }

  // Atomic within a single Dexie 'rw' transaction: IndexedDB serializes
  // overlapping readwrite transactions against the same object store even
  // across browser tabs/connections, so this is safe against a concurrent
  // write from another tab on this same device, not just within one JS
  // event loop.
  async updatePlaceIfUnchanged(
    place: Place,
    baseUpdatedAt: string,
  ): Promise<{ place: Place; conflict: boolean }> {
    return db.transaction('rw', db.places, async () => {
      const current = await db.places.get(place.id);
      if (!current) {
        throw new Error(`updatePlaceIfUnchanged: no place with id ${place.id}`);
      }
      if (current.updatedAt !== baseUpdatedAt) {
        return { place: current, conflict: true };
      }
      await db.places.put(place);
      return { place, conflict: false };
    });
  }

  // ---- Days ----

  async listDays(tripId: ID): Promise<Day[]> {
    const days = await db.days.where('tripId').equals(tripId).toArray();
    return days.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---- Itinerary ----

  async listItinerary(dayId: ID): Promise<ItineraryItem[]> {
    const items = await db.itinerary.where('dayId').equals(dayId).toArray();
    return items.sort((a, b) => a.order - b.order);
  }

  async listAllItinerary(tripId: ID): Promise<ItineraryItem[]> {
    const days = await this.listDays(tripId);
    const dayIds = days.map((d) => d.id);
    if (dayIds.length === 0) return [];
    const items = await db.itinerary.where('dayId').anyOf(dayIds).toArray();
    return items.sort((a, b) => a.order - b.order);
  }

  async upsertItineraryItem(item: ItineraryItem): Promise<ItineraryItem> {
    await db.itinerary.put(item);
    return item;
  }

  async deleteItineraryItem(id: ID): Promise<void> {
    await db.itinerary.delete(id);
  }

  // ---- Expenses ----

  async listExpenses(tripId: ID): Promise<Expense[]> {
    return db.expenses.where('tripId').equals(tripId).toArray();
  }

  async upsertExpense(expense: Expense): Promise<Expense> {
    await db.expenses.put(expense);
    return expense;
  }

  async deleteExpense(id: ID): Promise<void> {
    await db.expenses.delete(id);
  }

  // ---- Whole-trip import/export ----

  async exportSnapshot(): Promise<TripSnapshot> {
    const trip = await this.getTrip();
    if (!trip) {
      throw new Error('exportSnapshot: no trip found — call seedIfEmpty() first');
    }
    const [days, places, itinerary, expenses] = await Promise.all([
      this.listDays(trip.id),
      this.listPlaces(trip.id),
      this.listAllItinerary(trip.id),
      this.listExpenses(trip.id),
    ]);
    return { version: 5, trip, days, places, itinerary, expenses };
  }

  async importSnapshot(snapshot: TripSnapshot): Promise<void> {
    await db.transaction(
      'rw',
      db.trips,
      db.days,
      db.places,
      db.itinerary,
      db.expenses,
      async () => {
        await Promise.all([
          db.trips.clear(),
          db.days.clear(),
          db.places.clear(),
          db.itinerary.clear(),
          db.expenses.clear(),
        ]);
        await db.trips.put(snapshot.trip);
        await db.days.bulkPut(snapshot.days);
        await db.places.bulkPut(snapshot.places);
        await db.itinerary.bulkPut(snapshot.itinerary);
        await db.expenses.bulkPut(snapshot.expenses);
      },
    );
  }
}

/** Singleton repository instance used by the store. */
export const tripRepository: TripRepository = new DexieTripRepository();
