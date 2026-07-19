import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
})
