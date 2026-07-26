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
  TripMember,
} from '../data/schema';
import type { DayPlan } from '../lib/autoplan';
import { ACTIVE_TRIP_ID } from '../data/tripRepository';
import { getActiveRepository, tripRepository } from '../data/tripRepositoryInstance';
import { DexieTripRepository } from '../data/dexieTripRepository';
import { parseSnapshot, serializeSnapshot } from '../data/exportImport';
import { draftRepository } from '../data/draftRepository';
import type { PlaceDraft } from '../data/draftRepository';
import { stagedAssignmentRepository } from '../data/stagedAssignmentRepository';
import type { StagedAssignment } from '../data/stagedAssignmentRepository';
import * as exchangeRates from '../lib/exchangeRates';
import { appendRemoteIfDifferent } from '../lib/proseMerge';

export interface TripState {
  // ---- data ----
  trip: Trip | undefined;
  places: Place[];
  days: Day[];
  /** Itinerary items keyed by dayId (each array sorted by `order`). */
  itineraryByDay: Record<ID, ItineraryItem[]>;
  expenses: Expense[];
  /** True only while there is genuinely no cached local trip yet AND no
   *  repository result has landed either — i.e. a true first-ever load on
   *  this device. The UI should show its full-page "cold start" state only
   *  while this is true; every returning visit flips it to `false` almost
   *  instantly (as soon as the local Dexie cache is read), well before any
   *  network call resolves. */
  loading: boolean;
  /** True while `init()`'s background reconciliation against the
   *  currently-active repository (Dexie pre-auth, or the Supabase-backed
   *  `SyncedTripRepository` once signed in) is in flight. Drives the
   *  topbar's small non-blocking sync-status pill; unrelated to `loading`,
   *  which only ever reflects the one-time cold-start wait. */
  syncing: boolean;
  /** Message from the most recent background sync failure triggered by
   *  `init()`, or undefined. Cleared at the start of every sync attempt,
   *  mirroring the `ratesError` convention below. Only ever set for a
   *  genuine failure (not for the ordinary offline case, which the
   *  repository layer already handles by silently falling back to cache). */
  syncError: string | undefined;
  /** True while a `refreshRates()` fetch is in flight. */
  ratesLoading: boolean;
  /** Message from the most recent `refreshRates()` failure, or undefined.
   *  Cleared at the start of the next `refreshRates()` call. */
  ratesError: string | undefined;
  /**
   * In-memory mirror of the local (never-synced) Map day-assignment staging
   * table, keyed by placeId -- see `stagedAssignmentRepository.ts`. A place
   * with an entry here has an unsaved Map day reassignment pending. Loaded
   * from the staging table on `init()`; survives a city switch or a full
   * reload the same way place prose drafts do (`draftRepository.ts`), but
   * (like those drafts) is NEVER synced to Supabase. Read it via the
   * `getEffectiveDayId`/`getStagedAssignmentCount*` helpers exported
   * alongside this store, rather than re-deriving the same lookups ad hoc.
   */
  stagedAssignments: Record<ID, { dayId: ID | undefined; city: string }>;

  // ---- lifecycle ----
  /**
   * Cache-first, stale-while-revalidate load. Call once on app mount.
   *
   * 1. Reads directly from a fresh local Dexie repository instance and, if a
   *    cached trip exists, paints it into state immediately (`loading` goes
   *    `false` as soon as this resolves — Dexie reads are fast/local, so
   *    this should feel instant even offline).
   * 2. In the background (not awaited, so it never re-blocks a warm start),
   *    re-fetches everything from the currently-active repository (plain
   *    Dexie pre-auth, or the Supabase-backed `SyncedTripRepository` once
   *    signed in) and silently updates state again when that lands —
   *    `syncing` is true for the duration, and a failure sets `syncError`
   *    rather than throwing/blocking.
   * 3. If there is no cached local trip at all, this IS the first paint, so
   *    the background step above is awaited instead — `loading` stays true
   *    (the UI's blocking "cold start" state) until it settles.
   */
  init: () => Promise<void>;

  // ---- places ----
  /** `updatedAt` is never caller-supplied — every place-mutating action
   *  stamps it with the current time itself (see `Place.updatedAt`'s doc
   *  comment in schema.ts). */
  addPlace: (
    input: Omit<Place, 'id' | 'tripId' | 'status' | 'updatedAt'> &
      Partial<Pick<Place, 'status' | 'dayId'>>,
  ) => Promise<Place>;
  /** `place.updatedAt` is ignored (overwritten with now) — callers should
   *  not try to manage it themselves. To edit `description`/`selfReview`
   *  specifically, prefer `savePlaceDraft` + `commitPlaceDraft` below, which
   *  add append-both conflict detection; this action is for the other
   *  (non-prose) fields, e.g. name/category/position. */
  updatePlace: (place: Place) => Promise<void>;
  removePlace: (id: ID) => Promise<void>;
  /** Assign (or clear, with undefined) a place's day; keeps status in sync.
   *  Writes straight through the repository -- used by auto-plan and any
   *  other direct caller. The Map's pin-detail day dropdown does NOT call
   *  this directly; it calls `stagePlaceAssignment` below instead, which
   *  stages the edit locally and only reaches this write path in a batch,
   *  via `saveStagedAssignments`, once the user hits Save. */
  assignPlaceToDay: (placeId: ID, dayId: ID | undefined) => Promise<void>;

  // ---- Map: staged day-assignment edits ("Save changes" model) ----
  /**
   * Stage (or update) a day reassignment for a place -- called by the Map's
   * pin-detail day dropdown INSTEAD OF `assignPlaceToDay`. `dayId: undefined`
   * stages "unassign" (back to wishlist). If the staged value ends up equal
   * to the place's current SAVED `dayId`, the staged entry is removed
   * instead of written (typing back to the saved value leaves nothing to
   * commit for this place). Persists to the local staging table immediately
   * -- see `stagedAssignmentRepository.ts` -- so the change survives a
   * reload before Save is ever pressed. No-ops if `placeId` isn't a known
   * place.
   */
  stagePlaceAssignment: (placeId: ID, dayId: ID | undefined) => Promise<void>;
  /**
   * Discard every staged assignment scoped to ONE city; other cities' staged
   * assignments are untouched (Discard's scope is deliberately narrower than
   * Save's -- see `saveStagedAssignments`). No-ops if the city has nothing
   * staged.
   */
  discardStagedAssignmentsForCity: (city: string) => Promise<void>;
  /**
   * Batch-commit every staged assignment, across EVERY city, by calling
   * `assignPlaceToDay` (the existing write-through path -- remote-first; the
   * local Dexie cache is only mirrored after each remote write succeeds) for
   * each staged placeId/dayId pair, IN ORDER, stopping at the first failure.
   * Refuses to even attempt this while offline (`!navigator.onLine`) -- the
   * UI already disables the Save control offline, this is a defensive second
   * guard -- and throws in that case without touching staging.
   *
   * On full success, clears the staging table and in-memory state entirely.
   * On a failure partway through, staging is left reflecting REALITY, not
   * left unconditionally untouched: every entry that already committed
   * before the failure (real remote write + local mirror + in-memory
   * `places`/itinerary update -- cloud is source of truth, so that change is
   * real) is removed from staging, since there is nothing left to save for
   * it; the entry that failed and any not-yet-attempted entries stay staged.
   * The error is then rethrown so the UI can show its "still here, safe on
   * this device" message -- which is now actually true for whatever remains
   * staged. No-ops (resolves immediately) if nothing is staged.
   */
  saveStagedAssignments: () => Promise<void>;

  // ---- place prose drafts (description/selfReview) ----
  /** Read the local (never-synced) WIP draft for a place, if any — e.g. to
   *  prefill an edit form after a reload. `undefined` means no draft is
   *  pending; the caller should fall back to the place's own
   *  `description`/`selfReview`. */
  getPlaceDraft: (placeId: ID) => Promise<PlaceDraft | undefined>;
  /**
   * Persist WIP `description`/`selfReview` text for a place locally only
   * (never synced) — call on every edit (typically debounced) so a draft
   * survives a reload/offline with no network involved. The draft's
   * conflict-detection base (`baseUpdatedAt`) is established from the
   * place's current `updatedAt` the FIRST time a draft is started, and then
   * held fixed across subsequent `savePlaceDraft` calls for the same
   * editing session (until `commitPlaceDraft` or `discardPlaceDraft`) —
   * callers never need to manage it themselves.
   */
  savePlaceDraft: (
    placeId: ID,
    fields: { description?: string; selfReview?: string },
  ) => Promise<void>;
  /** Discard a local draft without committing it (e.g. a Cancel button). */
  discardPlaceDraft: (placeId: ID) => Promise<void>;
  /**
   * Commit a place's local draft (or, if there is none, whatever
   * `description`/`selfReview` the place currently has) through the
   * repository's `updatePlaceIfUnchanged`. If a concurrent edit from
   * another device is detected (the stored `updatedAt` has moved on from
   * the draft's base), this does NOT overwrite and does NOT surface a merge
   * UI — it appends the other device's current text below the local text
   * (see `useTripStore.ts` module comments for the exact algorithm) and
   * retries, bounded, until it succeeds. Clears the local draft on success.
   * Returns `merged: true` if a conflict was detected and auto-resolved
   * this way, so the caller can inform the user; rethrows (leaving the
   * draft intact) if the repository write itself fails, e.g. offline.
   */
  commitPlaceDraft: (placeId: ID) => Promise<{ place: Place; merged: boolean }>;

  // ---- itinerary ----
  addItineraryItem: (input: Omit<ItineraryItem, 'id' | 'order'> & Partial<Pick<ItineraryItem, 'order'>>) => Promise<ItineraryItem>;
  updateItineraryItem: (item: ItineraryItem) => Promise<void>;
  removeItineraryItem: (id: ID) => Promise<void>;
  /** Reorder a day's items to match the given id order. */
  reorderItinerary: (dayId: ID, orderedIds: ID[]) => Promise<void>;

  // ---- expenses ----
  /** `note`/`paidBy` flow through like every other `Expense` field — no
   *  special handling needed, they're just optional properties on the input. */
  addExpense: (input: Omit<Expense, 'id' | 'tripId'>) => Promise<Expense>;
  updateExpense: (expense: Expense) => Promise<void>;
  removeExpense: (id: ID) => Promise<void>;

  // ---- trip members (Phase 5) ----
  // Members are embedded on the Trip (`Trip.members`, like `cities`/`rates`),
  // not a separate table — so all three actions persist via `saveTrip`, the
  // same path `setHomeCurrency` already uses, rather than a new repository
  // method. Each is queued on its own `runMembersExclusive` (see below) so
  // two rapid calls (e.g. a double-click "Add") can't both read the same
  // stale `trip.members` and race-drop one another's write.
  /** Add a new member with a generated id; no-ops (throws) if there is no
   *  trip loaded yet, or if `name` is empty/whitespace-only after trimming. */
  addMember: (name: string) => Promise<TripMember>;
  /** Rename an existing member in place (same id). No-ops if the trip isn't
   *  loaded, `id` doesn't match any member, or the trimmed `name` is empty. */
  renameMember: (id: ID, name: string) => Promise<void>;
  /**
   * Remove a member. Deliberately ORPHAN-TOLERANT: this does NOT cascade-
   * delete or rewrite any `Expense` whose `paidBy` OR `coversMemberIds`
   * references `id` (Phase 6 adds the second reference site) — those
   * expenses are left exactly as they are, with a now-dangling reference
   * that no longer resolves to a member. Downstream renderers must treat
   * that as simply "unset"/"drop this id from the set" (e.g. show "—" for a
   * dangling `paidBy`, silently skip a dangling id in `coversMemberIds` when
   * rendering who an expense covers), never throw or crash on it. No-ops if
   * the trip isn't loaded or `id` doesn't match any member.
   */
  removeMember: (id: ID) => Promise<void>;
  /**
   * Set (or clear, with `undefined`) a member's avatar-ring/chip colour
   * (Phase 6, item 8) — one of the fixed `--m-*` swatch family names from
   * `mockup/DESIGN-SYSTEM.md`'s "Member colour palette" section, stored bare
   * (no leading `--`, e.g. `'m-denim'`) — see `TripMember.color`'s doc
   * comment in schema.ts. Same read-modify-write shape as `renameMember`,
   * queued on the same `runMembersExclusive` queue for the same reason (two
   * rapid picks can't race and drop one another's write). No-ops if the
   * trip isn't loaded or `id` doesn't match any member.
   */
  setMemberColor: (id: ID, color: string | undefined) => Promise<void>;

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

/** Converts a flat list of persisted staging rows into the in-memory
 *  `Record<placeId, ...>` shape `TripState.stagedAssignments` uses. */
function stagedAssignmentsToRecord(
  entries: StagedAssignment[],
): Record<ID, { dayId: ID | undefined; city: string }> {
  const record: Record<ID, { dayId: ID | undefined; city: string }> = {};
  for (const entry of entries) {
    record[entry.placeId] = { dayId: entry.dayId, city: entry.city };
  }
  return record;
}

/**
 * Builds the `stagedAssignments` field to include in an `init()` `set()`
 * call -- but only if nothing else changed staging while this read was in
 * flight. `versionAtRead` must be `stagedAssignmentsVersion`'s value
 * captured synchronously (no `await` in between) right before the
 * `stagedAssignmentRepository.listAll()` call this `entries` came from. If
 * the counter has since moved on (a `stagePlaceAssignment`/
 * `discardStagedAssignmentsForCity`/`saveStagedAssignments`/`importJson`
 * call completed in the meantime), this returns `{}` so the caller's `set()`
 * leaves `stagedAssignments` exactly as that more-recent action left it,
 * rather than clobbering it with this now-stale snapshot. See
 * `stagedAssignmentsVersion`'s module comment for the full race this guards
 * against.
 */
function stagedAssignmentsInitPatch(
  entries: StagedAssignment[],
  versionAtRead: number,
): Partial<Pick<TripState, 'stagedAssignments'>> {
  if (versionAtRead !== stagedAssignmentsVersion) return {};
  return { stagedAssignments: stagedAssignmentsToRecord(entries) };
}

/**
 * Builds the `places`/`days`/`itineraryByDay`/`expenses` fields to include
 * in an `init()` `set()` call -- but only if no place/itinerary/expense
 * write landed while this read was in flight. Exactly mirrors
 * `stagedAssignmentsInitPatch` above, guarding a DIFFERENT set of fields
 * against a DIFFERENT counter (`mutationVersion`) -- see its module comment
 * for the full race this closes (a background refresh's stale `listPlaces()`
 * etc. snapshot silently reverting a write, e.g. a `saveStagedAssignments()`
 * commit, that completed while that read was still in flight).
 * `versionAtRead` must be `mutationVersion`'s value captured synchronously
 * (no `await` in between) right before the `listPlaces`/`listDays`/
 * `listAllItinerary`/`listExpenses` calls this data came from. A mismatch
 * means a write landed in the meantime, so this returns `{}` and the
 * caller's `set()` leaves all four fields exactly as that more-recent write
 * left them -- a later `init()`/reload naturally re-reads current data, so
 * skipping this one stale refresh never leaves anything permanently behind.
 * `trip` is deliberately NOT one of these fields -- it isn't written by any
 * of the actions that bump `mutationVersion`, only by `setHomeCurrency`/
 * `refreshRates` (each already serialized by their own dedicated queue) and
 * the cache-first paint steps below, none of which race this same way.
 */
function domainDataInitPatch(
  data: { places: Place[]; days: Day[]; itinerary: ItineraryItem[]; expenses: Expense[] },
  versionAtRead: number,
): Partial<Pick<TripState, 'places' | 'days' | 'itineraryByDay' | 'expenses'>> {
  if (versionAtRead !== mutationVersion) return {};
  return {
    places: data.places,
    days: data.days,
    itineraryByDay: groupByDay(data.itinerary),
    expenses: data.expenses,
  };
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

// Dedicated queue for commitPlaceDraft(): serializes overlapping commits for
// the SAME place (e.g. a rapid double-click on "Save") so two calls can't
// both read "no conflict" and both write, silently dropping one's append-
// merge. Kept separate from `runExclusive` (itinerary-linking writes) since
// committing a place draft is unrelated and shouldn't queue behind (or
// block) assignPlaceToDay/applyAutoPlan calls for other places.
const runDraftExclusive = makeExclusiveQueue();

// Dedicated queue for saveStagedAssignments(): guards against a rapid
// double-click on "Save" starting two overlapping batch-commits (e.g. before
// the UI's own disabled-while-saving state has painted). Deliberately its
// OWN queue instance, never `runExclusive` -- saveStagedAssignments' body
// itself calls `assignPlaceToDay`, which queues on `runExclusive` internally;
// if saveStagedAssignments queued on that SAME instance, its own call would
// be waiting on `queue` while `queue` was simultaneously waiting on it to
// finish -- a self-deadlock. Two independent queue instances nest safely.
const runSaveExclusive = makeExclusiveQueue();

// Dedicated queue for addMember/renameMember/removeMember: each of these is a
// read-`trip`-then-`saveTrip` sequence (same shape as setHomeCurrency, which
// has no such guard today — but member CRUD is driven by a management UI
// where a rapid double-click on "Add"/"Remove" is plausible in a way a
// currency switch isn't). Without this, two overlapping calls could both
// read the same stale `trip.members` and the second write would silently
// clobber the first's. Its own queue instance — unrelated to, and must not
// nest inside, `runExclusive`/`runSaveExclusive`.
const runMembersExclusive = makeExclusiveQueue();

/** True when the browser (or a test) reports no network connectivity.
 *  Mirrors `syncedTripRepository.ts`'s private `isOffline()` -- kept as its
 *  own copy here rather than exported/shared, since the two call sites have
 *  no other coupling and this is a one-line check. */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Bounds `commitPlaceDraft`'s conflict-retry loop. A real repeated race
 *  this deep is not expected in a two-device household app — this exists to
 *  fail loudly rather than spin forever if something is pathologically
 *  wrong. */
const MAX_DRAFT_COMMIT_ATTEMPTS = 5;

// Guards against an outdated `init()` call's background refresh clobbering a
// newer one's result (or the freshly-reset post-sign-out state) — e.g. React
// StrictMode's dev-mode double-invoke, or a sign-out/sign-in happening while
// a previous call's refresh is still in flight. Every `init()` call captures
// the token at its start and re-checks it before each `set()`; a call whose
// token no longer matches the current one silently no-ops instead of writing
// stale data over whatever a later call (or `resetTripStoreForSignOut`) has
// since established.
let initToken = 0;

// Guards against a DIFFERENT race than `initToken`: `initToken` protects an
// outdated `init()` call's background refresh from clobbering a NEWER
// `init()` call's result. This counter protects `stagedAssignments`
// specifically from an `init()` call's background refresh clobbering a
// STAGING-side action (`stagePlaceAssignment`/`discardStagedAssignmentsForCity`/
// `saveStagedAssignments`/`importJson`) that committed WHILE that refresh's
// own `stagedAssignmentRepository.listAll()` read was still in flight --
// e.g. the user hits Save (which clears staging) a moment after `init()`
// already started re-reading the (soon to be stale) staged rows; without
// this guard, `init()`'s Promise.all would still resolve with the
// pre-Save snapshot and resurrect the just-cleared entries in memory (the
// Dexie table itself stays correct either way, so this is a display-only
// hazard, but a real one). Bumped by every one of those staging actions
// immediately alongside their own `set({ stagedAssignments: ... })`; `init()`
// snapshots this counter right before kicking off its staged-assignments
// read and re-checks it right before applying that read's result -- a
// mismatch means someone else changed staging in the meantime, so `init()`
// leaves that field alone (every OTHER field it refreshes is unaffected).
let stagedAssignmentsVersion = 0;

// Guards a THIRD race, in the same family as the two above but against the
// DOMAIN-DATA fields `init()`'s background refresh also touches --
// `places`/`days`/`itineraryByDay`/`expenses`. Those four are read by the
// exact same `Promise.all` as the staged-assignments read, but (unlike
// `stagedAssignments`) had no equivalent guard: a write that lands (e.g. a
// `saveStagedAssignments()` commit, or any other place/itinerary/expense
// write) WHILE that refresh's own `listPlaces()`/`listDays()`/
// `listAllItinerary()`/`listExpenses()` reads were still in flight would get
// silently reverted in memory the moment that now-stale snapshot resolved
// and its `set()` ran -- the remote/Dexie data stays correct either way (so
// this was never data loss, and a later `init()`/reload self-heals it), but
// a save visibly "undoing itself" on screen directly undercuts the trust the
// whole staged-Save feature depends on. Bumped by every store action that
// writes one of those four tables: addPlace/updatePlace/removePlace/
// assignPlaceToDay/commitPlaceDraft/applyAutoPlan (places);
// addItineraryItem/updateItineraryItem/removeItineraryItem/reorderItinerary
// (itineraryByDay); addExpense/updateExpense/removeExpense (expenses); and
// importSnapshot's whole-trip replace. `init()` snapshots this counter right
// before dispatching those four reads and re-checks it right before applying
// them via `domainDataInitPatch` below -- a mismatch means one of those
// actions completed in the meantime, so `init()` leaves all four fields
// alone (every OTHER field -- `trip`, `loading`, `syncing`, `stagedAssignments`
// -- is refreshed independently and unaffected by this guard).
let mutationVersion = 0;

/** Call on sign-out: invalidates any in-flight `init()`/background refresh
 *  (so it can never repaint this account's data after the user has left) and
 *  clears in-memory state back to its pre-load shape. Pair with pointing
 *  `tripRepositoryInstance` back at a fresh `DexieTripRepository` and with
 *  `clearLocalCache()` — this function only resets the Zustand store. */
export function resetTripStoreForSignOut(): void {
  initToken++;
  stagedAssignmentsVersion++;
  mutationVersion++;
  useTripStore.setState({
    trip: undefined,
    places: [],
    days: [],
    itineraryByDay: {},
    expenses: [],
    loading: true,
    syncing: false,
    syncError: undefined,
    stagedAssignments: {},
  });
}

// ---------------------------------------------------------------------------
// Plain exported selector helpers for the Map "Save changes" staging model.
// Deliberately NOT derived/stored state on TripState itself -- these are
// cheap, pure lookups over `stagedAssignments`, so components (and future
// selectors) can call them directly against whatever slice of the store they
// already have, without the store needing to keep a second, denormalized
// copy in sync.
// ---------------------------------------------------------------------------

/** Effective (about-to-be-shown) dayId for a place: the staged value if one
 *  is pending, otherwise the place's own saved `dayId`. Lets the Map render
 *  a pin at its staged day/colour immediately, without waiting for Save. */
export function getEffectiveDayId(
  place: Place,
  stagedAssignments: TripState['stagedAssignments'],
): ID | undefined {
  const staged = stagedAssignments[place.id];
  return staged ? staged.dayId : place.dayId;
}

/** Total number of staged (unsaved) day assignments across every city. */
export function getStagedAssignmentCount(
  stagedAssignments: TripState['stagedAssignments'],
): number {
  return Object.keys(stagedAssignments).length;
}

/** Number of staged (unsaved) day assignments scoped to one city. */
export function getStagedAssignmentCountForCity(
  stagedAssignments: TripState['stagedAssignments'],
  city: string,
): number {
  let count = 0;
  for (const entry of Object.values(stagedAssignments)) {
    if (entry.city === city) count++;
  }
  return count;
}

/** Staged (unsaved) counts broken down per city -- e.g. to badge every
 *  route-strip node with a pending dot, or drive the Save bar's "+N more in
 *  <city>" hint line. */
export function getStagedAssignmentCountsByCity(
  stagedAssignments: TripState['stagedAssignments'],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of Object.values(stagedAssignments)) {
    counts[entry.city] = (counts[entry.city] ?? 0) + 1;
  }
  return counts;
}

export const useTripStore = create<TripState>((set, get) => ({
  trip: undefined,
  places: [],
  days: [],
  itineraryByDay: {},
  expenses: [],
  loading: true,
  syncing: false,
  syncError: undefined,
  ratesLoading: false,
  ratesError: undefined,
  stagedAssignments: {},

  init: async () => {
    const token = ++initToken;

    // Unauthenticated / plain-offline mode: the currently-active repository
    // IS the local Dexie store already (no network involved at all), so a
    // separate cache-first probe read would just be a redundant second touch
    // of the exact same local table for zero benefit — skip straight to the
    // single read/seed sequence this always used, unchanged. (This also
    // sidesteps a real Dexie/fake-indexeddb footgun: issuing two back-to-back
    // reads against the same connection immediately after a fresh
    // open/upgrade can race Dexie's internal reopen bookkeeping. The staged-
    // assignments read below is deliberately folded into the SAME
    // `Promise.all` as the other post-seed reads rather than issued as an
    // earlier, separate read, for exactly this reason — it hit this exact
    // footgun during development, see git history if this comment outlives
    // the fix.) `syncing` never toggles in this mode — there's nothing being
    // synced from a remote, so the topbar pill has nothing to report.
    if (getActiveRepository() instanceof DexieTripRepository) {
      if (token !== initToken) return;
      set({ loading: true });
      await tripRepository.seedIfEmpty();
      const trip = await tripRepository.getTrip();
      const tripId = trip?.id ?? ACTIVE_TRIP_ID;
      const stagedVersionAtRead = stagedAssignmentsVersion;
      const mutationVersionAtRead = mutationVersion;
      const [places, days, itinerary, expenses, stagedEntries] = await Promise.all([
        tripRepository.listPlaces(tripId),
        tripRepository.listDays(tripId),
        tripRepository.listAllItinerary(tripId),
        tripRepository.listExpenses(tripId),
        stagedAssignmentRepository.listAll(),
      ]);
      if (token !== initToken) return;
      set({
        trip,
        loading: false,
        ...domainDataInitPatch({ places, days, itinerary, expenses }, mutationVersionAtRead),
        ...stagedAssignmentsInitPatch(stagedEntries, stagedVersionAtRead),
      });
      return;
    }

    // Signed in (a remote-backed `SyncedTripRepository` is active): cache-
    // first, stale-while-revalidate load.
    //
    // Step 1: paint straight from a dedicated local Dexie repository
    // instance, bypassing the active (network-capable) repository entirely,
    // so this never waits on Supabase.
    const local = new DexieTripRepository();
    let localTrip: Trip | undefined;
    try {
      localTrip = await local.getTrip();
    } catch {
      localTrip = undefined;
    }

    if (localTrip) {
      const tripId = localTrip.id;
      const stagedVersionAtRead = stagedAssignmentsVersion;
      const mutationVersionAtRead = mutationVersion;
      const [places, days, itinerary, expenses, stagedEntries] = await Promise.all([
        local.listPlaces(tripId),
        local.listDays(tripId),
        local.listAllItinerary(tripId),
        local.listExpenses(tripId),
        stagedAssignmentRepository.listAll(),
      ]);
      if (token !== initToken) return;
      set({
        trip: localTrip,
        loading: false,
        ...domainDataInitPatch({ places, days, itinerary, expenses }, mutationVersionAtRead),
        ...stagedAssignmentsInitPatch(stagedEntries, stagedVersionAtRead),
      });
    } else if (token === initToken) {
      // Genuinely nothing cached on this device yet — the background step
      // below is this trip's first-ever paint, so `loading` stays true
      // (the UI's blocking cold-start state) until it settles. Guarded too:
      // an outdated call finding no local trip must not flip `loading` back
      // to true after a newer call (or a sign-out reset) already resolved it.
      set({ loading: true });
    }

    // Step 2: reconcile against the currently-active (Supabase-backed)
    // repository in the background. Not awaited when a cached trip already
    // painted above, so a warm start never re-blocks on the network; awaited
    // below only for the genuine cold-start case, since there's nothing else
    // to show yet. Every `set()` here is guarded by the token captured at the
    // top of this call, so an outdated call (superseded by a newer `init()`
    // or by `resetTripStoreForSignOut()` bumping the token on sign-out) can
    // never overwrite newer state. Staged assignments are ALWAYS read from
    // the local `stagedAssignmentRepository` (never remote — see its module
    // comment); `stagedAssignmentsInitPatch` below guards this specific field
    // against a DIFFERENT race than `initToken` covers -- see
    // `stagedAssignmentsVersion`'s module comment. `domainDataInitPatch`
    // guards `places`/`days`/`itineraryByDay`/`expenses` the exact same way,
    // against its own `mutationVersion` counter -- this is the step where
    // that race is most likely to actually bite in practice (a real network
    // round-trip, not just a few IndexedDB reads, so the window for a write
    // like `saveStagedAssignments()` to land while this is in flight is far
    // wider here than in the cache-first steps above).
    if (token === initToken) set({ syncing: true, syncError: undefined });
    const refresh = (async () => {
      try {
        await tripRepository.seedIfEmpty();
        const trip = await tripRepository.getTrip();
        const tripId = trip?.id ?? ACTIVE_TRIP_ID;
        const stagedVersionAtRead = stagedAssignmentsVersion;
        const mutationVersionAtRead = mutationVersion;
        const [places, days, itinerary, expenses, stagedEntries] = await Promise.all([
          tripRepository.listPlaces(tripId),
          tripRepository.listDays(tripId),
          tripRepository.listAllItinerary(tripId),
          tripRepository.listExpenses(tripId),
          stagedAssignmentRepository.listAll(),
        ]);
        if (token !== initToken) return;
        set({
          trip,
          loading: false,
          syncing: false,
          ...domainDataInitPatch({ places, days, itinerary, expenses }, mutationVersionAtRead),
          ...stagedAssignmentsInitPatch(stagedEntries, stagedVersionAtRead),
        });
      } catch (err) {
        if (token !== initToken) return;
        const message = err instanceof Error ? err.message : 'Failed to sync trip data';
        // Still unblock a genuine cold start even on failure — there's
        // nothing more to wait for, and staying in `loading` forever would
        // be worse than showing whatever we have (possibly nothing).
        set({ loading: false, syncing: false, syncError: message });
      }
    })();

    if (!localTrip) {
      await refresh;
    }
  },

  addPlace: async (input) => {
    const trip = get().trip;
    const place: Place = {
      id: newId('place'),
      tripId: trip?.id ?? ACTIVE_TRIP_ID,
      status: input.status ?? 'wishlist',
      ...input,
      updatedAt: new Date().toISOString(),
    };
    await tripRepository.upsertPlace(place);
    mutationVersion++;
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
    const updated: Place = { ...place, updatedAt: new Date().toISOString() };
    await tripRepository.upsertPlace(updated);
    mutationVersion++;
    set((s) => ({ places: s.places.map((p) => (p.id === updated.id ? updated : p)) }));
  },

  // Also strips any itinerary item(s) linked to this place (item.placeId ===
  // id) from every day — otherwise a deleted place leaves a dangling stop
  // that still renders in the Itinerary tab / Map day-view. Also clears any
  // local (never-synced) prose draft for this place — deliberately
  // unconditional, not left to callers, so this guarantee lives here rather
  // than depending on every future call site remembering to pair a delete
  // with `discardPlaceDraft` first (a place deleted before a caller's own
  // draft check has even resolved would otherwise orphan a row in
  // db.placeDrafts forever, since nothing else reconciles drafts against
  // live places).
  removePlace: async (id) => {
    await tripRepository.deletePlace(id);
    const orphanedItemIds = Object.values(get().itineraryByDay)
      .flat()
      .filter((i) => i.placeId === id)
      .map((i) => i.id);
    await Promise.all([
      ...orphanedItemIds.map((itemId) => tripRepository.deleteItineraryItem(itemId)),
      draftRepository.deleteDraft(id),
    ]);
    mutationVersion++;
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

      if (oldDayId === dayId) {
        // No actual day change (incl. undefined -> undefined): nothing to
        // write or link/unlink. Checked BEFORE the write below (not after)
        // so a no-op re-assignment (e.g. a retry, or re-applying the same
        // staged batch entry twice) never bumps `updatedAt` for nothing --
        // that write would be silently discarded here anyway, but it could
        // still spuriously trip `updatePlaceIfUnchanged`'s conflict
        // detection for an unrelated, genuinely in-flight prose draft on
        // this same place.
        return;
      }

      const updated: Place = {
        ...existing,
        dayId,
        status: dayId ? 'planned' : 'wishlist',
        updatedAt: new Date().toISOString(),
      };
      await tripRepository.upsertPlace(updated);
      mutationVersion++;
      set((s) => ({
        places: s.places.map((p) => (p.id === placeId ? updated : p)),
      }));

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

  stagePlaceAssignment: async (placeId, dayId) => {
    const place = get().places.find((p) => p.id === placeId);
    if (!place) return;

    if (dayId === place.dayId) {
      // Typing back to the currently-saved value -- nothing left to commit
      // for this place. Only actually remove/bump if a staged row existed at
      // all -- otherwise this is a genuine no-op (nothing changed, so no
      // staging-version bump either; see `stagedAssignmentsVersion`).
      if (!(placeId in get().stagedAssignments)) return;
      await stagedAssignmentRepository.remove(placeId);
      stagedAssignmentsVersion++;
      set((s) => {
        const next = { ...s.stagedAssignments };
        delete next[placeId];
        return { stagedAssignments: next };
      });
      return;
    }

    await stagedAssignmentRepository.upsert({
      placeId,
      dayId,
      city: place.city,
      stagedAt: new Date().toISOString(),
    });
    stagedAssignmentsVersion++;
    set((s) => ({
      stagedAssignments: { ...s.stagedAssignments, [placeId]: { dayId, city: place.city } },
    }));
  },

  discardStagedAssignmentsForCity: async (city) => {
    const idsToRemove = Object.entries(get().stagedAssignments)
      .filter(([, entry]) => entry.city === city)
      .map(([placeId]) => placeId);
    if (idsToRemove.length === 0) return;

    await stagedAssignmentRepository.removeForCity(city);
    stagedAssignmentsVersion++;
    set((s) => {
      const next = { ...s.stagedAssignments };
      for (const placeId of idsToRemove) delete next[placeId];
      return { stagedAssignments: next };
    });
  },

  // NOT wrapped in `runExclusive` -- see the `runSaveExclusive` comment
  // above for why nesting it on that same queue would deadlock (this body
  // itself calls `assignPlaceToDay`, which queues on `runExclusive`
  // internally). `runSaveExclusive` is a separate instance, so it nests
  // safely and only serializes overlapping *saves* against each other.
  //
  // Commits SEQUENTIALLY, in staged order, stopping at the first failure --
  // deliberately not `Promise.allSettled` over every entry. Cloud is the
  // source of truth (see CLAUDE.md's write-through model): once
  // `assignPlaceToDay` resolves for an entry, that change is REAL --
  // written remotely and mirrored locally -- and staging must stop
  // representing it as "pending" immediately, in the same pass, not just on
  // a subsequent full-batch success. Running every entry independently
  // (the previous approach) let entries AFTER a failing one keep committing
  // for real while the whole batch still got reported+left staged as one
  // undifferentiated failure -- which both mis-informs the "still here, safe
  // on this device" error (untrue for the ones that landed) and makes
  // Discard silently wrong (it would only touch the local overlay, leaving
  // an already-remote-committed change with no way to revert it). Stopping
  // at the first failure also avoids firing more remote writes once we
  // already know we're in a failing state (e.g. offline mid-batch).
  saveStagedAssignments: () =>
    runSaveExclusive(async () => {
      if (isOffline()) {
        throw new Error('You’re offline — reconnect to save changes.');
      }

      const entries = Object.entries(get().stagedAssignments);
      if (entries.length === 0) return;

      const committedPlaceIds: ID[] = [];
      try {
        for (const [placeId, { dayId }] of entries) {
          await get().assignPlaceToDay(placeId, dayId);
          committedPlaceIds.push(placeId);
        }
      } catch (err) {
        // Staging must end up matching reality: drop exactly the entries
        // that demonstrably committed before the failure (there's nothing
        // left to save for them) and leave the failed + not-yet-attempted
        // entries staged, so a retry (or Discard) acts on a staging table
        // that's actually still true.
        if (committedPlaceIds.length > 0) {
          await stagedAssignmentRepository.removeMany(committedPlaceIds);
          stagedAssignmentsVersion++;
          set((s) => {
            const next = { ...s.stagedAssignments };
            for (const placeId of committedPlaceIds) delete next[placeId];
            return { stagedAssignments: next };
          });
        }
        const message = err instanceof Error ? err.message : 'Failed to save changes';
        throw new Error(message);
      }

      // Every staged assignment committed successfully -- clear the staging
      // table and in-memory state together.
      await stagedAssignmentRepository.clearAll();
      stagedAssignmentsVersion++;
      set({ stagedAssignments: {} });
    }),

  getPlaceDraft: (placeId) => draftRepository.getDraft(placeId),

  savePlaceDraft: async (placeId, fields) => {
    const existingDraft = await draftRepository.getDraft(placeId);
    const place = get().places.find((p) => p.id === placeId);
    // The base is established once (on the first save of a new editing
    // session) and then held fixed across further keystrokes/debounced
    // saves for the same draft, so `commitPlaceDraft` always compares
    // against "what the place looked like when editing began," not
    // "whatever it looked like a moment ago."
    const baseUpdatedAt = existingDraft?.baseUpdatedAt ?? place?.updatedAt ?? new Date(0).toISOString();
    await draftRepository.saveDraft({
      placeId,
      description: fields.description,
      selfReview: fields.selfReview,
      baseUpdatedAt,
      savedAt: new Date().toISOString(),
    });
  },

  discardPlaceDraft: async (placeId) => {
    await draftRepository.deleteDraft(placeId);
  },

  commitPlaceDraft: (placeId) =>
    runDraftExclusive(async () => {
      const place = get().places.find((p) => p.id === placeId);
      if (!place) {
        throw new Error(`commitPlaceDraft: no place with id ${placeId}`);
      }
      const draft = await draftRepository.getDraft(placeId);

      let description = draft?.description ?? place.description;
      let selfReview = draft?.selfReview ?? place.selfReview;
      let baseUpdatedAt = draft?.baseUpdatedAt ?? place.updatedAt;
      let merged = false;
      let result: { place: Place; conflict: boolean };
      let attempts = 0;

      do {
        attempts++;
        const candidate: Place = {
          ...place,
          description,
          selfReview,
          updatedAt: new Date().toISOString(),
        };
        result = await tripRepository.updatePlaceIfUnchanged(candidate, baseUpdatedAt);
        if (result.conflict) {
          merged = true;
          const remote = result.place;
          description = appendRemoteIfDifferent(description, remote.description);
          selfReview = appendRemoteIfDifferent(selfReview, remote.selfReview);
          baseUpdatedAt = remote.updatedAt;
        }
      } while (result.conflict && attempts < MAX_DRAFT_COMMIT_ATTEMPTS);

      if (result.conflict) {
        // Pathological: kept losing the race MAX_DRAFT_COMMIT_ATTEMPTS times
        // in a row. Leave the local draft intact (nothing was written) so
        // the user's text isn't lost — they can just retry the save.
        throw new Error(
          'commitPlaceDraft: too many concurrent edits from another device — please try saving again',
        );
      }

      mutationVersion++;
      set((s) => ({ places: s.places.map((p) => (p.id === placeId ? result.place : p)) }));
      await draftRepository.deleteDraft(placeId);
      return { place: result.place, merged };
    }),

  addItineraryItem: async (input) => {
    const existing = get().itineraryByDay[input.dayId] ?? [];
    const order = input.order ?? existing.length;
    const item: ItineraryItem = { id: newId('item'), order, ...input };
    await tripRepository.upsertItineraryItem(item);
    mutationVersion++;
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
    mutationVersion++;
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
    mutationVersion++;
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
    mutationVersion++;
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
    mutationVersion++;
    set((s) => ({ expenses: [...s.expenses, expense] }));
    return expense;
  },

  updateExpense: async (expense) => {
    await tripRepository.upsertExpense(expense);
    mutationVersion++;
    set((s) => ({ expenses: s.expenses.map((e) => (e.id === expense.id ? expense : e)) }));
  },

  removeExpense: async (id) => {
    await tripRepository.deleteExpense(id);
    mutationVersion++;
    set((s) => ({ expenses: s.expenses.filter((e) => e.id !== id) }));
  },

  addMember: (name) =>
    runMembersExclusive(async () => {
      const trip = get().trip;
      if (!trip) throw new Error('addMember: no trip loaded yet');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('addMember: name must not be empty');
      const member: TripMember = { id: newId('member'), name: trimmed };
      const updated: Trip = { ...trip, members: [...(trip.members ?? []), member] };
      await tripRepository.saveTrip(updated);
      set({ trip: updated });
      return member;
    }),

  renameMember: (id, name) =>
    runMembersExclusive(async () => {
      const trip = get().trip;
      if (!trip) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      if (!(trip.members ?? []).some((m) => m.id === id)) return;
      const members = (trip.members ?? []).map((m) => (m.id === id ? { ...m, name: trimmed } : m));
      const updated: Trip = { ...trip, members };
      await tripRepository.saveTrip(updated);
      set({ trip: updated });
    }),

  // Orphan-tolerant by design (see the TripState doc comment above): expenses
  // referencing this member's id (via `paidBy` OR, since Phase 6,
  // `coversMemberIds`) are deliberately left untouched — a dangling
  // reference renders as unset/skipped downstream, never cascade-deleted or
  // rewritten here.
  removeMember: (id) =>
    runMembersExclusive(async () => {
      const trip = get().trip;
      if (!trip) return;
      if (!(trip.members ?? []).some((m) => m.id === id)) return;
      const members = (trip.members ?? []).filter((m) => m.id !== id);
      const updated: Trip = { ...trip, members };
      await tripRepository.saveTrip(updated);
      set({ trip: updated });
    }),

  setMemberColor: (id, color) =>
    runMembersExclusive(async () => {
      const trip = get().trip;
      if (!trip) return;
      if (!(trip.members ?? []).some((m) => m.id === id)) return;
      const members = (trip.members ?? []).map((m) => (m.id === id ? { ...m, color } : m));
      const updated: Trip = { ...trip, members };
      await tripRepository.saveTrip(updated);
      set({ trip: updated });
    }),

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
          const updatedPlace: Place = {
            ...place,
            dayId: dayPlan.dayId,
            status: 'planned',
            updatedAt: new Date().toISOString(),
          };
          await tripRepository.upsertPlace(updatedPlace);
          mutationVersion++;
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
    // Local drafts are keyed by place id from the PREVIOUS data; a whole-trip
    // replace can reuse/reassign those ids to entirely different places, so
    // any pending draft text is no longer meaningfully associated with
    // anything and must not silently resurface against an unrelated place.
    // Staged Map day-assignments have the exact same problem (staged rows
    // are keyed by the old placeId too) and get the same treatment.
    await Promise.all([draftRepository.clearAll(), stagedAssignmentRepository.clearAll()]);
    stagedAssignmentsVersion++;
    mutationVersion++;
    set({
      trip: snapshot.trip,
      places: snapshot.places,
      days: snapshot.days,
      itineraryByDay: groupByDay(snapshot.itinerary),
      expenses: snapshot.expenses,
      loading: false,
      stagedAssignments: {},
    });
  },
}));
