// The Map tab — the app's "home screen". Real react-leaflet + OSM tiles
// (online-only, per spec). The top route-strip timeline (in App) is the
// PRIMARY city selector — `selectedCity` is passed down from there so the
// timeline and map stay in sync; day chips dim/emphasize pins for that day;
// clicking a pin opens a detail card with an assign-to-day select. Both the
// header "Add place" button and a real tap on the map open the shared
// AddPlaceModal (search entry point, and pin entry point with the tapped
// coordinate already known) instead of jumping to the Places tab. Offline
// shows a fallback message instead of the live map (data itself stays
// available via the other tabs).

import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import { useTripStore } from '../../store/useTripStore';
import { Icon } from '../../components/Icons';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { AddPlaceMode, AddPlacePoint } from '../places/AddPlaceModal';
import type { Day, Place } from '../../data/schema';
import { buildDayColorMap, dayColor, dayLabel, daysForCity } from '../../lib/tripView';
import { fmtCompactRange, parseISODate } from '../../lib/dates';
import { buildPinIcon } from './markerIcon';

const DEFAULT_CENTER: [number, number] = [30.5, 112];
const DEFAULT_ZOOM = 5;

interface MapPanelProps {
  /** The city currently selected on the route-strip timeline (lifted to App). */
  selectedCity: string;
  onOpenAutoPlan: (trigger?: HTMLElement | null) => void;
  onOpenAddPlace: (mode: AddPlaceMode, point?: AddPlacePoint) => void;
  onJumpToItinerary: (anchorId: string) => void;
}

export function MapPanel({ selectedCity, onOpenAutoPlan, onOpenAddPlace, onJumpToItinerary }: MapPanelProps) {
  const trip = useTripStore((s) => s.trip);
  const places = useTripStore((s) => s.places);
  const days = useTripStore((s) => s.days);
  const itineraryByDay = useTripStore((s) => s.itineraryByDay);
  const assignPlaceToDay = useTripStore((s) => s.assignPlaceToDay);
  const online = useOnlineStatus();

  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);

  // Reset the day/pin selection whenever the timeline switches cities.
  useEffect(() => {
    setSelectedDayId(null);
    setSelectedPlaceId(null);
  }, [selectedCity]);

  const dayColorMap = useMemo(() => buildDayColorMap(days), [days]);
  const cityDays = useMemo(() => daysForCity(days, selectedCity), [days, selectedCity]);
  const cityPlaces = useMemo(() => places.filter((p) => p.city === selectedCity), [places, selectedCity]);
  const selectedPlace = places.find((p) => p.id === selectedPlaceId) ?? null;
  const selectedDay = days.find((d) => d.id === selectedDayId) ?? null;
  const cityMeta = trip?.cities.find((c) => c.name === selectedCity);

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

  if (!trip) return null;

  return (
    <section className="panel" id="panel-map" role="tabpanel" aria-labelledby="tab-map">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Map</h2>
          <span className="panel-hint">Your home screen &middot; tap a city in the timeline above to change what&rsquo;s shown</span>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => onOpenAddPlace('search')}>
          <Icon name="plus" /> Add place
        </button>
      </div>

      <div className="map-showing" aria-live="polite" aria-atomic="true">
        <span className="map-showing-dot" />
        Showing <strong>{selectedCity || '—'}</strong>
        {cityMeta && <span className="range">&middot; {fmtCompactRange(cityMeta.arrive, cityMeta.depart)}</span>}
      </div>

      {cityDays.length > 0 && (
        <div className="chiprow" id="dayChips">
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
              {dayLabel(d, cityDays)}
            </button>
          ))}
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
                  places={cityPlaces}
                  cityDays={cityDays}
                  dayColorMap={dayColorMap}
                  selectedDayId={selectedDayId}
                  selectedPlaceId={selectedPlaceId}
                  onSelectPlace={handleSelectPlace}
                  onMapClick={handleMapTap}
                />
                <div className="map-badge map-add-hint" aria-hidden="true">
                  <Icon name="plus" /> Tap map to add
                </div>
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

          {cityDays.length > 0 && (
            <div className="legend" id="mapLegend">
              {cityDays.map((d) => (
                <div className="legend-item" key={d.id}>
                  <span className="legend-dot" style={{ background: dayColor(d.id, dayColorMap) }} />
                  {dayLabel(d, cityDays)}
                </div>
              ))}
              <div className="legend-item">
                <span className="legend-dot dashed" />
                Unassigned
              </div>
            </div>
          )}
        </div>

        <PinDetailPanel
          place={selectedPlace}
          selectedDay={selectedDay}
          cityDays={cityDays}
          dayColorMap={dayColorMap}
          itineraryByDay={itineraryByDay}
          onAssign={(dayId) => selectedPlace && assignPlaceToDay(selectedPlace.id, dayId)}
          onClose={() => setSelectedPlaceId(null)}
          onClearDayFilter={() => handleSelectDay(null)}
          onOpenInItinerary={(city) => onJumpToItinerary(`it-${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

interface LeafletMapProps {
  places: Place[];
  cityDays: Day[];
  dayColorMap: Map<string, string>;
  selectedDayId: string | null;
  selectedPlaceId: string | null;
  onSelectPlace: (id: string) => void;
  onMapClick: (lat: number, lng: number) => void;
}

function LeafletMap({
  places,
  cityDays,
  dayColorMap,
  selectedDayId,
  selectedPlaceId,
  onSelectPlace,
  onMapClick,
}: LeafletMapProps) {
  return (
    <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} className="leaflet-container" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitToPlaces places={places} />
      <ClickToAdd onMapClick={onMapClick} />
      {places.map((p) => {
        const day = cityDays.find((d) => d.id === p.dayId);
        const color = dayColor(p.dayId, dayColorMap);
        const unassigned = !p.dayId;
        const emph = selectedDayId ? p.dayId === selectedDayId : false;
        const dim = selectedDayId ? p.dayId !== selectedDayId : false;
        const badgeText = day ? String(parseISODate(day.date).getDate()) : undefined;
        const tooltipText = day ? dayLabel(day, cityDays) : 'Unassigned';
        return (
          <Marker
            key={p.id}
            position={[p.lat, p.lng]}
            icon={buildPinIcon({
              color,
              category: p.category,
              unassigned,
              badgeText,
              selected: p.id === selectedPlaceId,
              emph,
              dim,
            })}
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

function FitToPlaces({ places }: { places: Place[] }) {
  const map = useMap();
  useEffect(() => {
    if (places.length === 0) {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
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
  selectedDay: Day | null;
  cityDays: Day[];
  dayColorMap: Map<string, string>;
  itineraryByDay: Record<string, { id: string; title: string; startTime?: string; durationMin?: number; note?: string }[]>;
  onAssign: (dayId: string | undefined) => void;
  onClose: () => void;
  onClearDayFilter: () => void;
  onOpenInItinerary: (city: string) => void;
}

function PinDetailPanel({
  place,
  selectedDay,
  cityDays,
  dayColorMap,
  itineraryByDay,
  onAssign,
  onClose,
  onClearDayFilter,
  onOpenInItinerary,
}: PinDetailPanelProps) {
  if (place) {
    const assignedDay = cityDays.find((d) => d.id === place.dayId);
    return (
      <div className="pin-detail" id="pinDetail">
        <div className="pin-detail-top">
          <div>
            <div className="pin-detail-name">{place.name}</div>
            <div className="pin-detail-tags">
              {place.category && <span className="tag">{place.category}</span>}
              <span className="tag city">{place.city}</span>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>
        {place.note && <p className="pin-detail-note">{place.note}</p>}
        <div className="field-row">
          <span className="field-label">Assign to day</span>
        </div>
        <select
          value={place.dayId ?? ''}
          onChange={(e) => onAssign(e.target.value || undefined)}
        >
          <option value="">Unassigned</option>
          {cityDays.map((d) => (
            <option key={d.id} value={d.id}>
              {dayLabel(d, cityDays)}
            </option>
          ))}
        </select>
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
    const label = dayLabel(selectedDay, cityDays);
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
