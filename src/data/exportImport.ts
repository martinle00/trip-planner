// ============================================================================
// Whole-trip JSON export/import helpers (trip.json device portability).
// Owned by the Backend/data specialist. The UI calls these to wire up
// "Export" / "Import" buttons; the store's exportJson/importJson delegate
// through serializeSnapshot/parseSnapshot.
// ============================================================================

import type { Day, Expense, ID, ItineraryItem, Place, Trip, TripSnapshot } from './schema';

/** Serialize a TripSnapshot to a pretty-printed JSON string. Always writes
 *  the current (v5) shape. */
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

/** v3-shaped snapshot — the shape of `TripSnapshot` before the Phase 5
 *  `Expense.note`/`Expense.paidBy`/`Trip.members` additions. */
interface TripSnapshotV3 {
  version: 3;
  trip: Omit<Trip, 'members'>;
  days: Day[];
  places: Place[];
  itinerary: ItineraryItem[];
  expenses: Array<Omit<Expense, 'note' | 'paidBy'>>;
}

export function migrateSnapshotV2ToV3(snapshot: TripSnapshotV2): TripSnapshotV3 {
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

// ---------------------------------------------------------------------------
// v3 -> v4 migration (Phase 5 — richer expenses).
//
// v3 shape: no `Trip.members`, no `Expense.note`/`Expense.paidBy`.
// v4 shape (current — see schema.ts): all three added, all optional. A v3
// record is therefore ALREADY valid v4 data with those fields simply absent
// — this migration is a pure defaulting no-op, unlike the v1->v2/v2->v3
// steps above which had real per-record transforms to apply. Still done
// explicitly (rather than just accepting `version === 3` inline in
// `parseSnapshot`) so the version tag itself is corrected and this stays
// consistent with the shape every other migration step in this file takes.
// ---------------------------------------------------------------------------

interface TripSnapshotV4 {
  version: 4;
  trip: Trip;
  days: Day[];
  places: Place[];
  itinerary: ItineraryItem[];
  expenses: ExpenseV4[];
}

export function migrateSnapshotV3ToV4(snapshot: TripSnapshotV3): TripSnapshotV4 {
  return {
    version: 4,
    trip: snapshot.trip,
    days: snapshot.days,
    places: snapshot.places,
    itinerary: snapshot.itinerary,
    expenses: snapshot.expenses,
  };
}

// ---------------------------------------------------------------------------
// v4 -> v5 migration (Phase 6 — expense city attachment + sharing).
//
// v4 shape: `Expense.dayId`/`Expense.itemId` (optionally attached to a day/
// itinerary item), no `city`, no `coversMemberIds`, no `TripMember.color`.
// v5 shape (current — see schema.ts): `dayId`/`itemId` REMOVED outright
// (a deliberate non-additive break, decided by the user — see PHASE6.md);
// `Expense.city` added, derived from the OLD `dayId` by looking it up
// against the snapshot's own `days` array. `Expense.coversMemberIds` and
// `TripMember.color` are purely additive (both optional, absent = the
// existing default behaviour), so this migration's only real per-record
// transform is the `dayId` -> `city` derivation.
//
// `migrateExpenseV4ToV5` is exported (along with `ExpenseV4`) so `data/db.ts`'s
// Dexie `version(5).upgrade()` can reuse the exact same per-record transform
// for existing LOCAL IndexedDB data — the JSON import path here and the
// in-place IndexedDB upgrade must never drift out of sync with each other,
// same rule every earlier migration in this file follows.
// ---------------------------------------------------------------------------

export interface ExpenseV4 {
  id: string;
  tripId: string;
  dayId?: string;
  itemId?: string;
  category: string;
  label: string;
  amount: number;
  currency: string;
  paid: boolean;
  note?: string;
  paidBy?: string;
}

/**
 * Pure per-expense v4 -> v5 transform. `cityByDayId` maps a `Day.id` to its
 * `city` (built once per migration run from the snapshot's/local database's
 * own `days`, by the caller — see `migrateSnapshotV4ToV5` below and
 * `db.ts`'s `version(5).upgrade()`). A `dayId` that isn't a key in the map
 * (an orphaned/unresolvable reference) degrades to `city: undefined`
 * ("Whole trip") rather than throwing — same orphan-tolerance posture as
 * `Expense.paidBy`.
 */
export function migrateExpenseV4ToV5(
  expense: ExpenseV4,
  cityByDayId: Map<ID, string>,
): Expense {
  return {
    id: expense.id,
    tripId: expense.tripId,
    category: expense.category,
    label: expense.label,
    amount: expense.amount,
    currency: expense.currency,
    paid: expense.paid,
    note: expense.note,
    paidBy: expense.paidBy,
    city: expense.dayId ? cityByDayId.get(expense.dayId) : undefined,
  };
}

export function migrateSnapshotV4ToV5(snapshot: TripSnapshotV4): TripSnapshot {
  const cityByDayId = new Map(snapshot.days.map((d) => [d.id, d.city]));
  return {
    version: 5,
    trip: snapshot.trip,
    days: snapshot.days,
    places: snapshot.places,
    itinerary: snapshot.itinerary,
    expenses: snapshot.expenses.map((e) => migrateExpenseV4ToV5(e, cityByDayId)),
  };
}

/**
 * Normalises an explicit empty `Expense.coversMemberIds: []` to `undefined`
 * ("everyone") — the single choke point for this rule (see schema.ts's
 * `Expense.coversMemberIds` doc comment and PHASE6.md item 10). Applied
 * unconditionally to the final result of every `parseSnapshot` call, whether
 * the input arrived as a fresh v5 snapshot or was migrated up from an older
 * version, so a hand-edited or externally-produced import can't slip a `[]`
 * past this rule even though the app's own expense form can't produce one
 * (deselecting the last covered person snaps back to "everyone" there).
 */
function normalizeExpensesCoversMemberIds(expenses: Expense[]): Expense[] {
  return expenses.map((e) =>
    e.coversMemberIds && e.coversMemberIds.length === 0
      ? { ...e, coversMemberIds: undefined }
      : e,
  );
}

/**
 * Parse a JSON string into a (current, v5-shaped) TripSnapshot, with minimal
 * shape validation. Accepts v1, v2, v3, v4 and v5 snapshot JSON — v1, v2, v3
 * and v4 are transparently migrated, chaining v1 -> v2 -> v3 -> v4 -> v5 for
 * a very old export (see migrateSnapshotV1ToV2/migrateSnapshotV2ToV3/
 * migrateSnapshotV3ToV4/migrateSnapshotV4ToV5 above). Throws if the JSON is
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
  let snapshot: TripSnapshot;
  if (version === 1) {
    snapshot = migrateSnapshotV4ToV5(
      migrateSnapshotV3ToV4(migrateSnapshotV2ToV3(migrateSnapshotV1ToV2(parsed as TripSnapshotV1))),
    );
  } else if (version === 2) {
    snapshot = migrateSnapshotV4ToV5(migrateSnapshotV3ToV4(migrateSnapshotV2ToV3(parsed as TripSnapshotV2)));
  } else if (version === 3) {
    snapshot = migrateSnapshotV4ToV5(migrateSnapshotV3ToV4(parsed as TripSnapshotV3));
  } else if (version === 4) {
    snapshot = migrateSnapshotV4ToV5(parsed as TripSnapshotV4);
  } else if (version === 5) {
    snapshot = parsed as TripSnapshot;
  } else {
    throw new Error('parseSnapshot: unsupported snapshot version');
  }
  return { ...snapshot, expenses: normalizeExpensesCoversMemberIds(snapshot.expenses) };
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
