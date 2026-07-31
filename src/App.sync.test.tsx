// @vitest-environment jsdom
//
// The offline-write chrome: the topbar pill's state matrix, the sync sheet's
// tap-only opening, and the sign-out guard. Split out from App.test.tsx
// because that file mocks `useOnlineStatus` to a constant `false` for the
// whole module (so Leaflet never mounts) and this needs to drive online/
// offline per test.
//
// Real store -> DexieTripRepository -> Dexie via fake-indexeddb, same harness
// as App.test.tsx; the outbox is seeded directly rather than by faking a
// network failure, since the queueing itself is covered in
// outboxTripRepository.test.ts.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Dexie from 'dexie';
import App from './App';
import { useTripStore } from './store/useTripStore';
import { outboxRepository } from './data/outboxRepository';
import { ACTIVE_TRIP_ID } from './data/tripRepository';

let onlineMock = true;
vi.mock('./hooks/useOnlineStatus', () => ({ useOnlineStatus: () => onlineMock }));

function queuedPlace(id: string) {
  return {
    entity: 'place' as const,
    op: 'upsert' as const,
    recordId: id,
    payload: {
      id,
      tripId: ACTIVE_TRIP_ID,
      name: `Queued ${id}`,
      city: 'Shanghai',
      lat: 31.2,
      lng: 121.4,
      status: 'wishlist' as const,
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    queuedAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  onlineMock = true;
  await Dexie.delete('china-trip-planner');
  window.sessionStorage.clear();
});

afterEach(async () => {
  // The store is a module singleton, so anything a test sets directly leaks
  // into the next one — a stale `uploadFailure` pins the pill to its failure
  // label and every later query for "N changes waiting" misses.
  useTripStore.setState({ uploadFailure: undefined, uploading: false, pendingCount: 0 });
  await outboxRepository.clearAll();
  await Dexie.delete('china-trip-planner');
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

/** Renders the app and seeds `count` pending changes into the store. */
async function renderWithPending(count: number) {
  render(<App />);
  await screen.findByRole('tablist');
  for (let i = 0; i < count; i++) await outboxRepository.append(queuedPlace(`q${i}`));
  await useTripStore.getState().refreshPendingCount();
  await waitFor(() => expect(useTripStore.getState().pendingCount).toBe(count));
}

describe('sync pill — state matrix', () => {
  it('stays out of the way when there is nothing pending', async () => {
    render(<App />);
    await screen.findByRole('tablist');
    expect(document.querySelector('.sync-pending')).toBeNull();
  });

  it('offers an upload action when online with changes queued', async () => {
    await renderWithPending(3);
    const pill = await screen.findByRole('button', { name: /3 changes waiting to upload/ });
    expect(pill).toBeEnabled();
  });

  it('shows the count but no action while offline', async () => {
    // The old rule was "hide the pill while offline". It survives, read
    // precisely: never claim to BE SYNCING offline. A count of unsaved work
    // is a different fact, and offline is when it matters most.
    onlineMock = false;
    await renderWithPending(2);
    const pill = await screen.findByRole('button', { name: /2 changes waiting · offline/ });
    // Not tappable: there is nothing tapping could achieve, and a button that
    // does nothing is worse than a label.
    expect(pill).toBeDisabled();
  });

  it('singularises one change', async () => {
    await renderWithPending(1);
    expect(await screen.findByRole('button', { name: /1 change waiting to upload/ })).toBeInTheDocument();
  });

  it('reports a partial upload distinctly from a fresh queue', async () => {
    await renderWithPending(2);
    useTripStore.setState({ uploadFailure: { uploaded: 1, remaining: 1 } });
    expect(
      await screen.findByRole('button', { name: /1 change still waiting · couldn't upload/ }),
    ).toBeInTheDocument();
  });
});

describe('sync sheet', () => {
  it('never opens on its own — only by tapping the pill', async () => {
    // A focus-trapping sheet raised by a background network event lands
    // mid-form, mid-drag, or while you're walking one-handed out of a metro.
    onlineMock = false;
    await renderWithPending(2);
    expect(screen.queryByText(/changes made while offline/)).not.toBeInTheDocument();

    // Coming back online is the moment it'd be most tempting to auto-raise —
    // and the moment it's most likely to land on top of something. (Queuing
    // one more change is what forces the re-render here; flipping the mock
    // alone changes no state React is watching.)
    onlineMock = true;
    await outboxRepository.append(queuedPlace('q2'));
    await screen.findByRole('button', { name: /3 changes waiting to upload/ });
    expect(screen.queryByText(/changes made while offline/)).not.toBeInTheDocument();
  });

  it('opens on tap and uploads on confirm', async () => {
    await renderWithPending(2);
    fireEvent.click(screen.getByRole('button', { name: /2 changes waiting to upload/ }));

    expect(await screen.findByText(/2 changes made while offline/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Upload$/ }));

    await waitFor(() => expect(useTripStore.getState().pendingCount).toBe(0));
  });

  it('leaves the queue alone when declined', async () => {
    await renderWithPending(2);
    fireEvent.click(screen.getByRole('button', { name: /2 changes waiting to upload/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(await outboxRepository.count()).toBe(2);
  });

  it('warns about overwriting only when someone else is on the trip', async () => {
    await renderWithPending(1);
    fireEvent.click(screen.getByRole('button', { name: /1 change waiting to upload/ }));
    // Seed trip has no companions — don't manufacture anxiety about a risk
    // that can't happen to a solo traveller.
    expect(screen.queryByText(/will replace theirs/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    const trip = useTripStore.getState().trip!;
    useTripStore.setState({
      trip: {
        ...trip,
        members: [
          { id: 'm1', name: 'Martin', color: '--m-1' },
          { id: 'm2', name: 'Susanna', color: '--m-2' },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /1 change waiting to upload/ }));
    expect(await screen.findByText(/will replace theirs/)).toBeInTheDocument();
  });
});

describe('sign-out with pending changes', () => {
  it('asks before discarding work the app already said was saved', async () => {
    await renderWithPending(2);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: /Sign out/ }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/2 changes have not been uploaded/));
    // Declined — the queue is untouched.
    expect(await outboxRepository.count()).toBe(2);
  });

  it('does not ask when everything is uploaded', async () => {
    render(<App />);
    await screen.findByRole('tablist');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: /Sign out/ }));

    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
