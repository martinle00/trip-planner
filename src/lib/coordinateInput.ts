// ============================================================================
// Parses a coordinate a user pasted into the Add Place modal's manual path.
//
// The realistic sources are all Google Maps, which hands out several different
// shapes depending on how you got there:
//
//   1. right-click → copy coordinates      "31.2304, 121.4737"
//   2. right-click → copy, DMS locale      "31°14'49.4\"N 121°28'25.3\"E"
//   3. the URL bar on a place page         ".../place/X/@31.2337,121.4757,17z/data=…!3d31.2304!4d121.4737"
//   4. the URL bar with no place selected  ".../maps/@31.2304,121.4737,15z"
//   5. a share/search URL                  "maps.google.com/?q=31.2304,121.4737"
//
// Shape 3 carries BOTH the map camera (`@…`) and the actual marker (`!3d/!4d`),
// and they differ — the camera is wherever the viewport happened to sit. The
// marker is the answer, so `!3d/!4d` is checked first.
//
// `maps.app.goo.gl` short links cannot be resolved here: it needs a network
// round-trip and the redirect is CORS-blocked from the browser. They get their
// own result so the UI can say something useful instead of "unrecognised".
//
// Pure parsing — the GCJ-02 datum shift lives in lib/gcj02.ts and is applied by
// the caller, so the raw pasted value stays inspectable.
// ============================================================================

export type CoordinateParseFailure = 'empty' | 'shortlink' | 'unrecognised' | 'out-of-range';

export type CoordinateParseResult =
  | { ok: true; lat: number; lng: number }
  | { ok: false; reason: CoordinateParseFailure };

/** Decimal pair: "31.2304, 121.4737" — comma or whitespace separated. */
const DECIMAL_PAIR = /^([+-]?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*([+-]?\d{1,3}(?:\.\d+)?)$/;

/** DMS pair: 31°14'49.4"N 121°28'25.3"E — seconds and the separator between
 *  the two halves are both optional. Google uses typographic ° ' " but people
 *  retype them as plain quotes, so both are accepted. */
const DMS_PAIR =
  /^(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)?\s*["″]?\s*([NS])\s*[,\s]\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)?\s*["″]?\s*([EW])$/i;

/** The place marker on a Google place URL. */
const URL_MARKER = /!3d([+-]?\d+(?:\.\d+)?)!4d([+-]?\d+(?:\.\d+)?)/;

/** `?q=`, `&query=`, `&ll=`, `&daddr=` — the query-parameter carriers.
 *  Matched after `%2C` has been decoded back to a plain comma. */
const URL_PARAM = /[?&](?:q|query|ll|sll|daddr)=([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)/;

/** The map camera: `/@lat,lng,17z`. Last resort — see the header note. */
const URL_CAMERA = /@([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)/;

const SHORT_LINK = /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i;

function dmsToDecimal(deg: string, min: string, sec: string | undefined, hemisphere: string): number {
  const value = Number(deg) + Number(min) / 60 + (sec ? Number(sec) / 3600 : 0);
  const h = hemisphere.toUpperCase();
  return h === 'S' || h === 'W' ? -value : value;
}

function finish(lat: number, lng: number): CoordinateParseResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: 'unrecognised' };
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, reason: 'out-of-range' };
  return { ok: true, lat, lng };
}

/**
 * Parse a pasted coordinate or Google Maps URL. Returns the coordinate exactly
 * as written — no datum conversion (see `lib/gcj02.ts`).
 */
export function parseCoordinateInput(raw: string): CoordinateParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };

  const dms = DMS_PAIR.exec(text);
  if (dms) {
    return finish(
      dmsToDecimal(dms[1], dms[2], dms[3], dms[4]),
      dmsToDecimal(dms[5], dms[6], dms[7], dms[8]),
    );
  }

  const pair = DECIMAL_PAIR.exec(text);
  if (pair) return finish(Number(pair[1]), Number(pair[2]));

  if (/^https?:\/\//i.test(text) || /maps\./i.test(text) || text.includes('/maps')) {
    // Google percent-encodes the comma in `?q=` on some share paths. Decode
    // only that one sequence — a blanket decodeURIComponent throws on the
    // stray `%` that turns up in place names.
    const url = text.replace(/%2C/gi, ',');

    // A short link resolves to a real URL only via a network redirect we can't
    // follow from the browser — tell the user rather than guessing.
    if (SHORT_LINK.test(url) && !URL_MARKER.test(url) && !URL_CAMERA.test(url)) {
      return { ok: false, reason: 'shortlink' };
    }

    const marker = URL_MARKER.exec(url);
    if (marker) return finish(Number(marker[1]), Number(marker[2]));

    const param = URL_PARAM.exec(url);
    if (param) return finish(Number(param[1]), Number(param[2]));

    const camera = URL_CAMERA.exec(url);
    if (camera) return finish(Number(camera[1]), Number(camera[2]));
  }

  return { ok: false, reason: 'unrecognised' };
}

/** Fixed 5 decimals ≈ 1m — enough precision to confirm a pin by eye without
 *  implying more accuracy than a hand-copied coordinate has. */
export function formatCoordinate(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
