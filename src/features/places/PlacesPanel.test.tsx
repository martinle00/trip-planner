// @vitest-environment jsdom
//
// Component tests for the Places tab's city/category filter bar (Phase 2
// requirement 4). Store state is set directly via `useTripStore.setState` —
// no Dexie/IndexedDB involved. Critically exercises legacy/seed categories
// (e.g. 'Sightseeing', 'Wildlife') through the real UI to prove they're
// matched by their canonical filter chip via `categoryGroup()`, not silently
// orphaned.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  { id: 'p1', tripId: 't', name: 'The Bund', city: 'Shanghai', category: 'Sightseeing', lat: 1, lng: 1, status: 'wishlist' },
  { id: 'p2', tripId: 't', name: 'Yu Garden', city: 'Shanghai', category: 'Garden', lat: 1, lng: 1, status: 'wishlist' },
  { id: 'p3', tripId: 't', name: 'Nanjing Road', city: 'Shanghai', category: 'Shopping', lat: 1, lng: 1, status: 'wishlist' },
  { id: 'p4', tripId: 't', name: 'Chengdu Panda Base', city: 'Chengdu', category: 'Wildlife', lat: 1, lng: 1, status: 'wishlist' },
  { id: 'p5', tripId: 't', name: 'Jinli Street', city: 'Chengdu', category: 'Food', lat: 1, lng: 1, status: 'wishlist' },
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
        { id: 'p6', tripId: 't', name: 'Splendid China', city: 'Shanghai', category: 'Theme Park', lat: 1, lng: 1, status: 'wishlist' },
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
