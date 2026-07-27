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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icons';
import { useTripStore } from '../../store/useTripStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { ID, ItineraryItem, Place } from '../../data/schema';
import { PLACE_CATEGORIES, categoryIcon, orderedCities } from '../../lib/tripView';
import { splitMergedProse } from '../../lib/proseMerge';
import { formatCoordinate, parseCoordinateInput } from '../../lib/coordinateInput';
import { gcj02ToWgs84, isInsideChina } from '../../lib/gcj02';
import { haversineMeters } from '../../lib/geo';

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
  /** Read mode's "View on map" handoff: switches to the Map tab showing
   *  this place's city (App owns both pieces of state). Optional so the
   *  modal still renders standalone — the link simply isn't offered. */
  onViewOnMap?: (city: string) => void;
  /** Reports every time this place's draft existence flips, so the grid's
   *  card badges (which live outside this modal, and outside React state
   *  the store tracks reactively — drafts are IndexedDB-only) can stay in
   *  sync without re-scanning every place's draft on every keystroke. */
  onDraftChange: (placeId: ID, hasDraft: boolean) => void;
}

export function PlaceDetailModal({ place, pinColor, onClose, onViewOnMap, onDraftChange }: PlaceDetailModalProps) {
  const trip = useTripStore((s) => s.trip);
  const itineraryByDay = useTripStore((s) => s.itineraryByDay);
  const updatePlace = useTripStore((s) => s.updatePlace);
  const updateItineraryItem = useTripStore((s) => s.updateItineraryItem);
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

  // --- The identity fields (name/category/city/location) ------------------
  // Part of the SAME edit session as About/My review — one pencil, one
  // "Save changes", one discard story (mockup/place-detail-modal-v2.html).
  // An earlier attempt gave them their own block with their own Save/Cancel
  // and was rejected in review: two live editors with two persistence models
  // in one modal, and category/city duplicated from the head chips a few
  // pixels above. In edit mode these fields take over the exact slot the
  // title + tags + "View on map" occupy in read mode, so nothing new is
  // inserted between the header and the prose the modal is really about.
  //
  // They are NOT written into the local draft: that machinery exists for
  // long-form prose (append-merge on a concurrent edit), and "merge" is
  // meaningless for a category. They ride along on Save instead — see
  // handleSave, which commits the prose draft FIRST and only then writes the
  // identity fields on top of the place it returns (writing them first would
  // bump updatedAt and make commitPlaceDraft mistake this save for a
  // concurrent edit from another device, append-merging the prose with
  // itself).
  const [nameValue, setNameValue] = useState('');
  const [categoryValue, setCategoryValue] = useState('');
  const [cityValue, setCityValue] = useState('');
  const [coordValue, setCoordValue] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
  // Google serves GCJ-02 for Chinese locations while our tiles are WGS-84 —
  // same offset problem (and same reversible toggle) as AddPlaceModal. Off on
  // entry: the stored coordinate is already WGS-84, and re-shifting it would
  // walk the pin a few hundred metres every time the field is opened.
  const [applyChinaShift, setApplyChinaShift] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const editBtnRef = useRef<HTMLButtonElement>(null);
  // Set when a transition should move focus somewhere that only exists after
  // the re-render (the name input appears only in edit mode; the pencil only
  // in read mode) — applied by the effect below, not inline.
  const [pendingFocus, setPendingFocus] = useState<'name' | 'edit-btn' | null>(null);

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
  const cityNames = trip ? orderedCities(trip).map((c) => c.name) : [];

  // Declared up here, not next to the JSX that uses them: `identityDirty`
  // feeds handleRequestClose's dependency array, which is evaluated during
  // render, so a later `const` would be in its temporal dead zone.
  const parsedCoord = useMemo(() => parseCoordinateInput(coordValue), [coordValue]);
  const pastedPoint = parsedCoord.ok ? { lat: parsedCoord.lat, lng: parsedCoord.lng } : null;
  const shiftAvailable = pastedPoint !== null && isInsideChina(pastedPoint);
  const shiftApplied = shiftAvailable && applyChinaShift;
  const nextPoint = pastedPoint && shiftApplied ? gcj02ToWgs84(pastedPoint) : pastedPoint;

  function resetIdentityFields(from: Place | null) {
    setNameValue(from?.name ?? '');
    setCategoryValue(from?.category ?? '');
    setCityValue(from?.city ?? '');
    setCoordValue(from ? `${from.lat}, ${from.lng}` : '');
    setApplyChinaShift(false);
  }

  // True once any identity field diverges from what's stored. Unlike the
  // prose fields there's no draft behind these, so this is what stops a
  // close/discard from dropping them silently.
  const identityDirty =
    place !== null &&
    (nameValue.trim() !== place.name ||
      categoryValue !== (place.category ?? '') ||
      cityValue !== place.city ||
      (nextPoint !== null && (nextPoint.lat !== place.lat || nextPoint.lng !== place.lng)));

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
    resetIdentityFields(place);
    setLocationOpen(false);
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

  // Focus targets that only exist on the other side of a mode change: the
  // name input is edit-mode only, the pencil is read-mode only. Both were
  // being unmounted out from under the user's focus (dropping it to <body>)
  // before this ran after the re-render instead of during the handler.
  useEffect(() => {
    if (!pendingFocus) return;
    const el = pendingFocus === 'name' ? nameRef.current : editBtnRef.current;
    el?.focus();
    setPendingFocus(null);
  }, [pendingFocus, mode]);

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
  function enterEditMode(field: FieldKey | null = null) {
    resetIdentityFields(place);
    setLocationOpen(false);
    setMode('edit');
    // The empty-state CTAs know which prose field the user meant, so focus
    // goes there; the pencil and the draft pill don't, so focus lands on the
    // first field of the form (the name) instead of being dropped on <body>
    // when the pencil itself unmounts.
    if (field) setFocusField(field);
    else setPendingFocus('name');
  }

  function handleDiscardClick() {
    clearPendingDebounce();
    if (isDirty || identityDirty) {
      setMode('confirm-discard');
      return;
    }
    // Nothing to protect — "Discard draft" just doubles as "cancel editing".
    setAboutValue(savedAbout);
    setReviewValue(savedReview);
    resetIdentityFields(place);
    setMode('view');
    setPendingFocus('edit-btn');
  }

  async function handleDiscardConfirmed() {
    if (!placeId) return;
    await discardPlaceDraft(placeId);
    setAboutValue(savedAbout);
    setReviewValue(savedReview);
    resetIdentityFields(place);
    setIsDirty(false);
    onDraftChange(placeId, false);
    setMode('view');
    setPendingFocus('edit-btn');
  }

  async function handleSave() {
    if (!placeId || !place) return;

    // Identity validation happens before anything is written, and reports
    // through the SAME `.save-error` line the prose save uses — one error
    // surface for one save button. Focus goes to the field that has to
    // change, since the message alone doesn't say where to type.
    const trimmedName = nameValue.trim();
    if (!trimmedName) {
      setMode('edit');
      setSaveError('A place needs a name.');
      setPendingFocus('name');
      return;
    }
    if (!categoryValue || !cityValue) {
      setMode('edit');
      setSaveError(`Pick a ${!categoryValue ? 'category' : 'city'} before saving.`);
      return;
    }
    if (!nextPoint) {
      setMode('edit');
      setLocationOpen(true);
      setSaveError(
        'Couldn’t read a location from that. Paste a pair like 31.2304, 121.4737, or a full Google Maps link.',
      );
      return;
    }

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

      // Identity fields go on top of the place the commit returned, and only
      // after it — see the note where they're declared. A no-op write is
      // skipped so an ordinary prose save stays a single round trip.
      if (identityDirty) {
        const moved = nextPoint.lat !== saved.lat || nextPoint.lng !== saved.lng;
        await updatePlace({
          ...saved,
          name: trimmedName,
          category: categoryValue,
          city: cityValue,
          lat: nextPoint.lat,
          lng: nextPoint.lng,
          // The stored address came from the geocoder for the OLD
          // coordinate — keeping it beside a hand-moved pin is just a
          // wrong label.
          address: moved ? undefined : saved.address,
        });
        // A renamed place would otherwise keep its old title on the
        // itinerary stop created from it (see the store's
        // assignPlaceToDay), which reads as two different places.
        if (trimmedName !== saved.name) {
          const linked = Object.values(itineraryByDay)
            .flat()
            .filter((i: ItineraryItem) => i.placeId === placeId);
          await Promise.all(linked.map((i) => updateItineraryItem({ ...i, title: trimmedName })));
        }
      }

      setSavedAbout(saved.description ?? '');
      setSavedReview(saved.selfReview ?? '');
      setAboutValue(saved.description ?? '');
      setReviewValue(saved.selfReview ?? '');
      setIsDirty(false);
      onDraftChange(placeId, false);
      setMode('view');
      setPendingFocus('edit-btn');
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
    // Closing stays non-destructive for prose — the draft is already on disk
    // whatever happens. The identity fields have no draft behind them, so
    // closing on top of an unsaved one WOULD destroy it: route that through
    // the confirm step the modal already has rather than adding a second
    // kind of prompt.
    if (identityDirty) {
      setMode('confirm-discard');
      return;
    }
    onClose();
  }, [mode, identityDirty, onClose]);

  const unassigned = place ? !place.dayId : false;
  const editing = mode === 'edit' || mode === 'saving';

  return (
    <Modal open={place !== null} onClose={handleRequestClose} labelledBy="placeDetailTitle">
      {place && (
        <div className={flash ? 'flash-confirm' : undefined}>
          <div className="modal-head">
            <div className="modal-title-block">
              {/* The dialog's accessible name comes from this always-rendered
                  node, never from the visual title: that one is replaced by
                  the name input in edit mode, and an aria-labelledby target
                  that goes display:none is honoured inconsistently by real
                  screen readers. */}
              <h2 className="visually-hidden" id="placeDetailTitle">
                {place.name} — place details
              </h2>

              {editing ? (
                /* The identity fields take over the title/tags slot rather
                   than adding a section below it — same footprint, one of
                   the two ever visible, so nothing is pushed between the
                   header and the prose this modal is really about. */
                <div className="identity-edit">
                  <label className="visually-hidden" htmlFor="pd-name">
                    Name
                  </label>
                  <input
                    className="modal-title-input"
                    id="pd-name"
                    ref={nameRef}
                    type="text"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    placeholder="Place name"
                    disabled={mode === 'saving'}
                  />
                  <div className="identity-fields-row">
                    <div>
                      <label className="field-label" htmlFor="pd-cat">
                        Category
                      </label>
                      <select
                        id="pd-cat"
                        value={categoryValue}
                        onChange={(e) => setCategoryValue(e.target.value)}
                        disabled={mode === 'saving'}
                      >
                        <option value="">Choose a category&hellip;</option>
                        {/* A place saved before the categories were
                            canonicalised can carry a legacy value (e.g.
                            'Sightseeing') — keep it selectable rather than
                            silently re-categorising it on open. */}
                        {categoryValue && !PLACE_CATEGORIES.includes(categoryValue) && (
                          <option value={categoryValue}>{categoryValue}</option>
                        )}
                        {PLACE_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field-label" htmlFor="pd-city">
                        City
                      </label>
                      <select
                        id="pd-city"
                        value={cityValue}
                        onChange={(e) => setCityValue(e.target.value)}
                        disabled={mode === 'saving'}
                      >
                        <option value="">Choose a city&hellip;</option>
                        {cityValue && !cityNames.includes(cityValue) && (
                          <option value={cityValue}>{cityValue}</option>
                        )}
                        {cityNames.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Collapsed even inside edit mode: a raw coordinate is the
                      correction path for the rare misplaced pin, not
                      something to put in front of someone fixing a typo in
                      the name. */}
                  <div className="location-field">
                    <button
                      type="button"
                      className="location-toggle"
                      aria-expanded={locationOpen}
                      aria-controls="pd-location-editor"
                      onClick={() => setLocationOpen((v) => !v)}
                      disabled={mode === 'saving'}
                    >
                      <Icon name="pin" />
                      <span>Location set</span> &middot; <span className="action">Change</span>
                      <Icon name="chevron-right" className="chev" />
                    </button>
                    <div className={`location-editor${locationOpen ? ' open' : ''}`} id="pd-location-editor">
                      <label className="field-label" htmlFor="pd-coord">
                        Location
                      </label>
                      <input
                        className="text-input coord-input"
                        type="text"
                        id="pd-coord"
                        value={coordValue}
                        onChange={(e) => setCoordValue(e.target.value)}
                        placeholder="31.2304, 121.4737 — or a Google Maps link"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={mode === 'saving'}
                      />
                      <div className="coord-status" aria-live="polite">
                        {nextPoint ? (
                          <p className="coord-ok">
                            <Icon name="target" /> Pin sits at {formatCoordinate(nextPoint.lat, nextPoint.lng)}
                          </p>
                        ) : (
                          <p className="coord-hint">
                            Paste a pair like 31.2304, 121.4737, or a full Google Maps link.
                          </p>
                        )}
                        {shiftAvailable && nextPoint && pastedPoint && (
                          <p className="coord-note">
                            {shiftApplied
                              ? `Moved ${Math.round(haversineMeters(pastedPoint, nextPoint))}m to correct China’s map offset — Google’s coordinates are shifted there, ours aren’t.`
                              : 'Using these numbers exactly. If you pasted them from Google, the pin may sit a few hundred metres out.'}
                            <button
                              type="button"
                              className="coord-toggle"
                              onClick={() => setApplyChinaShift((v) => !v)}
                              disabled={mode === 'saving'}
                            >
                              {shiftApplied ? 'Use the pasted numbers instead' : 'Correct the offset'}
                            </button>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="modal-title" aria-hidden="true">
                    <span
                      className={`place-icon${unassigned ? ' unassigned' : ''}`}
                      style={{ ['--pin-color' as string]: pinColor }}
                    >
                      <Icon name={categoryIcon(place.category)} />
                    </span>
                    {place.name}
                  </div>
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
                  {/* Read mode's answer to "where is this?" — a map, not a
                      number pair. Nobody judges a pin by its decimals. */}
                  {onViewOnMap && (
                    <button
                      type="button"
                      className="detail-link modal-map-link"
                      onClick={() => {
                        onViewOnMap(place.city);
                        onClose();
                      }}
                    >
                      <Icon name="target" /> View on map <Icon name="chevron-right" className="chev" />
                    </button>
                  )}
                </>
              )}

              {/* Rendered only when it has something in it — as a row in the
                  head's flex column, an empty one still eats a gap. */}
              {(editing || isDirty) && (
                <div className="modal-cues">
                  {editing && <span className="editing-cue">Editing</span>}
                  {isDirty && (
                    <button type="button" className="draft-pill" onClick={() => enterEditMode()}>
                      <span className="dot" aria-hidden="true" />
                      Unsaved changes
                    </button>
                  )}
                </div>
              )}
            </div>
            {mode !== 'confirm-discard' && (
              <div className="modal-head-actions">
                {/* The one and only pencil in this modal: it opens the single
                    edit session covering name, category, city, location,
                    notes and review. */}
                {mode === 'view' && (
                  <button
                    ref={editBtnRef}
                    className="modal-edit-btn"
                    aria-label="Edit this place"
                    onClick={() => enterEditMode()}
                  >
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
                  Any changes to name, category, city, location, notes and review will be replaced with
                  what&rsquo;s currently saved. This can&rsquo;t be undone.
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
