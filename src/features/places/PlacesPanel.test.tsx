// @vitest-environment jsdom
//
// Component tests for the Places tab's city/category filter bar (Phase 2
// requirement 4). Store state is set directly via `useTripStore.setState` —
// no Dexie/IndexedDB involved. Critically exercises legacy/seed categories
// (e.g. 'Sightseeing', 'Wildlife') through the real UI to prove they're
// matched by their canonical filter chip via `categoryGroup()`, not silently
// orphaned.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlacesPanel } from './PlacesPanel';
import { useTripStore } from '../../store/useTripStore';
import type { Place, Trip } from '../../data/schema';

const TRIP: Trip = {
  id: 'trip-test',
  name: 'Test trip',
  startDate: '2026-11-07',
  endDate: '2026-11-30',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1, CNY: 0.21 },
  cities: [
    { name: 'Shanghai', order: 1, nights: 6, arrive: '2026-11-09', depart: '2026-11-15' },
    { name: 'Chengdu', order: 2, nights: 2, arrive: '2026-11-23', depart: '2026-11-25' },
  ],
};

// Mirrors the seed's mix of canonical and legacy/free-text categories.
const PLACES: Place[] = [
  { id: 'p1', tripId: 't', name: 'The Bund', city: 'Shanghai', category: 'Sightseeing', lat: 1, lng: 1, status: 'wishlist', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'p2', tripId: 't', name: 'Yu Garden', city: 'Shanghai', category: 'Garden', lat: 1, lng: 1, status: 'wishlist', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'p3', tripId: 't', name: 'Nanjing Road', city: 'Shanghai', category: 'Shopping', lat: 1, lng: 1, status: 'wishlist', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'p4', tripId: 't', name: 'Chengdu Panda Base', city: 'Chengdu', category: 'Wildlife', lat: 1, lng: 1, status: 'wishlist', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'p5', tripId: 't', name: 'Jinli Street', city: 'Chengdu', category: 'Food', lat: 1, lng: 1, status: 'wishlist', updatedAt: '2026-01-01T00:00:00.000Z' },
];

beforeEach(() => {
  useTripStore.setState({
    trip: TRIP,
    places: PLACES,
    days: [],
    itineraryByDay: {},
    expenses: [],
    loading: false,
    removePlace: vi.fn(),
    assignPlaceToDay: vi.fn(),
    // PlacesPanel always mounts a PlaceDetailModal (place=null until a card
    // is clicked) and scans every place's draft state on mount — stub these
    // rather than letting the real Dexie-backed store actions run, since
    // this test file never imports fake-indexeddb.
    getPlaceDraft: vi.fn().mockResolvedValue(undefined),
    savePlaceDraft: vi.fn().mockResolvedValue(undefined),
    discardPlaceDraft: vi.fn().mockResolvedValue(undefined),
    commitPlaceDraft: vi.fn().mockResolvedValue({ place: PLACES[0], merged: false }),
  });
});

describe('PlacesPanel — filters', () => {
  it('shows all 5 places and the unfiltered "N saved" hint by default', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    expect(screen.getByText('Chengdu Panda Base')).toBeInTheDocument();
    expect(screen.getByText('The Bund')).toBeInTheDocument();
    expect(screen.getByText('5 saved · 0 assigned to a day')).toBeInTheDocument();
  });

  it('the "Landmark" category chip matches a legacy "Sightseeing" seed place via categoryGroup()', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Landmark' }));
    expect(screen.getByText('The Bund')).toBeInTheDocument();
    expect(screen.queryByText('Yu Garden')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 5 shown')).toBeInTheDocument();
  });

  it('the "Nature" category chip matches a legacy "Wildlife" seed place', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Nature' }));
    expect(screen.getByText('Chengdu Panda Base')).toBeInTheDocument();
    expect(screen.getByText('1 of 5 shown')).toBeInTheDocument();
  });

  it('the "Shopping" category chip matches a place tagged Shopping', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shopping' }));
    expect(screen.getByText('Nanjing Road')).toBeInTheDocument();
    expect(screen.getByText('1 of 5 shown')).toBeInTheDocument();
  });

  it('the "Entertainment" category chip matches a legacy "Theme Park" place', () => {
    useTripStore.setState({
      places: [
        ...PLACES,
        { id: 'p6', tripId: 't', name: 'Splendid China', city: 'Shanghai', category: 'Theme Park', lat: 1, lng: 1, status: 'wishlist', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Entertainment' }));
    expect(screen.getByText('Splendid China')).toBeInTheDocument();
    expect(screen.queryByText('The Bund')).not.toBeInTheDocument();
  });

  it('no seed place is orphaned: every place appears under exactly one canonical category chip', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const canonicalChips = ['Landmark', 'Nature', 'Garden', 'Museum', 'Street / Market', 'Shopping', 'Food', 'Entertainment'];
    let totalMatched = 0;
    for (const chip of canonicalChips) {
      fireEvent.click(screen.getByRole('button', { name: chip }));
      const hint = screen.getByText(/of 5 shown|5 saved/);
      const match = hint.textContent?.match(/^(\d+) of 5 shown$/);
      if (match) totalMatched += Number(match[1]);
      fireEvent.click(screen.getByRole('button', { name: 'All categories' }));
    }
    expect(totalMatched).toBe(PLACES.length);
  });

  it('combines city and category filters (AND, not OR)', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Shanghai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nature' })); // Wildlife (Chengdu) shouldn't match Shanghai
    expect(screen.getByText('No places match these filters')).toBeInTheDocument();
    expect(screen.getByText('0 of 5 shown')).toBeInTheDocument();
  });

  it('shows a no-matches empty state with a working "Clear filters" action', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Shanghai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Museum' })); // no Shanghai museum in this fixture
    expect(screen.getByText('No places match these filters')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('5 saved · 0 assigned to a day')).toBeInTheDocument();
    expect(screen.getByText('Chengdu Panda Base')).toBeInTheDocument();
  });

  it('filtering by city alone scopes to that city\'s places across all its categories', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Chengdu' } });
    expect(screen.getByText('2 of 5 shown')).toBeInTheDocument();
    expect(screen.getByText('Chengdu Panda Base')).toBeInTheDocument();
    expect(screen.getByText('Jinli Street')).toBeInTheDocument();
    expect(screen.queryByText('The Bund')).not.toBeInTheDocument();
  });

  it('empty places list renders city sections with zero cards, not a crash', () => {
    useTripStore.setState({ places: [] });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    expect(screen.getByText('0 saved · 0 assigned to a day')).toBeInTheDocument();
  });
});

describe('PlacesPanel — card badges and description excerpt (Phase 4 items 3/4/7)', () => {
  it('shows a jade "Reviewed" tag only for a place with a saved selfReview', () => {
    useTripStore.setState({
      places: [{ ...PLACES[0], selfReview: 'Loved it here.' }, PLACES[1]],
    });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const reviewedCard = screen.getByText('The Bund').closest('.place-card') as HTMLElement;
    expect(within(reviewedCard).getByText('Reviewed')).toBeInTheDocument();
    const unreviewedCard = screen.getByText('Yu Garden').closest('.place-card') as HTMLElement;
    expect(within(unreviewedCard).queryByText('Reviewed')).not.toBeInTheDocument();
  });

  it('renders a description excerpt on the card — the removed `note` field has no consumer left', () => {
    useTripStore.setState({
      places: [{ ...PLACES[0], description: 'Best seen from across the river at dusk.' }, ...PLACES.slice(1)],
    });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    expect(screen.getByText('Best seen from across the river at dusk.')).toHaveClass('place-desc-excerpt');
  });

  it('shows a gold "Draft" tag once the initial per-place draft scan resolves', async () => {
    useTripStore.setState({
      getPlaceDraft: vi.fn(async (placeId: string) =>
        placeId === 'p1' ? { placeId, description: 'wip', baseUpdatedAt: '', savedAt: '' } : undefined,
      ),
    });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const card = screen.getByText('The Bund').closest('.place-card') as HTMLElement;
    await waitFor(() => expect(within(card).getByText('Draft')).toBeInTheDocument());
    const otherCard = screen.getByText('Yu Garden').closest('.place-card') as HTMLElement;
    expect(within(otherCard).queryByText('Draft')).not.toBeInTheDocument();
  });
});

describe('PlacesPanel — delete confirmation (Phase 4 item 6)', () => {
  it('a bare pin with nothing written warns plainly, and Cancel restores the card without deleting', () => {
    const removePlace = vi.fn();
    useTripStore.setState({ removePlace });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const card = screen.getByText('Yu Garden').closest('.place-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Delete Yu Garden' }));

    expect(screen.getByText(/This place has nothing written on it yet\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/This place has nothing written on it yet\./)).not.toBeInTheDocument();
    expect(screen.getByText('Yu Garden')).toBeInTheDocument();
    expect(removePlace).not.toHaveBeenCalled();
  });

  it('names the review word count and the notes, and deletes on confirm', () => {
    const removePlace = vi.fn();
    useTripStore.setState({
      places: [
        { ...PLACES[0], description: 'Bring cash', selfReview: 'A truly lovely walk along the water' },
        ...PLACES.slice(1),
      ],
      removePlace,
    });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const card = screen.getByText('The Bund').closest('.place-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Delete The Bund' }));

    expect(
      screen.getByText(/This will also delete your review \(7 words\) and your notes\./),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete place' }));
    expect(removePlace).toHaveBeenCalledWith('p1');
  });

  it('mentions an unsaved draft in the warning when one is pending for that place', async () => {
    useTripStore.setState({
      getPlaceDraft: vi.fn(async (placeId: string) =>
        placeId === 'p1' ? { placeId, description: 'wip', baseUpdatedAt: '', savedAt: '' } : undefined,
      ),
    });
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const card = await waitFor(() => {
      const c = screen.getByText('The Bund').closest('.place-card') as HTMLElement;
      expect(within(c).getByText('Draft')).toBeInTheDocument();
      return c;
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Delete The Bund' }));
    expect(screen.getByText(/This will also delete an unsaved draft\./)).toBeInTheDocument();
  });
});

describe('PlacesPanel — opening the detail modal', () => {
  it('clicking a card opens the detail modal for that place', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.click(screen.getByText('Yu Garden'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Yu Garden')).toBeInTheDocument();
  });

  it('the card\'s "Add notes" link also opens the detail modal, without navigating twice', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const card = screen.getByText('Yu Garden').closest('.place-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Add notes' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

// These assert the `hidden` attribute, which is as far as jsdom goes — it
// applies no stylesheet, so it cannot see that `.place-grid`'s `display:grid`
// out-specifies the UA's `[hidden]{display:none}`. That gap shipped a section
// that stayed visible when collapsed; `.place-grid[hidden]` in index.css is
// the fix, and only a real browser can catch a regression of it.
describe('PlacesPanel — collapsing city sections', () => {
  it('collapses a single city from its heading toggle, leaving other cities alone', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    const toggle = screen.getByRole('button', { name: /^Shanghai/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('The Bund').closest('.place-grid')).toHaveAttribute('hidden');
    expect(screen.getByText('Jinli Street').closest('.place-grid')).not.toHaveAttribute('hidden');

    fireEvent.click(toggle);
    expect(screen.getByText('The Bund').closest('.place-grid')).not.toHaveAttribute('hidden');
  });

  it('"Collapse all" collapses every visible city, then flips to "Expand all"', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Collapse all/ }));

    for (const name of ['Shanghai', 'Chengdu']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-expanded', 'false');
    }

    fireEvent.click(screen.getByRole('button', { name: /Expand all/ }));
    for (const name of ['Shanghai', 'Chengdu']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-expanded', 'true');
    }
  });

  it('a city hidden by the filters is not counted by the all-toggle', () => {
    render(<PlacesPanel onOpenAddPlace={() => {}} />);
    // Only Chengdu has a Food place, so Shanghai's section disappears and the
    // toggle (single visible city) goes away with it.
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    expect(screen.queryByRole('button', { name: /Collapse all/ })).not.toBeInTheDocument();
  });
});
