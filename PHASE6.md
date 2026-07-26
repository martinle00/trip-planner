# PHASE 6 — Nav corrections, mobile legibility, Settings, expense sharing

Working plan for Phase 6. Read this before touching anything. Same structure as
`PHASE4.md`/`PHASE5.md`: scope, decisions + rationale, traps, agent workstream.

> **STATUS (2026-07-26): design track APPROVED; all 11 items IMPLEMENTED.**
> Build clean, lint clean (only the known `RouteStrip.tsx:13` warning),
> **434 tests green**. Schema is v5. **code-reviewer: APPROVED** (three
> rounds, 8 findings — see "Code review outcome" at the bottom). **Still
> outstanding: qa-tester has not run, and nothing has been verified in a real
> browser.** See "Implementation notes" at the bottom — in particular,
> items 6–11 were written directly by the orchestrator after both
> implementation agents were terminated mid-run by a spend limit, so they did
> NOT go through the engineer → reviewer → QA pipeline the rest of the phase
> used.
>
> <details><summary>Original status</summary>
>
> **design track COMPLETE and APPROVED; implementation not started.** Scope below is fixed; the four contested calls have been
> decided by the user (see Decisions). Supabase migrations 0002 and 0003 are
> applied — Phases 4 and 5 both shipped carrying those forward; that debt is
> now clear.
>
> **Implementation reference: `mockup/phase6-nav-settings-expenses.html`**
> (all 11 items, light/dark × mobile/desktop). ux-designer → ux-reviewer ran
> three rounds: CHANGES REQUESTED (5 findings) → CHANGES REQUESTED (2) →
> APPROVED. `mockup/DESIGN-SYSTEM.md` gained the `--m-*` member colour
> palette. See "Design-track findings worth carrying forward" at the bottom
> before implementing.
>
> </details>

Phase 6 comes out of real-browser testing of Phase 5 — the verification step
Phase 5 shipped without. Eleven observations across four themes: **navigation
corrections** (Phase 5 got Add-place placement wrong in practice), **mobile
legibility**, a **new Settings surface**, and **richer expense sharing**.

A ux-reviewer pass was run on the contested items before this plan was written;
its findings are folded in below, including the two places where the user
deliberately overrode it.

## Scope (11 items)

### A. Navigation corrections (frontend + design; no schema)

1. **Add-place returns to the panel head on the Map tab; the FAB goes away.**
   Phase 5's single sticky FAB (`.map-add-fab-wrap`) is wrong in production: it
   sits over/near the map, and at the real map size (`min(70vh,560px)`, vs the
   mockup's 280px demo box) the full-label "+ Add place" reads as bulky and
   eats screen. **Fix:** delete `.map-add-fab-wrap` and put a single "Add place"
   button back in `.panel-head`, top-right beside the "Map" title — exactly the
   placement in `mockup/header-nav-hierarchy.html`'s `#v3-condense` frames.
   ⚠️ This knowingly re-opens the keyboard/AT reachability gap — see Decisions
   and trap #2. It is an **accepted trade-off, not an oversight**.

2. **Places tab: "Add place" sticky to the top, both viewports.** Today it's an
   in-flow `.add-card` that scrolls away. **Fix:** a slim sticky sub-bar,
   architecturally identical to the existing `.it-quicknav` /
   `.map-day-quicknav` (composed off `--topbar-h`/`--tabbar-h` via
   `useStickyOffsets`). Places currently has zero sticky sub-bars, so this
   fills a gap rather than stacking a redundant third layer.
   **Do NOT also make `.places-filter-bar` sticky** in the same pass — a
   two-select row under a new sticky button recreates the "too much fixed
   chrome" complaint that started this phase.

### B. Mobile legibility (frontend + design; no schema)

3. **Map day quick-nav chips: short numeric date only on mobile.** The chips
   are elongated at narrow width and break the layout. **Fix:** show only
   `9/11`, `10/11` etc. — a new `fmtShortNumeric(iso)` in `lib/dates.ts`.
   The full `dayLabel` text ("Day 2 · Mon 9 Nov") must be **kept in a clipped
   span**, because today the chip's visible text *is* its entire accessible
   name (only the group carries an `aria-label`). See trap #3.

4. **Mobile route node: the connector line strikes through the city name, and
   long names clip.** Root cause is CSS painting order, not styling taste:
   `.route-node .line` is `position:absolute; z-index:0` inside a
   `position:relative` node, and per CSS 2.1 painting order in-flow inline text
   paints *before* positioned `z-index:0` descendants — so the line always
   paints over `.route-city`. Desktop never shows it because `top:11px` puts
   the line at dot height, spatially clear of the text below. Mobile's
   `flex-direction:row` + `top:50%` puts it dead centre through the letters.
   **Fix:** revert the mobile node to the same stacked (dot above, label below)
   structure as desktop, and widen the fixed node from 74px to ~88–96px (74px
   split between dot + gap + text leaves only ~59px of label, which is why
   "Zhangjiajie" truncates hard). Add `z-index:-1` to `.line` as defence in
   depth so it can never paint over inline content again regardless of future
   layout changes.

### C. Itinerary (frontend; no schema)

5. **Back-to-top affordance.** Scrolling into a city late in the trip leaves no
   quick way back. **Fix:** a button that appears once scrolled past a
   threshold and returns to the top. Must respect `prefers-reduced-motion`
   (the codebase already has `prefersReducedMotion()` helpers in `RouteStrip`
   and `MapPanel` — reuse the pattern, don't re-derive it), and must not
   collide with the Map tab's sticky Save bar pattern or the mobile bottom
   dock.

### D. Settings surface (new; frontend + design)

6. **A Settings surface, opened from a topbar gear.** **Decision (user):
   build it, and move Trip companions into it.** Contents:
   - Trip companions (add / rename / remove — moved wholesale out of
     `BudgetPanel`, including the per-member colour swatch from item 8)
   - Home currency (moved out of the Budget rates card)
   - Theme toggle, Export, Import, Sign out (moved out of the topbar utility row)

   **A modal/sheet from a topbar gear icon — NOT a fifth tab.** The mobile
   bottom dock carries exactly 4 tabs by approved design
   (`header-nav-hierarchy.html` Variant 3); a 5th breaks it. Moving the utility
   buttons in here also relieves the mobile topbar crowding that Phase 5 item 1
   only partly solved by collapsing them to icons.

### E. Expense sharing + Budget corrections (schema v4 → v5)

7. **Fix the "By person" bar semantics and card grouping.** Two real defects,
   not styling preference:
   - **Bar math:** "By category" sizes bars as `amount / budget.total` (share of
     the whole). "By person" sizes them as `sum / byPersonMax` (share of the
     *top payer*). Same visual widget one card apart, two different scales — a
     person covering 90% of the trip renders identically to the largest of
     several small payers. **Fix:** `r.sum / budget.total * 100`, keeping the
     existing `Math.max(4, …)` legibility floor.
   - **Grouping:** the two read-only breakdown cards are separated by the
     companions CRUD card wedged between them. Item 6 moves companions out
     entirely, which resolves this — "By category" and "By person" become
     adjacent.

   **Do NOT change** the avatar-in-label-slot or the shared jade bar fill.
   Both are deliberate and documented (`index.css`'s `.member-avatar` /
   `.by-person-card` comments); both cards are "money already accounted for".

8. **Per-member colour, as a constrained swatch set — accent only.** Schema:
   `TripMember.color?: string`. UI: pick-one-of-N from a small fixed set
   (~6–8 new `--m-*` tokens), applied to the member avatar ring / member chip.
   **The By-person bar stays jade.** Recolouring it per-member would make one
   green mean two contradictory things in a single view (jade = paid, and
   whose-money), against §2's semantic vocabulary. New tokens are new
   design-system surface: they need a `DESIGN-SYSTEM.md` entry specifying the
   hues *before* implementation, chosen to avoid the `--jade`/`--gold` hue
   zones **and** exact overlap with `--d-*`, with `-soft`/`-soft-ink` pairs
   pre-computed and AA-verified in light **and** dark.

9. **"Attach to" simplifies to city names or "Whole trip"; `Expense.dayId` is
   DROPPED.** The per-day list is too granular for how expenses are actually
   logged. Schema: add `Expense.city?: string` (matches a `City.name`, like
   `Place.city` does; absent = whole trip) and **remove `Expense.dayId`
   outright** — decided by the user, see Decisions. Blast radius is genuinely
   small (enumerated in trap #5), but it includes a **Dexie index change**,
   which this database has never had before.

10. **An expense can cover everyone, one person, or a subset.** Schema:
    `Expense.coversMemberIds?: ID[]` — **absent/undefined means "everyone"**, so
    every existing row is already valid v5 data. Orphan-tolerant exactly like
    `paidBy`: an id in the array that no longer resolves to a current member is
    ignored, never throws, never cascade-deletes.

    **An explicit empty `[]` is normalised to `undefined` in
    `exportImport.ts`'s `parseSnapshot`** — decided during design review. The
    mockup makes `[]` unreachable through the expense form (deselecting the
    last person snaps back to "Everyone"), which is the right interaction, but
    it only constrains *this* UI. `coversMemberIds` also arrives via JSON
    import, which never passes through that control, so a hand-edited or
    externally-produced snapshot can still carry `[]`. Normalising once at
    `parseSnapshot` — the single choke point trap #1 already designates for
    defaulting new v5 fields — beats making every reader (the By-person
    rollup, the expense row, any future split calculation) defend against it
    independently. Do **both**: the interaction-level snap-back AND the
    data-layer normalisation.

11. **Paid-state capture gets a payer.**
    - Toggling an expense to **paid** prompts for which member paid it.
      Toggling it back to **unpaid** must NOT prompt.
    - The add-expense form gains an "already paid" option alongside the
      existing "Paid by" select — today the form always writes `paid: false`.

    `Expense.paid` and `Expense.paidBy` both already exist; this item is UI and
    flow, not schema.

## Decisions + rationale

- **Add-place goes back to the panel head — user's call, over the reviewer's
  recommendation.** The ux-reviewer recommended promoting it into the
  already-sticky `.map-day-quicknav` sub-bar instead, on the grounds that
  panel-head-only re-opens the keyboard/AT gap that `header-nav-hierarchy.html`
  flagged as unresolved and that PHASE5 trap #2 forbade shipping without a
  solution. The user weighed that and chose the panel head anyway: it's where
  the button lived before, it's what the approved header mockup shows, and
  the sticky-bar alternative keeps a control pinned in chrome that this phase
  is otherwise trying to slim down. **The gap is therefore accepted knowingly.**
  Record it in the code comment that replaces `MapPanel.tsx`'s current FAB
  comment, so a later reviewer doesn't "fix" it by adding a second button and
  re-creating the exact redundancy Phase 5 item 2 removed.

- **A Settings surface IS built — user's call, over the reviewer's
  recommendation and over PHASE5's own decision.** PHASE5 decided companions
  belong on Budget ("who-paid is a budget concern; co-locating keeps it
  discoverable and avoids a new settings surface"), and the reviewer argued to
  hold that line: nothing is orphaned today, and a 5th surface adds a hop to
  the add-expense → set-payer flow. Overridden because the surface now earns
  its keep from more than companions — it absorbs home currency, theme,
  export/import and sign-out, which directly relieves the mobile topbar
  crowding, and it removes the CRUD card that was breaking up the Budget tab's
  two breakdown cards (item 7). The reviewer's nav objection is respected by
  making it a **modal from a gear, not a fifth tab**.

- **Member colour is a fixed swatch set, not a free colour picker, and never
  the bar fill.** A picker can't be pre-verified against the `-soft-ink`
  contrast rule — arbitrary user hues on `--paper`/`--paper-sunk` can't be
  guaranteed AA in both themes. A curated set gives real customisation with
  every swatch's contrast pair computed up front, the same structure
  jade/gold/accent already use.

- **`Expense.dayId` is dropped, not deprecated — user's call.** The alternative
  was keeping it as a read-only deprecated field the UI stops writing. Dropped
  because nothing depends on it that isn't trivially rewritten: no query
  anywhere filters expenses by day (`dexieTripRepository` only ever queries
  `where('tripId')`), and the two `BudgetPanel` consumers (`openEdit`'s
  `setDayId`, and `dayMeta`) both get *simpler* keyed off `city` directly.
  `handleDayChange`'s "default the currency from the attached day's city" logic
  survives the change and gets shorter — it no longer has to look the day up to
  find its city. This is the second deliberate non-additive break of the
  FROZEN CONTRACT (after Phase 4's `Place.note`); it is done with the blast
  radius enumerated up front, which is the thing Phase 4 didn't do.

- **`coversMemberIds` absent = everyone, not "nobody".** Makes the migration a
  pure defaulting no-op and matches the common case (most expenses are shared).
  An explicit empty array is therefore meaningful-but-degenerate — decide
  whether to normalise it away or treat it as "everyone" too, and write the
  choice down.

## Traps (read before implementing)

1. **v4 → v5 must move in lockstep across every layer** — the trap that has
   recurred every phase since Phase 4. Touching `Expense` (`city`,
   `coversMemberIds`) and `TripMember` (`color`) means: `schema.ts` types, the
   Dexie mapping, the Supabase mapping **+ a new SQL migration 0004**,
   `exportImport.ts`'s `parseSnapshot` (accept v4, default the new fields,
   write v5), `TripSnapshot.version` 4 → 5, and the seed. Miss one and a
   round-trip silently drops data.

2. **0004 must re-emit the ENTIRE `import_trip_snapshot` function.** Migrations
   0002 and 0003 are now applied to the live project (user-confirmed,
   2026-07-26) — the long-running outstanding item from Phases 4 and 5 is
   cleared. But `create or replace function` redefines the *whole* body, so
   0004 has to carry forward every column 0001–0003 added (`description`,
   `self_review`, `members`, `note`, `paid_by`) alongside its own changes, or
   it silently regresses them. 0003's own header comment flags this exact
   hazard about 0002. Diff 0004's function body against 0003's before
   applying.

3. **The Add-place a11y gap is deliberately re-opened (item 1).** Documented
   above; the risk is a future reviewer or agent "fixing" it by re-adding a
   second affordance. The correct response to that finding is to point at this
   file, not to add a button. If a no-new-chrome mitigation exists (a skip
   link, a keyboard shortcut), the ux-designer should propose it — but not a
   second visible control.

4. **Mobile-succinct must not strip accessible names** (item 3). Third phase
   running for this one. Where hidden text is an element's accessible name,
   keep it **clipped**, never `display:none`. The day chips are exactly this
   case.

5. **Dropping `Expense.dayId` (item 9) — the full blast radius, enumerated.**
   Decided; this list is what makes it safe. Every site that touches it:

   | Site | What changes |
   |---|---|
   | `schema.ts` `Expense.dayId` | removed; `city?: string` added |
   | **`db.ts` `STORES.expenses`** | `'id, tripId, dayId'` → `'id, tripId, city'` — **see below** |
   | `supabaseTripRepository.ts` L202, L218 | `dayId: row.day_id` / `day_id: expense.dayId` → `city` |
   | `BudgetPanel.tsx` L324 (`openEdit`) | `setDayId(expense.dayId ?? '')` → city |
   | `BudgetPanel.tsx` L434–437 (`dayMeta`) | day lookup → plain city string |
   | `BudgetPanel.tsx` `handleDayChange` | keyed off city directly; gets shorter |
   | `exportImport.ts` | v4 → v5 per-record transform, derives `city` from `dayId` |
   | SQL 0004 | `expenses.city` column, backfill from `day_id`, drop `day_id`, and re-emit `import_trip_snapshot` |

   **The Dexie index change is the sharp edge.** `db.ts`'s comment states the
   index layout has never changed across any version — this is the first time.
   It needs a `this.version(5)` with a **changed** `.stores()` (not the
   repeated-`STORES` pattern versions 2–4 use) plus an `.upgrade()` that
   derives `city` from each row's `dayId` against the local `days` table before
   the old field goes. Get this wrong and existing local data silently loses
   its attachment. Note the index itself is dead weight today — **nothing
   queries expenses by day**; `dexieTripRepository` only ever does
   `where('tripId')` — so the swap to a `city` index is safe, and arguably it
   should just be dropped rather than replaced unless a city filter is planned.

   A `dayId` that no longer resolves to any day must degrade to "Whole trip",
   never throw — same orphan-tolerance posture as `paidBy`.

   **The index is REPLACED, not dropped** (user's call): `'id, tripId, city'`.
   It buys nothing in this phase — no code will query it — but **filtering
   expenses by city is a planned future feature** (see Backlog), and putting
   the index in now means that phase is a pure UI addition instead of another
   Dexie version bump. Deliberate dead weight, with a named reason.

6. **Member deletion stays orphan-tolerant across THREE references now**, not
   one: `Expense.paidBy` (existing), `Expense.coversMemberIds` (new), and the
   By-person rollup's `orphanCount` path. Removing a member must not cascade,
   crash, or silently drop an expense from a total without surfacing it.

7. **The Settings modal must not perturb the sticky stack or the AuthGate
   invariant.** Moving Export/Import/theme/sign-out out of the topbar changes
   `--topbar-h`, which `useStickyOffsets` feeds to every sticky sub-bar —
   re-verify the Itinerary and Map sub-bars and the mobile dock after the move.
   Sign-out in particular has an order-sensitive teardown (`App.tsx`'s
   `handleSignOut`: reset store → repoint repository → clear Dexie → sign out)
   — relocate the button, not the logic.

8. **The paid-toggle prompt (item 11) has two degenerate cases.** With zero
   members defined, it must not trap the user in a prompt with nothing to
   pick — mark paid without a payer. And toggling *off* must never prompt.

9. **New `--m-*` colour tokens must be verified in both themes before use**
   (item 8), against `-soft-ink` for any text/icon usage. §7's rule: no
   hardcoded colour, token or nothing.

10. **Nothing here is browser-verified yet.** Phase 5's FAB bug (invisible at
    scroll 0) passed every headless check and every green test. Items 1–5 are
    all layout/scroll behaviour — the class of thing this repo has now shipped
    three defects in. Real-browser verification is part of done, not a nicety.

## Agent workstream (handoff order)

1. **ux-designer → ux-reviewer (loop to zero comments).** Mockups for: the
   panel-head Add-place restoration + whatever no-new-chrome a11y mitigation is
   possible (item 1), the Places sticky sub-bar (item 2), the short-date chips
   and the corrected mobile route node (items 3–4), the Itinerary back-to-top
   (item 5), the **Settings modal** (item 6 — the largest new surface in this
   phase), the corrected By-person card (item 7), the `--m-*` swatch set +
   its `DESIGN-SYSTEM.md` entry (item 8), and the expense form's Attach-to /
   Covers / already-paid controls (items 9–11). Work in `mockup/`.

2. **backend-impl** (contract steward): `TripMember.color`, `Expense.city`,
   `Expense.coversMemberIds`, **removal of `Expense.dayId`** against the
   enumerated site list in trap #5 (including the Dexie `version(5)` index
   change); the v4 → v5 export/import migration; seed; SQL migration 0004 +
   mapping. Publish the exact `Expense`/`TripMember` deltas to the frontend
   early — `dayId`'s removal is a breaking change the frontend must land in the
   same pass.

   **`Expense.itemId` is removed in the same sweep** (user's call). It is
   declared in `schema.ts` and mapped both ways in `supabaseTripRepository.ts`
   (L203/L219) and `exportImport.ts`, and carried through every SQL migration's
   `import_trip_snapshot` body — but **nothing in the app has ever read or
   written it**: no UI, no store action, no query. Same field family as
   `dayId`, and 0004 already rewrites the whole function, so it costs
   essentially nothing now and a full extra migration later. Note it has no
   Dexie index, so unlike `dayId` it adds nothing to the `version(5)` work.

3. **frontend-engineer** (parallel with backend, against the published
   contract): items 1–7 and 11, plus consuming the new fields for 8–10.
   Store/view-model only — never Dexie directly.

4. **code-reviewer (loop) → qa-tester (loop).** QA must cover: v4 → v5 import
   of an old snapshot, the `dayId` → `city` derivation including an unresolvable
   `dayId`, member deletion against all three reference sites, an expense with
   an explicit empty `coversMemberIds`, the paid-toggle prompt with zero
   members, and both mobile and desktop layouts in light **and** dark.

## Backlog (deliberately NOT in this phase)

- **Filter expenses by city on the Budget tab.** Wanted, deferred to a later
  phase. Phase 6 lays the groundwork by indexing `expenses` on `city` (trap
  #5), so that phase should be UI-only — no schema or Dexie version change.
  Mirror the existing `.places-filter-bar` pattern rather than inventing a new
  one.
  (`Expense.itemId` was also on this list; it is now IN scope — removed
  alongside `dayId`, see the backend-impl workstream note.)

## Definition of done (phase)

- `npm run build`, `npm run lint`, `npm test` all green; new behaviour covered
  by tests (v4 → v5 round-trip, city attachment, coverage sets, member colour,
  the corrected By-person percentage — assert against `budget.total`, not
  `byPersonMax`, so the fix can't silently regress).
- **Verified in a real browser** at phone width and desktop, light and dark:
  panel-head Add-place, sticky Places button, short-date chips, a route strip
  with no strikethrough and no clipped names, the back-to-top button, the
  Settings modal, and every new Budget surface.
- **Supabase migration 0004 applied to the live project.** (0002 and 0003 were
  applied 2026-07-26, clearing the item Phases 4 and 5 both carried forward.)
- **A v4 snapshot exported before this phase imports cleanly**, with its
  expenses landing on the right cities — the `dayId` → `city` derivation is the
  one irreversible transform in this phase.

---

## Design-track findings worth carrying forward (2026-07-26)

Three review rounds, seven findings. The mockup is approved, but two of the
findings were about **what an implementer would copy**, not about how the
design looks — read these before porting anything.

1. **Every sticky/fixed/absolute divergence in the mockup carries a "MOCKUP
   STAND-IN" comment naming the real production value.** The reviewer swept
   the whole file for these on the final pass. Two exist deliberately (the
   Settings/payer overlay's `fixed`→`absolute` swap, back-to-top's
   `sticky`→`fixed`). **If you port a positioned block, read its comment
   first.** This convention exists because Phase 5 shipped an
   invisible-at-scroll-0 FAB by copying a block that was correct in a 280px
   demo frame and wrong in a `min(70vh,560px)` production one.

2. **`.places-add-quicknav` must use `top:calc(var(--topbar-h,0px) +
   var(--tabbar-h,0px))`**, matching `.map-day-quicknav`/`.it-quicknav`
   (`index.css` L774, L1445). The mockup shipped a bare `top:0` in round 1 —
   caught in review — which would have stuck the bar to the literal viewport
   top and rendered it behind the real topbar+tabbar. Same failure mode as #1.

3. **The payer prompt goes through the shared `src/components/Modal.tsx`** —
   which already supplies Escape, focus-trap and focus-restore. The mockup
   hand-rolls its overlay only because a static HTML file has nothing to
   import; that is NOT a licence to hand-roll a second overlay in production.

4. **Decide where focus lands after a colour pick.** The mockup's decision:
   picking a swatch closes the picker, so focus returns to the picker's
   trigger (standard disclosure-widget contract), not to the now-hidden
   swatch. This may not reproduce in React at all — the reconciler often
   preserves focus across stable-keyed re-renders — but decide it explicitly
   rather than inheriting whatever the framework happens to do. This is the
   third instance of the same class of bug in this project (Phase 5's
   rename/Escape-blur defect, AuthGate's re-gating bug), and the first two
   both shipped.

5. **`aria-checked` must be state-driven on both new radio widgets** (the
   `--m-*` swatch picker and the Settings theme toggle) — computed from the
   same value that drives the visual selected state, so the two cannot
   disagree. Round 1 had the visual state only.

6. **Verified, no action needed:** the `--m-*` contrast table is accurate
   (five pairs recomputed independently across both themes, all matching to
   rounding); `--m-sand`'s hue-40° exception is sound and stays distinguishable
   from `--line-strong`, the "no colour assigned" ring; the day chips' clipped
   accessible names are correct at both breakpoints.

---

## Implementation notes (2026-07-26)

**How this landed is unusual and matters for what to trust.** backend-impl and
frontend-engineer were launched in parallel as planned, but both were
terminated mid-run by an account spend limit. The partial work was committed as
`81a568c`. At that point:

- **backend-impl had finished essentially everything** — schema v5, both
  repository mappings, the Dexie `version(5)` index change, `exportImport.ts`,
  the seed, SQL 0004, and its own tests.
- **frontend-engineer had completed items 1–5** and died before reaching the
  Budget tab, leaving three `Expense.dayId` type errors — exactly the three
  sites trap #5 had enumerated in advance, which is why recovery took minutes.

Items 6–11 were then written directly by the orchestrator, inline. **They did
not go through the ux → engineer → code-review → QA pipeline** the rest of this
phase used. Build, lint and 426 tests pass, but that is a weaker guarantee than
the rest of the phase carries — this codebase has now shipped three defects of
the "green tests, broken browser" family.

### Worth knowing

1. **Four companions tests MOVED, they were not rewritten or dropped**, from
   `BudgetPanel.test.tsx` to `features/settings/SettingsModal.test.tsx`, when
   the companions card moved into Settings. That set includes the Escape-cancel
   regression test guarding a defect that already shipped once — jsdom cannot
   reproduce blur-on-unmount, so that test drives the sequence by hand and must
   survive any future refactor of that component.
2. **One test suite had its inputs changed** (`BudgetPanel.test.tsx`'s
   currency-default block): it drove "Attach to" with day ids that no longer
   exist as options. The assertions — currency defaulting, manual-override
   stickiness — are unchanged. Values, not expectations.
3. **The Budget integration test now opens Settings** to reach the home-currency
   control. Its actual assertion (changing home currency re-bases every total
   immediately, no refresh) is deliberately unchanged: crossing a modal
   boundary must not alter that behaviour.
4. **Two accessible-name defects were caught by the new tests**, both in code
   written this session: a `Status` label and a wrapping label both pointing at
   the "Already paid" checkbox (compound name "Status Already paid"), and the
   payer prompt's close button labelled "Cancel", colliding with the expense
   form's own Cancel. Both fixed at the source rather than worked around in the
   test.
5. **`MEMBER_COLOURS` lives in `lib/tripView.ts`**, not beside `MemberAvatar`,
   so the avatar file exports only a component — same reason `DAY_PALETTE` and
   `EXPENSE_CATEGORIES` live there.

### Next steps, in order

1. **code-reviewer over the whole phase**, weighted toward items 6–11 and the
   `SettingsModal` extraction — that moved a lot of stateful logic (the two
   rename guard refs especially) between components.
2. **qa-tester**, covering what PHASE6's workstream section already lists.
3. **Real-browser verification.** Standing debt from Phase 5, now larger: the
   Settings modal, swatch picker, sticky Places bar, corrected route strip,
   short-date chips, back-to-top, and the payer prompt — light and dark, phone
   and desktop.

---

## Code review outcome (2026-07-26) — APPROVED

Three rounds: **CHANGES REQUESTED** (7 findings) → **CHANGES REQUESTED** (1,
which was a defect *in* the round-1 fix) → **APPROVED**. All eight verified
closed by reading the code, not by re-running the suite.

**Every finding was in code that already had a green suite behind it.** That is
the fourth time in this project. Tests are not the gate that catches this class.

### The two that were real bugs, not style

1. **`pickColour` awaited the network write before restoring focus**
   (`SettingsModal.tsx`). Two failures fell out: a slow write let focus get
   yanked back to the previous member long after the user had moved on, and a
   **rejected** write — routine in this app, where writes require the network
   and fail loudly — skipped the restore entirely, leaving focus on nothing
   with the picker already closed. Fixed by decoupling: close picker →
   schedule focus → fire the write un-awaited. Both scenarios are named in the
   comment so a future "tidy this back to await" has to consciously override
   them. **This is the third instance of the async-work-drives-imperative-focus
   bug class here** (Phase 5's rename/Escape-blur, AuthGate's re-gating).

2. **`confirmPayer` would resurrect a deleted expense.** The round-1 fix
   re-fetched the expense by id but fell back to the stale captured snapshot
   when the row was gone — and `updateExpense` upserts unconditionally, so that
   fallback didn't degrade to a no-op, it re-created an expense deleted on
   another device mid-prompt, carrying a `paid: true` and a payer never
   confirmed against anything. Worse, its comment claimed to match
   `handleSubmit`'s edit branch while doing the opposite. Now genuinely
   mirrors it: no row, no write.

### Also fixed

- Two missing tests the phase's own Definition of Done had already demanded:
  the By-person bar percentage (verified it fails under the old `byPersonMax`
  math, so it's a real guard) and the "already has a payer doesn't re-ask"
  branch of the paid toggle.
- `openEdit`'s `city` prefill is orphan-filtered like `paidBy`. Without it the
  select *visually* showed "Whole trip" while state held a stale city, and
  re-picking the shown option fires no `onChange` — so the form could not clear
  it at all.
- Comment/CSS nits: `MEMBER_COLOURS`'s self-contradictory "kept beside the
  avatar", and a permanently shadowed duplicate `.members-list` rule.

### Deliberately NOT changed (ruled on, not overlooked)

- **`setTimeout(…, 0)` stays** rather than `requestAnimationFrame` — matches
  `openEdit`'s existing `scrollIntoView` deferral in the same file. Local
  convention beats a marginal semantic difference.
- **`void`-ed store writes stay un-caught.** Every sibling call in both files
  does the same, and offline-write UX is already named in `CLAUDE.md`'s "Not
  yet done". It is a phase-level gap to design deliberately, not something to
  smuggle into a review round.

### Verified solid, by reading

Both rename guard refs are an exact line-for-line port; all four moved
companions tests are intact and not weakened; the currency-default suite had
only its input values changed; `handleSignOut`'s order-sensitive teardown is
untouched with only the button relocated; the `dayId`/`itemId` removal is
complete across the enumerated blast radius; and no mockup positioning hazards
were ported into the new CSS.

---

## Post-review changes (2026-07-26)

Two follow-ups after the code review approved, both from real-browser use.

### By-person card layout — the actual defect behind item 7's complaint

The original report ("doesn't follow the design pattern shown throughout the
app") turned out to have a third cause neither the design review nor the code
review found, because it is invisible to both a mockup and a test suite:

- **`.cat-breakdown` declared no padding.** Every other card on the Budget tab
  declares its own (`.rates-card` 14/16, `.summary-card` 14, `.members-card`
  14/16, `.expense` 12/14). "By category" masked this with an inline
  `style={{ padding: '14px 16px' }}` on the element; "By person" reuses the
  same class and had **nothing**, so its rows rendered flush against the card
  border while the identical card directly above it was properly inset.
  Padding now lives on `.cat-breakdown`; the inline style is gone.
- **The two cards' labels were structurally different.** The truncation rule is
  `.cat-row .cat-label span`, but By-category used a bare text node while
  By-person wraps its name in a `<span>`. So one truncated with an ellipsis and
  the other didn't — a long category name pushed its grid column out of
  alignment with the card below. Both wrap now, matching the approved mockup.

**Lesson worth keeping: a missing `padding` declaration is invisible to the
entire gate stack.** Tests don't assert it, code review reads for logic, and
the mockup had its own padding so the divergence never appeared there. Only
running the app finds this class.

Two tests needed their selector widened from `.cat-label` to `.cat-label span`
— query only; the assertions still use `.closest('.cat-row')` unchanged.

### Back-to-top extended to Places and Budget

Item 5's button now appears on all three scrollable tabs. **Extracted to
`src/components/BackToTop.tsx`** rather than copied twice more: the threshold,
the reduced-motion check, the passive listener and the conditional-mount
decision all have to agree across every consumer, and three copies is three
chances to drift. `ItineraryPanel` now renders `<BackToTop />` like the other
two, and its local `prefersReducedMotion` helper (used only by the old inline
version) is gone.

Covered by `BackToTop.test.tsx`, including the two non-obvious behaviours:
it is **absent from the DOM** rather than hidden below the threshold (an
always-rendered invisible button is a Tab stop going nowhere), and it reads
scroll position **on mount**, so switching to an already-scrolled tab shows it
immediately instead of waiting for the next scroll event.

Not touched: `jumpToToday` and `scrollToCity` in `ItineraryPanel` both hardcode
`behavior: 'smooth'` with no reduced-motion check. Pre-existing, out of this
scope, worth a sweep later.
