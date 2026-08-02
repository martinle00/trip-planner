// ============================================================================
// Dev-only auto sign-in.
//
// WHY: testing the PWA for real means `npm run preview -- --host` and opening
// the LAN URL on a phone — and the magic-link flow is genuinely hostile there.
// The link has to be whitelisted per LAN origin in the Supabase dashboard, it
// arrives in a mail client, and tapping it opens the *default browser* rather
// than the installed standalone PWA, so the session lands in the wrong
// browsing context and the thing you were trying to test never signs in.
//
// This swaps that one step for `signInWithPassword` against a dedicated dev
// account. Everything downstream is deliberately UNCHANGED: it produces a
// genuine session, so RLS, the outbox and the synced repository all behave
// exactly as they do in production. This is not a mock and does not bypass
// authorization — it only bypasses the *email round-trip*.
//
// ---------------------------------------------------------------------------
// TWO INDEPENDENT GUARDS. Both must pass. Neither is sufficient alone, and
// that redundancy is the whole point — this is an auth shortcut, so a single
// misconfiguration must not be able to enable it in front of real users.
//
//  1. CREDENTIALS, at BUILD time. `__DEV_AUTH__` is injected by
//     vite.config.ts and is `null` in every mode except the dev server and
//     `npm run build:local`. The vars behind it are deliberately NOT
//     `VITE_`-prefixed, so Vite will not inline them on its own — the only
//     path into a bundle is that one explicit `define`. `npm run build`, which
//     produces the artifact `npx wrangler deploy` ships, therefore cannot
//     carry them no matter what sits in `.env.local`. This branch is dead code
//     in the deployed bundle, and the failure mode of any mistake here is
//     `null` (closed), not a leaked credential.
//
//  2. ORIGIN, at RUNTIME, against the hostname actually being served.
//     Guard 1 is a build-time property; guard 2 is what remains if a
//     credential-carrying build ever escapes anyway (someone deploys the
//     output of `build:local` by hand). A public hostname refuses regardless.
//
// Do not relax either one to "make it work" somewhere. If this needs to run
// against a non-local origin, that is a different feature with a different
// threat model, not a wider regex.
// ============================================================================

import { supabase } from '../../lib/supabaseClient';

export interface DevAuthCredentials {
  email: string;
  password: string;
}

/** Injected by `define` in vite.config.ts — see guard 1 above. */
declare const __DEV_AUTH__: DevAuthCredentials | null;

/**
 * The build-time credentials, or null. The `typeof` guard covers any consumer
 * that doesn't run through the Vite config at all (plain `tsc`, a node
 * script), where the identifier is genuinely undefined rather than replaced.
 */
export function configuredDevAuth(): DevAuthCredentials | null {
  if (typeof __DEV_AUTH__ === 'undefined' || __DEV_AUTH__ === null) return null;
  const { email, password } = __DEV_AUTH__;
  // Both, and both non-empty: a half-filled `.env.local` must not put this
  // into a state where it tries and fails to sign in on every boot.
  if (!email || !password) return null;
  return { email, password };
}

/** localhost, IPv6 loopback, and mDNS names (`some-macbook.local`). */
const LOCAL_HOSTNAME = /^(localhost|127\.0\.0\.1|\[?::1\]?|[a-z0-9-]+\.local)$/i;

/** RFC 1918 private ranges — the LAN IP `vite --host` prints. Deliberately
 *  written out rather than "not a public TLD": an allowlist of private space
 *  fails closed on anything unexpected, a denylist of public space fails open. */
const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/** Guard 2. Exported for the tests, which cover the hostnames that must be
 *  refused as carefully as the ones that must be allowed. */
export function isLocalOrigin(hostname: string): boolean {
  return LOCAL_HOSTNAME.test(hostname) || PRIVATE_IPV4.test(hostname);
}

/** Whether dev auto sign-in is available in this build, on this origin.
 *  Both guards. Credentials are a parameter purely so the tests can exercise
 *  the "configured" path — production callers always use the default, and the
 *  test build never has credentials to inject (vite.config.ts excludes
 *  `mode === 'test'` so the suite is identical for everyone). */
export function isDevAutoSignInEnabled(creds = configuredDevAuth()): boolean {
  // Re-checked here rather than trusted from `configuredDevAuth`: this is the
  // single predicate every caller asks, so it validates its own input whatever
  // the source.
  if (creds === null || !creds.email || !creds.password) return false;
  if (typeof window === 'undefined') return false;
  return isLocalOrigin(window.location.hostname);
}

/**
 * Sign in with the configured dev account. Resolves `true` if a session was
 * established.
 *
 * Intentionally does NOT set any gate state itself. A successful sign-in fires
 * a normal `SIGNED_IN` event, and `AuthGate`'s existing listener picks it up
 * like any other — which is what keeps the gate's render state derived rather
 * than imperatively assigned (see AuthGate.tsx's invariant comment; that
 * invariant has already cost two production bugs and must not be eroded by a
 * dev convenience).
 *
 * A failure is logged and swallowed: the gate simply stays on the normal
 * sign-in form, which is the correct fallback — a wrong password in
 * `.env.local` should cost you the magic link, not the ability to sign in.
 */
export async function attemptDevAutoSignIn(
  creds = configuredDevAuth(),
): Promise<boolean> {
  if (!creds || !isDevAutoSignInEnabled(creds)) return false;

  try {
    const { error } = await supabase.auth.signInWithPassword(creds);
    if (error) throw error;
    console.info('[dev] Auto-signed in as %s — magic link skipped.', creds.email);
    return true;
  } catch (err) {
    // Loud on purpose. The usual causes are all fixable in under a minute and
    // all invisible otherwise: the email/password provider is disabled in the
    // Supabase dashboard, the dev user doesn't exist, or the password is stale.
    console.error('[dev] Auto sign-in failed; falling back to the magic link form.', err);
    return false;
  }
}
