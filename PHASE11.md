# PHASE 11 — Settle up: who owes whom

Working notes for Phase 11. Read this before touching `lib/settlement.ts` or the
Budget tab's Settle-up card. Same structure as the other `PHASE*.md`: why, what
changed, decisions + rationale, traps.

> **STATUS: IMPLEMENTED.** `npm run build` clean, `npm run lint` clean (only the
> known `RouteStrip.tsx:13` warning), **756 tests green** (28 new: 21 in
> `lib/settlement.test.ts`, 7 in `BudgetPanel.test.tsx`).
> **No schema change, no migration, no repository change** — see decision 1.
> Rendered and checked in a real Chromium at 390px and 320px in both themes;
> not yet used on a real trip.

---

## Why

The Budget tab could say **who paid**, and could not say **who owes**. Those are
different questions, and only the second one is actionable:

- `By person` sums `Expense.paidBy`. A companion who has paid for nothing sits at
  `A$0` — which looks like "owes nothing" and means "is into everyone else for
  their share of every meal that covered them".
- `Expense.coversMemberIds` has existed since Phase 6 and **nothing read it** for
  a split. The data to answer "who owes whom" was already being collected and was
  never turned into an answer.

With expenses fronted by different people across a three-week trip, reconstructing
that by hand from a list of rows is exactly the arithmetic a computer should be
doing.

## What changed

- **`src/lib/settlement.ts`** — new, pure, no I/O. `computeSettlement(expenses,
  members, trip)` returns per-member balances, the minimal set of transfers, the
  counts behind them, and a mutually-exclusive breakdown of what it left out.
- **Budget tab: a `Settle up` card** below `By person`, above `All expenses`.
  Payment instructions, per-person balances with their working shown, and a gold
  note naming every expense that didn't qualify.
- `src/index.css` — a `.settle-*` block. No new tokens; the balances list reuses
  `.split-legend`/`.split-legend-row` from `By person` directly above it.

## Decisions and rationale

1. **A derived function, not a stored ledger — and that IS the "auto-rebalance".**
   The obvious shape for this feature is a debts table that gets written when an
   expense is added and amended when another one offsets it. Every balance here is
   instead recomputed from the expense list on every render, so:
   - Alex fronting Priya's dinner and Priya later fronting Alex's train **cancel by
     construction**. Each person's net is `(what they fronted) − (their share of
     what covered them)`, so an expense pointing the other way subtracts from the
     same number the first one added. Nothing is "marked repaid"; there is no
     rebalance step to forget to run.
   - There is no ledger that can drift out of step with the expenses it came from,
     nothing to migrate, and nothing new for the outbox to queue, replay or order
     (`sortForReplay` is untouched — this adds no entity).
   - Rates are live-converted like every other total on the tab, so a
     `refreshRates()` moves the balances too. Consistent with `Trip.rates`'
     documented "live-convert" model; **there is still no per-expense rate
     snapshot**, so a settled-up-yesterday balance can move today. Accepted: the
     alternative is a historical-rate feature this app has deliberately never had.

2. **Unpaid expenses are excluded, and that exclusion is loud.** `paid: false` is a
   planned cost — money nobody is out of pocket for. Settling against it tells a
   companion to reimburse a bill that has not been footed. The dangerous failure
   here is not a wrong number, it's **"All square" printed over a trip logged
   without ever ticking "paid"** — people walk away owing each other real money. So
   `countedExpenses === 0` renders *"Nothing to settle yet — N expenses not
   counted: …"* and can never render "All square".

3. **"Fronted", not "paid", in the balance rows.** A consequence of decision 2 that
   is visible on screen: `By person` sums every expense a member is named on,
   `Settle up` counts only the paid ones, so **the same person legitimately shows
   two different totals one card apart** (in testing: Alex `A$942` above,
   `fronted A$882` below). Reusing the word "paid" for both makes that read as a
   rendering bug. "Fronted" says money actually left this person's pocket, which is
   the only kind that can be owed back, and the gold note names the difference.

4. **Whole-trip, exempt from the filter bar.** Every other card on the tab rebases
   onto the filtered set and wears a `Filtered` tag. This one prints an instruction
   someone opens a banking app on, and "pay Priya A$40" derived from the
   Shanghai-only subset is an instruction that is *wrong to follow*. With a filter
   active it wears a `Whole trip` tag instead — the opposite claim, said out loud,
   because otherwise it looks exactly like another filtered subtotal. Same
   exemption the rates card already takes, for the same reason.

5. **Exclusion buckets are a partition.** `unpaid` / `noPayer` / `orphanPayer` /
   `noRate` / `coversNobody`, tested in that order, at most one per expense — so
   the counts sum to exactly the number left out. Each gets its own phrase rather
   than one lumped "N not counted", because the fixes are entirely different (tick
   "paid" vs. name a payer vs. wait for a rate). A card that quietly drops a bill is
   worse than one that shows nothing.

6. **Greedy netting, not optimal netting.** Largest debtor pays largest creditor.
   Always ≤ `n − 1` transfers and optimal in practice at trip sizes; the truly
   minimal answer needs subset-sum (NP-hard) to spot exact-matching groups, and the
   difference only appears at party sizes this app will never see.

7. **`SETTLEMENT_EPSILON = 0.5`, and it is display resolution, not float dust.**
   The card renders whole home-currency units, so a residue under half a unit is a
   row reading "Alex owes Priya A$0". Folding it away inside the lib (rather than
   filtering at render time) is what keeps "all square" and "no transfers to show"
   from being two states that look identical.

8. **Payment rows carry no bar.** Everything else on this tab encodes magnitude as
   width. A debt of `A$120` drawn twice as wide as one of `A$60` invites comparing
   debts *to each other*, when the only thing that matters per row is its own
   figure. Boxed, evenly-weighted list items instead.

9. **Orphan tolerance is unchanged from `schema.ts`.** An unresolvable id in
   `coversMemberIds` is ignored and the expense still splits across whoever is
   left; an unresolvable `paidBy` excludes the expense (there is no one to credit).
   Nothing here rewrites or cascade-deletes a dangling reference.

## Traps

- **Do not "fix" the two cards disagreeing about what a person paid.** It is
  decision 3, on purpose. Making the numbers match means either settling against
  unpaid bills (decision 2) or changing what `By person` reports.
- **Do not switch the memo to `visibleExpenses`.** It reads like an oversight next
  to every other memo on the tab, and it is decision 4. The `Whole trip` tag is the
  paired half of that choice — removing one without the other is the actual bug.
- **Ties in `simplify()` are broken by member name then id, deliberately.** The
  instruction list has to be stable: an unrelated edit elsewhere must not reshuffle
  who is told to pay whom while someone is reading the card.
- **`.split-legend-row` is now used by two cards.** `index.css` already warns that
  `.cat-label`/`.cat-amt` are descendant-scoped and every row-shaped widget must be
  added to those selector lists; the balances list relies on that having been done.

## Not done / possible next

- **Recording a repayment.** Nothing marks a transfer as *made* — the card
  describes the current position and the user settles it outside the app. There is
  a zero-schema-change trick available if this is ever wanted: a settlement payment
  is just an expense paid by the debtor covering only the creditor, which nets the
  pair to zero. It is not implemented because it would also add the repayment to
  the trip's spend total, and a transfer between companions is not a trip cost.
- **Uneven splits.** Every split is per-head across the covered members; there are
  no shares/weights, and `coversMemberIds` cannot express one.
- **Settling in a currency other than home.** Transfers are always home-currency.
