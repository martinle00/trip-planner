// ============================================================================
// FROZEN CONTRACT (interface) — the app-facing store.
// The frontend consumes THIS hook and its `TripState` shape. Keep the exported
// interface stable.
//
// Backend/data specialist: this file is now repository-backed (Dexie via
// tripRepository). `init()` seeds on first run and loads persisted state;
// every mutating action persists through the repository AND updates
// in-memory state optimistically.
// ============================================================================

import { create } from 'zustand';
import type {
  Day,
  Expense,
  ID,
  ItineraryItem,
  Place,
  Trip,
} from '../data/schema';
import type { DayPlan } from '../lib/autoplan';
import { ACTIVE_TRIP_ID } from '../data/tripRepository';
import { tripRepository } from '../data/dexieTripRepository';
import { parseSnapshot, serializeSnapshot } from '../data/exportImport';
import * as exchangeRates from '../lib/exchangeRates';

export interface TripState {
  // ---- data ----
  trip: Trip | undefined;
  places: Place[];
  days: Day[];
  /** Itinerary items keyed by dayId (each array sorted by `order`). */
  itineraryByDay: Record<ID, ItineraryItem[]>;
  expenses: Expense[];
  loading: boolean;
  /** True while a `refreshRates()` fetch is in flight. */
  ratesLoading: boolean;
  /** Message from the most recent `refreshRates()` failure, or undefined.
   *  Cleared at the start of the next `refreshRates()` call. */
  ratesError: string | undefined;

  // ---- lifecycle ----
  /** Load persisted data (seeding on first run). Call once on app mount. */
  init: () => Promise<void>;

  // ---- places ----
  addPlace: (
    input: Omit<Place, 'id' | 'tripId' | 'status'> & Partial<Pick<Place, 'status' | 'dayId'>>,
  ) => Promise<Place>;
  updatePlace: (place: Place) => Promise<void>;
  removePlace: (id: ID) => Promise<void>;
  /** Assign (or clear, with undefined) a place's day; keeps status in sync. */
  assignPlaceToDay: (placeId: ID, dayId: ID | undefined) => Promise<void>;

  // ---- itinerary ----
  addItineraryItem: (input: Omit<ItineraryItem, 'id' | 'order'> & Partial<Pick<ItineraryItem, 'order'>>) => Promise<ItineraryItem>;
  updateItineraryItem: (item: ItineraryItem) => Promise<void>;
  removeItineraryItem: (id: ID) => Promise<void>;
  /** Reorder a day's items to match the given id order. */
  reorderItinerary: (dayId: ID, orderedIds: ID[]) => Promise<void>;

  // ---- expenses ----
  addExpense: (input: Omit<Expense, 'id' | 'tripId'>) => Promise<Expense>;
  updateExpense: (expense: Expense) => Promise<void>;
  removeExpense: (id: ID) => Promise<void>;
  /**
   * Change the trip's home currency. Re-bases the existing `rates` map onto
   * the new home currency using its own stored cross-rate (a pure local
   * recalculation, no network call — see the implementation for the exact
   * math), so totals stay sane offline immediately after the switch. If no
   * cross-rate for the new currency is known yet, `rates` is reset to an
   * identity-only map and `ratesUpdatedAt` is cleared so the UI shows
   * "refresh needed" until `refreshRates()` is called. No-ops if `code`
   * equals the current home currency or the trip isn't loaded yet.
   */
  setHomeCurrency: (code: string) => Promise<void>;
  /**
   * Fetch live exchange rates (relative to the trip's current home
   * currency) via `lib/exchangeRates.fetchRates` and store them on the trip
   * (`rates`/`ratesBase`/`ratesUpdatedAt`), persisted through the
   * repository. Sets `ratesLoading` for the duration of the call and, on
   * failure, `ratesError` (a human-readable message) — the call also
   * rethrows so an awaiting caller can react directly. `ratesError` is
   * cleared at the start of every call, including a subsequent successful
   * one.
   */
  refreshRates: () => Promise<void>;

  // ---- auto-plan ----
  /** Commit an accepted auto-plan draft: writes items, assigns place days. */
  applyAutoPlan: (plan: DayPlan[]) => Promise<void>;

  // ---- portability ----
  exportJson: () => Promise<string>;
  importJson: (json: string) => Promise<void>;
}

const newId = (prefix: string): ID =>
  `${prefix}-${(crypto.randomUUID?.() ?? Math.random().toString(36).slice(2))}`;

function sortByOrder(items: ItineraryItem[]): ItineraryItem[] {
  return [...items].sort((a, b) => a.order - b.order);
}

function groupByDay(items: ItineraryItem[]): Record<ID, ItineraryItem[]> {
  const itineraryByDay: Record<ID, ItineraryItem[]> = {};
  for (const item of items) {
    (itineraryByDay[item.dayId] ??= []).push(item);
  }
  for (const dayId of Object.keys(itineraryByDay)) {
    itineraryByDay[dayId] = sortByOrder(itineraryByDay[dayId]);
  }
  return itineraryByDay;
}

// ---------------------------------------------------------------------------
// Write-serialization for the store's itinerary-linking actions.
//
// assignPlaceToDay and applyAutoPlan are each internally a read-then-write
// sequence against `itineraryByDay` (read: "does a linked item already exist
// for this placeId/dayId?" -> several `await`s later -> write: create or
// update it). That's fine for one call at a time, but two *overlapping*
// calls (an ordinary rapid double-click of "Accept draft", or two rapid
// day-dropdown changes) can both perform their read before either one's
// write lands — both see "none exists" and both insert, producing a
// duplicate ItineraryItem that a later call won't self-heal (it only ever
// finds/updates one of the two).
//
// runExclusive() queues callers onto a single shared promise chain so only
// one call's body runs at a time; an overlapping second call then starts
// only after the first has fully committed its writes, sees the
// already-linked item, and updates it in place instead of duplicating it.
// A failure in one queued call doesn't block the next (the chain always
// advances). Store-module-private — not part of the exported TripState
// contract.
//
// makeExclusiveQueue() factors out the pattern itself so unrelated features
// (see `runRatesExclusive` below, used only by refreshRates) can get their
// own independent queue/serialization without being chained behind — and
// so contending with — itinerary-linking writes they have nothing to do
// with.
function makeExclusiveQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const runExclusive = makeExclusiveQueue();

// Dedicated queue for refreshRates(): two overlapping calls (e.g. a rapid
// double-click on "Refresh rates" before the first request lands, or two
// components both triggering a refresh) would otherwise resolve
// last-COMPLETED-wins — a slower-but-earlier fetch could land after, and so
// overwrite, a faster-later one with staler rates and an older
// `ratesUpdatedAt`. The Budget UI already disables its refresh control while
// `ratesLoading` is true, but this queue closes the race unconditionally for
// any caller. Kept separate from `runExclusive` above since rate refreshes
// are unrelated to itinerary-linking writes.
const runRatesExclusive = makeExclusiveQueue();

export const useTripStore = create<TripState>((set, get) => ({
  trip: undefined,
  places: [],
  days: [],
  itineraryByDay: {},
  expenses: [],
  loading: true,
  ratesLoading: false,
  ratesError: undefined,

  init: async () => {
    set({ loading: true });
    await tripRepository.seedIfEmpty();
    const trip = await tripRepository.getTrip();
    const tripId = trip?.id ?? ACTIVE_TRIP_ID;
    const [places, days, itinerary, expenses] = await Promise.all([
      tripRepository.listPlaces(tripId),
      tripRepository.listDays(tripId),
      tripRepository.listAllItinerary(tripId),
      tripRepository.listExpenses(tripId),
    ]);
    set({
      trip,
      places,
      days,
      itineraryByDay: groupByDay(itinerary),
      expenses,
      loading: false,
    });
  },

  addPlace: async (input) => {
    const trip = get().trip;
    const place: Place = {
      id: newId('place'),
      tripId: trip?.id ?? ACTIVE_TRIP_ID,
      status: input.status ?? 'wishlist',
      ...input,
    };
    await tripRepository.upsertPlace(place);
    set((s) => ({ places: [...s.places, place] }));
    // A place created already assigned to a day gets a linked (untimed)
    // itinerary stop too, for consistency with assignPlaceToDay/applyAutoPlan.
    if (place.dayId) {
      await get().addItineraryItem({
        dayId: place.dayId,
        placeId: place.id,
        title: place.name,
      });
    }
    return place;
  },

  updatePlace: async (place) => {
    await tripRepository.upsertPlace(place);
    set((s) => ({ places: s.places.map((p) => (p.id === place.id ? place : p)) }));
  },

  // Also strips any itinerary item(s) linked to this place (item.placeId ===
  // id) from every day — otherwise a deleted place leaves a dangling stop
  // that still renders in the Itinerary tab / Map day-view.
  removePlace: async (id) => {
    await tripRepository.deletePlace(id);
    const orphanedItemIds = Object.values(get().itineraryByDay)
      .flat()
      .filter((i) => i.placeId === id)
      .map((i) => i.id);
    await Promise.all(orphanedItemIds.map((itemId) => tripRepository.deleteItineraryItem(itemId)));
    set((s) => {
      const next: Record<ID, ItineraryItem[]> = {};
      for (const [dayId, items] of Object.entries(s.itineraryByDay)) {
        next[dayId] = items.filter((i) => i.placeId !== id);
      }
      return {
        places: s.places.filter((p) => p.id !== id),
        itineraryByDay: next,
      };
    });
  },

  // Assigning/reassigning/unassigning a place to a day keeps a single linked
  // ItineraryItem (item.placeId === placeId) in sync with the place's dayId,
  // so the day's plan (Map day-view + Itinerary tab) reflects the change —
  // mirroring the pattern applyAutoPlan already uses. The link is identified
  // purely by placeId + dayId (not by remembering "the" item across calls),
  // so:
  //  - assign (wishlist -> day D): create one untimed linked stop on D,
  //    UNLESS one already exists on D (e.g. auto-plan already linked it) —
  //    in that case the existing item (and any startTime/note on it) is left
  //    untouched, avoiding a duplicate.
  //  - reassign (day A -> day B): the linked item is *moved* (its `dayId` is
  //    updated and it's appended to the end of B's order) — any startTime/
  //    note/durationMin previously set on it is preserved. If B already has
  //    its own linked item for this place, the moved item is dropped instead
  //    (no duplicate) and B's existing item wins.
  //  - unassign (day A -> wishlist): the linked item is deleted outright.
  //
  // Wrapped in runExclusive: this whole read-then-write sequence is
  // serialized against other assignPlaceToDay/applyAutoPlan calls, so two
  // overlapping invocations (e.g. rapid day-dropdown changes) can't both
  // read "no existing link" before either writes — the second one always
  // observes the first's completed write and updates/moves it instead of
  // creating a duplicate.
  assignPlaceToDay: (placeId, dayId) =>
    runExclusive(async () => {
      const existing = get().places.find((p) => p.id === placeId);
      if (!existing) return;
      const oldDayId = existing.dayId;
      const updated: Place = { ...existing, dayId, status: dayId ? 'planned' : 'wishlist' };
      await tripRepository.upsertPlace(updated);
      set((s) => ({
        places: s.places.map((p) => (p.id === placeId ? updated : p)),
      }));

      if (oldDayId === dayId) {
        // No actual day change (incl. undefined -> undefined): nothing to
        // link/unlink.
        return;
      }

      const linkedOnOldDay = oldDayId
        ? (get().itineraryByDay[oldDayId] ?? []).filter((i) => i.placeId === placeId)
        : [];

      if (!dayId) {
        // Unassign: drop the linked stop(s) entirely.
        await Promise.all(linkedOnOldDay.map((item) => get().removeItineraryItem(item.id)));
        return;
      }

      const linkedOnNewDay = (get().itineraryByDay[dayId] ?? []).filter(
        (i) => i.placeId === placeId,
      );

      if (linkedOnNewDay.length > 0) {
        // Target day already has a linked stop for this place (e.g. from
        // auto-plan) — keep it, and drop any stray link left on the old day.
        await Promise.all(linkedOnOldDay.map((item) => get().removeItineraryItem(item.id)));
        return;
      }

      if (linkedOnOldDay.length > 0) {
        // Move: relocate the existing linked item to the new day, appended
        // at the end (updateItineraryItem auto-appends on a cross-day
        // move), preserving any customizations it already had.
        const [toMove, ...extras] = linkedOnOldDay;
        await get().updateItineraryItem({ ...toMove, dayId });
        await Promise.all(extras.map((extra) => get().removeItineraryItem(extra.id)));
        return;
      }

      // No existing linked item anywhere — create a fresh untimed stop.
      await get().addItineraryItem({
        dayId,
        placeId,
        title: updated.name,
      });
    }),

  addItineraryItem: async (input) => {
    const existing = get().itineraryByDay[input.dayId] ?? [];
    const order = input.order ?? existing.length;
    const item: ItineraryItem = { id: newId('item'), order, ...input };
    await tripRepository.upsertItineraryItem(item);
    set((s) => ({
      itineraryByDay: {
        ...s.itineraryByDay,
        [input.dayId]: sortByOrder([...(s.itineraryByDay[input.dayId] ?? []), item]),
      },
    }));
    return item;
  },

  // Handles both an in-place edit and a day change (item.dayId differs from
  // wherever it currently lives in state) — the item is removed from
  // whichever day's array currently holds it (by id) and (re)inserted, sorted,
  // into item.dayId's array. On a cross-day move the caller-supplied `order`
  // is ignored and replaced with an append (end of the target day's list) —
  // this way a caller can never hand it a stale order for a day it hasn't
  // looked at; same-day edits keep the given order untouched.
  updateItineraryItem: async (item) => {
    const stateNow = get();
    let currentDayId: ID | undefined;
    for (const [dayId, items] of Object.entries(stateNow.itineraryByDay)) {
      if (items.some((i) => i.id === item.id)) {
        currentDayId = dayId;
        break;
      }
    }
    const isMove = currentDayId !== undefined && currentDayId !== item.dayId;
    const finalItem: ItineraryItem = isMove
      ? { ...item, order: (stateNow.itineraryByDay[item.dayId] ?? []).length }
      : item;

    await tripRepository.upsertItineraryItem(finalItem);
    set((s) => {
      const next: Record<ID, ItineraryItem[]> = {};
      for (const [dayId, items] of Object.entries(s.itineraryByDay)) {
        next[dayId] = items.filter((i) => i.id !== finalItem.id);
      }
      next[finalItem.dayId] = sortByOrder([...(next[finalItem.dayId] ?? []), finalItem]);
      return { itineraryByDay: next };
    });
  },

  removeItineraryItem: async (id) => {
    await tripRepository.deleteItineraryItem(id);
    set((s) => {
      const next: Record<ID, ItineraryItem[]> = {};
      for (const [dayId, items] of Object.entries(s.itineraryByDay)) {
        next[dayId] = items.filter((i) => i.id !== id);
      }
      return { itineraryByDay: next };
    });
  },

  reorderItinerary: async (dayId, orderedIds) => {
    const items = get().itineraryByDay[dayId] ?? [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const reordered = orderedIds
      .map((id, idx) => {
        const it = byId.get(id);
        return it ? { ...it, order: idx } : undefined;
      })
      .filter((i): i is ItineraryItem => Boolean(i));
    await Promise.all(reordered.map((item) => tripRepository.upsertItineraryItem(item)));
    set((s) => ({ itineraryByDay: { ...s.itineraryByDay, [dayId]: reordered } }));
  },

  addExpense: async (input) => {
    const trip = get().trip;
    const expense: Expense = {
      id: newId('exp'),
      tripId: trip?.id ?? ACTIVE_TRIP_ID,
      ...input,
    };
    await tripRepository.upsertExpense(expense);
    set((s) => ({ expenses: [...s.expenses, expense] }));
    return expense;
  },

  updateExpense: async (expense) => {
    await tripRepository.upsertExpense(expense);
    set((s) => ({ expenses: s.expenses.map((e) => (e.id === expense.id ? expense : e)) }));
  },

  removeExpense: async (id) => {
    await tripRepository.deleteExpense(id);
    set((s) => ({ expenses: s.expenses.filter((e) => e.id !== id) }));
  },

  // Re-bases the stored `rates` map (home-relative, see schema.ts's Trip
  // doc comment) onto a new home currency using the OLD map's own cross-rate
  // for the new currency — purely local arithmetic, works offline, and
  // keeps every other currency's converted value internally consistent
  // (e.g. CNY relative to SGD is unaffected by which of the two is "home").
  //
  // Math: rates[C] (old) = value in OLD home of 1 unit C. Let
  // crossRate = rates[newCode] = value in OLD home of 1 unit of the NEW
  // home currency. Then value in NEW home of 1 unit C = rates[C] / crossRate
  // (dividing an OLD-home value by "OLD-home per 1 NEW-home" converts it to
  // NEW-home terms). This also correctly re-derives rates[oldHome] = 1 /
  // crossRate, since rates[oldHome] was 1.
  //
  // If the old map has no entry for the new currency at all, there's no
  // cross-rate to re-base from — fall back to an identity-only map (just
  // { [newCode]: 1 }) and clear ratesUpdatedAt so the UI reports "refresh
  // needed" rather than silently keeping stale/wrongly-based numbers.
  setHomeCurrency: async (code) => {
    const trip = get().trip;
    if (!trip) return;
    const newCode = code.trim().toUpperCase();
    if (!newCode || newCode === trip.homeCurrency) return;

    const crossRate = trip.rates[newCode];
    let rates: Record<string, number>;
    let ratesUpdatedAt = trip.ratesUpdatedAt;
    if (crossRate && crossRate > 0) {
      rates = {};
      for (const [currency, homeValue] of Object.entries(trip.rates)) {
        rates[currency] = homeValue / crossRate;
      }
      rates[newCode] = 1; // exact identity, not a self-division float artifact
    } else {
      rates = { [newCode]: 1 };
      ratesUpdatedAt = undefined;
    }

    const updated: Trip = { ...trip, homeCurrency: newCode, rates, ratesUpdatedAt, ratesBase: newCode };
    await tripRepository.saveTrip(updated);
    set({ trip: updated });
  },

  refreshRates: () =>
    runRatesExclusive(async () => {
      const trip = get().trip;
      if (!trip) return;
      set({ ratesLoading: true, ratesError: undefined });
      try {
        const { rates, base, fetchedAt } = await exchangeRates.fetchRates(trip.homeCurrency);
        const updated: Trip = { ...trip, rates, ratesBase: base, ratesUpdatedAt: fetchedAt };
        await tripRepository.saveTrip(updated);
        set({ trip: updated, ratesLoading: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to refresh exchange rates';
        set({ ratesLoading: false, ratesError: message });
        throw err;
      }
    }),

  // Note: this intentionally does NOT call the public assignPlaceToDay —
  // that action creates its own (untimed) linked itinerary item, which would
  // duplicate the fully-timed item auto-plan produces here. Instead it
  // inlines the place-side of the assignment and writes the single,
  // fully-specified ItineraryItem per stop directly.
  //
  // Idempotent by (dayId, placeId): re-applying the same (or a regenerated)
  // plan UPDATES an already-linked item on that day in place (preserving its
  // id) rather than inserting a new one. That check-then-write is itself
  // only safe against ONE call at a time, though — it reads
  // itineraryByDay, then does several `await`s (place upsert, item
  // create/update) before writing, so two truly *overlapping* calls (e.g. a
  // rapid double-click on "Accept draft", which has no in-flight guard in
  // AutoPlanModal) could otherwise both read "no existing item" and both
  // insert. The whole per-call body is therefore wrapped in runExclusive so
  // overlapping invocations are serialized (queued, not interleaved) — the
  // second one only starts once the first has fully committed, and so
  // reliably finds and updates the item the first one just created instead
  // of duplicating it.
  applyAutoPlan: (plan) =>
    runExclusive(async () => {
      for (const dayPlan of plan) {
        for (const stop of dayPlan.stops) {
          const place = get().places.find((p) => p.id === stop.placeId);
          if (!place) continue;
          const updatedPlace: Place = { ...place, dayId: dayPlan.dayId, status: 'planned' };
          await tripRepository.upsertPlace(updatedPlace);
          set((s) => ({
            places: s.places.map((p) => (p.id === stop.placeId ? updatedPlace : p)),
          }));

          const existingItem = (get().itineraryByDay[dayPlan.dayId] ?? []).find(
            (i) => i.placeId === stop.placeId,
          );
          if (existingItem) {
            await get().updateItineraryItem({
              ...existingItem,
              dayId: dayPlan.dayId,
              title: updatedPlace.name,
              startTime: stop.startTime,
              durationMin: stop.durationMin,
              order: stop.order,
            });
          } else {
            await get().addItineraryItem({
              dayId: dayPlan.dayId,
              placeId: stop.placeId,
              title: updatedPlace.name,
              startTime: stop.startTime,
              durationMin: stop.durationMin,
              order: stop.order,
            });
          }
        }
      }
    }),

  exportJson: async () => {
    const snapshot = await tripRepository.exportSnapshot();
    return serializeSnapshot(snapshot);
  },

  importJson: async (json) => {
    const snapshot = parseSnapshot(json);
    await tripRepository.importSnapshot(snapshot);
    set({
      trip: snapshot.trip,
      places: snapshot.places,
      days: snapshot.days,
      itineraryByDay: groupByDay(snapshot.itinerary),
      expenses: snapshot.expenses,
      loading: false,
    });
  },
}));
