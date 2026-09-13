import { describe, expect, it } from 'vitest';
import { buildSeed } from '../data/seed';
import type { City, Day, Expense, ItineraryItem, Place } from '../data/schema';
import { addDaysISO } from './dates';
import {
  addLeg,
  baseLegs,
  buildTargetDays,
  chainLegDates,
  moveLeg,
  planJourneyEdit,
  reconcileDaysToCities,
  dayTripDateRange,
  legNameError,
  recompactOrder,
  removeLeg,
  setDayTripDate,
  setLegNights,
  setTripStart,
  totalNights,
  tripSpan,
} from './journey';

const seed = buildSeed();
const CITIES = seed.trip.cities;
const DAYS = seed.days;

function idFactory() {
  let n = 0;
  return () => `new-${++n}`;
}

/** The leg a day belongs to, day trips included — mirrors `daysForLeg`. */
function legOf(day: Day): string {
  return day.parentCity ?? day.city;
}

function apply(diff: ReturnType<typeof reconcileDaysToCities>, existing: Day[]): Day[] {
  const deleted = new Set(diff.delete.map((d) => d.id));
  const updated = new Map(diff.update.map((d) => [d.id, d]));
  return [...existing.filter((d) => !deleted.has(d.id)).map((d) => updated.get(d.id) ?? d), ...diff.create]
    .sort((a, b) => a.date.localeCompare(b.date));
}

describe('leg chaining', () => {
  it('reproduces the seed dates from the seed leg list', () => {
    // The seed is the reference layout: contiguous base legs, day trips
    // pinned inside their parent. Re-chaining it must be a no-op.
    expect(chainLegDates(CITIES, '2026-11-07')).toEqual(CITIES);
  });

  it('shifts the whole trip when the start date moves', () => {
    const next = setTripStart(CITIES, '2026-11-10');
    expect(tripSpan(next, '2026-11-10')).toEqual({ startDate: '2026-11-10', endDate: '2026-12-03' });
    // Every leg moves by the same delta, day trips included.
    expect(next.find((c) => c.name === 'Wulong')?.arrive).toBe('2026-11-24');
    expect(totalNights(next)).toBe(totalNights(CITIES));
  });

  it('re-chains only from the edited leg onward', () => {
    const next = setLegNights(CITIES, 'Shanghai', 4);
    expect(next.find((c) => c.name === 'Singapore')?.arrive).toBe('2026-11-07');
    expect(next.find((c) => c.name === 'Shanghai')?.depart).toBe('2026-11-13');
    expect(next.find((c) => c.name === 'Suzhou')?.arrive).toBe('2026-11-13');
    expect(tripSpan(next, '2026-11-07').endDate).toBe('2026-11-28');
  });

  it('keeps a day trip at its offset into the parent, not its absolute date', () => {
    // Wulong sits on Chongqing's 2nd day (20th arrive, 21st day-trip).
    const next = setLegNights(CITIES, 'Shanghai', 4);
    const chongqing = next.find((c) => c.name === 'Chongqing');
    const wulong = next.find((c) => c.name === 'Wulong');
    expect(chongqing?.arrive).toBe('2026-11-18');
    expect(wulong?.arrive).toBe('2026-11-19');
  });

  it('clamps a day trip into a parent that shrank underneath it', () => {
    // Shenzhen is on Guangzhou's 3rd day; cut Guangzhou to 2 nights.
    const next = setLegNights(CITIES, 'Guangzhou', 2);
    const guangzhou = next.find((c) => c.name === 'Guangzhou');
    const shenzhen = next.find((c) => c.name === 'Shenzhen');
    expect(shenzhen?.arrive).toBe('2026-11-26');
    expect(shenzhen!.arrive >= guangzhou!.arrive).toBe(true);
    expect(shenzhen!.arrive < guangzhou!.depart).toBe(true);
  });
});

describe('leg operations', () => {
  it('removes a leg, its day trips, and shortens the trip', () => {
    const next = removeLeg(CITIES, 'Chongqing');
    expect(next.map((c) => c.name)).not.toContain('Chongqing');
    expect(next.map((c) => c.name)).not.toContain('Wulong');
    expect(totalNights(next)).toBe(totalNights(CITIES) - 3);
    expect(tripSpan(next, '2026-11-07')).toEqual({ startDate: '2026-11-07', endDate: '2026-11-27' });
  });

  it('removes a day trip on its own without touching its parent', () => {
    const next = removeLeg(CITIES, 'Wulong');
    expect(next.map((c) => c.name)).toContain('Chongqing');
    expect(totalNights(next)).toBe(totalNights(CITIES));
  });

  it('preserves the trip start date when the FIRST leg is removed', () => {
    const next = removeLeg(CITIES, 'Singapore');
    // Shanghai moves up to the 7th; the trip gets shorter, it does not start later.
    expect(next.find((c) => c.name === 'Shanghai')?.arrive).toBe('2026-11-07');
    expect(tripSpan(next, '2026-11-07').startDate).toBe('2026-11-07');
    expect(totalNights(next)).toBe(totalNights(CITIES) - 2);
  });

  it('reorders base legs and drags day trips along with their parent', () => {
    const next = moveLeg(CITIES, 'Chengdu', 1);
    const names = next.filter((c) => !c.parentCity).map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['Singapore', 'Chengdu', 'Shanghai']);
    // Wulong still sits immediately after Chongqing, and inside it.
    const ordered = [...next].sort((a, b) => a.order - b.order).map((c) => c.name);
    expect(ordered[ordered.indexOf('Chongqing') + 1]).toBe('Wulong');
    const chongqing = next.find((c) => c.name === 'Chongqing')!;
    const wulong = next.find((c) => c.name === 'Wulong')!;
    expect(wulong.arrive >= chongqing.arrive && wulong.arrive < chongqing.depart).toBe(true);
    expect(totalNights(next)).toBe(totalNights(CITIES));
    expect(tripSpan(next, '2026-11-07').endDate).toBe('2026-11-30');
  });

  it('recompacts order contiguously from 1', () => {
    const next = recompactOrder(removeLeg(CITIES, 'Suzhou'));
    expect(next.map((c) => c.order)).toEqual(next.map((_, i) => i + 1));
  });
});

describe('addLeg', () => {
  it('appends the leg, chained onto the end of the trip', () => {
    const next = addLeg(CITIES, 'Hong Kong', 3, seed.trip.startDate);
    const added = next.find((c) => c.name === 'Hong Kong')!;
    const last = baseLegs(CITIES)[baseLegs(CITIES).length - 1];

    expect(added.arrive).toBe(last.depart);
    expect(added.depart).toBe(addDaysISO(last.depart, 3));
    expect(added.nights).toBe(3);
    expect(added.parentCity).toBeUndefined();
    // It is last in order, and nothing before it moved.
    expect(baseLegs(next).at(-1)!.name).toBe('Hong Kong');
    expect(tripSpan(next, seed.trip.startDate).startDate).toBe(tripSpan(CITIES, seed.trip.startDate).startDate);
    expect(totalNights(next)).toBe(totalNights(CITIES) + 3);
  });

  it('produces days for the new leg without disturbing the existing ones', () => {
    const next = addLeg(CITIES, 'Hong Kong', 2, seed.trip.startDate);
    const diff = reconcileDaysToCities(next, DAYS, seed.trip.id, idFactory());

    expect(diff.delete).toEqual([]);
    expect(diff.update).toEqual([]);
    expect(diff.create.map((d) => d.city)).toEqual(['Hong Kong', 'Hong Kong']);
  });

  it('rebuilds from empty using the fallback start', () => {
    const next = addLeg([], 'Osaka', 4, '2026-11-07');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: 'Osaka', order: 1, nights: 4, arrive: '2026-11-07', depart: '2026-11-11' });
  });

  it('trims the name and refuses a duplicate, whatever its case or padding', () => {
    expect(addLeg(CITIES, '  Hong Kong  ', 1, seed.trip.startDate).find((c) => c.name === 'Hong Kong')).toBeTruthy();

    // The name is the key `Day.city`/`Place.city` match on, so a second
    // "Shanghai" would silently share the first one's pool of days.
    for (const dupe of ['Shanghai', 'shanghai', ' SHANGHAI ', 'Wulong']) {
      expect(addLeg(CITIES, dupe, 1, seed.trip.startDate)).toEqual(CITIES);
      expect(legNameError(CITIES, dupe)).toMatch(/already on this trip/);
    }
    expect(addLeg(CITIES, '   ', 1, seed.trip.startDate)).toEqual(CITIES);
    expect(legNameError(CITIES, '  ')).toMatch(/Give the city a name/);
    expect(legNameError(CITIES, 'Hong Kong')).toBeNull();
  });

  it('re-adopts the places a removed leg left behind', () => {
    const without = removeLeg(CITIES, 'Chongqing');
    const readded = addLeg(without, 'Chongqing', 3, seed.trip.startDate);
    const plan = planJourneyEdit({
      nextCities: readded,
      tripId: seed.trip.id,
      days: DAYS,
      places: seed.places,
      itinerary: [],
      expenses: [],
      newId: idFactory(),
    });
    // The Chongqing place was never deleted, so putting the leg back takes it
    // out of "Not on this trip" again. (Wulong stays orphaned — its day-trip
    // leg went with its parent and wasn't re-added.)
    expect(plan.orphanedPlaces.map((p) => p.city)).not.toContain('Chongqing');
  });
});

describe('setDayTripDate', () => {
  const wulong = () => CITIES.find((c) => c.name === 'Wulong')!;
  const chongqing = () => CITIES.find((c) => c.name === 'Chongqing')!;

  it('moves the day trip within its parent and keeps it one day long', () => {
    const target = chongqing().arrive;
    const next = setDayTripDate(CITIES, 'Wulong', target);
    const moved = next.find((c) => c.name === 'Wulong')!;
    expect(moved.arrive).toBe(target);
    expect(moved.nights).toBe(0);
    expect(moved.depart).toBe(addDaysISO(target, 1));
    // The parent — and every other leg — is untouched: a day trip consumes no
    // calendar, so re-dating one must not shift the trip.
    expect(next.filter((c) => !c.parentCity)).toEqual(CITIES.filter((c) => !c.parentCity));
  });

  it('clamps a date outside the parent onto the nearest day it has', () => {
    const parent = chongqing();
    const last = addDaysISO(parent.arrive, parent.nights - 1);
    expect(setDayTripDate(CITIES, 'Wulong', '2026-12-25').find((c) => c.name === 'Wulong')!.arrive).toBe(last);
    expect(setDayTripDate(CITIES, 'Wulong', '2020-01-01').find((c) => c.name === 'Wulong')!.arrive).toBe(parent.arrive);
  });

  // The reason clamping exists at all: an out-of-span day trip is dropped by
  // buildTargetDays with no error, so it would silently leave the itinerary.
  it('always leaves the day trip somewhere buildTargetDays will keep it', () => {
    for (const date of ['2020-01-01', '2026-12-25', chongqing().arrive]) {
      const next = setDayTripDate(CITIES, 'Wulong', date);
      expect(buildTargetDays(next).some((t) => t.city === 'Wulong')).toBe(true);
    }
  });

  it('ignores a base leg and an unknown name', () => {
    expect(setDayTripDate(CITIES, 'Chongqing', '2026-11-20')).toEqual(CITIES);
    expect(setDayTripDate(CITIES, 'Atlantis', '2026-11-20')).toEqual(CITIES);
  });

  it('offers exactly the parent’s days as the allowed range', () => {
    const parent = chongqing();
    expect(dayTripDateRange(parent)).toEqual({
      min: parent.arrive,
      max: addDaysISO(parent.arrive, parent.nights - 1),
    });
    // A leg with no nights left has no day to host anything; the range
    // collapses to a single date rather than inverting.
    expect(dayTripDateRange({ ...parent, nights: 0 })).toEqual({
      min: parent.arrive,
      max: parent.arrive,
    });
  });

  it('survives the round trip through a nights change', () => {
    const onDayTwo = setDayTripDate(CITIES, 'Wulong', addDaysISO(chongqing().arrive, 1));
    // Shortening an EARLIER leg shifts Chongqing; the day trip keeps its
    // offset into the parent rather than its absolute date.
    const shifted = setLegNights(onDayTwo, baseLegs(onDayTwo)[0].name, 1);
    const parent = shifted.find((c) => c.name === 'Chongqing')!;
    expect(shifted.find((c) => c.name === 'Wulong')!.arrive).toBe(addDaysISO(parent.arrive, 1));
    expect(wulong().name).toBe('Wulong'); // the seed itself was never mutated
  });
});

describe('buildTargetDays', () => {
  it('reproduces the seed day layout', () => {
    const targets = buildTargetDays(CITIES);
    expect(targets).toHaveLength(DAYS.length);
    expect(targets.map((t) => `${t.date}:${t.city}:${t.parentCity ?? '-'}`)).toEqual(
      [...DAYS]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((d) => `${d.date}:${d.city}:${d.parentCity ?? '-'}`),
    );
  });

  it('drops a day trip whose date falls outside its parent', () => {
    const stray: City[] = CITIES.map((c) =>
      c.name === 'Wulong' ? { ...c, arrive: '2026-12-25', depart: '2026-12-26' } : c,
    );
    const targets = buildTargetDays(stray);
    expect(targets.some((t) => t.city === 'Wulong')).toBe(false);
    // The parent keeps a full complement of its own days rather than a hole.
    expect(targets.filter((t) => t.city === 'Chongqing')).toHaveLength(3);
  });
});

describe('reconcileDaysToCities — id stability is the whole point', () => {
  it('is a no-op against the days the leg list already produced', () => {
    const diff = reconcileDaysToCities(CITIES, DAYS, seed.trip.id, idFactory());
    expect(diff).toEqual({ create: [], update: [], delete: [] });
  });

  it('shortening a leg deletes only that leg\'s trailing days', () => {
    const next = setLegNights(CITIES, 'Shanghai', 4);
    const diff = reconcileDaysToCities(next, DAYS, seed.trip.id, idFactory());
    expect(diff.create).toEqual([]);
    expect(diff.delete).toHaveLength(2);
    expect(diff.delete.every((d) => d.city === 'Shanghai')).toBe(true);
    // The two dropped days are the LAST two of the leg, not the first.
    expect(diff.delete.map((d) => d.date).sort()).toEqual(['2026-11-13', '2026-11-14']);
  });

  it('keeps every surviving day\'s id when later legs shift', () => {
    const next = setLegNights(CITIES, 'Shanghai', 4);
    const diff = reconcileDaysToCities(next, DAYS, seed.trip.id, idFactory());
    const deleted = new Set(diff.delete.map((d) => d.id));
    const survivors = DAYS.filter((d) => !deleted.has(d.id));
    const result = apply(diff, DAYS);
    // Not one new id: every remaining day is an existing row that moved date.
    expect(result.map((d) => d.id).sort()).toEqual(survivors.map((d) => d.id).sort());
    // ...and they did move — this is exactly the case a date-keyed match would
    // have destroyed by deleting and recreating all of them.
    expect(diff.update.length).toBeGreaterThan(0);
  });

  it('preserves the day trip\'s own identity when it slides within its parent', () => {
    const wulongDay = DAYS.find((d) => d.city === 'Wulong')!;
    const next = CITIES.map((c) =>
      c.name === 'Wulong' ? { ...c, arrive: '2026-11-22', depart: '2026-11-23' } : c,
    );
    const diff = reconcileDaysToCities(next, DAYS, seed.trip.id, idFactory());
    expect(diff.create).toEqual([]);
    expect(diff.delete).toEqual([]);
    const moved = diff.update.find((d) => d.id === wulongDay.id);
    expect(moved).toMatchObject({ date: '2026-11-22', city: 'Wulong', parentCity: 'Chongqing' });
  });

  it('removing a leg deletes exactly its days, day trips included', () => {
    const next = removeLeg(CITIES, 'Chongqing');
    const diff = reconcileDaysToCities(next, DAYS, seed.trip.id, idFactory());
    expect(diff.create).toEqual([]);
    expect(new Set(diff.delete.map(legOf))).toEqual(new Set(['Chongqing']));
    expect(diff.delete).toHaveLength(3);
    expect(apply(diff, DAYS)).toHaveLength(DAYS.length - 3);
  });

  it('lengthening a leg creates only the new days', () => {
    const next = setLegNights(CITIES, 'Suzhou', 4);
    const diff = reconcileDaysToCities(next, DAYS, seed.trip.id, idFactory());
    expect(diff.delete).toEqual([]);
    expect(diff.create).toHaveLength(2);
    expect(diff.create.every((d) => d.city === 'Suzhou')).toBe(true);
    expect(diff.create.map((d) => d.id)).toEqual(['new-1', 'new-2']);
  });

  it('reordering legs renames no day and creates none', () => {
    const next = moveLeg(CITIES, 'Chengdu', 1);
    const diff = reconcileDaysToCities(next, DAYS, seed.trip.id, idFactory());
    expect(diff.create).toEqual([]);
    expect(diff.delete).toEqual([]);
    expect(apply(diff, DAYS).map((d) => d.id).sort()).toEqual(DAYS.map((d) => d.id).sort());
  });

  it('shorten-then-relengthen leaves the untouched days alone and the new ones empty', () => {
    const shortened = setLegNights(CITIES, 'Shanghai', 4);
    const firstDiff = reconcileDaysToCities(shortened, DAYS, seed.trip.id, idFactory());
    const afterCut = apply(firstDiff, DAYS);

    const restored = setLegNights(shortened, 'Shanghai', 6);
    const secondDiff = reconcileDaysToCities(restored, afterCut, seed.trip.id, idFactory());
    expect(secondDiff.delete).toEqual([]);
    expect(secondDiff.create).toHaveLength(2);
    // The four days that were never removed kept their original ids — and
    // therefore their stops — across both edits.
    const finalDays = apply(secondDiff, afterCut);
    const keptShanghai = finalDays.filter((d) => d.city === 'Shanghai' && !d.id.startsWith('new-'));
    expect(keptShanghai).toHaveLength(4);
    expect(keptShanghai.map((d) => d.id)).toEqual(
      DAYS.filter((d) => d.city === 'Shanghai').slice(0, 4).map((d) => d.id),
    );
  });

  it('produces days for a trip that had none yet', () => {
    const diff = reconcileDaysToCities(CITIES, [], seed.trip.id, idFactory());
    expect(diff.create).toHaveLength(DAYS.length);
    expect(diff.delete).toEqual([]);
  });
});

describe('planJourneyEdit — the cascade', () => {
  const tripId = seed.trip.id;
  const chongqingDays = DAYS.filter((d) => legOf(d) === 'Chongqing');

  const places: Place[] = [
    {
      id: 'p-hongya', tripId, name: 'Hongya Cave', city: 'Chongqing', lat: 29.56, lng: 106.57,
      status: 'planned', dayId: chongqingDays[0].id, updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'p-wishlist', tripId, name: 'Ciqikou', city: 'Chongqing', lat: 29.58, lng: 106.45,
      status: 'wishlist', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'p-bund', tripId, name: 'The Bund', city: 'Shanghai', lat: 31.23, lng: 121.49,
      status: 'planned', dayId: DAYS.find((d) => d.city === 'Shanghai')!.id,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const itinerary: ItineraryItem[] = [
    { id: 'i-1', dayId: chongqingDays[0].id, placeId: 'p-hongya', title: 'Hongya Cave', order: 0 },
    { id: 'i-2', dayId: chongqingDays[1].id, title: 'Hotpot', order: 0 },
    { id: 'i-3', dayId: DAYS.find((d) => d.city === 'Shanghai')!.id, placeId: 'p-bund', title: 'The Bund', order: 0 },
  ];
  const expenses: Expense[] = [
    { id: 'e-1', tripId, category: 'Food', label: 'Hotpot', amount: 200, currency: 'CNY', paid: true, city: 'Chongqing' },
    { id: 'e-2', tripId, category: 'Transport', label: 'Flights', amount: 1200, currency: 'AUD', paid: true },
  ];

  function planRemoval(name: string) {
    return planJourneyEdit({
      nextCities: removeLeg(CITIES, name), tripId, days: DAYS, places, itinerary, expenses,
      newId: idFactory(),
    });
  }

  it('deletes the stops on every deleted day', () => {
    const plan = planRemoval('Chongqing');
    expect(plan.itineraryToDelete.map((i) => i.id).sort()).toEqual(['i-1', 'i-2']);
  });

  it('unassigns places that lost their day, and leaves the rest alone', () => {
    const plan = planRemoval('Chongqing');
    expect(plan.placesToUnassign).toHaveLength(1);
    expect(plan.placesToUnassign[0]).toMatchObject({
      id: 'p-hongya', dayId: undefined, status: 'wishlist',
    });
    // The Shanghai place keeps its assignment; the wishlist one never had one.
    expect(plan.placesToUnassign.map((p) => p.id)).not.toContain('p-bund');
  });

  it('orphans rather than deletes places and expenses in a removed city', () => {
    const plan = planRemoval('Chongqing');
    expect(plan.orphanedPlaces.map((p) => p.id).sort()).toEqual(['p-hongya', 'p-wishlist']);
    expect(plan.orphanedExpenses.map((e) => e.id)).toEqual(['e-1']);
    // "Whole trip" expenses have no city and are never orphaned.
    expect(plan.orphanedExpenses.map((e) => e.id)).not.toContain('e-2');
  });

  it('moves a place that still has a stop on a surviving day onto that day, instead of unassigning it', () => {
    const shanghaiDayId = DAYS.find((d) => d.city === 'Shanghai')!.id;
    const alsoOnShanghai: ItineraryItem[] = [
      ...itinerary,
      { id: 'i-4', dayId: shanghaiDayId, placeId: 'p-hongya', title: 'Hongya', order: 1 },
    ];
    const plan = planJourneyEdit({
      nextCities: removeLeg(CITIES, 'Chongqing'), tripId, days: DAYS, places,
      itinerary: alsoOnShanghai, expenses, newId: idFactory(),
    });
    expect(plan.placesToUnassign).toHaveLength(1);
    expect(plan.placesToUnassign[0]).toMatchObject({ id: 'p-hongya', dayId: shanghaiDayId, status: 'planned' });
  });

  it('touches nothing when the edit adds days', () => {
    const plan = planJourneyEdit({
      nextCities: setLegNights(CITIES, 'Suzhou', 4), tripId, days: DAYS, places, itinerary,
      expenses, newId: idFactory(),
    });
    expect(plan.itineraryToDelete).toEqual([]);
    expect(plan.placesToUnassign).toEqual([]);
    expect(plan.orphanedPlaces).toEqual([]);
    expect(plan.days.create).toHaveLength(2);
  });
});
