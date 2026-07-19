// Places tab — wishlist/planned pins grouped by city (each section tinted
// with a stable per-city accent so a long list still reads as distinct
// chunks), with a city + category filter bar and a day-assignment select per
// card. "Add place" opens the shared AddPlaceModal (search-first) instead of
// an inline form — the same modal the Map tab uses, so there's only one
// add-place flow in the app.

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTripStore } from '../../store/useTripStore';
import { Icon } from '../../components/Icons';
import type { AddPlaceMode } from './AddPlaceModal';
import type { Day, Place } from '../../data/schema';
import {
  PLACE_CATEGORIES,
  buildDayColorMap,
  categoryGroup,
  categoryIcon,
  cityAccentColor,
  dayColor,
  dayLabel,
  daysForCity,
  groupPlacesByCity,
  orderedCities,
} from '../../lib/tripView';

interface PlacesPanelProps {
  onOpenAddPlace: (mode: AddPlaceMode) => void;
}

export function PlacesPanel({ onOpenAddPlace }: PlacesPanelProps) {
  const trip = useTripStore((s) => s.trip);
  const places = useTripStore((s) => s.places);
  const days = useTripStore((s) => s.days);
  const removePlace = useTripStore((s) => s.removePlace);
  const assignPlaceToDay = useTripStore((s) => s.assignPlaceToDay);

  const [cityFilter, setCityFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const dayColorMap = useMemo(() => buildDayColorMap(days), [days]);
  const groups = useMemo(() => (trip ? groupPlacesByCity(places, trip.cities) : []), [places, trip]);

  if (!trip) return null;

  const totalPlaces = places.length;
  const assignedCount = places.filter((p) => p.dayId).length;
  const filtersActive = cityFilter !== 'all' || categoryFilter !== 'all';

  function matchesFilters(p: Place): boolean {
    return (
      (cityFilter === 'all' || p.city === cityFilter) &&
      (categoryFilter === 'all' || categoryGroup(p.category) === categoryFilter)
    );
  }

  const totalVisible = places.filter(matchesFilters).length;
  const hintText = filtersActive
    ? `${totalVisible} of ${totalPlaces} shown`
    : `${totalPlaces} saved · ${assignedCount} assigned to a day`;

  function clearFilters() {
    setCityFilter('all');
    setCategoryFilter('all');
  }

  return (
    <section className="panel" id="panel-places" role="tabpanel" aria-labelledby="tab-places">
      <div className="panel-head">
        <h2 className="panel-title">Places</h2>
        <span className="panel-hint" id="placesPanelHint">
          {hintText}
        </span>
      </div>

      <div className="add-card">
        <strong>Save a place you want to visit</strong>
        <button className="btn btn-primary btn-sm" onClick={() => onOpenAddPlace('search')}>
          <Icon name="plus" /> Add place
        </button>
      </div>

      <div className="places-filter-bar">
        <div className="field-row">
          <label className="field-label" htmlFor="placeCityFilter">City</label>
          <select id="placeCityFilter" value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}>
            <option value="all">All cities &middot; {totalPlaces}</option>
            {orderedCities(trip).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} &middot; {places.filter((p) => p.city === c.name).length}
              </option>
            ))}
          </select>
        </div>
        <div className="chiprow" id="placeCategoryChips" style={{ margin: '10px 0 0' }}>
          <button type="button" className={`chip${categoryFilter === 'all' ? ' active' : ''}`} onClick={() => setCategoryFilter('all')}>
            All categories
          </button>
          {PLACE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`chip${categoryFilter === cat ? ' active' : ''}`}
              onClick={() => setCategoryFilter(cat)}
            >
              <Icon name={categoryIcon(cat)} className="chip-icon" />
              {cat}
            </button>
          ))}
        </div>
      </div>

      {totalVisible === 0 ? (
        <div className="places-filter-empty" id="placesFilterEmpty">
          <Icon name="pin" />
          <strong>No places match these filters</strong>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      ) : (
        groups.map(({ city: c, places: cityPlaces }) => {
          const filtered = cityPlaces.filter(matchesFilters);
          if (filtered.length === 0) return null;
          const cDays = daysForCity(days, c.name);
          const assigned = cityPlaces.filter((p) => p.dayId).length;
          const accent = cityAccentColor(c.order);
          return (
            <div className="city-section" key={c.name} style={{ ['--city-accent' as string]: accent } as CSSProperties}>
              <div className="city-section-head">
                <span className="city-dot" />
                <h3>{c.name}</h3>
                <span className="count">
                  {cityPlaces.length} place{cityPlaces.length === 1 ? '' : 's'} &middot;{' '}
                  {assigned ? `${assigned} assigned` : 'not planned'}
                </span>
              </div>
              <div className="place-grid">
                {filtered.map((p) => (
                  <PlaceCard
                    key={p.id}
                    place={p}
                    cityDays={cDays}
                    dayColorMap={dayColorMap}
                    onAssign={(dayId) => assignPlaceToDay(p.id, dayId)}
                    onRemove={() => removePlace(p.id)}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

interface PlaceCardProps {
  place: Place;
  cityDays: Day[];
  dayColorMap: Map<string, string>;
  onAssign: (dayId: string | undefined) => void;
  onRemove: () => void;
}

function PlaceCard({ place, cityDays, dayColorMap, onAssign, onRemove }: PlaceCardProps) {
  const color = dayColor(place.dayId, dayColorMap);
  const tintStyle: CSSProperties = { ['--select-tint' as string]: color } as CSSProperties;

  return (
    <article className="place-card">
      <div className="place-card-top">
        <span className="place-title">
          <span className={`place-icon${!place.dayId ? ' unassigned' : ''}`} style={{ ['--pin-color' as string]: color } as CSSProperties}>
            <Icon name={categoryIcon(place.category)} />
          </span>
          <span className="place-name">{place.name}</span>
        </span>
        <div className="place-card-actions">
          <button className="icon-btn" aria-label={`Delete ${place.name}`} onClick={onRemove}>
            <Icon name="trash" />
          </button>
        </div>
      </div>
      <div className="place-tags">
        {place.category && <span className="tag">{place.category}</span>}
        <span className="tag city">{place.city}</span>
      </div>
      {place.note && <p className="place-note">{place.note}</p>}
      <div className="place-foot">
        {cityDays.length > 0 ? (
          <span className="assign-slot">
            <select
              className={`assign-select${!place.dayId ? ' is-wishlist' : ''}`}
              style={tintStyle}
              aria-label={`Assign day for ${place.name}`}
              value={place.dayId ?? ''}
              onChange={(e) => onAssign(e.target.value || undefined)}
            >
              <option value="">Wishlist</option>
              {cityDays.map((d) => (
                <option key={d.id} value={d.id}>
                  {dayLabel(d, cityDays)}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <span className="assign-none">No days scheduled yet</span>
        )}
      </div>
    </article>
  );
}
