# PHASE 10 — Editable journey: legs and dates

The trip got shorter and some cities are off the list. The app can't express that.

`buildSeed()` writes `Trip.cities` and one `Day` row per date **once**, and nothing
in the codebase has ever written either again: `TripRepository` exposes `listDays`
and no day writer at all, and no store action touches `trip.cities`. The only way to
change the shape of the journey today is to hand-edit an exported `trip.json` and
re-import it — which is a whole-trip destructive replace that the offline layer
deliberately refuses to queue.

This phase makes the journey a thing the user edits.

> **STATUS: IMPLEMENTED** (P0 — remove / nights / start date / reorder, plus the
> Edit journey sheet; then **add a leg** and **re-date a day trip**). Verified by
> `npm test` (695), `npm run build` and `npm run lint`.
> **Not yet exercised against the live Supabase project**, which
> is where the Dexie-vs-Postgres cascade and the replay ordering actually get
> tested — see §9. Of P1, only **rename a leg** is still outstanding.
>
> The `ux-designer` half of CLAUDE.md's pipeline was skipped (no mockup was
> ever produced), but **`ux-reviewer` has since reviewed the implementation**
> and its findings are applied: reorder arrows raised to 30×28 (they were
> 22×18, below the design system's own 26px floor, on the sheet's primary
> action), nights settable by typing rather than only by ±1 taps, a
> scroll-into-view + `.flash-confirm` pulse on an added leg, a scoped
> `role="status"` region announcing nights/reorder/add/remove, "Remove day
> trip" instead of "Remove leg" on a day trip's confirm, a stated reason on
> the disabled day-trip date, and `aria-labelledby`/`aria-describedby`
> corrections. Verified at a simulated 390px viewport — the leg row does not
> overflow, and leg names now truncate rather than widening it.
>
> A second review pass confirmed all of the above and found one more: the
> nights field **rejects an over-cap keystroke** rather than snapping to 30,
> which had put a number in the box the user had typed neither digit of
> (press 9, press 9, read 30). Typing "30" is unaffected — 3 and 0 are each
> within the cap — so only unreachable values behave differently. Same pass:
> leading zeros normalise on input, the typed path announces once on blur
> instead of per keystroke, and `scrollIntoView` gates on
> `prefersReducedMotion()`.
>
> Numbered PHASE10 because PHASE9 (offline maps) already claims the number; the
> two are independent and this one shipped first — it changes what the trip *is*,
> and PHASE9's per-leg map downloads are sized off the leg list this phase makes
> mutable.

## Where the code landed

| Piece | File |
|---|---|
| Date chaining, leg ops, the day diff, the cascade plan | `src/lib/journey.ts` |
| `addDaysISO` / `daysBetweenISO` / `datesBetweenISO` | `src/lib/dates.ts` |
| `upsertDay` / `deleteDay` | `tripRepository.ts` + all four implementations |
| `day` outbox kind, dependency-ordered replay (`sortForReplay`) | `outboxTripRepository.ts` |
| `editJourney` / `previewJourneyEdit` | `useTripStore.ts` |
| "Not on this trip" group | `lib/tripView.ts`, `PlacesPanel.tsx` |
| The sheet | `src/features/journey/EditJourneyModal.tsx` |

One thing the plan did not anticipate: **the outbox had to stop replaying in queue
order.** `append` coalesces by moving a re-edited record to the back of the queue,
so a day created offline and then re-edited ends up queued *after* a place that
references it — and Postgres has a real foreign key there. Replaying in queue order
would insert a place whose `day_id` doesn't exist yet, which is a constraint
violation, which `isConnectivityFailure` correctly refuses to re-queue, which means
the drain stops dead with no way for the user to clear it. `sortForReplay` writes
parents before children and deletes children before parents. Coalescing guarantees
one entry per record, so reordering can't change any record's final value — only
whether the intermediate states are legal.

---

## 1. What's already free, and what isn't

Worth being precise about, because the split is lopsided and it determines the
sequencing.

**`Trip.cities` is already fully writable end to end.** It's an embedded JSONB
array on the trip row (`schema.ts:103`, `0001_init.sql:16`), so editing legs is a
`saveTrip()` — which Dexie, `SupabaseTripRepository` and the outbox's `'trip'` kind
all already handle. Zero new plumbing.

**`Day` rows are write-once and have no writer anywhere.** This is the actual work:

| Layer | Today | Needs |
|---|---|---|
| `TripRepository` | `listDays` only | `upsertDay`, `deleteDay` |
| `DexieTripRepository` | reads `db.days` | the two writers |
| `SupabaseTripRepository` | reads `days` | the two writers |
| `OutboxTripRepository` | kinds `trip`/`place`/`itinerary`/`expense` | a `day` kind |
| `useTripStore` | `days` is read-only state | the journey actions |
| Supabase RLS | `"own trip days" … for all` | **nothing** — writes already permitted |

**No snapshot version bump.** Nothing below changes a type's shape, so
`TripSnapshot.version` stays `5` and `parseSnapshot` is untouched. If a proposal
here starts requiring a v6, it has grown past this phase's scope — see §7.

---

## 2. The central algorithm: days are derived, ids are not

`Day` is *almost* a pure function of `Trip.cities` — for each base leg, one day per
date in `[arrive, depart)`, with day-trip legs overriding the parent's day on their
date. That's exactly what `buildSeed()` does.

The part that isn't derivable is `Day.id`, and it is load-bearing:
`ItineraryItem.dayId` and `Place.dayId` both point at it.

**So the reconciliation is a diff, never a rebuild.** Rebuilding days wholesale
from the edited leg list — the obvious implementation — regenerates every id and
orphans every itinerary stop in the trip. This is the single most likely way to
ship a broken version of this feature.

```ts
// src/lib/reconcileDays.ts — pure, the crown jewel of the test surface
export function reconcileDaysToCities(
  cities: City[],
  existingDays: Day[],
): { create: Day[]; update: Day[]; delete: Day[] };
```

**Match existing days to target days by `(leg name, ordinal within the leg)`, not
by date.** Matching by date looks simpler and is wrong: shortening Shanghai by two
nights shifts every later leg's dates, and a date-keyed match would then delete and
recreate every remaining day of the trip — destroying the itinerary the user spent
weeks building, in an edit that was supposed to touch one leg. Ordinal matching
means "Chongqing day 2" keeps its id and its stops wherever it lands on the
calendar, which is what the user means.

Corollary: **a leg rename must be an explicit operation**, not something inferred
from the diff. See §4.

### Cascade rules for a deleted day

Deleting a day is not a single-row delete, and the two backends disagree about it
if you let them:

- **Postgres cascades already** — `itinerary.day_id … on delete cascade` and
  `places.day_id … on delete set null` (`0001_init.sql:40,47`).
- **Dexie cascades nothing.** No FKs.

Left alone, the local cache and the remote diverge on every leg deletion, and an
outbox replay would produce a different result from what the user watched happen on
screen. So **cascade explicitly, client-side, in the store action**: delete the
day's itinerary items by id, unassign the affected places (`dayId: undefined`,
`status: 'wishlist'`), then delete the day. Postgres's cascades then become a no-op
safety net rather than a second, invisible implementation.

Note that orphaned itinerary rows are *silently invisible* rather than obviously
broken: `listAllItinerary` filters `anyOf(dayIds)`, so a stop whose day is gone
simply never loads again while sitting in the table forever. Nothing will surface
this in testing — it has to be got right by construction.

---

## 3. Date model: chained legs

The seed is strictly contiguous — every leg's `depart` equals the next leg's
`arrive`. Two ways to preserve that under editing:

- **Chained (recommended).** Legs are contiguous by construction. The user edits
  *nights*; `arrive`/`depart` for that leg and every leg after it are recomputed,
  and `Trip.startDate`/`endDate` fall out of the first and last leg. "Cut the trip
  from 23 nights to 12" is a handful of edits, not nine date-picker fights.
- **Independent dates.** Each leg carries its own arrive/depart, gaps and overlaps
  allowed. More flexible, and it makes the common case tedious and the invalid
  states plentiful.

Go chained, with one escape hatch: the **trip start date is directly editable**, and
everything shifts off it. That covers "we're leaving three days later" in one edit.
Show the computed dates as read-only text on each leg row — the user needs to see
`9–15 Nov`, they just shouldn't have to type it.

Day-trip legs (`nights: 0`, `parentCity` set) are the awkward case: they consume no
nights and instead override their parent's day on a date. Rules:

- A day trip's date must stay inside its parent's `[arrive, depart)`. When the
  parent shifts, shift the day trip by the same delta; if the parent shortens past
  it, clamp to the parent's last day.
- Deleting a parent leg deletes its day trips with it (surfaced in the confirm, §5).
- Editing nights to 0 on a normal leg does **not** silently make it a day trip;
  that's a separate explicit action.

---

## 4. The operations

**P0 — what the shortened trip actually needs:**

1. **Remove a leg.** Deletes its days (with the §2 cascade), removes it from
   `trip.cities`, recompacts `order`, re-chains dates.
2. **Change a leg's nights.** Adds or removes days at the end of the leg, re-chains
   everything after it.
3. **Change the trip start date.** Shifts every leg by the same delta.
4. **Reorder legs.** Changes `order`, re-chains dates. Day-trip legs move with
   their parent, never independently.

**P1:**

5. ~~**Add a leg.**~~ **DONE** — `addLeg` + the "Add a city" form at the foot of the
   leg list. Appends with one night; the reorder arrows and the nights stepper do
   the rest, so the form stays a single text field. `legNameError` rejects blanks
   and duplicates case- and whitespace-insensitively, because **the name is the
   key** — two legs sharing one would share a pool of days under
   `reconcileDaysToCities`'s `(city, ordinal)` match. Needed no store or repository
   change: a new leg is a `saveTrip` plus `days.create`, both of which `editJourney`
   already did.

   > **Known gap, shipped deliberately.** The two hardcoded per-city tables in
   > `tripView.ts` still only know the seed's ten cities, so an added leg is
   > *usable but not fully at home*:
   > - `CITY_CURRENCY_OVERRIDES` (`Singapore → SGD`) — `defaultCurrencyForCity`
   >   returns `trip.tripCurrency` for any city that IS a leg, so expenses on an
   >   added **non-China** leg default to CNY. Overridable per expense; wrong by
   >   default.
   > - `CITY_FALLBACK_CENTER` — `fallbackCenterForCity` falls through to
   >   `{lat:30,lng:110}` (roughly the middle of China). Only bites a place
   >   quick-added to the new city *without* picking a spot on the map and with no
   >   existing pins there to centre on.
   >
   > The clean fix stays as planned: additive optional `City.currency?` and
   > `City.center?` (permitted by the contract's additive rule, and free of a SQL
   > migration since `cities` is JSONB), with `lib/geocode.ts` resolving the centre
   > at add time. That pulls a network call and a currency picker into the add
   > form, which is why it isn't in this slice.
6. **Rename a leg.** Must be an explicit cascading write, because **the city name is
   the foreign key** — `Place.city`, `Expense.city`, `Day.city` and `Day.parentCity`
   are all name strings. One store action rewrites all four in one pass. Offline
   this queues one outbox entry per affected record; that's honest and fine, but it
   is why rename is P1 and not folded into the leg row's text input as a
   free-for-all.

**Deliberately out of scope:** multiple trips, per-day city overrides beyond the
existing day-trip mechanism, splitting a leg in two, and any merge/conflict logic
(unchanged from Phase 8 — last write wins).

---

## 5. Orphans: the trap that eats the wishlist

`Place.city` and `Expense.city` reference a leg by name, and `schema.ts` is explicit
that both are orphan-*tolerant* — a `city` that no longer matches any leg is "never
a hard error, just an unresolvable label". The Budget tab honours that: an expense
whose city is gone renders as "Whole trip" (`BudgetPanel.tsx:397`).

**The Places tab does not.** `groupPlacesByCity` (`tripView.ts:91`) iterates
`trip.cities` and emits a group per leg — a place whose city isn't in that list is
never rendered by anything. Remove Chengdu today and its saved places don't get
deleted, they get *silently erased from the UI*, still occupying rows in Dexie and
Postgres. The same applies to the map's city chips and the Places tab's city filter.

So, before any removal ships:

- **Add an "Not on this trip" group** to `groupPlacesByCity`, rendered last, holding
  every place whose city matches no leg. Same treatment in the Places city filter.
- **Don't delete the places.** The user is shortening a trip, not abandoning the
  research, and they may put the leg back. Keep them, show them, let them be moved
  to another leg or deleted deliberately.
- **State the blast radius in the confirm dialog**, computed from real counts, not
  a generic "are you sure":

  > Remove **Chengdu**?
  > 2 days · 5 itinerary stops will be deleted.
  > 2 saved places move to "Not on this trip".
  > 1 expense moves to "Whole trip".
  > The trip becomes 21 nights, ending 28 Nov.

---

## 6. UI

An **"Edit journey" sheet**: one row per leg showing name, computed date range and a
nights stepper, with reorder arrows and a remove control; the trip start date at the
top; a live "23 nights · 7–30 Nov" summary at the bottom that updates as you edit.
A day trip nests under its parent with its own date input — the only date in the
sheet the user sets directly, because a day trip consumes no nights and so which of
its parent's days it lands on isn't derivable from anything else.

**Entry point: a row at the top of Settings.** This was originally an edit
affordance on `RouteStrip`, on the reasoning that the strip *is* the journey — the
sheet stayed a `<Modal>` rather than a Settings section (a reorderable ten-row list
with date maths would dominate a surface built for small self-contained controls),
but the trigger lived at the end of the strip as a dashed node. **It went unfound
in real use**: at the end of a row of cities, a node reads as another city, not as
a control. Settings is where you already go to change what the trip *is*, the row
carries a "10 cities · 23 nights" summary so it states a fact rather than just
naming a destination, and `App` closes Settings before opening the sheet — both are
`<Modal>`s and stacking them traps focus in the wrong dialog.

**Edits apply on save, not per keystroke** — a nights stepper that re-chains dates
and diffs days on every tap would fire a cascade of writes (and outbox entries) for
an intermediate state the user never wanted. Compute the pending leg list locally in
the sheet, show the diff summary, write once on Save.

Per CLAUDE.md this goes through the mockup pipeline: `ux-designer` →
`ux-reviewer` against `mockup/DESIGN-SYSTEM.md` before implementation.

---

## 7. Traps

- **Do not implement this as "rebuild the snapshot and `importSnapshot` it".** It is
  by far the shortest path and it is wrong three times over: `importSnapshot` is
  explicitly never queued by the outbox (so the whole feature would be broken
  offline — on the trip it exists for), it is a destructive whole-trip replace that
  would wipe a collaborator's concurrent work, and it regenerates nothing it needs
  to preserve. Journey edits are per-record writes.
- **Rebuilding days instead of diffing them** silently destroys the itinerary. §2.
- **Matching days by date instead of leg ordinal** destroys the itinerary of every
  leg *after* the one being edited, which is worse because it looks like it worked.
- **Postgres cascades, Dexie doesn't.** §2. Divergence here is invisible until a
  device that didn't make the edit reads the remote.
- **Places in a removed city vanish from the UI without being deleted.** §5.
- **`Day.id` is referenced from two directions** — `ItineraryItem.dayId` *and*
  `Place.dayId`. `reconcilePlaceDaysToItinerary` heals the place side, but only if
  the itinerary stops were properly deleted first; it can't repair what it can't
  see.
- **`buildSeed()` is a FROZEN CONTRACT and stays as-is.** It's the starting shape,
  not the current shape. Resist "just edit the seed" — it does nothing for any
  device that has already seeded, which is all of them.
- **The outbox coalesces per record.** A leg edit that creates a day and then, in
  the same save, deletes it must not leave a queued create for a row that no longer
  exists locally. Compute the final diff, then queue — never queue intermediates.
- **`autoplan.ts` needs no change** but its output points at `dayId`s. Applying an
  auto-plan and then shortening a leg must go through the same cascade as any other
  day deletion; no special case.

---

## 8. Sequencing

1. `reconcileDaysToCities` + the date-chaining maths, pure and fully tested. No UI,
   no persistence. Everything else is built on this being right.
2. Repository: `upsertDay`/`deleteDay` across the interface, Dexie, Supabase; the
   `day` outbox kind. No behaviour change yet — just the seam.
3. The `groupPlacesByCity` "Not on this trip" group. Ships alone, and makes removal
   safe to build on.
4. Store actions for P0 (remove / nights / start date / reorder) with the explicit
   cascade, one write batch per save.
5. Mockup → review → the Edit journey sheet.
6. P1 (add, rename) once the P0 loop is exercised on the real trip.

Steps 1–4 are the phase; 5 is what makes it usable; 6 is a follow-up.

Step 6 ran early and only half: **add** landed with the sheet (it needed no new
plumbing), **rename** did not (it's a cascading four-table write, see above).

## 9. Verification

```bash
npm test && npm run build && npm run lint
```

New tests: the day diff (every combination of shorten / lengthen / remove / reorder
/ day-trip clamp, asserting **id stability** explicitly — that's the property that
matters, not the row count); the cascade (stops deleted, places unassigned); the
orphan grouping; the outbox `day` kind incl. queued delete replay.

Manual, because mocked tests can't cover it:

1. Remove a mid-trip leg with itinerary stops on it. Confirm the counts in the
   dialog match what actually happens, and that the later legs' stops survive with
   their new dates.
2. Do the same edit offline. Confirm the pill counts the queued records, then sync
   and confirm a second device sees the identical trip — this is the Dexie/Postgres
   cascade divergence check, and nothing else finds it.
3. Shorten a leg, then re-lengthen it. The recreated days should be empty, and the
   days that were never removed should have kept their stops.

Write the changeset with the change (**minor** — new capability), per CLAUDE.md.
