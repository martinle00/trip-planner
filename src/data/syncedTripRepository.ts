// ============================================================================
// Write-through wrapper: Supabase (remote) is the source of truth for every
// mutation; the local Dexie cache is mirrored on success and only read from
// when genuinely offline. This intentionally does NOT queue or merge offline
// writes -- the app has no conflict-resolution model, so a mutation while
// offline must fail loudly (the caller/UI surfaces the error) rather than
// silently diverge from the server.
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

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export class SyncedTripRepository implements TripRepository {
  private readonly remote: TripRepository;
  private readonly cache: TripRepository;

  constructor(remote: TripRepository, cache: TripRepository) {
    this.remote = remote;
    this.cache = cache;
  }

  async seedIfEmpty(): Promise<void> {
    await this.remote.seedIfEmpty();
  }

  // ---- Trip ----

  async getTrip(): Promise<Trip | undefined> {
    try {
      const trip = await this.remote.getTrip();
      if (trip) await this.cache.saveTrip(trip);
      return trip;
    } catch (err) {
      if (isOffline()) return this.cache.getTrip();
      throw err;
    }
  }

  async saveTrip(trip: Trip): Promise<void> {
    await this.remote.saveTrip(trip);
    await this.cache.saveTrip(trip);
  }

  // ---- Places ----

  async listPlaces(tripId: ID): Promise<Place[]> {
    try {
      const places = await this.remote.listPlaces(tripId);
      await Promise.all(places.map((p) => this.cache.upsertPlace(p)));
      return places;
    } catch (err) {
      if (isOffline()) return this.cache.listPlaces(tripId);
      throw err;
    }
  }

  async upsertPlace(place: Place): Promise<Place> {
    const saved = await this.remote.upsertPlace(place);
    await this.cache.upsertPlace(saved);
    return saved;
  }

  async deletePlace(id: ID): Promise<void> {
    await this.remote.deletePlace(id);
    await this.cache.deletePlace(id);
  }

  // ---- Days ----

  async listDays(tripId: ID): Promise<Day[]> {
    try {
      const days = await this.remote.listDays(tripId);
      return days;
    } catch (err) {
      if (isOffline()) return this.cache.listDays(tripId);
      throw err;
    }
  }

  // ---- Itinerary ----

  async listItinerary(dayId: ID): Promise<ItineraryItem[]> {
    try {
      return await this.remote.listItinerary(dayId);
    } catch (err) {
      if (isOffline()) return this.cache.listItinerary(dayId);
      throw err;
    }
  }

  async listAllItinerary(tripId: ID): Promise<ItineraryItem[]> {
    try {
      const items = await this.remote.listAllItinerary(tripId);
      await Promise.all(items.map((i) => this.cache.upsertItineraryItem(i)));
      return items;
    } catch (err) {
      if (isOffline()) return this.cache.listAllItinerary(tripId);
      throw err;
    }
  }

  async upsertItineraryItem(item: ItineraryItem): Promise<ItineraryItem> {
    const saved = await this.remote.upsertItineraryItem(item);
    await this.cache.upsertItineraryItem(saved);
    return saved;
  }

  async deleteItineraryItem(id: ID): Promise<void> {
    await this.remote.deleteItineraryItem(id);
    await this.cache.deleteItineraryItem(id);
  }

  // ---- Expenses ----

  async listExpenses(tripId: ID): Promise<Expense[]> {
    try {
      const expenses = await this.remote.listExpenses(tripId);
      await Promise.all(expenses.map((e) => this.cache.upsertExpense(e)));
      return expenses;
    } catch (err) {
      if (isOffline()) return this.cache.listExpenses(tripId);
      throw err;
    }
  }

  async upsertExpense(expense: Expense): Promise<Expense> {
    const saved = await this.remote.upsertExpense(expense);
    await this.cache.upsertExpense(saved);
    return saved;
  }

  async deleteExpense(id: ID): Promise<void> {
    await this.remote.deleteExpense(id);
    await this.cache.deleteExpense(id);
  }

  // ---- Whole-trip import/export ----

  async exportSnapshot(): Promise<TripSnapshot> {
    return this.remote.exportSnapshot();
  }

  async importSnapshot(snapshot: TripSnapshot): Promise<void> {
    await this.remote.importSnapshot(snapshot);
    await this.cache.importSnapshot(snapshot);
  }
}
