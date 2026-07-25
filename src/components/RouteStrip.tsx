// Trip-legs strip in the topbar — the PRIMARY city selector for the Map tab.
// Mirrors the mockup's route-strip: one node per leg with a trailing
// scroll-fade cue while there's more to scroll to, and an "active" node for
// whichever city is currently driving the Map screen. The active state
// persists across tabs (it's lifted to App) so it always previews what
// Map will show when you switch to it.

import { useEffect, useRef, useState } from 'react';
import type { City } from '../data/schema';
import { fmtCompactRange } from '../lib/dates';

/** URL-safe id fragment for a city name, e.g. "Zhangjiajie" -> "zhangjiajie". */
export function citySlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

interface RouteStripProps {
  cities: City[];
  /** The city currently selected on the Map (shared with MapPanel via App). */
  selectedCity: string;
  /** Tapping a node selects that city on the Map and switches to the Map tab. */
  onSelect: (cityName: string) => void;
  /** City names with an unsaved (staged, not yet committed) Map reassignment
   *  — draws a small gold dot on that node (see the Map save-changes spec,
   *  mockup/map-save-changes.html). Shown on ANY city with something staged,
   *  active or not, so it doesn't disappear/reappear as the selection moves.
   *  Optional so every other RouteStrip caller/test is unaffected. */
  pendingCities?: ReadonlySet<string>;
}

export function RouteStrip({ cities, selectedCity, onSelect, pendingCities }: RouteStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function update() {
      if (!el) return;
      const overflowing = el.scrollWidth > el.clientWidth + 2;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      setHasOverflow(overflowing && !atEnd);
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [cities]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !selectedCity) return;
    const node = el.querySelector<HTMLElement>(`[data-city="${citySlug(selectedCity)}"]`);
    node?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
  }, [selectedCity]);

  return (
    <div
      ref={ref}
      className={`route-strip${hasOverflow ? ' has-overflow' : ''}`}
      aria-label="Trip legs · tap a city to show it on the map"
    >
      {cities.map((city) => {
        const active = selectedCity === city.name;
        const hasPending = pendingCities?.has(city.name) ?? false;
        return (
          <button
            key={city.name}
            className={`route-node${active ? ' active' : ''}${hasPending ? ' has-pending' : ''}`}
            data-city={citySlug(city.name)}
            aria-current={active ? 'true' : undefined}
            onClick={() => onSelect(city.name)}
          >
            <span className="line" />
            <span className="route-dot" />
            {hasPending && <span className="route-pending-dot" aria-hidden="true" />}
            <span className="route-city">
              {city.name}
              {hasPending && <span className="visually-hidden">, has unsaved changes</span>}
            </span>
            <span className="route-date">{fmtCompactRange(city.arrive, city.depart)}</span>
          </button>
        );
      })}
    </div>
  );
}
