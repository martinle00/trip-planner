# ctpapp

## 0.12.0

### Minor Changes

- bcba7ae: Add a **Hotel** place category for accommodation. It appears in the Add Place and
  Place Detail category pickers and as a Places-tab filter chip, with a new `cat-hotel`
  bed icon. Free-text categories like `accommodation`, `hostel`, `guest_house`, `motel`
  or `apartment`, including ones from geocoder results, now group under it.
- 5b08179: Settle up now follows the Budget tab's filters. Picking a category (or a city, or
  Paid/Unpaid) rebases the card, so "who owes whom **for Food**" is answerable
  without doing the arithmetic by hand — the payments, the balances and the
  fronted/share working all narrow to the selection, and the heading names the
  scope it covers.

  Scoped, the card is read-only: "Mark paid" and the "Already settled" strip appear
  only in the whole-trip view. A repayment settles the trip's one balance, never a
  category's slice of it, and the expense it writes carries no category or city — so
  recording one from a filtered view would leave that view still asking for money
  that had just changed hands. The scoped view links back to the whole-trip one
  instead.

- ebcbec5: A place can now be on **several days** and under **several categories**.

  - **Days:** the day dropdown on Places cards and the Map pin panel is replaced by day chips.
    Tap any number of them. Each chosen day gets its own itinerary stop, and turning a day
    off removes only that stop. Changing a place from one day to another moves its existing
    stop, so a start time or note set on it isn't lost. On the Map, a place shows in the
    day-view of every day it's on, and a day filter highlights it on each of them. In the
    Itinerary, "Add stop" now offers places already scheduled on other days.
  - **Categories:** Add Place and Place Detail pick categories with chips instead of a single
    select. The first one picked is the primary and sets the place's icon. Cards, the pin
    panel and the detail modal list every category, and a category filter matches a place
    on any of them.

  Requires migration `0009_place_categories.sql` on the Supabase project. Place saves fail
  until it is applied.

- bcba7ae: The topbar timeline now drives the **Places** and **Itinerary** tabs as well as the
  Map. Both tabs open scrolled to the selected city. Tapping a city while you're on one
  of them keeps you on that tab and jumps to the city instead of switching to the Map.
  A day-trip leg jumps to its nested day in the Itinerary. Other tabs still switch to
  the Map.

  Every leg of the trip now has a section in **Places**, even one with nothing saved
  yet ("No places yet"). Adding or removing a leg in Edit journey adds or removes its
  section, so an added leg like Chengdu no longer stays hidden until its first place.

## 0.11.0

### Minor Changes

- 32f3c1d: **Settle up — the Budget tab now works out who owes whom.**

  With some expenses fronted by one person and some by another, the "By person" card
  could only ever tell you who _paid_. A companion who had paid for nothing sat at
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

## 0.10.0

### Minor Changes

- b6e2822: Find a pin on the Map tab, and land on the right one coming from Places.

  - **New search box above the map.** Type a name, category or city and pick a
    saved place to have the map fly to it, select it and flash the marker. It
    searches the whole trip, not just the city on screen — a hit elsewhere
    switches the map to that city first (the row says so before you tap it).
    This searches your own places, never the network, so it works offline.
    Matches with no coordinate yet can't be jumped to, and the panel says how
    many it left out rather than dropping them silently.
  - **"View on map" now singles out the place you opened.** It used to switch to
    the Map tab showing that city and leave you to find the pin yourself among
    every other pin there; it now carries the place through, so the pin arrives
    selected, centred and briefly ringed, with its detail panel already open.

- 8369218: A place can now be saved **without a location**. Previously, adding a place with no
  search result and no pasted coordinate silently dropped it at the centre of its city —
  so a food chain with four branches in one city produced four identical pins that looked
  exactly like real ones. Leaving the coordinate field blank now saves the place unpinned:
  list the candidate branches in the description, and set the location from the place's
  detail modal once you've worked out which one fits the day.

  Places without a location are excluded from the map (which says how many it left off)
  and from Auto-plan, and are tagged "No location" on the Places tab and in the detail
  modal.

  Needs `supabase/migrations/0007_optional_place_location.sql` applied before a
  location-less place can sync.

- 0e7c639: Add a **Transport** place category for transit nodes (airports, train/bus stations,
  metro stops, ferry terminals). It appears in the Add Place and Place Detail category
  pickers and as a Places-tab filter chip, with a new `cat-transport` icon on the map
  markers and place rows. Free-text categories like `airport`, `station`, `metro` or
  `ferry` — including ones carried in from geocoder results — now group under it.

### Patch Changes

- 2358436: Fix focus jumping to the close button on every keystroke inside a modal. The
  shared `Modal` focus trap keyed its setup effect on `onClose`; callers that
  rebuild that callback each render (Edit journey) re-ran the effect — and its
  initial-focus call — on every render, so typing a city name moved focus to the
  X after each letter. `onClose` is now read through a ref and the effect keys on
  `open` alone.

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
