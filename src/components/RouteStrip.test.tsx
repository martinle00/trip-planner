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

  it('marks a city with a staged Map change via .has-pending, on any node — active or not', () => {
    render(
      <RouteStrip
        cities={CITIES}
        selectedCity="Shanghai"
        onSelect={() => {}}
        pendingCities={new Set(['Chengdu'])}
      />,
    );
    const chengdu = screen.getByText('Chengdu').closest('button')!;
    const shanghai = screen.getByText('Shanghai').closest('button')!;
    expect(chengdu.className).toContain('has-pending');
    expect(shanghai.className).not.toContain('has-pending');
    expect(screen.getByText(', has unsaved changes')).toBeInTheDocument();
  });

  it('omits the pending dot entirely when pendingCities is not passed', () => {
    render(<RouteStrip cities={CITIES} selectedCity="Shanghai" onSelect={() => {}} />);
    expect(document.querySelector('.route-pending-dot')).not.toBeInTheDocument();
  });
});

// Day-trip legs (Wulong from Chongqing, Shenzhen from Guangzhou) were filtered
// out of the strip entirely, which also meant they could never be selected —
// so the Map had no way to show them. They're in now, marked as day trips
// rather than passed off as overnight stops.
describe('RouteStrip — day-trip legs', () => {
  const WITH_DAY_TRIP: City[] = [
    { name: 'Chongqing', order: 1, nights: 3, arrive: '2026-11-20', depart: '2026-11-23' },
    { name: 'Wulong', order: 2, nights: 0, arrive: '2026-11-21', depart: '2026-11-22', parentCity: 'Chongqing' },
  ];

  it('renders a day-trip leg as a selectable node', () => {
    const onSelect = vi.fn();
    render(<RouteStrip cities={WITH_DAY_TRIP} selectedCity="Chongqing" onSelect={onSelect} />);

    const wulong = screen.getByText('Wulong').closest('button')!;
    fireEvent.click(wulong);
    expect(onSelect).toHaveBeenCalledWith('Wulong');
  });

  it('marks it as a day trip instead of showing a misleading two-date range', () => {
    render(<RouteStrip cities={WITH_DAY_TRIP} selectedCity="Chongqing" onSelect={() => {}} />);

    const wulong = screen.getByText('Wulong').closest('button')!;
    expect(wulong.className).toContain('is-daytrip');
    // Zero nights — "21–22 Nov" would overstate it.
    expect(wulong).toHaveTextContent('Day trip · 21 Nov');
    expect(wulong).not.toHaveTextContent('21–22 Nov');
    expect(wulong).toHaveTextContent(/day trip from Chongqing/);

    const chongqing = screen.getByText('Chongqing').closest('button')!;
    expect(chongqing.className).not.toContain('is-daytrip');
    expect(chongqing).toHaveTextContent('20–23 Nov');
  });

  it('a day-trip leg can be the active city', () => {
    render(<RouteStrip cities={WITH_DAY_TRIP} selectedCity="Wulong" onSelect={() => {}} />);
    const wulong = screen.getByText('Wulong').closest('button')!;
    expect(wulong).toHaveAttribute('aria-current', 'true');
    expect(wulong.className).toContain('active');
  });
});
