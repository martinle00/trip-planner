import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabaseClient';
import { DexieTripRepository } from '../../data/dexieTripRepository';
import { SupabaseTripRepository } from '../../data/supabaseTripRepository';
import { SyncedTripRepository } from '../../data/syncedTripRepository';
import { OutboxTripRepository } from '../../data/outboxTripRepository';
import { setTripRepository } from '../../data/tripRepositoryInstance';
import { bootstrapMigration } from '../../data/bootstrapMigration';

type GateState = 'checking-session' | 'signed-out' | 'bootstrapping' | 'bootstrap-failed' | 'ready';

/** localStorage key recording that `bootstrapMigration` has already run
 *  (successfully reached a decision) for a given user on this device.
 *  Bootstrap's remote `getTrip()` round-trip is only meaningful the very
 *  first time a device signs in — every later boot is pure overhead, so
 *  it's skipped once this flag is set (see the effect below). */
function bootstrapFlagKey(userId: string): string {
  return `trip-planner:bootstrapped:${userId}`;
}

/** The full write path: offline queue on the outside, write-through sync in
 *  the middle, Supabase + the Dexie cache at the bottom. The outbox has to be
 *  outermost -- it queues on the failure the synced layer would otherwise
 *  propagate, and it needs the same local cache to mirror into so the app
 *  keeps reading its own offline edits (see outboxTripRepository.ts). */
function buildRepository(remote: SupabaseTripRepository, local: DexieTripRepository) {
  return new OutboxTripRepository(new SyncedTripRepository(remote, local), local);
}

/** Wraps the app: gates rendering behind a Supabase magic-link sign-in, then
 *  wires up the synced (Supabase + Dexie cache) repository before the app's
 *  own init() runs. Session persistence is handled by supabase-js itself
 *  (localStorage), so a reload keeps you signed in.
 *
 *  Only the very first sign-in ever on a device pays for `bootstrapMigration`
 *  (a real Supabase round-trip, needed once to decide whether an existing
 *  local trip should be pushed up). Every later boot for the same user skips
 *  it entirely and renders immediately once the repository is wired up — the
 *  store's own cache-first `init()` (see useTripStore.ts) takes it from
 *  there, painting cached data instantly and reconciling with the server in
 *  the background. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  /** Whether the initial "is there a persisted session?" question has been
   *  answered yet (by `getSession()` or the listener's first event). */
  const [sessionResolved, setSessionResolved] = useState(false);
  /** The user id the trip repository is currently wired up for, or null. */
  const [wiredUserId, setWiredUserId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  /** Why the one-time bootstrap failed, if it did. Without this the async
   *  effect below could reject and simply never set `wiredUserId` — leaving
   *  the gate on its spinner forever, with nothing to retry it, because the
   *  effect is keyed on values that didn't change. That is exactly how a
   *  409 from `import_trip_snapshot` presented: an endless "Loading your
   *  trip…" on the device, and the only evidence server-side. */
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  /** Bumped by "Try again" to re-run the bootstrap effect. */
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userId = session?.user?.id ?? null;

  // Latch so whichever of `getSession()` / the listener's first event lands
  // first wins, and the slower one can't clobber it. Read and written
  // synchronously in the same callback, so there's no stale-read race.
  const resolvedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled || resolvedRef.current) return;
      resolvedRef.current = true;
      setSession(data.session);
      setSessionResolved(true);
    });

    // Every auth event does the same, minimal thing: record the latest
    // session. Nothing here decides what to *render* — that's derived below
    // from (userId, wiredUserId), so a routine TOKEN_REFRESHED (which
    // supabase-js fires automatically on tab focus, producing a new session
    // object for the same user) can never re-gate rendering and unmount
    // <App/>, losing its local state (active tab, selected city, modals).
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      resolvedRef.current = true;
      setSession(newSession);
      setSessionResolved(true);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  // Wire the repository for whoever is signed in. Keyed on the user id (not
  // the session object), so a token refresh doesn't reconstruct it or re-run
  // bootstrap mid-session; the `wiredUserId === userId` guard makes re-runs
  // idempotent.
  useEffect(() => {
    if (!userId) {
      setWiredUserId(null);
      setBootstrapping(false);
      return;
    }
    if (wiredUserId === userId) return;

    let cancelled = false;
    const local = new DexieTripRepository();
    const remote = new SupabaseTripRepository(supabase, userId);
    const flagKey = bootstrapFlagKey(userId);

    if (localStorage.getItem(flagKey) === '1') {
      // Returning session on this device: skip bootstrapMigration's remote
      // round-trip entirely and render right away.
      setTripRepository(buildRepository(remote, local));
      setWiredUserId(userId);
      return;
    }

    // First-ever sign-in on this device for this user: bootstrapMigration
    // needs one real check against the remote before it's safe to proceed
    // (see bootstrapMigration.ts) — this is the one boot that briefly waits.
    setBootstrapping(true);
    setBootstrapError(null);
    (async () => {
      try {
        await bootstrapMigration(local, remote);
        if (cancelled) return;
        localStorage.setItem(flagKey, '1');
        setTripRepository(buildRepository(remote, local));
        setWiredUserId(userId);
        setBootstrapping(false);
      } catch (err) {
        if (cancelled) return;
        // The flag is deliberately NOT set: this device hasn't successfully
        // bootstrapped, so the next boot must try again rather than wiring up
        // a repository whose one-time migration never ran.
        console.error('Bootstrap failed', err);
        setBootstrapError(err instanceof Error ? err.message : String(err));
        setBootstrapping(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, wiredUserId, bootstrapAttempt]);

  // What to render, DERIVED rather than imperatively assigned. This is the
  // key invariant: as long as the repository is wired for the currently
  // signed-in user, the gate is 'ready' — no ordering of auth events can
  // knock it backwards. An earlier version tracked this as its own state
  // that events wrote to imperatively, which stranded the gate on
  // "Loading…" whenever a late-resolving `getSession()` reset it to
  // 'checking-session' after the repository effect had already settled
  // (the effect, keyed on an unchanged userId, then never re-ran to undo it).
  //
  // `bootstrapError` is read here but never *un*-sets 'ready': it's only
  // consulted once `wiredUserId !== userId`, so the invariant above still
  // holds exactly as written — a wired repository always renders the app,
  // whatever else has happened. It only replaces the spinner that would
  // otherwise be shown forever.
  const state: GateState = !sessionResolved
    ? 'checking-session'
    : !userId
      ? 'signed-out'
      : wiredUserId === userId
        ? 'ready'
        : bootstrapping
          ? 'bootstrapping'
          : bootstrapError
            ? 'bootstrap-failed'
            : 'checking-session';

  const handleSendLink = async () => {
    setError(null);
    setSending(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (signInError) throw signInError;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (state === 'checking-session') {
    // Reading the persisted Supabase session (localStorage-backed, no
    // network) — normally resolves within a tick, so this is never the
    // mockup's cold-start visual, just a minimal placeholder.
    return (
      <div className="app-shell">
        <main>
          <p className="panel-hint">Loading&hellip;</p>
        </main>
      </div>
    );
  }

  if (state === 'bootstrap-failed') {
    // Shows the raw error on purpose. This screen only appears when the app
    // cannot start at all, and the underlying message ("duplicate key value
    // violates unique constraint \"trips_pkey\"") is the difference between
    // a five-minute diagnosis and reading server logs. It's also the one
    // failure a user can't work around by retrying blindly.
    return (
      <div className="boot-cold-start" role="alert">
        <div className="boot-cold-start-title">Couldn&rsquo;t open your trip</div>
        <div className="boot-cold-start-hint">
          Signing in worked, but setting this device up didn&rsquo;t. If this keeps happening, check that
          you&rsquo;re signing in with the same account you use elsewhere.
        </div>
        <p className="save-error" style={{ marginTop: 12 }}>
          <span>{bootstrapError}</span>
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary btn-sm" onClick={() => setBootstrapAttempt((n) => n + 1)}>
            Try again
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (state === 'bootstrapping') {
    // The one boot that genuinely waits on a network round-trip: the very
    // first sign-in on this device, where bootstrapMigration must check
    // whether an existing local trip needs pushing up before anything else
    // can safely proceed. Matches mockup/mockup.html's `.boot-cold-start`.
    return (
      <div className="boot-cold-start" role="status" aria-live="polite">
        <div className="boot-cold-start-spinner" aria-hidden="true" />
        <div className="boot-cold-start-title">Loading your trip&hellip;</div>
        <div className="boot-cold-start-hint">
          First time on this device &mdash; fetching your trip from the cloud.
        </div>
      </div>
    );
  }

  if (state === 'signed-out') {
    return (
      <div className="app-shell">
        <main style={{ maxWidth: 360, margin: '15vh auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 className="trip-title">Sign in</h1>
          <p className="panel-hint">
            Enter your email and we&rsquo;ll send you a one-time sign-in link &mdash; no password needed.
          </p>
          {sent ? (
            <p className="panel-hint">
              Check <strong>{email}</strong> for a sign-in link. You can close this tab.
            </p>
          ) : (
            <>
              <input
                className="text-input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <button
                className="btn btn-primary btn-block"
                disabled={!email || sending}
                onClick={() => void handleSendLink()}
              >
                {sending ? 'Sending…' : 'Send magic link'}
              </button>
              {error && <p className="panel-hint" style={{ color: 'var(--accent)' }}>{error}</p>}
            </>
          )}
        </main>
      </div>
    );
  }

  return <>{children}</>;
}
