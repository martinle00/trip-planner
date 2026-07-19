import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENCIES,
  OpenErApiRatesProvider,
  RateFetchError,
  convert,
  currencySymbol,
  fetchRates,
  resetRatesProvider,
  setRatesProvider,
} from './exchangeRates';
import type { RatesProvider, RatesResult } from './exchangeRates';

const RAW_SUCCESS = {
  result: 'success',
  base_code: 'AUD',
  rates: {
    AUD: 1,
    CNY: 4.7619, // units of CNY per 1 AUD -> inverted, AUD value of 1 CNY = 1/4.7619 ~= 0.21
    SGD: 0.885,
    USD: 0.654,
  },
  time_last_update_unix: 1700000000,
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
  resetRatesProvider();
});

describe('fetchRates (open.er-api.com provider)', () => {
  it('calls the correct URL for the given base currency', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    await fetchRates('AUD');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe('https://open.er-api.com/v6/latest/AUD');
  });

  it('uppercases and trims the requested base currency in the URL', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    await fetchRates(' aud ');

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe('https://open.er-api.com/v6/latest/AUD');
  });

  it('inverts the API rates into "home value of 1 unit of C"', async () => {
    mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    const result = await fetchRates('AUD');

    expect(result.base).toBe('AUD');
    expect(result.rates.AUD).toBe(1);
    expect(result.rates.CNY).toBeCloseTo(1 / 4.7619, 6);
    expect(result.rates.SGD).toBeCloseTo(1 / 0.885, 6);
    expect(result.rates.USD).toBeCloseTo(1 / 0.654, 6);
  });

  it('sets rates[base] to exactly 1 (not a 1/1 float artifact)', async () => {
    mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    const result = await fetchRates('AUD');
    expect(Object.is(result.rates.AUD, 1)).toBe(true);
  });

  it('stamps fetchedAt with a parseable ISO date-time', async () => {
    mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    const result = await fetchRates('AUD');
    expect(Number.isNaN(new Date(result.fetchedAt).getTime())).toBe(false);
  });

  it('drops non-numeric / non-positive entries defensively', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResponse({
          result: 'success',
          base_code: 'AUD',
          rates: { AUD: 1, CNY: 4.76, BAD: 'nope', ZERO: 0, NEG: -1 },
        }),
      ),
    );
    const result = await fetchRates('AUD');
    expect(result.rates.CNY).toBeCloseTo(1 / 4.76, 6);
    expect(result.rates.BAD).toBeUndefined();
    expect(result.rates.ZERO).toBeUndefined();
    expect(result.rates.NEG).toBeUndefined();
  });

  it('passes the caller-supplied AbortSignal through to fetch', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    const controller = new AbortController();
    await fetchRates('AUD', { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('rethrows an AbortError as-is rather than wrapping it', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch(() => Promise.reject(abortError));
    await expect(fetchRates('AUD')).rejects.toBe(abortError);
  });

  it('rethrows an AbortError that fires mid response-body-read as-is (not wrapped in RateFetchError)', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(abortError),
      } as unknown as Response),
    );
    await expect(fetchRates('AUD')).rejects.toBe(abortError);
  });

  it('throws RateFetchError on a network failure', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(fetchRates('AUD')).rejects.toBeInstanceOf(RateFetchError);
  });

  it('throws RateFetchError on a non-OK HTTP response', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({}, false, 503)));
    await expect(fetchRates('AUD')).rejects.toBeInstanceOf(RateFetchError);
  });

  it('throws RateFetchError on an unparseable JSON response', async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('bad json')),
      } as unknown as Response),
    );
    await expect(fetchRates('AUD')).rejects.toBeInstanceOf(RateFetchError);
  });

  it('throws RateFetchError when the API result is not "success" (e.g. unknown code)', async () => {
    mockFetch(() =>
      Promise.resolve(jsonResponse({ result: 'error', 'error-type': 'unsupported-code' })),
    );
    await expect(fetchRates('XYZ')).rejects.toBeInstanceOf(RateFetchError);
  });

  it('throws RateFetchError when rates is missing from an otherwise "success" response', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({ result: 'success', base_code: 'AUD' })));
    await expect(fetchRates('AUD')).rejects.toBeInstanceOf(RateFetchError);
  });
});

describe('OpenErApiRatesProvider', () => {
  it('can be instantiated and used directly (implements RatesProvider)', async () => {
    mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    const provider = new OpenErApiRatesProvider();
    const result = await provider.fetchRates('AUD');
    expect(result.rates.AUD).toBe(1);
  });
});

describe('setRatesProvider / resetRatesProvider', () => {
  it('swaps the provider used by fetchRates without changing callers', async () => {
    const fakeResult: RatesResult = { rates: { AUD: 1, CNY: 0.2 }, base: 'AUD', fetchedAt: '2026-01-01T00:00:00.000Z' };
    const fakeProvider: RatesProvider = {
      fetchRates: vi.fn().mockResolvedValue(fakeResult),
    };
    setRatesProvider(fakeProvider);

    const result = await fetchRates('AUD');

    expect(result).toEqual(fakeResult);
    expect(fakeProvider.fetchRates).toHaveBeenCalledWith('AUD', {});
  });

  it('resetRatesProvider restores the default open.er-api.com provider', async () => {
    setRatesProvider({ fetchRates: vi.fn().mockResolvedValue({ rates: {}, base: 'AUD', fetchedAt: '' }) });
    resetRatesProvider();
    mockFetch(() => Promise.resolve(jsonResponse(RAW_SUCCESS)));
    const result = await fetchRates('AUD');
    expect(result.rates.AUD).toBe(1);
  });
});

describe('convert', () => {
  it('multiplies amount by the stored rate for that currency', () => {
    const trip = { rates: { AUD: 1, CNY: 0.21 } };
    expect(convert(100, 'CNY', trip)).toBeCloseTo(21, 6);
    expect(convert(50, 'AUD', trip)).toBe(50);
  });

  it('returns undefined when there is no known rate for the currency', () => {
    const trip = { rates: { AUD: 1 } };
    expect(convert(100, 'JPY', trip)).toBeUndefined();
  });
});

describe('currencySymbol', () => {
  it('returns the known symbol for a listed currency', () => {
    expect(currencySymbol('AUD')).toBe('A$');
    expect(currencySymbol('CNY')).toBe('¥');
  });

  it('falls back to the bare code for an unlisted currency', () => {
    expect(currencySymbol('XYZ')).toBe('XYZ ');
  });
});

describe('CURRENCIES', () => {
  it('includes every trip-relevant currency at least once, with unique codes', () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ['AUD', 'CNY', 'SGD', 'USD', 'HKD']) {
      expect(codes).toContain(code);
    }
  });
});
