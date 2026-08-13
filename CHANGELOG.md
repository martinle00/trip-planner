# ctpapp

## 0.9.0

### Minor Changes

- a03e89b: Dev-only auto sign-in for local builds: set `DEV_AUTH_EMAIL` and `DEV_AUTH_PASSWORD` in
  `.env.local` and run `npm run build:local`, and the app signs in with a password account
  instead of emailing a magic link — so the PWA can be tested on a phone over the LAN
  without the email detour (magic links open the default browser, not the installed PWA,
  so the session lands in the wrong browsing context). It's a real session, so RLS, sync
  and the outbox are unaffected.

  Gated so it cannot reach production: the variables are deliberately un-prefixed, so Vite
  never auto-inlines them, and they enter the bundle only through an explicit `define` that
  runs for the dev server and `--mode localdev`. Plain `npm run build` — the artifact
  `wrangler deploy` ships — cannot carry them. A runtime origin check (localhost, loopback,
  `*.local`, RFC 1918) is the second, independent guard.

- ae43685: The trip's journey is now editable. "Edit journey" — the first row in Settings — opens a
  sheet where each leg has a nights field (typed or stepped ±1), up/down reordering and a
  remove control, plus a trip start date that shifts everything at once. Leg dates are shown, not typed: legs
  run back to back, so changing one leg re-dates the rest automatically. A day trip is the
  exception and has its own date picker, bounded to the days its parent city actually has.
  Cities can also be added: name it, and it goes on the end with one night for the arrows
  and the stepper to place. Edits are held as a draft and applied in a single batch on
  Save, so a nights stepper doesn't fire a write per tap.

  Note that the app only knows the original ten cities' currency and map centre, so
  expenses on an added city outside China default to CNY (overridable per expense), and a
  place quick-added there without a map pin lands on a rough default. Renaming a city is
  not possible yet — the name is what places, expenses and days are filed under.

  Removing a leg says exactly what it will cost before it does anything — days removed,
  itinerary stops deleted, places and expenses affected, and whether a day trip goes with
  it. Saved places in a removed city are **kept**, not deleted, and now appear in a "Not on
  this trip" group at the bottom of the Places tab (they were previously invisible in the
  UI while still occupying rows in the database).

  Days that survive an edit keep their identity, so the itinerary you have already built
  stays attached to them even when the whole trip shifts on the calendar — see PHASE10.md,
  which also covers why the day cascade is done explicitly rather than left to Postgres's
  foreign keys, and why queued writes now replay in dependency order rather than queue
  order.

### Patch Changes

- a03e89b: adding mobile local test functionality
- b9d6b58: bug fix for failing test

## 0.8.0

### Minor Changes

- Filter expenses by city, category and paid status on the Budget tab.

  Totals rebase onto the filtered set — "Trip total" answers "what does this selection
  cost?" — and every rebased card carries a `Filtered` tag so a subtotal read on its own
  can't be mistaken for a trip-wide figure. The rates card stays unfiltered; it reports
  rates, not a subtotal.

- Add stop now picks from the places you've already saved.

  The Add-stop modal offers places in that day's city that aren't on the itinerary yet,
  instead of a blank Title field, so a stop links back to its map pin. Free text stays
  available for the stops that aren't places — hotel check-in, a train, a dinner booking.

- Offline writes: a durable outbox with user-gated upload.

  A mutation made with no usable connection now succeeds locally and is queued in a Dexie
  `outbox` table instead of failing. `OutboxTripRepository` wraps the existing
  write-through layer; queued writes coalesce per record, and nothing uploads until you
  tap the topbar pill. Replay stops at the first failure and is safe to re-run.

  This deliberately inverts the old "no silent divergence" rule — see PHASE8.md for the
  rationale and the four traps, in particular that `init()`'s background revalidation must
  stay suppressed while the queue is non-empty.

### Patch Changes

- Fix: the By-person card silently dropped unassigned spending.

  An expense with no `paidBy` was skipped before anything counted it, so the per-person
  bars were shares of a total they could never add up to — with nothing on the card
  saying where the rest went. Since the add form leaves the payer unset by default, that
  was routinely a large slice. The card is now one stacked split with an explicit "Not
  assigned" segment, so the gap has to occupy width. Segments are coloured per member,
  matching their avatar.
