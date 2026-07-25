// UI-facing view-model helpers for the Map tab's staged-changes Save model
// (see mockup/map-save-changes.html — approved spec). The store
// (`useTripStore.ts`) already owns the canonical `stagedAssignments` shape
// and its pure counting/lookup selectors (`getEffectiveDayId`,
// `getStagedAssignmentCount`, `getStagedAssignmentCountForCity`,
// `getStagedAssignmentCountsByCity`) — this file builds ONLY the bits that
// are genuinely UI copy/derived-set concerns the store deliberately doesn't
// own, on top of those selectors, so there's exactly one place that knows
// how to count a staged assignment.

import type { ID } from '../../data/schema';
import { getStagedAssignmentCountsByCity } from '../../store/useTripStore';
import type { TripState } from '../../store/useTripStore';

export type StagedAssignments = TripState['stagedAssignments'];

/** Whether this place has an unsaved (staged, not yet committed) reassignment. */
export function isPlacePending(placeId: ID, staged: StagedAssignments): boolean {
  return Object.hasOwn(staged, placeId);
}

/** Every city name that currently has at least one staged change — drives the
 *  route-strip's per-city pending dot. */
export function citiesWithPendingChanges(staged: StagedAssignments): Set<string> {
  return new Set(Object.keys(getStagedAssignmentCountsByCity(staged)));
}

/** The Save bar's cross-city hint line: null when every staged change is
 *  already visible in `currentCity` (nothing to call out), else "+N more in
 *  X" (some staged here too) or "All changes are in X" (none staged here,
 *  but the bar is still up because X has some). Mirrors
 *  mockup/map-save-changes.html's `buildLocationHint` exactly. */
export function crossCityHint(staged: StagedAssignments, currentCity: string): string | null {
  const counts = getStagedAssignmentCountsByCity(staged);
  const currentCount = counts[currentCity] ?? 0;
  const otherCities = Object.keys(counts).filter((c) => c !== currentCity);
  if (otherCities.length === 0) return null;
  const otherCount = otherCities.reduce((sum, c) => sum + (counts[c] ?? 0), 0);
  const where = otherCities.length === 1 ? `in ${otherCities[0]}` : `in ${otherCities.length} other cities`;
  return currentCount === 0 ? `All changes are ${where}` : `+${otherCount} more ${where}`;
}
