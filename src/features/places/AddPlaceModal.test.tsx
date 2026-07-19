// @vitest-environment jsdom
//
// Component tests for the AddPlaceModal search state machine and save paths
// (Phase 2 requirement 3). `lib/geocode`'s `searchPlaces` is fully mocked —
// these tests never hit real Nominatim. `useOnlineStatus` is mocked so
// online/offline can be controlled per test. The store's `addPlace` action
// is stubbed via `useTripStore.setState` so saves never touch Dexie/IndexedDB.
//
// Fake timers are used throughout to assert the 300ms debounce precisely;
// `@testing-library`'s `waitFor`/`findBy*` poll on real timers and hang when
// fake timers are active, so every assertion here follows an explicit
// `flush()` (a 0ms fake-timer advance, which also drains pending
// microtasks) instead.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AddPlaceModal } from './AddPlaceModal';
import { useTripStore } from '../../store/useTripStore';
import type { TripState } from '../../store/useTripStore';
import { GeocodeError } from '../../lib/geocode';
import type { GeocodeResult } from '../../lib/geocode';
import { PLACE_CATEGORIES } from '../../lib/tripView';
import type { Place, Trip } from '../../data/schema';

const searchPlacesMock = vi.fn();
vi.mock('../../lib/geocode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/geocode')>();
  return {
    ...actual,
    searchPlaces: (...args: unknown[]) => searchPlacesMock(...args),
  };
});

let onlineMock = true;
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineMock,
}));

const TRIP: Trip = {
  id: 'trip-test',
  name: 'Test trip',
  startDate: '2026-11-07',
  endDate: '2026-11-30',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1, CNY: 0.21 },
  cities: [
    { name: 'Chengdu', order: 1, nights: 2, arrive: '2026-11-23', depart: '2026-11-25' },
    { name: 'Shanghai', order: 2, nights: 6, arrive: '2026-11-09', depart: '2026-11-15' },
  ],
};

function makeResult(overrides: Partial<GeocodeResult> = {}): GeocodeResult {
  return {
    name: 'Chengdu Panda Base',
    address: 'Chengdu Panda Base, Chenghua, Chengdu, Sichuan, China',
    lat: 30.733,
    lng: 104.145,
    category: 'attraction',
    sourceId: 'osm:way/1',
    ...overrides,
  };
}

let addPlaceMock: ReturnType<typeof vi.fn<TripState['addPlace']>>;

function resetStore(placesOverride: Place[] = []) {
  addPlaceMock = vi.fn<TripState['addPlace']>().mockResolvedValue({} as Place);
  useTripStore.setState({
    trip: TRIP,
    places: placesOverride,
    days: [],
    itineraryByDay: {},
    expenses: [],
    loading: false,
    addPlace: addPlaceMock,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  searchPlacesMock.mockReset();
  onlineMock = true;
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Drain any pending microtasks (e.g. an already-resolved mock promise)
 *  without advancing the debounce clock. Needs a couple of ticks: one for
 *  the mocked promise's own resolution, one for the state update it
 *  triggers to actually commit. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

/** Advance fake time by the full debounce window, then drain microtasks so
 *  the resulting (mocked, already-resolved/rejected) search promise has
 *  fully settled and its state update has committed. */
async function advanceDebounce() {
  await vi.advanceTimersByTimeAsync(300);
  await flush();
}

describe('AddPlaceModal — search state machine', () => {
  it('debounces: typing does not call searchPlaces until 300ms after the last keystroke, then calls it exactly once', async () => {
    searchPlacesMock.mockResolvedValue([makeResult()]);
    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);

    const input = screen.getByPlaceholderText('Search for a place or address…');
    fireEvent.change(input, { target: { value: 'pa' } });
    await vi.advanceTimersByTimeAsync(200);
    expect(searchPlacesMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'panda' } });
    await vi.advanceTimersByTimeAsync(200);
    expect(searchPlacesMock).not.toHaveBeenCalled(); // reset by the second keystroke

    await vi.advanceTimersByTimeAsync(100); // total 300ms since the *last* keystroke
    expect(searchPlacesMock).toHaveBeenCalledTimes(1);
    expect(searchPlacesMock).toHaveBeenCalledWith(
      'panda',
      expect.objectContaining({ cityHint: 'Chengdu' }),
    );
  });

  it('aborts the previous in-flight request when a newer keystroke supersedes it', async () => {
    const pending: { reject: (e: unknown) => void }[] = [];
    searchPlacesMock.mockImplementation(
      (_q: string, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          pending.push({ reject });
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);
    const input = screen.getByPlaceholderText('Search for a place or address…');

    fireEvent.change(input, { target: { value: 'temple' } });
    await advanceDebounce();
    expect(searchPlacesMock).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: 'temple garden' } });
    await advanceDebounce();
    expect(searchPlacesMock).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(2);

    // Still no error surfaced — the first request's rejection (from its
    // controller being aborted) must have been swallowed silently.
    expect(screen.queryByText("Search isn't working right now")).not.toBeInTheDocument();
  });

  it('[] results -> "no results" state', async () => {
    searchPlacesMock.mockResolvedValue([]);
    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search for a place or address…'), {
      target: { value: 'nonexistent place xyz' },
    });
    await advanceDebounce();
    expect(screen.getByText(/No results for/)).toBeInTheDocument();
  });

  it('a thrown GeocodeError -> error state with manual-entry fallback offered', async () => {
    searchPlacesMock.mockRejectedValue(new GeocodeError('boom'));
    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search for a place or address…'), {
      target: { value: 'temple' },
    });
    await advanceDebounce();
    expect(screen.getByText("Search isn't working right now")).toBeInTheDocument();
    // Manual-entry fallback is still reachable from the error state.
    expect(screen.getByText(/Can.t find it\? Enter it manually/)).toBeInTheDocument();
  });

  it('a thrown AbortError is ignored silently (never surfaces the error state)', async () => {
    let rejectFirst: ((e: unknown) => void) | undefined;
    searchPlacesMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce([]);

    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);
    const input = screen.getByPlaceholderText('Search for a place or address…');

    fireEvent.change(input, { target: { value: 'temple' } });
    await advanceDebounce();
    expect(searchPlacesMock).toHaveBeenCalledTimes(1);

    // Simulate the real fetch/AbortController behavior: aborting rejects
    // with an AbortError-named error.
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    rejectFirst?.(abortErr);
    await flush();

    // Must NOT show the error UI — and the loading state (from the still-
    // in-flight second call in a real flow) is untouched by the abort.
    expect(screen.queryByText("Search isn't working right now")).not.toBeInTheDocument();
  });

  it('offline short-circuits: searchPlaces is never called, and the offline message shows', async () => {
    onlineMock = false;
    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);
    expect(screen.getByText('Search needs a connection')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search for a place or address…'), {
      target: { value: 'temple' },
    });
    await advanceDebounce();
    expect(searchPlacesMock).not.toHaveBeenCalled();
  });
});

describe('AddPlaceModal — category selector', () => {
  it('offers exactly the canonical 8 categories, in order, defaulting to the first — and "Neighbourhood" is gone', async () => {
    render(<AddPlaceModal open mode="pin" point={{ lat: 1, lng: 1 }} defaultCity="Chengdu" onClose={() => {}} />);

    const select = screen.getByLabelText('Category') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.value);
    expect(optionLabels).toEqual(PLACE_CATEGORIES);
    expect(optionLabels).toEqual([
      'Landmark', 'Nature', 'Garden', 'Museum', 'Street / Market', 'Shopping', 'Food', 'Entertainment',
    ]);
    expect(optionLabels).not.toContain('Neighbourhood');
    expect(select.value).toBe(PLACE_CATEGORIES[0]);
  });

  it('saving with a chosen category (e.g. the new "Shopping") persists it on the place', async () => {
    render(<AddPlaceModal open mode="pin" point={{ lat: 1, lng: 1 }} defaultCity="Chengdu" onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A shop' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Shopping' } });
    fireEvent.click(screen.getByText('Save to wishlist'));
    await flush();

    expect(addPlaceMock).toHaveBeenCalledTimes(1);
    expect(addPlaceMock.mock.calls[0][0].category).toBe('Shopping');
  });

  it('saving with the new "Entertainment" category persists it on the place', async () => {
    render(<AddPlaceModal open mode="pin" point={{ lat: 1, lng: 1 }} defaultCity="Chengdu" onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A theme park' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Entertainment' } });
    fireEvent.click(screen.getByText('Save to wishlist'));
    await flush();

    expect(addPlaceMock).toHaveBeenCalledTimes(1);
    expect(addPlaceMock.mock.calls[0][0].category).toBe('Entertainment');
  });
});

describe('AddPlaceModal — save paths', () => {
  it('saving a selected search result persists lat/lng/address from that result', async () => {
    const result = makeResult();
    searchPlacesMock.mockResolvedValue([result]);
    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Search for a place or address…'), {
      target: { value: 'panda base' },
    });
    await advanceDebounce();
    expect(screen.getByText(result.name)).toBeInTheDocument();

    fireEvent.click(screen.getByText(result.name));
    fireEvent.click(screen.getByText('Save to wishlist'));
    await flush();

    expect(addPlaceMock).toHaveBeenCalledTimes(1);
    const saved = addPlaceMock.mock.calls[0][0];
    expect(saved.lat).toBe(result.lat);
    expect(saved.lng).toBe(result.lng);
    expect(saved.address).toBe(result.address);
    expect(saved.name).toBe(result.name);
  });

  it('pin mode keeps the tapped coordinate and sets no address', async () => {
    render(
      <AddPlaceModal open mode="pin" point={{ lat: 12.34, lng: 56.78 }} defaultCity="Chengdu" onClose={() => {}} />,
    );

    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'My dropped pin' } });
    fireEvent.click(screen.getByText('Save to wishlist'));
    await flush();

    expect(addPlaceMock).toHaveBeenCalledTimes(1);
    const saved = addPlaceMock.mock.calls[0][0];
    expect(saved.lat).toBe(12.34);
    expect(saved.lng).toBe(56.78);
    expect(saved.address).toBeUndefined();
    expect(saved.name).toBe('My dropped pin');
  });

  it('manual entry uses the city-centroid/fallback location and sets no address', async () => {
    resetStore([]); // no existing places in Chengdu -> static fallback center
    render(<AddPlaceModal open mode="search" point={null} defaultCity="Chengdu" onClose={() => {}} />);

    fireEvent.click(screen.getByText(/Can.t find it\? Enter it manually/));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Manually entered place' } });
    fireEvent.click(screen.getByText('Save to wishlist'));
    await flush();

    expect(addPlaceMock).toHaveBeenCalledTimes(1);
    const saved = addPlaceMock.mock.calls[0][0];
    // Static Chengdu fallback from lib/tripView.ts's CITY_FALLBACK_CENTER.
    expect(saved.lat).toBe(30.5728);
    expect(saved.lng).toBe(104.0668);
    expect(saved.address).toBeUndefined();
  });
});
