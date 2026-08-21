// The Map tab's "find a pin" box. Searches the trip's own saved places (see
// placeSearch.ts for the ranking and why it spans the whole trip rather than
// just the city on screen) and hands the chosen one back to MapPanel, which
// selects it, flies the map to it and flashes the marker.
//
// Deliberately NOT a geocoder — AddPlaceModal owns that. This one is offline-
// safe because it only ever reads the store.
//
// ARIA: the editable-combobox pattern. The input keeps focus at all times and
// owns every keystroke; the options are `<li role="option">` (not buttons —
// a listbox may only contain options), pointed at by `aria-activedescendant`.
// That's why each row swallows `mousedown`: a real focus move to the row
// would tear down the combobox relationship the pattern depends on.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icons';
import type { ID, LocatedPlace, Place } from '../../data/schema';
import { categoryIcon } from '../../lib/tripView';
import { searchPlaces } from './placeSearch';

interface MapSearchProps {
  /** Every place in the trip — the search spans cities on purpose. */
  places: Place[];
  /** The city the map is showing, used to rank local pins first and to label
   *  the ones that will require a city switch. */
  selectedCity: string;
  /** The marker colour for a place (its effective day's colour) so a row
   *  matches the pin it will take you to. MapPanel supplies this rather than
   *  this component re-deriving the day-colour map and the staging overlay. */
  colorForPlace: (place: Place) => string;
  onPick: (place: LocatedPlace) => void;
}

export function MapSearch({ places, selectedCity, colorForPlace, onPick }: MapSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (id: ID) => `${listId}-opt-${id}`;

  const { matches, unlocatedCount, truncated } = useMemo(
    () => searchPlaces(places, query, selectedCity),
    [places, query, selectedCity],
  );
  const trimmed = query.trim();
  const expanded = open && trimmed.length > 0;
  const active = expanded ? matches[activeIndex] : undefined;

  // A new query invalidates the old highlight — always start back at the top
  // match, which is also what Enter picks without any arrowing.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Switching cities from elsewhere (the timeline) re-ranks every result, so
  // the box would be showing a list built for a different city. Close it.
  useEffect(() => {
    setOpen(false);
  }, [selectedCity]);

  useEffect(() => {
    if (!expanded) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [expanded]);

  const pick = useCallback(
    (place: LocatedPlace) => {
      setOpen(false);
      // The query stays put: after jumping to one branch of a chain, the
      // obvious next move is to re-open the same list and try the next one.
      inputRef.current?.blur();
      onPick(place);
    },
    [onPick],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (matches.length === 0) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) => (i + delta + matches.length) % matches.length);
      return;
    }
    if (e.key === 'Enter') {
      if (!expanded || !active) return;
      e.preventDefault();
      pick(active.place);
      return;
    }
    if (e.key === 'Escape') {
      // First Escape retracts the list, a second clears the box. Clearing on
      // the first press would throw away a query the user is still editing.
      if (expanded) setOpen(false);
      else setQuery('');
      return;
    }
    if (e.key === 'Tab') setOpen(false);
  }

  function handleClear() {
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  const status = !trimmed
    ? ''
    : matches.length === 0
      ? `No saved place matches ${trimmed}`
      : `${matches.length} ${matches.length === 1 ? 'place' : 'places'} found`;

  return (
    <div className="map-search" ref={rootRef}>
      <div className="search-field map-search-field">
        <Icon name="search" className="search-field-icon" />
        <input
          ref={inputRef}
          className="text-input"
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active.place.id) : undefined}
          aria-label="Search your saved places"
          placeholder="Search your places…"
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button type="button" className="search-clear" onClick={handleClear} aria-label="Clear search">
            <Icon name="close" />
          </button>
        )}
      </div>

      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {status}
      </p>

      {expanded && (
        <div className="map-search-panel">
          {matches.length > 0 && (
            <ul className="map-search-results" id={listId} role="listbox" aria-label="Matching places">
              {matches.map((m, i) => (
                <li
                  key={m.place.id}
                  id={optionId(m.place.id)}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`map-search-result${i === activeIndex ? ' active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => pick(m.place)}
                >
                  <span className="map-search-dot" style={{ background: colorForPlace(m.place) }} aria-hidden="true">
                    <svg aria-hidden="true">
                      <use href={`#i-${categoryIcon(m.place.category)}`} />
                    </svg>
                  </span>
                  <span className="map-search-body">
                    <span className="map-search-name">{m.place.name}</span>
                    <span className="map-search-meta">
                      {m.place.category ? `${m.place.category} · ` : ''}
                      {m.place.city}
                    </span>
                  </span>
                  {/* Sets the expectation that picking this row moves the map
                      off the city the user is looking at, before it happens. */}
                  {m.otherCity && <span className="map-search-jump">Switch city</span>}
                </li>
              ))}
            </ul>
          )}

          {matches.length === 0 && (
            <p className="search-hint">
              No saved place matches &ldquo;{trimmed}&rdquo;.
              {unlocatedCount > 0 ? '' : ' Try a place, category or city name.'}
            </p>
          )}

          {/* An unpinned place can't be searched *to* — there's nowhere on the
              map to go. Saying so beats letting it look like the place was
              never saved. See placeSearch.ts. */}
          {unlocatedCount > 0 && (
            <p className="map-search-note">
              <Icon name="pin" />
              {unlocatedCount === 1
                ? '1 match has no location yet, so it isn’t on the map.'
                : `${unlocatedCount} matches have no location yet, so they aren’t on the map.`}{' '}
              Open it on the Places tab to set one.
            </p>
          )}

          {truncated && <p className="map-search-note">Showing the closest matches — keep typing to narrow it down.</p>}
        </div>
      )}
    </div>
  );
}
