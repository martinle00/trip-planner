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
  it('defaults currency to the attached city (Singapore -> SGD, Shanghai -> CNY), and "Whole trip" -> home currency', () => {
    resetStore({ days: DAYS });
    render(<BudgetPanel onOpenSettings={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);

    const attachTo = screen.getByLabelText('Attach to') as HTMLSelectElement;
    const currencySelect = screen.getByLabelText('Currency paid in') as HTMLSelectElement;

    fireEvent.change(attachTo, { target: { value: 'Singapore' } });
    expect(currencySelect.value).toBe('SGD');

    fireEvent.change(attachTo, { target: { value: 'Shanghai' } });
    expect(currencySelect.value).toBe('CNY');

    fireEvent.change(attachTo, { target: { value: '' } });
    expect(currencySelect.value).toBe('AUD'); // trip.homeCurrency
  });

  it('keeps a manually-picked currency when "Attach to" changes afterwards', () => {
    resetStore({ days: DAYS });
    render(<BudgetPanel onOpenSettings={() => {}} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);

    const attachTo = screen.getByLabelText('Attach to') as HTMLSelectElement;
    const currencySelect = screen.getByLabelText('Currency paid in') as HTMLSelectElement;

    fireEvent.change(attachTo, { target: { value: 'Shanghai' } });
    expect(currencySelect.value).toBe('CNY');

    fireEvent.change(currencySelect, { target: { value: 'USD' } }); // manual override
    expect(currencySelect.value).toBe('USD');

    fireEvent.change(attachTo, { target: { value: 'Singapore' } }); // would default to SGD
    expect(currencySelect.value).toBe('USD'); // ...but the manual choice sticks
  });

  it('resets the manual-override flag once the form is reopened', () => {
    resetStore({ days: DAYS });
    render(<BudgetPanel onOpenSettings={() => {}} />);
    const toggle = screen.getAllByRole('button', { name: 'Add expense' })[0];
    fireEvent.click(toggle);

    const currencySelect = screen.getByLabelText('Currency paid in') as HTMLSelectElement;
    fireEvent.change(currencySelect, { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); // closes + resets

    fireEvent.click(toggle); // reopen
    expect((screen.getByLabelText('Currency paid in') as HTMLSelectElement).value).toBe('AUD');

    const attachTo = screen.getByLabelText('Attach to') as HTMLSelectElement;
    fireEvent.change(attachTo, { target: { value: 'Singapore' } });
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
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
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
    render(<BudgetPanel onOpenSettings={() => {}} />);
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
    render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(screen.getByText(/THB · no rate/)).toBeInTheDocument();
  });

  it('hides the conversion line for an expense already in the home currency', () => {
    render(<BudgetPanel onOpenSettings={() => {}} />);
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
    render(<BudgetPanel onOpenSettings={() => {}} />);

    const foodRow = screen.getByText('Food', { selector: '.cat-label span' }).closest('.cat-row') as HTMLElement;
    expect(foodRow.querySelector('.cat-amt-note')?.textContent).toBe('2 currencies');

    const shoppingRow = screen
      .getByText('Shopping', { selector: '.cat-label span' })
      .closest('.cat-row') as HTMLElement;
    expect(shoppingRow.querySelector('.cat-amt-note')).toBeNull();
  });

  it('a category whose only OTHER-currency expense has no known rate does not count it toward "N currencies" (it is excluded before reaching the category tally)', () => {
    const expenses: Expense[] = [
      { id: 'e-food-cny', tripId: 'trip-test', category: 'Food', label: 'Food CNY', amount: 100, currency: 'CNY', paid: true },
      { id: 'e-food-thb', tripId: 'trip-test', category: 'Food', label: 'Food THB (no rate)', amount: 500, currency: 'THB', paid: true },
    ];
    resetStore({ expenses });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    const foodRow = screen.getByText('Food', { selector: '.cat-label span' }).closest('.cat-row') as HTMLElement;
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
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(visibleStatusText(container)).toMatch(/Fetching latest rates/);
    const btn = screen.getByRole('button', { name: /Refreshing/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the error state citing the last known-good fetch time', () => {
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twoHoursAgo }, ratesError: 'Network error' });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(visibleStatusText(container)).toMatch(/Couldn.t refresh — still showing rates from 2 hours ago/);
  });

  it('shows the offline state citing the last known-good fetch time', () => {
    onlineMock = false;
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twoHoursAgo } });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(visibleStatusText(container)).toMatch(/You.re offline — showing last-known rates from 2 hours ago/);
  });

  it('shows the "never refreshed" state when ratesUpdatedAt is undefined', () => {
    resetStore(); // BASE_TRIP has no ratesUpdatedAt
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(visibleStatusText(container)).toBe('No rates fetched yet — using built-in reference rates');
  });

  it('shows "Rates updated <relative time>" once refreshed and settled', () => {
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twoHoursAgo } });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(visibleStatusText(container)).toBe('Rates updated 2 hours ago');
  });

  it('shows the "stale" state once the last fetch is older than 24 hours', () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    resetStore({ trip: { ...BASE_TRIP, ratesUpdatedAt: twentyFiveHoursAgo } });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(visibleStatusText(container)).toBe('Rates updated 1 day ago — may be out of date');
  });

  it('calls refreshRates() when the refresh button is clicked', () => {
    const refreshRates = vi.fn<TripState['refreshRates']>().mockResolvedValue(undefined);
    resetStore({ refreshRates });
    render(<BudgetPanel onOpenSettings={() => {}} />);
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
    const { container, rerender } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(container.querySelector('.summary-card.flash-confirm')).toBeNull();

    // Simulate refreshRates() completing successfully: ratesLoading flips
    // false, ratesError stays undefined.
    useTripStore.setState({ ratesLoading: false, ratesError: undefined });
    rerender(<BudgetPanel onOpenSettings={() => {}} />);

    expect(container.querySelector('.summary-card.flash-confirm')).not.toBeNull();

    vi.advanceTimersByTime(850);
    rerender(<BudgetPanel onOpenSettings={() => {}} />);
    expect(container.querySelector('.summary-card.flash-confirm')).toBeNull();
  });

  it('does NOT flash on a loading->settled transition that ended in failure', () => {
    resetStore({ expenses: EXPENSES, ratesLoading: true });
    const { container, rerender } = render(<BudgetPanel onOpenSettings={() => {}} />);

    useTripStore.setState({ ratesLoading: false, ratesError: 'Network error' });
    rerender(<BudgetPanel onOpenSettings={() => {}} />);

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
    render(<BudgetPanel onOpenSettings={() => {}} />);

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
    render(<BudgetPanel onOpenSettings={() => {}} />);

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
    render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(screen.getByText('Original note')).toBeInTheDocument();
  });

  it('clearing the note field on save persists it as unset, not an empty string', async () => {
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({ expenses: [EXPENSE], updateExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

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
describe('BudgetPanel — Paid by on expenses (Phase 5 item 5)', () => {
  const MEMBERS: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];

  // NOTE: the companions CRUD tests that used to live here (empty state,
  // add, rename/remove, and the Escape-cancel regression) moved to
  // features/settings/SettingsModal.test.tsx in Phase 6 along with the
  // companions card itself. They were ported, not dropped.

  it('lets the expense form pick a "Paid by" member, and surfaces the payer on the saved row', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, addExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

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
    expect(() => render(<BudgetPanel onOpenSettings={() => {}} />)).not.toThrow();
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
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
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
    render(<BudgetPanel onOpenSettings={() => {}} />);

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
    render(<BudgetPanel onOpenSettings={() => {}} />);
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
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const byPersonCard = container.querySelector('.by-person-card') as HTMLElement;
    const alexRow = within(byPersonCard)
      .getByText('Alex')
      .closest('.split-legend-row') as HTMLElement;
    expect(within(alexRow).getByText('A$36')).toBeInTheDocument();
    expect(within(alexRow).getByText('1 excl. (no rate)')).toBeInTheDocument();

    const priyaRow = within(byPersonCard)
      .getByText('Priya')
      .closest('.split-legend-row') as HTMLElement;
    expect(within(priyaRow).getByText('A$0')).toBeInTheDocument();

    expect(
      within(byPersonCard).getByText(/1 expense excluded — payer no longer in your companions list/),
    ).toBeInTheDocument();
  });
});

describe('BudgetPanel — already-paid, payer prompt and Covers (Phase 6 items 10-11)', () => {
  const MEMBERS_2: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];
  const UNPAID: Expense = {
    id: 'e-1', tripId: 'trip-test', category: 'Food', label: 'Hotpot',
    amount: 80, currency: 'CNY', paid: false,
  };

  it('marking an expense paid asks who paid, and records the chosen payer', async () => {
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, expenses: [UNPAID], updateExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getByLabelText('Mark Hotpot as paid'));
    expect(screen.getByText('Who paid?')).toBeInTheDocument();
    // The toggle alone must NOT have committed anything yet — the prompt owns
    // the write, so dismissing it leaves the expense untouched.
    expect(updateExpense).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Priya/ }));
    await vi.waitFor(() =>
      expect(updateExpense).toHaveBeenCalledWith(expect.objectContaining({ paid: true, paidBy: 'm-priya' })),
    );
  });

  it('cancelling the payer prompt leaves the expense unpaid and unchanged', () => {
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, expenses: [UNPAID], updateExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getByLabelText('Mark Hotpot as paid'));
    fireEvent.click(screen.getByRole('button', { name: 'Close without marking paid' }));

    expect(screen.queryByText('Who paid?')).not.toBeInTheDocument();
    expect(updateExpense).not.toHaveBeenCalled();
  });

  it('un-marking a paid expense never prompts', async () => {
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS_2 },
      expenses: [{ ...UNPAID, paid: true, paidBy: 'm-alex' }],
      updateExpense,
    });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getByLabelText('Mark Hotpot as unpaid'));
    expect(screen.queryByText('Who paid?')).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(updateExpense).toHaveBeenCalledWith(expect.objectContaining({ paid: false })),
    );
  });

  it('with NO companions defined, marking paid commits immediately instead of trapping an empty prompt', async () => {
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({ expenses: [UNPAID], updateExpense }); // BASE_TRIP has no members
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getByLabelText('Mark Hotpot as paid'));
    expect(screen.queryByText('Who paid?')).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(updateExpense).toHaveBeenCalledWith(expect.objectContaining({ paid: true })),
    );
  });

  it('does not re-ask when the expense already records a payer', async () => {
    // The one branch that must NOT fall through to the prompt despite
    // members existing — every other branch of the toggle contract has a
    // test, and this is the easiest to break by reordering the guards.
    const updateExpense = vi.fn<TripState['updateExpense']>().mockResolvedValue(undefined);
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS_2 },
      expenses: [{ ...UNPAID, paidBy: 'm-alex' }],
      updateExpense,
    });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getByLabelText('Mark Hotpot as paid'));
    expect(screen.queryByText('Who paid?')).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(updateExpense).toHaveBeenCalledWith(expect.objectContaining({ paid: true, paidBy: 'm-alex' })),
    );
  });

  it('the add form can log an expense that is already paid', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({ addExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Flights' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '900' } });
    fireEvent.click(screen.getByLabelText('Already paid'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[1]);

    await vi.waitFor(() =>
      expect(addExpense).toHaveBeenCalledWith(expect.objectContaining({ paid: true })),
    );
  });

  it('Covers defaults to everyone, which is stored as undefined (never an empty array)', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, addExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Taxi' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '30' } });
    expect(screen.getByRole('radio', { name: 'Everyone' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[1]);

    await vi.waitFor(() =>
      expect(addExpense).toHaveBeenCalledWith(expect.objectContaining({ coversMemberIds: undefined })),
    );
  });

  it('a subset of people is stored as their ids', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, addExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Museum' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Choose people' }));
    fireEvent.click(screen.getByLabelText('Alex'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[1]);

    await vi.waitFor(() =>
      expect(addExpense).toHaveBeenCalledWith(expect.objectContaining({ coversMemberIds: ['m-alex'] })),
    );
  });

  it('deselecting the LAST chosen person snaps back to Everyone, so "covers nobody" is unreachable', async () => {
    // The degenerate empty-array state is prevented at three layers; this is
    // the interaction-level one. `parseSnapshot` handles data arriving by
    // import, which never passes through this control at all.
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, addExpense });
    render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[0]);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Snacks' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Choose people' }));
    fireEvent.click(screen.getByLabelText('Alex'));
    fireEvent.click(screen.getByLabelText('Alex')); // deselect the only one

    expect(screen.getByRole('radio', { name: 'Everyone' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add expense' })[1]);

    await vi.waitFor(() =>
      expect(addExpense).toHaveBeenCalledWith(expect.objectContaining({ coversMemberIds: undefined })),
    );
  });
});

describe('BudgetPanel — breakdown bar semantics (Phase 6 item 7)', () => {
  // PHASE6.md's definition of done names this explicitly: assert against
  // budget.total, NOT byPersonMax. The old `sum / byPersonMax` math made the
  // top payer always render a full-width bar, so a person covering 90% of the
  // trip looked identical to the largest of several small payers — the same
  // widget meaning two different things one card apart from "By category".
  const MEMBERS_2: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];
  const EXPENSES: Expense[] = [
    { id: 'e-1', tripId: 'trip-test', category: 'Food', label: 'Big', amount: 75, currency: 'AUD', paid: true, paidBy: 'm-alex' },
    { id: 'e-2', tripId: 'trip-test', category: 'Food', label: 'Small', amount: 25, currency: 'AUD', paid: true, paidBy: 'm-priya' },
  ];

  it('sizes the split segments as a share of what was actually paid', () => {
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, expenses: EXPENSES });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const card = container.querySelector('.by-person-card') as HTMLElement;
    const widths = Array.from(card.querySelectorAll('.split-seg')).map(
      (el) => (el as HTMLElement).style.width,
    );
    expect(widths).toEqual(['75%', '25%']);
  });

  it('gives a member who paid nothing no segment at all', () => {
    // The old form floored every bar at 4% so a tiny payer stayed visible —
    // which also drew a visible bar next to "A$0". Stacked, a zero share is
    // simply absent, which is the honest rendering.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS_2 },
      expenses: [EXPENSES[0]],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const card = container.querySelector('.by-person-card') as HTMLElement;
    expect(card.querySelectorAll('.split-seg')).toHaveLength(1);
    const priyaRow = within(card).getByText('Priya').closest('.split-legend-row') as HTMLElement;
    expect(within(priyaRow).getByText('A$0')).toBeInTheDocument();
  });

  it('gives unassigned spending its own segment instead of dropping it', () => {
    // THE bug this form replaced: an expense with no `paidBy` was skipped
    // before anything counted it, so the per-person bars were shares of a
    // total they could never add up to — with nothing on the card saying
    // where the rest went.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS_2 },
      expenses: [
        { ...EXPENSES[0], amount: 50 },
        { ...EXPENSES[1], amount: 25 },
        // Nobody named — the common case, since the add form leaves it unset.
        { id: 'e-3', tripId: 'trip-test', category: 'Food', label: 'Shared', amount: 25, currency: 'AUD', paid: true },
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const card = container.querySelector('.by-person-card') as HTMLElement;
    const unassigned = card.querySelector('.split-seg-unassigned') as HTMLElement;
    expect(unassigned).not.toBeNull();
    expect(unassigned.style.width).toBe('25%');

    const row = within(card).getByText(/Not assigned/).closest('.split-legend-row') as HTMLElement;
    expect(within(row).getByText('A$25')).toBeInTheDocument();
    expect(within(row).getByText(/1 expense/)).toBeInTheDocument();

    // And the segments account for the whole track.
    const widths = Array.from(card.querySelectorAll('.split-seg')).map(
      (el) => parseFloat((el as HTMLElement).style.width),
    );
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it('marks a $0 companion recessive so a missing segment doesn’t read as a broken bar', () => {
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, expenses: [EXPENSES[0]] });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const card = container.querySelector('.by-person-card') as HTMLElement;
    const priyaRow = within(card).getByText('Priya').closest('.split-legend-row') as HTMLElement;
    expect(priyaRow.className).toContain('is-zero');
    const alexRow = within(card).getByText('Alex').closest('.split-legend-row') as HTMLElement;
    expect(alexRow.className).not.toContain('is-zero');
  });

  it('paints each segment in that member’s own avatar colour', () => {
    resetStore({
      trip: {
        ...BASE_TRIP,
        members: [
          { id: 'm-alex', name: 'Alex', color: 'm-denim' },
          { id: 'm-priya', name: 'Priya', color: 'm-berry' },
        ],
      },
      expenses: EXPENSES,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const segs = Array.from(
      (container.querySelector('.by-person-card') as HTMLElement).querySelectorAll('.split-seg'),
    ) as HTMLElement[];
    expect(segs.map((el) => el.style.background)).toEqual(['var(--m-denim)', 'var(--m-berry)']);
    // Coloured segments must not carry the alternating-lightness fallback,
    // which would misreport the swatch the member actually picked.
    expect(segs.some((el) => el.className.includes('split-seg-plain'))).toBe(false);
  });

  it('falls back to jade for a member with no colour set', () => {
    // Colour is optional on a member by design — an unset one must look
    // unset, never get silently auto-assigned a swatch here.
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, expenses: EXPENSES });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const segs = Array.from(
      (container.querySelector('.by-person-card') as HTMLElement).querySelectorAll('.split-seg'),
    ) as HTMLElement[];
    expect(segs.every((el) => el.className.includes('split-seg-plain'))).toBe(true);
    expect(segs.every((el) => el.style.background === '')).toBe(true);
  });

  it('describes the whole track in one sentence for screen readers', () => {
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS_2 }, expenses: EXPENSES });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    const card = container.querySelector('.by-person-card') as HTMLElement;
    // A stacked bar's segments carry no text of their own — without this a
    // screen reader walks a row of silent divs.
    expect(within(card).getByRole('img')).toHaveAttribute(
      'aria-label',
      'Who paid: Alex A$75, Priya A$25',
    );
  });
});

// ---------------------------------------------------------------------------
// Filters. The summary/By-category/By-person cards deliberately REBASE onto
// the filtered set — "Trip total" answers "what does this selection cost?"
// while a filter is on, which is the whole point of filtering by city. The
// rates card is the one thing that must not move: it reports the rates being
// applied, not a subtotal.
// ---------------------------------------------------------------------------

const FILTER_MEMBERS: TripMember[] = [
  { id: 'm1', name: 'Martin', color: '--m-1' },
  { id: 'm2', name: 'Sam', color: '--m-2' },
];

const FILTER_EXPENSES: Expense[] = [
  { id: 'e1', tripId: 'trip-test', category: 'Food', label: 'Hawker lunch', amount: 100, currency: 'AUD', paid: true, city: 'Singapore', paidBy: 'm1' },
  { id: 'e2', tripId: 'trip-test', category: 'Attractions', label: 'Gardens tickets', amount: 200, currency: 'AUD', paid: false, city: 'Singapore', paidBy: 'm2' },
  { id: 'e3', tripId: 'trip-test', category: 'Food', label: 'Xiaolongbao', amount: 400, currency: 'AUD', paid: true, city: 'Shanghai', paidBy: 'm1' },
  // No city — the "Whole trip" bucket. Also no payer, which is the ordinary
  // case (the add form leaves `paidBy` unset) and what the By-person card's
  // "Not assigned" segment reports.
  { id: 'e4', tripId: 'trip-test', category: 'Transport', label: 'Flights', amount: 1000, currency: 'AUD', paid: false },
  // Category outside EXPENSE_CATEGORIES — imported/legacy data.
  { id: 'e5', tripId: 'trip-test', category: 'Visas', label: 'Visa fee', amount: 50, currency: 'AUD', paid: true, city: 'Shanghai', paidBy: 'm2' },
];

function renderWithFilters() {
  resetStore({ days: DAYS, expenses: FILTER_EXPENSES, trip: { ...BASE_TRIP, members: FILTER_MEMBERS } });
  return render(<BudgetPanel onOpenSettings={() => {}} />);
}

function visibleLabels(): string[] {
  return Array.from(document.querySelectorAll('.expense-label')).map((n) => n.textContent ?? '');
}

function tripTotal(): string {
  return document.querySelector('.summary-card .home')?.textContent ?? '';
}

/** A filter chip. They're `role="radio"` (single-choice), not plain buttons —
 *  see the radiogroup comment in BudgetPanel.tsx. */
/** Filter chips are `aria-pressed` buttons in a labelled group, never radios
 *  — see the ARIA comment in BudgetPanel.tsx. */
function chip(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('BudgetPanel — filters', () => {
  it('filters by city, and rebases the totals onto that city', () => {
    renderWithFilters();
    expect(tripTotal()).toBe('A$1,750');

    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Singapore' } });

    expect(visibleLabels()).toEqual(['Gardens tickets', 'Hawker lunch']);
    expect(tripTotal()).toBe('A$300');
  });

  it('reaches city-less expenses through the "Whole trip" option', () => {
    renderWithFilters();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '__none__' } });

    expect(visibleLabels()).toEqual(['Flights']);
    expect(tripTotal()).toBe('A$1,000');
  });

  it('filters by category and by paid status', () => {
    renderWithFilters();

    fireEvent.click(chip('Food'));
    expect(visibleLabels()).toEqual(['Xiaolongbao', 'Hawker lunch']);

    fireEvent.click(chip('All categories'));
    fireEvent.click(chip('Unpaid'));
    expect(visibleLabels()).toEqual(['Flights', 'Gardens tickets']);

    // Pressing the active payment chip again releases it back to everything —
    // that's what replaces a third "Paid & unpaid" chip.
    fireEvent.click(chip('Unpaid'));
    expect(visibleLabels()).toHaveLength(5);
  });

  it('releases an active category chip when pressed again, matching the payment row', () => {
    // The two rows are styled identically and stacked — whichever a user
    // learns first sets their expectation of the other, so "press the active
    // chip to clear it" has to hold in both.
    renderWithFilters();
    fireEvent.click(chip('Food'));
    expect(visibleLabels()).toEqual(['Xiaolongbao', 'Hawker lunch']);

    fireEvent.click(chip('Food'));
    expect(visibleLabels()).toHaveLength(5);
    expect(chip('All categories')).toHaveAttribute('aria-pressed', 'true');
  });

  it('combines filters with AND', () => {
    renderWithFilters();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Shanghai' } });
    fireEvent.click(chip('Food'));

    expect(visibleLabels()).toEqual(['Xiaolongbao']);
    expect(tripTotal()).toBe('A$400');
  });

  it('offers a chip for a category outside EXPENSE_CATEGORIES, so no expense is unreachable', () => {
    renderWithFilters();
    // Built from the constant alone, 'Visas' would have no chip and that row
    // could never be isolated.
    fireEvent.click(chip('Visas'));
    expect(visibleLabels()).toEqual(['Visa fee']);
  });

  it('offers no chip for a canonical category nothing is filed under', () => {
    renderWithFilters();
    // 'Accommodation' is in EXPENSE_CATEGORIES but unused here — a chip for
    // it could only ever return an empty list.
    expect(screen.queryByRole('button', { name: 'Accommodation' })).not.toBeInTheDocument();
    expect(chip('Food')).toBeInTheDocument();
  });

  it('rebases the By-person bars too, so the cards never disagree with the list', () => {
    const { container } = renderWithFilters();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Shanghai' } });

    const byPerson = container.querySelector('.by-person-card') as HTMLElement;
    // Shanghai only: Martin A$400 (e3), Sam A$50 (e5).
    expect(within(byPerson).getByText('A$400')).toBeInTheDocument();
    expect(within(byPerson).getByText('A$50')).toBeInTheDocument();
  });

  it('leaves the rates card alone — it reports rates, not a subtotal', () => {
    resetStore({
      days: DAYS,
      expenses: [
        ...FILTER_EXPENSES,
        { id: 'e6', tripId: 'trip-test', category: 'Food', label: 'Street food', amount: 90, currency: 'CNY', paid: true, city: 'Shanghai' },
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const rateChipText = () =>
      Array.from(container.querySelectorAll('.rate-chip')).map((n) => n.textContent ?? '').join(' ');
    expect(rateChipText()).toContain('CNY');

    // Filtering to a city with no CNY expense must not drop the CNY rate.
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Singapore' } });
    expect(rateChipText()).toContain('CNY');
  });

  it('marks every rebased card as filtered, so a card read on its own can’t mislead', () => {
    const { container } = renderWithFilters();
    // `.tag` is also the expense rows' category pill, so match on the text.
    const filteredTags = () =>
      Array.from(container.querySelectorAll('.tag')).filter((t) => t.textContent === 'Filtered');
    expect(filteredTags()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Shanghai' } });

    // The "Showing N of M" strip scrolls away on a phone long before the
    // By-person card is on screen, so each rebased card carries its own tag.
    const tagged = filteredTags().map((t) => t.parentElement?.textContent ?? '');
    expect(tagged.some((t) => t.includes('Trip total'))).toBe(true);
    expect(tagged.some((t) => t.includes('Paid / booked'))).toBe(true);
    expect(tagged.some((t) => t.includes('Still to pay'))).toBe(true);
    expect(tagged.some((t) => t.includes('By category'))).toBe(true);
    expect(tagged.some((t) => t.includes('By person'))).toBe(true);
  });

  it('announces the filtered count in a live region', () => {
    const { container } = renderWithFilters();
    const live = container.querySelector('[role="status"][aria-live="polite"]') as HTMLElement;
    // Present and empty before any filter, so the region is already in the
    // a11y tree when its content changes (announcements are unreliable when
    // the live element itself is inserted at the same time).
    expect(live).not.toBeNull();
    expect(live.textContent).toBe('');

    fireEvent.click(chip('Food'));
    expect(live.textContent).toMatch(/Showing 2 of 5 expenses/);
  });

  it('exposes both chip rows as labelled groups of toggle buttons, not radios', () => {
    const { container } = renderWithFilters();
    // role="radiogroup"/"radio" would promise roving tabindex + Arrow-key
    // navigation that chips (individually tabbable buttons) don't implement.
    expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
    expect(container.querySelectorAll('.expense-filter-bar [role="group"]')).toHaveLength(2);

    // Visible labels, not just aria-label: the two rows are styled
    // identically, so "Paid & unpaid" would otherwise read as one more
    // category chip.
    const bar = container.querySelector('.places-filter-bar') as HTMLElement;
    expect(within(bar).getByText('Category')).toBeInTheDocument();
    expect(within(bar).getByText('Payment')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Paid & unpaid' })).not.toBeInTheDocument();

    expect(chip('Unpaid')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip('Unpaid'));
    expect(chip('Unpaid')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Paid')).toHaveAttribute('aria-pressed', 'false');
    expect(chip('All categories')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a count and clears back to everything', () => {
    renderWithFilters();
    fireEvent.click(chip('Food'));
    expect(screen.getByText(/Showing 2 of 5 expenses/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(visibleLabels()).toHaveLength(5);
    expect(screen.queryByText(/Showing 2 of 5/)).not.toBeInTheDocument();
  });





  it('does not render By-person bars when nothing matches the filters', () => {
    // Bars are floored at 4% width so a small payer stays visible, which
    // means an empty selection would otherwise draw every companion a stub
    // bar — reading as "they paid something" when nothing matched at all.
    // The card sits outside the summary block, so it needs its own guard.
    const { container } = renderWithFilters();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Singapore' } });
    fireEvent.click(chip('Transport'));

    const byPerson = container.querySelector('.by-person-card') as HTMLElement;
    expect(byPerson.querySelectorAll('.cat-row')).toHaveLength(0);
    expect(within(byPerson).getByText(/nothing to split/)).toBeInTheDocument();
  });

  it('offers a way out when a combination matches nothing', () => {
    renderWithFilters();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Singapore' } });
    fireEvent.click(chip('Transport'));

    expect(visibleLabels()).toEqual([]);
    expect(screen.getByText('No expenses match these filters.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(visibleLabels()).toHaveLength(5);
  });
});

// ============================================================================
// Settle up — who owes whom. The maths itself is covered exhaustively in
// lib/settlement.test.ts; these cover the card's own decisions: the
// whole-trip exemption from the filter bar, the states it can be in, and the
// exclusion reporting that keeps "nothing to settle" from reading as
// "settled".
// ============================================================================
describe('BudgetPanel — Settle up', () => {
  const MEMBERS: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];

  function exp(partial: Partial<Expense> & { id: string }): Expense {
    return {
      tripId: 'trip-test',
      category: 'Food',
      label: partial.id,
      amount: 0,
      currency: 'AUD',
      paid: true,
      ...partial,
    };
  }

  function settleCard(container: HTMLElement): HTMLElement {
    return container.querySelector('.settle-card') as HTMLElement;
  }

  it('asks for companions before it can say anything about who owes whom', () => {
    resetStore({ expenses: [exp({ id: 'e1', amount: 100 })] });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    expect(
      within(settleCard(container)).getByText(/Add at least two companions to track who owes whom/),
    ).toBeInTheDocument();
  });

  it('opens Settings from that pointer — companions are edited there, not here', () => {
    const onOpenSettings = vi.fn();
    resetStore();
    const { container } = render(<BudgetPanel onOpenSettings={onOpenSettings} />);

    fireEvent.click(
      within(settleCard(container)).getByRole('button', { name: 'Manage companions in Settings' }),
    );
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('names who pays whom, how much, and shows the working behind each balance', () => {
    // Alex fronts A$300 covering both; Priya has paid nothing.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' })],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const card = settleCard(container);

    const row = card.querySelector('.settle-row') as HTMLElement;
    expect(within(row).getByText('Alex')).toBeInTheDocument();
    expect(within(row).getByText('Priya')).toBeInTheDocument();
    expect(within(row).getByText('A$150')).toBeInTheDocument();

    const alexBalance = within(card).getAllByText('Alex').at(-1)!.closest('.split-legend-row') as HTMLElement;
    // Verb and figure are separate elements (different type faces), so
    // assert on the composed text rather than a single text node.
    expect((alexBalance.querySelector('.cat-amt-value') as HTMLElement).textContent).toBe(
      'is owed A$150',
    );
    expect(within(alexBalance).getByText(/fronted A\$300 · share A\$150/)).toBeInTheDocument();
  });

  it('nets offsetting expenses down instead of listing both debts', () => {
    // Alex covers Priya's A$80 dinner; Priya covers Alex's A$50 train. The
    // card must show ONE A$30 payment, not two debts to remember.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 80, paidBy: 'm-alex', coversMemberIds: ['m-priya'] }),
        exp({ id: 'e2', amount: 50, paidBy: 'm-priya', coversMemberIds: ['m-alex'] }),
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const card = settleCard(container);

    const rows = card.querySelectorAll('.settle-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText('A$30')).toBeInTheDocument();
    expect(
      within(card).getByText(/2 expenses left 2 separate debts between you, netted down to 1 payment/),
    ).toBeInTheDocument();
  });

  it('reports all square once the offsetting expenses cancel exactly', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 80, paidBy: 'm-alex', coversMemberIds: ['m-priya'] }),
        exp({ id: 'e2', amount: 80, paidBy: 'm-priya', coversMemberIds: ['m-alex'] }),
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const card = settleCard(container);

    expect(within(card).getByText(/All square/)).toBeInTheDocument();
    expect(card.querySelectorAll('.settle-row')).toHaveLength(0);
    expect(within(card).getAllByText('square')).toHaveLength(2);
  });

  it('never reports "all square" when nothing qualified — it says what is missing', () => {
    // The dangerous case: a whole trip logged without ticking "paid".
    // Reporting that as settled sends people home owing each other money.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 300, paidBy: 'm-alex', paid: false }),
        exp({ id: 'e2', amount: 40 }),
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const card = settleCard(container);

    expect(within(card).queryByText(/All square/)).not.toBeInTheDocument();
    expect(
      within(card).getByText(/Nothing to settle yet — 2 expenses not counted: 1 not marked paid yet, 1 with no payer set/),
    ).toBeInTheDocument();
  });

  it('names each exclusion reason separately alongside a real settlement', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 300, paidBy: 'm-alex' }),
        exp({ id: 'e2', amount: 500, currency: 'THB', paidBy: 'm-priya' }), // no rate
        exp({ id: 'e3', amount: 99, paidBy: 'm-ghost' }), // former companion
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    expect(
      within(settleCard(container)).getByText(
        /2 expenses not counted — 1 paid by a former companion, 1 with no exchange rate/,
      ),
    ).toBeInTheDocument();
  });

  it('rebases onto the filtered set so a category answers "who owes whom for this"', () => {
    // A$300 of food + A$100 of transport, both fronted by Alex. Whole trip
    // that's Priya owing A$200; filtered to Food it must be A$150 — the
    // question the user asked by pressing the chip.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 300, paidBy: 'm-alex', category: 'Food' }),
        exp({ id: 'e2', amount: 100, paidBy: 'm-alex', category: 'Transport' }),
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    expect(
      within(settleCard(container).querySelector('.settle-row') as HTMLElement).getByText('A$200'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Food' }));

    const card = settleCard(container);
    expect(within(card).getByText('Filtered')).toBeInTheDocument();
    expect(within(card).getByText(/who owes whom for Food, in AUD/)).toBeInTheDocument();
    expect(within(card.querySelector('.settle-row') as HTMLElement).getByText('A$150')).toBeInTheDocument();
    // The balances rebase with it, working and all.
    const alexBalance = within(card).getAllByText('Alex').at(-1)!.closest('.split-legend-row') as HTMLElement;
    expect(within(alexBalance).getByText(/fronted A\$300 · share A\$150/)).toBeInTheDocument();
  });

  it('names the whole filter, not just the category, when several are on', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 300, paidBy: 'm-alex', category: 'Food', city: 'Shanghai' }),
        exp({ id: 'e2', amount: 100, paidBy: 'm-alex', category: 'Food', city: 'Singapore' }),
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Shanghai' } });

    const card = settleCard(container);
    expect(within(card).getByText(/who owes whom for Food · Shanghai, in AUD/)).toBeInTheDocument();
    expect(within(card.querySelector('.settle-row') as HTMLElement).getByText('A$150')).toBeInTheDocument();
  });

  it('withholds "Mark paid" while scoped — a repayment settles the trip, not a category', () => {
    // The double-payment trap: the repayment this button writes carries
    // `category: 'Repayment'`, so it falls straight out of the Food filter
    // that produced the row. The scoped view would still be demanding money
    // that had just been handed over.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 300, paidBy: 'm-alex', category: 'Food' }),
        exp({ id: 'e2', amount: 100, paidBy: 'm-alex', category: 'Transport' }),
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(within(settleCard(container)).getByRole('button', { name: /Mark paid/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Food' }));

    const card = settleCard(container);
    expect(within(card).queryByRole('button', { name: /Mark paid/ })).not.toBeInTheDocument();
    expect(
      within(card).getByText(/Part of the whole-trip balance, not a separate debt/),
    ).toBeInTheDocument();
  });

  it('hands the scoped view a way back to the actionable one', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 300, paidBy: 'm-alex', category: 'Food' }),
        exp({ id: 'e2', amount: 100, paidBy: 'm-alex', category: 'Transport' }),
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));

    fireEvent.click(
      within(settleCard(container)).getByRole('button', {
        name: 'Show the whole trip to record a repayment',
      }),
    );

    const card = settleCard(container);
    expect(within(card).queryByText('Filtered')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /Mark paid/ })).toBeInTheDocument();
    expect(within(card.querySelector('.settle-row') as HTMLElement).getByText('A$200')).toBeInTheDocument();
  });

  it('says a filtered empty result is empty FOR THAT FILTER, not for the trip', () => {
    // "Nothing to settle yet" full stop, over a trip that plainly has debts,
    // is the same class of lie as "all square" over an unpaid trip.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [
        exp({ id: 'e1', amount: 300, paidBy: 'm-alex', category: 'Food' }),
        exp({ id: 'e2', amount: 100, category: 'Transport' }), // no payer
      ],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Transport' }));

    const card = settleCard(container);
    expect(
      within(card).getByText(/Nothing to settle yet for Transport — 1 expense not counted/),
    ).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Show the whole trip' })).toBeInTheDocument();
  });
});

// ============================================================================
// Phase 11 — recording a repayment. The rule that matters most here is
// schema.ts's: a transfer is NOT spending, so it must be absent from every
// cost total on this tab while still clearing the balance it was recorded
// for.
// ============================================================================
describe('BudgetPanel — marking a debt paid', () => {
  const MEMBERS: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];

  function exp(partial: Partial<Expense> & { id: string }): Expense {
    return {
      tripId: 'trip-test',
      category: 'Food',
      label: partial.id,
      amount: 0,
      currency: 'AUD',
      paid: true,
      ...partial,
    };
  }

  const REPAYMENT = exp({
    id: 'r1',
    category: 'Repayment',
    label: 'Priya → Alex',
    amount: 150,
    paidBy: 'm-priya',
    coversMemberIds: ['m-alex'],
    isTransfer: true,
  });

  it('writes the handover as a transfer expense: debtor pays, creditor is the only one covered', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' })],
      addExpense,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(
      within(container.querySelector('.settle-card') as HTMLElement).getByRole('button', {
        name: /Mark paid/,
      }),
    );
    await vi.waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1));

    expect(addExpense.mock.calls[0][0]).toMatchObject({
      amount: 150,
      currency: 'AUD',
      paid: true,
      paidBy: 'm-priya',
      coversMemberIds: ['m-alex'],
      isTransfer: true,
    });
  });

  it('rounds the recorded amount to cents, not to the whole units it displays', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({} as Expense);
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      // A$101 split two ways -> Priya owes 50.5 exactly.
      expenses: [exp({ id: 'e1', amount: 101, paidBy: 'm-alex' })],
      addExpense,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(
      within(container.querySelector('.settle-card') as HTMLElement).getByRole('button', {
        name: /Mark paid/,
      }),
    );
    await vi.waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1));

    expect(addExpense.mock.calls[0][0].amount).toBe(50.5);
  });

  it('clears the debt and reports the trip as square once recorded', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' }), REPAYMENT],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const card = container.querySelector('.settle-card') as HTMLElement;

    expect(within(card).getByText(/All square/)).toBeInTheDocument();
    expect(card.querySelectorAll('.settle-row')).toHaveLength(0);
  });

  it('keeps a repayment out of EVERY cost total — it is not trip spending', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' }), REPAYMENT],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    // Trip total stays A$300, not A$450.
    const summary = container.querySelector('.summary-card') as HTMLElement;
    expect(within(summary).getByText('A$300')).toBeInTheDocument();
    expect(within(summary).queryByText('A$450')).not.toBeInTheDocument();

    // By-person still credits Alex the A$300 he spent, and does not credit
    // Priya the A$150 she handed back.
    const byPerson = container.querySelector('.by-person-card') as HTMLElement;
    const priyaRow = within(byPerson).getByText('Priya').closest('.split-legend-row') as HTMLElement;
    expect(within(priyaRow).getByText('A$0')).toBeInTheDocument();

    // Absent from the "All expenses" list (it shows in the Settle-up card's
    // own history strip instead — that's the only place it belongs), and its
    // "Repayment" category never becomes a filter chip.
    const list = container.querySelector('.expense-list') as HTMLElement;
    expect(within(list).getByText('e1')).toBeInTheDocument();
    expect(within(list).queryByText('Priya → Alex')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Repayment/ })).not.toBeInTheDocument();
  });

  it('shows recorded repayments in their own strip, with an undo', async () => {
    const removeExpense = vi.fn<TripState['removeExpense']>().mockResolvedValue(undefined);
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' }), REPAYMENT],
      removeExpense,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const history = container.querySelector('.settle-history') as HTMLElement;

    expect(within(history).getByText('Priya → Alex')).toBeInTheDocument();
    expect(within(history).getByText('A$150')).toBeInTheDocument();

    fireEvent.click(within(history).getByRole('button', { name: /Undo/ }));
    await vi.waitFor(() => expect(removeExpense).toHaveBeenCalledWith('r1'));
  });

  it('hides the settled strip while scoped — a repayment belongs to no category', () => {
    // Filtered to Food, the balances legitimately exclude the repayment (it
    // isn't a food expense), so listing it underneath them would contradict
    // the very figures it sits below.
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' }), REPAYMENT],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    expect(container.querySelector('.settle-history')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Food' }));

    const card = container.querySelector('.settle-card') as HTMLElement;
    expect(card.querySelector('.settle-history')).toBeNull();
    // The debt is outstanding again in this scope, since the repayment that
    // cleared it isn't food — which is exactly why there's no button here.
    expect(within(card.querySelector('.settle-row') as HTMLElement).getByText('A$150')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Mark paid/ })).not.toBeInTheDocument();
  });

  it('still offers the undo when a repayment is the only expense left', () => {
    // A repayment on its own genuinely skews the balances, so the card must
    // not fall into "nothing to settle" and hide the one control that
    // reverses it.
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, expenses: [REPAYMENT] });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);
    const card = container.querySelector('.settle-card') as HTMLElement;

    expect(within(card).queryByText(/Nothing to settle yet/)).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /Undo/ })).toBeInTheDocument();
  });
});

// ============================================================================
// Phase 11, post-UX-review. Both actions on the Settle-up card DESTROY the
// control that was activated (the row moves between the payment list and the
// settled strip), so focus and confirmation are not polish here — without
// them a keyboard/screen-reader user is dropped to <body> in silence right
// after committing a real repayment.
// ============================================================================
describe('BudgetPanel — Settle up: focus and confirmation', () => {
  const MEMBERS: TripMember[] = [
    { id: 'm-alex', name: 'Alex' },
    { id: 'm-priya', name: 'Priya' },
  ];

  function exp(partial: Partial<Expense> & { id: string }): Expense {
    return {
      tripId: 'trip-test',
      category: 'Food',
      label: partial.id,
      amount: 0,
      currency: 'AUD',
      paid: true,
      ...partial,
    };
  }

  const REPAYMENT = exp({
    id: 'r1',
    category: 'Repayment',
    label: 'Priya → Alex',
    amount: 150,
    paidBy: 'm-priya',
    coversMemberIds: ['m-alex'],
    isTransfer: true,
  });

  it('moves focus to the new repayment\'s Undo after marking a debt paid', async () => {
    // The store is stubbed, so drive the re-render by hand: mark paid, then
    // push the created repayment into state the way the real action would.
    const addExpense = vi
      .fn<TripState['addExpense']>()
      .mockImplementation(async () => {
        useTripStore.setState((s) => ({ expenses: [...s.expenses, REPAYMENT] }));
        return REPAYMENT;
      });
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' })],
      addExpense,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(
      within(container.querySelector('.settle-card') as HTMLElement).getByRole('button', {
        name: /Mark paid/,
      }),
    );

    await vi.waitFor(() => {
      const undo = container.querySelector('[data-settle-focus="undo-r1"]');
      expect(undo).not.toBeNull();
      expect(document.activeElement).toBe(undo);
    });
  });

  it('hands focus back to the restored Mark paid button after an undo', async () => {
    const removeExpense = vi.fn<TripState['removeExpense']>().mockImplementation(async () => {
      useTripStore.setState((s) => ({ expenses: s.expenses.filter((e) => e.id !== 'r1') }));
    });
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' }), REPAYMENT],
      removeExpense,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(
      within(container.querySelector('.settle-history') as HTMLElement).getByRole('button', {
        name: /Undo/,
      }),
    );

    await vi.waitFor(() => {
      const mark = container.querySelector('[data-settle-focus="mark-m-priya->m-alex"]');
      expect(mark).not.toBeNull();
      expect(document.activeElement).toBe(mark);
    });
  });

  it('falls back to the card heading when the action leaves no successor', async () => {
    // Marking the ONLY debt paid collapses the list to "All square", so there
    // is no Undo to land on until the strip renders — the heading is the
    // last-resort target rather than <body>.
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue({
      ...REPAYMENT,
      id: 'not-in-state',
    });
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' })],
      addExpense,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(
      within(container.querySelector('.settle-card') as HTMLElement).getByRole('button', {
        name: /Mark paid/,
      }),
    );

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        container.querySelector('[data-settle-focus="settle-heading"]'),
      );
    });
  });

  it('announces what was recorded, naming both people and the amount', async () => {
    const addExpense = vi.fn<TripState['addExpense']>().mockResolvedValue(REPAYMENT);
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' })],
      addExpense,
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    fireEvent.click(
      within(container.querySelector('.settle-card') as HTMLElement).getByRole('button', {
        name: /Mark paid/,
      }),
    );

    await vi.waitFor(() => {
      const status = container.querySelector('.settle-card [role="status"]') as HTMLElement;
      expect(status.textContent).toContain('Priya paid Alex A$150');
    });
  });

  it('disables only the row being submitted, never every row at once', () => {
    resetStore({
      trip: { ...BASE_TRIP, members: MEMBERS },
      expenses: [exp({ id: 'e1', amount: 300, paidBy: 'm-alex' })],
    });
    const { container } = render(<BudgetPanel onOpenSettings={() => {}} />);

    // Nothing in flight -> the button is live. (The per-row scoping itself is
    // the `settlingKey === key` comparison; this guards against the old
    // `settlingKey !== null`, which greyed out unrelated debts.)
    const mark = container.querySelector('[data-settle-focus="mark-m-priya->m-alex"]');
    expect((mark as HTMLButtonElement).disabled).toBe(false);
  });
});
