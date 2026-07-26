# PHASE 5 — Mobile polish + richer expenses

Working plan for Phase 5. Read this before touching anything. Mirrors the
structure of `PHASE4.md`: scope, decisions + rationale, traps, and the agent
workstream.

> **STATUS (2026-07-26): all 6 items COMPLETE through the full pipeline.**
> design → code review (1 fix round) → QA `PASS`. **393 tests green**, build
> clean, lint clean (only the known `RouteStrip.tsx:13` warning). See
> "Outcome" at the bottom of this file for what landed, the one accepted
> trade-off, and what is still outstanding. **Two manual steps remain before
> this can be trusted end-to-end: apply Supabase migrations 0002 + 0003, and
> verify the mobile layouts in a real browser.**

Phase 5 came out of real browser testing of the Phase-4 header-nav redesign
(mobile bottom dock + desktop condensing header, now landed in the working
tree). Six observations, grouped into two themes: **mobile/narrow-view polish**
and **richer expense tracking**.

## Scope (6 items)

### A. Mobile / narrow-view polish (frontend + design; no schema)

1. **Topbar actions overflow on mobile.** The utility row (Export / Import /
   sync pill / theme / Auto-plan / Sign out) wraps awkwardly on narrow
   viewports, leaving dead whitespace on the right (the Sign-out text button is
   the most visible offender). **Fix:** collapse the utility buttons to
   icon-only on narrow viewports, reusing the exact machinery the Phase-4
   redesign already built — `.btn-collapsible` + the clipped `.btn-label`
   (keeps the accessible name), and the `i-download` / `i-upload` / `i-logout`
   icons already added to the sprite. This is the SAME visual treatment as the
   desktop condensed state, just triggered by width instead of scroll. CSS-only
   plus possibly one class toggle; no new icons, no new pattern.

2. **Two Add-place buttons is redundant.** The Phase-4 a11y fix added a second,
   icon-only "Add place" (`+`) into the Map day sub-bar (`.map-day-quicknav`)
   alongside the panel-head "Add place". Keep exactly ONE add-place affordance.
   **Decision (user): remove the `+` from the day sub-bar** (do NOT repurpose it
   to "add day" — see Decisions). ⚠️ Removing it re-opens the reachability gap it
   was solving: once the panel-head "Add place" scrolls off, a keyboard/SR user
   has no way to add a place. The single remaining affordance MUST stay
   keyboard/AT-reachable at every scroll position — the ux-designer owns where
   it lives per viewport (candidate: a real, keyboard-operable Add-place FAB on
   the map surface, replacing today's `aria-hidden` "tap to add" hint). Do not
   just delete the button and leave the gap.

3. **Route-strip date bubbles read badly on mobile.** `fmtCompactRange`
   ("7–9 Nov") + the two-line node is cramped/awkward at narrow width.
   **Fix + principle:** establish a "**mobile = as succinct as possible**"
   rule — on narrow viewports, strip trip chrome to the minimum (e.g. route
   nodes show city name only, or a very short date form; drop the weekday/month
   noise). ux-designer defines the exact mobile route-node form; add the rule to
   `mockup/DESIGN-SYSTEM.md` so it's reusable, not a one-off. May add a shorter
   date formatter in `lib/dates.ts`. Watch the a11y-name trap (item in Traps).

### B. Richer expenses (schema v3 → v4; backend + frontend + design)

4. **Edit an existing expense + free-text notes.** Today an expense can only be
   added, paid-toggled, or deleted — no editing of its details. **Add:** an edit
   affordance per row (reuse/extend the existing inline add-form as an
   add/edit form, saving via the store's existing `updateExpense`), and a new
   free-text **`note`** surfaced on the row. Schema: `Expense.note?: string`
   (additive).

5. **Track who paid, via a trip-members list.** **Decision (user): a defined
   members list**, not free-text. Define travel companions once; pick the payer
   per expense. Schema: `TripMember { id: ID; name: string }` + `Trip.members?:
   TripMember[]` (additive), and `Expense.paidBy?: ID` (member id, additive).
   UI: small members management (add / rename / remove) in the Budget tab; a
   "Paid by" selector in the expense form; payer surfaced on the row. Composes
   with the app's existing paid/owed (jade/gold) vocabulary — leaves the door
   open to a future per-person "who owes whom" view.

6. **(Stretch, same data) per-person totals.** With `paidBy` in place, an
   optional per-member breakdown in the Budget summary (each member's converted
   share). In scope if cheap once 4+5 land; otherwise defer. Must reuse the
   existing live-convert / no-rate-exclusion logic — never sum raw across
   currencies.

## Decisions + rationale

- **`+` is removed, NOT turned into "add day".** The user's intuition (a `+`
  among the day chips reads as "add a day") is fair, but there is no
  day-creation anywhere in the app: `TripRepository` exposes only
  `listDays` — no `upsertDay`/`deleteDay` — and days are seeded aligned to each
  city's `arrive`/`depart`. "Add day" would be a net-new backend feature
  (repository method across Dexie **and** Supabase, a store action, plus a
  contested rule for the new day's date and its relationship to the city's date
  range). Not worth it for this phase; a single clear Add-place is the smaller,
  cleaner win. Revisit "add day" as its own item later if wanted.

- **Members are `{id,name}` objects, not bare name strings.** Referential
  stability: renaming a companion shouldn't strand `paidBy` references, and it
  makes reliable per-person rollups possible. `Expense.paidBy` stores the id.

- **Members live on the Trip (`Trip.members`), managed in the Budget tab.**
  Who-paid is a budget concern; co-locating keeps it discoverable and avoids a
  new settings surface.

- **Reuse, don't reinvent, the Phase-4 collapse infra.** Item 1's mobile
  icon-collapse is deliberately the same `.btn-collapsible`/clipped-label
  pattern the desktop condensing header uses — one mechanism, two triggers.

## Traps (read before implementing)

1. **v3 → v4 migration must move in lockstep across every layer** — the
   recurring Phase-4 trap. Touching `Expense` (`note`, `paidBy`) and `Trip`
   (`members`) means: `schema.ts` types, the Dexie mapping, the Supabase mapping
   **+ a new SQL migration (0002)** adding `expenses.note`, `expenses.paid_by`,
   and `trips.members` (JSONB), `exportImport.ts` `parseSnapshot` (accept v3,
   default the new fields, write v4), `TripSnapshot.version` 3 → 4, and the
   seed. All additive/optional, so migration is a defaulting no-op — but it must
   still be done everywhere or a round-trip silently drops data. (Note memory's
   "SQL 0002 outstanding" — reconcile with any already-pending migration before
   numbering.)

2. **Removing the `+` re-opens the add-place a11y gap.** The single remaining
   Add-place must be keyboard/AT-reachable at all scroll positions. Don't ship
   item 2 without item's reachability solution designed and verified.

3. **`paidBy` / member deletion.** Deleting a member that expenses reference
   must NOT cascade-delete or crash — render the payer as unset/"—" (orphan
   tolerant). New optional fields on existing rows render as unset, never throw.

4. **Live-convert integrity for per-person totals (item 6).** Convert each
   expense on the fly from `Trip.rates`, honour no-rate exclusions exactly like
   the existing budget totals (`convert()` in `lib/exchangeRates.ts`). Never add
   raw amounts across currencies.

5. **Mobile-succinct must not strip accessible names.** The Phase-4 redesign
   already learned this: use `display:none` only when content is gone for
   everyone; where hidden text is an element's accessible name (route-node
   city+date), keep it clipped, not removed.

## Agent workstream (handoff order)

Non-trivial UI → design track first, then parallel implementation, then review
+ QA. Same pipeline as before.

1. **ux-designer → ux-reviewer (loop to zero comments).** Mockups for: mobile
   topbar icon-collapse (item 1), the single canonical Add-place placement +
   reachability per viewport (item 2), the mobile-succinct route-node form +
   the DESIGN-SYSTEM.md rule (item 3), the expense add/edit form with notes +
   Paid-by (items 4–5), members management UI (item 5), and optionally the
   per-person breakdown (item 6). Work in `mockup/`.

2. **backend-impl** (contract steward): `Expense.note`, `Expense.paidBy`,
   `TripMember` + `Trip.members`; store actions for member add/rename/remove
   (expense add/update already exist); export/import v3 → v4 migration; seed;
   Supabase SQL migration 0002 + mapping. Publish the exact Expense/Trip deltas
   to the frontend early. **No new day methods needed** (per the decision).

3. **frontend-engineer** (parallel with backend, against the published
   contract): item 1 mobile collapse, item 2 remove-`+`-and-reconcile, item 3
   mobile route-strip, item 4 edit + notes UI, item 5 Paid-by + members UI,
   item 6 if in scope. Consume store/view-model only — never Dexie directly.

4. **code-reviewer (loop) → qa-tester (loop).** QA must cover: v3→v4 import of
   an old snapshot, member-delete orphan tolerance, no-rate expenses in any new
   per-person total, and both mobile and desktop layouts (light + dark).

## Definition of done (phase)

- `npm run build`, `npm run lint`, `npm test` all green; new behavior covered by
  tests (schema migration round-trip, expense edit, paidBy, members CRUD).
- Verified in a real browser at phone width and desktop: no topbar overflow, one
  Add-place (reachable when scrolled), succinct mobile route strip, expense
  edit/notes/paid-by working, members manageable.
- Supabase migration 0002 applied to the live project (or explicitly noted as
  pending, like Phase 4's outstanding manual steps).

---

## Outcome (2026-07-26)

All 6 items landed. Pipeline: ux-designer → ux-reviewer → backend-impl ∥
frontend-engineer → code-reviewer (**CHANGES REQUESTED**, 4 findings, then
**APPROVED**) → qa-tester (**PASS**, 9 tests added). Final: **393 tests / 26
files**, build clean, lint clean.

Note the SQL migration was numbered **0003** (`0003_expense_members.sql`), not
0002 — it reconciles with the already-pending 0002 rather than colliding with
it. **Neither is applied to the live project.** Until 0003 runs,
`import_trip_snapshot` silently drops `members`/`note`/`paidBy` on JSON import,
with no error.

### Defects the review gate caught (worth remembering)

1. **The Add-place FAB was invisible at scroll 0** — `position:sticky` never
   renders above its own static in-flow position, and the FAB had been placed
   after the whole map/legend/pin-detail grid. Root cause: **the mockup's demo
   map box is 280px; the real app's is `min(70vh,560px)`.** The mockup's
   "reachable at the top" claim was true *in the mockup* and silently didn't
   carry over. Lesson: when a mockup asserts a scroll/layout property, check
   its own box dimensions against production before trusting it.
2. **Escape while renaming a companion could silently COMMIT the edit.**
   Unmounting a focused `<input>` makes real browsers fire `blur`, which React
   routes to `onBlur` → `commitRename`. **jsdom does not reproduce
   blur-on-unmount**, so no amount of green tests could have caught it. Fixed
   with a `renameCancelingRef` guard; the regression test drives Escape then an
   explicit `blur` deliberately.

### Accepted trade-off — do not "fix" this without reading first

The single Add-place FAB's sticky containing block is the map column, so a
**sighted** user scrolled past the legend into pin-detail/Save-bar territory
has no visible Add-place control until scrolling back up. **Keyboard/AT
reachability is unaffected** (Tab reaches it in DOM order; focus scrolls it into
view) — which is what trap #2 literally requires. Accepted because no placement
satisfies both ends without restructuring `.panel` (shared by all four tabs)
into an ordered flex/grid, or adding a second control that reopens the exact
redundancy item 2 existed to remove. Full reasoning in `MapPanel.tsx`'s comment.

### Still outstanding

- **Supabase migrations 0002 + 0003 not applied to the live project.**
- **No real-browser verification yet.** Not checkable headlessly: the <719px
  topbar collapse, the city-only route strip, the FAB's actual on-screen
  position, and light/dark rendering of all the new Budget surfaces.
- Unrelated work sitting in the same tree: `src/lib/geocode.ts` has an
  unreviewed-for-merge Photon geocoder change (Phase 4 item 9 territory). It
  was reviewed ad-hoc and has **two known open defects** — a coordinate guard
  that doesn't guard (`Number.isNaN` doesn't coerce, so `coordinates: []`
  yields `lat: undefined`), and `resetGeocodeProvider()` resetting to Nominatim
  while `createDefaultGeocodeProvider()` returns Photon. Not part of Phase 5;
  deliberately left untouched.
