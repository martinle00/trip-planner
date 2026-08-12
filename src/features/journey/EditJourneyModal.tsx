// Edit journey — the trip's legs and dates.
//
// Opens from a row in Settings, NOT from the route strip. It was tried there
// first, on the reasoning that the strip IS the journey — but a dashed node at
// the end of a row of cities reads as another city, and the control went
// unfound. Settings is where you already go to change what the trip is.
// The sheet stays its own <Modal> rather than a Settings section: a
// reorderable leg list with date arithmetic and a destructive confirm would
// dominate a surface built for small self-contained controls.
//
// EDITS ARE LOCAL UNTIL SAVE. Every control here mutates a draft leg list in
// component state; nothing is persisted until "Save changes". Applying per
// keystroke would re-chain the dates and diff the days on every tap of a
// nights stepper, queueing a write per record for intermediate journeys the
// user never asked for — and the outbox coalesces by record, so those would
// be real uploads, not just churn. One edit, one batch.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icons';
import { useTripStore } from '../../store/useTripStore';
import type { City } from '../../data/schema';
import { fmtCompactRange } from '../../lib/dates';
import {
  addLeg,
  baseLegs,
  dayTripDateRange,
  dayTripsOf,
  legNameError,
  setDayTripDate,
  moveLeg,
  removeLeg,
  setLegNights,
  setTripStart,
  totalNights,
  tripSpan,
} from '../../lib/journey';

interface EditJourneyModalProps {
  open: boolean;
  onClose: () => void;
}

/** Guardrail on the nights stepper. 30 is well past anything this trip needs
 *  and exists only so a held-down button can't run the date maths away. */
const MAX_NIGHTS = 30;

/** Fourth copy of this in the codebase (`RouteStrip`, `MapPanel`, `BackToTop`),
 *  matching them verbatim rather than inventing a fifth shape. Worth lifting
 *  into `lib/` the next time someone touches all four. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function EditJourneyModal({ open, onClose }: EditJourneyModalProps) {
  const trip = useTripStore((s) => s.trip);
  const editJourney = useTripStore((s) => s.editJourney);
  const previewJourneyEdit = useTripStore((s) => s.previewJourneyEdit);

  // The draft. Seeded from the trip each time the sheet opens (keyed on
  // `open` via the reset below) so a cancelled edit leaves nothing behind.
  const [draft, setDraft] = useState<City[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [newLegName, setNewLegName] = useState('');
  const [addError, setAddError] = useState<string | undefined>();
  /** The leg just added, for the scroll-into-view + jade pulse. Cleared once
   *  the pulse has run so re-adding the same name flashes again. */
  const [flashLeg, setFlashLeg] = useState<string | null>(null);
  /** In-progress text in a nights field, so it can be empty mid-edit without
   *  the model reading that as zero. Only ever holds the ONE field being
   *  typed in; everything else renders straight from the draft. */
  const [nightsText, setNightsText] = useState<{ leg: string; text: string } | null>(null);
  /**
   * What a screen reader is told after an action. One region for the whole
   * sheet, written explicitly by the handlers — NOT a live region per leg row.
   * Editing one leg re-dates every leg after it, so per-row regions would all
   * fire at once and bury the change the user actually made.
   */
  const [announcement, setAnnouncement] = useState('');
  const flashRef = useRef<HTMLDivElement>(null);

  // Bring the newly added leg into view and let the pulse run once. Without
  // the scroll, adding a city to a journey longer than the sheet clears the
  // field and appends the row below the fold — indistinguishable from
  // nothing having happened.
  useEffect(() => {
    if (!flashLeg) return;
    flashRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    const timer = window.setTimeout(() => setFlashLeg(null), 800);
    return () => window.clearTimeout(timer);
  }, [flashLeg]);

  // Memoised so the `plan` below doesn't recompute the whole day diff on
  // every render — the `?? []` fallback would otherwise be a fresh array each
  // time and defeat both memos.
  const cities = useMemo(() => draft ?? trip?.cities ?? [], [draft, trip?.cities]);
  const legs = useMemo(() => baseLegs(cities), [cities]);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(trip?.cities);

  // The blast radius of the draft as it currently stands. Recomputed on every
  // change so the summary line and the remove confirmation always describe
  // what Save would actually do, not a stale snapshot.
  const plan = useMemo(
    () => (dirty ? previewJourneyEdit(cities) : null),
    [dirty, cities, previewJourneyEdit],
  );

  function reset() {
    setDraft(null);
    setConfirming(null);
    setError(undefined);
    setNewLegName('');
    setAddError(undefined);
    setFlashLeg(null);
    setNightsText(null);
    setAnnouncement('');
  }

  /** One night, not zero: a leg with no nights has no days, so it would be
   *  added and then not appear anywhere in the itinerary. */
  function handleAddLeg() {
    const problem = legNameError(cities, newLegName);
    if (problem) return setAddError(problem);
    const name = newLegName.trim();
    setDraft(addLeg(cities, name, 1, span.startDate));
    setNewLegName('');
    setAddError(undefined);
    setFlashLeg(name);
    setAnnouncement(`${name} added to the end of the trip, 1 night.`);
  }

  /**
   * Shared by the steppers and the typed field so both clamp identically.
   *
   * `announce` is false while TYPING: every keystroke applies, so "14" would
   * otherwise announce "1 night" and then "14 nights" a moment apart. The
   * typed path announces once on blur instead; a stepper tap is a completed
   * action and announces immediately.
   */
  function applyNights(leg: City, nights: number, announce = true) {
    const clamped = Math.min(Math.max(nights, 0), MAX_NIGHTS);
    setDraft(setLegNights(cities, leg.name, clamped));
    if (announce) setAnnouncement(`${leg.name}: ${clamped} night${clamped === 1 ? '' : 's'}.`);
  }

  /** Position is announced because it's the thing that changed and the thing
   *  a non-sighted user can't see — the arrows themselves move focus nowhere. */
  function moveLegTo(leg: City, index: number) {
    setDraft(moveLeg(cities, leg.name, index));
    setAnnouncement(`${leg.name} moved to position ${index + 1} of ${legs.length}.`);
  }

  function handleClose() {
    reset();
    onClose();
  }

  if (!trip) return null;

  const span = tripSpan(cities, trip.startDate);
  const nights = totalNights(cities);

  async function handleSave() {
    if (!draft) return handleClose();
    setSaving(true);
    setError(undefined);
    try {
      await editJourney(draft);
      reset();
      onClose();
    } catch (err) {
      // Left open with the draft intact — a failed save must never look like
      // a successful one, and retyping the whole journey is not a fair ask.
      setError(err instanceof Error ? err.message : 'Could not save the journey');
    } finally {
      setSaving(false);
    }
  }

  /** The cost of removing `name`, in the user's terms. Computed against the
   *  draft, so removing two legs describes the combined result. */
  function removalSummary(name: string): string[] {
    const after = removeLeg(cities, name);
    const preview = previewJourneyEdit(after);
    const alreadyPlanned = plan?.days.delete.length ?? 0;
    const days = preview.days.delete.length - alreadyPlanned;
    const stops = preview.itineraryToDelete.length - (plan?.itineraryToDelete.length ?? 0);
    const orphans = preview.orphanedPlaces.length - (plan?.orphanedPlaces.length ?? 0);
    const expenses = preview.orphanedExpenses.length - (plan?.orphanedExpenses.length ?? 0);

    const lines: string[] = [];
    if (days > 0) lines.push(`${days} day${days === 1 ? '' : 's'} removed from the trip.`);
    if (stops > 0) lines.push(`${stops} itinerary stop${stops === 1 ? '' : 's'} deleted.`);
    if (orphans > 0) {
      lines.push(
        `${orphans} saved place${orphans === 1 ? '' : 's'} kept, moved to “Not on this trip”.`,
      );
    }
    if (expenses > 0) {
      lines.push(`${expenses} expense${expenses === 1 ? '' : 's'} moved to “Whole trip”.`);
    }
    const child = dayTripsOf(cities, name);
    if (child.length > 0) {
      lines.push(`The ${child.map((c) => c.name).join(' and ')} day trip goes with it.`);
    }
    return lines;
  }

  return (
    <Modal open={open} onClose={handleClose} labelledBy="editJourneyTitle">
      <div className="modal-head">
        <h3 id="editJourneyTitle">Edit journey</h3>
        <button className="icon-btn" onClick={handleClose} aria-label="Close edit journey">
          <Icon name="close" />
        </button>
      </div>

      <section className="settings-section">
        <h4 className="settings-section-title">Trip start</h4>
        <p className="panel-hint">
          Legs run back to back, so moving the start shifts the whole trip.
        </p>
        <div className="field-row">
          <label className="field-label" htmlFor="journeyStart">Departs</label>
          <input
            id="journeyStart"
            type="date"
            value={span.startDate}
            onChange={(e) => {
              if (!e.target.value) return;
              setDraft(setTripStart(cities, e.target.value));
            }}
          />
        </div>
      </section>

      <section className="settings-section">
        <h4 className="settings-section-title">Legs</h4>
        <p className="panel-hint">
          Set how many nights you&rsquo;re staying; the dates follow. Removing a leg keeps
          its saved places.
        </p>

        <div className="journey-legs">
          {legs.map((leg, index) => {
            const children = dayTripsOf(cities, leg.name);
            const isConfirming = confirming === leg.name;
            return (
              <div
                className={`journey-leg${flashLeg === leg.name ? ' flash-confirm' : ''}`}
                key={leg.name}
                ref={flashLeg === leg.name ? flashRef : undefined}
              >
                <div className="journey-leg-main">
                  <div className="journey-leg-reorder">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Move ${leg.name} earlier`}
                      disabled={index === 0}
                      onClick={() => moveLegTo(leg, index - 1)}
                    >
                      <Icon name="chevron-right" className="journey-arrow-up" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Move ${leg.name} later`}
                      disabled={index === legs.length - 1}
                      onClick={() => moveLegTo(leg, index + 1)}
                    >
                      <Icon name="chevron-right" className="journey-arrow-down" />
                    </button>
                  </div>

                  <div className="journey-leg-id">
                    {/* `title` is the desktop fallback for a name the column
                        ellipsises. The full name is in the accessible tree
                        regardless — the truncation is CSS-only. */}
                    <span className="journey-leg-name" title={leg.name}>{leg.name}</span>
                    <span className="journey-leg-dates">
                      {leg.nights > 0
                        ? fmtCompactRange(leg.arrive, leg.depart)
                        : 'no nights'}
                    </span>
                  </div>

                  <div className="journey-nights" role="group" aria-label={`Nights in ${leg.name}`}>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`One fewer night in ${leg.name}`}
                      disabled={leg.nights === 0}
                      onClick={() => applyNights(leg, leg.nights - 1)}
                    >
                      <Icon name="minus" />
                    </button>
                    {/* Typed, not only stepped. 1 → 10 nights was ten taps of
                        a 26px button on a phone; the steppers stay for the ±1
                        nudge that is most of the real usage. `inputMode`
                        rather than type="number" — the spinner arrows would
                        be a third, tinier copy of the two buttons either
                        side of it. */}
                    <input
                      className="journey-nights-value"
                      type="text"
                      inputMode="numeric"
                      value={nightsText?.leg === leg.name ? nightsText.text : String(leg.nights)}
                      aria-label={`Number of nights in ${leg.name}`}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 2);
                        // Over the cap, the KEYSTROKE is rejected — the field
                        // keeps what it had. Snapping to "30" instead showed a
                        // number the user hadn't typed either digit of: press
                        // 9 then 9 and the box reads 30. Typing "30" itself
                        // never reaches here (3, then 0, are both ≤ 30), so
                        // this only affects genuinely unreachable values.
                        if (digits !== '' && Number(digits) > MAX_NIGHTS) return;
                        // Normalised so a stray leading zero can't sit in the
                        // field ("03") until blur reformats it.
                        const text = digits === '' ? '' : String(Number(digits));
                        // Held locally so the field can be EMPTY mid-edit.
                        // Committing '' as 0 would re-chain the whole trip
                        // every time someone cleared the box to retype it.
                        setNightsText({ leg: leg.name, text });
                        if (text !== '') applyNights(leg, Number(text), false);
                      }}
                      onBlur={() => {
                        // Announce the settled value, once, and only if this
                        // field is the one that was actually being typed in.
                        if (nightsText?.leg === leg.name) {
                          setAnnouncement(
                            `${leg.name}: ${leg.nights} night${leg.nights === 1 ? '' : 's'}.`,
                          );
                        }
                        setNightsText(null);
                      }}
                    />
                    <span className="journey-nights-unit">
                      night{leg.nights === 1 ? '' : 's'}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`One more night in ${leg.name}`}
                      disabled={leg.nights >= MAX_NIGHTS}
                      onClick={() => applyNights(leg, leg.nights + 1)}
                    >
                      <Icon name="plus" />
                    </button>
                  </div>

                  <button
                    type="button"
                    className="icon-btn journey-leg-remove"
                    aria-label={`Remove ${leg.name}`}
                    onClick={() => setConfirming(isConfirming ? null : leg.name)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>

                {children.length > 0 && (
                  <div className="journey-leg-children">
                    {children.map((child) => {
                      const range = dayTripDateRange(leg);
                      return (
                      <div className="journey-daytrip" key={child.name}>
                        <span className="journey-daytrip-label">
                          Day trip &middot; {child.name}
                          {/* Says WHY the date is greyed out. The disabled
                              state is otherwise a dead end: the fix is a
                              night on the parent, which is a different
                              control in a different part of the row. */}
                          {leg.nights === 0 && (
                            <span className="journey-daytrip-blocked">
                              {' '}&mdash; give {leg.name} a night to place this
                            </span>
                          )}
                        </span>
                        {/* The one date in the sheet that IS typed. A day trip
                            consumes no nights, so which of its parent's days it
                            falls on is a free choice, not a consequence —
                            min/max pin it to days the parent actually has. */}
                        <input
                          type="date"
                          className="journey-daytrip-date"
                          value={child.arrive}
                          min={range.min}
                          max={range.max}
                          disabled={leg.nights === 0}
                          aria-label={`Date of the ${child.name} day trip`}
                          onChange={(e) => {
                            if (!e.target.value) return;
                            setDraft(setDayTripDate(cities, child.name, e.target.value));
                          }}
                        />
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Remove the ${child.name} day trip`}
                          onClick={() => setConfirming(confirming === child.name ? null : child.name)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                )}

                {(isConfirming || children.some((c) => c.name === confirming)) && (
                  <RemoveConfirm
                    name={confirming!}
                    isDayTrip={children.some((c) => c.name === confirming)}
                    lines={removalSummary(confirming!)}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => {
                      setDraft(removeLeg(cities, confirming!));
                      setAnnouncement(`${confirming} removed.`);
                      setConfirming(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {legs.length === 0 && (
          <p className="panel-hint">
            Every leg has been removed. Add a city below, or close without saving.
          </p>
        )}

        {/* Sits at the BOTTOM of the list because that's where the new leg
            lands — `addLeg` appends, and the reorder arrows move it from
            there. A form that added into the middle would need a position
            control duplicating those arrows. */}
        <form
          className="journey-add"
          onSubmit={(e) => {
            e.preventDefault();
            handleAddLeg();
          }}
        >
          <input
            className="journey-add-name"
            value={newLegName}
            onChange={(e) => {
              setNewLegName(e.target.value);
              setAddError(undefined);
            }}
            placeholder="Add a city"
            aria-label="New city name"
            aria-invalid={addError ? true : undefined}
            aria-describedby="journeyAddHint"
          />
          <button type="submit" className="btn btn-ghost btn-sm" disabled={!newLegName.trim()}>
            <Icon name="plus" />
            Add
          </button>
        </form>
        {/* Same id either way, so `aria-describedby` keeps pointing at whichever
            is showing — the hint when the field is clean, the reason when it
            isn't. `role="alert"` announces the error immediately; the
            description is what gets re-read on a later visit to the field. */}
        {addError ? (
          <p id="journeyAddHint" className="journey-add-error" role="alert">
            {addError}
          </p>
        ) : (
          <p id="journeyAddHint" className="panel-hint journey-add-hint">
            Goes on the end with one night; move it with the arrows and set the nights there.
          </p>
        )}
      </section>

      {/* Actions the user takes with a button but can only verify by LOOKING —
          a nights change, a reorder, an add, a removal. The visible summary
          below is live too, but it only ever reports the trip-wide total. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>

      <div className="journey-summary" aria-live="polite">
        <strong>
          {nights} night{nights === 1 ? '' : 's'}
        </strong>
        {legs.length > 0 && (
          <span> &middot; {fmtCompactRange(span.startDate, span.endDate)}</span>
        )}
        {plan && (plan.days.delete.length > 0 || plan.days.create.length > 0) && (
          <span className="journey-summary-delta">
            {plan.days.delete.length > 0 && ` · ${plan.days.delete.length} day${plan.days.delete.length === 1 ? '' : 's'} removed`}
            {plan.days.create.length > 0 && ` · ${plan.days.create.length} day${plan.days.create.length === 1 ? '' : 's'} added`}
          </span>
        )}
      </div>

      <div className="modal-foot">
        {error && (
          <p className="save-error" role="alert">
            <Icon name="alert" />
            {error}
          </p>
        )}
        <div className="modal-foot-actions">
          <button className="btn btn-ghost" onClick={handleClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface RemoveConfirmProps {
  name: string;
  /** Day trips are never called "legs" anywhere else in this sheet — the row
   *  above reads "Day trip · Wulong" — so the confirm button can't either. */
  isDayTrip: boolean;
  lines: string[];
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The blast radius, stated in facts rather than a generic "are you sure".
 * The user is about to delete days of planning; "2 days · 5 stops deleted, 2
 * places kept" is the difference between an informed choice and a gamble.
 */
function RemoveConfirm({ name, isDayTrip, lines, onCancel, onConfirm }: RemoveConfirmProps) {
  // Labelled BY the visible heading rather than a parallel aria-label, which
  // read out as "Confirm removing Beijing, group — Remove Beijing?".
  const titleId = `journeyConfirm-${name.replace(/\s+/g, '-')}`;
  return (
    <div className="journey-confirm" role="group" aria-labelledby={titleId}>
      <strong className="journey-confirm-title" id={titleId}>Remove {name}?</strong>
      {lines.length > 0 ? (
        <ul className="journey-confirm-list">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="journey-confirm-list">Nothing else is affected.</p>
      )}
      <div className="journey-confirm-actions">
        <button type="button" className="btn delete-btn btn-sm" onClick={onConfirm}>
          Remove {isDayTrip ? 'day trip' : 'leg'}
        </button>
        {/* Primary styling on the SAFE choice, matching the place-card
            delete confirm — the destructive one shouldn't be the one your
            thumb lands on by default. */}
        <button type="button" className="btn btn-primary btn-sm" autoFocus onClick={onCancel}>
          Keep it
        </button>
      </div>
    </div>
  );
}
