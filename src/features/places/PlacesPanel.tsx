// Places tab — wishlist/planned pins grouped by city (each section tinted
// with a stable per-city accent so a long list still reads as distinct
// chunks), with a city + category filter bar and a day-assignment select per
// card. "Add place" opens the shared AddPlaceModal (search-first) instead of
// an inline form — the same modal the Map tab uses, so there's only one
// add-place flow in the app.
//
// Each card also opens the PlaceDetailModal (Phase 4 item 3) for
// description/self-review editing, and carries its own inline two-step
// delete confirmation (Phase 4 item 6) — see PlaceCard below.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTripStore } from '../../store/useTripStore';
import { Icon } from '../../components/Icons';
import { BackToTop } from '../../components/BackToTop';
import { citySlug } from '../../components/RouteStrip';
import type { AddPlaceMode } from './AddPlaceModal';
import { PlaceDetailModal } from './PlaceDetailModal';
import type { Day, ID, Place } from '../../data/schema';
import { buildPlaceDeleteWarning } from '../../lib/placeDeleteWarning';
import {
  PLACE_CATEGORIES,
  buildDayColorMap,
  categoryGroup,
  categoryIcon,
  cityAccentColor,
  dayColor,
  dayLabel,
  daysForCity,
  daysForLeg,
  groupPlacesByCity,
  orderedCities,
} from '../../lib/tripView';

interface PlacesPanelProps {
  onOpenAddPlace: (mode: AddPlaceMode) => void;
  /** "View on map" from a place's detail modal — App switches to the Map
   *  tab showing that city (the same handoff the timeline's city chips
   *  use). Optional so tests can render the panel standalone. */
  onViewOnMap?: (city: string) => void;
}

export function PlacesPanel({ onOpenAddPlace, onViewOnMap }: PlacesPanelProps) {
  const trip = useTripStore((s) => s.trip);
  const places = useTripStore((s) => s.places);
  const days = useTripStore((s) => s.days);
  const removePlace = useTripStore((s) => s.removePlace);
  const assignPlaceToDay = useTripStore((s) => s.assignPlaceToDay);
  const getPlaceDraft = useTripStore((s) => s.getPlaceDraft);

  const [cityFilter, setCityFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [selectedPlaceId, setSelectedPlaceId] = useState<ID | null>(null);
  const [draftPlaceIds, setDraftPlaceIds] = useState<Set<ID>>(new Set());
  // Collapsed-by-exception: a city is expanded unless it's in this set, so a
  // newly added city shows its places rather than hiding them.
  const [collapsedCities, setCollapsedCities] = useState<Set<string>>(new Set());

  const dayColorMap = useMemo(() => buildDayColorMap(days), [days]);
  const groups = useMemo(() => (trip ? groupPlacesByCity(places, trip.cities) : []), [places, trip]);

  // Seeds which places currently carry an unsaved local draft, once on
  // mount (e.g. after a full reload, so the "Draft" badge and the
  // content-aware delete warning are both right immediately). Drafts live in
  // IndexedDB, outside the Zustand store's reactive state, so there's
  // nothing to subscribe to here — every change AFTER this initial scan is
  // instead reported incrementally by PlaceDetailModal via markDraft, rather
  // than re-scanning every place's draft on every keystroke.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(places.map(async (p) => ((await getPlaceDraft(p.id)) ? p.id : null)));
      if (!cancelled) setDraftPlaceIds(new Set(entries.filter((id): id is ID => id !== null)));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markDraft = useCallback((placeId: ID, hasDraft: boolean) => {
    setDraftPlaceIds((prev) => {
      if (prev.has(placeId) === hasDraft) return prev;
      const next = new Set(prev);
      if (hasDraft) next.add(placeId);
      else next.delete(placeId);
      return next;
    });
  }, []);

  // The store's removePlace guarantees the place's local draft (if any) is
  // cleaned up too (see useTripStore.ts) — this just keeps the in-memory
  // badge Set in sync, and closes the detail modal if it currently has this
  // exact place open (there's nothing left to show).
  const handleDelete = useCallback(
    async (placeId: ID) => {
      await removePlace(placeId);
      markDraft(placeId, false);
      setSelectedPlaceId((cur) => (cur === placeId ? null : cur));
    },
    [removePlace, markDraft],
  );

  if (!trip) return null;

  const totalPlaces = places.length;
  const assignedCount = places.filter((p) => p.dayId).length;
  const filtersActive = cityFilter !== 'all' || categoryFilter !== 'all';
  const selectedPlace = places.find((p) => p.id === selectedPlaceId) ?? null;

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

  // Only the sections actually on screen (a city filtered down to nothing
  // isn't rendered) count towards the all-or-nothing toggle.
  const visibleCityNames = groups
    .filter(({ places: cityPlaces }) => cityPlaces.some(matchesFilters))
    .map(({ city: c }) => c.name);
  const allCollapsed = visibleCityNames.length > 0 && visibleCityNames.every((n) => collapsedCities.has(n));

  function toggleCity(name: string) {
    setCollapsedCities((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  function toggleAllCities() {
    setCollapsedCities(allCollapsed ? new Set() : new Set(visibleCityNames));
  }

  return (
    <section className="panel" id="panel-places" role="tabpanel" aria-labelledby="tab-places">
      <div className="panel-head">
        <h2 className="panel-title">Places</h2>
        <span className="panel-hint" id="placesPanelHint">
          {hintText}
        </span>
      </div>

      {/* PHASE 6 item 2 — sticky sub-bar, architecturally identical to
          `.it-quicknav`/`.map-day-quicknav` (composed off --topbar-h/
          --tabbar-h via useStickyOffsets), replacing the old in-flow
          `.add-card` that scrolled away. The filter bar right below
          deliberately stays non-sticky — see the CSS comment on
          `.places-add-quicknav`. */}
      <div className="places-add-quicknav">
        <span className="places-add-quicknav-hint">Save a place you want to visit</span>
        {visibleCityNames.length > 1 && (
          <button className="btn btn-ghost btn-sm" onClick={toggleAllCities}>
            <Icon name="chevron-right" className={`section-chevron${allCollapsed ? '' : ' is-open'}`} />
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
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
          // Options come from this city's own days; the "Day N" labels count
          // over the leg including its day trips, so a day trip doesn't
          // renumber the days after it.
          const cLegDays = daysForLeg(days, c.name);
          const assigned = cityPlaces.filter((p) => p.dayId).length;
          const accent = cityAccentColor(c.order);
          const collapsed = collapsedCities.has(c.name);
          const bodyId = `city-places-${citySlug(c.name)}`;
          return (
            <div
              className={`city-section${collapsed ? ' is-collapsed' : ''}`}
              key={c.name}
              style={{ ['--city-accent' as string]: accent } as CSSProperties}
            >
              <h3 className="city-section-head">
                <button
                  type="button"
                  className="city-section-toggle"
                  aria-expanded={!collapsed}
                  aria-controls={bodyId}
                  onClick={() => toggleCity(c.name)}
                >
                  <span className="city-dot" />
                  <span className="city-section-name">{c.name}</span>
                  <span className="count">
                    {cityPlaces.length} place{cityPlaces.length === 1 ? '' : 's'} &middot;{' '}
                    {assigned ? `${assigned} assigned` : 'not planned'}
                  </span>
                  <Icon name="chevron-right" className={`section-chevron${collapsed ? '' : ' is-open'}`} />
                </button>
              </h3>
              <div className="place-grid" id={bodyId} hidden={collapsed}>
                {filtered.map((p) => (
                  <PlaceCard
                    key={p.id}
                    place={p}
                    cityDays={cDays}
                    legDays={cLegDays}
                    dayColorMap={dayColorMap}
                    hasDraft={draftPlaceIds.has(p.id)}
                    onAssign={(dayId) => assignPlaceToDay(p.id, dayId)}
                    onDelete={() => handleDelete(p.id)}
                    onOpenDetail={() => setSelectedPlaceId(p.id)}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}

      <PlaceDetailModal
        place={selectedPlace}
        pinColor={selectedPlace ? dayColor(selectedPlace.dayId, dayColorMap) : 'var(--d-grey)'}
        onClose={() => setSelectedPlaceId(null)}
        onViewOnMap={onViewOnMap}
        onDraftChange={markDraft}
      />
      <BackToTop />
    </section>
  );
}

interface PlaceCardProps {
  place: Place;
  cityDays: Day[];
  /** The leg's days incl. its day trips — what "Day N" counts over. */
  legDays: Day[];
  dayColorMap: Map<string, string>;
  hasDraft: boolean;
  onAssign: (dayId: string | undefined) => void;
  onDelete: () => void;
  onOpenDetail: () => void;
}

function PlaceCard({ place, cityDays, legDays, dayColorMap, hasDraft, onAssign, onDelete, onOpenDetail }: PlaceCardProps) {
  const color = dayColor(place.dayId, dayColorMap);
  const tintStyle: CSSProperties = { ['--select-tint' as string]: color } as CSSProperties;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const trashRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Restores focus to the trash trigger on Cancel — mirrors the approved
  // mockup's cancelDeleteConfirm(), which does the same.
  useEffect(() => {
    if (wasConfirming.current && !confirmingDelete) {
      trashRef.current?.focus();
    }
    wasConfirming.current = confirmingDelete;
  }, [confirmingDelete]);

  if (confirmingDelete) {
    return (
      <article className="card place-card is-delete-confirm" role="alertdialog" aria-label={`Delete ${place.name}?`}>
        <div className="delete-confirm-inner">
          <Icon name="alert" />
          <div className="delete-confirm-text">
            <strong>Delete {place.name}?</strong>
            <span>{buildPlaceDeleteWarning(place, hasDraft)} This can&rsquo;t be undone.</span>
          </div>
        </div>
        <div className="delete-confirm-actions">
          <button type="button" className="btn delete-btn" onClick={onDelete}>
            Delete place
          </button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </div>
      </article>
    );
  }

  const hasDetail = Boolean(place.description?.trim() || place.selfReview?.trim());

  return (
    <article className="card place-card" onClick={onOpenDetail}>
      <div className="place-card-top">
        <span className="place-title">
          <span className={`place-icon${!place.dayId ? ' unassigned' : ''}`} style={{ ['--pin-color' as string]: color } as CSSProperties}>
            <Icon name={categoryIcon(place.category)} />
          </span>
          <span className="place-name">{place.name}</span>
        </span>
        <div className="place-card-actions">
          <button
            ref={trashRef}
            className="icon-btn icon-btn-danger"
            aria-label={`Delete ${place.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(true);
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
      <div className="place-tags">
        {place.category && <span className="tag">{place.category}</span>}
        <span className="tag city">{place.city}</span>
        {/* A non-empty selfReview IS the "visited" signal (Phase 4 item 3) —
            deliberately not a `visited` status field, so this never has to
            touch PlaceStatus/autoplan/map marker colours. */}
        {place.selfReview?.trim() && (
          <span className="tag reviewed">
            <Icon name="check" className="tag-icon" />
            Reviewed
          </span>
        )}
        {hasDraft && <span className="tag draft">Draft</span>}
      </div>
      {place.description?.trim() && <p className="place-desc-excerpt">{place.description}</p>}
      <button
        type="button"
        className="detail-link"
        onClick={(e) => {
          e.stopPropagation();
          onOpenDetail();
        }}
      >
        {hasDetail ? 'Notes & review' : 'Add notes'} <Icon name="chevron-right" />
      </button>
      <div className="place-foot">
        {cityDays.length > 0 ? (
          <span className="assign-slot">
            <select
              className={`assign-select${!place.dayId ? ' is-wishlist' : ''}`}
              style={tintStyle}
              aria-label={`Assign day for ${place.name}`}
              value={place.dayId ?? ''}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onAssign(e.target.value || undefined)}
            >
              <option value="">Wishlist</option>
              {cityDays.map((d) => (
                <option key={d.id} value={d.id}>
                  {dayLabel(d, legDays)}
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
