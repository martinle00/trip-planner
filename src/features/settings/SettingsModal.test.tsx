// @vitest-environment jsdom
//
// Tests for the Settings modal (Phase 6 item 6). The companions tests here
// MOVED from BudgetPanel.test.tsx when the companions card relocated — they
// are not new coverage, and deliberately were not dropped in the move. The
// Escape-cancel test in particular guards a defect that has already shipped
// once (Phase 5 code review), and jsdom cannot reproduce the browser
// behaviour that caused it, so it has to drive the sequence by hand.
//
// Also covers the Phase 6 additions: the `--m-*` colour picker's
// `aria-checked` wiring (a design-review finding — a first pass had the
// visual selected state only, leaving a screen-reader user unable to tell
// which swatch was active) and the theme radiogroup.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';
import { useTripStore } from '../../store/useTripStore';
import type { TripState } from '../../store/useTripStore';
import type { Trip, TripMember } from '../../data/schema';

const BASE_TRIP: Trip = {
  id: 'trip-test',
  name: 'Test trip',
  startDate: '2026-11-07',
  endDate: '2026-11-30',
  homeCurrency: 'AUD',
  tripCurrency: 'CNY',
  rates: { AUD: 1, CNY: 0.21 },
  cities: [{ name: 'Shanghai', order: 1, nights: 6, arrive: '2026-11-09', depart: '2026-11-15' }],
};

const MEMBERS: TripMember[] = [
  { id: 'm-alex', name: 'Alex' },
  { id: 'm-priya', name: 'Priya', color: 'm-denim' },
];

function resetStore(overrides: Partial<TripState> = {}) {
  useTripStore.setState({
    trip: BASE_TRIP,
    days: [],
    places: [],
    itineraryByDay: {},
    expenses: [],
    loading: false,
    addMember: vi.fn<TripState['addMember']>().mockResolvedValue({} as TripMember),
    renameMember: vi.fn<TripState['renameMember']>().mockResolvedValue(undefined),
    removeMember: vi.fn<TripState['removeMember']>().mockResolvedValue(undefined),
    setMemberColor: vi.fn<TripState['setMemberColor']>().mockResolvedValue(undefined),
    setHomeCurrency: vi.fn<TripState['setHomeCurrency']>().mockResolvedValue(undefined),
    ...overrides,
  });
}

function renderSettings(props: Partial<React.ComponentProps<typeof SettingsModal>> = {}) {
  return render(
    <SettingsModal
      open
      onClose={() => {}}
      theme="light"
      onSetTheme={() => {}}
      onExport={() => {}}
      onImportClick={() => {}}
      onSignOut={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  resetStore();
});

describe('SettingsModal — trip companions (moved from the Budget tab in Phase 6)', () => {
  it('shows the empty-companions state when the trip has no members yet', () => {
    renderSettings();
    expect(screen.getByText('No companions yet')).toBeInTheDocument();
  });

  it('adds a member via the companions form and clears the input', async () => {
    const addMember = vi.fn<TripState['addMember']>().mockResolvedValue({ id: 'm-new', name: 'Sam' });
    resetStore({ addMember });
    renderSettings();

    const input = screen.getByLabelText('New companion name');
    fireEvent.change(input, { target: { value: '  Sam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await vi.waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    expect(addMember).toHaveBeenCalledWith('Sam');
  });

  it('renames a member on Enter and removes a member via its icon buttons', async () => {
    const renameMember = vi.fn<TripState['renameMember']>().mockResolvedValue(undefined);
    const removeMember = vi.fn<TripState['removeMember']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, renameMember, removeMember });
    renderSettings();

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
    // now-detached input — standing in for what a real browser would fire on
    // its own. Without the `renameCancelingRef` guard, that blur would still
    // call commitRename and silently persist the half-typed value.
    const renameMember = vi.fn<TripState['renameMember']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, renameMember });
    const { container } = renderSettings();
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
});

describe('SettingsModal — member colour picker (Phase 6 item 8)', () => {
  it('exposes the selected swatch via aria-checked, not just a visual class', () => {
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS } });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Choose colour for Priya' }));

    // Priya is 'm-denim' in the fixture, so exactly that swatch reports
    // checked and every other one reports unchecked. Asserting on the ARIA
    // state (not the class) is the point: the design review rejected a first
    // pass that set the visual state only.
    const denim = screen.getByRole('radio', { name: 'Denim' });
    expect(denim).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Berry' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'No colour' })).toHaveAttribute('aria-checked', 'false');
  });

  it('reports "No colour" as checked for a member with no colour assigned', () => {
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS } });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Choose colour for Alex' }));
    expect(screen.getByRole('radio', { name: 'No colour' })).toHaveAttribute('aria-checked', 'true');
  });

  it('picks a colour, and clears it back to unset via "No colour"', async () => {
    const setMemberColor = vi.fn<TripState['setMemberColor']>().mockResolvedValue(undefined);
    resetStore({ trip: { ...BASE_TRIP, members: MEMBERS }, setMemberColor });
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Choose colour for Alex' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Berry' }));
    await vi.waitFor(() => expect(setMemberColor).toHaveBeenCalledWith('m-alex', 'm-berry'));

    fireEvent.click(screen.getByRole('button', { name: 'Choose colour for Priya' }));
    fireEvent.click(screen.getByRole('radio', { name: 'No colour' }));
    // `undefined`, not '' — the field's contract is "absent means unset".
    await vi.waitFor(() => expect(setMemberColor).toHaveBeenCalledWith('m-priya', undefined));
  });
});

describe('SettingsModal — appearance and trip data', () => {
  it('marks the active theme with aria-checked and reports the choice', () => {
    const onSetTheme = vi.fn();
    renderSettings({ theme: 'dark', onSetTheme });

    expect(screen.getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Light/ })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('radio', { name: /Light/ }));
    expect(onSetTheme).toHaveBeenCalledWith('light');
  });

  it('surfaces export, import and sign out', () => {
    const onExport = vi.fn();
    const onImportClick = vi.fn();
    const onSignOut = vi.fn();
    renderSettings({ onExport, onImportClick, onSignOut });

    fireEvent.click(screen.getByRole('button', { name: /Export trip.json/ }));
    fireEvent.click(screen.getByRole('button', { name: /Import trip.json/ }));
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));

    expect(onExport).toHaveBeenCalled();
    expect(onImportClick).toHaveBeenCalled();
    // Sign-out's order-sensitive teardown still lives in App.tsx — Settings
    // only relocated the button, so all this asserts is that it delegates.
    expect(onSignOut).toHaveBeenCalled();
  });

  it('changes the home currency (moved here from the Budget rates card)', () => {
    const setHomeCurrency = vi.fn<TripState['setHomeCurrency']>().mockResolvedValue(undefined);
    resetStore({ setHomeCurrency });
    renderSettings();

    fireEvent.change(screen.getByLabelText(/Home currency/), { target: { value: 'CNY' } });
    expect(setHomeCurrency).toHaveBeenCalledWith('CNY');
  });
});
