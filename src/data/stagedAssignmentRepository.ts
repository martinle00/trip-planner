// ============================================================================
// Local-only staging table for Map day-assignment edits (the "Save changes"
// model — see mockup/map-save-changes.html). Deliberately NOT part of
// `TripRepository` -- staged assignments never sync to Supabase; they exist
// purely so an in-progress Map reassignment survives a city switch/reload/
// offline with no network involved at all, until the user explicitly hits
// Save. Always backed by the LOCAL `db.stagedAssignments` Dexie table
// regardless of which `TripRepository` is currently active (plain Dexie
// pre-auth, or the Supabase-backed `SyncedTripRepository` once signed in) --
// see db.ts's `StagedAssignment`/`version(4)` schema.
//
// Mirrors `draftRepository.ts`'s pattern (same local-only-editing-state
// precedent, one row per place instead of one row per free-text draft).
// Consumed only by `useTripStore` (never directly by UI components), matching
// the rest of the app's persistence-seam convention -- see CLAUDE.md.
// ============================================================================

import { db } from './db';
import type { StagedAssignment } from './db';
import type { ID } from './schema';

export type { StagedAssignment };

export const stagedAssignmentRepository = {
  async listAll(): Promise<StagedAssignment[]> {
    return db.stagedAssignments.toArray();
  },

  async upsert(entry: StagedAssignment): Promise<void> {
    await db.stagedAssignments.put(entry);
  },

  async remove(placeId: ID): Promise<void> {
    await db.stagedAssignments.delete(placeId);
  },

  /** Remove several staged rows by placeId in one go -- used by
   *  `saveStagedAssignments` to drop exactly the entries that demonstrably
   *  committed before a mid-batch failure, leaving the rest staged. */
  async removeMany(placeIds: ID[]): Promise<void> {
    await db.stagedAssignments.bulkDelete(placeIds);
  },

  /** Remove every staged row belonging to one city (Discard's scope — see
   *  `useTripStore.discardStagedAssignmentsForCity`). Other cities' staged
   *  rows are left untouched. */
  async removeForCity(city: string): Promise<void> {
    await db.stagedAssignments.where('city').equals(city).delete();
  },

  /** Wipe every local staged assignment (across every city). Called on a
   *  successful `saveStagedAssignments` batch-commit and on a whole-trip
   *  `importJson` (place ids from the incoming snapshot may not correspond
   *  to whatever was staged against the old data). Sign-out clears staged
   *  assignments too, but via `clearLocalCache` in db.ts directly (it
   *  already owns the whole-cache wipe transaction). */
  async clearAll(): Promise<void> {
    await db.stagedAssignments.clear();
  },
};
