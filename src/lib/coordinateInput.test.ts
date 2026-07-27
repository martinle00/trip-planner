import { describe, it, expect } from 'vitest';
import { parseCoordinateInput, formatCoordinate } from './coordinateInput';

function coords(raw: string) {
  const r = parseCoordinateInput(raw);
  if (!r.ok) throw new Error(`expected a parse, got ${r.reason}`);
  return [r.lat, r.lng];
}

describe('parseCoordinateInput — bare pairs', () => {
  it('parses the right-click copy-coordinates format', () => {
    expect(coords('31.2304, 121.4737')).toEqual([31.2304, 121.4737]);
  });

  it('tolerates no space, extra space, and a space-only separator', () => {
    expect(coords('31.2304,121.4737')).toEqual([31.2304, 121.4737]);
    expect(coords('  31.2304 ,  121.4737  ')).toEqual([31.2304, 121.4737]);
    expect(coords('31.2304 121.4737')).toEqual([31.2304, 121.4737]);
  });

  it('handles negative and whole-number values', () => {
    expect(coords('-33.8688, 151.2093')).toEqual([-33.8688, 151.2093]);
    expect(coords('0, 0')).toEqual([0, 0]);
  });

  it('parses DMS with and without seconds', () => {
    const [lat, lng] = coords('31°14\'49.4"N 121°28\'25.3"E');
    expect(lat).toBeCloseTo(31.2470555, 5);
    expect(lng).toBeCloseTo(121.4736944, 5);
    const [lat2] = coords("31°14'N 121°28'E");
    expect(lat2).toBeCloseTo(31.2333333, 5);
  });

  it('applies S/W hemispheres as negatives', () => {
    const [lat, lng] = coords('33°51\'24.0"S 151°12\'33.5"W');
    expect(lat).toBeLessThan(0);
    expect(lng).toBeLessThan(0);
  });
});

describe('parseCoordinateInput — Google Maps URLs', () => {
  it('prefers the !3d/!4d marker over the @ camera position', () => {
    // The camera sits at 31.2337,121.4757 but the pin is at 31.2304,121.4737.
    const url =
      'https://www.google.com/maps/place/The+Bund/@31.2337,121.4757,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d31.2304!4d121.4737';
    expect(coords(url)).toEqual([31.2304, 121.4737]);
  });

  it('falls back to the @ camera when there is no marker', () => {
    expect(coords('https://www.google.com/maps/@31.2304,121.4737,15z')).toEqual([31.2304, 121.4737]);
  });

  it('reads ?q= and &ll= parameters', () => {
    expect(coords('https://maps.google.com/?q=31.2304,121.4737')).toEqual([31.2304, 121.4737]);
    expect(coords('https://www.google.com/maps?ll=31.2304,121.4737&z=16')).toEqual([31.2304, 121.4737]);
  });

  it('decodes a percent-encoded comma in ?q=', () => {
    expect(coords('https://www.google.com/maps/search/?api=1&query=31.2304%2C121.4737')).toEqual([
      31.2304, 121.4737,
    ]);
  });
});

describe('parseCoordinateInput — failures', () => {
  it('reports empty input', () => {
    expect(parseCoordinateInput('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('reports an unresolvable short link distinctly from garbage', () => {
    expect(parseCoordinateInput('https://maps.app.goo.gl/A1b2C3d4E5')).toEqual({
      ok: false,
      reason: 'shortlink',
    });
    expect(parseCoordinateInput('the bund, shanghai')).toEqual({ ok: false, reason: 'unrecognised' });
  });

  it('rejects out-of-range values rather than pinning nonsense', () => {
    expect(parseCoordinateInput('121.4737, 31.2304')).toEqual({ ok: false, reason: 'out-of-range' });
    expect(parseCoordinateInput('31.2304, 999.1')).toEqual({ ok: false, reason: 'out-of-range' });
  });
});

describe('formatCoordinate', () => {
  it('renders 5 decimals', () => {
    expect(formatCoordinate(31.2304, 121.4737)).toBe('31.23040, 121.47370');
  });
});
