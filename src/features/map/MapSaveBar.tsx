// The Map tab's staged-changes Save bar — approved via
// mockup/map-save-changes.html. Deliberately store-agnostic: every input is a
// plain prop and both mutations (`onSave`/`onDiscardCity`) are callbacks, so
// this component owns none of the staging state itself and can be fully unit
// tested without a Zustand store or a repository in the loop. MapPanel is the
// only thing that wires it to `useTripStore`.
//
// Docked to the bottom of the Map panel's own scroll position (position:
// sticky in CSS — see .map-save-bar in index.css), not inside .pin-detail:
// staged changes can span several pins across several cities, so the bar has
// to stay honest about "how many changes" no matter what's currently
// selected or shown (see the PLACEMENT DECISION comment in the mockup).
//
// Save vs Discard scope (also resolved in the mockup, reproduced here):
// Save commits every staged change, in every city, in one action. Discard
// only reverts what's staged in whichever city is CURRENTLY shown — a
// localized "undo what I did here," not a global undo. The Discard button's
// own label carries the current city name so that asymmetry is visible
// before the destructive confirm gate, not just inside it.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from '../../components/Icons';

type Phase = 'idle' | 'saving' | 'saved' | 'error' | 'confirm';
type DataState = 'hidden' | 'pending' | 'saving' | 'saved' | 'error' | 'confirm-discard';

export interface MapSaveBarProps {
  /** Staged-assignment count across every city — the bar's headline number. */
  pendingTotal: number;
  /** Staged-assignment count scoped to the city currently shown on the map —
   *  Discard only ever acts on this scope. */
  pendingInCity: number;
  /** The city currently shown on the map — named on the Discard button and
   *  in its confirm copy so Discard's narrower scope is never ambiguous. */
  cityLabel: string;
  /** Cross-city hint line ("+1 more in Suzhou" / "All changes are in
   *  Suzhou"), or null when every staged change is already visible here. */
  hint: string | null;
  online: boolean;
  /** Commits every staged change, in every city. Should reject on failure
   *  (leaving staging intact) and when offline — this component drives its
   *  saving -> saved / saving -> error transitions off whether the returned
   *  promise resolves or rejects. */
  onSave: () => Promise<void>;
  /** Reverts whatever's staged in `cityLabel` only. Purely local — expected
   *  to work offline. */
  onDiscardCity: () => void;
  /** Focused when a Discard empties the bar entirely (nothing staged left
   *  anywhere) — there's no control left inside the bar itself to land focus
   *  on, so the caller should point this at e.g. the panel's own heading. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

const ERROR_MESSAGE =
  "Couldn't save — check your connection. Your changes are still here, safe on this device.";
const OFFLINE_MESSAGE =
  "You're offline — Save is off until you're reconnected. Your changes are safe on this device, even after a reload.";

/** Stable id for the outer bar element, so callers (the pin-detail panel's
 *  "Unsaved change" pill) can scroll it into view / find its Save button
 *  without this component needing to expose a DOM ref of its own. */
export const MAP_SAVE_BAR_ID = 'map-save-bar';

export function MapSaveBar({
  pendingTotal,
  pendingInCity,
  cityLabel,
  hint,
  online,
  onSave,
  onDiscardCity,
  fallbackFocusRef,
}: MapSaveBarProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [announcement, setAnnouncement] = useState('');
  // What to fall back to when the confirm step is cancelled — a prior 'error'
  // is deliberately NOT cleared by a plain edit (see the dataState derivation
  // below), so cancelling out of a confirm opened while in that state must
  // restore it rather than resetting to plain 'pending'.
  const phaseBeforeConfirmRef = useRef<'idle' | 'error'>('idle');
  const hideTimerRef = useRef<number | null>(null);
  const discardBtnRef = useRef<HTMLButtonElement>(null);
  const keepEditingBtnRef = useRef<HTMLButtonElement>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const discardHintId = useId();
  // Tracks the previous render's pendingTotal so the guard below can detect a
  // genuine INCREASE (a real new stage), not just "still nonzero" — right
  // after a successful save, the parent's own re-render (clearing
  // `stagedAssignments`) hasn't necessarily landed yet, so `pendingTotal` can
  // still legitimately read its pre-save (nonzero) value for one tick even
  // though nothing new was staged. Comparing against the prior value instead
  // of a bare ">0" check avoids that spurious cancellation.
  const prevPendingTotalRef = useRef(pendingTotal);

  // AUTO-HIDE RACE: if the 'saved' flash's auto-hide timer is still pending
  // when a NEW change gets staged (pendingTotal ticks UP), kill it outright —
  // otherwise a change staged during that brief window could still get
  // force-hidden a moment later even though the bar has since legitimately
  // gone back to 'pending'.
  useEffect(() => {
    if (phase === 'saved' && pendingTotal > prevPendingTotalRef.current && hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    prevPendingTotalRef.current = pendingTotal;
  }, [pendingTotal, phase]);

  useEffect(
    () => () => {
      if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const dataState: DataState =
    phase === 'confirm'
      ? 'confirm-discard'
      : phase === 'saving'
        ? 'saving'
        : phase === 'saved'
          ? 'saved'
          : phase === 'error'
            ? 'error'
            : pendingTotal === 0
              ? 'hidden'
              : 'pending';

  // Offline is an orthogonal modifier, not a state of its own — it can be
  // true while the bar is 'pending' OR 'error' (a failed save while still
  // offline). Precedence: offline wins over a generic error message (see the
  // STACKED MESSAGING resolution in the mockup) — Save can't even be
  // attempted while offline, so a generic "couldn't save" message would be
  // actively misleading once we already know the connection is the problem.
  const isOffline = !online && (dataState === 'pending' || dataState === 'error');

  useEffect(() => {
    if (dataState === 'saved') setAnnouncement('Changes saved.');
    else if (dataState === 'error') setAnnouncement('Save failed. Your changes are still staged here.');
    else if (dataState === 'pending') {
      setAnnouncement(`${pendingTotal} unsaved change${pendingTotal === 1 ? '' : 's'}.`);
    } else setAnnouncement('');
  }, [dataState, pendingTotal]);

  // FOCUS: land on "Keep editing" (the safe option) the moment the confirm
  // step opens, mirroring PlaceDetailModal's discard-confirm precedent.
  useEffect(() => {
    if (dataState !== 'confirm-discard') return;
    const t = window.setTimeout(() => keepEditingBtnRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [dataState]);

  const handleSave = useCallback(async () => {
    if (!online || pendingTotal === 0) return;
    setPhase('saving');
    try {
      await onSave();
      setPhase('saved');
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        setPhase('idle');
      }, 1500);
    } catch {
      // Failure leaves every staged change exactly as it was — nothing
      // re-typed, nothing reverted, Save is simply retryable.
      setPhase('error');
    }
  }, [online, pendingTotal, onSave]);

  const handleRequestDiscard = useCallback(() => {
    if (pendingInCity === 0) return; // defensive — the button is already disabled in this state
    phaseBeforeConfirmRef.current = phase === 'error' ? 'error' : 'idle';
    setPhase('confirm');
  }, [phase, pendingInCity]);

  // FOCUS: return to the control that opened the confirmation — it's still
  // visible and still the thing the user was just interacting with.
  const handleCancelDiscard = useCallback(() => {
    setPhase(phaseBeforeConfirmRef.current);
    window.setTimeout(() => discardBtnRef.current?.focus(), 0);
  }, []);

  const handleConfirmDiscard = useCallback(() => {
    const remainingAfter = pendingTotal - pendingInCity;
    onDiscardCity();
    setPhase('idle');
    if (remainingAfter > 0) {
      // The "Discard changes" button just clicked is about to disappear;
      // Save is now the obvious next action and lives in a stable spot in
      // the still-visible bar.
      window.setTimeout(() => saveBtnRef.current?.focus(), 0);
    } else {
      // The whole bar is about to go away — there's no control left inside
      // it to receive focus, so fall back to whatever the caller pointed us
      // at (e.g. the panel's own heading) rather than letting focus drop to
      // <body> unannounced.
      window.setTimeout(() => fallbackFocusRef?.current?.focus(), 0);
    }
  }, [pendingTotal, pendingInCity, onDiscardCity, fallbackFocusRef]);

  // ESCAPE: backs the confirm step out by one level (same as pressing "Keep
  // editing"), matching PlaceDetailModal's precedent — it doesn't skip past
  // it and slam something shut.
  useEffect(() => {
    if (dataState !== 'confirm-discard') return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handleCancelDiscard();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dataState, handleCancelDiscard]);

  if (dataState === 'hidden') {
    // Still render the live region even while the bar itself is hidden, so
    // an announcement from a state reached moments ago (e.g. "Changes
    // saved.") isn't yanked out of the DOM before AT has a chance to read it,
    // and so this component never needs to mount/unmount around the
    // announcement itself.
    return (
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
    );
  }

  const saving = dataState === 'saving';
  const hasLocalPending = pendingInCity > 0;
  const discardHintText = hasLocalPending ? '' : `Nothing staged in ${cityLabel} to discard`;
  const showHint = !!hint && (dataState === 'pending' || dataState === 'error');
  const saveDisabled = saving || pendingTotal === 0 || (!online && dataState !== 'saved');

  return (
    <>
      <div
        id={MAP_SAVE_BAR_ID}
        className={`map-save-bar${isOffline ? ' is-offline' : ''}`}
        data-state={dataState}
        role="region"
        aria-label="Map save status"
      >
        {dataState !== 'confirm-discard' && (
          <div className="map-save-bar-row">
            <div className="map-save-bar-info">
              <div className="map-save-bar-info-row">
                {dataState === 'saved' ? (
                  <Icon name="check" className="map-save-bar-check" />
                ) : (
                  <span className="map-save-bar-dot" aria-hidden="true" />
                )}
                <span className="map-save-bar-text">
                  {pendingTotal} unsaved change{pendingTotal === 1 ? '' : 's'}
                </span>
              </div>
              {showHint && <span className="map-save-bar-subtext">{hint}</span>}
            </div>
            <div className="map-save-bar-actions">
              <button
                ref={discardBtnRef}
                type="button"
                className="btn btn-ghost"
                onClick={handleRequestDiscard}
                disabled={saving || !hasLocalPending}
                title={discardHintText || undefined}
                aria-describedby={discardHintId}
              >
                Discard ({cityLabel})
              </button>
              <span className="visually-hidden" id={discardHintId}>
                {discardHintText}
              </span>
              <button
                ref={saveBtnRef}
                type="button"
                className="btn btn-primary"
                onClick={() => void handleSave()}
                disabled={saveDisabled}
              >
                {saving ? <span className="spin" aria-hidden="true" /> : <Icon name="check" />}
                <span>{saving ? 'Saving…' : 'Save changes'}</span>
              </button>
            </div>
          </div>
        )}

        {isOffline ? (
          <p className="map-save-bar-msg">
            <Icon name="target" />
            <span>{OFFLINE_MESSAGE}</span>
          </p>
        ) : (
          dataState === 'error' && (
            <p className="map-save-bar-msg" role="alert">
              <Icon name="alert" />
              <span>{ERROR_MESSAGE}</span>
            </p>
          )
        )}

        {dataState === 'confirm-discard' && (
          <div className="map-save-bar-confirm">
            <p className="map-save-bar-confirm-text">
              <Icon name="alert" />
              <span>
                <strong>
                  Discard {pendingInCity} unsaved change{pendingInCity === 1 ? '' : 's'} in {cityLabel}?
                </strong>
                They&rsquo;ll revert to how they were last saved. This can&rsquo;t be undone.
              </span>
            </p>
            <div className="map-save-bar-confirm-actions">
              <button type="button" className="btn discard-btn" onClick={handleConfirmDiscard}>
                Discard changes
              </button>
              <button
                ref={keepEditingBtnRef}
                type="button"
                className="btn btn-primary"
                onClick={handleCancelDiscard}
              >
                Keep editing
              </button>
            </div>
          </div>
        )}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
