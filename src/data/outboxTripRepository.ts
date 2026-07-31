// ============================================================================
// Offline-write layer: wraps a network-capable TripRepository so a mutation
// made with no usable connection succeeds LOCALLY and is queued for later
// upload, instead of failing in the user's face.
//
// Composition (see AuthGate.tsx):
//
//   OutboxTripRepository( SyncedTripRepository( Supabase, Dexie ), Dexie )
//
// This deliberately inverts the invariant `syncedTripRepository.ts` was built
// on ("the cache is only written after the remote succeeds -- no silent
// divergence"). Divergence is now allowed, on purpose, because the trip this
// app exists for is spent somewhere Supabase is unreachable for a day at a
// time. What makes it not-silent is the pending count in the topbar and the
// fact that nothing uploads without the user tapping Upload -- see
// `useTripStore.syncOutbox` and App.tsx.
//
// `TripRepository` itself is unchanged; this is exactly the swap the seam
// exists for.
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
import { hasPendingWrites, outboxRepository } from './outboxRepository';

/**
 * Is this failure "the network couldn't take it" (queue it) or "the server
 * refused it" (surface it)?
 *
 * DEFAULT IS FALSE -- anything unrecognised is rethrown. An RLS denial, an
 * expired session or a constraint violation queued as if it were a dropped
 * connection would be retried forever against a server that will never accept
 * it, while the UI reported success. That is the one way this feature can
 * silently eat data, so the classification only ever opts IN to queueing on a
 * recognised connectivity signal.
 *
 * Signals, in order of reliability:
 *  - `navigator.onLine === false` -- the browser is certain there's no link.
 *  - a `TypeError` -- what `fetch` throws when the request never completed.
 *    supabase-js surfaces this both raw and wrapped depending on the call.
 *  - a message matching a known transport failure. Chrome says "Failed to
 *    fetch", Safari "Load failed", Firefox "NetworkError when attempting to
 *    fetch resource" -- all three appear on a phone that lost signal
 *    mid-request, which is the exact case this exists for.
 */
export function isConnectivityFailure(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (err instanceof TypeError) return true;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : '';
  return /failed to fetch|load failed|networkerror|network request failed|err_internet_disconnected|the internet connection appears to be offline/i.test(
    message,
  );
}

export class OutboxTripRepository implements TripRepository {
  private readonly inner: TripRepository;
  private readonly cache: TripRepository;

  constructor(inner: TripRepository, cache: TripRepository) {
    this.inner = inner;
    this.cache = cache;
  }

  /**
   * The write-through repository underneath, for replaying the queue against.
   *
   * Replay MUST NOT go back through this wrapper: a failure would be caught
   * by `writeOrQueue` and re-queued, so a drain against a still-dead network
   * would look like it succeeded while quietly rewriting the same queue
   * forever. `useTripStore.syncOutbox` uses this instead.
   */
  get replayTarget(): TripRepository {
    return this.inner;
  }

  /**
   * Run a write against the remote; on a connectivity failure, apply it to
   * the local cache and queue it instead. `mirror` performs the local half --
   * it must leave the cache in exactly the state a successful remote write
   * would have, because that cache is what the whole app reads from until the
   * queue drains.
   */
  private async writeOrQueue<T>(
    entry: Parameters<typeof outboxRepository.append>[0],
    attempt: () => Promise<T>,
    mirror: () => Promise<T>,
  ): Promise<T> {
    try {
      return await attempt();
    } catch (err) {
      if (!isConnectivityFailure(err)) throw err;
      const result = await mirror();
      await outboxRepository.append(entry);
      return result;
    }
  }

  /**
   * Reads bypass the remote entirely while anything is queued.
   *
   * Not an optimisation -- a correctness requirement. The remote is missing
   * every queued change, so a read that reached it would return data OLDER
   * than what's on screen and hand it to the store to paint, reverting the
   * user's own offline edits in front of them. The queue is drained first,
   * then reads go back to normal (`useTripStore.syncOutbox` re-runs `init`).
   */
  private async readLocalIfPending<T>(local: () => Promise<T>, remote: () => Promise<T>): Promise<T> {
    return (await hasPendingWrites()) ? local() : remote();
  }

  async seedIfEmpty(): Promise<void> {
    await this.inner.seedIfEmpty();
  }

  // ---- Trip ----

  async getTrip(): Promise<Trip | undefined> {
    return this.readLocalIfPending(
      () => this.cache.getTrip(),
      () => this.inner.getTrip(),
    );
  }

  async saveTrip(trip: Trip): Promise<void> {
    await this.writeOrQueue(
      { entity: 'trip', op: 'upsert', recordId: trip.id, payload: trip, queuedAt: nowISO() },
      () => this.inner.saveTrip(trip),
      () => this.cache.saveTrip(trip),
    );
  }

  // ---- Places ----

  async listPlaces(tripId: ID): Promise<Place[]> {
    return this.readLocalIfPending(
      () => this.cache.listPlaces(tripId),
      () => this.inner.listPlaces(tripId),
    );
  }

  async upsertPlace(place: Place): Promise<Place> {
    return this.writeOrQueue(
      { entity: 'place', op: 'upsert', recordId: place.id, payload: place, queuedAt: nowISO() },
      () => this.inner.upsertPlace(place),
      () => this.cache.upsertPlace(place),
    );
  }

  async deletePlace(id: ID): Promise<void> {
    await this.writeOrQueue(
      { entity: 'place', op: 'delete', recordId: id, queuedAt: nowISO() },
      () => this.inner.deletePlace(id),
      () => this.cache.deletePlace(id),
    );
  }

  /**
   * Never queued. This is a CONDITIONAL write whose entire purpose is to
   * detect whether the remote row changed since `baseUpdatedAt` -- replaying
   * it hours later would be comparing against a version that is by then
   * ancient, so it would either spuriously conflict or blindly clobber, and
   * neither is what the caller asked for.
   *
   * Failing offline is already handled well upstream: `commitPlaceDraft`
   * leaves the prose in `draftRepository`, which exists precisely so in-
   * progress text survives without a network. So the user keeps their
   * writing; it just stays a draft until they're back online.
   */
  async updatePlaceIfUnchanged(
    place: Place,
    baseUpdatedAt: string,
  ): Promise<{ place: Place; conflict: boolean }> {
    return this.inner.updatePlaceIfUnchanged(place, baseUpdatedAt);
  }

  // ---- Days ----

  async listDays(tripId: ID): Promise<Day[]> {
    return this.readLocalIfPending(
      () => this.cache.listDays(tripId),
      () => this.inner.listDays(tripId),
    );
  }

  // ---- Itinerary ----

  async listItinerary(dayId: ID): Promise<ItineraryItem[]> {
    return this.readLocalIfPending(
      () => this.cache.listItinerary(dayId),
      () => this.inner.listItinerary(dayId),
    );
  }

  async listAllItinerary(tripId: ID): Promise<ItineraryItem[]> {
    return this.readLocalIfPending(
      () => this.cache.listAllItinerary(tripId),
      () => this.inner.listAllItinerary(tripId),
    );
  }

  async upsertItineraryItem(item: ItineraryItem): Promise<ItineraryItem> {
    return this.writeOrQueue(
      { entity: 'itinerary', op: 'upsert', recordId: item.id, payload: item, queuedAt: nowISO() },
      () => this.inner.upsertItineraryItem(item),
      () => this.cache.upsertItineraryItem(item),
    );
  }

  async deleteItineraryItem(id: ID): Promise<void> {
    await this.writeOrQueue(
      { entity: 'itinerary', op: 'delete', recordId: id, queuedAt: nowISO() },
      () => this.inner.deleteItineraryItem(id),
      () => this.cache.deleteItineraryItem(id),
    );
  }

  // ---- Expenses ----

  async listExpenses(tripId: ID): Promise<Expense[]> {
    return this.readLocalIfPending(
      () => this.cache.listExpenses(tripId),
      () => this.inner.listExpenses(tripId),
    );
  }

  async upsertExpense(expense: Expense): Promise<Expense> {
    return this.writeOrQueue(
      { entity: 'expense', op: 'upsert', recordId: expense.id, payload: expense, queuedAt: nowISO() },
      () => this.inner.upsertExpense(expense),
      () => this.cache.upsertExpense(expense),
    );
  }

  async deleteExpense(id: ID): Promise<void> {
    await this.writeOrQueue(
      { entity: 'expense', op: 'delete', recordId: id, queuedAt: nowISO() },
      () => this.inner.deleteExpense(id),
      () => this.cache.deleteExpense(id),
    );
  }

  // ---- Whole-trip import/export ----

  async exportSnapshot(): Promise<TripSnapshot> {
    return this.inner.exportSnapshot();
  }

  /**
   * Never queued, and deliberately allowed to fail offline. This is a
   * destructive whole-trip REPLACE (the `import_trip_snapshot` RPC deletes
   * every row before re-inserting). Queued, it would sit for a day and then
   * wipe out everything a collaborator did in the meantime, with the user
   * having long forgotten they pressed it. It is also the one operation whose
   * queued record ids may not survive: an import invalidates every id already
   * sitting in the outbox, which is why a successful import clears the queue.
   */
  async importSnapshot(snapshot: TripSnapshot): Promise<void> {
    await this.inner.importSnapshot(snapshot);
    await this.cache.importSnapshot(snapshot);
    await outboxRepository.clearAll();
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Send one queued write to `target`. Every branch is idempotent by record id
 * (upserts overwrite, deletes of an already-deleted row are a no-op), which
 * is what makes a partially-completed drain safe to simply re-run.
 *
 * Deletes carry no payload, so nothing here needs the original record.
 */
export async function applyOutboxEntry(
  target: TripRepository,
  entry: { entity: string; op: string; recordId: ID; payload?: unknown },
): Promise<void> {
  if (entry.op === 'delete') {
    switch (entry.entity) {
      case 'place':
        return target.deletePlace(entry.recordId);
      case 'itinerary':
        return target.deleteItineraryItem(entry.recordId);
      case 'expense':
        return target.deleteExpense(entry.recordId);
      // A trip is never deleted by this app — there is exactly one, and
      // `TripRepository` exposes no way to remove it.
      default:
        return;
    }
  }
  switch (entry.entity) {
    case 'trip':
      return target.saveTrip(entry.payload as Trip);
    case 'place':
      await target.upsertPlace(entry.payload as Place);
      return;
    case 'itinerary':
      await target.upsertItineraryItem(entry.payload as ItineraryItem);
      return;
    case 'expense':
      await target.upsertExpense(entry.payload as Expense);
      return;
    default:
      return;
  }
}
