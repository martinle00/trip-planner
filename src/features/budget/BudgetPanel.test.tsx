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
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BudgetPanel } from './BudgetPanel';
import { useTripStore } from '../../store/useTripStore';
import type { TripState } from '../../store/useTripStore';
import type { Day, Expense, Trip, TripMember } from '../../data/schema';

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
    addMember: vi.fn<TripState['addMember']>().mockResolvedValue({} as TripMember),
    renameMember: vi.fn<TripState['renameMember']>().mockResolvedValue(undefined),
    removeMember: vi.fn<TripState['removeMember']>().mockResolvedValue(undefined),
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
    const { container } = render(<BudgetPanel />);
    // Converted: USD 100*1.5=150, AUD 50*1=50, CNY 120*0.21=25.2, THB = no rate.
    // Raw amount order would wrongly put THB (10000) and CNY (120) ahead of USD (100).
    // Scoped to the expense list itself — a bare `/one/` regex over the whole
    // document also matches unrelated Phase 5 companions-card copy ("pick
    // one as…", "anyone else…", "— none —").
    const expenseList = container.querySelector('.expense-list') as HTMLElement;
    const labels = within(expenseList)
      .getAllByText(/one/)
      .map((el) => el.textContent);
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

// ============================================================================
// Phase 5 item 4 — expense edit + free-text notes.
// ============================================================================
describe('BudgetPanel — expense edit + notes (Phase 5 item 4)', () => {
  const EXPENSE: Expense = {
    id: 'e-edit',
    tripId: 'trip-test',
    category: 'Food',
    label: 'Noodles',
    amount: 100,
    currency: 'CNY',
    paid: false,
    note: 'Original note',
  };

  it('opens pre-filled in edit mode from the row\'s pencil icon, swapping the heading/submit label', () => {
    resetStore({ expenses: [EXPENSE] });
    render(<BudgetPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Noodles' }));

    expect(screen.getByRole('heading', { name: 'Editing expense' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Noodles');
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText(/^Note/) as HTMLTextAreaElement).value).toBe('Original note');
  });

  it('saves an edit via updateExpense, preserving fields the form does not touch (id, tripId, paid)', async () => {
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({ expenses: [EXPENSE], updateExpense });
    render(<BudgetPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Noodles' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Noodles (updated)' } });
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Updated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await vi.waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1));
    expect(updateExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'e-edit',
        tripId: 'trip-test',
        paid: false,
        label: 'Noodles (updated)',
        note: 'Updated note',
      }),
    );
  });

  it('surfaces the note on the expense row', () => {
    resetStore({ expenses: [EXPENSE] });
    render(<BudgetPanel />);
    expect(screen.getByText('Original note')).toBeInTheDocument();
  });

  it('clearing the note field on save persists it as unset, not an empty string', async () => {
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({ expenses: [EXPENSE], updateExpense });
    render(<BudgetPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Noodles' }));
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await vi.waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1));
    expect(updateExpense.mock.calls[0][0].note).toBeUndefined();
  });
});

// ============================================================================
// Phase 5 item 5 — trip companions (members) + Paid by, including the
// orphan-tolerance trap (#3).
// ============================================================================
describe('BudgetPanel — trip companions + Paid by (Phase 5 item 5)', () => {
  const MEMBERS: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];

  it('shows the empty-companions state when the trip has no members yet', () => {
    resetStore();
    render(<BudgetPanel />);
    expect(screen.getByText('No companions yet')).toBeInTheDocument();
  });

  it('adds a member via the companions form and clears the input', async () => {
    const addMember = vi.fn<TripState['addMember']>().mockResolvedValue({ id: 'm-new', name: 'Sam' });
    resetStore({ addMember });
    render(<BudgetPanel />);

    const input = screen.getByLabelText('New companion name');
    fireEvent.change(input, { target: { value: '  Sam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // Wait on the actual side effect (input clears) rather than racing the
    // mocked promise's own microtask against the assertion below.
    await vi.waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(addMember).toHaveBeenCalledWith('Sam');
  });

  it('renames a member on Enter and removes a member via its icon buttons', async () => {
    const renameMember = vi.fn<TripState['renameMember']>().mockResolvedValue(undefined);
    const removeMember = vi.fn<TripState['removeMember']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, renameMember, removeMember });
    render(<BudgetPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Alex' }));
    const renameInput = screen.getByLabelText('Rename companion');
    fireEvent.change(renameInput, { target: { value: 'Alexandra' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    await vi.waitFor(() => expect(renameMember).toHaveBeenCalledWith('m-alex', 'Alexandra'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Priya' }));
    await vi.waitFor(() => expect(removeMember).toHaveBeenCalledWith('m-priya'));
  });

  it('Escape cancels a rename without calling renameMember, even when the resulting unmount fires a blur (code-review regression)', () => {
    // jsdom does not reproduce a real browser's "removing a focused element
    // fires blur/focusout synchronously" behaviour, so this test drives that
    // exact sequence by hand: Escape first (which unmounts the input via
    // `renamingId` flipping to null), THEN an explicit blur on the
    // now-detached input — standing in for what a real browser would fire
    // on its own. Without the `renameCancelingRef` guard, that blur would
    // still call commitRename and silently persist the half-typed value.
    const renameMember = vi.fn<TripState['renameMember']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, renameMember });
    const { container } = render(<BudgetPanel />);
    // Scoped query, not screen.getByText('Alex') — "Alex" also appears as a
    // <option> inside the (CSS-hidden but still DOM-present) expense form's
    // "Paid by" select, which getByText doesn't filter out.
    const memberName = () => container.querySelector('.member-chip .member-name')?.textContent;

    fireEvent.click(screen.getByRole('button', { name: 'Rename Alex' }));
    const renameInput = screen.getByLabelText('Rename companion');
    fireEvent.change(renameInput, { target: { value: 'Unwanted edit' } });
    fireEvent.keyDown(renameInput, { key: 'Escape' });

    // The chip reverted to display mode (Escape's own, non-blur effect).
    expect(screen.queryByLabelText('Rename companion')).not.toBeInTheDocument();
    expect(memberName()).toBe('Alex');

    // Simulate the real-browser blur a DOM removal would trigger.
    fireEvent.blur(renameInput);

    expect(renameMember).not.toHaveBeenCalled();
    expect(memberName()).toBe('Alex');
  });

  it('lets the expense form pick a "Paid by" member, and surfaces the payer on the saved row', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, addExpense });
    render(<BudgetPanel />);

    // Two "Add expense"-named buttons exist once the form is open (the
    // header button, and the form's own submit button) — [0]/[1] picks each
    // deliberately rather than relying on `getByRole` staying unambiguous.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Dumplings' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Paid by'), { target: { value: 'm-priya' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[1]);

    await vi.waitFor(() =>
      expect(addExpense).toHaveBeenCalledWith(expect.objectContaining({ paidBy: 'm-priya' })),
    );
  });

  it('PHASE5 trap #3 — an expense whose paidBy no longer resolves to a member renders "Paid by —", never crashes', () => {
    const orphanExpense: Expense = {
      id: 'e-orphan',
      tripId: 'trip-test',
      category: 'Food',
      label: 'Hotpot',
      amount: 80,
      currency: 'CNY',
      paid: false,
      paidBy: 'm-deleted',
    };
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, expenses: [orphanExpense] });
    expect(() => render(<BudgetPanel />)).not.toThrow();
    // A tight regex (not a bare /Paid by/) — the companions card's own
    // panel-hint copy also contains the literal words "Paid by" (in
    // quotes), so a looser match would be ambiguous.
    expect(screen.getByText(/Paid by\s*—/)).toBeInTheDocument();
  });

  it('an expense with no paidBy at all renders no payer meta (not an error state)', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [{ id: 'e-plain', tripId: 'trip-test', category: 'Food', label: 'Snack', amount: 10, currency: 'AUD', paid: true }],
    });
    const { container } = render(<BudgetPanel />);
    expect(container.querySelector('.expense-payer')).toBeNull();
  });

  it('PHASE5 trap #3 — opening the edit form for an expense with a dangling paidBy opens the "Paid by" select on "— none —", not the orphaned id', async () => {
    const orphanExpense: Expense = {
      id: 'e-orphan-edit',
      tripId: 'trip-test',
      category: 'Food',
      label: 'Hotpot',
      amount: 80,
      currency: 'CNY',
      paid: false,
      paidBy: 'm-deleted',
    };
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, expenses: [orphanExpense], updateExpense });
    render(<BudgetPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Hotpot' }));

    const paidBySelect = screen.getByLabelText('Paid by') as HTMLSelectElement;
    expect(paidBySelect.value).toBe('');
    // The dangling id is genuinely absent from the option list, not merely
    // unselected — confirms there's nothing selectable that maps to it.
    expect(within(paidBySelect).queryByRole('option', { name: /m-deleted/ })).not.toBeInTheDocument();

    // Re-saving without touching "Paid by" clears the dangling reference
    // (documented behaviour — see the openEdit doc comment) rather than
    // silently preserving the orphaned id server-side.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(updateExpense).toHaveBeenCalledTimes(1));
    expect(updateExpense.mock.calls[0][0].paidBy).toBeUndefined();
  });
});

// ============================================================================
// Phase 5 item 6 — per-person totals, including the live-convert trap (#4).
// ============================================================================
describe('BudgetPanel — By-person totals (Phase 5 item 6)', () => {
  const MEMBERS: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];

  it('shows a pointer back to the companions card when there are no members yet', () => {
    resetStore();
    render(<BudgetPanel />);
    expect(screen.getByText(/No companions yet — add one above/)).toBeInTheDocument();
  });

  it('sums each member\'s CONVERTED total (never raw amounts across currencies), excludes a no-rate expense from the bar with a note, and separately flags an orphaned-payer expense', () => {
    const expenses: Expense[] = [
      // Alex: CNY 100 (converts to 21) + USD 10 (converts to 15) = 36.
      { id: 'e1', tripId: 'trip-test', category: 'Food', label: 'A', amount: 100, currency: 'CNY', paid: true, paidBy: 'm-alex' },
      { id: 'e2', tripId: 'trip-test', category: 'Food', label: 'B', amount: 10, currency: 'USD', paid: true, paidBy: 'm-alex' },
      // Alex also has a no-rate (THB) expense — excluded from the bar, flagged.
      { id: 'e3', tripId: 'trip-test', category: 'Food', label: 'C', amount: 500, currency: 'THB', paid: false, paidBy: 'm-alex' },
      // Priya paid nothing.
      // An expense paid by a member who no longer exists — must not be
      // silently dropped nor crash; surfaced as its own separate note.
      { id: 'e4', tripId: 'trip-test', category: 'Food', label: 'D', amount: 999, currency: 'CNY', paid: true, paidBy: 'm-ghost' },
    ];
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, expenses });
    const { container } = render(<BudgetPanel />);

    const byPersonCard = container.querySelector('.by-person-card') as HTMLElement;
    const alexRow = within(byPersonCard).getByText('Alex').closest('.cat-row') as HTMLElement;
    expect(within(alexRow).getByText('A$36')).toBeInTheDocument();
    expect(within(alexRow).getByText('1 excl. (no rate)')).toBeInTheDocument();

    const priyaRow = within(byPersonCard).getByText('Priya').closest('.cat-row') as HTMLElement;
    expect(within(priyaRow).getByText('A$0')).toBeInTheDocument();

    expect(
      within(byPersonCard).getByText(/1 expense excluded — payer no longer in your companions list/),
    ).toBeInTheDocument();
  });
});
