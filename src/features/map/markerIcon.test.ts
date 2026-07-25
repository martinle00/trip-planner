// @vitest-environment jsdom
//
// buildPinIcon's `pending` option (Map save-changes spec,
// mockup/map-save-changes.html) — the gold ring class plus a small gold dot
// that signal "this pin has an unsaved (staged) day reassignment".

import { describe, expect, it } from 'vitest';
import { buildPinIcon } from './markerIcon';

describe('buildPinIcon — pending', () => {
  it('adds the .pending class and a pin-pending-dot when pending', () => {
    const icon = buildPinIcon({ color: 'var(--d-blue)', unassigned: false, pending: true });
    const html = icon.options.html as string;
    expect(html).toContain('pin-marker');
    expect(html).toContain('pending');
    expect(html).toContain('pin-pending-dot');
  });

  it('omits the pending class and dot when not pending', () => {
    const icon = buildPinIcon({ color: 'var(--d-blue)', unassigned: false, pending: false });
    const html = icon.options.html as string;
    expect(html).not.toContain('pending');
    expect(html).not.toContain('pin-pending-dot');
  });

  it('defaults to not pending when the option is omitted', () => {
    const icon = buildPinIcon({ color: 'var(--d-blue)', unassigned: false });
    const html = icon.options.html as string;
    expect(html).not.toContain('pin-pending-dot');
  });

  it('can be both unassigned (dashed) and pending at once', () => {
    const icon = buildPinIcon({ color: 'var(--d-grey)', unassigned: true, pending: true });
    const html = icon.options.html as string;
    expect(html).toContain('unassigned');
    expect(html).toContain('pending');
  });
});
