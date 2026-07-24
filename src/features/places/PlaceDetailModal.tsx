// Place detail modal (Phase 4 items 3 + 4 + 5) — description/selfReview
// editing with a local-draft-then-explicit-save model. Reuses Modal.tsx
// unchanged; mirrors the approved design in mockup/place-detail-modal.html.
//
// Draft lifecycle:
//  - Every keystroke debounce-saves a WIP draft to IndexedDB via the store's
//    savePlaceDraft (local-only, never synced — see data/draftRepository.ts).
//    It survives modal close, tab switch and a full reload.
//  - Only "Save changes" writes through to the real Place row, via
//    commitPlaceDraft, which append-merges a concurrent edit from another
//    device rather than overwriting it (see lib/proseMerge.ts) and clears
//    the local draft on success.
//  - Closing the modal (X / overlay click / Escape) is NEVER destructive —
//    the draft is already safely persisted regardless of how the modal
//    closes. The only actually-destructive action is the footer's "Discard
//    draft", which gets its own inline confirm step before it touches
//    anything.
//
// Escape/overlay-click/X all route through the single `onClose` prop that
// Modal.tsx calls for all three (it doesn't distinguish between them) — see
// handleRequestClose below. The approved mockup has Escape specifically step
// edit -> view -> closed one level at a time, which Modal.tsx's single-prop
// contract can't express without modifying that shared component. Since
// closing is non-destructive either way (the draft persists regardless), the
// one simplification made here is that Escape/overlay/X all close outright
// from edit mode instead of first stepping back to read mode — the only
// state genuinely guarded is an in-flight save and an open "discard draft?"
// confirmation (both still block/step-back correctly).
//
// IMPORTANT — this component does NOT unmount when the modal "closes": the
// parent (PlacesPanel) renders exactly one <PlaceDetailModal> and only ever
// changes its `place` prop (a real Place, or null when nothing should be
// showing). React keeps this same component instance — and every ref on it —
// mounted across that. That matters for two things below: (1) refs like
// debounceRef/pendingWriteRef are NOT reset for free by an "unmount" that
// never happens, so the debounced-save machinery has to explicitly flush and
// clear them whenever `placeId` changes, including to null (see the
// [placeId] effect's cleanup); and (2) handleRequestClose must be memoized
// (useCallback), or its identity churns on every keystroke re-render and
// re-triggers Modal.tsx's focus-trap effect (keyed on `[open, onClose]`),
// yanking focus out of the textarea the user is actively typing in.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icons';
import { useTripStore } from '../../store/useTripStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { ID, Place } from '../../data/schema';
import { categoryIcon } from '../../lib/tripView';
import { splitMergedProse } from '../../lib/proseMerge';

const DRAFT_DEBOUNCE_MS = 500;
const SAVE_ERROR_FALLBACK =
  "Couldn't save — check your connection. Your draft is still here, safe on this device.";
const MERGE_NOTICE =
  'Saved — your partner also edited this on another device while you were writing. Their text was added below yours; look for the divider.';

type DetailMode = 'view' | 'edit' | 'saving' | 'confirm-discard';
type FieldKey = 'about' | 'review';

interface PlaceDetailModalProps {
  place: Place | null;
  /** The place's marker colour (from the day it's assigned to, or the
   *  unassigned grey) — computed by the caller with `dayColor()`, same as
   *  the place card, so this component doesn't need its own copy of the
   *  day-color map. */
  pinColor: string;
  onClose: () => void;
  /** Reports every time this place's draft existence flips, so the grid's
   *  card badges (which live outside this modal, and outside React state
   *  the store tracks reactively — drafts are IndexedDB-only) can stay in
   *  sync without re-scanning every place's draft on every keystroke. */
  onDraftChange: (placeId: ID, hasDraft: boolean) => void;
}

export function PlaceDetailModal({ place, pinColor, onClose, onDraftChange }: PlaceDetailModalProps) {
  const getPlaceDraft = useTripStore((s) => s.getPlaceDraft);
  const savePlaceDraft = useTripStore((s) => s.savePlaceDraft);
  const discardPlaceDraft = useTripStore((s) => s.discardPlaceDraft);
  const commitPlaceDraft = useTripStore((s) => s.commitPlaceDraft);
  const online = useOnlineStatus();

  const [mode, setMode] = useState<DetailMode>('view');
  const [aboutValue, setAboutValue] = useState('');
  const [reviewValue, setReviewValue] = useState('');
  const [savedAbout, setSavedAbout] = useState('');
  const [savedReview, setSavedReview] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [focusField, setFocusField] = useState<FieldKey | null>(null);

  const debounceRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const aboutRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  const discardTriggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingDiscard = useRef(false);
  // Mirrors whatever the pending debounce timer would write. This component
  // is reused for every place (see the file-header note above) — these refs
  // are NOT reset by an unmount when the user moves on to a different place,
  // so the [placeId] effect below explicitly flushes+clears them itself
  // whenever `placeId` changes, not just on a true unmount. Losing the last
  // half-second of typing — to a fast close OR to switching straight to
  // another place mid-debounce — is exactly the kind of loss this feature
  // exists to prevent.
  const pendingWriteRef = useRef<{ placeId: ID; description: string; selfReview: string } | null>(null);

  const placeId = place?.id ?? null;

  // (Re)loads whenever a different place opens — including switching
  // straight from one place's card to another's while this same component
  // instance stays mounted underneath (see file-header note). Deliberately
  // NOT keyed on `place` itself: after a successful save this component sets
  // savedAbout/savedReview/aboutValue/reviewValue directly from the commit
  // result (see handleSave), and re-running this effect on every resulting
  // `place` prop change would either redundantly re-derive the same values
  // or race that just-applied transition.
  useEffect(() => {
    let cancelled = false;
    if (placeId) {
      setSaveError(null);
      setConflictMessage(null);
      (async () => {
        const draft = await getPlaceDraft(placeId);
        if (cancelled) return;
        const savedA = place?.description ?? '';
        const savedR = place?.selfReview ?? '';
        setSavedAbout(savedA);
        setSavedReview(savedR);
        if (draft) {
          // Opening a place that already has a draft resumes editing exactly
          // where it was left, rather than showing the (now stale) saved
          // text and making the user go hunt for the "Unsaved changes" pill
          // first.
          setAboutValue(draft.description ?? '');
          setReviewValue(draft.selfReview ?? '');
          setIsDirty(true);
          setMode('edit');
        } else {
          setAboutValue(savedA);
          setReviewValue(savedR);
          setIsDirty(false);
          setMode('view');
        }
      })();
    }
    // This cleanup runs both when `placeId` is about to change to a
    // different value (including to null, i.e. the modal "closing") AND on a
    // genuine unmount (e.g. the whole Places tab unmounting on a tab
    // switch) — a single ref-scoped flush covers every way a pending write
    // could otherwise be silently dropped, including the one that bit us
    // before this fix: opening place A, typing, then opening place B within
    // DRAFT_DEBOUNCE_MS. Without this, B's scheduleDraftSave would just
    // clear A's still-pending timer and overwrite the shared
    // pendingWriteRef, discarding A's text with no error and no draft badge.
    return () => {
      cancelled = true;
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
        const pending = pendingWriteRef.current;
        pendingWriteRef.current = null;
        if (pending) {
          // Deliberately fire-and-forget: a React effect cleanup can't be
          // async (there's nothing to await it), so this can't be made
          // fully synchronous without a much bigger change (e.g. blocking
          // navigation until the write lands, which is disproportionate
          // here). The write itself is a single Dexie `put()`, normally
          // sub-millisecond, so the only realistic failure window is an
          // extremely fast unmount+remount (e.g. a rapid double tab-switch)
          // racing ahead of it — and even then nothing is actually lost:
          // the write still completes and lands in IndexedDB moments later,
          // so re-opening this exact place would show it. The visible
          // symptom, if it ever happens, is a "Draft" badge that's
          // momentarily one write behind, not data loss.
          void savePlaceDraft(pending.placeId, {
            description: pending.description,
            selfReview: pending.selfReview,
          });
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    };
  }, []);

  // Deliberate focus management for the discard-confirm step, mirroring
  // PlacesPanel's delete-confirm pattern (autoFocus on the safe option +
  // ref-restore on the way back out) rather than leaning on Modal.tsx's
  // incidental re-focus, which (a) shouldn't be relied on for this — see the
  // handleRequestClose memoization note above — and (b) would land on the
  // wrong (destructive) control if it ever did fire. "Keep editing" gets
  // autoFocus directly in the JSX below, since that panel is a fresh DOM
  // mount each time (conditionally rendered, not just hidden).
  useEffect(() => {
    const isConfirming = mode === 'confirm-discard';
    if (wasConfirmingDiscard.current && !isConfirming && mode === 'edit') {
      discardTriggerRef.current?.focus();
    }
    wasConfirmingDiscard.current = isConfirming;
  }, [mode]);

  useEffect(() => {
    if (mode !== 'edit' || !focusField) return;
    const el = focusField === 'about' ? aboutRef.current : reviewRef.current;
    el?.focus();
    setFocusField(null);
  }, [mode, focusField]);

  const persistDraft = useCallback(
    async (nextAbout: string, nextReview: string) => {
      if (!placeId) return;
      const differs = nextAbout.trim() !== savedAbout.trim() || nextReview.trim() !== savedReview.trim();
      if (differs) {
        await savePlaceDraft(placeId, { description: nextAbout, selfReview: nextReview });
        setIsDirty(true);
        onDraftChange(placeId, true);
      } else {
        // Typed back to exactly the saved text — nothing left to protect.
        await discardPlaceDraft(placeId);
        setIsDirty(false);
        onDraftChange(placeId, false);
      }
    },
    [placeId, savedAbout, savedReview, savePlaceDraft, discardPlaceDraft, onDraftChange],
  );

  const scheduleDraftSave = useCallback(
    (nextAbout: string, nextReview: string) => {
      if (!placeId) return;
      pendingWriteRef.current = { placeId, description: nextAbout, selfReview: nextReview };
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        pendingWriteRef.current = null;
        void persistDraft(nextAbout, nextReview);
      }, DRAFT_DEBOUNCE_MS);
    },
    [placeId, persistDraft],
  );

  function handleAboutChange(value: string) {
    setAboutValue(value);
    scheduleDraftSave(value, reviewValue);
  }
  function handleReviewChange(value: string) {
    setReviewValue(value);
    scheduleDraftSave(aboutValue, value);
  }

  function clearPendingDebounce() {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    pendingWriteRef.current = null;
  }

  // Enters edit mode AND moves focus into the field the user actually meant
  // to edit, rather than leaving it to Modal.tsx's generic focus trap (which
  // would land on the first focusable element — typically the close button,
  // not a field at all). Used by the empty-state "+ Add notes"/"+ Write a
  // review" CTAs (which know exactly which field they're for) and, below,
  // by the header pencil "Edit" button and the "Unsaved changes" draft pill
  // (which don't, so they default to 'about' — matching the approved
  // mockup's own setMode(), where the third `focusField` argument defaults
  // to 'about' when the caller doesn't pass one).
  function enterEditMode(field: FieldKey = 'about') {
    setMode('edit');
    setFocusField(field);
  }

  function handleDiscardClick() {
    clearPendingDebounce();
    if (isDirty) {
      setMode('confirm-discard');
      return;
    }
    // Nothing to protect — "Discard draft" just doubles as "cancel editing".
    setAboutValue(savedAbout);
    setReviewValue(savedReview);
    setMode('view');
  }

  async function handleDiscardConfirmed() {
    if (!placeId) return;
    await discardPlaceDraft(placeId);
    setAboutValue(savedAbout);
    setReviewValue(savedReview);
    setIsDirty(false);
    onDraftChange(placeId, false);
    setMode('view');
  }

  async function handleSave() {
    if (!placeId) return;
    clearPendingDebounce();
    setMode('saving');
    setSaveError(null);

    // Don't even attempt a doomed network write — commitPlaceDraft would
    // just reject with a raw fetch error a moment later anyway (see the
    // catch block below). The draft is already safely persisted locally
    // (see the draft lifecycle note at the top of this file); Save is
    // simply retryable once back online.
    if (!online) {
      setMode('edit');
      setSaveError(SAVE_ERROR_FALLBACK);
      return;
    }

    try {
      // Make sure the very latest keystrokes are captured as the draft
      // before committing — commitPlaceDraft reads from the draft table,
      // not from this component's in-memory state, and a debounced save may
      // still be pending if Save is clicked within DRAFT_DEBOUNCE_MS of the
      // last keystroke.
      const differs = aboutValue.trim() !== savedAbout.trim() || reviewValue.trim() !== savedReview.trim();
      if (differs) {
        await savePlaceDraft(placeId, { description: aboutValue, selfReview: reviewValue });
      }
      const { place: saved, merged } = await commitPlaceDraft(placeId);
      setSavedAbout(saved.description ?? '');
      setSavedReview(saved.selfReview ?? '');
      setAboutValue(saved.description ?? '');
      setReviewValue(saved.selfReview ?? '');
      setIsDirty(false);
      onDraftChange(placeId, false);
      setMode('view');
      setConflictMessage(merged ? MERGE_NOTICE : null);
      setFlash(true);
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlash(false), 800);
    } catch (err) {
      // The user-facing message is ALWAYS the friendly fallback — never the
      // raw error. commitPlaceDraft's failure path reaches all the way down
      // through SyncedTripRepository -> SupabaseTripRepository ->
      // postgrest-js, which rethrows the underlying fetch/network error
      // verbatim for a non-retryable client method (e.g. a browser
      // `TypeError: Failed to fetch`, a DNS failure, an RLS/auth error, a
      // 5xx) — none of that is written for a user to read, and the second
      // half of SAVE_ERROR_FALLBACK ("your draft is still here, safe on
      // this device") is the one sentence this whole feature exists to
      // guarantee, so it must never be crowded out by whatever specifically
      // went wrong. The real error is still logged for debugging.
      console.error('Failed to save place changes', err);
      // The draft is untouched on failure (nothing above cleared it) — Save
      // is simply retryable, and nothing typed is lost.
      setMode('edit');
      setSaveError(SAVE_ERROR_FALLBACK);
    }
  }

  // Memoized (not a plain nested function) and deliberately keyed on `mode`
  // rather than recreated every render: this is Modal.tsx's `onClose` prop,
  // and Modal's focus-trap effect re-runs whenever THAT identity changes
  // (see Modal.tsx: `useEffect(..., [open, onClose])`) — re-focusing the
  // first focusable element (or the modal shell) every time. A plain nested
  // function here gets a new identity on every keystroke re-render (typing
  // updates aboutValue/reviewValue), so it was re-triggering that effect and
  // yanking real focus out of the textarea after roughly one character.
  // `mode` is the only thing this function's behaviour actually depends on
  // besides the `onClose` prop itself, and it does NOT change while typing.
  const handleRequestClose = useCallback(() => {
    if (mode === 'saving') return; // don't abandon a save that's actively in flight
    if (mode === 'confirm-discard') {
      // Don't let Escape/overlay-click skip past an open destructive prompt.
      setMode('edit');
      return;
    }
    onClose();
  }, [mode, onClose]);

  const unassigned = place ? !place.dayId : false;
  const editing = mode === 'edit' || mode === 'saving';

  return (
    <Modal open={place !== null} onClose={handleRequestClose} labelledBy="placeDetailTitle">
      {place && (
        <div className={flash ? 'flash-confirm' : undefined}>
          <div className="modal-head">
            <div className="modal-title-block">
              <h2 className="modal-title" id="placeDetailTitle">
                <span
                  className={`place-icon${unassigned ? ' unassigned' : ''}`}
                  style={{ ['--pin-color' as string]: pinColor }}
                >
                  <Icon name={categoryIcon(place.category)} />
                </span>
                {place.name}
              </h2>
              <div className="modal-tags">
                {place.category && <span className="tag">{place.category}</span>}
                <span className="tag city">{place.city}</span>
                {savedReview.trim() && (
                  <span className="tag reviewed">
                    <Icon name="check" className="tag-icon" />
                    Reviewed
                  </span>
                )}
              </div>
              <div className="modal-cues">
                {(mode === 'edit' || mode === 'saving') && <span className="editing-cue">Editing</span>}
                {isDirty && (
                  <button type="button" className="draft-pill" onClick={() => enterEditMode()}>
                    <span className="dot" aria-hidden="true" />
                    Unsaved changes
                  </button>
                )}
              </div>
            </div>
            {mode !== 'confirm-discard' && (
              <div className="modal-head-actions">
                {mode === 'view' && (
                  <button className="modal-edit-btn" aria-label="Edit notes and review" onClick={() => enterEditMode()}>
                    <Icon name="edit" />
                  </button>
                )}
                <button
                  className="modal-close modal-close-lg"
                  aria-label="Close"
                  onClick={handleRequestClose}
                  disabled={mode === 'saving'}
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
          </div>

          {conflictMessage && mode !== 'confirm-discard' && (
            <div className="conflict-banner" role="status">
              <Icon name="check" />
              <p>{conflictMessage}</p>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setConflictMessage(null)}>
                <Icon name="close" />
              </button>
            </div>
          )}

          {mode !== 'confirm-discard' && (
            <>
              <DetailSection
                label="About"
                icon="book"
                editing={editing}
                text={editing ? aboutValue : savedAbout}
                onChange={handleAboutChange}
                placeholder="What should you know before visiting? Opening hours, best time of day, getting there, tips…"
                emptyTitle="Nothing written yet"
                emptyHint="Opening hours, best time of day, tips before you go"
                emptyCta="+ Add notes"
                onEmptyCta={() => enterEditMode('about')}
                textareaId="place-detail-about"
                fieldClassName="about-field"
                textareaRef={aboutRef}
                disabled={mode === 'saving'}
              />
              <DetailSection
                label="My review"
                icon="quote"
                editing={editing}
                text={editing ? reviewValue : savedReview}
                onChange={handleReviewChange}
                placeholder="How did it go? Worth it, what you'd skip next time, how long you stayed…"
                emptyTitle="You haven't reviewed this place yet"
                emptyHint="Write it up once you've been"
                emptyCta="+ Write a review"
                onEmptyCta={() => enterEditMode('review')}
                textareaId="place-detail-review"
                fieldClassName="review-field"
                textareaRef={reviewRef}
                disabled={mode === 'saving'}
              />
            </>
          )}

          {editing && (
            <div className="modal-foot">
              {saveError && (
                <p className="save-error" role="alert">
                  <Icon name="alert" />
                  <span>{saveError}</span>
                </p>
              )}
              <div className="modal-foot-actions">
                <button
                  ref={discardTriggerRef}
                  type="button"
                  className="btn btn-ghost"
                  onClick={handleDiscardClick}
                  disabled={mode === 'saving'}
                >
                  Discard draft
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={mode === 'saving'}>
                  {mode === 'saving' ? <span className="spin" aria-hidden="true" /> : <Icon name="check" />}
                  <span>{mode === 'saving' ? 'Saving…' : 'Save changes'}</span>
                </button>
              </div>
            </div>
          )}

          {mode === 'confirm-discard' && (
            <div className="discard-confirm">
              <p className="discard-confirm-text">
                <Icon name="alert" />
                <span>
                  <strong>Discard this draft?</strong>
                  It&rsquo;ll be replaced with what&rsquo;s currently saved. This can&rsquo;t be undone.
                </span>
              </p>
              <div className="discard-confirm-actions">
                <button type="button" className="btn discard-btn" onClick={() => void handleDiscardConfirmed()}>
                  Discard draft
                </button>
                {/* autoFocus, not incidental re-focus: this panel is a fresh
                    DOM mount each time (conditionally rendered, not just
                    hidden), so autoFocus fires reliably on mount, landing on
                    the safe option rather than the destructive one. */}
                <button type="button" className="btn btn-primary" autoFocus onClick={() => setMode('edit')}>
                  Keep editing
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

interface DetailSectionProps {
  label: string;
  icon: string;
  editing: boolean;
  text: string;
  onChange: (value: string) => void;
  placeholder: string;
  emptyTitle: string;
  emptyHint: string;
  emptyCta: string;
  onEmptyCta: () => void;
  textareaId: string;
  fieldClassName: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}

function DetailSection({
  label,
  icon,
  editing,
  text,
  onChange,
  placeholder,
  emptyTitle,
  emptyHint,
  emptyCta,
  onEmptyCta,
  textareaId,
  fieldClassName,
  textareaRef,
  disabled,
}: DetailSectionProps) {
  return (
    <div className="detail-section">
      <label className="field-label" htmlFor={textareaId}>
        <Icon name={icon} />
        {label}
      </label>
      {editing ? (
        <div className="detail-edit">
          <textarea
            id={textareaId}
            className={fieldClassName}
            ref={textareaRef}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
          />
        </div>
      ) : text.trim() ? (
        <div className="detail-prose">
          <Prose text={text} />
        </div>
      ) : (
        <div className="detail-empty">
          <Icon name={icon} />
          <div className="detail-empty-text">
            <strong>{emptyTitle}</strong>
            <span>{emptyHint}</span>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onEmptyCta}>
            {emptyCta}
          </button>
        </div>
      )}
    </div>
  );
}

// The crude-by-design "keep both" conflict resolution (Phase 4 item 5): the
// merged text IS the data (the sentinel line is stored in the field itself,
// see lib/proseMerge.ts), so rendering is just splitting on it and drawing a
// visible divider between the segments instead of showing the raw line.
function Prose({ text }: { text: string }) {
  const segments = splitMergedProse(text);
  return (
    <>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="conflict-sep-row">Also written on another device</div>}
          <span className="prose-block">{segment}</span>
        </Fragment>
      ))}
    </>
  );
}
