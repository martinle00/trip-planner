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

import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MapPanel } from './MapPanel';
import { useTripStore } from '../../store/useTripStore';
import type { Day, Place, Trip } from '../../data/schema';

let onlineMock = true;
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineMock,
}));

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
  useMap: () => ({ setView: vi.fn(), fitBounds: vi.fn() }),
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
    stagePlaceAssignment: vi.fn(async (placeId: string, dayId: string | undefined) => {
      const place = useTripStore.getState().places.find((p) => p.id === placeId);
      if (!place) return;
      useTripStore.setState((s) => {
        if (dayId === place.dayId) {
          const next = { ...s.stagedAssignments };
          delete next[placeId];
          return { stagedAssignments: next };
        }
        return { stagedAssignments: { ...s.stagedAssignments, [placeId]: { dayId, city: place.city } } };
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

function renderMapPanel() {
  return render(
    <MapPanel
      selectedCity="Shanghai"
      onOpenAutoPlan={() => {}}
      onOpenAddPlace={() => {}}
      onJumpToItinerary={() => {}}
    />,
  );
}

beforeEach(() => {
  onlineMock = true;
});

describe('MapPanel — staged changes', () => {
  it('stages a day reassignment via stagePlaceAssignment, not assignPlaceToDay, and shows it on the Save bar', () => {
    setupStore();
    renderMapPanel();

    // No Save bar yet — nothing staged.
    expect(screen.queryByRole('region', { name: 'Map save status' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Tianzifang/));
    const select = screen.getByLabelText('Assign Tianzifang to a day');
    fireEvent.change(select, { target: { value: 'day-2' } });

    expect(useTripStore.getState().stagePlaceAssignment).toHaveBeenCalledWith('place-tianzifang', 'day-2');
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  });

  it('reflects an already-staged assignment as the select\'s value and shows the "Unsaved change" pill', () => {
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayId: 'day-3', city: 'Shanghai' } } });
    renderMapPanel();

    fireEvent.click(screen.getByText(/Tianzifang/));
    const select = screen.getByLabelText('Assign Tianzifang to a day') as HTMLSelectElement;
    expect(select.value).toBe('day-3');
    // Scoped to the pill (a real <button>) — "Unsaved change" also appears as
    // plain text in the always-present legend entry.
    expect(screen.getByRole('button', { name: 'Unsaved change' })).toBeInTheDocument();
  });

  it('shows the cross-city hint and the correct per-city Discard scope', () => {
    setupStore({
      stagedAssignments: {
        'place-tianzifang': { dayId: 'day-2', city: 'Shanghai' },
        'place-elsewhere': { dayId: undefined, city: 'Suzhou' },
      },
    });
    renderMapPanel();

    expect(screen.getByText('2 unsaved changes')).toBeInTheDocument();
    expect(screen.getByText('+1 more in Suzhou')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard (Shanghai)' })).toBeInTheDocument();
  });

  it('Discard calls discardStagedAssignmentsForCity scoped to the city on screen', () => {
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayId: 'day-2', city: 'Shanghai' } } });
    renderMapPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Discard (Shanghai)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(useTripStore.getState().discardStagedAssignmentsForCity).toHaveBeenCalledWith('Shanghai');
  });

  it('Save calls saveStagedAssignments', async () => {
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayId: 'day-2', city: 'Shanghai' } } });
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
    setupStore({ stagedAssignments: { 'place-tianzifang': { dayId: 'day-2', city: 'Shanghai' } } });
    renderMapPanel();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});
