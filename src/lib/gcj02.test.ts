import { describe, it, expect } from 'vitest';
import { gcj02ToWgs84, wgs84ToGcj02, isInsideChina } from './gcj02';
import { haversineMeters } from './geo';

const BUND = { lat: 31.2304, lng: 121.4737 }; // Shanghai
const SYDNEY = { lat: -33.8688, lng: 151.2093 };

describe('isInsideChina', () => {
  it('accepts the trip cities and rejects Sydney', () => {
    expect(isInsideChina(BUND)).toBe(true);
    expect(isInsideChina({ lat: 39.9042, lng: 116.4074 })).toBe(true); // Beijing
    expect(isInsideChina(SYDNEY)).toBe(false);
  });
});

describe('gcj02ToWgs84', () => {
  it('is a no-op outside China — a pasted Sydney coordinate must not move', () => {
    expect(gcj02ToWgs84(SYDNEY)).toEqual(SYDNEY);
    expect(wgs84ToGcj02(SYDNEY)).toEqual(SYDNEY);
  });

  it('shifts a Chinese coordinate by the expected few hundred metres', () => {
    const shifted = gcj02ToWgs84(BUND);
    const distance = haversineMeters(BUND, shifted);
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(1000);
  });

  it('round-trips to sub-metre accuracy', () => {
    for (const point of [BUND, { lat: 39.9042, lng: 116.4074 }, { lat: 22.5431, lng: 114.0579 }]) {
      const back = wgs84ToGcj02(gcj02ToWgs84(point));
      expect(haversineMeters(point, back)).toBeLessThan(1);
    }
  });

  it('moves in a consistent direction — the offset is not random per call', () => {
    expect(gcj02ToWgs84(BUND)).toEqual(gcj02ToWgs84(BUND));
  });
});
