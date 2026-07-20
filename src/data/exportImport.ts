// ============================================================================
// Whole-trip JSON export/import helpers (trip.json device portability).
// Owned by the Backend/data specialist. The UI calls these to wire up
// "Export" / "Import" buttons; the store's exportJson/importJson delegate
// through serializeSnapshot/parseSnapshot.
// ============================================================================

import type { Day, Expense, ItineraryItem, Place, Trip, TripSnapshot } from './schema';

/** Serialize a TripSnapshot to a pretty-printed JSON string. Always writes
 *  the current (v3) shape. */
export function serializeSnapshot(snapshot: TripSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

// ---------------------------------------------------------------------------
// v1 -> v2 migration.
//
// v1 shape (pre multi-currency budget):
//   Trip: { ..., cnyToHomeRate: number }               (no `rates` table)
//   Expense: { ..., amountCny: number }                 (no `currency` field)
//
// v2 shape (current — see schema.ts):
//   Trip: { ..., rates: Record<string, number>, ratesUpdatedAt?, ratesBase? }
//   Expense: { ..., amount: number, currency: string }
//
// Every historical expense was logged in CNY, so migration maps
// `amountCny` -> `{ amount: amountCny, currency: 'CNY' }`. `cnyToHomeRate`
// already meant "multiply a CNY amount by this to get the home-currency
// equivalent" — exactly the v2 `rates[C]` convention — so it becomes
// `rates.CNY`, with `rates[homeCurrency] = 1` (home currency in its own
// terms is always 1:1). `ratesUpdatedAt` is left undefined: a migrated v1
// trip has never been through a live `refreshRates()`.
//
// `migrateTripV1ToV2`/`migrateExpenseV1ToV2` are exported (along with the v1
// types) so `data/db.ts`'s Dexie `version(2).upgrade()` can reuse the exact
// same per-record transform for existing LOCAL IndexedDB data — the JSON
// import path here and the in-place IndexedDB upgrade must never drift out
// of sync with each other.
// ---------------------------------------------------------------------------

export interface TripV1 {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  homeCurrency: string;
  tripCurrency: string;
  cnyToHomeRate: number;
  cities: Trip['cities'];
}

export interface ExpenseV1 {
  id: string;
  tripId: string;
  dayId?: string;
  itemId?: string;
  category: string;
  label: string;
  amountCny: number;
  paid: boolean;
}

interface TripSnapshotV1 {
  version: 1;
  trip: TripV1;
  days: Day[];
  places: Place[];
  itinerary: ItineraryItem[];
  expenses: ExpenseV1[];
}

export function migrateTripV1ToV2(trip: TripV1): Trip {
  const { cnyToHomeRate, ...rest } = trip;
  return {
    ...rest,
    rates: {
      CNY: cnyToHomeRate,
      [trip.homeCurrency]: 1,
    },
    ratesBase: trip.homeCurrency,
    ratesUpdatedAt: undefined,
  };
}

export function migrateExpenseV1ToV2(expense: ExpenseV1): Expense {
  const { amountCny, ...rest } = expense;
  return { ...rest, amount: amountCny, currency: 'CNY' };
}

/** v2-shaped snapshot — places are `PlaceV2` (pre `description`/`selfReview`/
 *  required `updatedAt`, still carrying the old free-text `note`). */
interface TripSnapshotV2 {
  version: 2;
  trip: Trip;
  days: Day[];
  places: PlaceV2[];
  itinerary: ItineraryItem[];
  expenses: Expense[];
}

function migrateSnapshotV1ToV2(snapshot: TripSnapshotV1): TripSnapshotV2 {
  return {
    version: 2,
    trip: migrateTripV1ToV2(snapshot.trip),
    days: snapshot.days,
    places: snapshot.places as PlaceV2[],
    itinerary: snapshot.itinerary,
    expenses: snapshot.expenses.map(migrateExpenseV1ToV2),
  };
}

// ---------------------------------------------------------------------------
// v2 -> v3 migration.
//
// v2 shape: `Place.note` (single free-text field), no `description`/
// `selfReview`, no `updatedAt`.
// v3 shape (current — see schema.ts): `Place.note` removed; `description`
// (pre-visit notes) + `selfReview` (post-visit reflection) added, both
// optional; `updatedAt` (ISO date-time) added, required.
//
// `migratePlaceV2ToV3` is exported (along with `PlaceV2`) so `data/db.ts`'s
// Dexie `version(3).upgrade()` can reuse the exact same per-place transform
// for existing LOCAL IndexedDB data — the JSON import path here and the
// in-place IndexedDB upgrade must never drift out of sync with each other,
// same rule the v1->v2 migration above already follows.
// ---------------------------------------------------------------------------

export interface PlaceV2 {
  id: string;
  tripId: string;
  name: string;
  note?: string;
  category?: string;
  lat: number;
  lng: number;
  city: string;
  status: Place['status'];
  dayId?: string;
  sourceUrl?: string;
  address?: string;
}

/**
 * Pure per-place v2 -> v3 transform. Folds `note` into `description`
 * (concatenating if `description` is somehow already present on the input —
 * defensive; a genuine v2 record never has one) and backfills `updatedAt`
 * from `fallbackUpdatedAt` when the record doesn't already carry one.
 * `fallbackUpdatedAt` is passed in (rather than computed here) so a single
 * migration run — one Dexie upgrade, or one `parseSnapshot` call — stamps
 * every place it touches with the exact same timestamp, and so this
 * function itself stays a pure, easily-testable transform.
 */
export function migratePlaceV2ToV3(
  place: PlaceV2 & { description?: string; updatedAt?: string },
  fallbackUpdatedAt: string,
): Place {
  const { note, description: existingDescription, updatedAt, ...rest } = place;
  const description = note
    ? existingDescription
      ? `${existingDescription}\n\n${note}`
      : note
    : existingDescription;
  return {
    ...rest,
    description,
    updatedAt: updatedAt ?? fallbackUpdatedAt,
  };
}

export function migrateSnapshotV2ToV3(snapshot: TripSnapshotV2): TripSnapshot {
  const fallbackUpdatedAt = new Date().toISOString();
  return {
    version: 3,
    trip: snapshot.trip,
    days: snapshot.days,
    places: snapshot.places.map((p) => migratePlaceV2ToV3(p, fallbackUpdatedAt)),
    itinerary: snapshot.itinerary,
    expenses: snapshot.expenses,
  };
}

/**
 * Parse a JSON string into a (current, v3-shaped) TripSnapshot, with minimal
 * shape validation. Accepts v1, v2 and v3 snapshot JSON — v1 and v2 are
 * transparently migrated, chaining v1 -> v2 -> v3 for a very old export (see
 * migrateSnapshotV1ToV2/migrateSnapshotV2ToV3 above). Throws if the JSON is
 * malformed, clearly not a trip snapshot, or carries a `version` this build
 * doesn't recognize (including a missing/undefined version) — an
 * unrecognized version is never silently trusted as the current shape.
 */
export function parseSnapshot(json: string): TripSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('parseSnapshot: invalid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('trip' in parsed) ||
    !('days' in parsed) ||
    !('places' in parsed) ||
    !('itinerary' in parsed) ||
    !('expenses' in parsed)
  ) {
    throw new Error('parseSnapshot: JSON is not a valid TripSnapshot');
  }
  const version = (parsed as { version?: unknown }).version;
  if (version === 1) {
    return migrateSnapshotV2ToV3(migrateSnapshotV1ToV2(parsed as TripSnapshotV1));
  }
  if (version === 2) {
    return migrateSnapshotV2ToV3(parsed as TripSnapshotV2);
  }
  if (version === 3) {
    return parsed as TripSnapshot;
  }
  throw new Error('parseSnapshot: unsupported snapshot version');
}

/**
 * Trigger a browser download of the snapshot as a `.json` file.
 * Call from a UI event handler (e.g. an "Export" button's onClick).
 */
export function downloadSnapshot(
  snapshot: TripSnapshot,
  filename = 'trip.json',
): void {
  const json = serializeSnapshot(snapshot);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Read a File (e.g. from an <input type="file"> change event) as text.
 * Pair with `parseSnapshot` to turn it into a TripSnapshot.
 */
export function readSnapshotFile(file: File): Promise<string> {
  return file.text();
}
