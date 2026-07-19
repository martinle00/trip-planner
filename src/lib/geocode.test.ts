import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GeocodeError,
  NominatimGeocodeProvider,
  resetGeocodeProvider,
  searchPlaces,
  setGeocodeProvider,
} from './geocode';
import type { GeocodeProvider, GeocodeResult } from './geocode';

const RAW_RESULT = {
  place_id: 123456,
  osm_type: 'way',
  osm_id: 987654,
  lat: '30.5921',
  lon: '104.0442',
  display_name: 'Chengdu Research Base of Giant Panda Breeding, Chenghua, Chengdu, Sichuan, China',
  name: 'Chengdu Research Base of Giant Panda Breeding',
  type: 'attraction',
  class: 'tourism',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetGeocodeProvider();
});

describe('searchPlaces (Nominatim provider)', () => {
  it('returns [] without calling fetch for a blank query', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    const results = await searchPlaces('   ');
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the Nominatim URL with format/addressdetails/q/limit/accept-language', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([RAW_RESULT])));
    await searchPlaces('panda base');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    const url = new URL(calledUrl);
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('addressdetails')).toBe('1');
    expect(url.searchParams.get('q')).toBe('panda base');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('accept-language')).toBe('en');
  });

  it('appends cityHint/countryHint to the query text', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([RAW_RESULT])));
    await searchPlaces('panda base', { cityHint: 'Chengdu' });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.searchParams.get('q')).toBe('panda base, Chengdu');
  });

  it('infers countrycodes from a recognized trip cityHint', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([RAW_RESULT])));
    await searchPlaces('panda base', { cityHint: 'Chengdu' });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.searchParams.get('countrycodes')).toBe('cn');
  });

  it('infers countrycodes for Singapore, distinct from the China legs', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    await searchPlaces('hawker centre', { cityHint: 'Singapore' });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.searchParams.get('countrycodes')).toBe('sg');
  });

  it('an explicit countryHint overrides the cityHint-inferred country', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    await searchPlaces('museum', { cityHint: 'Chengdu', countryHint: 'Australia' });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.searchParams.get('countrycodes')).toBe('au');
  });

  it('accepts a raw 2-letter countryHint code directly', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    await searchPlaces('museum', { countryHint: 'NZ' });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.searchParams.get('countrycodes')).toBe('nz');
  });

  it('omits countrycodes for an unrecognized city with no countryHint', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    await searchPlaces('museum', { cityHint: 'Sydney' });

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl);
    expect(url.searchParams.has('countrycodes')).toBe(false);
  });

  it('clamps limit into [1, 10] and defaults to 5', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    await searchPlaces('temple', { limit: 999 });
    expect(new URL((fetchMock.mock.calls[0] as [string])[0]).searchParams.get('limit')).toBe('10');

    await searchPlaces('temple', { limit: 0 });
    expect(new URL((fetchMock.mock.calls[1] as [string])[0]).searchParams.get('limit')).toBe('1');

    await searchPlaces('temple');
    expect(new URL((fetchMock.mock.calls[2] as [string])[0]).searchParams.get('limit')).toBe('5');
  });

  it('maps Nominatim raw results into GeocodeResult[]', async () => {
    mockFetch(() => Promise.resolve(jsonResponse([RAW_RESULT])));
    const results = await searchPlaces('panda base', { cityHint: 'Chengdu' });

    expect(results).toEqual<GeocodeResult[]>([
      {
        name: 'Chengdu Research Base of Giant Panda Breeding',
        address: RAW_RESULT.display_name,
        lat: 30.5921,
        lng: 104.0442,
        category: 'attraction',
        sourceId: 'osm:way/987654',
      },
    ]);
  });

  it('falls back to the first display_name segment when name is missing', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResponse([
          {
            place_id: 1,
            lat: '1.1',
            lon: '2.2',
            display_name: 'Some Place, Some City, Some Country',
          },
        ]),
      ),
    );
    const [result] = await searchPlaces('some place');
    expect(result.name).toBe('Some Place');
    expect(result.sourceId).toBe('nominatim:1');
    expect(result.category).toBeUndefined();
  });

  it('drops raw results with unparseable lat/lon or missing display_name', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResponse([
          { place_id: 1, lat: 'not-a-number', lon: '2.2', display_name: 'Bad lat' },
          { place_id: 2, lat: '1.1', lon: '2.2' /* no display_name */ },
          RAW_RESULT,
        ]),
      ),
    );
    const results = await searchPlaces('mixed');
    expect(results).toHaveLength(1);
    expect(results[0].sourceId).toBe('osm:way/987654');
  });

  it('returns [] for an empty result set', async () => {
    mockFetch(() => Promise.resolve(jsonResponse([])));
    expect(await searchPlaces('nonexistent place xyz')).toEqual([]);
  });

  it('returns [] if the response body is not an array (defensive)', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ error: 'nope' })));
    expect(await searchPlaces('weird')).toEqual([]);
  });

  it('throws GeocodeError on a non-OK HTTP response', async () => {
    mockFetch(() => Promise.resolve(jsonResponse([], false, 503)));
    await expect(searchPlaces('temple')).rejects.toBeInstanceOf(GeocodeError);
  });

  it('throws GeocodeError on a network failure', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(searchPlaces('temple')).rejects.toBeInstanceOf(GeocodeError);
  });

  it('rethrows an AbortError as-is rather than wrapping it', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch(() => Promise.reject(abortError));
    await expect(searchPlaces('temple')).rejects.toBe(abortError);
  });

  it('passes the caller-supplied AbortSignal through to fetch', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse([])));
    const controller = new AbortController();
    await searchPlaces('temple', { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe('NominatimGeocodeProvider', () => {
  it('can be instantiated and used directly (implements GeocodeProvider)', async () => {
    mockFetch(() => Promise.resolve(jsonResponse([RAW_RESULT])));
    const provider = new NominatimGeocodeProvider();
    const results = await provider.searchPlaces('panda base');
    expect(results).toHaveLength(1);
  });
});

describe('setGeocodeProvider', () => {
  it('swaps the provider used by searchPlaces without changing callers', async () => {
    const fakeResult: GeocodeResult = {
      name: 'Fake Place',
      address: 'Fake Address',
      lat: 1,
      lng: 2,
    };
    const fakeProvider: GeocodeProvider = {
      searchPlaces: vi.fn().mockResolvedValue([fakeResult]),
    };
    setGeocodeProvider(fakeProvider);

    const results = await searchPlaces('anything', { cityHint: 'Chengdu' });

    expect(results).toEqual([fakeResult]);
    expect(fakeProvider.searchPlaces).toHaveBeenCalledWith('anything', { cityHint: 'Chengdu' });
  });
});

describe('setup/teardown sanity', () => {
  beforeEach(() => {
    resetGeocodeProvider();
  });

  it('resetGeocodeProvider restores the default Nominatim provider', async () => {
    setGeocodeProvider({ searchPlaces: vi.fn().mockResolvedValue([]) });
    resetGeocodeProvider();
    mockFetch(() => Promise.resolve(jsonResponse([RAW_RESULT])));
    const results = await searchPlaces('panda base');
    expect(results).toHaveLength(1);
  });
});
