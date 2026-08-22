import { describe, expect, it } from 'vitest';
import { SETTLEMENT_EPSILON, computeSettlement, excludedCount } from './settlement';
import type { Expense, TripMember } from '../data/schema';

const ALEX: TripMember = { id: 'alex', name: 'Alex', color: 'm-denim' };
const PRIYA: TripMember = { id: 'priya', name: 'Priya' };
const SAM: TripMember = { id: 'sam', name: 'Sam' };

/** `rates[C]` = value of ONE unit of C in home currency (schema.ts convention).
 *  AUD is home, so it is 1; JPY is deliberately absent = "no known rate". */
const TRIP = { rates: { AUD: 1, CNY: 0.21 } };

let seq = 0;
function expense(partial: Partial<Expense>): Expense {
  seq += 1;
  return {
    id: `e${seq}`,
    tripId: 't1',
    category: 'Food',
    label: `Expense ${seq}`,
    amount: 0,
    currency: 'AUD',
    paid: true,
    ...partial,
  };
}

/** Sugar for the common case: paid, in home currency, covering everyone. */
function paidBy(who: string, amount: number, extra: Partial<Expense> = {}): Expense {
  return expense({ paidBy: who, amount, ...extra });
}

function netOf(balances: { member: TripMember; net: number }[], id: string): number {
  return balances.find((b) => b.member.id === id)!.net;
}

describe('computeSettlement — balances', () => {
  it('splits an everyone-covers expense evenly and credits the payer in full', () => {
    const s = computeSettlement([paidBy('alex', 300)], [ALEX, PRIYA, SAM], TRIP);

    expect(s.balances.map((b) => [b.member.id, b.paid, b.share, b.net])).toEqual([
      ['alex', 300, 100, 200],
      ['priya', 0, 100, -100],
      ['sam', 0, 100, -100],
    ]);
    expect(s.countedExpenses).toBe(1);
    expect(s.isSquare).toBe(false);
  });

  it('splits only across the members an expense explicitly covers', () => {
    // Alex fronts a room Priya and Sam share and Alex does not use.
    const s = computeSettlement(
      [paidBy('alex', 200, { coversMemberIds: ['priya', 'sam'] })],
      [ALEX, PRIYA, SAM],
      TRIP,
    );

    expect(netOf(s.balances, 'alex')).toBe(200);
    expect(netOf(s.balances, 'priya')).toBe(-100);
    expect(netOf(s.balances, 'sam')).toBe(-100);
  });

  it('converts every currency to home before comparing (never sums raw amounts)', () => {
    // 1000 CNY = A$210, split two ways.
    const s = computeSettlement(
      [paidBy('alex', 1000, { currency: 'CNY' })],
      [ALEX, PRIYA],
      TRIP,
    );

    expect(netOf(s.balances, 'alex')).toBeCloseTo(105, 6);
    expect(netOf(s.balances, 'priya')).toBeCloseTo(-105, 6);
  });

  it('leaves a member who paid nothing and was covered by nothing at zero', () => {
    const s = computeSettlement(
      [paidBy('alex', 100, { coversMemberIds: ['alex', 'priya'] })],
      [ALEX, PRIYA, SAM],
      TRIP,
    );

    expect(netOf(s.balances, 'sam')).toBe(0);
    expect(s.transfers.map((t) => [t.from.id, t.to.id, t.amount])).toEqual([['priya', 'alex', 50]]);
  });

  it('returns a row per member with no expenses at all', () => {
    const s = computeSettlement([], [ALEX, PRIYA], TRIP);

    expect(s.balances).toHaveLength(2);
    expect(s.isSquare).toBe(true);
    expect(s.transfers).toEqual([]);
    expect(s.totalToSettle).toBe(0);
  });

  it('handles a trip with no members without throwing', () => {
    const s = computeSettlement([paidBy('alex', 100)], [], TRIP);

    expect(s.balances).toEqual([]);
    expect(s.transfers).toEqual([]);
    expect(s.exclusions.orphanPayer).toBe(1);
  });
});

describe('computeSettlement — the rebalance', () => {
  it('nets offsetting expenses to square without anything being marked repaid', () => {
    // Alex fronts Priya's dinner; Priya later fronts Alex's train for the
    // same amount. Two debts pointing opposite ways cancel by construction.
    const s = computeSettlement(
      [
        paidBy('alex', 80, { coversMemberIds: ['priya'] }),
        paidBy('priya', 80, { coversMemberIds: ['alex'] }),
      ],
      [ALEX, PRIYA],
      TRIP,
    );

    expect(s.isSquare).toBe(true);
    expect(s.transfers).toEqual([]);
    expect(s.rawObligations).toBe(2);
  });

  it('rebalances to the remainder when the offsetting expense is smaller', () => {
    const s = computeSettlement(
      [
        paidBy('alex', 80, { coversMemberIds: ['priya'] }),
        paidBy('priya', 30, { coversMemberIds: ['alex'] }),
      ],
      [ALEX, PRIYA],
      TRIP,
    );

    expect(s.transfers.map((t) => [t.from.id, t.to.id, t.amount])).toEqual([['priya', 'alex', 50]]);
  });

  it('collapses a chain of IOUs into a single payment', () => {
    // Alex covers Priya 60; Priya covers Sam 60. Priya is square in the
    // middle — the answer is Sam pays Alex, and Priya is not involved.
    const s = computeSettlement(
      [
        paidBy('alex', 60, { coversMemberIds: ['priya'] }),
        paidBy('priya', 60, { coversMemberIds: ['sam'] }),
      ],
      [ALEX, PRIYA, SAM],
      TRIP,
    );

    expect(netOf(s.balances, 'priya')).toBe(0);
    expect(s.transfers.map((t) => [t.from.id, t.to.id, t.amount])).toEqual([['sam', 'alex', 60]]);
    expect(s.rawObligations).toBe(2);
  });

  it('never needs more than one fewer transfer than there are members', () => {
    const s = computeSettlement(
      [paidBy('alex', 300), paidBy('priya', 30), paidBy('sam', 60)],
      [ALEX, PRIYA, SAM],
      TRIP,
    );

    expect(s.transfers.length).toBeLessThanOrEqual(2);
    // Every transfer clears real debt, and the total moved equals what the
    // debtors collectively owe.
    const owed = s.balances.filter((b) => b.net < 0).reduce((sum, b) => sum - b.net, 0);
    expect(s.totalToSettle).toBeCloseTo(owed, 6);
  });

  it('leaves every balance at zero once the computed transfers are applied', () => {
    const s = computeSettlement(
      [
        paidBy('alex', 210),
        paidBy('priya', 45, { coversMemberIds: ['alex', 'sam'] }),
        paidBy('sam', 90, { coversMemberIds: ['priya'] }),
      ],
      [ALEX, PRIYA, SAM],
      TRIP,
    );

    const after = new Map(s.balances.map((b) => [b.member.id, b.net]));
    for (const t of s.transfers) {
      after.set(t.from.id, after.get(t.from.id)! + t.amount);
      after.set(t.to.id, after.get(t.to.id)! - t.amount);
    }
    for (const net of after.values()) expect(Math.abs(net)).toBeLessThanOrEqual(SETTLEMENT_EPSILON);
  });

  it('is stable under reordering of the expense list', () => {
    const list = [
      paidBy('alex', 210),
      paidBy('priya', 45, { coversMemberIds: ['alex', 'sam'] }),
      paidBy('sam', 90, { coversMemberIds: ['priya'] }),
    ];
    const forwards = computeSettlement(list, [ALEX, PRIYA, SAM], TRIP);
    const backwards = computeSettlement([...list].reverse(), [ALEX, PRIYA, SAM], TRIP);

    expect(backwards.transfers.map((t) => [t.from.id, t.to.id])).toEqual(
      forwards.transfers.map((t) => [t.from.id, t.to.id]),
    );
  });

  it('does not emit a transfer for a residue too small to display', () => {
    // A three-way split of A$100 leaves 0.33 of float residue per person.
    const s = computeSettlement(
      [paidBy('alex', 100), paidBy('priya', 100), paidBy('sam', 100.4)],
      [ALEX, PRIYA, SAM],
      TRIP,
    );

    expect(s.transfers).toEqual([]);
    expect(s.isSquare).toBe(true);
  });
});

describe('computeSettlement — exclusions', () => {
  it('excludes an unpaid expense: a planned cost is not money anyone is out', () => {
    const s = computeSettlement([paidBy('alex', 300, { paid: false })], [ALEX, PRIYA], TRIP);

    expect(s.exclusions.unpaid).toBe(1);
    expect(s.countedExpenses).toBe(0);
    expect(s.isSquare).toBe(true);
    expect(excludedCount(s.exclusions)).toBe(1);
  });

  it('excludes an expense with no payer rather than guessing one', () => {
    const s = computeSettlement([expense({ amount: 300 })], [ALEX, PRIYA], TRIP);

    expect(s.exclusions.noPayer).toBe(1);
    expect(s.balances.every((b) => b.net === 0)).toBe(true);
  });

  it('excludes an expense whose payer was removed from the companions list', () => {
    const s = computeSettlement([paidBy('ghost', 300)], [ALEX, PRIYA], TRIP);

    expect(s.exclusions.orphanPayer).toBe(1);
    expect(s.balances.every((b) => b.net === 0)).toBe(true);
  });

  it('excludes an expense in a currency with no rate rather than summing it as zero', () => {
    const s = computeSettlement([paidBy('alex', 30000, { currency: 'JPY' })], [ALEX, PRIYA], TRIP);

    expect(s.exclusions.noRate).toBe(1);
    expect(s.countedExpenses).toBe(0);
  });

  it('ignores covered ids that no longer resolve, splitting across the rest', () => {
    const s = computeSettlement(
      [paidBy('alex', 100, { coversMemberIds: ['priya', 'ghost'] })],
      [ALEX, PRIYA],
      TRIP,
    );

    expect(excludedCount(s.exclusions)).toBe(0);
    expect(netOf(s.balances, 'priya')).toBe(-100);
    expect(netOf(s.balances, 'alex')).toBe(100);
  });

  it('excludes an expense whose covered members have all been removed', () => {
    const s = computeSettlement(
      [paidBy('alex', 100, { coversMemberIds: ['ghost'] })],
      [ALEX, PRIYA],
      TRIP,
    );

    expect(s.exclusions.coversNobody).toBe(1);
    expect(s.balances.every((b) => b.net === 0)).toBe(true);
  });

  it('counts each excluded expense in exactly one bucket', () => {
    // Unpaid AND payerless AND unconvertible — the first check wins, so the
    // buckets stay a partition of the excluded set.
    const s = computeSettlement(
      [expense({ amount: 10, currency: 'JPY', paid: false })],
      [ALEX, PRIYA],
      TRIP,
    );

    expect(s.exclusions).toEqual({
      unpaid: 1,
      noPayer: 0,
      orphanPayer: 0,
      noRate: 0,
      coversNobody: 0,
    });
    expect(excludedCount(s.exclusions)).toBe(1);
  });

  it('keeps counting the expenses that do qualify alongside excluded ones', () => {
    const s = computeSettlement(
      [
        paidBy('alex', 100),
        paidBy('alex', 500, { paid: false }),
        paidBy('ghost', 500),
        expense({ amount: 500 }),
      ],
      [ALEX, PRIYA],
      TRIP,
    );

    expect(s.countedExpenses).toBe(1);
    expect(excludedCount(s.exclusions)).toBe(3);
    expect(s.transfers.map((t) => [t.from.id, t.to.id, t.amount])).toEqual([['priya', 'alex', 50]]);
  });
});
