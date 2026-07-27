// The single add-place flow for the whole app: opened from the Map tab's
// primary "Add place" button, from a real tap on the Leaflet map (coordinate
// already known), and from the Places tab's own "Add place" button — so
// there's only one add-place UI anywhere (per the approved mockup).
//
// Two modes:
//  - 'search' — the primary entry point: search-first, with a manual
//    fallback ("Can't find it? Enter it manually").
//  - 'pin'    — a coordinate is already known (tapped on the map); search is
//    still offered but only to auto-fill a name, the pin keeps its tapped
//    coordinate.
//
// Search consumer contract (per lib/geocode.ts's Nominatim usage-policy
// notes): debounce keystrokes ~300ms, and create a fresh AbortController per
// request, aborting the previous one, so a superseded keystroke's request is
// cancelled rather than piling up. `[]` results show the "no results" state;
// an AbortError is ignored silently; a GeocodeError (or any other rejection)
// falls back to manual entry (`suggestPlaceLocation()` supplies a city-centroid
// coordinate at save time). Offline is driven off `useOnlineStatus()`.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { Icon } from '../../components/Icons';
import { useTripStore } from '../../store/useTripStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { searchPlaces } from '../../lib/geocode';
import type { GeocodeResult } from '../../lib/geocode';
import { formatCoordinate, parseCoordinateInput } from '../../lib/coordinateInput';
import type { CoordinateParseFailure } from '../../lib/coordinateInput';
import { gcj02ToWgs84, isInsideChina } from '../../lib/gcj02';
import { haversineMeters } from '../../lib/geo';
import { PLACE_CATEGORIES, inferCityFromAddress, orderedCities, suggestPlaceLocation } from '../../lib/tripView';

export type AddPlaceMode = 'search' | 'pin';

export interface AddPlacePoint {
  lat: number;
  lng: number;
}

interface AddPlaceModalProps {
  open: boolean;
  mode: AddPlaceMode;
  point: AddPlacePoint | null;
  /** The trip city currently selected on the Map — used as the geocode
   *  search's `cityHint` (and in the coordinate hint copy). Deliberately NOT
   *  pre-selected in the City field: an unnoticed default is how a place ends
   *  up filed under the wrong city. */
  defaultCity: string;
  onClose: () => void;
}

type SearchStatus = 'idle' | 'loading' | 'results' | 'empty' | 'offline' | 'error';

const SEARCH_DEBOUNCE_MS = 300;

const SEARCH_STATUS_MESSAGES: Record<SearchStatus, string> = {
  idle: '',
  loading: 'Searching…',
  results: '',
  empty: 'No results found.',
  offline: 'Offline — search unavailable. Enter the place manually below.',
  error: "Search isn't working right now. Enter the place manually below.",
};

const COORD_FAILURE_MESSAGES: Record<Exclude<CoordinateParseFailure, 'empty'>, string> = {
  shortlink:
    'That’s a shortened Google link. Open it first, then copy the full address out of the browser’s address bar.',
  unrecognised:
    'Couldn’t read a coordinate from that. Paste a pair like 31.2304, 121.4737, or a full Google Maps link.',
  'out-of-range': 'Those numbers are out of range — latitude comes first (−90 to 90), then longitude.',
};

export function AddPlaceModal({ open, mode, point, defaultCity, onClose }: AddPlaceModalProps) {
  const trip = useTripStore((s) => s.trip);
  const places = useTripStore((s) => s.places);
  const addPlace = useTripStore((s) => s.addPlace);
  const online = useOnlineStatus();

  const [query, setQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<GeocodeResult | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [flashName, setFlashName] = useState(false);

  const [name, setName] = useState('');
  // Both start empty and are required to save. Neither is defaulted: a
  // pre-filled Category/City reads as "already answered", and the wrong
  // answer is silently accepted at a rate a deliberate choice never is.
  const [category, setCategory] = useState<string>('');
  const [city, setCity] = useState('');
  // A short, optional description only — NOT the full About/My review editor
  // the place detail modal has (Phase 4 item 3/7). Adding a place and
  // writing about it are different moments: this stays a fast, few-second
  // step; real long-form writing happens later, from the place's own card.
  const [description, setDescription] = useState('');
  // Manual entry's coordinate escape hatch. Without it a manually-added place
  // lands on the city centroid, which for a city this size is useless — and
  // Nominatim's China coverage is patchy enough that manual is the common path,
  // not the rare one.
  const [coordInput, setCoordInput] = useState('');
  // Google serves GCJ-02 for Chinese locations; our OSM tiles are WGS-84, so a
  // pasted Chinese coordinate needs the datum shift to land on the building.
  // On by default, but reversible from the UI — the offset has not been
  // verified against a real browser yet (see PHASE4.md item 9).
  const [applyChinaShift, setApplyChinaShift] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const debounceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cityNames = trip ? orderedCities(trip).map((c) => c.name) : [];

  const parsedCoord = useMemo(() => parseCoordinateInput(coordInput), [coordInput]);
  const pastedPoint = parsedCoord.ok ? { lat: parsedCoord.lat, lng: parsedCoord.lng } : null;
  const shiftAvailable = pastedPoint !== null && isInsideChina(pastedPoint);
  const shiftApplied = shiftAvailable && applyChinaShift;
  const manualPoint = pastedPoint && shiftApplied ? gcj02ToWgs84(pastedPoint) : pastedPoint;
  const coordFailureMessage =
    parsedCoord.ok || parsedCoord.reason === 'empty'
      ? `Leave this blank and the pin drops at the centre of ${city || defaultCity || 'the city'} — right city, wrong street.`
      : COORD_FAILURE_MESSAGES[parsedCoord.reason];

  function clearPendingTimers() {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    abortRef.current?.abort();
  }

  // Reset all transient state whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setSelectedResult(null);
    setManualEntry(false);
    setFlashName(false);
    setName('');
    setDescription('');
    setCoordInput('');
    setApplyChinaShift(true);
    setCategory('');
    setCity('');
    setSaving(false);
    setSaved(false);
    setSearchStatus(online ? 'idle' : 'offline');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Abort any in-flight search and pending timers when the modal closes or unmounts.
  useEffect(() => {
    if (open) return;
    clearPendingTimers();
  }, [open]);
  useEffect(() => clearPendingTimers, []);

  // React to connectivity changes while the modal is open.
  useEffect(() => {
    if (!open) return;
    if (!online) {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      abortRef.current?.abort();
      setSearchStatus('offline');
    } else {
      setSearchStatus((cur) => (cur === 'offline' ? 'idle' : cur));
    }
  }, [online, open]);

  async function runSearch(q: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const found = await searchPlaces(q, { cityHint: defaultCity || undefined, limit: 6, signal: controller.signal });
      if (controller.signal.aborted) return;
      setResults(found);
      setSearchStatus(found.length > 0 ? 'results' : 'empty');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return; // superseded — ignore silently
      setResults([]);
      setSearchStatus('error'); // GeocodeError (or anything else) — fall back to manual entry
    }
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    if (!online) {
      setSearchStatus('offline');
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      abortRef.current?.abort();
      setSearchStatus('idle');
      setResults([]);
      return;
    }
    setSearchStatus('loading');
    debounceRef.current = window.setTimeout(() => {
      void runSearch(trimmed);
    }, SEARCH_DEBOUNCE_MS);
  }

  function handleClearSearch() {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setQuery('');
    setResults([]);
    setSearchStatus(online ? 'idle' : 'offline');
  }

  function handleSelectResult(r: GeocodeResult) {
    if (mode === 'pin') {
      // The pin already has its coordinate from the tap — search here only
      // supplies a name.
      setName(r.name);
      setFlashName(true);
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlashName(false), 800);
      return;
    }
    setSelectedResult(r);
    setName(r.name);
    const inferred = inferCityFromAddress(r.address, cityNames);
    if (inferred) setCity(inferred);
  }

  function handleManualEntry() {
    setManualEntry(true);
    setSelectedResult(null);
    setName('');
  }

  function handleBackToSearch() {
    setManualEntry(false);
    setSelectedResult(null);
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || !category || !city || saving) return;
    setSaving(true);

    let lat: number;
    let lng: number;
    let address: string | undefined;
    if (mode === 'pin' && point) {
      lat = point.lat;
      lng = point.lng;
    } else if (selectedResult) {
      lat = selectedResult.lat;
      lng = selectedResult.lng;
      address = selectedResult.address;
    } else if (manualPoint) {
      lat = manualPoint.lat;
      lng = manualPoint.lng;
    } else {
      const loc = suggestPlaceLocation(city, places);
      lat = loc.lat;
      lng = loc.lng;
    }

    await addPlace({
      name: trimmedName,
      category,
      city,
      description: description.trim() || undefined,
      lat,
      lng,
      address,
    });
    setSaved(true);
    closeTimerRef.current = window.setTimeout(onClose, 900);
  }

  const missingFields = [
    !name.trim() && 'a name',
    !category && 'a category',
    !city && 'a city',
  ].filter((f): f is string => typeof f === 'string');
  const canSave = missingFields.length === 0;

  const detailsVisible = mode === 'pin' || selectedResult !== null || manualEntry;
  const searchStageVisible = mode === 'pin' || !detailsVisible;
  const titleText = mode === 'pin' ? 'Name this pin' : 'Add a place';
  const introText =
    mode === 'pin'
      ? "You dropped a pin on the map. Search to auto-fill a name, or type one in below — the pin stays exactly where you dropped it."
      : "Search for a place and we’ll pin its exact location — or enter it manually if you can’t find it.";
  const searchStatusMessage =
    searchStatus === 'results' ? `${results.length} result${results.length === 1 ? '' : 's'} found.` : SEARCH_STATUS_MESSAGES[searchStatus];

  return (
    <Modal open={open} onClose={onClose} labelledBy="addPlaceTitle">
      <div className="modal-head">
        <h2 className="modal-title" id="addPlaceTitle">
          <Icon name="pin" /> {titleText}
        </h2>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <p className="modal-intro">{introText}</p>

      {mode === 'pin' && point && (
        <div className="pin-context-card on">
          <Icon name="target" />
          <div>
            <strong>Pin dropped on the map</strong>
            <span>
              {point.lat.toFixed(4)}, {point.lng.toFixed(4)}
            </span>
          </div>
        </div>
      )}

      {searchStageVisible && (
        <div>
          <div className="search-field">
            <Icon name="search" className="search-field-icon" />
            <input
              className="text-input"
              type="text"
              placeholder="Search for a place or address…"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                className="search-clear"
                onClick={handleClearSearch}
                aria-label="Clear search"
              >
                <Icon name="close" />
              </button>
            )}
          </div>

          <p className="visually-hidden" aria-live="polite" aria-atomic="true">
            {searchStatusMessage}
          </p>

          <div className="search-panel">
            {searchStatus === 'idle' && (
              <p className="search-hint">Start typing to search &mdash; try a landmark, street, or neighbourhood name.</p>
            )}
            {searchStatus === 'loading' && (
              <div className="search-loading">
                <span className="spin" /> Searching&hellip;
              </div>
            )}
            {searchStatus === 'results' && (
              <div className="search-results">
                {results.map((r, i) => (
                  <button key={r.sourceId ?? `${r.name}-${i}`} type="button" className="search-result" onClick={() => handleSelectResult(r)}>
                    <Icon name="pin" className="search-result-icon" />
                    <span className="search-result-body">
                      <span className="search-result-name">{r.name}</span>
                      <span className="search-result-addr">{r.address}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {searchStatus === 'empty' && (
              <p className="search-hint">
                No results for &ldquo;{query}&rdquo;. Try different words, or add it manually below.
              </p>
            )}
            {(searchStatus === 'offline' || searchStatus === 'error') && (
              <div className="search-offline">
                <Icon name="map" />
                <div>
                  <strong>{searchStatus === 'offline' ? "Search needs a connection" : "Search isn't working right now"}</strong>
                  <span>
                    {searchStatus === 'offline'
                      ? "You’re offline right now. Add the place manually below — you can paste its coordinates from Google Maps to pin it exactly, or leave them blank and we’ll use the centre of the city."
                      : "We couldn’t reach the place search service. Add the place manually below — paste its coordinates from Google Maps to pin it exactly."}
                  </span>
                </div>
              </div>
            )}
          </div>

          {mode === 'search' && (
            <button type="button" className="manual-toggle" onClick={handleManualEntry}>
              <Icon name="plus" /> Can&rsquo;t find it? Enter it manually
            </button>
          )}
        </div>
      )}

      {detailsVisible && (
        <form className="add-place-details on" onSubmit={(e) => void handleSave(e)}>
          {mode === 'search' && (
            <button type="button" className="details-back" onClick={handleBackToSearch}>
              <Icon name="chevron-left" /> Back to search
            </button>
          )}

          {selectedResult && mode === 'search' ? (
            <div className="selected-card on">
              <Icon name="pin" />
              <div>
                <strong>{selectedResult.name}</strong>
                <span>{selectedResult.address}</span>
              </div>
            </div>
          ) : (
            <div className={flashName ? 'flash-confirm' : undefined}>
              <label htmlFor="ap-name">Name</label>
              <input
                className="text-input"
                type="text"
                id="ap-name"
                style={{ width: '100%' }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Shaoxing Park"
              />
            </div>
          )}

          <div className="add-form-grid" style={{ marginTop: 10 }}>
            <div>
              <label htmlFor="ap-cat">Category</label>
              <select id="ap-cat" value={category} onChange={(e) => setCategory(e.target.value)} required>
                <option value="">Choose a category&hellip;</option>
                {PLACE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ap-city">City</label>
              <select id="ap-city" value={city} onChange={(e) => setCity(e.target.value)} required>
                <option value="">Choose a city&hellip;</option>
                {cityNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {mode === 'search' && !selectedResult && (
            <div style={{ marginTop: 10 }}>
              <label htmlFor="ap-coord">
                Coordinates <span className="field-optional">(paste from Google Maps)</span>
              </label>
              <input
                className="text-input coord-input"
                type="text"
                id="ap-coord"
                value={coordInput}
                onChange={(e) => setCoordInput(e.target.value)}
                placeholder="31.2304, 121.4737 — or a Google Maps link"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="coord-status" aria-live="polite">
                {manualPoint ? (
                  <p className="coord-ok">
                    <Icon name="target" /> Pin drops at {formatCoordinate(manualPoint.lat, manualPoint.lng)}
                  </p>
                ) : (
                  <p className="coord-hint">{coordFailureMessage}</p>
                )}
                {shiftAvailable && manualPoint && pastedPoint && (
                  <p className="coord-note">
                    {shiftApplied
                      ? `Moved ${Math.round(haversineMeters(pastedPoint, manualPoint))}m to correct China’s map offset — Google’s coordinates are shifted there, ours aren’t.`
                      : 'Using the pasted numbers exactly. Google’s Chinese coordinates are normally offset, so the pin may sit a few hundred metres out.'}
                    <button type="button" className="coord-toggle" onClick={() => setApplyChinaShift((v) => !v)}>
                      {shiftApplied ? 'Use the pasted numbers instead' : 'Correct the offset'}
                    </button>
                  </p>
                )}
              </div>
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <label htmlFor="ap-description">
              Description <span className="field-optional">(optional)</span>
            </label>
            <textarea
              className="text-input add-place-description"
              id="ap-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why you want to go, best time of day, anything worth knowing before you visit — you can always write more later."
            />
          </div>

          <button type="submit" className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={!canSave || saving}>
            <Icon name="check" /> Save to wishlist
          </button>
          {/* Says what's missing rather than leaving a dead button — the two
              selects now start empty, so "why can't I save?" is a real
              question here in a way it wasn't before. */}
          {!canSave && (
            <p className="coord-hint" style={{ marginTop: 8 }}>
              Add {missingFields.join(' and ')} to save this place.
            </p>
          )}
          {saved && (
            <div className="accepted-msg on" style={{ marginTop: 12, marginBottom: 0 }}>
              <Icon name="check" /> Saved &mdash; you&rsquo;ll find it on the map and in Places any time.
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}
