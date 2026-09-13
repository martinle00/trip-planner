// The Map tab — the app's "home screen". Real react-leaflet + OSM tiles
// (online-only, per spec). The top route-strip timeline (in App) is the
// PRIMARY city selector — `selectedCity` is passed down from there so the
// timeline and map stay in sync; day chips dim/emphasize pins for that day;
// clicking a pin opens a detail card with day chips (a place can span several
// days). Both the
// header "Add place" button and a real tap on the map open the shared
// AddPlaceModal (search entry point, and pin entry point with the tapped
// coordinate already known) instead of jumping to the Places tab. Offline
// shows a fallback message instead of the live map (data itself stays
// available via the other tabs).
//
// STAGED CHANGES (approved via mockup/map-save-changes.html): the day-assign
// select below no longer writes through immediately — it calls the store's
// `stagePlaceAssignment`, and every pin/select/chip in this file reads a
// place's EFFECTIVE day (`getEffectiveDayId` — the staged value if one is
// pending, else the saved `dayId`) instead of `place.dayId` directly, so a
// staged reassignment is reflected everywhere at once, before Save is ever
// pressed. `<MapSaveBar>` (a separate, store-agnostic component) is the only
// thing that actually commits or reverts staging.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import {
  getEffectiveDayId,
  getEffectiveDayIds,
  getStagedAssignmentCount,
  getStagedAssignmentCountForCity,
  useTripStore,
} from '../../store/useTripStore';
import { Icon } from '../../components/Icons';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { AddPlaceMode, AddPlacePoint } from '../places/AddPlaceModal';
import type { Day, ID, LocatedPlace, Place } from '../../data/schema';
import { hasLocation, placeCategories } from '../../data/schema';
import { DayChips } from '../../components/ChoiceChips';
import { buildPlaceDayIndex } from '../../lib/placeDays';
import { buildDayColorMap, cityFocusPoint, dayColor, dayLabel, daysForCity, daysForLeg } from '../../lib/tripView';
import { fmtCompactRange, fmtShortNumeric, parseISODate } from '../../lib/dates';
import { buildPinIcon } from './markerIcon';
import { MapSaveBar, MAP_SAVE_BAR_ID } from './MapSaveBar';
import { MapSearch } from './MapSearch';
import { crossCityHint, isPlacePending } from './mapStaging';
import type { StagedAssignments } from './mapStaging';

const DEFAULT_CENTER: [number, number] = [30.5, 112];
const DEFAULT_ZOOM = 5;
/** Zoom a focused pin is guaranteed at least — close enough to read the street
 *  it's on, but never zooms BACK out if the user was already closer in. */
const FOCUS_ZOOM = 15;
/** How long the focused pin keeps its flash ring. Long enough to find with
 *  your eyes after the pan settles, short enough not to become chrome. */
const FLASH_MS = 2600;

/** A request to put a specific pin in front of the user: select it, move the
 *  map to it and flash it. Carries a nonce so asking for the SAME place twice
 *  in a row still re-fires — otherwise a second "View on map" on a place
 *  that's already selected would do nothing visible. */
export interface MapFocusRequest {
  placeId: ID;
  nonce: number;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

interface MapPanelProps {
  /** The city currently selected on the route-strip timeline (lifted to App). */
  selectedCity: string;
  onOpenAutoPlan: (trigger?: HTMLElement | null) => void;
  onOpenAddPlace: (mode: AddPlaceMode, point?: AddPlacePoint) => void;
  onJumpToItinerary: (anchorId: string) => void;
  /** A pin to jump to on arrival — set by the Places tab's "View on map".
   *  App is expected to have pointed `selectedCity` at that place's city in
   *  the same update. Cleared via `onFocusHandled` so it can't re-fire when
   *  the user later comes back to this tab. */
  focusRequest?: MapFocusRequest | null;
  onFocusHandled?: () => void;
  /** Lets a search hit in another city switch the map there (App owns
   *  `selectedCity`). Without it the search box is city-local. */
  onSelectCity?: (city: string) => void;
}

export function MapPanel({
  selectedCity,
  onOpenAutoPlan,
  onOpenAddPlace,
  onJumpToItinerary,
  focusRequest = null,
  onFocusHandled,
  onSelectCity,
}: MapPanelProps) {
  const trip = useTripStore((s) => s.trip);
  const places = useTripStore((s) => s.places);
  const days = useTripStore((s) => s.days);
  const itineraryByDay = useTripStore((s) => s.itineraryByDay);
  const stagedAssignments = useTripStore((s) => s.stagedAssignments);
  const stagePlaceAssignment = useTripStore((s) => s.stagePlaceAssignment);
  const discardStagedAssignmentsForCity = useTripStore((s) => s.discardStagedAssignmentsForCity);
  const saveStagedAssignments = useTripStore((s) => s.saveStagedAssignments);
  const online = useOnlineStatus();

  const placeDayIndex = useMemo(() => buildPlaceDayIndex(itineraryByDay, days), [itineraryByDay, days]);
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  // The pin the map camera should move to, and the one wearing the transient
  // flash ring. Separate from `selectedPlaceId` because selection is sticky
  // (it drives the detail panel) while these two are one-shot.
  const [focusTarget, setFocusTarget] = useState<MapFocusRequest | null>(null);
  const [flashPlaceId, setFlashPlaceId] = useState<string | null>(null);
  const focusNonceRef = useRef(0);
  // A pin asked for while the map was still on ANOTHER city. Held in a ref,
  // not state, because the city switch it triggers lands in the same commit
  // as the reset effect below — which would otherwise clear the very
  // selection the user just asked for.
  const pendingFocusRef = useRef<string | null>(null);
  // Focused when a Discard empties the Save bar entirely (nothing staged left
  // anywhere) — there's no control left inside the bar to land focus on.
  const panelTitleRef = useRef<HTMLHeadingElement>(null);

  // Reset the day/pin selection whenever the timeline switches cities — unless
  // the switch was itself a jump to a specific pin, which survives it.
  useEffect(() => {
    setSelectedDayId(null);
    setSelectedPlaceId(pendingFocusRef.current);
    pendingFocusRef.current = null;
  }, [selectedCity]);

  /** Puts one pin in front of the user: selects it, clears any day filter
   *  hiding it, moves the camera and flashes the marker. Switches cities
   *  first when the pin isn't in the one on screen. */
  const focusPlace = useCallback(
    (placeId: ID, city: string) => {
      if (city !== selectedCity) {
        // Read back by the `selectedCity` effect above, in the commit the
        // city switch causes.
        pendingFocusRef.current = placeId;
        onSelectCity?.(city);
      }
      setSelectedDayId(null);
      setSelectedPlaceId(placeId);
      focusNonceRef.current += 1;
      setFocusTarget({ placeId, nonce: focusNonceRef.current });
      setFlashPlaceId(placeId);
    },
    [selectedCity, onSelectCity],
  );

  // Declared AFTER the city-reset effect on purpose: both run in the same
  // commit when App switches tab, city and focus at once, and effects fire in
  // declaration order, so this one gets the last word on the selection.
  useEffect(() => {
    if (!focusRequest) return;
    focusPlace(focusRequest.placeId, selectedCity);
    onFocusHandled?.();
    // `focusPlace`/`selectedCity` are intentionally not deps: this fires once
    // per distinct request, and App has already pointed `selectedCity` at the
    // place's city. Re-running on a later city change would drag the map back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useEffect(() => {
    if (!flashPlaceId) return;
    const timer = window.setTimeout(() => setFlashPlaceId(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashPlaceId]);

  const dayColorMap = useMemo(() => buildDayColorMap(days), [days]);
  const cityDays = useMemo(() => daysForCity(days, selectedCity), [days, selectedCity]);
  // Chips/markers filter on cityDays (a day trip's stops belong to the
  // day-trip city), but "Day N" counts over legDays so the day trip doesn't
  // renumber the days after it.
  const legDays = useMemo(() => daysForLeg(days, selectedCity), [days, selectedCity]);
  const cityPlaces = useMemo(() => places.filter((p) => p.city === selectedCity), [places, selectedCity]);
  // Only pinned places reach Leaflet. A place can exist without coordinates
  // (a chain whose branch isn't chosen yet — see `Place.lat`); it stays on
  // the Places tab and is counted below the map rather than being pinned to
  // a made-up spot.
  const cityPinnedPlaces = useMemo(() => cityPlaces.filter(hasLocation), [cityPlaces]);
  const unpinnedCount = cityPlaces.length - cityPinnedPlaces.length;
  const selectedPlace = places.find((p) => p.id === selectedPlaceId) ?? null;
  const selectedDay = days.find((d) => d.id === selectedDayId) ?? null;
  const cityMeta = trip?.cities.find((c) => c.name === selectedCity);

  const totalPending = getStagedAssignmentCount(stagedAssignments);
  const pendingInCity = getStagedAssignmentCountForCity(stagedAssignments, selectedCity);
  const saveBarHint = crossCityHint(stagedAssignments, selectedCity);
  const selectedPlacePending = selectedPlace ? isPlacePending(selectedPlace.id, stagedAssignments) : false;

  function handleSelectDay(dayId: string | null) {
    setSelectedDayId(dayId);
    setSelectedPlaceId(null);
  }
  function handleSelectPlace(id: string) {
    setSelectedPlaceId(id);
  }

  function handleMapTap(lat: number, lng: number) {
    setSelectedPlaceId(null);
    onOpenAddPlace('pin', { lat, lng });
  }

  /** Scrolls the sticky Save bar into view and, if it's not disabled, moves
   *  focus to its Save button — used by the pin-detail panel's "Unsaved
   *  change" pill so a change staged from a pin far from the bar is easy to
   *  act on immediately. */
  function handleJumpToSaveBar() {
    const bar = document.getElementById(MAP_SAVE_BAR_ID);
    if (!bar) return;
    bar.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'end' });
    const saveBtn = bar.querySelector<HTMLButtonElement>('.map-save-bar-actions .btn-primary');
    if (saveBtn && !saveBtn.disabled) {
      window.setTimeout(() => saveBtn.focus(), 250);
    }
  }

  if (!trip) return null;

  return (
    <section className="panel" id="panel-map" role="tabpanel" aria-labelledby="tab-map">
      {/* PHASE 6 item 1 — no-new-chrome a11y mitigation for the panel-head
          Add-place button below. Once the panel head scrolls out of view, a
          keyboard-only/screen-reader user has no way back to Add-place
          without scrolling all the way up — see the button's own comment for
          why that gap is an accepted trade-off, not an oversight. This is the
          standard "skip to content" idiom: clipped off-screen at rest
          (`.skip-to-add`), reachable only via Tab, invisible to a sighted
          mouse user. First Tab stop in the whole panel. */}
      <a className="skip-to-add" href="#map-add-place-btn">
        Skip to Add place
      </a>
      <div className="panel-head">
        <div>
          <h2 className="panel-title" ref={panelTitleRef} tabIndex={-1}>
            Map
          </h2>
          <span className="panel-hint">Your home screen &middot; tap a city in the timeline above to change what&rsquo;s shown</span>
        </div>
        <button
          type="button"
          id="map-add-place-btn"
          className="btn btn-primary btn-sm"
          onClick={() => onOpenAddPlace('search')}
        >
          <Icon name="plus" /> Add place
        </button>
      </div>

      <div className="map-showing" aria-live="polite" aria-atomic="true">
        <span className="map-showing-dot" />
        Showing <strong>{selectedCity || '—'}</strong>
        {cityMeta && <span className="range">&middot; {fmtCompactRange(cityMeta.arrive, cityMeta.depart)}</span>}
      </div>

      {/* Finds a saved pin by name instead of hunting for it among the day
          colours. Spans the whole trip, so a hit in another city switches the
          map there first — see placeSearch.ts. */}
      <MapSearch
        places={places}
        selectedCity={selectedCity}
        colorForPlace={(p) => dayColor(getEffectiveDayId(p, stagedAssignments), dayColorMap)}
        onPick={(p) => focusPlace(p.id, p.city)}
      />

      {/* Promotes the day-filter chips into their own sticky sub-bar under the
          (also sticky) tabbar — same pattern as the Itinerary tab's existing
          #itQuickNav/.it-quicknav (index.css ~L649), just applied to Map.
          Map-tab-only (this lives in MapPanel, not App's shared chrome), so
          the global header's height stays tab-independent regardless of
          which tab is active — see mockup/header-nav-hierarchy.html
          #v3-condense. Chips only — the trailing Add-place affordance this
          sub-bar briefly carried in Phase 5 is gone; Add-place now lives
          solely in `.panel-head` above (PHASE6 item 1). */}
      {cityDays.length > 0 && (
        <div className="map-day-quicknav" id="mapDayQuicknav" aria-label="Filter pins by day">
          <div className="map-day-quicknav-chips">
            <button
              className={`chip day-all${selectedDayId === null ? ' active' : ''}`}
              onClick={() => handleSelectDay(null)}
            >
              All days
            </button>
            {cityDays.map((d) => (
              <button
                key={d.id}
                className={`chip${selectedDayId === d.id ? ' active' : ''}`}
                onClick={() => handleSelectDay(d.id)}
              >
                <span className="chip-dot" style={{ background: dayColor(d.id, dayColorMap) }} />
                {/* PHASE6 item 3 — mobile shows only the short numeric date
                    ("9/11"); the full `dayLabel` text stays in the DOM,
                    clipped (never display:none'd), because today it's the
                    chip's ENTIRE accessible name (only the wrapping group
                    carries an aria-label). Desktop shows the full label and
                    hides the short one — pure decorative duplicate there, so
                    display:none is fine for everyone on that viewport. */}
                <span className="chip-date-full">{dayLabel(d, legDays)}</span>
                <span className="chip-date-short" aria-hidden="true">
                  {fmtShortNumeric(d.date)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="map-layout">
        <div>
          <div className="map-stage-wrap">
            {online ? (
              <div className="map-container-outer">
                <div className="map-badge">
                  <Icon name="map" /> Map: <b>OpenStreetMap</b>
                </div>
                <LeafletMap
                  places={cityPinnedPlaces}
                  cityDays={cityDays}
                  legDays={legDays}
                  dayColorMap={dayColorMap}
                  stagedAssignments={stagedAssignments}
                  placeDayIndex={placeDayIndex}
                  selectedDayId={selectedDayId}
                  selectedPlaceId={selectedPlaceId}
                  focusTarget={focusTarget}
                  flashPlaceId={flashPlaceId}
                  onSelectPlace={handleSelectPlace}
                  onMapClick={handleMapTap}
                  cityName={selectedCity}
                />
                <button
                  type="button"
                  className="btn btn-sm autoplan-cta map-fab"
                  onClick={(e) => onOpenAutoPlan(e.currentTarget)}
                >
                  <Icon name="sparkle" /> Auto-plan
                </button>
              </div>
            ) : (
              <div className="map-empty">
                <Icon name="map" />
                <strong>You&rsquo;re offline</strong>
                <span>The live map needs a connection. Your places, itinerary and budget are still saved on this device.</span>
              </div>
            )}
          </div>

          {unpinnedCount > 0 && (
            <p className="map-unpinned-note">
              <Icon name="pin" />
              {unpinnedCount === 1
                ? '1 place in this city has no location yet, so it isn’t on the map.'
                : `${unpinnedCount} places in this city have no location yet, so they aren’t on the map.`}{' '}
              Open it on the Places tab to set one.
            </p>
          )}

          {cityDays.length > 0 && (
            <div className="legend" id="mapLegend">
              {cityDays.map((d) => (
                <div className="legend-item" key={d.id}>
                  <span className="legend-dot" style={{ background: dayColor(d.id, dayColorMap) }} />
                  {dayLabel(d, legDays)}
                </div>
              ))}
              <div className="legend-item">
                <span className="legend-dot dashed" />
                Unassigned
              </div>
              <div className="legend-item">
                <span className="legend-dot pending-ring" aria-hidden="true" />
                Unsaved change
              </div>
            </div>
          )}
        </div>

        <PinDetailPanel
          place={selectedPlace}
          effectivePlaceDayIds={selectedPlace ? getEffectiveDayIds(selectedPlace, stagedAssignments, placeDayIndex) : []}
          pending={selectedPlacePending}
          selectedDay={selectedDay}
          cityDays={cityDays}
          legDays={legDays}
          dayColorMap={dayColorMap}
          itineraryByDay={itineraryByDay}
          onSetDays={(dayIds) => selectedPlace && stagePlaceAssignment(selectedPlace.id, dayIds)}
          onClose={() => setSelectedPlaceId(null)}
          onClearDayFilter={() => handleSelectDay(null)}
          onOpenInItinerary={(city) => onJumpToItinerary(`it-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)}
          onJumpToSaveBar={handleJumpToSaveBar}
        />
      </div>

      {/* Second identically-hidden skip link, after the map/legend/pin-detail
          content and before the Save bar — closes the "already tabbed deep
          into the panel" half of the gap the first skip link (top of panel)
          can't reach on its own. Same clip/reveal-on-focus treatment as the
          one above, so it costs zero additional visible chrome and is NOT a
          second Add-place *control* (PHASE6.md trap #3 forbids a second
          visible affordance — a hidden skip-link isn't one). The mockup's
          version of this sits after a scrollable list of pin cards; this
          panel has no equivalent list (pins live on the Leaflet map, not as
          a DOM list), so the nearest analogous "end of this panel's real
          content" position is here, right before the Save bar. */}
      <a className="skip-to-add" href="#map-add-place-btn">
        Back to Add place
      </a>

      <MapSaveBar
        pendingTotal={totalPending}
        pendingInCity={pendingInCity}
        cityLabel={selectedCity}
        hint={saveBarHint}
        online={online}
        onSave={saveStagedAssignments}
        onDiscardCity={() => discardStagedAssignmentsForCity(selectedCity)}
        fallbackFocusRef={panelTitleRef}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------

interface LeafletMapProps {
  places: LocatedPlace[];
  cityDays: Day[];
  /** The leg's days incl. its day trips — what "Day N" counts over. */
  legDays: Day[];
  dayColorMap: Map<string, string>;
  stagedAssignments: StagedAssignments;
  /** Saved days per place — see `buildPlaceDayIndex`. */
  placeDayIndex: Map<ID, ID[]>;
  selectedDayId: string | null;
  selectedPlaceId: string | null;
  /** Camera request — see `MapFocusRequest` and `FlyToPlace`. */
  focusTarget: MapFocusRequest | null;
  /** The pin currently wearing the transient "here it is" ring. */
  flashPlaceId: string | null;
  onSelectPlace: (id: string) => void;
  onMapClick: (lat: number, lng: number) => void;
  /** The selected city — used to centre the map when it has no pins yet. */
  cityName: string;
}

function LeafletMap({
  places,
  cityDays,
  legDays,
  dayColorMap,
  stagedAssignments,
  placeDayIndex,
  selectedDayId,
  selectedPlaceId,
  focusTarget,
  flashPlaceId,
  onSelectPlace,
  onMapClick,
  cityName,
}: LeafletMapProps) {
  return (
    <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="leaflet-container" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitToPlaces places={places} cityName={cityName} />
      {/* After FitToPlaces on purpose: when a focus request arrives together
          with a city switch, both effects run in the same commit and this one
          has to win the camera. */}
      <FlyToPlace target={focusTarget} places={places} />
      <ClickToAdd onMapClick={onMapClick} />
      {places.map((p) => {
        const effDayIds = getEffectiveDayIds(p, stagedAssignments, placeDayIndex);
        const onSelectedDay = selectedDayId !== null && effDayIds.includes(selectedDayId);
        // A place on several days wears the filtered day's colour while that
        // day is picked, and its primary day's otherwise.
        const effDayId = onSelectedDay ? selectedDayId : getEffectiveDayId(p, stagedAssignments);
        const pending = isPlacePending(p.id, stagedAssignments);
        const day = cityDays.find((d) => d.id === effDayId);
        const color = dayColor(effDayId, dayColorMap);
        const unassigned = !effDayId;
        const emph = selectedDayId ? onSelectedDay : false;
        const dim = selectedDayId ? !onSelectedDay : false;
        const extraDays = effDayIds.length - 1;
        const badgeText = day ? String(parseISODate(day.date).getDate()) : undefined;
        const tooltipText =
          (day ? dayLabel(day, legDays) : 'Unassigned') +
          (extraDays > 0 ? ` +${extraDays} more day${extraDays === 1 ? '' : 's'}` : '') +
          (pending ? ' (unsaved)' : '');
        return (
          <Marker
            key={p.id}
            position={[p.lat, p.lng]}
            icon={buildPinIcon({
              color,
              category: placeCategories(p)[0],
              unassigned,
              badgeText,
              selected: p.id === selectedPlaceId,
              emph,
              dim,
              pending,
              flash: p.id === flashPlaceId,
            })}
            // Leaflet stacks markers by latitude; without this the pin the
            // user just asked for can sit behind a neighbour.
            zIndexOffset={p.id === selectedPlaceId ? 1000 : 0}
            eventHandlers={{ click: () => onSelectPlace(p.id) }}
          >
            <Tooltip direction="top" offset={[0, -14]}>
              {p.name} &middot; {tooltipText}
            </Tooltip>
          </Marker>
        );
      })}
    </MapContainer>
  );
}

function FitToPlaces({ places, cityName }: { places: LocatedPlace[]; cityName: string }) {
  const map = useMap();
  useEffect(() => {
    if (places.length === 0) {
      // Nothing pinned here yet — show the city itself rather than the whole
      // country. This is the normal state for a day-trip leg (Wulong,
      // Shenzhen), which typically has no saved places, and it's what made
      // those legs look like the map simply didn't have them.
      const center = cityName ? cityFocusPoint(cityName, []) : null;
      if (center) map.setView([center.lat, center.lng], 11);
      else map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      return;
    }
    if (places.length === 1) {
      map.setView([places[0].lat, places[0].lng], 13);
      return;
    }
    const bounds: LatLngBoundsExpression = places.map((p) => [p.lat, p.lng] as [number, number]);
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, map]);
  return null;
}

/** Moves the camera to a requested pin. `places` is a dependency because the
 *  request routinely arrives one commit BEFORE the pin does: a cross-city jump
 *  switches `selectedCity` first, and only the following render carries that
 *  city's places. The nonce ledger makes the effect idempotent, so the extra
 *  runs `places` causes cost nothing and can't drag the map back to a pin the
 *  user has since moved away from. */
function FlyToPlace({ target, places }: { target: MapFocusRequest | null; places: LocatedPlace[] }) {
  const map = useMap();
  const handledNonce = useRef(0);
  useEffect(() => {
    if (!target || handledNonce.current === target.nonce) return;
    const place = places.find((p) => p.id === target.placeId);
    if (!place) return; // Not in the city on screen yet — wait for the switch.
    handledNonce.current = target.nonce;
    // Never zoom back OUT: if the user was already closer in than FOCUS_ZOOM,
    // yanking them out is a worse answer than just panning.
    const zoom = Math.max(map.getZoom(), FOCUS_ZOOM);
    if (prefersReducedMotion()) map.setView([place.lat, place.lng], zoom);
    else map.flyTo([place.lat, place.lng], zoom, { duration: 0.8 });
  }, [target, places, map]);
  return null;
}

function ClickToAdd({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// ---------------------------------------------------------------------------

interface PinDetailPanelProps {
  place: Place | null;
  /** The place's staged days if a change is pending, else its saved days —
   *  what the day chips should actually show. */
  effectivePlaceDayIds: ID[];
  /** Whether `place` has an unsaved (staged) day reassignment right now. */
  pending: boolean;
  selectedDay: Day | null;
  cityDays: Day[];
  /** The leg's days incl. its day trips — what "Day N" counts over. */
  legDays: Day[];
  dayColorMap: Map<string, string>;
  itineraryByDay: Record<string, { id: string; title: string; startTime?: string; durationMin?: number; note?: string }[]>;
  onSetDays: (dayIds: ID[]) => void;
  onClose: () => void;
  onClearDayFilter: () => void;
  onOpenInItinerary: (city: string) => void;
  onJumpToSaveBar: () => void;
}

function PinDetailPanel({
  place,
  effectivePlaceDayIds,
  pending,
  selectedDay,
  cityDays,
  legDays,
  dayColorMap,
  itineraryByDay,
  onSetDays,
  onClose,
  onClearDayFilter,
  onOpenInItinerary,
  onJumpToSaveBar,
}: PinDetailPanelProps) {
  if (place) {
    // "Open in Itinerary" reflects the place's actually-SAVED assignment —
    // the itinerary tab has nothing linked yet for a staged-but-not-saved
    // reassignment (that link is only created once Save commits it).
    const assignedDay = cityDays.find((d) => d.id === place.dayId);
    return (
      <div className="pin-detail" id="pinDetail">
        <div className="pin-detail-top">
          <div>
            <div className="pin-detail-name">{place.name}</div>
            <div className="pin-detail-tags">
              {placeCategories(place).map((c) => (
                <span className="tag" key={c}>
                  {c}
                </span>
              ))}
              <span className="tag city">{place.city}</span>
            </div>
            {/* Same visual language as PlaceDetailModal's "Unsaved changes"
                draft pill — this is the same kind of risk (an edit that only
                exists on this device so far), so it reads as the same
                product handling it the same way. Doubles as a shortcut to
                the Save bar. */}
            {pending && (
              <button type="button" className="draft-pill" onClick={onJumpToSaveBar}>
                <span className="dot" aria-hidden="true" />
                Unsaved change
              </button>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        {place.description?.trim() && <p className="pin-detail-note">{place.description}</p>}
        <div className="field-row">
          <span className="field-label">Days</span>
        </div>
        {cityDays.length > 0 ? (
          <DayChips
            days={cityDays}
            legDays={legDays}
            selected={effectivePlaceDayIds}
            dayColorMap={dayColorMap}
            label={`Days for ${place.name}`}
            onChange={onSetDays}
          />
        ) : (
          <span className="assign-none">No days scheduled yet</span>
        )}
        {assignedDay && (
          <button className="btn btn-sm btn-ghost btn-block" onClick={() => onOpenInItinerary(place.city)}>
            Open in Itinerary
          </button>
        )}
      </div>
    );
  }

  if (selectedDay) {
    const stops = itineraryByDay[selectedDay.id] ?? [];
    const color = dayColor(selectedDay.id, dayColorMap);
    const label = dayLabel(selectedDay, legDays);
    return (
      <div className="pin-detail" id="pinDetail">
        <div className="dayplan-head">
          <div className="dayplan-title">
            <span className="dot" style={{ background: color }} />
            {label}
          </div>
          <button className="icon-btn" onClick={onClearDayFilter} title="Clear day filter">
            <Icon name="close" />
          </button>
        </div>
        {stops.length > 0 ? (
          <div className="dayplan-list">
            {stops.map((s) => (
              <div className="dayplan-stop" key={s.id}>
                <span className="t tabular">{s.startTime ?? '--:--'}</span>
                <div className="body">
                  <strong>{s.title}</strong>
                  {s.durationMin != null && <div className="meta">{s.durationMin} min</div>}
                  {s.note && <div className="note">{s.note}</div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="dayplan-empty">No stops mapped out for this day yet &mdash; open the Itinerary tab to add some.</p>
        )}
        <button className="btn btn-sm btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => onOpenInItinerary(selectedDay.city)}>
          Open in Itinerary
        </button>
      </div>
    );
  }

  return (
    <div className="pin-detail empty" id="pinDetail">
      <Icon name="pin" />
      <div>
        <strong>Tap a pin, or pick a day above</strong>
        <br />
        Place details or the day&rsquo;s plan will show here.
      </div>
    </div>
  );
}
