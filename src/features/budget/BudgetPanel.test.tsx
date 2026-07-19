// @vitest-environment jsdom
//
// Component tests for the redesigned multi-currency Budget UI. Store state
// is set directly via `useTripStore.setState` (mirrors PlacesPanel.test.tsx
// / AddPlaceModal.test.tsx) — no Dexie/IndexedDB involved, and every
// mutating store action is a `vi.fn()` stub. `useOnlineStatus` is mocked so
// the rates-freshness "offline" state can be driven directly.
//
// Covers: the add-expense form's city->currency default (and that a manual
// override survives a subsequent "Attach to" change), the no-rate exclusion
// treatment (excluded from totals, flagged in the currency chips/expense
// row), sorting expenses by CONVERTED home-currency amount rather than raw
// amount, and every rates-freshness status-line state driven off real store
// fields.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BudgetPanel } from './BudgetPanel';
import { useTripStore } from '../../store/useTripStore';
import type { TripState } from '../../store/useTripStore';
import type { Day, Expense, Trip } from '../../data/schema';

let onlineMock = true;
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineMock,
}));

const BASE_TRIP: Trip = {
  id: 'trip-test',
  name: 'Test trip',
  startDate: '2026-11-07',
  endDate: '2026-11-30',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1, CNY: 0.21, USD: 1.5 }, // THB deliberately absent — "no rate" case
  cities: [
    { name: 'Singapore', order: 1, nights: 2, arrive: '2026-11-07', depart: '2026-11-09' },
    { name: 'Shanghai', order: 2, nights: 6, arrive: '2026-11-09', depart: '2026-11-15' },
  ],
};

const DAYS: Day[] = [
  { id: 'day-sg', tripId: 'trip-test', date: '2026-11-08', city: 'Singapore' },
  { id: 'day-sh', tripId: 'trip-test', date: '2026-11-10', city: 'Shanghai' },
];

function resetStore(overrides: Partial<TripState> = {}) {
  useTripStore.setState({
    trip: BASE_TRIP,
    days: [],
    places: [],
    itineraryByDay: {},
    expenses: [],
    loading: false,
    ratesLoading: false,
    ratesError: undefined,
    addExpense: vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense),
    updateExpense: vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined),
    removeExpense: vi.fn<TripState['removeExpense']>().mockResolvedValue(undefined),
    setHomeCurrency: vi.fn<TripState['setHomeCurrency']>().mockResolvedValue(undefined),
    refreshRates: vi.fn<TripState['refreshRates']>().mockResolvedValue(undefined),
    ...overrides,
  });
}

beforeEach(() => {
  onlineMock = true;
  resetStore();
});

describe('BudgetPanel — add-expense currency default', () => {
  it('defaults currency to the attached day’s city (Singapore -> SGD, Shanghai -> CNY), and "Whole trip" -> home currency', () => {
    resetStore({ days: DAYS });
    render(<BudgetPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);

    const attachTo = screen.getByLabelText('Attach to') as HTMLSelectElement;
    const currencySelect = screen.getByLabelText('Currency paid in') as HTMLSelectElement;

    fireEvent.change(attachTo, { target: { value: 'day-sg' } });
    expect(currencySelect.value).toBe('SGD');

    fireEvent.change(attachTo, { target: { value: 'day-sh' } });
    expect(currencySelect.value).toBe('CNY');

    fireEvent.change(attachTo, { target: { value: '' } });
    expect(currencySelect.value).toBe('AUD'); // trip.homeCurrency
  });

  it('keeps a manually-picked currency when "Attach to" changes afterwards', () => {
    resetStore({ days: DAYS });
    render(<BudgetPanel />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);

    const attachTo = screen.getByLabelText('Attach to') as HTMLSelectElement;
    const currencySelect = screen.getByLabelText('Currency paid in') as HTMLSelectElement;

    fireEvent.change(attachTo, { target: { value: 'day-sh' } });
    expect(currencySelect.value).toBe('CNY');

    fireEvent.change(currencySelect, { target: { value: 'USD' } }); // manual override
    expect(currencySelect.value).toBe('USD');

    fireEvent.change(attachTo, { target: { value: 'day-sg' } }); // would default to SGD
    expect(currencySelect.value).toBe('USD'); // ...but the manual choice sticks
  });

  it('resets the manual-override flag once the form is reopened', () => {
    resetStore({ days: DAYS });
    render(<BudgetPanel />);
    const toggle = screen.getAllByRole('button', { name: 'Add expense' })[0];
    fireEvent.click(toggle);

    const currencySelect = screen.getByLabelText('Currency paid in') as HTMLSelectElement;
    fireEvent.change(currencySelect, { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); // closes + resets

    fireEvent.click(toggle); // reopen
    expect((screen.getByLabelText('Currency paid in') as HTMLSelectElement).value).toBe('AUD');

    const attachTo = screen.getByLabelText('Attach to') as HTMLSelectElement;
    fireEvent.change(attachTo, { target: { value: 'day-sg' } });
    expect((screen.getByLabelText('Currency paid in') as HTMLSelectElement).value).toBe('SGD');
  });
});

describe('BudgetPanel — no-rate exclusion and converted-amount sort', () => {
  const EXPENSES: Expense[] = [
    { id: 'e-usd', tripId: 'trip-test', category: 'Transport', label: 'USD one', amount: 100, currency: 'USD', paid: false },
    { id: 'e-cny', tripId: 'trip-test', category: 'Food', label: 'CNY one', amount: 120, currency: 'CNY', paid: false },
    { id: 'e-thb', tripId: 'trip-test', category: 'Food', label: 'THB one (no rate)', amount: 10000, currency: 'THB', paid: false },
    { id: 'e-aud', tripId: 'trip-test', category: 'Shopping', label: 'AUD one (home)', amount: 50, currency: 'AUD', paid: true },
  ];

  beforeEach(() => {
    resetStore({ expenses: EXPENSES });
  });

  it('sorts expenses by CONVERTED home-currency amount, not raw amount, with no-rate rows at the end', () => {
    render(<BudgetPanel />);
    // Converted: USD 100*1.5=150, AUD 50*1=50, CNY 120*0.21=25.2, THB = no rate.
    // Raw amount order would wrongly put THB (10000) and CNY (120) ahead of USD (100).
    const labels = screen.getAllByText(/one/).map((el) => el.textContent);
    expect(labels).toEqual([
      'USD one',
      'AUD one (home)',
      'CNY one',
      'THB one (no rate)',
    ]);
  });

  it('excludes the no-rate expense from the summary totals and flags it', () => {
    render(<BudgetPanel />);
    // total = 150 + 50 + 25.2 = 225.2 -> rounds to A$225
    expect(screen.getByText('A$225')).toBeInTheDocument();
    // "1 expense excluded (no rate)" appears twice — once on the Trip total
    // card, once on Still-to-pay (the excluded expense is unpaid) — but NOT
    // on Paid/booked, which under-counts nothing.
    expect(screen.getAllByText('1 expense excluded (no rate)')).toHaveLength(2);
    expect(screen.getByText('No rate')).toBeInTheDocument();
    expect(screen.getByText('no rate yet')).toBeInTheDocument();
  });

  it('flags the no-rate currency in the per-currency subtotal chips', () => {
    render(<BudgetPanel />);
    expect(screen.getByText(/THB · no rate/)).toBeInTheDocument();
  });

  it('hides the conversion line for an expense already in the home currency', () => {
    render(<BudgetPanel />);
    const row = screen.getByText('AUD one (home)').closest('.expense') as HTMLElement;
    const conv = row.querySelector('.conv');
    expect(conv).not.toBeNull();
    expect(conv?.textContent).toBe('');
  });
});

describe('BudgetPanel — category breakdown mixed-currency note', () => {
  it('shows "N currencies" only for a category mixing multiple (convertible) currencies, not a single-currency one', () => {
    const expenses: Expense[] = [
      // Food: CNY + USD (2 convertible currencies) -> should show "2 currencies".
      { id: 'e-food-cny', tripId: 'trip-test', category: 'Food', label: 'Food CNY', amount: 100, currency: 'CNY', paid: true },
      { id: 'e-food-usd', tripId: 'trip-test', category: 'Food', label: 'Food USD', amount: 10, currency: 'USD', paid: true },
      // Shopping: AUD only -> should NOT show a currencies note.
      { id: 'e-shop-aud', tripId: 'trip-test', category: 'Shopping', label: 'Shop AUD', amount: 40, currency: 'AUD', paid: true },
    ];
    resetStore({ expenses });
    render(<BudgetPanel />);

    const foodRow = screen.getByText('Food', { selector: '.cat-label' }).closest('.cat-row') as HTMLElement;
    expect(foodRow.querySelector('.cat-amt-note')?.textContent).toBe('2 currencies');

    const shoppingRow = screen
      .getByText('Shopping', { selector: '.cat-label' })
      .closest('.cat-row') as HTMLElement;
    expect(shoppingRow.querySelector('.cat-amt-note')).toBeNull();
  });

  it('a category whose only OTHER-currency expense has no known rate does not count it toward "N currencies" (it is excluded before reaching the category tally)', () => {
    const expenses: Expense[] = [
      { id: 'e-food-cny', tripId: 'trip-test', category: 'Food', label: 'Food CNY', amount: 100, currency: 'CNY', paid: true },
      { id: 'e-food-thb', tripId: 'trip-test', category: 'Food', label: 'Food THB (no rate)', amount: 500, currency: 'THB', paid: true },
    ];
    resetStore({ expenses });
    render(<BudgetPanel />);

    const foodRow = screen.getByText('Food', { selector: '.cat-label' }).closest('.cat-row') as HTMLElement;
    expect(foodRow.querySelector('.cat-amt-note')).toBeNull();
  });
});

describe('BudgetPanel — rates freshness states', () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // The status message is rendered twice on purpose (the visible
  // `.rates-status-text` row, plus an `aria-live` announcer with the same
  // wording) — assert against the visible row specifically so the two
  // don't collide as duplicate text matches.
  function visibleStatusText(container: HTMLElement): string | null | undefined {
    return container.querySelector('.rates-status-text')?.textContent;
  }

  it('shows "loading" (busy, disabled button) while a refresh is in flight', () => {
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twoHoursAgo }, ratesLoading: true });
    const { container } = render(<BudgetPanel />);
    expect(visibleStatusText(container)).toMatch(/Fetching latest rates/);
    const btn = screen.getByRole('button', { name: /Refreshing/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the error state citing the last known-good fetch time', () => {
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twoHoursAgo }, ratesError: 'Network error' });
    const { container } = render(<BudgetPanel />);
    expect(visibleStatusText(container)).toMatch(/Couldn.t refresh — still showing rates from 2 hours ago/);
  });

  it('shows the offline state citing the last known-good fetch time', () => {
    onlineMock = false;
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twoHoursAgo } });
    const { container } = render(<BudgetPanel />);
    expect(visibleStatusText(container)).toMatch(/You.re offline — showing last-known rates from 2 hours ago/);
  });

  it('shows the "never refreshed" state when ratesUpdatedAt is undefined', () => {
    resetStore(); // BASE_TRIP has no ratesUpdatedAt
    const { container } = render(<BudgetPanel />);
    expect(visibleStatusText(container)).toBe('No rates fetched yet — using built-in reference rates');
  });

  it('shows "Rates updated <relative time>" once refreshed and settled', () => {
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twoHoursAgo } });
    const { container } = render(<BudgetPanel />);
    expect(visibleStatusText(container)).toBe('Rates updated 2 hours ago');
  });

  it('shows the "stale" state once the last fetch is older than 24 hours', () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twentyFiveHoursAgo } });
    const { container } = render(<BudgetPanel />);
    expect(visibleStatusText(container)).toBe('Rates updated 1 day ago — may be out of date');
  });

  it('calls refreshRates() when the refresh button is clicked', () => {
    const refreshRates = vi.fn<TripState['refreshRates']>().mockResolvedValue(undefined);
    resetStore({ refreshRates });
    render(<BudgetPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rates' }));
    expect(refreshRates).toHaveBeenCalledTimes(1);
  });
});

describe('BudgetPanel — post-refresh "totals flash" pulse', () => {
  const EXPENSES: Expense[] = [
    { id: 'e-1', tripId: 'trip-test', category: 'Food', label: 'Noodles', amount: 100, currency: 'CNY', paid: true },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds flash-confirm to the summary cards on a loading->settled (success) transition, then removes it after ~800ms', () => {
    resetStore({ expenses: EXPENSES, ratesLoading: true });
    const { container, rerender } = render(<BudgetPanel />);
    expect(container.querySelector('.summary-card.flash-confirm')).toBeNull();

    // Simulate refreshRates() completing successfully: ratesLoading flips
    // false, ratesError stays undefined.
    useTripStore.setState({ ratesLoading: false, ratesError: undefined });
    rerender(<BudgetPanel />);

    expect(container.querySelector('.summary-card.flash-confirm')).not.toBeNull();

    vi.advanceTimersByTime(850);
    rerender(<BudgetPanel />);
    expect(container.querySelector('.summary-card.flash-confirm')).toBeNull();
  });

  it('does NOT flash on a loading->settled transition that ended in failure', () => {
    resetStore({ expenses: EXPENSES, ratesLoading: true });
    const { container, rerender } = render(<BudgetPanel />);

    useTripStore.setState({ ratesLoading: false, ratesError: 'Network error' });
    rerender(<BudgetPanel />);

    expect(container.querySelector('.summary-card.flash-confirm')).toBeNull();
  });
});
