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
import type { Day, ItineraryItem, Trip } from '../../data/schema';

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
