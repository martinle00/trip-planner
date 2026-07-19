// ============================================================================
// Exchange-rate service. Provider-agnostic by design, mirroring lib/geocode.ts:
// callers only ever import `fetchRates` / `convert` / `CURRENCIES` from this
// module. The open.er-api.com implementation below can be swapped for a
// Frankfurter (frankfurter.dev) fallback provider later — via
// `setRatesProvider()` — without touching any caller. Owned by the
// Backend/data specialist.
//
// Provider decision: open.er-api.com (free, no API key,
// `GET https://open.er-api.com/v6/latest/{BASE}` -> `{ result: 'success',
// base_code, rates: { CODE: number, ... }, time_last_update_unix, ... }`).
// Noted fallback if open.er-api.com proves unreliable: Frankfurter
// (https://api.frankfurter.dev), which returns a similar `{ base, rates }`
// shape — a second `RatesProvider` implementation can wrap it and be
// installed via `setRatesProvider()`.
//
// Rate storage convention (matches `Trip.rates` in data/schema.ts): the
// value returned/stored for currency C is the value, in the requested base
// currency, of ONE unit of C — i.e. `homeAmount = amount * rates[C]`, a
// plain multiply. open.er-api.com's raw response is the OPPOSITE direction
// (units of C per 1 unit of base), so `fetchRates` inverts every rate before
// returning it.
// ============================================================================

import type { Trip } from '../data/schema';

/** Result of a successful rate fetch, already in the app's storage
 *  convention (see module doc comment above). */
export interface RatesResult {
  /** `rates[C]` = value, in `base`, of ONE unit of currency C. `rates[base]`
   *  is always exactly `1`. */
  rates: Record<string, number>;
  /** The currency the rates are relative to (normally equal to the
   *  requested `base` currency, but taken from the provider's response when
   *  available). */
  base: string;
  /** ISO date-time this fetch completed (client clock — providers' own
   *  "last updated" timestamps vary in freshness/format, so we timestamp the
   *  fetch itself). */
  fetchedAt: string;
}

/** A provider-agnostic exchange-rate backend. `OpenErApiRatesProvider` is
 *  the default/only implementation today; a Frankfurter provider can
 *  implement this same interface as a drop-in replacement/fallback. */
export interface RatesProvider {
  fetchRates(base: string, opts?: { signal?: AbortSignal }): Promise<RatesResult>;
}

/** Thrown for network failures, non-OK HTTP responses, and API-level error
 *  results (e.g. an unrecognized base currency). Aborts are NOT wrapped in
 *  this — an aborted fetch rejects with the original `AbortError`
 *  (`DOMException`/`Error` with `name === 'AbortError'`), mirroring
 *  `GeocodeError` in lib/geocode.ts. */
export class RateFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RateFetchError';
  }
}

const OPEN_ER_API_BASE = 'https://open.er-api.com/v6/latest';

/** Raw shape of an open.er-api.com `/v6/latest/{BASE}` response (fields we
 *  use only). */
interface OpenErApiRawResponse {
  result?: string;
  ['error-type']?: string;
  base_code?: string;
  rates?: Record<string, unknown>;
  time_last_update_unix?: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** open.er-api.com-backed `RatesProvider`. */
export class OpenErApiRatesProvider implements RatesProvider {
  async fetchRates(base: string, opts: { signal?: AbortSignal } = {}): Promise<RatesResult> {
    const code = base.trim().toUpperCase();
    const url = `${OPEN_ER_API_BASE}/${encodeURIComponent(code)}`;

    let response: Response;
    try {
      response = await fetch(url, { signal: opts.signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new RateFetchError('Network error while fetching exchange rates', { cause: err });
    }

    if (!response.ok) {
      throw new RateFetchError(`Exchange rate fetch failed with status ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new RateFetchError('Exchange rate response was unparseable', { cause: err });
    }

    const raw = data as OpenErApiRawResponse;
    if (raw.result !== 'success' || !raw.rates || typeof raw.rates !== 'object') {
      throw new RateFetchError(
        `Exchange rate API returned an error result${raw['error-type'] ? `: ${raw['error-type']}` : ''}`,
      );
    }

    // Invert: the API gives "units of C per 1 unit of base"; we store
    // "value in base of 1 unit of C" so callers can always just multiply.
    const rates: Record<string, number> = {};
    for (const [currency, apiRate] of Object.entries(raw.rates)) {
      if (typeof apiRate === 'number' && Number.isFinite(apiRate) && apiRate > 0) {
        rates[currency] = 1 / apiRate;
      }
    }
    const resolvedBase = raw.base_code || code;
    rates[resolvedBase] = 1; // exact identity, not a 1/1 float round-trip

    return { rates, base: resolvedBase, fetchedAt: new Date().toISOString() };
  }
}

let activeProvider: RatesProvider = new OpenErApiRatesProvider();

/** Swap the active rates provider (e.g. to a future Frankfurter fallback
 *  implementation, or a test double). Callers of `fetchRates()` are
 *  unaffected. */
export function setRatesProvider(provider: RatesProvider): void {
  activeProvider = provider;
}

/** Reset to the default open.er-api.com provider (mainly for tests). */
export function resetRatesProvider(): void {
  activeProvider = new OpenErApiRatesProvider();
}

/**
 * Fetch live exchange rates relative to `homeCurrency`. Resolves to a
 * `RatesResult` ready to store directly on `Trip.rates`/`ratesBase`/
 * `ratesUpdatedAt` (see useTripStore's `refreshRates`).
 *
 * Rejects with `RateFetchError` on network/HTTP/API-result failure, or with
 * the original abort error (`name === 'AbortError'`) if `opts.signal` fires
 * first.
 */
export async function fetchRates(
  homeCurrency: string,
  opts: { signal?: AbortSignal } = {},
): Promise<RatesResult> {
  return activeProvider.fetchRates(homeCurrency, opts);
}

/**
 * Convert `amount` (in `currency`) into the trip's home currency using its
 * currently stored `rates`. Returns `undefined` when there is no known rate
 * for `currency` yet — callers (the Budget UI) must treat that as "no rate
 * yet" (e.g. show a placeholder / exclude from totals with a note), not
 * silently coerce it to 0 or the raw amount.
 */
export function convert(
  amount: number,
  currency: string,
  trip: Pick<Trip, 'rates'>,
): number | undefined {
  const rate = trip.rates[currency];
  if (rate === undefined) return undefined;
  return amount * rate;
}

/** Metadata for the currencies relevant to this trip, plus a handful of
 *  common majors — for UI selectors (home-currency picker, expense-currency
 *  picker). Not an exhaustive ISO 4217 list (166 codes); add more as needed. */
export interface CurrencyMeta {
  code: string;
  symbol: string;
  name: string;
}

export const CURRENCIES: CurrencyMeta[] = [
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
];

/** Look up a currency's display symbol; falls back to the bare code (e.g.
 *  "XYZ ") for anything not in `CURRENCIES`. */
export function currencySymbol(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? `${code} `;
}
