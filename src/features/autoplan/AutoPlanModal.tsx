// Auto-plan modal: tunable knobs -> autoPlan() draft preview -> Accept
// commits via store.applyAutoPlan. autoPlan() itself is the frozen
// auto-plan-specialist algorithm (src/lib/autoplan.ts) — this component only
// renders the config panel and the draft it returns.

import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icons';
import { useTripStore } from '../../store/useTripStore';
import { autoPlan, DEFAULT_AUTOPLAN_CONFIG } from '../../lib/autoplan';
import type { AutoPlanConfig, DayPlan } from '../../lib/autoplan';
import { buildDayColorMap, dayColor } from '../../lib/tripView';
import { fmtWeekdayDayMonth } from '../../lib/dates';

interface AutoPlanModalProps {
  open: boolean;
  onClose: () => void;
}

type StepKey = 'maxStopsPerDay' | 'avgMinutesPerStop' | 'travelBufferMin';

export function AutoPlanModal({ open, onClose }: AutoPlanModalProps) {
  const places = useTripStore((s) => s.places);
  const days = useTripStore((s) => s.days);
  const applyAutoPlan = useTripStore((s) => s.applyAutoPlan);

  const [config, setConfig] = useState<AutoPlanConfig>(DEFAULT_AUTOPLAN_CONFIG);
  const [draft, setDraft] = useState<DayPlan[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const dayColorMap = buildDayColorMap(days);
  const placeById = new Map(places.map((p) => [p.id, p]));

  function handleClose() {
    setDraft(null);
    setAccepted(false);
    setGenerating(false);
    onClose();
  }

  function step(key: StepKey, delta: number, min: number, max: number) {
    setConfig((c) => ({ ...c, [key]: Math.min(max, Math.max(min, (c[key] ?? 0) + delta)) }));
  }

  function generate() {
    setGenerating(true);
    setAccepted(false);
    window.setTimeout(() => {
      setDraft(autoPlan(places, days, config));
      setGenerating(false);
    }, 350);
  }

  async function accept() {
    if (!draft) return;
    await applyAutoPlan(draft);
    setAccepted(true);
  }

  return (
    <Modal open={open} onClose={handleClose} labelledBy="autoplanTitle">
      <div className="modal-head">
        <h2 className="modal-title" id="autoplanTitle">
          <Icon name="sparkle" /> Auto-plan your itinerary
        </h2>
        <button className="modal-close" aria-label="Close" onClick={handleClose}>
          <Icon name="close" />
        </button>
      </div>
      <p className="modal-intro">
        We&rsquo;ll group your pinned places into efficient days based on location and the preferences below. It&rsquo;s a
        starting point &mdash; you can edit, reorder or move anything afterwards.
      </p>

      <div className="knobs">
        <div className="knob">
          <span className="field-label">Max stops per day</span>
          <div className="stepper">
            <button type="button" aria-label="Decrease max stops per day" onClick={() => step('maxStopsPerDay', -1, 1, 8)}>
              &minus;
            </button>
            <span className="val tabular">{config.maxStopsPerDay}</span>
            <button type="button" aria-label="Increase max stops per day" onClick={() => step('maxStopsPerDay', 1, 1, 8)}>
              +
            </button>
          </div>
        </div>
        <div className="knob">
          <span className="field-label">Day start time</span>
          <input
            className="time-input"
            type="time"
            style={{ width: '100%' }}
            value={config.dayStartTime}
            onChange={(e) => setConfig((c) => ({ ...c, dayStartTime: e.target.value }))}
          />
        </div>
        <div className="knob">
          <span className="field-label">Avg. minutes per stop</span>
          <div className="stepper">
            <button
              type="button"
              aria-label="Decrease average minutes per stop"
              onClick={() => step('avgMinutesPerStop', -15, 30, 180)}
            >
              &minus;
            </button>
            <span className="val tabular">{config.avgMinutesPerStop}</span>
            <button
              type="button"
              aria-label="Increase average minutes per stop"
              onClick={() => step('avgMinutesPerStop', 15, 30, 180)}
            >
              +
            </button>
          </div>
        </div>
        <div className="knob">
          <span className="field-label">Travel buffer (min)</span>
          <div className="stepper">
            <button type="button" aria-label="Decrease travel buffer" onClick={() => step('travelBufferMin', -10, 0, 60)}>
              &minus;
            </button>
            <span className="val tabular">{config.travelBufferMin ?? 0}</span>
            <button type="button" aria-label="Increase travel buffer" onClick={() => step('travelBufferMin', 10, 0, 60)}>
              +
            </button>
          </div>
        </div>
      </div>

      <div className="generate-row">
        <button className="btn btn-primary autoplan-cta" onClick={generate}>
          <Icon name="sparkle" /> Generate draft
        </button>
      </div>
      <div className={`generating${generating ? ' on' : ''}`}>
        <span className="spin" /> Grouping nearby places into days&hellip;
      </div>

      <div className={`draft${draft && !generating ? ' on' : ''}`}>
        {accepted && (
          <div className="accepted-msg on">
            <Icon name="check" /> Draft applied to your Itinerary &mdash; edit any stop there any time.
          </div>
        )}
        {draft && (
          <>
            <div className="draft-heading">
              Draft preview &middot; {draft.length} day{draft.length === 1 ? '' : 's'} planned
            </div>
            {draft.length === 0 ? (
              <p className="draft-note">
                Nothing to plan yet &mdash; add some pins with real coordinates and make sure their city has scheduled
                days.
              </p>
            ) : (
              <div className="draft-days">
                {draft.map((d) => (
                  <div className="draft-day" key={d.dayId}>
                    <div className="draft-day-head">
                      <span className="it-day-dot" style={{ background: dayColor(d.dayId, dayColorMap) }} />
                      {d.city} &middot; {fmtWeekdayDayMonth(d.date)} &middot; {d.stops.length} stop
                      {d.stops.length === 1 ? '' : 's'}
                    </div>
                    {d.stops.map((stop) => (
                      <div className="draft-stop" key={`${stop.placeId}-${stop.order}`}>
                        <span className="t tabular">{stop.startTime}</span> {placeById.get(stop.placeId)?.name ?? 'Stop'}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <p className="draft-note">
              Grouped by walking distance within each city &middot; places in a city with no scheduled days are left for
              you to plan manually.
            </p>
            <div className="draft-actions">
              <button className="btn btn-ghost" onClick={generate}>
                Regenerate
              </button>
              <button className="btn btn-primary" onClick={accept} disabled={draft.length === 0}>
                Accept draft
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
