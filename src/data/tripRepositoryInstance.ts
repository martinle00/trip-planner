// ============================================================================
// Mutable repository seam consumed by the store. Defaults to the local Dexie
// repository so the app works unauthenticated/offline exactly as before;
// the auth gate calls `setTripRepository` once a session exists to swap in a
// `SyncedTripRepository` (Supabase + Dexie cache).
// ============================================================================

import type { TripRepository } from './tripRepository';
import { DexieTripRepository } from './dexieTripRepository';

let current: TripRepository = new DexieTripRepository();

export function setTripRepository(repository: TripRepository): void {
  current = repository;
}

/** The raw active repository object (not the stable `tripRepository` proxy
 *  below) — lets a caller (see useTripStore.ts's `init()`) check what kind of
 *  repository is actually active right now, e.g. via `instanceof
 *  DexieTripRepository`, to decide whether a separate local-cache probe read
 *  would bypass a real network round-trip (worth it) or would just be a
 *  redundant second touch of the same local store (skip it). */
export function getActiveRepository(): TripRepository {
  return current;
}

/** Proxy so existing `tripRepository.xxx()` call sites keep working across swaps. */
export const tripRepository: TripRepository = new Proxy({} as TripRepository, {
  get(_target, prop: keyof TripRepository) {
    return current[prop].bind(current);
  },
});
