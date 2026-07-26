import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './index.css'
import App from './App.tsx'
import { AuthGate } from './features/auth/AuthGate.tsx'
import { createDefaultGeocodeProvider, setGeocodeProvider } from './lib/geocode'

// Install the place-search backend once, at startup: Photon (free, keyless,
// better fuzzy/typeahead matching than Nominatim, WGS-84 coords). Callers of
// searchPlaces() are unaffected.
setGeocodeProvider(createDefaultGeocodeProvider())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
