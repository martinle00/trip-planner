// @vitest-environment jsdom
//
// App-level integration test for the multi-currency Budget feature: exercises
// the REAL store -> DexieTripRepository -> Dexie chain (fake-indexeddb) end
// to end through <App>, rather than stubbing store actions like
// BudgetPanel.test.tsx does. This is the integration layer the unit tests
// can't catch: does adding a mixed-currency expense through the real store
// actually show up, correctly converted, in the rendered Budget tab; does
// changing home currency through the UI re-render the totals; does a
// (mocked-network) refresh flow through to the displayed numbers. The live
// open.er-api.com fetch itself is mocked — see QA report for the manual
// browser check of the real endpoint.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Dexie from 'dexie';
import App from './../../App';
import { useTripStore } from '../../store/useTripStore';

const fetchRatesMock = vi.fn();
vi.mock('../../lib/exchangeRates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/exchangeRates')>();
  return {
    ...actual,
    fetchRates: (...args: unknown[]) => fetchRatesMock(...args),
  };
});

beforeEach(async () => {
  await Dexie.delete('china-trip-planner');
  fetchRatesMock.mockReset();
});

afterEach(async () => {
  await Dexie.delete('china-trip-planner');
});

async function renderOnBudgetTab() {
  render(<App />);
  await screen.findByRole('tablist');
  fireEvent.click(screen.getByRole('tab', { name: /Budget/ }));
  return screen.getByRole('tabpanel');
}

/** The "Trip total" summary card's rendered value — scoped so it can't
 *  collide with "Paid / booked" / "Still to pay" showing the same figure. */
function tripTotalText(panel: HTMLElement): string | null | undefined {
  const label = within(panel).getByText('Trip total');
  return label.closest('.summary-card')?.querySelector('.home')?.textContent;
}

describe('Budget — App-level integration (real store/Dexie, mocked fetch)', () => {
  it('shows the empty state before any expense exists', async () => {
    const panel = await renderOnBudgetTab();
    expect(within(panel).getByText('No expenses logged yet')).toBeInTheDocument();
  });

  it('renders correct home-currency totals for mixed-currency expenses added through the real store', async () => {
    const panel = await renderOnBudgetTab();

    // Seed trip is AUD home, with built-in reference rates CNY:0.21, SGD:1.13.
    await useTripStore.getState().addExpense({
      category: 'Food',
      label: 'Noodles',
      amount: 100,
      currency: 'CNY',
      paid: true,
    });
    await useTripStore.getState().addExpense({
      category: 'Transport',
      label: 'MRT',
      amount: 10,
      currency: 'SGD',
      paid: false,
    });

    // 100 * 0.21 + 10 * 1.13 = 21 + 11.3 = 32.3 -> rounds to A$32.
    await waitFor(() => expect(within(panel).getByText('A$32')).toBeInTheDocument());
    expect(within(panel).getByText('Noodles')).toBeInTheDocument();
    expect(within(panel).getByText('MRT')).toBeInTheDocument();
  });

  it('changing the home currency via the selector re-bases and re-renders every total immediately (no refresh needed)', async () => {
    const panel = await renderOnBudgetTab();
    await useTripStore.getState().addExpense({
      category: 'Food',
      label: 'Noodles',
      amount: 100,
      currency: 'CNY',
      paid: true,
    });
    await waitFor(() => expect(tripTotalText(panel)).toBe('A$21'));

    const homeSelect = within(panel).getByLabelText(/Home currency/) as HTMLSelectElement;
    fireEvent.change(homeSelect, { target: { value: 'SGD' } });

    // Trip total should now render in S$ terms, and NOT crash/show NaN.
    await waitFor(() => {
      expect(useTripStore.getState().trip?.homeCurrency).toBe('SGD');
    });
    // Re-based CNY-in-SGD = 0.21 / 1.13 ≈ 0.1858 per unit; 100 * that ≈ 18.58 -> S$19.
    await waitFor(() => expect(tripTotalText(panel)).toBe('S$19'));
    expect(within(panel).queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('a manual rates refresh flows through to the displayed totals', async () => {
    const panel = await renderOnBudgetTab();
    await useTripStore.getState().addExpense({
      category: 'Food',
      label: 'Noodles',
      amount: 100,
      currency: 'CNY',
      paid: true,
    });
    await waitFor(() => expect(tripTotalText(panel)).toBe('A$21'));

    fetchRatesMock.mockResolvedValue({
      rates: { AUD: 1, CNY: 0.3, SGD: 1.13 },
      base: 'AUD',
      fetchedAt: new Date().toISOString(),
    });

    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh rates' }));

    // 100 * 0.30 = 30 -> A$30, replacing the old A$21 total.
    await waitFor(() => expect(tripTotalText(panel)).toBe('A$30'));
  });

  it('an expense in a currency with no known rate is excluded from totals but still visible, flagged, in the list', async () => {
    const panel = await renderOnBudgetTab();
    await useTripStore.getState().addExpense({
      category: 'Shopping',
      label: 'Souvenir',
      amount: 500,
      currency: 'JPY', // not in the seed rates map
      paid: false,
    });

    await waitFor(() => expect(within(panel).getByText('Souvenir')).toBeInTheDocument());
    expect(tripTotalText(panel)).toBe('A$0'); // total excludes the JPY expense
    // Appears on Trip total AND Still-to-pay (the excluded expense is
    // unpaid) but NOT on Paid/booked.
    expect(within(panel).getAllByText('1 expense excluded (no rate)')).toHaveLength(2);
    expect(within(panel).getByText('no rate yet')).toBeInTheDocument();
  });
});
