// @vitest-environment jsdom
//
// This is an auth shortcut, so its guards are the thing under test — and the
// hostnames that must be REFUSED matter more than the ones that must be
// allowed. A regex that accidentally matches a public host is the failure mode
// that ships an auto-sign-in to real users.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attemptDevAutoSignIn,
  configuredDevAuth,
  isDevAutoSignInEnabled,
  isLocalOrigin,
} from './devAutoSignIn';

const signInWithPassword = vi.fn();
vi.mock('../../lib/supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: (...args: unknown[]) => signInWithPassword(...args) } },
}));

/** jsdom's location is read-only; this is the supported way to move origin. */
function setHostname(hostname: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hostname },
  });
}

beforeEach(() => {
  signInWithPassword.mockReset();
  signInWithPassword.mockResolvedValue({ error: null });
  setHostname('localhost');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Injected explicitly. The real source is a build-time `define` that the test
 *  build deliberately never populates — see vite.config.ts. */
const CREDS = { email: 'dev@example.com', password: 'hunter2' };

describe('isLocalOrigin', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '::1',
    '[::1]',
    'martins-macbook.local',
    '192.168.1.42',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
  ])('allows %s', (hostname) => {
    expect(isLocalOrigin(hostname)).toBe(true);
  });

  it.each([
    'trip-planner.workers.dev',
    'example.com',
    '8.8.8.8',
    // Just outside RFC 1918 on both sides — an off-by-one in the 172.16/12
    // range is the easiest mistake to make and the hardest to notice.
    '172.15.0.1',
    '172.32.0.1',
    // Substring/suffix attacks: an unanchored or careless pattern lets all
    // three of these through, and each is a registrable public domain.
    'localhost.example.com',
    'evil-localhost.com',
    '192.168.1.42.example.com',
    'notlocalhost',
    'example.local.com',
  ])('refuses %s', (hostname) => {
    expect(isLocalOrigin(hostname)).toBe(false);
  });
});

describe('configuredDevAuth', () => {
  // Guard 1, as it actually ships. vite.config.ts excludes `mode === 'test'`
  // from the credential-injecting modes, so this must hold on every machine
  // regardless of what the developer has in `.env.local` — if it ever fails,
  // the suite has started depending on local configuration.
  it('is null in the test build', () => {
    expect(configuredDevAuth()).toBeNull();
  });
});

describe('isDevAutoSignInEnabled', () => {
  it('is false with no credentials configured', () => {
    expect(isDevAutoSignInEnabled(null)).toBe(false);
  });

  it('is false when a credential is present but empty', () => {
    expect(isDevAutoSignInEnabled({ email: 'dev@example.com', password: '' })).toBe(false);
  });

  it('is true with both credentials on a local origin', () => {
    expect(isDevAutoSignInEnabled(CREDS)).toBe(true);
  });

  it('is true on a private LAN IP — the phone-testing case this exists for', () => {
    setHostname('192.168.1.42');
    expect(isDevAutoSignInEnabled(CREDS)).toBe(true);
  });

  // The load-bearing one: guard 1 (credentials absent from the build) is what
  // normally makes this dead code in production, but it's a build-time
  // property. If a credential-carrying build ever escapes — someone deploying
  // the output of `npm run build:local` by hand — this is all that's left.
  it('is false on a public origin even with credentials present', () => {
    setHostname('trip-planner.workers.dev');
    expect(isDevAutoSignInEnabled(CREDS)).toBe(false);
  });
});

describe('attemptDevAutoSignIn', () => {
  it('signs in with the configured credentials and reports success', async () => {
    await expect(attemptDevAutoSignIn(CREDS)).resolves.toBe(true);
    expect(signInWithPassword).toHaveBeenCalledWith(CREDS);
  });

  // The production call site passes no argument, so this is the path that
  // actually runs in a deployed bundle: no credentials, no network call.
  it('does not touch supabase at all with no argument (the deployed case)', async () => {
    await expect(attemptDevAutoSignIn()).resolves.toBe(false);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('does not touch supabase on a public origin', async () => {
    setHostname('trip-planner.workers.dev');
    await expect(attemptDevAutoSignIn(CREDS)).resolves.toBe(false);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  // A bad password must cost you the shortcut, not the ability to sign in --
  // the gate stays on the normal magic-link form.
  it('swallows a sign-in error and reports failure', async () => {
    signInWithPassword.mockResolvedValue({ error: new Error('Invalid login credentials') });
    await expect(attemptDevAutoSignIn(CREDS)).resolves.toBe(false);
  });

  it('swallows a thrown network error', async () => {
    signInWithPassword.mockRejectedValue(new Error('offline'));
    await expect(attemptDevAutoSignIn(CREDS)).resolves.toBe(false);
  });
});
