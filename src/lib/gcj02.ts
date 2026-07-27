// ============================================================================
// GCJ-02 ("Mars coordinates") ↔ WGS-84 conversion.
//
// China mandates GCJ-02, a deliberate nonlinear obfuscation of true WGS-84
// positions, for maps published inside the country. Google Maps serves GCJ-02
// for Chinese locations, so a coordinate copied out of Google Maps plots
// roughly 300–600m away from where it really is when drawn on this app's
// WGS-84 OpenStreetMap tiles — consistently, and in a plausible-looking
// direction rather than obviously broken.
//
// The forward transform below is the standard published algorithm (Krasovsky
// 1940 ellipsoid). The inverse has no closed form; `gcj02ToWgs84` recovers it
// by fixed-point iteration, which converges to well under a metre in 3 passes
// because the offset is smooth and small relative to the distances involved.
//
// Pure math, no dependencies, no I/O.
// ============================================================================

import type { GeoPoint } from './geo';

const A = 6378245.0; // Krasovsky 1940 semi-major axis, metres
// ...and its squared eccentricity. Published as 0.00669342162296594323; trimmed
// to the digits a float64 actually holds (the two compare `===`) so the linter's
// no-loss-of-precision rule stays quiet.
const EE = 0.006693421622965943;

/** Rough mainland-China bounding box. Outside it, GCJ-02 and WGS-84 agree and
 *  the published algorithm is defined to be a no-op. Coarse by design — it is
 *  the same box every implementation of this transform uses, and a box is all
 *  that is knowable without shipping a border polygon. */
export function isInsideChina({ lat, lng }: GeoPoint): boolean {
  return lng >= 73.66 && lng <= 135.05 && lat >= 3.86 && lat <= 53.55;
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

/** True WGS-84 → the offset GCJ-02 position Google would show for it. */
export function wgs84ToGcj02(point: GeoPoint): GeoPoint {
  if (!isInsideChina(point)) return point;
  const { lat, lng } = point;
  const x = lng - 105.0;
  const y = lat - 35.0;
  let dLat = transformLat(x, y);
  let dLng = transformLng(x, y);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

/** A Google/GCJ-02 coordinate → the true WGS-84 position our tiles use.
 *  Iterative inverse of `wgs84ToGcj02`. */
export function gcj02ToWgs84(point: GeoPoint): GeoPoint {
  if (!isInsideChina(point)) return point;
  let guess = point;
  for (let i = 0; i < 3; i++) {
    const round = wgs84ToGcj02(guess);
    guess = { lat: guess.lat + (point.lat - round.lat), lng: guess.lng + (point.lng - round.lng) };
  }
  return guess;
}
