// @vitest-environment jsdom
//
// Component tests for the Itinerary tab's reorder mode: the toggle's two
// labels, the grip handle only existing while reordering, and both ways of
// moving a stop (pointer drag + keyboard). Store state is set directly via
// `useTripStore.setState` — no Dexie/IndexedDB involved.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ItineraryPanel } from './ItineraryPanel';
import { useTripStore } from '../../store/useTripStore';
import type { Day, ItineraryItem, Place, Trip } from '../../data/schema';

const TRIP: Trip = {
  id: 'trip-test',
  name: 'Test trip',
  startDate: '2026-11-07',
  endDate: '2026-11-10',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1, CNY: 0.21 },
  cities: [{ name: 'Shanghai', order: 1, nights: 3, arrive: '2026-11-07', depart: '2026-11-10' }],
};

const DAYS: Day[] = [{ id: 'd1', tripId: 'trip-test', date: '2026-11-07', city: 'Shanghai' }];

const ITEMS: ItineraryItem[] = [
  { id: 'i1', dayId: 'd1', title: 'The Bund', order: 0 },
  { id: 'i2', dayId: 'd1', title: 'Yu Garden', order: 1 },
  { id: 'i3', dayId: 'd1', title: 'Nanjing Road', order: 2 },
];

const ROW_HEIGHT = 50;

type ReorderFn = (dayId: string, orderedIds: string[]) => Promise<void>;
let reorderItinerary: ReturnType<typeof vi.fn<ReorderFn>>;

beforeEach(() => {
  reorderItinerary = vi.fn<ReorderFn>(async () => {});
  useTripStore.setState({
    trip: TRIP,
    days: DAYS,
    places: [],
    itineraryByDay: { d1: ITEMS },
    expenses: [],
    loading: false,
    reorderItinerary,
    removeItineraryItem: vi.fn(),
    addItineraryItem: vi.fn(),
    updateItineraryItem: vi.fn(),
  });

  // jsdom lays nothing out, so drag geometry has to be faked: uniform
  // stacked rows, no gap. Only `.stop` rects are read by the component.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rows = Array.from(document.querySelectorAll('.stop'));
    const idx = rows.indexOf(this);
    const top = idx < 0 ? 0 : idx * ROW_HEIGHT;
    return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  // Pointer capture isn't implemented in jsdom.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
});

function enterReorderMode() {
  fireEvent.click(screen.getByRole('button', { name: /Reorder stops/ }));
}

function gripFor(title: string) {
  return screen.getByRole('button', { name: new RegExp(`^Reorder ${title},`) });
}

describe('ItineraryPanel — reorder mode', () => {
  it('the toggle reads "Save changes" while reordering and switches back on exit', () => {
    render(<ItineraryPanel />);
    expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument();

    enterReorderMode();
    const save = screen.getByRole('button', { name: /Save changes/ });
    expect(save).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(save);
    expect(screen.getByRole('button', { name: /Reorder stops/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows a drag handle per stop only while reordering — and no up/down buttons at all', () => {
    render(<ItineraryPanel />);
    expect(screen.queryByRole('button', { name: /^Reorder The Bund/ })).not.toBeInTheDocument();

    enterReorderMode();
    expect(gripFor('The Bund')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move stop (up|down)/ })).not.toBeInTheDocument();
  });

  it('dragging a stop down past two rows commits the new order', () => {
    render(<ItineraryPanel />);
    enterReorderMode();
    const grip = gripFor('The Bund');

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 25 });
    // +1: the row has to pass the last row's midpoint, not just reach it.
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 25 + 2 * ROW_HEIGHT + 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(reorderItinerary).toHaveBeenCalledWith('d1', ['i2', 'i3', 'i1']);
  });

  it('a drag that never leaves its own row does not write', () => {
    render(<ItineraryPanel />);
    enterReorderMode();
    const grip = gripFor('Yu Garden');

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 75 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 80 });
    fireEvent.pointerUp(grip, { pointerId: 1 });

    expect(reorderItinerary).not.toHaveBeenCalled();
  });

  it('a cancelled drag (pointercancel) is discarded', () => {
    render(<ItineraryPanel />);
    enterReorderMode();
    const grip = gripFor('The Bund');

    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientY: 25 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 25 + 2 * ROW_HEIGHT });
    fireEvent.pointerCancel(grip, { pointerId: 1 });

    expect(reorderItinerary).not.toHaveBeenCalled();
  });

  it('the handle also reorders from the keyboard, and ignores moves past the ends', () => {
    render(<ItineraryPanel />);
    enterReorderMode();

    fireEvent.keyDown(gripFor('Yu Garden'), { key: 'ArrowUp' });
    expect(reorderItinerary).toHaveBeenLastCalledWith('d1', ['i2', 'i1', 'i3']);

    // Yu Garden is now the first row, so it has nowhere further up to go.
    reorderItinerary.mockClear();
    fireEvent.keyDown(gripFor('Yu Garden'), { key: 'ArrowUp' });
    expect(reorderItinerary).not.toHaveBeenCalled();
  });

  it('renders the pending order immediately, before the store write lands', () => {
    render(<ItineraryPanel />);
    enterReorderMode();
    fireEvent.keyDown(gripFor('Nanjing Road'), { key: 'ArrowUp' });

    const titles = Array.from(document.querySelectorAll('.stop-title')).map((n) => n.textContent);
    expect(titles).toEqual(['The Bund', 'Nanjing Road', 'Yu Garden']);
  });
});

describe('ItineraryPanel — stop rows outside reorder mode', () => {
  it('keeps edit and remove available', () => {
    render(<ItineraryPanel />);
    const row = screen.getByText('Yu Garden').closest('.stop') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Edit Yu Garden' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Remove Yu Garden' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The Add-stop picker. Adding a stop starts from the places already collected
// in the Places tab rather than a blank Title field, so these cover which
// places get offered (and, just as importantly, which don't) plus the
// free-text escape hatch that has to keep working for stops that aren't map
// pins at all.
// ---------------------------------------------------------------------------

const TWO_CITY_TRIP: Trip = {
  ...TRIP,
  cities: [
    { name: 'Shanghai', order: 1, nights: 2, arrive: '2026-11-07', depart: '2026-11-09' },
    { name: 'Suzhou', order: 2, nights: 1, arrive: '2026-11-09', depart: '2026-11-10' },
  ],
};

const TWO_CITY_DAYS: Day[] = [
  { id: 'd1', tripId: 'trip-test', date: '2026-11-07', city: 'Shanghai' },
  { id: 'd2', tripId: 'trip-test', date: '2026-11-08', city: 'Shanghai' },
  { id: 'd3', tripId: 'trip-test', date: '2026-11-09', city: 'Suzhou' },
];

function place(id: string, name: string, city: string, category?: string): Place {
  return {
    id,
    tripId: 'trip-test',
    name,
    city,
    category,
    lat: 31.2,
    lng: 121.4,
    status: 'wishlist',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const PLACES: Place[] = [
  place('p1', 'Yu Garden', 'Shanghai', 'Garden'),
  place('p2', 'The Bund', 'Shanghai', 'Landmark'),
  place('p3', 'Tiger Hill', 'Suzhou', 'Landmark'),
];

interface PickerOverrides {
  places?: Place[];
  itineraryByDay?: Record<string, ItineraryItem[]>;
}

function renderWithPlaces(overrides: PickerOverrides = {}) {
  const addItineraryItem = vi.fn(async (input: unknown) => input);
  useTripStore.setState({
    trip: TWO_CITY_TRIP,
    days: TWO_CITY_DAYS,
    places: overrides.places ?? PLACES,
    itineraryByDay: overrides.itineraryByDay ?? {},
    expenses: [],
    loading: false,
    reorderItinerary,
    removeItineraryItem: vi.fn(),
    addItineraryItem: addItineraryItem as unknown as never,
    updateItineraryItem: vi.fn(),
  });
  render(<ItineraryPanel />);
  return { addItineraryItem };
}

/** Opens the Add-stop modal for the nth day section on screen (0-based). */
function openAddStop(dayIndex = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: /Add stop/ })[dayIndex]);
}

/** The modal's submit button — scoped by type so it can't collide with the
 *  per-day "Add stop" buttons behind the modal, which share its label. */
function submitStop(): HTMLElement {
  return document.querySelector('form button[type="submit"]') as HTMLElement;
}

function offeredPlaceNames(): string[] {
  return Array.from(document.querySelectorAll('.search-result-name')).map((n) => n.textContent ?? '');
}

describe('ItineraryPanel — Add stop place picker', () => {
  it('offers only places in that day’s city', () => {
    renderWithPlaces();
    openAddStop(0); // Shanghai

    expect(offeredPlaceNames()).toEqual(['The Bund', 'Yu Garden']);
    expect(offeredPlaceNames()).not.toContain('Tiger Hill');
  });

  it('excludes a place that already has a stop on ANOTHER day', () => {
    // p1 is scheduled on d2; opening Add stop on d1 (same city) must not
    // re-offer it. `place.dayId` alone wouldn't catch this reliably — the
    // itinerary is the source of truth.
    renderWithPlaces({
      itineraryByDay: { d2: [{ id: 'x1', dayId: 'd2', placeId: 'p1', title: 'Yu Garden', order: 0 }] },
    });
    openAddStop(0);

    expect(offeredPlaceNames()).toEqual(['The Bund']);
  });

  it('hides the search box until the list is long enough to need one', () => {
    renderWithPlaces(); // 2 Shanghai candidates
    openAddStop(0);
    expect(screen.queryByLabelText('Filter places')).not.toBeInTheDocument();
    expect(offeredPlaceNames()).toEqual(['The Bund', 'Yu Garden']);
  });

  it('filters the offered places by the search box once it appears', () => {
    const many = [
      ...PLACES,
      ...Array.from({ length: 7 }, (_, i) => place(`f${i}`, `Filler ${i}`, 'Shanghai')),
    ];
    renderWithPlaces({ places: many });
    openAddStop(0);

    fireEvent.change(screen.getByLabelText('Filter places'), { target: { value: 'bund' } });
    expect(offeredPlaceNames()).toEqual(['The Bund']);

    fireEvent.change(screen.getByLabelText('Filter places'), { target: { value: 'zzz' } });
    expect(offeredPlaceNames()).toEqual([]);
    expect(screen.getByText(/No places match/)).toBeInTheDocument();
  });

  it('picking a place submits a stop carrying both placeId and the place name', async () => {
    const { addItineraryItem } = renderWithPlaces();
    openAddStop(0);

    fireEvent.click(screen.getByText('Yu Garden').closest('button') as HTMLElement);
    fireEvent.click(submitStop());

    expect(addItineraryItem).toHaveBeenCalledTimes(1);
    expect(addItineraryItem.mock.calls[0][0]).toMatchObject({
      dayId: 'd1',
      placeId: 'p1',
      title: 'Yu Garden',
    });
  });

  it('the free-text escape hatch still produces a stop with no placeId', () => {
    const { addItineraryItem } = renderWithPlaces();
    openAddStop(0);

    fireEvent.click(screen.getByRole('button', { name: /Type a custom stop instead/ }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Check in to hotel' } });
    fireEvent.click(submitStop());

    expect(addItineraryItem.mock.calls[0][0]).toMatchObject({
      dayId: 'd1',
      title: 'Check in to hotel',
    });
    expect((addItineraryItem.mock.calls[0][0] as { placeId?: string }).placeId).toBeUndefined();
  });

  it('falls back to free text, with a pointer at the Places tab, when nothing is left to pick', () => {
    renderWithPlaces({ places: [] });
    openAddStop(0);

    expect(document.querySelector('.search-results')).toBeNull();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByText(/add them in the Places tab/)).toBeInTheDocument();
  });

  it('cannot submit until a place is picked', () => {
    renderWithPlaces();
    openAddStop(0);

    expect(submitStop()).toBeDisabled();
    fireEvent.click(screen.getByText('Yu Garden').closest('button') as HTMLElement);
    expect(submitStop()).toBeEnabled();
  });

  it('keeps focus inside the dialog when swapping between picker and free text', () => {
    // <Modal/> only manages focus when it OPENS, so a mode swap that
    // unmounts the focused control would otherwise drop focus to <body> and
    // force a keyboard user to tab in from the top of the dialog again.
    renderWithPlaces();
    openAddStop(0);

    fireEvent.click(screen.getByRole('button', { name: /Type a custom stop instead/ }));
    expect(document.activeElement).toBe(screen.getByLabelText('Title'));

    // No search field on a short list, so focus falls back to the first place
    // rather than nothing.
    fireEvent.click(screen.getByRole('button', { name: /Pick from your places instead/ }));
    expect(document.activeElement).toBe(document.querySelector('.search-result'));

    // ...and the same on the way back out of a selection.
    fireEvent.click(screen.getByText('Yu Garden').closest('button') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /^Change selected place/ }));
    expect(document.activeElement).toBe(document.querySelector('.search-result'));
  });

  it('editing an existing free-text stop is unaffected by the picker', () => {
    renderWithPlaces({
      itineraryByDay: { d1: [{ id: 'x9', dayId: 'd1', title: 'Dinner booking', order: 0 }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Dinner booking' }));

    expect(document.querySelector('.search-results')).toBeNull();
    expect(screen.getByLabelText('Title')).toHaveValue('Dinner booking');
  });
});
