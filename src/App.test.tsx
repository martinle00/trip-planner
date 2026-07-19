// @vitest-environment jsdom
//
// App-level integration test for Phase 2 requirement 1: "the timeline
// drives the map". Runs the real store -> DexieTripRepository -> Dexie
// chain against fake-indexeddb (an in-memory IndexedDB), so this seeds and
// loads exactly like the real app. `useOnlineStatus` is forced offline so
// the real react-leaflet `<MapContainer>` (which needs real browser
// layout/ResizeObserver APIs jsdom doesn't provide) never mounts — the
// Map tab's "Showing <City>" indicator, day chips and route-strip wiring
// render unconditionally regardless of online state, so this still
// faithfully exercises the requirement. The live Leaflet map itself needs
// manual/browser verification (see QA report).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Dexie from 'dexie';
import App from './App';

vi.mock('./hooks/useOnlineStatus', () => ({ useOnlineStatus: () => false }));

beforeEach(async () => {
  await Dexie.delete('china-trip-planner');
});

afterEach(async () => {
  await Dexie.delete('china-trip-planner');
});

function mapTab() {
  return screen.getByRole('tab', { name: /Map/ });
}
function itineraryTab() {
  return screen.getByRole('tab', { name: /Itinerary/ });
}
/** The route-strip node for a city, scoped to the timeline (not any
 *  same-named button elsewhere, e.g. the Itinerary tab's own per-city
 *  quick-nav button). */
function routeNode(cityName: string) {
  const strip = screen.getByLabelText(/Trip legs/);
  return within(strip).getByRole('button', { name: new RegExp(cityName) });
}

describe('App — timeline drives the Map', () => {
  it('tapping a route-strip city switches to/stays on the Map tab, updates the active city, and shows "Showing <City>" — never navigates to Itinerary', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    // Start on the Map tab by default.
    expect(mapTab()).toHaveAttribute('aria-selected', 'true');

    const suzhouNode = routeNode('Suzhou');
    fireEvent.click(suzhouNode);

    expect(mapTab()).toHaveAttribute('aria-selected', 'true');
    expect(itineraryTab()).toHaveAttribute('aria-selected', 'false');
    expect(suzhouNode).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Suzhou', { selector: 'strong' })).toBeInTheDocument();
  });

  it('switching to another tab first, then tapping the timeline, brings you back to Map (not Itinerary)', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    fireEvent.click(itineraryTab());
    expect(itineraryTab()).toHaveAttribute('aria-selected', 'true');

    const changshaNode = routeNode('Changsha');
    fireEvent.click(changshaNode);

    expect(mapTab()).toHaveAttribute('aria-selected', 'true');
    expect(itineraryTab()).toHaveAttribute('aria-selected', 'false');
  });

  it('the active city persists across tab switches (previews what Map will show)', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    fireEvent.click(routeNode('Chengdu'));
    fireEvent.click(itineraryTab());
    fireEvent.click(mapTab());

    expect(routeNode('Chengdu')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Chengdu', { selector: 'strong' })).toBeInTheDocument();
  });

  it('there is exactly one route-strip timeline (the old in-map city-chips row is gone)', async () => {
    render(<App />);
    await screen.findByRole('tablist');
    expect(screen.getAllByLabelText(/Trip legs/)).toHaveLength(1);
  });

  it('shows the offline fallback on the Map tab instead of crashing when offline', async () => {
    const { container } = render(<App />);
    await screen.findByRole('tablist');
    expect(container.querySelector('.offline-banner')).toBeTruthy();
    expect(screen.getAllByText(/needs a connection/).length).toBeGreaterThan(0);
  });
});

describe('App — shared Add-place modal (Phase 2 requirement 2)', () => {
  it('opens from the Map tab\'s "Add place" button without leaving the Map screen', async () => {
    render(<App />);
    await screen.findByRole('tablist');
    expect(mapTab()).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: /Add place/ }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Add a place')).toBeInTheDocument();
    // Still on the Map tab underneath the modal.
    expect(mapTab()).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the identical modal from the Places tab\'s own "Add place" button, without leaving Places', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    fireEvent.click(screen.getByRole('tab', { name: /Places/ }));
    expect(screen.getByRole('tab', { name: /Places/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: /Add place/ }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Add a place')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Places/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('Escape closes the modal and returns focus without navigating tabs', async () => {
    render(<App />);
    await screen.findByRole('tablist');
    fireEvent.click(screen.getByRole('button', { name: /Add place/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mapTab()).toHaveAttribute('aria-selected', 'true');
  });
});

describe('App — regression: other tabs still render', () => {
  it('Places, Itinerary and Budget tabs each render without crashing', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    fireEvent.click(screen.getByRole('tab', { name: /Places/ }));
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Itinerary/ }));
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Budget/ }));
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();

    fireEvent.click(mapTab());
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });
});
