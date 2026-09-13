// Multi-select toggle chips for the two choices a place is no longer limited
// to one of: its days and its categories. Both are `aria-pressed` buttons in a
// labelled group — the same pattern the Budget tab's filter chips use — rather
// than checkboxes, because they sit inside cards that are themselves clickable
// and a chip row reads as the choice at a glance where a select hid it.

import type { CSSProperties } from 'react';
import type { Day, ID } from '../data/schema';
import { categoryIcon, dayColor, dayLabel } from '../lib/tripView';
import { Icon } from './Icons';

interface DayChipsProps {
  /** Which days can be chosen — a city's own days. */
  days: Day[];
  /** The leg's days incl. day trips — what "Day N" counts over. */
  legDays: Day[];
  selected: ID[];
  dayColorMap: Map<ID, string>;
  /** Names the group for assistive tech, e.g. "Days for Yu Garden". */
  label: string;
  onChange: (dayIds: ID[]) => void;
  disabled?: boolean;
}

/** "Day 2" / "Day trip" / "Mon 10 Nov" — the chip face. The full label is
 *  what a screen reader and the tooltip get. */
function shortDayLabel(day: Day, legDays: Day[]): string {
  const full = dayLabel(day, legDays);
  return full.split(' · ')[0];
}

export function DayChips({ days, legDays, selected, dayColorMap, label, onChange, disabled }: DayChipsProps) {
  const chosen = new Set(selected);
  function toggle(dayId: ID) {
    const next = new Set(chosen);
    if (!next.delete(dayId)) next.add(dayId);
    onChange(days.filter((d) => next.has(d.id)).map((d) => d.id));
  }
  return (
    <div className="choice-chips" role="group" aria-label={label}>
      {days.map((d) => {
        const on = chosen.has(d.id);
        const full = dayLabel(d, legDays);
        return (
          <button
            key={d.id}
            type="button"
            className={`choice-chip${on ? ' is-on' : ''}`}
            style={{ ['--chip-tint' as string]: dayColor(d.id, dayColorMap) } as CSSProperties}
            aria-pressed={on}
            aria-label={full}
            title={full}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              toggle(d.id);
            }}
          >
            <span className="choice-chip-dot" aria-hidden="true" />
            {shortDayLabel(d, legDays)}
          </button>
        );
      })}
    </div>
  );
}

interface CategoryChipsProps {
  options: string[];
  /** In the order chosen — the first is the primary (its icon is the place's). */
  selected: string[];
  label: string;
  onChange: (categories: string[]) => void;
  disabled?: boolean;
}

export function CategoryChips({ options, selected, label, onChange, disabled }: CategoryChipsProps) {
  // A place saved before the categories were canonicalised can carry a legacy
  // value (e.g. 'Sightseeing') — keep it visible and removable rather than
  // silently re-categorising it on open.
  const all = [...options, ...selected.filter((c) => !options.includes(c))];
  function toggle(category: string) {
    onChange(selected.includes(category) ? selected.filter((c) => c !== category) : [...selected, category]);
  }
  return (
    <div className="choice-chips" role="group" aria-label={label}>
      {all.map((c) => {
        const on = selected.includes(c);
        return (
          <button
            key={c}
            type="button"
            className={`choice-chip${on ? ' is-on' : ''}`}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => toggle(c)}
          >
            <Icon name={categoryIcon(c)} className="chip-icon" />
            {c}
          </button>
        );
      })}
    </div>
  );
}
