import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { IconSprite, Icon } from './components/Icons';
import { RouteStrip } from './components/RouteStrip';
import { useTripStore } from './store/useTripStore';
import { initTheme, toggleTheme as flipTheme } from './lib/theme';
import type { Theme } from './lib/theme';
import { orderedCities } from './lib/tripView';
import { fmtCompactRange } from './lib/dates';
import { useStickyOffsets } from './hooks/useStickyOffsets';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { MapPanel } from './features/map/MapPanel';
import { PlacesPanel } from './features/places/PlacesPanel';
import { ItineraryPanel } from './features/itinerary/ItineraryPanel';
import { BudgetPanel } from './features/budget/BudgetPanel';
import { AutoPlanModal } from './features/autoplan/AutoPlanModal';
import { AddPlaceModal } from './features/places/AddPlaceModal';
import type { AddPlaceMode, AddPlacePoint } from './features/places/AddPlaceModal';

type TabId = 'map' | 'places' | 'itinerary' | 'budget';

const TAB_DEFS: { id: TabId; label: string; icon: string }[] = [
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'places', label: 'Places', icon: 'pin' },
  { id: 'itinerary', label: 'Itinerary', icon: 'calendar' },
  { id: 'budget', label: 'Budget', icon: 'wallet' },
];

function App() {
  const init = useTripStore((s) => s.init);
  const trip = useTripStore((s) => s.trip);
  const loading = useTripStore((s) => s.loading);
  const exportJson = useTripStore((s) => s.exportJson);
  const importJson = useTripStore((s) => s.importJson);
  const online = useOnlineStatus();

  const [tab, setTab] = useState<TabId>('map');
  const [theme, setTheme] = useState<Theme>('light');
  const [autoplanOpen, setAutoplanOpen] = useState(false);
  const autoplanTriggerRef = useRef<HTMLElement | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // The city currently driving the Map screen. Lifted here so the timeline
  // (route-strip, in the topbar) and the Map tab stay in sync, and the
  // timeline's "active" state persists even while on another tab.
  const [selectedCity, setSelectedCityState] = useState<string>('');

  // The single add-place modal, shared by the Map tab's "Add place" button,
  // a real tap on the Leaflet map (mode 'pin', coordinate known), and the
  // Places tab's own "Add place" button.
  const [addPlaceOpen, setAddPlaceOpen] = useState(false);
  const [addPlaceMode, setAddPlaceMode] = useState<AddPlaceMode>('search');
  const [addPlacePoint, setAddPlacePoint] = useState<AddPlacePoint | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    setTheme(initTheme());
  }, []);

  useEffect(() => {
    if (selectedCity || !trip) return;
    const base = orderedCities(trip).filter((c) => !c.parentCity);
    if (base.length > 0) setSelectedCityState(base[0].name);
  }, [trip, selectedCity]);

  useStickyOffsets([tab]);

  const handleToggleTheme = useCallback(() => {
    setTheme((cur) => flipTheme(cur));
  }, []);

  const openAutoPlan = useCallback((trigger?: HTMLElement | null) => {
    autoplanTriggerRef.current = trigger ?? (document.activeElement as HTMLElement | null);
    setAutoplanOpen(true);
  }, []);
  const closeAutoPlan = useCallback(() => setAutoplanOpen(false), []);

  const jumpTo = useCallback((targetTab: TabId, anchorId?: string) => {
    setTab(targetTab);
    if (anchorId) {
      window.setTimeout(() => {
        document.getElementById(anchorId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 30);
    }
  }, []);

  /** The timeline's primary city-select action: switches to (or stays on)
   *  the Map tab and shows that city there. */
  const selectCity = useCallback((cityName: string) => {
    setSelectedCityState(cityName);
    setTab('map');
  }, []);

  const openAddPlace = useCallback((mode: AddPlaceMode, point?: AddPlacePoint) => {
    setAddPlaceMode(mode);
    setAddPlacePoint(point ?? null);
    setAddPlaceOpen(true);
  }, []);
  const closeAddPlace = useCallback(() => setAddPlaceOpen(false), []);

  const handleExport = useCallback(async () => {
    const json = await exportJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trip.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [exportJson]);

  const handleImportClick = useCallback(() => importInputRef.current?.click(), []);
  const handleImportFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const text = await file.text();
      try {
        await importJson(text);
      } catch (err) {
        window.alert(`Couldn't import that file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [importJson],
  );

  if (loading || !trip) {
    return (
      <div className="app-shell">
        <IconSprite />
        <main>
          <p className="panel-hint">Loading your trip&hellip;</p>
        </main>
      </div>
    );
  }

  const baseCities = orderedCities(trip).filter((c) => !c.parentCity);

  return (
    <>
      <div className="app-shell">
        <IconSprite />

        {!online && (
          <div className="offline-banner">
            <Icon name="target" /> You&rsquo;re offline &mdash; showing data saved on this device. The live map needs a
            connection.
          </div>
        )}

        <header className="topbar">
          <div className="topbar-row">
            <div className="trip-id">
              <span className="trip-eyebrow">Personal trip &middot; from Sydney</span>
              <h1 className="trip-title">{trip.name}</h1>
              <span className="trip-sub">
                {fmtCompactRange(trip.startDate, trip.endDate)} &middot; {baseCities.length} legs &middot;{' '}
                {trip.tripCurrency} trip / {trip.homeCurrency} home
              </span>
            </div>
            <div className="topbar-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => void handleExport()} title="Export trip.json">
                Export
              </button>
              <button className="btn btn-ghost btn-sm" onClick={handleImportClick} title="Import trip.json">
                Import
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="visually-hidden"
                onChange={(e) => void handleImportFile(e)}
                aria-hidden="true"
                tabIndex={-1}
              />
              <button
                className="btn btn-ghost btn-icon"
                onClick={handleToggleTheme}
                aria-label="Toggle light and dark theme"
                title="Toggle light / dark"
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
              </button>
              <button className="btn autoplan-cta" onClick={(e) => openAutoPlan(e.currentTarget)}>
                <Icon name="sparkle" /> Auto-plan
              </button>
            </div>
          </div>

          <RouteStrip cities={baseCities} selectedCity={selectedCity} onSelect={selectCity} />
        </header>

        <nav className="tabbar" role="tablist" aria-label="Trip planner sections">
          {TAB_DEFS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              className={`tab${tab === t.id ? ' active' : ''}`}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>

        <main>
          {tab === 'map' && (
            <MapPanel
              selectedCity={selectedCity}
              onOpenAutoPlan={openAutoPlan}
              onOpenAddPlace={openAddPlace}
              onJumpToItinerary={(anchorId) => jumpTo('itinerary', anchorId)}
            />
          )}
          {tab === 'places' && <PlacesPanel onOpenAddPlace={openAddPlace} />}
          {tab === 'itinerary' && <ItineraryPanel />}
          {tab === 'budget' && <BudgetPanel />}
        </main>
      </div>

      <AutoPlanModal open={autoplanOpen} onClose={closeAutoPlan} />
      <AddPlaceModal open={addPlaceOpen} mode={addPlaceMode} point={addPlacePoint} defaultCity={selectedCity} onClose={closeAddPlace} />
    </>
  );
}

export default App;
