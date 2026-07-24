// ============================================================================
// The append-both conflict sentinel for Place.description / Place.selfReview,
// and the helpers that write and read it.
//
// 🔴 THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR THE SENTINEL STRING.
//
// The separator is stored IN the prose text (the merged text *is* the data —
// the boundary has to survive export/import and a round-trip through both
// repositories). The renderer then detects it to swap in a visual divider
// instead of showing the raw line.
//
// That only works if the writer and the reader agree byte-for-byte. If the
// store hardcoded one string and the detail-modal renderer hardcoded another,
// it would typecheck perfectly and only surface in real use — as a stray
// `— Also written on another device —` line sitting in the middle of a user's
// write-up. So: both sides import from here. Do not inline this string
// anywhere else, and do not "tidy" the punctuation (those are em dashes, and
// `mockup/place-detail-modal.html` matches them exactly).
// ============================================================================

/** The sentinel line itself, as stored in the text. Em dashes, not hyphens. */
export const CONFLICT_SENTINEL = '— Also written on another device —';

/** The sentinel as inserted between two conflicting texts — blank lines on
 *  both sides so it reads as its own paragraph in raw text too (e.g. in an
 *  export the user opens in a plain editor). */
export const CONFLICT_SEPARATOR = `\n\n${CONFLICT_SENTINEL}\n\n`;

/**
 * Append-both merge for one free-text field: if `remote` is empty or
 * identical to `local` (after trimming), there's nothing to preserve, so
 * `local` is returned unchanged. If `local` is empty, `remote` is returned
 * as-is (no pointless leading separator). Otherwise the two are joined with
 * `CONFLICT_SEPARATOR` — this NEVER discards either side, matching the
 * "nothing is ever lost" conflict-resolution policy (see
 * `useTripStore.commitPlaceDraft`).
 */
export function appendRemoteIfDifferent(
  local: string | undefined,
  remote: string | undefined,
): string | undefined {
  const localTrimmed = (local ?? '').trim();
  const remoteTrimmed = (remote ?? '').trim();
  if (!remoteTrimmed || remoteTrimmed === localTrimmed) return local;
  if (!localTrimmed) return remote;
  return `${local}${CONFLICT_SEPARATOR}${remote}`;
}

/**
 * Split merged prose back into its segments for rendering. A text with no
 * sentinel yields a single segment, so the renderer can treat every place's
 * prose uniformly and just draw a divider between segments.
 *
 * Repeated conflicts append repeatedly, so N sentinels -> N+1 segments; this
 * splits on all of them rather than assuming at most one.
 */
export function splitMergedProse(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(CONFLICT_SENTINEL)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Whether this text carries an auto-merged edit from another device — e.g.
 *  to show the "merged" affordance on the place card without re-splitting. */
export function hasMergedEdit(text: string | undefined): boolean {
  return Boolean(text?.includes(CONFLICT_SENTINEL));
}
