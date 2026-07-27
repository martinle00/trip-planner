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

  // Reaching here means: this device has local data, and the signed-in
  // account can't see a remote trip. Since migration 0005 there is exactly
  // one shared trip and it already exists, so "no remote trip" no longer
  // means "nothing has been created yet" — it means this account isn't a
  // collaborator on it.
  //
  // Pushing the local seed up in that situation is never right: at best it
  // would overwrite the shared trip with this device's untouched seed data,
  // and in practice it just fails —
  //
  //   409  duplicate key value violates unique constraint "trips_pkey"
  //
  // (`trips.id` is a global primary key; `ACTIVE_TRIP_ID` is a constant).
  // Which is exactly what wedged a phone signed in as a second account.
  //
  // So: do nothing. The app surfaces "you're not on this trip yet", and the
  // fix is a row in `trip_collaborators`, not a second trip. The local Dexie
  // data stays untouched and unshared on this device.
}
