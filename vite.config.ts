import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Dev auth credentials are deliberately NOT `VITE_`-prefixed, so Vite never
  // inlines them on its own. They reach the bundle only through the explicit
  // `define` below — which means the default is closed: delete this block, or
  // build in any mode not listed here, and `__DEV_AUTH__` is null.
  //
  // WHY THIS MATTERS: `npm run build` produces the artifact that
  // `npx wrangler deploy` ships (DEPLOY.md), straight from the same `dist/`
  // used for local phone testing. If these were `VITE_`-prefixed they'd be
  // baked into every production build made on a machine with a `.env.local`,
  // publishing a working Supabase password. devAutoSignIn.ts's origin check
  // would still stop the auto-login firing on the live site, but it cannot
  // stop someone reading the credential out of the JS and using it directly.
  //
  //   serve            -> dev server; never deployed, so allowed.
  //   --mode localdev  -> `npm run build:local`, the opt-in phone-testing
  //                       build. Same output as `build`, plus credentials.
  //   anything else    -> null. `npm run build` is production mode and can
  //                       never carry them, whatever is in `.env.local`.
  //
  // `mode !== 'test'` keeps the suite deterministic: without it, a developer
  // with credentials configured would run different tests than CI.
  const env = loadEnv(mode, process.cwd(), '')
  const allowDevAuth = (command === 'serve' && mode !== 'test') || mode === 'localdev'
  const devAuth =
    allowDevAuth && env.DEV_AUTH_EMAIL && env.DEV_AUTH_PASSWORD
      ? { email: env.DEV_AUTH_EMAIL, password: env.DEV_AUTH_PASSWORD }
      : null

  if (devAuth) {
    // Printed on every build/serve that carries credentials, so it is never a
    // surprise which artifact contains them.
    console.warn(
      `\n  [dev-auth] Credentials for ${devAuth.email} are embedded in this build.` +
        `\n  [dev-auth] Do NOT deploy this output. Use \`npm run build\` for anything public.\n`,
    )
  }

  return {
    define: {
      __DEV_AUTH__: JSON.stringify(devAuth),
    },
    test: {
      // Default environment stays 'node' (matches the existing lib/ unit
      // tests, and avoids cross-realm DOMException/Error identity quirks
      // between jsdom's globals and Node's native DOMException). Component
      // tests that need a DOM opt in per-file via a
      // `// @vitest-environment jsdom` docblock.
      setupFiles: ['./src/test/setup.ts'],
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'icons.svg', 'pwa-icon.svg'],
        manifest: {
          name: 'China Trip Planner',
          short_name: 'Trip Planner',
          description: 'A local Wanderlog for the Nov 2026 China trip — map, places, itinerary and budget.',
          start_url: '/',
          display: 'standalone',
          background_color: '#FAF7F2',
          theme_color: '#B23A2E',
          icons: [
            { src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Precache the app shell only — the live map's OSM tiles are
          // deliberately left uncached (online-only map, per spec). Places,
          // Itinerary and Budget keep working offline via IndexedDB.
          globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        },
      }),
    ],
  }
})
