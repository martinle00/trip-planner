// @vitest-environment jsdom
//
// Unit/component tests for the route-strip timeline (Phase 2 requirement 1):
// tapping a city node calls back with that city name, the active city has a
// visible `aria-current` state, and `citySlug` is stable/URL-safe.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RouteStrip, citySlug } from './RouteStrip';
import type { City } from '../data/schema';

const CITIES: City[] = [
  { name: 'Shanghai', order: 1, nights: 6, arrive: '2026-11-09', depart: '2026-11-15' },
  { name: 'Chengdu', order: 2, nights: 2, arrive: '2026-11-23', depart: '2026-11-25' },
];

describe('citySlug', () => {
  it('lowercases and hyphenates non-alphanumeric characters', () => {
    expect(citySlug('Zhangjiajie')).toBe('zhangjiajie');
    expect(citySlug('St. Someplace / Foo')).toBe('st-someplace-foo');
  });
});

describe('RouteStrip', () => {
  it('renders one node per city, each with its name and date range', () => {
    render(<RouteStrip cities={CITIES} selectedCity="Shanghai" onSelect={() => {}} />);
    expect(screen.getByText('Shanghai')).toBeInTheDocument();
    expect(screen.getByText('Chengdu')).toBeInTheDocument();
  });

  it('marks the selected city as active/aria-current, and no other city', () => {
    render(<RouteStrip cities={CITIES} selectedCity="Chengdu" onSelect={() => {}} />);
    const chengdu = screen.getByText('Chengdu').closest('button')!;
    const shanghai = screen.getByText('Shanghai').closest('button')!;
    expect(chengdu).toHaveAttribute('aria-current', 'true');
    expect(chengdu.className).toContain('active');
    expect(shanghai).not.toHaveAttribute('aria-current');
    expect(shanghai.className).not.toContain('active');
  });

  it('tapping a node calls onSelect with that city name', () => {
    const onSelect = vi.fn();
    render(<RouteStrip cities={CITIES} selectedCity="Shanghai" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Chengdu').closest('button')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('Chengdu');
  });

  it('renders with no city marked active when selectedCity matches none', () => {
    render(<RouteStrip cities={CITIES} selectedCity="" onSelect={() => {}} />);
    expect(screen.getByText('Shanghai').closest('button')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Chengdu').closest('button')).not.toHaveAttribute('aria-current');
  });
});
