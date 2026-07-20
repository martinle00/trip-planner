// ============================================================================
// Local-only draft storage for a place's free-text prose fields
// (description/selfReview). Deliberately NOT part of `TripRepository` --
// drafts never sync to Supabase; they exist purely so in-progress edits
// survive a reload/offline with no network involved at all. Always backed by
// the LOCAL `db.placeDrafts` Dexie table regardless of which `TripRepository`
// is currently active (plain Dexie pre-auth, or the Supabase-backed
// `SyncedTripRepository` once signed in) -- see db.ts's `PlaceDraft`/
// `version(3)` schema.
//
// Consumed only by `useTripStore` (never directly by UI components), matching
// the rest of the app's persistence-seam convention -- see CLAUDE.md.
// ============================================================================

import { db } from './db';
import type { PlaceDraft } from './db';
import type { ID } from './schema';

export type { PlaceDraft };

export const draftRepository = {
  async getDraft(placeId: ID): Promise<PlaceDraft | undefined> {
    return db.placeDrafts.get(placeId);
  },

  async saveDraft(draft: PlaceDraft): Promise<void> {
    await db.placeDrafts.put(draft);
  },

  async deleteDraft(placeId: ID): Promise<void> {
    await db.placeDrafts.delete(placeId);
  },

  /** Wipe every local draft. Called on a whole-trip `importJson` (place ids
   *  from the incoming snapshot may not correspond to whatever drafts were
   *  pending against the old data). Sign-out clears drafts too, but via
   *  `clearLocalCache` in db.ts directly (it already owns the whole-cache
   *  wipe transaction). */
  async clearAll(): Promise<void> {
    await db.placeDrafts.clear();
  },
};
