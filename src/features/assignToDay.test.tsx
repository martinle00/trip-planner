// @vitest-environment jsdom
//
// End-to-end (App-level) coverage for the "assign a place to a day now
// updates that day's itinerary" fix (see useTripStore.ts: assignPlaceToDay,
// applyAutoPlan, removePlace). Complements the store-level unit tests in
// store/useTripStore.test.ts by driving the real Places tab / Itinerary tab
// / Map day-view / Auto-plan modal components, so a regression that only
// shows up in how a component wires up the store action (not the store
// logic itself) would be caught here too.
//
// Same harness as App.test.tsx: real store -> DexieTripRepository -> Dexie
// chain against fake-indexeddb, useOnlineStatus forced offline so the real
// Leaflet map never mounts (day chips / pin-detail day-view still render
// unconditionally). Selecting a pin on the live map itself is manual/browser
// -only — see the QA report.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Dexie from 'dexie';
import App from '../App';

vi.mock('../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => false }));

beforeEach(async () => {
  await Dexie.delete('china-trip-planner');
});

afterEach(async () => {
  await Dexie.delete('china-trip-planner');
});

function placesTab() {
  return screen.getByRole('tab', { name: /Places/ });
}
function itineraryTab() {
  return screen.getByRole('tab', { name: /Itinerary/ });
}
function mapTab() {
  return screen.getByRole('tab', { name: /Map/ });
}

/** Assign (or reassign/unassign) a seeded place's day via its Places-tab
 *  card dropdown, matching the target option by its visible day label
 *  (e.g. /Day 1/, or /Wishlist/ to unassign). Waits for the change to
 *  actually commit (the store write is async). */
async function assignViaPlacesTab(placeName: string, optionMatcher: RegExp) {
  fireEvent.click(placesTab());
  const select = (await screen.findByLabelText(
    new RegExp(`Assign day for ${placeName}`),
  )) as HTMLSelectElement;
  const option = Array.from(select.options).find((o) => optionMatcher.test(o.textContent ?? ''));
  if (!option) throw new Error(`No option matching ${optionMatcher} for ${placeName}`);
  fireEvent.change(select, { target: { value: option.value } });
  await waitFor(() => expect(select.value).toBe(option.value));
}

describe('Assign place to day — Places tab -> Itinerary tab', () => {
  it('assigning a wishlist place makes it appear as an untimed stop in the Itinerary tab immediately', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    await assignViaPlacesTab('Marina Bay Sands', /Day 1/);

    fireEvent.click(itineraryTab());
    const stop = await screen.findByText('Marina Bay Sands');
    const stopRow = stop.closest('.stop');
    expect(stopRow).toBeTruthy();
    // Untimed: no start time was set by a plain assign.
    expect(within(stopRow as HTMLElement).getByText('--:--')).toBeInTheDocument();
  });

  it('reassigning to a different day moves the stop (old day empties, new day gets it), no duplicate', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    await assignViaPlacesTab('Marina Bay Sands', /Day 1/);
    await assignViaPlacesTab('Marina Bay Sands', /Day 2/);

    fireEvent.click(itineraryTab());
    const singapore = document.getElementById('it-singapore');
    expect(singapore).toBeTruthy();
    const stopTitles = await waitFor(() => {
      const titles = Array.from(singapore!.querySelectorAll('.stop-title')).map((n) => n.textContent);
      expect(titles).toContain('Marina Bay Sands');
      return titles;
    });
    // Exactly one stop titled Marina Bay Sands across all Singapore days.
    expect(stopTitles.filter((t) => t === 'Marina Bay Sands')).toHaveLength(1);

    // The day-1 section shows no stops for it (still "No stops planned yet"
    // unless the other seeded Singapore place also lives there).
    const day1Section = singapore!.querySelector('.it-day');
    expect(day1Section?.textContent).not.toContain('Marina Bay Sands');
  });

  it('unassigning back to wishlist removes the stop from the Itinerary tab', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    await assignViaPlacesTab('Marina Bay Sands', /Day 1/);
    fireEvent.click(itineraryTab());
    await screen.findByText('Marina Bay Sands');

    await assignViaPlacesTab('Marina Bay Sands', /Wishlist/);

    fireEvent.click(itineraryTab());
    await waitFor(() => {
      expect(screen.queryByText('Marina Bay Sands')).not.toBeInTheDocument();
    });
  });
});

describe('Assign place to day — Places tab -> Map day-view', () => {
  it('assigning a place makes it appear in that day\'s plan on the Map (day chip -> day-view list)', async () => {
    render(<App />);
    await screen.findByRole('tablist');
    // Default selected city is Singapore (first leg), and the app starts on
    // the Map tab.
    expect(mapTab()).toHaveAttribute('aria-selected', 'true');

    await assignViaPlacesTab('Marina Bay Sands', /Day 1/);

    fireEvent.click(mapTab());
    const day1Chip = await screen.findByRole('button', { name: /Day 1/ });
    fireEvent.click(day1Chip);

    const dayPlan = await screen.findByText('Marina Bay Sands');
    expect(dayPlan.closest('.dayplan-stop')).toBeTruthy();
  });

  it('reassigning moves the place off the old day\'s Map day-view onto the new one', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    await assignViaPlacesTab('Marina Bay Sands', /Day 1/);
    await assignViaPlacesTab('Marina Bay Sands', /Day 2/);

    fireEvent.click(mapTab());
    fireEvent.click(await screen.findByRole('button', { name: /Day 1/ }));
    await waitFor(() => {
      expect(screen.queryByText('Marina Bay Sands')).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByRole('button', { name: /Day 2/ }));
    expect(await screen.findByText('Marina Bay Sands')).toBeInTheDocument();
  });
});

describe('Delete place — regression, no orphaned stop', () => {
  it('removing an assigned place also removes it from the Itinerary tab', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    await assignViaPlacesTab('Marina Bay Sands', /Day 1/);

    const card = screen.getByText('Marina Bay Sands').closest('.place-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /Delete Marina Bay Sands/ }));

    fireEvent.click(itineraryTab());
    await waitFor(() => {
      expect(screen.queryByText('Marina Bay Sands')).not.toBeInTheDocument();
    });
  });
});

describe('Auto-plan accept — no duplicate stops, incl. rapid double-click', () => {
  it('accepting a generated draft writes exactly one stop per planned place', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    fireEvent.click(screen.getByRole('button', { name: /Auto-plan/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Generate draft/ }));
    await screen.findByText(/Draft preview/, {}, { timeout: 2000 });

    fireEvent.click(screen.getByRole('button', { name: /Accept draft/ }));
    await screen.findByText(/Draft applied/);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(itineraryTab());

    const singapore = document.getElementById('it-singapore');
    expect(singapore).toBeTruthy();
    const titles = Array.from(singapore!.querySelectorAll('.stop-title')).map((n) => n.textContent);
    // Both seeded Singapore places should be planned, exactly once each.
    expect(titles.filter((t) => t === 'Marina Bay Sands')).toHaveLength(1);
    expect(titles.filter((t) => t === 'Gardens by the Bay')).toHaveLength(1);
  });

  it('a rapid double-click on "Accept draft" does not duplicate the generated stops', async () => {
    render(<App />);
    await screen.findByRole('tablist');

    fireEvent.click(screen.getByRole('button', { name: /Auto-plan/ }));
    fireEvent.click(screen.getByRole('button', { name: /Generate draft/ }));
    await screen.findByText(/Draft preview/, {}, { timeout: 2000 });

    const acceptBtn = screen.getByRole('button', { name: /Accept draft/ });
    // Two overlapping clicks, fired back-to-back with no await between them
    // — reproduces a rapid double-click (accept() has no in-flight guard in
    // AutoPlanModal; the store's runExclusive queue is what prevents the
    // duplicate).
    fireEvent.click(acceptBtn);
    fireEvent.click(acceptBtn);
    await screen.findByText(/Draft applied/);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(itineraryTab());

    const singapore = document.getElementById('it-singapore');
    const titles = Array.from(singapore!.querySelectorAll('.stop-title')).map((n) => n.textContent);
    expect(titles.filter((t) => t === 'Marina Bay Sands')).toHaveLength(1);
    expect(titles.filter((t) => t === 'Gardens by the Bay')).toHaveLength(1);
  });
});
