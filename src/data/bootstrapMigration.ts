// ============================================================================
// One-time push of an existing local Dexie trip up to Supabase on first
// sign-in on a device. Must run BEFORE seedIfEmpty() is called on the
// composed (Supabase) repository -- otherwise seedIfEmpty would create a
// fresh empty remote trip first, making the "remote is empty" check below
// false by the time this runs.
//
// Deterministic policy (no merge, matches the app's no-conflict-resolution
// model): remote wins if it already has a trip (e.g. a second device signing
// in) -- local Dexie is treated as a stale cache and never pushed in that
// case. Local-to-remote push only happens when the remote is genuinely empty.
// ============================================================================

import type { TripRepository } from './tripRepository';

export async function bootstrapMigration(
  local: TripRepository,
  remote: TripRepository,
): Promise<void> {
  const [localTrip, remoteTrip] = await Promise.all([local.getTrip(), remote.getTrip()]);
  if (!localTrip || remoteTrip) return;
  const snapshot = await local.exportSnapshot();
  await remote.importSnapshot(snapshot);
}
