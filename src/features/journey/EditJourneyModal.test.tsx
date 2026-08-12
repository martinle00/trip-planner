// @vitest-environment jsdom
//
// Tests for the Edit journey sheet (Phase 10). The store's real
// `previewJourneyEdit` is used throughout — the blast-radius copy is the
// whole point of the confirmation step, and stubbing it would only assert
// that the component renders whatever it's handed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { EditJourneyModal } from './EditJourneyModal';
import { useTripStore } from '../../store/useTripStore';
import type { TripState } from '../../store/useTripStore';
import { buildSeed } from '../../data/seed';
import { addDaysISO } from '../../lib/dates';

const seed = buildSeed();

function resetStore(overrides: Partial<TripState> = {}) {
  const real = useTripStore.getState();
  useTripStore.setState({
    trip: seed.trip,
    days: seed.days,
    places: seed.places,
    itineraryByDay: {},
    expenses: [],
    loading: false,
    previewJourneyEdit: real.previewJourneyEdit,
    editJourney: vi.fn<TripState['editJourney']>().mockResolvedValue({
      cities: [], days: { create: [], update: [], delete: [] },
      itineraryToDelete: [], placesToUnassign: [], orphanedPlaces: [], orphanedExpenses: [],
    }),
    ...overrides,
  });
}

function open() {
  return render(<EditJourneyModal open onClose={() => {}} />);
}

/** The leg row containing `name` — rows aren't individually labelled, so
 *  this walks up from the leg's own nights group. */
function legRow(name: string): HTMLElement {
  const group = screen.getByRole('group', { name: `Nights in ${name}` });
  return group.closest('.journey-leg') as HTMLElement;
}

/** The nights field is an input, not text — read its value, don't getByText. */
function nightsField(name: string): HTMLInputElement {
  return screen.getByLabelText(`Number of nights in ${name}`) as HTMLInputElement;
}

beforeEach(() => {
  resetStore();
});

describe('leg list', () => {
  it('lists every base leg with its nights and dates, day trips nested', () => {
    open();
    expect(screen.getByText('Shanghai')).toBeTruthy();
    expect(nightsField('Shanghai').value).toBe('6');
    expect(within(legRow('Shanghai')).getByText('9–15 Nov')).toBeTruthy();
    // Wulong is a day trip: nested under Chongqing, with no nights stepper.
    expect(screen.queryByRole('group', { name: 'Nights in Wulong' })).toBeNull();
    expect(within(legRow('Chongqing')).getByText(/Day trip · Wulong/)).toBeTruthy();
  });

  it('summarises the whole trip and updates as the draft changes', () => {
    open();
    expect(screen.getByText('23 nights')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('One fewer night in Shanghai'));
    fireEvent.click(screen.getByLabelText('One fewer night in Shanghai'));

    expect(screen.getByText('21 nights')).toBeTruthy();
    expect(screen.getByText(/2 days removed/)).toBeTruthy();
    // Dates are derived, not typed — Suzhou has slid two days earlier.
    expect(within(legRow('Suzhou')).getByText('13–15 Nov')).toBeTruthy();
  });

  it('disables the stepper at zero nights and the reorder arrows at the ends', () => {
    open();
    expect(screen.getByLabelText('Move Singapore earlier').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Move Guangzhou later').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('One fewer night in Singapore').hasAttribute('disabled')).toBe(false);
  });

  it('shifts the whole trip when the start date changes', () => {
    open();
    fireEvent.change(screen.getByLabelText('Departs'), { target: { value: '2026-11-10' } });
    expect(within(legRow('Singapore')).getByText('10–12 Nov')).toBeTruthy();
    expect(screen.getByText('23 nights')).toBeTruthy();
  });
});

describe('removing a leg', () => {
  it('states the blast radius before removing anything', () => {
    open();
    fireEvent.click(screen.getByLabelText('Remove Chongqing'));

    expect(screen.getByText('Remove Chongqing?')).toBeTruthy();
    expect(screen.getByText('3 days removed from the trip.')).toBeTruthy();
    // The seed has a Chongqing and a Wulong place; both are kept, not deleted.
    expect(screen.getByText(/2 saved places kept, moved to “Not on this trip”/)).toBeTruthy();
    expect(screen.getByText(/The Wulong day trip goes with it/)).toBeTruthy();
    // Still only a confirmation — the leg is untouched.
    expect(screen.getByText('Chongqing')).toBeTruthy();
    expect(screen.getByText('23 nights')).toBeTruthy();
  });

  it('"Keep it" cancels without changing the draft', () => {
    open();
    fireEvent.click(screen.getByLabelText('Remove Chongqing'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(screen.queryByText('Remove Chongqing?')).toBeNull();
    expect(screen.getByText('23 nights')).toBeTruthy();
  });

  it('removes the leg and its day trip from the draft on confirm', () => {
    open();
    fireEvent.click(screen.getByLabelText('Remove Chongqing'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove leg' }));

    expect(screen.queryByRole('group', { name: 'Nights in Chongqing' })).toBeNull();
    expect(screen.queryByText(/Day trip · Wulong/)).toBeNull();
    expect(screen.getByText('20 nights')).toBeTruthy();
  });

  it('removes a day trip on its own without touching its parent', () => {
    open();
    fireEvent.click(screen.getByLabelText('Remove the Wulong day trip'));
    // "day trip", not "leg" — a day trip is never called a leg in this sheet.
    expect(screen.queryByRole('button', { name: 'Remove leg' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove day trip' }));

    expect(screen.queryByText(/Day trip · Wulong/)).toBeNull();
    expect(screen.getByRole('group', { name: 'Nights in Chongqing' })).toBeTruthy();
    expect(screen.getByText('23 nights')).toBeTruthy();
  });
});

describe('adding a leg', () => {
  function addCity(name: string) {
    fireEvent.change(screen.getByLabelText('New city name'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  }

  it('appends the city with one night and clears the field', () => {
    open();
    addCity('Hong Kong');

    expect((screen.getByLabelText('New city name') as HTMLInputElement).value).toBe('');
    expect(nightsField('Hong Kong').value).toBe('1');
    // Chained onto the end: the seed runs to 30 Nov, so this is the 30th–1st.
    expect(within(legRow('Hong Kong')).getByText('30 Nov – 1 Dec')).toBeTruthy();
    expect(screen.getByText('24 nights')).toBeTruthy();
    expect(screen.getByText(/1 day added/)).toBeTruthy();
  });

  it('refuses a duplicate name and says why, without touching the draft', () => {
    open();
    addCity('shanghai');

    expect(screen.getByRole('alert')).toHaveTextContent('shanghai is already on this trip.');
    expect(screen.getByText('23 nights')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
    // The name stays put so it can be corrected rather than retyped.
    expect((screen.getByLabelText('New city name') as HTMLInputElement).value).toBe('shanghai');
  });

  it('persists the new leg on save', () => {
    open();
    addCity('Hong Kong');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const saved = vi.mocked(useTripStore.getState().editJourney).mock.calls[0][0];
    expect(saved.at(-1)).toMatchObject({ name: 'Hong Kong', nights: 1 });
  });

  it('can rebuild a journey that was emptied in the same draft', () => {
    open();
    for (const leg of ['Singapore', 'Shanghai', 'Suzhou', 'Changsha', 'Zhangjiajie', 'Chongqing', 'Chengdu', 'Guangzhou']) {
      fireEvent.click(screen.getByLabelText(`Remove ${leg}`));
      fireEvent.click(screen.getByRole('button', { name: 'Remove leg' }));
    }
    expect(screen.getByText(/Every leg has been removed/)).toBeTruthy();

    addCity('Osaka');
    // Falls back to the trip's own start date, since no leg is left to chain from.
    expect(within(legRow('Osaka')).getByText('7–8 Nov')).toBeTruthy();
  });
});

describe('setting nights by typing (ux review #3)', () => {
  it('accepts a typed number instead of ~20 taps', () => {
    open();
    fireEvent.change(nightsField('Suzhou'), { target: { value: '9' } });

    expect(nightsField('Suzhou').value).toBe('9');
    expect(screen.getByText('30 nights')).toBeTruthy();
    // Derived dates re-chain off the typed value like any other edit.
    expect(within(legRow('Changsha')).getByText('24–26 Nov')).toBeTruthy();
  });

  it('tolerates an empty field mid-edit without committing it as zero', () => {
    open();
    fireEvent.change(nightsField('Suzhou'), { target: { value: '' } });

    // The field shows empty, the model still holds 2 — clearing the box to
    // retype must not re-chain the whole trip through zero.
    expect(nightsField('Suzhou').value).toBe('');
    expect(screen.getByText('23 nights')).toBeTruthy();

    fireEvent.blur(nightsField('Suzhou'));
    expect(nightsField('Suzhou').value).toBe('2');
  });

  it('ignores junk, and rejects the keystroke that would exceed the maximum', () => {
    open();
    fireEvent.change(nightsField('Suzhou'), { target: { value: '4abc' } });
    expect(nightsField('Suzhou').value).toBe('4');

    // Not clamped to '30' — that would put a number in the box that the user
    // typed neither digit of. The over-cap keystroke simply doesn't register.
    fireEvent.change(nightsField('Suzhou'), { target: { value: '99' } });
    expect(nightsField('Suzhou').value).toBe('4');

    // The cap itself is still reachable: 3, then 0, are each within it.
    fireEvent.change(nightsField('Suzhou'), { target: { value: '3' } });
    fireEvent.change(nightsField('Suzhou'), { target: { value: '30' } });
    expect(nightsField('Suzhou').value).toBe('30');
  });

  it('strips a leading zero rather than showing it until blur', () => {
    open();
    fireEvent.change(nightsField('Suzhou'), { target: { value: '03' } });
    expect(nightsField('Suzhou').value).toBe('3');
  });
});

describe('announcements and feedback (ux review #2, #4)', () => {
  function status() {
    return document.querySelector('[role="status"]') as HTMLElement;
  }

  it('announces a typed nights change once, on blur, not per keystroke', () => {
    open();
    fireEvent.change(nightsField('Suzhou'), { target: { value: '1' } });
    fireEvent.change(nightsField('Suzhou'), { target: { value: '14' } });
    // Mid-typing: applied to the draft, but not yet announced — otherwise
    // "1 night" is read out on the way to "14 nights".
    expect(screen.getByText('35 nights')).toBeTruthy();
    expect(status()).toHaveTextContent('');

    fireEvent.blur(nightsField('Suzhou'));
    expect(status()).toHaveTextContent('Suzhou: 14 nights.');
  });

  it('announces a nights change, a reorder, an add and a removal', () => {
    open();
    fireEvent.click(screen.getByLabelText('One more night in Suzhou'));
    expect(status()).toHaveTextContent('Suzhou: 3 nights.');

    fireEvent.click(screen.getByLabelText('Move Suzhou earlier'));
    expect(status()).toHaveTextContent('Suzhou moved to position 2 of 8.');

    fireEvent.change(screen.getByLabelText('New city name'), { target: { value: 'Osaka' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(status()).toHaveTextContent('Osaka added to the end of the trip, 1 night.');

    fireEvent.click(screen.getByLabelText('Remove Osaka'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove leg' }));
    expect(status()).toHaveTextContent('Osaka removed.');
  });

  it('pulses the newly added leg, then stops', () => {
    vi.useFakeTimers();
    try {
      const { container } = open();
      fireEvent.change(screen.getByLabelText('New city name'), { target: { value: 'Osaka' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));

      expect(container.querySelector('.journey-leg.flash-confirm')).not.toBeNull();
      act(() => vi.advanceTimersByTime(900));
      expect(container.querySelector('.journey-leg.flash-confirm')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('re-dating a day trip', () => {
  it('bounds the date input to the days its parent actually has', () => {
    open();
    const chongqing = seed.trip.cities.find((c) => c.name === 'Chongqing')!;
    const input = screen.getByLabelText('Date of the Wulong day trip') as HTMLInputElement;
    expect(input.min).toBe(chongqing.arrive);
    expect(input.max).toBe(addDaysISO(chongqing.arrive, chongqing.nights - 1));
  });

  it('moves the day trip without moving anything else', () => {
    open();
    const chongqing = seed.trip.cities.find((c) => c.name === 'Chongqing')!;
    const target = addDaysISO(chongqing.arrive, 2); // the seed has it on day 2

    fireEvent.change(screen.getByLabelText('Date of the Wulong day trip'), {
      target: { value: target },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const saved = vi.mocked(useTripStore.getState().editJourney).mock.calls[0][0];
    expect(saved.find((c) => c.name === 'Wulong')?.arrive).toBe(target);
    // Every base leg is exactly where it was — the day trip consumes no
    // calendar, so re-dating it must not re-chain the trip.
    expect(saved.filter((c) => !c.parentCity).map((c) => `${c.name}:${c.arrive}`)).toEqual(
      seed.trip.cities.filter((c) => !c.parentCity).map((c) => `${c.name}:${c.arrive}`),
    );
  });
});

describe('saving', () => {
  it('does not persist anything until Save is pressed', () => {
    open();
    const editJourney = useTripStore.getState().editJourney;

    fireEvent.click(screen.getByLabelText('One fewer night in Shanghai'));
    fireEvent.click(screen.getByLabelText('One fewer night in Shanghai'));
    fireEvent.click(screen.getByLabelText('One more night in Suzhou'));

    // Three edits, zero writes — the whole reason the sheet holds a draft.
    expect(editJourney).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(editJourney).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(editJourney).mock.calls[0][0];
    expect(saved.find((c) => c.name === 'Shanghai')?.nights).toBe(4);
    expect(saved.find((c) => c.name === 'Suzhou')?.nights).toBe(3);
  });

  it('keeps Save disabled until something actually changes', () => {
    open();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('One more night in Suzhou'));
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(false);
  });

  it('discards the draft on Cancel, so reopening starts from the trip again', () => {
    const onClose = vi.fn();
    const { rerender } = render(<EditJourneyModal open onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('One fewer night in Shanghai'));
    expect(screen.getByText('22 nights')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();

    rerender(<EditJourneyModal open onClose={onClose} />);
    expect(screen.getByText('23 nights')).toBeTruthy();
  });

  it('keeps the sheet open with the draft intact when the save fails', async () => {
    resetStore({
      editJourney: vi.fn<TripState['editJourney']>().mockRejectedValue(new Error('Network is down')),
    });
    const onClose = vi.fn();
    render(<EditJourneyModal open onClose={onClose} />);

    fireEvent.click(screen.getByLabelText('One fewer night in Shanghai'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down');
    expect(onClose).not.toHaveBeenCalled();
    // The edit survives — retyping the whole journey is not a fair ask.
    expect(screen.getByText('22 nights')).toBeTruthy();
  });
});
