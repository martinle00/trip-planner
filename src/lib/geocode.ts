// ============================================================================
// Place-search / geocoding service. Provider-agnostic by design: callers only
// ever import `searchPlaces` (or the `GeocodeProvider` interface) from this
// module. The active implementation can be swapped — via `setGeocodeProvider()`
// — without touching any caller. Owned by the Backend/data specialist.
//
// Provider decision: **Photon** (Komoot's free OSM-based geocoder) is the
// default the app installs at startup; **Nominatim** remains as a fallback and
// the module-load default. Both return WGS-84 coordinates, which match our
// Leaflet + OSM tiles exactly — no GCJ-02/BD-09 conversion (unlike Google/
// Baidu/Amap, which were rejected for that offset plus key/registration/proxy
// friction). Photon was chosen over Nominatim because it's built for
// search-as-you-type: it tolerates partial names and typos, which cuts down the
// "not found → add manually" misses. Both draw on the same OpenStreetMap data,
// so a place genuinely absent from OSM still won't appear — that ceiling is why
// the `GeocodeProvider` seam is kept, in case a China-native provider (behind a
// proxy) is ever needed. Photon's public endpoint needs no API key or account.
//
// Shared usage discipline (Photon's public endpoint and Nominatim both ask for
// light, non-parallel use): this module makes one request per `searchPlaces()`
// call and does no internal retry/polling; callers doing typeahead search MUST
// debounce keystrokes (~300ms) and pass an `AbortSignal` so a superseded
// request is cancelled rather than piling up. Results derive from OpenStreetMap
// and should be attributed to its contributors in the UI, and a language hint
// is sent so results come back in a consistent language.
// ============================================================================

/** A single geocoded / place-search result, provider-agnostic. */
export interface GeocodeResult {
  /** Short display name, e.g. "Chengdu Research Base of Giant Panda Breeding". */
  name: string;
  /** Full formatted address / display string. */
  address: string;
  /** WGS-84 latitude. */
  lat: number;
  /** WGS-84 longitude. */
  lng: number;
  /** Free-text place category/type from the provider, e.g. 'attraction', 'museum'. */
  category?: string;
  /** Provider-specific stable identifier (e.g. `osm:way/12345`), for dedup/debugging. */
  sourceId?: string;
}

export interface GeocodeSearchOptions {
  /** Trip city name to bias results toward (e.g. "Chengdu"). Appended to the
   *  query text and, for recognized trip cities, used to infer a country code. */
  cityHint?: string;
  /** Country name (e.g. "China", "Singapore") or ISO 3166-1 alpha-2 code (e.g.
   *  "cn") to bias/restrict results toward. Overrides any country inferred
   *  from `cityHint`. */
  countryHint?: string;
  /** Max results to return (1–10, default 5). */
  limit?: number;
  /** Abort signal for the caller to cancel an in-flight search (e.g. when a
   *  newer keystroke supersedes this one, or the add-place modal closes). */
  signal?: AbortSignal;
}

/** A provider-agnostic place-search backend. Nominatim is the default/only
 *  implementation today; a Mapbox/MapTiler provider can implement this same
 *  interface as a drop-in replacement. */
export interface GeocodeProvider {
  searchPlaces(query: string, opts?: GeocodeSearchOptions): Promise<GeocodeResult[]>;
}

/** Thrown for network failures and non-OK HTTP responses. Aborts are NOT
 *  wrapped in this — an aborted search rejects with the original
 *  `AbortError` (`DOMException`/`Error` with `name === 'AbortError'`) so
 *  callers can distinguish "user cancelled" from "search failed" and only
 *  fall back to `suggestPlaceLocation()` (in `lib/tripView.ts`) for the
 *  latter. */
export class GeocodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GeocodeError';
  }
}

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Trip cities → ISO 3166-1 alpha-2 country code, used only to bias/restrict
 *  Nominatim results when the caller supplies a recognized `cityHint` and no
 *  explicit `countryHint`. Mirrors the leg list in `lib/tripView.ts`'s
 *  `CITY_FALLBACK_CENTER`. */
const CITY_COUNTRY_CODE: Record<string, string> = {
  singapore: 'sg',
  shanghai: 'cn',
  suzhou: 'cn',
  changsha: 'cn',
  zhangjiajie: 'cn',
  chongqing: 'cn',
  wulong: 'cn',
  chengdu: 'cn',
  guangzhou: 'cn',
  shenzhen: 'cn',
};

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  china: 'cn',
  singapore: 'sg',
  australia: 'au',
};

function resolveCountryCode(opts: GeocodeSearchOptions): string | undefined {
  if (opts.countryHint) {
    const hint = opts.countryHint.trim().toLowerCase();
    if (/^[a-z]{2}$/.test(hint)) return hint;
    return COUNTRY_NAME_TO_CODE[hint];
  }
  if (opts.cityHint) {
    return CITY_COUNTRY_CODE[opts.cityHint.trim().toLowerCase()];
  }
  return undefined;
}

/** Build the free-text query Nominatim searches against: the raw query plus
 *  any city/country hints, so "panda base" + cityHint "Chengdu" becomes
 *  "panda base, Chengdu". */
function buildQueryText(query: string, opts: GeocodeSearchOptions): string {
  const parts = [query.trim()];
  if (opts.cityHint?.trim()) parts.push(opts.cityHint.trim());
  if (opts.countryHint?.trim()) parts.push(opts.countryHint.trim());
  return parts.filter(Boolean).join(', ');
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return 5;
  return Math.min(Math.max(Math.trunc(limit), 1), 10);
}

function buildNominatimUrl(query: string, opts: GeocodeSearchOptions): string {
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('q', buildQueryText(query, opts));
  url.searchParams.set('limit', String(clampLimit(opts.limit)));
  url.searchParams.set('accept-language', 'en');
  const countryCode = resolveCountryCode(opts);
  if (countryCode) url.searchParams.set('countrycodes', countryCode);
  return url.toString();
}

/** Raw shape of one Nominatim `jsonv2` search result (fields we use only). */
interface NominatimRawResult {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  type?: string;
  class?: string;
}

function mapNominatimResult(raw: NominatimRawResult): GeocodeResult | undefined {
  const lat = Number(raw.lat);
  const lng = Number(raw.lon);
  if (!raw.display_name || Number.isNaN(lat) || Number.isNaN(lng)) return undefined;
  const name = raw.name?.trim() || raw.display_name.split(',')[0].trim();
  const sourceId =
    raw.osm_type && raw.osm_id != null
      ? `osm:${raw.osm_type}/${raw.osm_id}`
      : raw.place_id != null
        ? `nominatim:${raw.place_id}`
        : undefined;
  return {
    name,
    address: raw.display_name,
    lat,
    lng,
    category: raw.type || raw.class || undefined,
    sourceId,
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Nominatim-backed `GeocodeProvider`. */
export class NominatimGeocodeProvider implements GeocodeProvider {
  async searchPlaces(query: string, opts: GeocodeSearchOptions = {}): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const url = buildNominatimUrl(trimmed, opts);

    let response: Response;
    try {
      response = await fetch(url, { signal: opts.signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new GeocodeError('Network error while searching for places', { cause: err });
    }

    if (!response.ok) {
      throw new GeocodeError(`Nominatim search failed with status ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new GeocodeError('Nominatim returned an unparseable response', { cause: err });
    }
    if (!Array.isArray(data)) return [];

    const results: GeocodeResult[] = [];
    for (const raw of data as NominatimRawResult[]) {
      const mapped = mapNominatimResult(raw);
      if (mapped) results.push(mapped);
    }
    return results;
  }
}

// ============================================================================
// Photon provider (Komoot). Nominatim is an *address geocoder* whose exact,
// address-first matching misses a lot of real queries — a partial POI name or a
// small typo returns nothing, which is a big share of the "not found → add
// manually" friction. Photon indexes the same OpenStreetMap data but is built
// for search-as-you-type, so it tolerates partial names and typos far better.
//
// It returns **WGS-84** coordinates (GeoJSON `[lng, lat]`) — the same datum as
// our Leaflet + OSM tiles and stored `Place.lat`/`Place.lng` — so results drop
// in with no conversion. The public endpoint needs no API key or account.
//
// Photon has no `countrycodes`-style restrict parameter; instead it takes a
// `lat`/`lon` location bias, so we bias toward the trip city's centre and (like
// the Nominatim path) fold the city/country hints into the query text.
// ============================================================================

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

/** Per-city bias centres (WGS-84), used to steer Photon results toward the city
 *  the user is adding a place to. Mirrors `CITY_FALLBACK_CENTER` in
 *  `lib/tripView.ts` — kept here to avoid a lib→lib import cycle and so this
 *  provider module stays self-contained. */
const CITY_PROXIMITY: Record<string, { lat: number; lng: number }> = {
  singapore: { lat: 1.2899, lng: 103.8519 },
  shanghai: { lat: 31.2304, lng: 121.4737 },
  suzhou: { lat: 31.2989, lng: 120.5853 },
  changsha: { lat: 28.2282, lng: 112.9388 },
  zhangjiajie: { lat: 29.1274, lng: 110.4795 },
  chongqing: { lat: 29.563, lng: 106.5516 },
  wulong: { lat: 29.3226, lng: 107.759 },
  chengdu: { lat: 30.5728, lng: 104.0668 },
  guangzhou: { lat: 23.1291, lng: 113.2644 },
  shenzhen: { lat: 22.5431, lng: 114.0579 },
};

/** Raw shape of one Photon GeoJSON feature (fields we use only). Coordinates
 *  are `[lng, lat]` per the GeoJSON spec. Photon returns no single formatted
 *  address string, so we compose one from the component fields below. */
interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    city?: string;
    state?: string;
    country?: string;
    osm_id?: number;
    osm_type?: string; // 'N' | 'W' | 'R'
    osm_key?: string;
    osm_value?: string;
  };
}

const PHOTON_OSM_TYPE: Record<string, string> = { N: 'node', W: 'way', R: 'relation' };

/** Compose a human-readable address from Photon's component fields, coarse →
 *  fine, e.g. "Panda Ave 1375, Chenghua, Chengdu, Sichuan, China". Kept
 *  city/state/country-inclusive so `inferCityFromAddress` (lib/tripView.ts) can
 *  still prefill the Add-Place city field from it. */
function composePhotonAddress(props: NonNullable<PhotonFeature['properties']>): string {
  const street =
    props.street && props.housenumber
      ? `${props.street} ${props.housenumber}`
      : props.street || undefined;
  const parts = [street, props.district, props.city, props.state, props.country];
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(', ');
}

function mapPhotonFeature(feature: PhotonFeature): GeocodeResult | undefined {
  const coords = feature.geometry?.coordinates;
  const props = feature.properties;
  if (!coords || !props) return undefined;
  const [lng, lat] = coords;
  if (Number.isNaN(lat) || Number.isNaN(lng)) return undefined;
  const name = (props.name || props.street || '').trim();
  if (!name) return undefined;
  const address = composePhotonAddress(props) || name;
  const osmType = props.osm_type ? PHOTON_OSM_TYPE[props.osm_type] : undefined;
  const sourceId =
    osmType && props.osm_id != null ? `osm:${osmType}/${props.osm_id}` : undefined;
  return {
    name,
    address,
    lat,
    lng,
    category: props.osm_value || props.osm_key || undefined,
    sourceId,
  };
}

function buildPhotonUrl(query: string, opts: GeocodeSearchOptions): string {
  const url = new URL(PHOTON_ENDPOINT);
  url.searchParams.set('q', buildQueryText(query, opts));
  url.searchParams.set('limit', String(clampLimit(opts.limit)));
  url.searchParams.set('lang', 'en');
  // Bias (not restrict) toward the trip city's centre so "panda base" near
  // Chengdu ranks above an identically-named place elsewhere.
  if (opts.cityHint) {
    const centre = CITY_PROXIMITY[opts.cityHint.trim().toLowerCase()];
    if (centre) {
      url.searchParams.set('lat', String(centre.lat));
      url.searchParams.set('lon', String(centre.lng));
    }
  }
  return url.toString();
}

/** Photon-backed `GeocodeProvider` — the default the app installs at startup. */
export class PhotonGeocodeProvider implements GeocodeProvider {
  async searchPlaces(query: string, opts: GeocodeSearchOptions = {}): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const url = buildPhotonUrl(trimmed, opts);

    let response: Response;
    try {
      response = await fetch(url, { signal: opts.signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new GeocodeError('Network error while searching for places', { cause: err });
    }

    if (!response.ok) {
      throw new GeocodeError(`Photon search failed with status ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new GeocodeError('Photon returned an unparseable response', { cause: err });
    }
    const features = (data as { features?: unknown })?.features;
    if (!Array.isArray(features)) return [];

    const results: GeocodeResult[] = [];
    for (const feature of features as PhotonFeature[]) {
      const mapped = mapPhotonFeature(feature);
      if (mapped) results.push(mapped);
    }
    return results;
  }
}

/** The provider the app runs with by default: Photon (free, keyless, better
 *  fuzzy/typeahead matching than Nominatim). Called once at startup (see
 *  `main.tsx`); tests can still swap providers via `setGeocodeProvider`. */
export function createDefaultGeocodeProvider(): GeocodeProvider {
  return new PhotonGeocodeProvider();
}

let activeProvider: GeocodeProvider = new NominatimGeocodeProvider();

/** Swap the active geocode provider (e.g. to a future Mapbox/MapTiler impl,
 *  or a test double). Callers of `searchPlaces()` are unaffected. */
export function setGeocodeProvider(provider: GeocodeProvider): void {
  activeProvider = provider;
}

/** Reset to the default Nominatim provider (mainly for tests). */
export function resetGeocodeProvider(): void {
  activeProvider = new NominatimGeocodeProvider();
}

/**
 * Search for real-world places by free-text query, biased toward the trip
 * context. Returns WGS-84 coordinates that drop straight into `Place.lat`/
 * `Place.lng` with no conversion.
 *
 * Resolves to `[]` for a blank query or a query with no matches. Rejects
 * with `GeocodeError` on network/HTTP failure, or with the original
 * abort error (`name === 'AbortError'`) if `opts.signal` fires first — the
 * caller should catch aborts silently and only treat `GeocodeError` (or any
 * other rejection) as "search unavailable", falling back to
 * `suggestPlaceLocation()` from `lib/tripView.ts`.
 */
export async function searchPlaces(
  query: string,
  opts: GeocodeSearchOptions = {},
): Promise<GeocodeResult[]> {
  return activeProvider.searchPlaces(query, opts);
}
