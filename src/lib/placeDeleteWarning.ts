// Content-aware delete-confirmation copy for a place (Phase 4 item 6): names
// what's actually being lost instead of a generic "Are you sure?" — deleting
// a bare pin and deleting one with three paragraphs of review are different
// acts. Mirrors buildDeleteWarning()/joinWithAnd()/wordCount() in the
// approved mockup (mockup/place-detail-modal.html) exactly, so the copy the
// designer signed off on is what ships.

/** Whitespace-delimited word count of free text, treating an all-whitespace
 *  (or undefined) string as zero words rather than one empty-string "word". */
export function wordCount(text: string | undefined): number {
  const trimmed = (text ?? '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function joinWithAnd(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export interface PlaceProseSummary {
  description?: string;
  selfReview?: string;
}

/**
 * Builds the body copy for the place-card delete confirmation. Deliberately
 * does NOT append "This can't be undone." — callers append that fixed
 * trailing sentence themselves (see `PlacesPanel`'s `PlaceCard`), matching
 * the mockup's own split between the content-aware sentence and the fixed
 * warning that follows it.
 */
export function buildPlaceDeleteWarning(place: PlaceProseSummary, hasDraft: boolean): string {
  const parts: string[] = [];
  if (place.selfReview?.trim()) parts.push(`your review (${wordCount(place.selfReview)} words)`);
  if (place.description?.trim()) parts.push('your notes');
  if (hasDraft) parts.push('an unsaved draft');
  if (parts.length === 0) return 'This place has nothing written on it yet.';
  return `This will also delete ${joinWithAnd(parts)}.`;
}
