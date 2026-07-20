// ============================================================================
// Supabase-backed implementation of the frozen `TripRepository` interface.
// Maps camelCase domain types (schema.ts) to snake_case Postgres rows
// (supabase/migrations/0001_init.sql). Scoped to a single trip per user
// (ACTIVE_TRIP_ID / trips_user_id_unique), matching the local Dexie model.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
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
import { buildSeed } from './seed';

// ---- row <-> domain mappers ------------------------------------------------

interface TripRow {
  id: string;
  user_id: string;
  name: string;
  start_date: string;
  end_date: string;
  home_currency: string;
  trip_currency: string;
  rates: Record<string, number>;
  rates_updated_at: string | null;
  rates_base: string | null;
  cities: Trip['cities'];
}

function tripFromRow(row: TripRow): Trip {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    homeCurrency: row.home_currency,
    tripCurrency: row.trip_currency,
    rates: row.rates,
    ratesUpdatedAt: row.rates_updated_at ?? undefined,
    ratesBase: row.rates_base ?? undefined,
    cities: row.cities,
  };
}

function tripToRow(trip: Trip, userId: string): Omit<TripRow, never> {
  return {
    id: trip.id,
    user_id: userId,
    name: trip.name,
    start_date: trip.startDate,
    end_date: trip.endDate,
    home_currency: trip.homeCurrency,
    trip_currency: trip.tripCurrency,
    rates: trip.rates,
    rates_updated_at: trip.ratesUpdatedAt ?? null,
    rates_base: trip.ratesBase ?? null,
    cities: trip.cities,
  };
}

interface DayRow {
  id: string;
  trip_id: string;
  date: string;
  city: string;
  parent_city: string | null;
}

function dayFromRow(row: DayRow): Day {
  return {
    id: row.id,
    tripId: row.trip_id,
    date: row.date,
    city: row.city,
    parentCity: row.parent_city ?? undefined,
  };
}

interface PlaceRow {
  id: string;
  trip_id: string;
  name: string;
  description: string | null;
  self_review: string | null;
  category: string | null;
  lat: number;
  lng: number;
  city: string;
  status: string;
  day_id: string | null;
  source_url: string | null;
  address: string | null;
  updated_at: string;
}

function placeFromRow(row: PlaceRow): Place {
  return {
    id: row.id,
    tripId: row.trip_id,
    name: row.name,
    description: row.description ?? undefined,
    selfReview: row.self_review ?? undefined,
    category: row.category ?? undefined,
    lat: row.lat,
    lng: row.lng,
    city: row.city,
    status: row.status as Place['status'],
    dayId: row.day_id ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    address: row.address ?? undefined,
    updatedAt: row.updated_at,
  };
}

function placeToRow(place: Place): PlaceRow {
  return {
    id: place.id,
    trip_id: place.tripId,
    name: place.name,
    description: place.description ?? null,
    self_review: place.selfReview ?? null,
    category: place.category ?? null,
    lat: place.lat,
    lng: place.lng,
    city: place.city,
    status: place.status,
    day_id: place.dayId ?? null,
    source_url: place.sourceUrl ?? null,
    address: place.address ?? null,
    updated_at: place.updatedAt,
  };
}

interface ItineraryRow {
  id: string;
  day_id: string;
  place_id: string | null;
  title: string;
  start_time: string | null;
  duration_min: number | null;
  note: string | null;
  order: number;
}

function itineraryFromRow(row: ItineraryRow): ItineraryItem {
  return {
    id: row.id,
    dayId: row.day_id,
    placeId: row.place_id ?? undefined,
    title: row.title,
    startTime: row.start_time ?? undefined,
    durationMin: row.duration_min ?? undefined,
    note: row.note ?? undefined,
    order: row.order,
  };
}

function itineraryToRow(item: ItineraryItem): ItineraryRow {
  return {
    id: item.id,
    day_id: item.dayId,
    place_id: item.placeId ?? null,
    title: item.title,
    start_time: item.startTime ?? null,
    duration_min: item.durationMin ?? null,
    note: item.note ?? null,
    order: item.order,
  };
}

interface ExpenseRow {
  id: string;
  trip_id: string;
  day_id: string | null;
  item_id: string | null;
  category: string;
  label: string;
  amount: number;
  currency: string;
  paid: boolean;
}

function expenseFromRow(row: ExpenseRow): Expense {
  return {
    id: row.id,
    tripId: row.trip_id,
    dayId: row.day_id ?? undefined,
    itemId: row.item_id ?? undefined,
    category: row.category,
    label: row.label,
    amount: row.amount,
    currency: row.currency,
    paid: row.paid,
  };
}

function expenseToRow(expense: Expense): ExpenseRow {
  return {
    id: expense.id,
    trip_id: expense.tripId,
    day_id: expense.dayId ?? null,
    item_id: expense.itemId ?? null,
    category: expense.category,
    label: expense.label,
    amount: expense.amount,
    currency: expense.currency,
    paid: expense.paid,
  };
}

export class SupabaseTripRepository implements TripRepository {
  private readonly client: SupabaseClient;
  private readonly userId: string;

  constructor(client: SupabaseClient, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  async seedIfEmpty(): Promise<void> {
    const existing = await this.getTrip();
    if (existing) return;
    const snapshot = buildSeed();
    await this.importSnapshot(snapshot);
  }

  // ---- Trip ----

  async getTrip(): Promise<Trip | undefined> {
    const { data, error } = await this.client
      .from('trips')
      .select('*')
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw error;
    return data ? tripFromRow(data as TripRow) : undefined;
  }

  async saveTrip(trip: Trip): Promise<void> {
    const { error } = await this.client.from('trips').upsert(tripToRow(trip, this.userId));
    if (error) throw error;
  }

  // ---- Places ----

  async listPlaces(tripId: ID): Promise<Place[]> {
    const { data, error } = await this.client.from('places').select('*').eq('trip_id', tripId);
    if (error) throw error;
    return (data as PlaceRow[]).map(placeFromRow);
  }

  async upsertPlace(place: Place): Promise<Place> {
    const { error } = await this.client.from('places').upsert(placeToRow(place));
    if (error) throw error;
    return place;
  }

  async deletePlace(id: ID): Promise<void> {
    const { error } = await this.client.from('places').delete().eq('id', id);
    if (error) throw error;
  }

  // Conditional update via a `WHERE id = ... AND updated_at = ...` clause —
  // atomic at the database level, no read-compare-write race window. `.select()`
  // makes PostgREST return the updated row(s) so we can tell "matched and
  // wrote" (non-empty array) apart from "matched nothing" (empty array)
  // without a second round-trip on the success path.
  async updatePlaceIfUnchanged(
    place: Place,
    baseUpdatedAt: string,
  ): Promise<{ place: Place; conflict: boolean }> {
    const { data, error } = await this.client
      .from('places')
      .update(placeToRow(place))
      .eq('id', place.id)
      .eq('updated_at', baseUpdatedAt)
      .select();
    if (error) throw error;
    if (data && data.length > 0) {
      return { place, conflict: false };
    }

    // Nothing matched: either `updated_at` moved on since the caller read
    // it (the expected conflict case) or the place doesn't exist at all.
    // Re-read to tell those apart and hand back the current row.
    const { data: currentRow, error: readError } = await this.client
      .from('places')
      .select('*')
      .eq('id', place.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!currentRow) {
      throw new Error(`updatePlaceIfUnchanged: no place with id ${place.id}`);
    }
    return { place: placeFromRow(currentRow as PlaceRow), conflict: true };
  }

  // ---- Days ----

  async listDays(tripId: ID): Promise<Day[]> {
    const { data, error } = await this.client
      .from('days')
      .select('*')
      .eq('trip_id', tripId)
      .order('date', { ascending: true });
    if (error) throw error;
    return (data as DayRow[]).map(dayFromRow);
  }

  // ---- Itinerary ----

  async listItinerary(dayId: ID): Promise<ItineraryItem[]> {
    const { data, error } = await this.client
      .from('itinerary')
      .select('*')
      .eq('day_id', dayId)
      .order('order', { ascending: true });
    if (error) throw error;
    return (data as ItineraryRow[]).map(itineraryFromRow);
  }

  async listAllItinerary(tripId: ID): Promise<ItineraryItem[]> {
    const days = await this.listDays(tripId);
    const dayIds = days.map((d) => d.id);
    if (dayIds.length === 0) return [];
    const { data, error } = await this.client
      .from('itinerary')
      .select('*')
      .in('day_id', dayIds)
      .order('order', { ascending: true });
    if (error) throw error;
    return (data as ItineraryRow[]).map(itineraryFromRow);
  }

  async upsertItineraryItem(item: ItineraryItem): Promise<ItineraryItem> {
    const { error } = await this.client.from('itinerary').upsert(itineraryToRow(item));
    if (error) throw error;
    return item;
  }

  async deleteItineraryItem(id: ID): Promise<void> {
    const { error } = await this.client.from('itinerary').delete().eq('id', id);
    if (error) throw error;
  }

  // ---- Expenses ----

  async listExpenses(tripId: ID): Promise<Expense[]> {
    const { data, error } = await this.client.from('expenses').select('*').eq('trip_id', tripId);
    if (error) throw error;
    return (data as ExpenseRow[]).map(expenseFromRow);
  }

  async upsertExpense(expense: Expense): Promise<Expense> {
    const { error } = await this.client.from('expenses').upsert(expenseToRow(expense));
    if (error) throw error;
    return expense;
  }

  async deleteExpense(id: ID): Promise<void> {
    const { error } = await this.client.from('expenses').delete().eq('id', id);
    if (error) throw error;
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
    return { version: 3, trip, days, places, itinerary, expenses };
  }

  async importSnapshot(snapshot: TripSnapshot): Promise<void> {
    // Delegates to a Postgres RPC function (see 0001_init.sql) that performs
    // an atomic delete-then-insert across all 5 tables — PostgREST offers no
    // cross-statement client transaction, and plain sequential upserts here
    // wouldn't remove rows dropped from the snapshot (e.g. a deleted place).
    const { error } = await this.client.rpc('import_trip_snapshot', { snapshot });
    if (error) throw error;
  }
}
