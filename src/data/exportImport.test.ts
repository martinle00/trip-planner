import { describe, expect, it } from 'vitest';
import { buildSeed } from './seed';
import { migratePlaceV2ToV3, migrateSnapshotV2ToV3, parseSnapshot, serializeSnapshot } from './exportImport';
import type { PlaceV2 } from './exportImport';

describe('serializeSnapshot / parseSnapshot', () => {
  it('round-trips a full TripSnapshot (incl. place `address`/`description`) losslessly', () => {
    const snapshot = buildSeed();
    snapshot.places[0] = {
      ...snapshot.places[0],
      address: 'Some formatted address, City, Country',
      description: 'Go early to beat the crowds',
      selfReview: 'Worth it, but bring water',
    };
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

describe('parseSnapshot — v1 -> v2 -> v3 chained migration', () => {
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
    places: [
      {
        id: 'place-v1',
        tripId: 'trip-v1',
        name: 'The Bund',
        city: 'Shanghai',
        lat: 31.2,
        lng: 121.5,
        status: 'wishlist',
        note: 'Go at sunset',
      },
    ],
    itinerary: [],
    expenses: [
      { id: 'exp-1', tripId: 'trip-v1', category: 'Food', label: 'Noodles', amountCny: 38, paid: true },
      { id: 'exp-2', tripId: 'trip-v1', dayId: 'day-1', category: 'Transport', label: 'Metro', amountCny: 0, paid: false },
    ],
  });

  it('migrates a v1 snapshot all the way to v3 shape (version, trip.rates, expense amount/currency, place description)', () => {
    const parsed = parseSnapshot(V1_JSON);

    expect(parsed.version).toBe(3);
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
    // days/itinerary pass through untouched.
    expect(parsed.days).toEqual([{ id: 'day-1', tripId: 'trip-v1', date: '2026-11-09', city: 'Shanghai' }]);
    // note -> description, and a fresh updatedAt was backfilled.
    expect(parsed.places).toHaveLength(1);
    expect(parsed.places[0]).toMatchObject({ id: 'place-v1', description: 'Go at sunset' });
    expect((parsed.places[0] as unknown as { note?: string }).note).toBeUndefined();
    expect(parsed.places[0].updatedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(parsed.places[0].updatedAt))).toBe(false);
  });

  it('a migrated v1 snapshot re-serializes as v3 and round-trips (no longer version 1)', () => {
    const migrated = parseSnapshot(V1_JSON);
    const reparsed = parseSnapshot(serializeSnapshot(migrated));
    expect(reparsed).toEqual(migrated);
    expect(reparsed.version).toBe(3);
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

  it('throws for an unrecognized future version (e.g. 4)', () => {
    expect(() => parseSnapshot(JSON.stringify({ ...BASE, version: 4 }))).toThrow(
      'parseSnapshot: unsupported snapshot version',
    );
  });

  it('throws for a garbage (non-numeric) version value', () => {
    expect(() => parseSnapshot(JSON.stringify({ ...BASE, version: 'v2' }))).toThrow(
      'parseSnapshot: unsupported snapshot version',
    );
  });

  it('does not throw for a well-formed current (v3) snapshot', () => {
    const snapshot = buildSeed();
    expect(() => parseSnapshot(serializeSnapshot(snapshot))).not.toThrow();
  });
});

describe('parseSnapshot — v2 -> v3 migration (Place.note -> description, updatedAt)', () => {
  const V2_JSON = JSON.stringify({
    version: 2,
    trip: {
      id: 'trip-v2',
      name: 'V2 Trip',
      startDate: '2026-11-07',
      endDate: '2026-11-30',
      homeCurrency: 'AUD',
      tripCurrency: 'CNY',
      rates: { AUD: 1, CNY: 0.21 },
      ratesBase: 'AUD',
      cities: [],
    },
    days: [],
    places: [
      {
        id: 'place-with-note',
        tripId: 'trip-v2',
        name: 'The Bund',
        city: 'Shanghai',
        lat: 31.2,
        lng: 121.5,
        status: 'wishlist',
        note: 'Go at sunset',
      },
      {
        id: 'place-without-note',
        tripId: 'trip-v2',
        name: 'Yu Garden',
        city: 'Shanghai',
        lat: 31.2,
        lng: 121.5,
        status: 'wishlist',
      },
    ],
    itinerary: [],
    expenses: [],
  });

  it('migrates a v2 snapshot to v3: note -> description, note removed, updatedAt backfilled', () => {
    const parsed = parseSnapshot(V2_JSON);

    expect(parsed.version).toBe(3);
    const withNote = parsed.places.find((p) => p.id === 'place-with-note');
    expect(withNote?.description).toBe('Go at sunset');
    expect((withNote as unknown as { note?: string })?.note).toBeUndefined();
    expect(withNote?.updatedAt).toBeDefined();

    const withoutNote = parsed.places.find((p) => p.id === 'place-without-note');
    expect(withoutNote?.description).toBeUndefined();
    expect(withoutNote?.updatedAt).toBeDefined();
  });

  it('a migrated v2 snapshot re-serializes as v3 and round-trips', () => {
    const migrated = parseSnapshot(V2_JSON);
    const reparsed = parseSnapshot(serializeSnapshot(migrated));
    expect(reparsed).toEqual(migrated);
  });
});

describe('migratePlaceV2ToV3 (pure per-place transform)', () => {
  const base: PlaceV2 = {
    id: 'p1',
    tripId: 't1',
    name: 'Some Place',
    city: 'Shanghai',
    lat: 1,
    lng: 2,
    status: 'wishlist',
  };

  it('maps note -> description', () => {
    const migrated = migratePlaceV2ToV3({ ...base, note: 'hello' }, '2026-01-01T00:00:00.000Z');
    expect(migrated.description).toBe('hello');
    expect((migrated as unknown as { note?: string }).note).toBeUndefined();
  });

  it('concatenates note into an already-present description (defensive edge case)', () => {
    const migrated = migratePlaceV2ToV3(
      { ...base, note: 'hello', description: 'existing' } as PlaceV2 & { description?: string },
      '2026-01-01T00:00:00.000Z',
    );
    expect(migrated.description).toBe('existing\n\nhello');
  });

  it('leaves description undefined when there is no note and no existing description', () => {
    const migrated = migratePlaceV2ToV3(base, '2026-01-01T00:00:00.000Z');
    expect(migrated.description).toBeUndefined();
  });

  it('uses the fallback updatedAt when the record has none', () => {
    const migrated = migratePlaceV2ToV3(base, '2026-06-01T00:00:00.000Z');
    expect(migrated.updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('preserves an already-present updatedAt rather than overwriting it with the fallback', () => {
    const migrated = migratePlaceV2ToV3(
      { ...base, updatedAt: '2020-01-01T00:00:00.000Z' } as PlaceV2 & { updatedAt?: string },
      '2026-06-01T00:00:00.000Z',
    );
    expect(migrated.updatedAt).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('migrateSnapshotV2ToV3', () => {
  it('stamps every place in one migration run with the exact same fallback updatedAt', () => {
    const v2: Parameters<typeof migrateSnapshotV2ToV3>[0] = {
      version: 2,
      trip: buildSeed().trip,
      days: [],
      places: [
        { id: 'p1', tripId: 't', name: 'A', city: 'Shanghai', lat: 1, lng: 2, status: 'wishlist' },
        { id: 'p2', tripId: 't', name: 'B', city: 'Shanghai', lat: 1, lng: 2, status: 'wishlist' },
      ],
      itinerary: [],
      expenses: [],
    };
    const migrated = migrateSnapshotV2ToV3(v2);
    expect(migrated.version).toBe(3);
    const [a, b] = migrated.places;
    expect(a.updatedAt).toBe(b.updatedAt);
  });
});
