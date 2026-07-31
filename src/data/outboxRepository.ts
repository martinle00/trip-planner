// ============================================================================
// The pending-write queue. Deliberately NOT part of `TripRepository` -- the
// outbox never syncs anywhere; it is the list of writes that still have to be
// sent. Always backed by the LOCAL `db.outbox` Dexie table regardless of which
// repository is active, mirroring `draftRepository.ts`/
// `stagedAssignmentRepository.ts`.
//
// Written to only by `outboxTripRepository.ts` (which decides what is
// queueable) and drained only by `useTripStore.syncOutbox`. UI components
// never touch it -- they read the count off the store, matching the rest of
// the app's persistence-seam convention (see CLAUDE.md).
// ============================================================================

import { db } from './db';
import type { OutboxEntry } from './db';

export type { OutboxEntry };

/**
 * Notified whenever the queue changes size. Exists so the store can keep its
 * `pendingCount` current without every one of the ~20 mutating actions having
 * to remember to ask -- an easy thing to forget in exactly the one action
 * that matters. `useTripStore` subscribes once, on init.
 */
const listeners = new Set<() => void>();

export function onOutboxChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export const outboxRepository = {
  /**
   * Queue a pending write, COALESCING against whatever is already queued for
   * the same record: any existing entry for `[entity+recordId]` is replaced.
   *
   * This is what keeps the queue proportional to *records changed* rather
   * than to keystrokes -- editing one expense's label five times offline
   * leaves one entry, and the count the user is shown before tapping Upload
   * means something. It also makes replay cheaper and strictly last-write-
   * wins per record, which is the behaviour the rest of the app already has.
   *
   * The three cases, all of which fall out of "replace":
   *   upsert then upsert -> one upsert, latest payload
   *   upsert then delete -> one delete (the intermediate write is moot; the
   *                         record may never have reached the server at all)
   *   delete then upsert -> one upsert (re-created before uploading)
   *
   * `queuedAt` is carried over from the entry being replaced, so it keeps
   * meaning "when this record first went stale" -- which is what the
   * staleness disclosure in the sync sheet is measured from.
   */
  async append(entry: Omit<OutboxEntry, 'seq'>): Promise<void> {
    await db.transaction('rw', db.outbox, async () => {
      const existing = await db.outbox
        .where('[entity+recordId]')
        .equals([entry.entity, entry.recordId])
        .first();
      if (existing?.seq != null) {
        await db.outbox.delete(existing.seq);
      }
      await db.outbox.add({ ...entry, queuedAt: existing?.queuedAt ?? entry.queuedAt });
    });
    notify();
  },

  /** Every pending write in replay order (`seq` ascending). */
  async list(): Promise<OutboxEntry[]> {
    return db.outbox.orderBy('seq').toArray();
  },

  /** Drop one entry, after its write has actually landed remotely. */
  async remove(seq: number): Promise<void> {
    await db.outbox.delete(seq);
    notify();
  },

  /** Records with a pending change. This is the number shown to the user. */
  async count(): Promise<number> {
    return db.outbox.count();
  },

  /**
   * When the oldest still-pending change was queued, or undefined if the
   * queue is empty. Drives the "you've been reading local-only data for a
   * while" disclosure -- the app can't know WHAT a collaborator changed
   * meanwhile, but it does know how long it has been ignoring them.
   */
  async oldestQueuedAt(): Promise<string | undefined> {
    const first = await db.outbox.orderBy('seq').first();
    return first?.queuedAt;
  },

  /** Discard everything. Only for a deliberate wipe (sign-out via
   *  `clearLocalCache`, or a whole-trip import that invalidates every queued
   *  record id). Never call this to "recover" from a failed replay -- that
   *  silently throws away the user's work. */
  async clearAll(): Promise<void> {
    await db.outbox.clear();
    notify();
  },
};

/** Convenience for the repository layer: is there anything pending at all?
 *  Cheaper than `list()` when the answer only gates a branch. */
export async function hasPendingWrites(): Promise<boolean> {
  return (await outboxRepository.count()) > 0;
}
