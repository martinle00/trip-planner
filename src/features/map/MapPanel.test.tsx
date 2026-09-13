// @vitest-environment jsdom
//
// Wiring tests for the Map tab's staged-changes model (approved via
// mockup/map-save-changes.html): the pin-detail day select STAGES a
// reassignment (via the store's `stagePlaceAssignment`) instead of writing
// it through immediately, the Save bar reflects the staged count, and its
// Discard is scoped to the city currently on screen. The state-machine
// behaviour of the Save bar itself (saving/saved/error/offline/confirm) is
// already covered by MapSaveBar.test.tsx — this file only proves MapPanel
// wires the real store actions to it correctly.
//
// react-leaflet is mocked out: MapContainer/Marker/Tooltip are replaced with
// plain DOM stand-ins (a real Leaflet map has no useful behaviour to assert
// on in jsdom, and isn't what this feature is about) — a Marker becomes a
// button labelled by its tooltip text, so a pin can still be "clicked" the
// same way a user would tap it.

import { useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MapPanel } from './MapPanel';
import { useTripStore } from '../../store/useTripStore';
import type { Day, Place, Trip } from '../../data/schema';

let onlineMock = true;
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineMock,
}));

// One shared stand-in for the Leaflet map object, so a test can assert where
// the camera was sent (FitToPlaces/FlyToPlace both go through it). `vi.mock`
// is hoisted above this, but `useMap` only dereferences it at render time.
const mapStub = {
  setView: vi.fn(),
  fitBounds: vi.fn(),
  flyTo: vi.fn(),
  getZoom: vi.fn(() => 11),
};

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TileLayer: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Marker: ({
    children,
    eventHandlers,
  }: {
    children: ReactNode;
    eventHandlers?: { click?: () => void };
  }) => (
    <button type="button" onClick={() => eventHandlers?.click?.()}>
      {children}
    </button>
  ),
  useMap: () => mapStub,
  useMapEvents: () => null,
}));

const TRIP: Trip = {
  id: 'trip-1',
  name: 'China 2026',
  startDate: '2026-11-09',
  endDate: '2026-11-17',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1, CNY: 0.2 },
  cities: [
    { name: 'Shanghai', order: 1, nights: 6, arrive: '2026-11-09', depart: '2026-11-15' },
    { name: 'Suzhou', order: 2, nights: 2, arrive: '2026-11-15', depart: '2026-11-17' },
  ],
};

const DAY_2: Day = { id: 'day-2', tripId: 'trip-1', date: '2026-11-10', city: 'Shanghai' };
const DAY_3: Day = { id: 'day-3', tripId: 'trip-1', date: '2026-11-11', city: 'Shanghai' };
const DAYS = [DAY_2, DAY_3];

const TIANZIFANG: Place = {
  id: 'place-tianzifang',
  tripId: 'trip-1',
  name: 'Tianzifang',
  category: 'Neighbourhood',
  city: 'Shanghai',
  lat: 31.21,
  lng: 121.47,
  status: 'wishlist',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const BUND: Place = {
  id: 'place-bund',
  tripId: 'trip-1',
  name: 'The Bund',
  category: 'Landmark',
  city: 'Shanghai',
  lat: 31.24,
  lng: 121.49,
  status: 'planned',
  dayId: 'day-2',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function setupStore(overrides: Partial<ReturnType<typeof baseState>> = {}) {
  useTripStore.setState({ ...baseState(), ...overrides });
}

function baseState() {
  return {
    trip: TRIP,
    places: [TIANZIFANG, BUND],
    days: DAYS,
    itineraryByDay: {},
    stagedAssignments: {},
    // Real (if minimal) implementations, not bare vi.fn() stubs — a
    // MapPanel/MapSaveBar wiring test needs staging a change to actually
    // update `stagedAssignments` so the count/pin/select reactively update,
    // the same way the real store's implementation does. `vi.fn` wrapping
    // still lets assertions check call args.
    stagePlaceAssignment: vi.fn(async (placeId: string, dayIds: string[]) => {
      const place = useTripStore.getState().places.find((p) => p.id === placeId);
      if (!place) return;
      useTripStore.setState((s) => {
        if (dayIds.join() === (place.dayId ?? '')) {
          const next = { ...s.stagedAssignments };
          delete next[placeId];
          return { stagedAssignments: next };
        }
        return { stagedAssignments: { ...s.stagedAssignments, [placeId]: { dayIds, city: place.city } } };
      });
    }),
    discardStagedAssignmentsForCity: vi.fn(async (city: string) => {
      useTripStore.setState((s) => {
        const next = { ...s.stagedAssignments };
        for (const [id, entry] of Object.entries(next)) {
          if (entry.city === city) delete next[id];
        }
        return { stagedAssignments: next };
      });
    }),
    saveStagedAssignments: vi.fn().mockResolvedValue(undefined),
  };
}

function renderMapPanel(props: Partial<ComponentProps<typeof MapPanel>> = {}) {
  return render(
    <MapPanel
      selectedCity="Shanghai"
      onOpenAutoPlan={() => {}}
      onOpenAddPlace={() => {}}
      onJumpToItinerary={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  onlineMock = true;
  mapStub.setView.mockClear();
  mapStub.fitBounds.mockClear();
  mapStub.flyTo.mockClear();
});

describe('MapPanel — staged changes', () => {
  it('stages a day reassignment via stagePlaceAssignment, not assignPlaceToDay, and shows it on the Save bar', () => {
    setupStore();
    renderMapPanel();

    // No Save bar yet — nothing staged.
    expect(screen.queryByRole('region', { name: 'Map save status' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Tianzifang/));
    const dayChips = within(screen.getByRole('group', { name: 'Days for Tianzifang' })).getAllByRole('button');
    fireEvent.click(dayChips[0]); // day-2

    expect(useTripStore.getState().stagePlaceAssignment).toHaveBeenCalledWith('place-tianzifang', ['day-2']);
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  });

  it('reflects an already-staged assignment on the day chips and shows the "Unsaved change" pill', () => {
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayIds: ['day-3'], city: 'Shanghai' } } });
    renderMapPanel();

    fireEvent.click(screen.getByText(/Tianzifang/));
    const dayChips = within(screen.getByRole('group', { name: 'Days for Tianzifang' })).getAllByRole('button');
    expect(dayChips.map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    // Scoped to the pill (a real <button>) — "Unsaved change" also appears as
    // plain text in the always-present legend entry.
    expect(screen.getByRole('button', { name: 'Unsaved change' })).toBeInTheDocument();
  });

  it('shows the cross-city hint and the correct per-city Discard scope', () => {
    setupStore({
      stagedAssignments: {
        'place-tianzifang': { dayIds: ['day-2'], city: 'Shanghai' },
        'place-elsewhere': { dayIds: [], city: 'Suzhou' },
      },
    });
    renderMapPanel();

    expect(screen.getByText('2 unsaved changes')).toBeInTheDocument();
    expect(screen.getByText('+1 more in Suzhou')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard (Shanghai)' })).toBeInTheDocument();
  });

  it('Discard calls discardStagedAssignmentsForCity scoped to the city on screen', () => {
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayIds: ['day-2'], city: 'Shanghai' } } });
    renderMapPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Discard (Shanghai)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(useTripStore.getState().discardStagedAssignmentsForCity).toHaveBeenCalledWith('Shanghai');
  });

  it('Save calls saveStagedAssignments', async () => {
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayIds: ['day-2'], city: 'Shanghai' } } });
    renderMapPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(useTripStore.getState().saveStagedAssignments).toHaveBeenCalledTimes(1);
  });

  it('always includes the "Unsaved change" legend entry alongside "Unassigned"', () => {
    setupStore();
    renderMapPanel();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(document.querySelector('.legend-dot.pending-ring')).toBeInTheDocument();
  });

  it('disables Save while offline but keeps the bar informative', () => {
    onlineMock = false;
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayIds: ['day-2'], city: 'Shanghai' } } });
    renderMapPanel();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

describe('MapPanel — places with no location', () => {
  const CHAIN: Place = {
    id: 'place-chain',
    tripId: 'trip-1',
    name: 'Jia Jia Tang Bao',
    category: 'Food',
    city: 'Shanghai',
    status: 'wishlist',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('does not pin a place that has no coordinates, and says so under the map', () => {
    setupStore({ places: [TIANZIFANG, CHAIN] });
    renderMapPanel();

    // The located place still gets its marker...
    expect(screen.getByText(/Tianzifang/)).toBeInTheDocument();
    // ...the unlocated one is nowhere on the map (no made-up city-centre pin).
    expect(screen.queryByText(/Jia Jia Tang Bao/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 place in this city has no location yet/)).toBeInTheDocument();
  });

  it('says nothing when every place in the city is pinned', () => {
    setupStore();
    renderMapPanel();
    expect(screen.queryByText(/no location yet/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

/** Stands in for App, which owns `selectedCity`: lets a cross-city search pick
 *  actually switch the map's city so the follow-on selection can be asserted. */
function CityHarness() {
  const [city, setCity] = useState('Shanghai');
  return (
    <MapPanel
      selectedCity={city}
      onSelectCity={setCity}
      onOpenAutoPlan={() => {}}
      onOpenAddPlace={() => {}}
      onJumpToItinerary={() => {}}
    />
  );
}

const SUZHOU_GARDEN: Place = {
  id: 'place-humble',
  tripId: 'trip-1',
  name: 'Humble Administrator’s Garden',
  category: 'Garden',
  city: 'Suzhou',
  lat: 31.32,
  lng: 120.63,
  status: 'wishlist',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function typeSearch(text: string) {
  const box = screen.getByRole('combobox', { name: 'Search your saved places' });
  fireEvent.change(box, { target: { value: text } });
  return box;
}

/** Scoped to the search listbox on purpose — the pin-detail panel's
 *  "Assign to day" `<select>` contributes `option` roles of its own. */
function searchOptions(): HTMLElement[] {
  const list = screen.queryByRole('listbox', { name: 'Matching places' });
  return list ? within(list).getAllByRole('option') : [];
}

function showingCity(): string {
  return document.querySelector('.map-showing strong')?.textContent ?? '';
}

describe('MapPanel — pin search', () => {
  it('lists only matching places and flies the map to the one picked', () => {
    setupStore();
    renderMapPanel();
    typeSearch('bund');

    const options = searchOptions();
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('The Bund');

    fireEvent.click(options[0]);

    // Selected in the detail panel...
    expect(screen.getByRole('group', { name: 'Days for The Bund' })).toBeInTheDocument();
    // ...and the camera actually moved to it.
    expect(mapStub.flyTo).toHaveBeenCalledWith([31.24, 121.49], 15, expect.anything());
    // The list closes behind the pick.
    expect(searchOptions()).toHaveLength(0);
  });

  it('picks the highlighted match on Enter, arrow keys moving the highlight', () => {
    setupStore();
    renderMapPanel();
    const box = typeSearch('a'); // matches both Shanghai places

    expect(searchOptions().length).toBeGreaterThan(1);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const highlighted = searchOptions().find((o) => o.getAttribute('aria-selected') === 'true');
    // Exactly one option is active, and it's the one the input points at —
    // that pairing is the whole combobox contract.
    expect(highlighted).toBe(searchOptions()[1]);
    expect(box).toHaveAttribute('aria-activedescendant', highlighted!.id);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(searchOptions()).toHaveLength(0);
    expect(mapStub.flyTo).toHaveBeenCalledTimes(1);
  });

  it('switches cities for a match elsewhere in the trip, and keeps it selected through the switch', () => {
    setupStore({ places: [TIANZIFANG, BUND, SUZHOU_GARDEN] });
    render(<CityHarness />);

    // Not reachable from Shanghai's pins — the search still finds it.
    typeSearch('humble');
    const [option] = searchOptions();
    expect(option).toHaveTextContent('Switch city');

    fireEvent.click(option);

    expect(showingCity()).toBe('Suzhou');
    // The city switch resets the day/pin selection for every OTHER reason;
    // this one has to survive it, or the jump lands on nothing.
    expect(document.querySelector('.pin-detail-name')).toHaveTextContent('Humble Administrator’s Garden');
    expect(mapStub.flyTo).toHaveBeenCalledWith([31.32, 120.63], 15, expect.anything());
  });

  it('counts a matching place with no location instead of silently dropping it', () => {
    const chain: Place = {
      id: 'place-chain',
      tripId: 'trip-1',
      name: 'Bund Snack Bar',
      city: 'Shanghai',
      status: 'wishlist',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    setupStore({ places: [BUND, chain] });
    renderMapPanel();
    typeSearch('bund');

    expect(searchOptions()).toHaveLength(1);
    expect(screen.getByText(/1 match has no location yet/)).toBeInTheDocument();
  });
});

describe('MapPanel — "View on map" focus request', () => {
  it('selects, centres and reports back the requested pin', () => {
    setupStore();
    const onFocusHandled = vi.fn();
    renderMapPanel({ focusRequest: { placeId: 'place-bund', nonce: 1 }, onFocusHandled });

    expect(screen.getByRole('group', { name: 'Days for The Bund' })).toBeInTheDocument();
    expect(mapStub.flyTo).toHaveBeenCalledWith([31.24, 121.49], 15, expect.anything());
    // Consumed once — a request left set would re-centre the map every time
    // the user came back to this tab.
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a request', () => {
    setupStore();
    renderMapPanel();
    expect(mapStub.flyTo).not.toHaveBeenCalled();
    expect(screen.getByText(/Tap a pin, or pick a day above/)).toBeInTheDocument();
  });
});
