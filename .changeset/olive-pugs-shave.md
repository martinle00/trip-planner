---
"ctpapp": minor
---

**Settle up — the Budget tab now works out who owes whom.**

With some expenses fronted by one person and some by another, the "By person" card
could only ever tell you who *paid*. A companion who had paid for nothing sat at
A$0, which looks like "owes nothing" and actually means "owes their share of every
meal that covered them". The new **Settle up** card answers the other question:

- **Who pays whom, and how much** — netted down to the fewest handovers. Offsetting
  expenses cancel automatically: if you cover someone's dinner and they later cover
  your train, the two debts collapse into one smaller payment (or into none at
  all), and the card says so — "6 debts across 4 expenses net down to 2 payments".
  Nothing needs marking as repaid; log an expense that covers someone back and the
  balances rebalance themselves.
- **A balance per companion**, with the working shown — what they fronted, what
  their share came to, and the difference — so the verdict isn't a bare number.
- **Every expense it couldn't count, named** — not yet marked paid, no payer set,
  paid by a former companion, or in a currency with no exchange rate. If nothing
  qualifies it says exactly what's missing rather than reporting "all square".

Splits respect each expense's **Covers** setting, so a hotel room that only covered
two of you is only owed by those two. Everything converts to your home currency
first, and the card always covers the **whole trip** even when the list is filtered
to one city — a per-city figure would be the wrong amount to actually hand over.

**Mark a debt paid.** Each payment row carries a **Mark paid** button — tap it once
the money has actually changed hands and the balance clears. A repayment is recorded
as its own kind of entry, so it settles the debt without counting as trip spending:
your total, categories and per-person figures don't move, and it stays out of the
expense list. Recorded repayments sit in an **Already settled** strip under the
balances, where one recorded by mistake can be undone.

Following a UX review: companion names in a payment row no longer truncate (the
amount and button move to their own line instead), "Mark paid" and "Undo" got
full-size tap targets, and both actions now confirm what they did and keep keyboard
focus somewhere sensible instead of dropping it.
