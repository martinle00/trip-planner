# PHASE 11 — Settle up: who owes whom

Working notes for Phase 11. Read this before touching `lib/settlement.ts` or the
Budget tab's Settle-up card. Same structure as the other `PHASE*.md`: why, what
changed, decisions + rationale, traps.

> **STATUS: IMPLEMENTED**, in two parts — the read-only settlement first, then
> **recording a repayment** (`Expense.isTransfer`) as a follow-up. `npm run build`
> clean, `npm run lint` clean (only the known `RouteStrip.tsx:13` warning),
> **775 tests green**. Rendered and checked in a real Chromium at 390px and 320px
> in both themes; not yet used on a real trip.
>
> ⚠️ **`supabase/migrations/0008_expense_transfers.sql` has NOT been applied to the
> live project.** Until it is, `upsertExpense` fails on the missing `is_transfer`
> column — a hard error, *not* something the outbox will queue. Same posture as
> `0007`; see the CLAUDE.md note.

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

4. **Two modes: whole-trip and actionable, or filtered and read-only.** *(Revised —
   the card was originally exempt from the filter bar entirely; see "Following the
   filter" below for what replaced that and why the original reasoning survives it.)*
   With no filter it reads `expenses`, wears no tag, and offers `Mark paid` plus the
   `Already settled` strip. With any filter on it rebases onto `visibleExpenses`,
   wears the ordinary `Filtered` tag, names its scope in the heading — and withholds
   both of those controls. The original danger was never *showing* a scoped figure;
   it was showing one that looks exactly like the real one next to a button that
   acts on it.

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
- **Do not re-enable `Mark paid` in the scoped mode.** The memo now switches between
  `expenses` and `visibleExpenses` (decision 4), and the withheld button is what pays
  for that. A repayment carries `category: 'Repayment'` and no city, so it falls out
  of every filter that could have produced the debt it cleared: recording one from a
  Food-only view would leave that view still demanding the money just handed over,
  and the second payment looks entirely justified to whoever makes it. Making a
  per-category settlement actionable means the repayment has to carry the scope it
  settles — a schema change, not a UI one.
- **Ties in `simplify()` are broken by member name then id, deliberately.** The
  instruction list has to be stable: an unrelated edit elsewhere must not reshuffle
  who is told to pay whom while someone is reading the card.
- **`.split-legend-row` is now used by two cards.** `index.css` already warns that
  `.cat-label`/`.cat-amt` are descendant-scoped and every row-shaped widget must be
  added to those selector lists; the balances list relies on that having been done.

---

## Part 2 — Recording a repayment (`Expense.isTransfer`)

Part 1 could only ever *describe* the position: you settled up in a banking app and
the card went on saying "Sam pays Alex A$317" until an offsetting expense happened
to cancel it. Each settle row now carries **Mark paid**.

### What changed

- **`Expense.isTransfer?: boolean`** (schema.ts) — snapshot **v5 → v6**, purely
  additive, no per-record transform (`migrateSnapshotV5ToV6`).
- **`supabase/migrations/0008_expense_transfers.sql`** — `is_transfer boolean not
  null default false`, plus the whole `import_trip_snapshot` body carried forward
  again (0002/0003/0004 all flag that `create or replace` hazard).
- **No Dexie version bump.** `isTransfer` isn't indexed, and `.stores()` only
  declares indexed fields — absent already reads as "ordinary expense". This is the
  first expense-field change in the project's history that needed *no* local
  migration; every earlier one is a `version(n).upgrade()` in `db.ts`.
- Budget tab: a `costExpenses` choke point, the **Mark paid** button, and an
  **Already settled** strip.

### Decisions and rationale

1. **A flag on `Expense`, not a `settlements` table.** A repayment is shaped
   exactly like an expense — payer in `paidBy`, recipient as the single entry in
   `coversMemberIds`, amount in home currency, `paid: true` — so it rides the
   repository, outbox, sync, replay-ordering and export/import paths *unchanged*.
   No new entity to queue, order or write RLS for; marking a debt paid works
   offline for free. A table would have cost all of that for the same result.

2. **It needs no special case in the settlement maths, and that is the point.**
   Crediting the payer the full amount and charging the recipient the full amount
   *is* clearing the debt, through the ordinary balance formula. `settlement.ts`
   does exactly one thing differently with a transfer: **counts it separately**, so
   "N debts across M expenses" doesn't call a hand-back a purchase.

3. **A transfer is not spending — enforced at ONE choke point.** `costExpenses` in
   `BudgetPanel` feeds the trip total, paid/to-pay, By-category, By-person, the
   per-currency subtotals, the filter counts and the expense list. Filtering in each
   total separately is how one of them gets missed and the trip's spend silently
   inflates by the size of every debt settled. A new total added later inherits the
   rule instead of having to remember it.

4. **Rounded to CENTS, not to the whole units the card displays.** Whole units look
   obvious — the button sits next to "A$317" — and are wrong: the residue from each
   rounding lands on the *same* creditor, so two companions settling A$33.33 apiece
   accumulate 0.67, clear `SETTLEMENT_EPSILON`, and leave the card nagging about a
   A$1 debt nobody owes. Caught by a test written specifically for it, which also
   pins the whole-unit behaviour as the counter-example. Cents are also what a bank
   transfer can actually carry, and `fmtMoney` rounds the display anyway.

5. **Repayments are absent from "All expenses", so the history strip is the only
   undo.** A hand-back is not a cost and must not sit in a list of costs — which
   makes the `Already settled` strip the sole place one is visible, and therefore
   the sole place one can be reversed. A mis-recorded repayment would otherwise be
   unreachable while silently holding a real debt at zero.

6. **"Mark paid", not "Pay".** The app moves no money and must not imply it did.

### Traps

- **The empty state tests `settledTransfers` as well as `countedExpenses`.** A
  repayment on its own genuinely moves the balances (it credits one person and
  charges another). Testing `countedExpenses` alone renders "nothing to settle"
  over a real imbalance *and* strands the only control that could undo it.
- **`expenseFromRow` maps `false` → `undefined`, deliberately.** The column is
  `not null default false`, so every pre-Phase-11 row reads back `false`; mapping it
  straight through would start writing `isTransfer` onto every ordinary expense in
  the trip on the next sync.
- **Anything new that sums expenses must filter on `isTransfer`.** See decision 3.

---

## Migration 0008: the `create or replace` trap, walked into

`0008` was first written by rebuilding `import_trip_snapshot`'s body from **0004**.
That is the wrong base — **0005 redefined the function**, and rebasing on 0004 would
have silently reverted both of 0005's changes:

- capturing `v_owner` so a member importing a JSON backup **doesn't take ownership**
  of the trip, and
- re-inserting the `trip_collaborators` row that the `trips` delete cascaded away.

Demonstrated against a real Postgres 16, not reasoned about: with the original 0008,
a non-owner importing a snapshot ended up as `trips.user_id` and the collaborator
count went to **0** — which, under `is_trip_member()` RLS, means every other person
on the trip silently loses access to it. Invisible until someone imports.

`0008` is now 0005's body verbatim plus the single `is_transfer` change (a diff of
the two functions shows nothing else), and is idempotent.

**Rule for the next migration that touches this function: diff against the file that
LAST defined it, not against 0001.** Today that is 0008; the sequence so far is
0001 → 0004 → 0005 → 0008.

### Verified locally before hand-applying

The whole chain 0001→0008 was replayed against a scratch Postgres 16 cluster with a
minimal `auth` schema stub (`auth.uid()`, `auth.users`, the three roles) — all eight
apply clean, `is_transfer` lands as `boolean not null default false`, re-running 0008
is a no-op, a non-owner import leaves the creator and collaborators intact, and an
`isTransfer: true` expense round-trips through the RPC while an ordinary one reads
back `false`.

---

## UX review (post-implementation)

Reviewed by the `ux-reviewer` agent against `mockup/DESIGN-SYSTEM.md`, reading the
implemented card plus rendered screenshots of all six states in both themes.
Verdict: changes requested, 3 MAJOR / 2 MINOR / 1 NIT. Clean on the `-soft-ink`
contrast rule, dark-theme parity, colour-never-sole-signifier, and component reuse.
All six were fixed:

1. **(MAJOR) Names truncated to "Priy…" in the payment row** — the one row read once
   and acted on, and the one place the design gave names the *least* width, since the
   row also carries a chevron, an amount and a button. Two companions with similar
   names would have been told apart only by avatar colour, which §2 says is never a
   sole signifier. Fixed in two stages, both content-triggered, no media query: the
   amount + button drop to a second line together (`.settle-row-action`), and if two
   long names still can't share a line the second party takes its own.
   `flex-basis:auto` on `.settle-parties` is load-bearing — a fixed basis wrapped
   *every* row, including the short-name two-companion case the app is actually for.
2. **(MAJOR) `Mark paid` tap target below the app's own floor** — a bespoke
   5px/11.5px shrink put the card's PRIMARY action near the 26px `.icon-btn` size §4
   explicitly reserves for secondary destructive controls. Now `.btn-sm` metrics plus
   `min-height:40px` (36px for `Undo`).
3. **(MAJOR) Focus dropped after `Mark paid` / `Undo`** — both actions destroy the
   element that was activated (the row moves between the payment list and the settled
   strip), so focus fell to `<body>` in silence at the moment the user had just
   committed a repayment. Focus now moves to the successor: the new repayment's
   `Undo` after marking paid, the restored row's `Mark paid` after undoing, the card
   heading (`tabIndex={-1}`, with a `:focus-visible` ring) when neither exists.
4. **(MINOR) No confirmation** — added a `role="status"` live region naming both
   people and the amount.
5. **(MINOR) `rebalanceNote` exposed an undefined internal count** — "6 debts across
   4 expenses" never said what a "debt" was or how it related to the expense count,
   and "rebalances this on its own" had an unanchored subject. Rewritten to introduce
   the relationship ("4 expenses left 6 separate debts between you…").
6. **(NIT) All `Mark paid` buttons disabled together** — `settlingKey !== null`
   greyed out unrelated debts; now scoped per row.

> **Trap found while fixing #3:** the pending-focus target must be **state, not a
> ref**. It is set *after* the awaited write, by which point the `expenses` change
> has already rendered — an effect keyed on `expenses` reading a ref never fires,
> because setting a ref schedules no render. Three tests failed on exactly this and
> are what caught it; they now pin the behaviour.

---

## Part 3 — Following the filter

The card originally sat outside the filter bar entirely (decision 4, as first
written), on the grounds that "pay Priya A$40" derived from the Shanghai-only
subset is an instruction that is wrong to follow. That reasoning is still correct.
What it got wrong was the conclusion: it treated *seeing* a scoped figure and
*acting* on one as the same thing, so the price of protecting the second was
giving up the first — and "who owes whom for food" is a question people actually
ask on a trip, and one nothing else on the tab could answer.

So the exemption was replaced with a split. `settleFiltered` (just `filtersActive`)
picks the expense set and the mode:

| | no filter | any filter |
|---|---|---|
| source | `expenses` (transfers included) | `visibleExpenses` (transfer-free by construction) |
| tag | none | `Filtered`, plus the scope named in the heading |
| `Mark paid` | yes | **no** |
| `Already settled` strip | yes | **no** |
| net note | ends "…balances follow automatically" | ends at the netting |

### Why the scoped mode is read-only

**A repayment belongs to no category and no city.** `handleMarkSettled` writes
`category: 'Repayment'` with no `city`, so the expense that clears a debt falls out
of the very filter that produced it. Marking a Food-scoped debt paid would clear it
in the whole-trip view and leave the Food view still asking for the same money —
and a second payment made against a card that is still demanding it looks entirely
justified to whoever makes it. That is the failure this card can least afford, and
no tag or wording prevents it; only the absent button does.

Two consequences worth naming:

- **The button is withheld, not disabled.** A greyed control reads as "not yet";
  the honest claim is "not from here", which is what the scope note says while
  pointing back at the whole-trip view.
- **The strip is hidden too, and for a different reason.** A scoped balance
  correctly *excludes* the repayments (they aren't food), so listing them directly
  beneath would contradict the figures they sit under. It also means the undo path
  is filter-gated — which is why both the scope note and the filtered empty state
  carry an explicit "Show the whole trip" button rather than relying on the filter
  bar further up the page.

### Scope wording

`settleScopePhrase` joins the active axes with ` · ` ("Food", "Food · Shanghai",
"Food · unpaid only"). The `NO_CITY` sentinel is spelled "expenses with no city"
rather than reusing the filter's own **Whole trip** label: on this card that phrase
already means the *unfiltered, actionable* view — the old tag — so borrowing it
would name the scoped mode after the one thing it isn't.

`paidFilter: 'unpaid'` legitimately empties the card (unpaid expenses are excluded
from settlement anyway, decision 2). It lands on "Nothing to settle yet for unpaid
only — N expenses not counted: N not marked paid yet", which is self-explaining,
plus the way back.

---

## Not done / possible next

- **Nothing reconciles a partial repayment against a specific debt.** A transfer is
  just a payer, a recipient and an amount; settle A$100 of a A$317 debt and the
  card correctly shows A$217 outstanding, but nothing links the two records.
- **Uneven splits.** Every split is per-head across the covered members; there are
  no shares/weights, and `coversMemberIds` cannot express one.
- **Settling in a currency other than home.** Transfers are always home-currency.
- **A scoped settlement can't be acted on.** Part 3's read-only mode is a
  consequence of a repayment carrying no category or city. Making "settle the food
  bill" a real action needs the transfer to record the scope it discharges — a
  schema change, and one that then has to decide what a scoped repayment means for
  the whole-trip balance.
