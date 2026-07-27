import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { IconSprite, Icon } from './components/Icons';
import { RouteStrip } from './components/RouteStrip';
import { useTripStore, resetTripStoreForSignOut } from './store/useTripStore';
import { initTheme, toggleTheme as flipTheme } from './lib/theme';
import type { Theme } from './lib/theme';
import { supabase } from './lib/supabaseClient';
import { clearLocalCache } from './data/db';
import { DexieTripRepository } from './data/dexieTripRepository';
import { setTripRepository } from './data/tripRepositoryInstance';
import { orderedCities } from './lib/tripView';
import { citiesWithPendingChanges } from './features/map/mapStaging';
import { fmtCompactRange } from './lib/dates';
import { useStickyOffsets } from './hooks/useStickyOffsets';
import { useCondenseHeader } from './hooks/useCondenseHeader';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { MapPanel } from './features/map/MapPanel';
import { PlacesPanel } from './features/places/PlacesPanel';
import { ItineraryPanel } from './features/itinerary/ItineraryPanel';
import { SettingsModal } from './features/settings/SettingsModal';
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

const ACTIVE_TAB_STORAGE_KEY = 'trip-planner:activeTab';
const TAB_IDS: readonly TabId[] = TAB_DEFS.map((t) => t.id);

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

/** Reads the last-active tab from sessionStorage so that a full reload
 *  (which, on an installed PWA — especially iOS — can happen just from
 *  backgrounding the app for a while, not just an explicit refresh) restores
 *  where the user left off instead of always landing back on Map. Scoped to
 *  sessionStorage (not localStorage) since this is just a "resume this
 *  session" affordance, not a durable preference. */
function readStoredTab(): TabId {
  try {
    const stored = window.sessionStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    return isTabId(stored) ? stored : 'map';
  } catch {
    return 'map';
  }
}

type SyncDisplay = 'hidden' | 'syncing' | 'done';

function App() {
  const init = useTripStore((s) => s.init);
  const trip = useTripStore((s) => s.trip);
  const loading = useTripStore((s) => s.loading);
  const syncing = useTripStore((s) => s.syncing);
  const exportJson = useTripStore((s) => s.exportJson);
  const importJson = useTripStore((s) => s.importJson);
  // Drives the route-strip's per-city "unsaved changes" dot (see the Map
  // save-changes spec) — computed here, in the topbar, since the strip is
  // shared across every tab, not just Map.
  const stagedAssignments = useTripStore((s) => s.stagedAssignments);
  const pendingCities = useMemo(() => citiesWithPendingChanges(stagedAssignments), [stagedAssignments]);
  const online = useOnlineStatus();

  // Drives the topbar's small sync-status pill (mockup's .sync-indicator):
  // shows "syncing" for as long as the store's background refresh
  // (useTripStore's init()) is in flight, then holds "done" for ~1.6s once
  // it finishes before settling back to hidden — mirroring the mockup's
  // syncSettle/setBootState timing exactly. Kept as local UI state (rather
  // than in the store) since the "hold done for 1.6s" behavior is purely a
  // presentational animation-timing concern, not app data.
  const [syncDisplay, setSyncDisplay] = useState<SyncDisplay>('hidden');
  const wasSyncingRef = useRef(false);

  useEffect(() => {
    if (syncing) {
      wasSyncingRef.current = true;
      setSyncDisplay('syncing');
      return;
    }
    if (!wasSyncingRef.current) return;
    wasSyncingRef.current = false;
    setSyncDisplay('done');
    const timer = window.setTimeout(() => setSyncDisplay('hidden'), 1600);
    return () => window.clearTimeout(timer);
  }, [syncing]);

  const [tab, setTab] = useState<TabId>(readStoredTab);
  const [theme, setTheme] = useState<Theme>('light');
  const [autoplanOpen, setAutoplanOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // Desktop-only condensing header (mockup/header-nav-hierarchy.html
  // #v3-condense) — see useCondenseHeader for the hysteresis/breakpoint
  // reasoning. `condenseSentinelRef` is a thin marker rendered as <main>'s
  // first child, below.
  const condenseSentinelRef = useRef<HTMLDivElement>(null);
  const condensed = useCondenseHeader(condenseSentinelRef);

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

  useEffect(() => {
    try {
      window.sessionStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
    } catch {
      // Ignore (e.g. sessionStorage unavailable/full/private-mode) — this is
      // a best-effort UX nicety, not required for correctness.
    }
  }, [tab]);

  /** Settings offers an explicit light/dark choice rather than a blind
   *  toggle, but `lib/theme.ts` only exposes a flip (it persists and applies
   *  the attribute as a side effect). Flipping only when the requested theme
   *  differs keeps that single code path — picking the already-active theme
   *  is a no-op, not a flip to the other one. */
  const handleSetTheme = useCallback((next: Theme) => {
    setTheme((cur) => (cur === next ? cur : flipTheme(cur)));
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

  const handleSignOut = useCallback(async () => {
    try {
      // Order matters: invalidate any in-flight init()/background refresh
      // and repoint the repository seam BEFORE clearing the cache, so a
      // stale request that resolves after this point can never repaint the
      // signed-out account's data or repopulate IndexedDB right after it's
      // wiped (see resetTripStoreForSignOut's token-bump).
      resetTripStoreForSignOut();
      setTripRepository(new DexieTripRepository());
      await clearLocalCache();
      await supabase.auth.signOut();
    } catch (err) {
      console.error('Sign out failed', err);
    }
  }, []);

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
    // The store's init() flips `loading` to false as soon as it has *any*
    // trip to show — from the local Dexie cache almost instantly, or (only
    // on a genuine first-ever load with nothing cached) once the first
    // network fetch lands. So reaching this branch means there is truly
    // nothing cached yet: the mockup's blocking `.boot-cold-start` state.
    // Every returning visit skips this entirely.
    return (
      <div className="boot-cold-start" role="status" aria-live="polite">
        <IconSprite />
        <div className="boot-cold-start-spinner" aria-hidden="true" />
        <div className="boot-cold-start-title">Loading your trip&hellip;</div>
        <div className="boot-cold-start-hint">First time on this device &mdash; fetching your trip from the cloud.</div>
      </div>
    );
  }

  // Every leg, day trips included — they're places you actually go, and
  // leaving them out meant Wulong/Shenzhen could never be selected, so the
  // Map had no way to show them either. RouteStrip marks them as day trips
  // rather than passing them off as overnight stops.
  const tripLegs = orderedCities(trip);

  return (
    <>
      <div className="app-shell">
        <IconSprite />

        {!online && (
          <div className="offline-banner" role="status" aria-live="polite">
            <Icon name="target" /> You&rsquo;re offline &mdash; showing data saved on this device. The live map needs a
            connection.
          </div>
        )}

        {/* `can-condense` marks this eligible for the desktop shrink-on-scroll
            refinement; `is-condensed` (driven by useCondenseHeader, gated to
            >=720px) is the only thing that actually turns it on — see
            index.css's `@media (min-width:720px)` condensing-header block.
            Harmless below that width: no CSS there reads `is-condensed`, and
            the hook never sets it in the first place. */}
        <header className={`topbar can-condense${condensed ? ' is-condensed' : ''}`}>
          <div className="topbar-row">
            <div className="trip-id">
              <span className="trip-eyebrow">Personal trip &middot; from Sydney</span>
              <h1 className="trip-title">{trip.name}</h1>
              <span className="trip-sub">
                {fmtCompactRange(trip.startDate, trip.endDate)} &middot; {tripLegs.length} legs &middot;{' '}
                {trip.tripCurrency} trip / {trip.homeCurrency} home
              </span>
            </div>
            <div className={`topbar-actions${condensed ? ' is-collapsed' : ''}`}>
              {/* Export/Import/theme/Sign-out all moved into the Settings
                  modal in Phase 6 item 6 — the file input itself stays here
                  because it's a hidden, always-mounted element the modal
                  triggers via `handleImportClick`; moving it inside a
                  conditionally-rendered modal would unmount it mid-flight. */}
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="visually-hidden"
                onChange={(e) => void handleImportFile(e)}
                aria-hidden="true"
                tabIndex={-1}
              />
              {/* Non-blocking background-sync status (mockup's
                  .sync-indicator): hidden on a normal steady visit (cache
                  already fresh, nothing to report), appears briefly on a
                  returning visit while the store quietly refreshes from the
                  active repository behind the already-rendered cached view,
                  then settles back to hidden. Forced hidden while offline —
                  mutually exclusive with the offline banner above so the
                  user is never told "syncing" and "offline" at once. */}
              <span
                className="sync-indicator"
                data-state={online ? syncDisplay : 'hidden'}
                role="status"
                aria-live="polite"
              >
                <span className="sync-dot" aria-hidden="true" />
                <Icon name="check" className="sync-check" />
                <span className="sync-indicator-label">
                  {syncDisplay === 'done' ? 'Synced' : 'Syncing…'}
                </span>
              </span>
              <button className="btn autoplan-cta btn-collapsible" onClick={(e) => openAutoPlan(e.currentTarget)}>
                <Icon name="sparkle" /> <span className="btn-label">Auto-plan</span>
              </button>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
                title="Settings"
              >
                <Icon name="settings" />
              </button>
            </div>
          </div>

          <RouteStrip cities={tripLegs} selectedCity={selectedCity} onSelect={selectCity} pendingCities={pendingCities} />
        </header>

        {/* Below 720px this is repositioned into the fixed bottom tab dock
            approved in mockup/header-nav-hierarchy.html Variant 3 — CSS-only
            (`@media (max-width:719px)` in index.css), same markup either
            way, so aria semantics/state never fork into two implementations.
            Its DOM position (right after the topbar, before <main>) is
            unchanged by that, which is what keeps primary nav early in
            keyboard focus order even when it's visually docked at the
            bottom — the fix for that variant's flagged focus-order gap. */}
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
              <Icon name={t.icon} />
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

        <main>
          {/* Zero-footprint sentinel for useCondenseHeader — see that hook
              and .condense-sentinel in index.css. */}
          <div className="condense-sentinel" ref={condenseSentinelRef} aria-hidden="true" />
          {tab === 'map' && (
            <MapPanel
              selectedCity={selectedCity}
              onOpenAutoPlan={openAutoPlan}
              onOpenAddPlace={openAddPlace}
              onJumpToItinerary={(anchorId) => jumpTo('itinerary', anchorId)}
            />
          )}
          {tab === 'places' && <PlacesPanel onOpenAddPlace={openAddPlace} onViewOnMap={selectCity} />}
          {tab === 'itinerary' && <ItineraryPanel />}
          {tab === 'budget' && <BudgetPanel onOpenSettings={() => setSettingsOpen(true)} />}
        </main>
      </div>

      <AutoPlanModal open={autoplanOpen} onClose={closeAutoPlan} />
      {/* Sign-out's teardown is order-sensitive (reset store -> repoint the
          repository -> clear Dexie -> sign out; see handleSignOut). Phase 6
          relocated the BUTTON into Settings, not the logic — the handler is
          still owned here and simply passed down. */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onSetTheme={handleSetTheme}
        onExport={() => void handleExport()}
        onImportClick={handleImportClick}
        onSignOut={() => void handleSignOut()}
      />
      <AddPlaceModal open={addPlaceOpen} mode={addPlaceMode} point={addPlacePoint} defaultCity={selectedCity} onClose={closeAddPlace} />
    </>
  );
}

export default App;
