---
'ctpapp': minor
---

Dev-only auto sign-in for local builds: set `DEV_AUTH_EMAIL` and `DEV_AUTH_PASSWORD` in
`.env.local` and run `npm run build:local`, and the app signs in with a password account
instead of emailing a magic link — so the PWA can be tested on a phone over the LAN
without the email detour (magic links open the default browser, not the installed PWA,
so the session lands in the wrong browsing context). It's a real session, so RLS, sync
and the outbox are unaffected.

Gated so it cannot reach production: the variables are deliberately un-prefixed, so Vite
never auto-inlines them, and they enter the bundle only through an explicit `define` that
runs for the dev server and `--mode localdev`. Plain `npm run build` — the artifact
`wrangler deploy` ships — cannot carry them. A runtime origin check (localhost, loopback,
`*.local`, RFC 1918) is the second, independent guard.
