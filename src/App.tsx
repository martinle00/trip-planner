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
import { Modal } from './components/Modal';
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
  const pendingCount = useTripStore((s) => s.pendingCount);
  const pendingSince = useTripStore((s) => s.pendingSince);
  const uploading = useTripStore((s) => s.uploading);
  const uploadFailure = useTripStore((s) => s.uploadFailure);
  const syncOutbox = useTripStore((s) => s.syncOutbox);
  const [syncSheetOpen, setSyncSheetOpen] = useState(false);
  /* Whether anyone else could plausibly be editing this trip, which gates the
     overwrite warning in the sync sheet. `trip.members` is the closest signal
     the app has — but note it means BUDGET COMPANIONS, not accounts
     (`trip_collaborators` is the account list, and nothing loads it client-
     side). So the warning stays unnamed: telling someone "Susanna's version
     will be replaced" when Susanna has no account and never edited anything
     would be worse than the vaguer sentence. */
  const sharedTrip = (trip?.members?.length ?? 0) > 1;
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

  // The pill's pending states, in priority order. `null` hands the slot back
  // to the existing Syncing…/Synced behaviour, which is unchanged.
  //
  // Deliberately NOT tappable while offline: there is nothing tapping could
  // achieve, and a button that does nothing when pressed is worse than a
  // label. The count still shows, because "your work is safe on this device
  // and will go up later" is the thing to communicate at that moment.
  const pendingState = useMemo((): { label: string; tone: string; tappable: boolean } | null => {
    if (uploading) {
      return { label: `Uploading ${pendingCount}…`, tone: 'uploading', tappable: false };
    }
    if (uploadFailure) {
      const n = uploadFailure.remaining;
      return {
        label: `${n} change${n === 1 ? '' : 's'} still waiting · couldn't upload`,
        tone: 'failed',
        tappable: true,
      };
    }
    if (pendingCount === 0) return null;
    const n = pendingCount;
    return online
      ? { label: `${n} change${n === 1 ? '' : 's'} waiting to upload`, tone: 'pending', tappable: true }
      : { label: `${n} change${n === 1 ? '' : 's'} waiting · offline`, tone: 'pending', tappable: false };
  }, [pendingCount, uploading, uploadFailure, online]);

  // The pill is a live region, and a burst of offline edits would otherwise
  // read out "1 change… 2 changes… 3 changes…" one per keystroke-ish write.
  // Announce the settled value instead.
  const [announcedPending, setAnnouncedPending] = useState('');
  useEffect(() => {
    const label = pendingState?.label ?? '';
    const timer = window.setTimeout(() => setAnnouncedPending(label), 1200);
    return () => window.clearTimeout(timer);
  }, [pendingState?.label]);

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
    // Sign-out wipes the local cache, and the outbox goes with it (queued
    // writes are only permitted to the account that made them, so they can't
    // be replayed by whoever signs in next). Anything still queued is work
    // the app already told the user had saved — destroying it silently is
    // the worst thing this feature could do, so it takes an explicit yes.
    if (useTripStore.getState().pendingCount > 0) {
      const n = useTripStore.getState().pendingCount;
      const confirmed = window.confirm(
        `${n} change${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} not been uploaded yet and will be lost if you sign out now.\n\nSign out anyway?`,
      );
      if (!confirmed) return;
    }
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

  // Signed in, the load has settled, and there's still no trip: since
  // migration 0005 that has exactly one meaning — this account isn't a
  // collaborator on the (single, shared) trip. It used to sit on the
  // cold-start spinner forever while the client tried and failed to create a
  // trip of its own (409, trips_pkey). There is nothing the user can do from
  // here, so say so plainly instead of implying it's still loading.
  if (!loading && !trip) {
    return (
      <div className="boot-cold-start" role="alert">
        <IconSprite />
        <div className="boot-cold-start-title">You&rsquo;re not on this trip yet</div>
        <div className="boot-cold-start-hint">
          Signing in worked, but this account hasn&rsquo;t been added to the trip. Ask whoever set it up to add
          you, then reload.
        </div>
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 14 }} onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </div>
    );
  }

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
                  then settles back to hidden.
                  
                  The original rule was "forced hidden while offline, so the
                  user is never told syncing and offline at once". That rule
                  survives, read precisely: what must never appear offline is
                  a claim to BE SYNCING. A count of changes waiting to upload
                  is a different fact, and offline is exactly when it matters
                  most — so the pending states below render in both. */}
              <span className="visually-hidden" role="status" aria-live="polite">
                {announcedPending}
              </span>
              {pendingState ? (
                <button
                  className="sync-indicator sync-pending"
                  data-state={pendingState.tone}
                  onClick={() => pendingState.tappable && setSyncSheetOpen(true)}
                  disabled={!pendingState.tappable}
                  aria-label={pendingState.label}
                >
                  <span className="sync-dot" aria-hidden="true" />
                  <span className="sync-pending-label">{pendingState.label}</span>
                </button>
              ) : (
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
              )}
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

      {/* Only ever opened by tapping the pill. Nothing raises this on its
          own — a focus-trapping sheet triggered by a background network
          event arrives mid-expense-form or mid-drag, or while you're walking
          one-handed out of a metro station, which is precisely the context
          this whole feature exists for. Connectivity returning changes the
          pill's label and nothing else. */}
      <SyncSheet
        open={syncSheetOpen}
        onClose={() => setSyncSheetOpen(false)}
        pendingCount={pendingCount}
        pendingSince={pendingSince}
        uploadFailure={uploadFailure}
        sharedTrip={sharedTrip}
        onUpload={() => {
          setSyncSheetOpen(false);
          void syncOutbox();
        }}
      />

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

interface SyncSheetProps {
  open: boolean;
  onClose: () => void;
  pendingCount: number;
  pendingSince: string | undefined;
  uploadFailure: { uploaded: number; remaining: number } | undefined;
  /** Whether more than one person is on this trip — gates the overwrite
   *  warning so a solo traveller isn't handed anxiety about a risk that
   *  can't happen to them. */
  sharedTrip: boolean;
  onUpload: () => void;
}

/** How long the queue has to have been pending before the app admits the
 *  user has been reading device-only data. Below this it's a normal blip and
 *  saying so would just be noise. */
const STALE_DISCLOSURE_MS = 2 * 60 * 60 * 1000;

function SyncSheet({
  open,
  onClose,
  pendingCount,
  pendingSince,
  uploadFailure,
  sharedTrip,
  onUpload,
}: SyncSheetProps) {
  const stale =
    pendingSince !== undefined && Date.now() - new Date(pendingSince).getTime() > STALE_DISCLOSURE_MS;

  return (
    <Modal open={open} onClose={onClose} labelledBy="syncSheetTitle">
      <div className="modal-head">
        <h2 className="modal-title" id="syncSheetTitle">
          {uploadFailure ? 'Upload didn’t finish' : 'Changes waiting to upload'}
        </h2>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {uploadFailure ? (
        <p className="sync-sheet-lead">
          Uploaded {uploadFailure.uploaded} of {uploadFailure.uploaded + uploadFailure.remaining}.{' '}
          {uploadFailure.remaining} didn&rsquo;t go through.
        </p>
      ) : (
        <p className="sync-sheet-lead">
          {pendingCount} change{pendingCount === 1 ? '' : 's'} made while offline.
        </p>
      )}

      {/* Deliberately not a red warning. This is a normal consequence of the
          app's last-write-wins model, not an error — and it's stated in plain
          terms the user can act on (go ask them) rather than "conflict",
          which offers nothing to do. */}
      {sharedTrip && !uploadFailure && (
        <p className="sync-sheet-note">
          If someone else changed the same thing while you were offline, your version will replace
          theirs.
        </p>
      )}

      {stale && !uploadFailure && (
        <p className="sync-sheet-note">
          You&rsquo;re seeing only what&rsquo;s on this device — anyone else&rsquo;s changes
          won&rsquo;t appear until you upload.
        </p>
      )}

      {/* Equal weight, on purpose, against the usual ghost/primary split:
          "Not now" is the safe choice on one bar of signal, and Upload
          shouldn't be the button your thumb finds by default. */}
      <div className="sync-sheet-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Not now
        </button>
        <button className="btn btn-ghost sync-sheet-upload" onClick={onUpload}>
          <Icon name="check" /> {uploadFailure ? 'Try again' : 'Upload'}
        </button>
      </div>
    </Modal>
  );
}

export default App;
