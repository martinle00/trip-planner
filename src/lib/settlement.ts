// ============================================================================
// Settle-up: who owes whom, netted down to the fewest transfers.
//
// The Budget tab's "By person" card answers "who PAID what". That is not the
// same question as "who OWES what": a companion who paid nothing but was
// covered by every meal still owes money, and someone who fronted a hotel
// that only covered other people is owed all of it. This module answers the
// second question, from the same three fields the expense form already
// writes — `paidBy`, `coversMemberIds` and `amount`/`currency`.
//
// THE REBALANCE IS THE NETTING, and it is why this is a pure function of the
// current expense list rather than a stored ledger. If Alex fronts Priya's
// dinner and Priya later fronts Alex's train, those two debts cancel — not
// because anything was marked "repaid", but because each person's balance is
// (what they paid) minus (their share of what covered them), so an expense
// pointing the other way subtracts from the same number the first one added.
// Recomputing on every render is therefore the whole feature: adding an
// offsetting expense rebalances by construction, and there is no ledger that
// can drift out of step with the expenses it was derived from.
//
// RECORDING A REPAYMENT needs no special case here, which is the point of
// modelling it as `Expense.isTransfer` rather than a settlements table. A
// repayment is an ordinary expense whose payer is the debtor and whose single
// covered member is the creditor, so the formula above credits the debtor the
// full amount and charges the creditor the full amount — the pair moves to
// zero through the same arithmetic every other expense goes through. The only
// thing this module does differently with one is COUNT it separately, so the
// "N debts across M expenses" line doesn't call a hand-back a purchase.
//
// Everything here is in HOME currency (see `Trip.rates`' "live-convert"
// contract in data/schema.ts): the balances re-derive from whatever rates are
// currently stored, exactly like every other total on the Budget tab.
// ============================================================================

import type { Expense, ID, Trip, TripMember } from '../data/schema';
import { convert } from './exchangeRates';

/**
 * Balances below this magnitude (in home currency) count as square.
 *
 * Not float-dust tolerance — that would be ~1e-9. This is the display
 * resolution: the card renders whole home-currency units, so a residue under
 * half a unit is a row that reads "Alex owes Priya A$0". Anything the user
 * cannot see is not a debt worth printing, so it is folded away here rather
 * than filtered at render time, where "all square" and "no transfers to show"
 * would become two different states that look identical.
 */
export const SETTLEMENT_EPSILON = 0.5;

/** One member's position: what they put in, what they consumed, the difference. */
export interface SettlementBalance {
  member: TripMember;
  /** Home-currency total this member actually paid out. */
  paid: number;
  /** Home-currency total of their slice of every expense that covered them. */
  share: number;
  /**
   * `paid - share`. Positive = the group owes them (they are in credit);
   * negative = they owe the group. Within ±`SETTLEMENT_EPSILON` of zero
   * means square — use `isSquare` rather than testing `=== 0`.
   */
  net: number;
}

/** A single "pay this person this much" instruction. `amount` is always > 0. */
export interface SettlementTransfer {
  from: TripMember;
  to: TripMember;
  /** Home currency. */
  amount: number;
}

/**
 * Why an expense didn't feed the calculation. Buckets are MUTUALLY EXCLUSIVE
 * and tested in the order listed below, so the counts sum to exactly the
 * number of expenses left out — a partial split that silently dropped rows is
 * the failure mode this card has to avoid above all others, since the number
 * it prints is one someone is expected to act on and hand over money for.
 */
export interface SettlementExclusions {
  /** Not marked paid — a planned cost, so nobody has fronted anything yet. */
  unpaid: number;
  /** No `paidBy`: something was bought but nothing records who fronted it. */
  noPayer: number;
  /** `paidBy` no longer resolves to a current member (they were removed). */
  orphanPayer: number;
  /** No rate for the expense's currency — no comparable home-currency value. */
  noRate: number;
  /**
   * `coversMemberIds` resolves to nobody (every covered member was removed).
   * The form can't produce this — deselecting the last person snaps back to
   * "everyone" — but a hand-edited import or a later member removal can.
   */
  coversNobody: number;
}

export interface Settlement {
  /** One row per current member, in `Trip.members` order. */
  balances: SettlementBalance[];
  /** Fewest transfers that clear every balance. Empty when all square. */
  transfers: SettlementTransfer[];
  /**
   * Trip COSTS that fed the calculation — repayments are counted separately
   * in `settledTransfers`, because "3 debts across 4 expenses" must mean four
   * things the group bought, not three purchases and a hand-back.
   */
  countedExpenses: number;
  /**
   * Repayments (`Expense.isTransfer`) that fed the calculation — money already
   * handed between companions. They move the balances through exactly the same
   * arithmetic as any other expense, which is the whole reason a repayment
   * needs no special case: crediting the payer and charging the recipient
   * their full share IS clearing the debt.
   */
  settledTransfers: number;
  /**
   * Individual IOUs before netting: one per (counted expense × covered member
   * other than the payer). This is what `transfers.length` is compared
   * against to show the rebalance doing its job ("14 IOUs → 1 payment").
   */
  rawObligations: number;
  exclusions: SettlementExclusions;
  /** True when every balance is within `SETTLEMENT_EPSILON` of zero. */
  isSquare: boolean;
  /** Total that changes hands to settle — the sum of every transfer. */
  totalToSettle: number;
}

/** Members this expense is split across, in `members` order.
 *
 *  `coversMemberIds: undefined` means EVERYONE (the field's contract in
 *  schema.ts) — deliberately not the same as an empty array. Ids that no
 *  longer resolve are ignored rather than throwing, matching how every other
 *  reader treats this field. */
function coveredMembers(expense: Expense, members: TripMember[]): TripMember[] {
  const ids = expense.coversMemberIds;
  if (ids === undefined) return members;
  const wanted = new Set<ID>(ids);
  return members.filter((m) => wanted.has(m.id));
}

/**
 * Net every member's position down to the fewest payments that clear it.
 *
 * Greedy largest-debtor-pays-largest-creditor. For the handful of people on
 * one trip this is optimal in practice and always produces at most
 * `n - 1` transfers; the theoretically minimal answer is NP-hard (it needs
 * subset-sum to spot exact-matching groups) and the difference only shows up
 * at party sizes this app will never see.
 *
 * Ties are broken by member name then id so the instruction list is STABLE:
 * an unrelated edit elsewhere must not silently reshuffle who is told to pay
 * whom while someone is reading the card.
 */
function simplify(balances: SettlementBalance[]): SettlementTransfer[] {
  interface Side {
    member: TripMember;
    remaining: number;
  }
  const biggestFirst = (a: Side, b: Side) =>
    b.remaining - a.remaining ||
    a.member.name.localeCompare(b.member.name) ||
    a.member.id.localeCompare(b.member.id);

  const debtors: Side[] = balances
    .filter((b) => b.net < -SETTLEMENT_EPSILON)
    .map((b) => ({ member: b.member, remaining: -b.net }))
    .sort(biggestFirst);
  const creditors: Side[] = balances
    .filter((b) => b.net > SETTLEMENT_EPSILON)
    .map((b) => ({ member: b.member, remaining: b.net }))
    .sort(biggestFirst);

  const transfers: SettlementTransfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d];
    const creditor = creditors[c];
    const amount = Math.min(debtor.remaining, creditor.remaining);
    if (amount > SETTLEMENT_EPSILON) {
      transfers.push({ from: debtor.member, to: creditor.member, amount });
    }
    debtor.remaining -= amount;
    creditor.remaining -= amount;
    // Advance whichever side is now settled. Both, when they matched exactly
    // — otherwise the next round pairs a zeroed-out person with a real one
    // and emits a sub-epsilon transfer that only gets thrown away again.
    if (debtor.remaining <= SETTLEMENT_EPSILON) d += 1;
    if (creditor.remaining <= SETTLEMENT_EPSILON) c += 1;
  }
  return transfers;
}

/**
 * Compute who owes whom across a whole trip.
 *
 * Deliberately takes the FULL expense list, never the Budget tab's filtered
 * view: "pay Priya A$40" is an instruction someone acts on, and one derived
 * from the Chengdu-only subset is an instruction that is wrong to follow.
 * (Same exemption, for the same reason, that the rates card already has.)
 */
export function computeSettlement(
  expenses: Expense[],
  members: TripMember[],
  trip: Pick<Trip, 'rates'>,
): Settlement {
  const paidByMember = new Map<ID, number>();
  const shareByMember = new Map<ID, number>();
  for (const m of members) {
    paidByMember.set(m.id, 0);
    shareByMember.set(m.id, 0);
  }

  const exclusions: SettlementExclusions = {
    unpaid: 0,
    noPayer: 0,
    orphanPayer: 0,
    noRate: 0,
    coversNobody: 0,
  };
  let countedExpenses = 0;
  let settledTransfers = 0;
  let rawObligations = 0;

  for (const e of expenses) {
    // An unpaid expense is a planned cost, not money someone is out of
    // pocket for — settling against it would tell a companion to reimburse
    // a bill nobody has actually footed. Counted and surfaced, never
    // silently skipped: a trip logged without ever ticking "paid" must not
    // read as "all square".
    if (!e.paid) {
      exclusions.unpaid += 1;
      continue;
    }
    if (!e.paidBy) {
      exclusions.noPayer += 1;
      continue;
    }
    const payer = members.find((m) => m.id === e.paidBy);
    if (!payer) {
      exclusions.orphanPayer += 1;
      continue;
    }
    const converted = convert(e.amount, e.currency, trip);
    if (converted === undefined) {
      exclusions.noRate += 1;
      continue;
    }
    const covered = coveredMembers(e, members);
    if (covered.length === 0) {
      exclusions.coversNobody += 1;
      continue;
    }

    // A repayment moves money without the group having bought anything, so it
    // counts towards the balances but never towards the "N debts across M
    // expenses" framing — it is the thing that DISCHARGES a debt, not one that
    // creates one.
    if (e.isTransfer) settledTransfers += 1;
    else countedExpenses += 1;

    paidByMember.set(payer.id, (paidByMember.get(payer.id) ?? 0) + converted);
    const perHead = converted / covered.length;
    for (const m of covered) {
      shareByMember.set(m.id, (shareByMember.get(m.id) ?? 0) + perHead);
      // The payer's own slice is not an IOU — they already hold it.
      if (!e.isTransfer && m.id !== payer.id && perHead > SETTLEMENT_EPSILON) rawObligations += 1;
    }
  }

  const balances: SettlementBalance[] = members.map((member) => {
    const paid = paidByMember.get(member.id) ?? 0;
    const share = shareByMember.get(member.id) ?? 0;
    return { member, paid, share, net: paid - share };
  });

  const transfers = simplify(balances);
  return {
    balances,
    transfers,
    countedExpenses,
    settledTransfers,
    rawObligations,
    exclusions,
    isSquare: balances.every((b) => Math.abs(b.net) <= SETTLEMENT_EPSILON),
    totalToSettle: transfers.reduce((sum, t) => sum + t.amount, 0),
  };
}

/** Total number of expenses left out of the calculation, for the "N not
 *  counted" note. Sums every bucket — see `SettlementExclusions`. */
export function excludedCount(exclusions: SettlementExclusions): number {
  return (
    exclusions.unpaid +
    exclusions.noPayer +
    exclusions.orphanPayer +
    exclusions.noRate +
    exclusions.coversNobody
  );
}
