import { describe, expect, it } from 'vitest';
import { buildSeed } from './seed';
import { parseSnapshot, serializeSnapshot } from './exportImport';

describe('serializeSnapshot / parseSnapshot', () => {
  it('round-trips a full TripSnapshot (incl. place `address`) losslessly', () => {
    const snapshot = buildSeed();
    snapshot.places[0] = { ...snapshot.places[0], address: 'Some formatted address, City, Country' };
    const json = serializeSnapshot(snapshot);
    const parsed = parseSnapshot(json);
    expect(parsed).toEqual(snapshot);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseSnapshot('{not valid json')).toThrow('parseSnapshot: invalid JSON');
  });

  it('throws when required top-level keys are missing', () => {
    expect(() => parseSnapshot(JSON.stringify({ trip: {} }))).toThrow(
      'parseSnapshot: JSON is not a valid TripSnapshot',
    );
  });

  it('throws for valid JSON that is not an object (e.g. an array or primitive)', () => {
    expect(() => parseSnapshot('[]')).toThrow('parseSnapshot: JSON is not a valid TripSnapshot');
    expect(() => parseSnapshot('42')).toThrow('parseSnapshot: JSON is not a valid TripSnapshot');
    expect(() => parseSnapshot('null')).toThrow('parseSnapshot: JSON is not a valid TripSnapshot');
  });
});

describe('parseSnapshot — v1 -> v2 migration', () => {
  const V1_JSON = JSON.stringify({
    version: 1,
    trip: {
      id: 'trip-v1',
      name: 'Old Trip',
      startDate: '2026-11-07',
      endDate: '2026-11-30',
      homeCurrency: 'AUD',
      tripCurrency: 'CNY',
      cnyToHomeRate: 0.21,
      cities: [{ name: 'Shanghai', order: 1, nights: 2, arrive: '2026-11-09', depart: '2026-11-11' }],
    },
    days: [{ id: 'day-1', tripId: 'trip-v1', date: '2026-11-09', city: 'Shanghai' }],
    places: [],
    itinerary: [],
    expenses: [
      { id: 'exp-1', tripId: 'trip-v1', category: 'Food', label: 'Noodles', amountCny: 38, paid: true },
      { id: 'exp-2', tripId: 'trip-v1', dayId: 'day-1', category: 'Transport', label: 'Metro', amountCny: 0, paid: false },
    ],
  });

  it('migrates a v1 snapshot to v2 shape (version, trip.rates, expense amount/currency)', () => {
    const parsed = parseSnapshot(V1_JSON);

    expect(parsed.version).toBe(2);
    expect(parsed.trip).toEqual({
      id: 'trip-v1',
      name: 'Old Trip',
      startDate: '2026-11-07',
      endDate: '2026-11-30',
      homeCurrency: 'AUD',
      tripCurrency: 'CNY',
      rates: { CNY: 0.21, AUD: 1 },
      ratesBase: 'AUD',
      ratesUpdatedAt: undefined,
      cities: [{ name: 'Shanghai', order: 1, nights: 2, arrive: '2026-11-09', depart: '2026-11-11' }],
    });
    expect(parsed.expenses).toEqual([
      { id: 'exp-1', tripId: 'trip-v1', category: 'Food', label: 'Noodles', amount: 38, currency: 'CNY', paid: true },
      {
        id: 'exp-2',
        tripId: 'trip-v1',
        dayId: 'day-1',
        category: 'Transport',
        label: 'Metro',
        amount: 0,
        currency: 'CNY',
        paid: false,
      },
    ]);
    // days/places/itinerary pass through untouched.
    expect(parsed.days).toEqual([{ id: 'day-1', tripId: 'trip-v1', date: '2026-11-09', city: 'Shanghai' }]);
  });

  it('a migrated v1 snapshot re-serializes as v2 and round-trips (no longer version 1)', () => {
    const migrated = parseSnapshot(V1_JSON);
    const reparsed = parseSnapshot(serializeSnapshot(migrated));
    expect(reparsed).toEqual(migrated);
    expect(reparsed.version).toBe(2);
  });

  it('the migrated rate preserves the "multiply to convert" convention (rates.CNY === old cnyToHomeRate)', () => {
    const migrated = parseSnapshot(V1_JSON);
    expect(migrated.trip.rates.CNY).toBe(0.21);
    expect(migrated.trip.rates[migrated.trip.homeCurrency]).toBe(1);
  });
});

describe('parseSnapshot — unsupported/missing version is rejected, never silently trusted', () => {
  const BASE = { trip: {}, days: [], places: [], itinerary: [], expenses: [] };

  it('throws for a snapshot with no version field at all', () => {
    expect(() => parseSnapshot(JSON.stringify(BASE))).toThrow(
      'parseSnapshot: unsupported snapshot version',
    );
  });

  it('throws for an unrecognized future version (e.g. 3)', () => {
    expect(() => parseSnapshot(JSON.stringify({ ...BASE, version: 3 }))).toThrow(
      'parseSnapshot: unsupported snapshot version',
    );
  });

  it('throws for a garbage (non-numeric) version value', () => {
    expect(() => parseSnapshot(JSON.stringify({ ...BASE, version: 'v2' }))).toThrow(
      'parseSnapshot: unsupported snapshot version',
    );
  });

  it('does not throw for a well-formed current (v2) snapshot', () => {
    const snapshot = buildSeed();
    expect(() => parseSnapshot(serializeSnapshot(snapshot))).not.toThrow();
  });
});
