// @vitest-environment jsdom
//
// Regression coverage for the auth-remount bug: a routine same-user
// TOKEN_REFRESHED event (which supabase-js fires automatically on tab focus)
// must NOT unmount the wrapped children, since that reset all of App.tsx's
// local UI state (active tab, selected city, open modals). A genuine
// SIGNED_OUT/SIGNED_IN-as-a-different-user must still re-gate rendering.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthGate } from './AuthGate';

type Listener = (event: string, session: unknown) => void;

let authListener: Listener | undefined;
let currentSession: { user: { id: string } } | null = null;
/** When set, `getSession()` resolves only once this is released — lets a test
 *  land the listener's INITIAL_SESSION first and the slower getSession after. */
let getSessionGate: Promise<void> | undefined;

vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: async () => {
        if (getSessionGate) await getSessionGate;
        return { data: { session: currentSession } };
      },
      onAuthStateChange: (cb: Listener) => {
        authListener = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithOtp: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

// Mutable so a test can make the one-time bootstrap fail — see the
// 'bootstrap failure' block at the bottom of this file.
const bootstrapMigrationMock = vi.fn<() => Promise<void>>();
vi.mock('../../data/bootstrapMigration', () => ({
  bootstrapMigration: () => bootstrapMigrationMock(),
}));

beforeEach(() => {
  authListener = undefined;
  getSessionGate = undefined;
  currentSession = { user: { id: 'user-1' } };
  localStorage.clear();
  bootstrapMigrationMock.mockReset();
  bootstrapMigrationMock.mockResolvedValue(undefined);
  localStorage.setItem('trip-planner:bootstrapped:user-1', '1');
});

describe('AuthGate', () => {
  it('a routine TOKEN_REFRESHED for the same user does not unmount children', async () => {
    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());

    authListener?.('TOKEN_REFRESHED', { user: { id: 'user-1' } });

    // Still mounted immediately and after a tick — never re-gated.
    expect(screen.getByTestId('app-marker')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());
  });

  it('a late-resolving getSession() cannot strand the gate on "Loading…" after the listener already made it ready', async () => {
    // Regression test for the stuck-on-Loading bug: the listener's
    // INITIAL_SESSION lands first and settles the gate to ready, then the
    // slower getSession() resolves. It must not knock the gate backwards —
    // the repository effect is keyed on an unchanged userId, so nothing
    // would ever re-run to undo it.
    let releaseGetSession!: () => void;
    getSessionGate = new Promise<void>((resolve) => {
      releaseGetSession = resolve;
    });

    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    authListener?.('INITIAL_SESSION', { user: { id: 'user-1' } });
    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());

    releaseGetSession();
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByTestId('app-marker')).toBeInTheDocument();
    expect(screen.queryByText(/^Loading…$/)).not.toBeInTheDocument();
  });

  it('a genuine SIGNED_OUT re-gates rendering back to the sign-in screen', async () => {
    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());

    authListener?.('SIGNED_OUT', null);

    await waitFor(() => expect(screen.queryByTestId('app-marker')).not.toBeInTheDocument());
    expect(screen.getByText(/sign in/i)).toBeInTheDocument();
  });

  it('a same-user SIGNED_OUT immediately followed by a SIGNED_IN does not get stuck on the sign-in screen', async () => {
    // Regression test for the stale-ref race: refs must be updated
    // synchronously inside the callback, not via a delayed useEffect mirror,
    // so back-to-back events in the same tick see each other's decisions.
    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());

    authListener?.('SIGNED_OUT', null);
    authListener?.('SIGNED_IN', { user: { id: 'user-1' } });

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());
  });

  it('a SIGNED_IN as a different user re-runs the bootstrap/repository flow', async () => {
    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());

    authListener?.('SIGNED_IN', { user: { id: 'user-2' } });

    // No bootstrap flag for user-2, so the gate must re-run the
    // bootstrap/repository-construction flow (not just silently keep
    // showing user-1's already-mounted app content) before settling ready
    // again — asserted here via the bootstrap flag actually getting set for
    // the new user, proving the effect re-ran.
    await waitFor(() => expect(localStorage.getItem('trip-planner:bootstrapped:user-2')).toBe('1'));
    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());
  });
});

// The one-time bootstrap can genuinely fail — the case that prompted this was
// `import_trip_snapshot` returning 409 (`duplicate key value violates unique
// constraint "trips_pkey"`) for a second account. It used to reject inside an
// un-caught async effect: `wiredUserId` was never set, so the DERIVED gate
// state sat on 'bootstrapping' forever, and because the effect is keyed on
// values that hadn't changed it never retried. A spinner, indefinitely, with
// the only evidence in the server log.
describe('AuthGate — bootstrap failure', () => {
  beforeEach(() => {
    // First-ever sign-in on this device, so bootstrap actually runs.
    localStorage.removeItem('trip-planner:bootstrapped:user-1');
  });

  it('reports the failure instead of spinning forever, and shows the real error', async () => {
    bootstrapMigrationMock.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "trips_pkey"'),
    );

    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t open your trip/)).toBeInTheDocument();
    expect(screen.getByText(/trips_pkey/)).toBeInTheDocument();
    expect(screen.queryByTestId('app-marker')).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading your trip/)).not.toBeInTheDocument();
  });

  it('does not set the bootstrapped flag on failure — the next boot must retry', async () => {
    bootstrapMigrationMock.mockRejectedValueOnce(new Error('nope'));

    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(localStorage.getItem('trip-planner:bootstrapped:user-1')).toBeNull();
  });

  it('"Try again" re-runs the bootstrap and renders the app once it succeeds', async () => {
    bootstrapMigrationMock.mockRejectedValueOnce(new Error('transient'));

    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(bootstrapMigrationMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());
    expect(bootstrapMigrationMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('trip-planner:bootstrapped:user-1')).toBe('1');
  });

  it('a successful bootstrap still renders the app and sets the flag', async () => {
    render(
      <AuthGate>
        <div data-testid="app-marker">app content</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByTestId('app-marker')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(localStorage.getItem('trip-planner:bootstrapped:user-1')).toBe('1');
  });
});
