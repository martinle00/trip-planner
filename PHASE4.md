# Phase 4 — Place write-ups, expense editing, manual coordinates

**Status: IN PROGRESS, design + backend only. No frontend work started.**
Written 2026-07-20 as a session handoff. Read this before resuming.

---

## ⚠️ First thing to check when resuming

**The working tree may not compile.** Two agents were running in the background when
the session ended, and their output landed on disk without being reviewed:

1. **backend-impl** — was explicitly authorised to remove `Place.note` from the schema
   *without* fixing the three UI files that consume it, leaving them for the
   frontend-engineer. So a broken typecheck is an EXPECTED intermediate state, not
   necessarily a bug.
2. **ux-designer** — was on round 4 of `mockup/place-detail-modal.html`.

Before anything else:

```bash
git status                 # see what actually landed
npm run build              # expect failures in the 3 files listed under item 7
npm test
```

Read the backend agent's changes before trusting them — its report was never reviewed
by a human or by the code-reviewer agent. **Nothing in this phase has been through
code review or QA.**

---

## Context

The trip is Nov 2026 to China. Two people — the user and their partner — share **one
login** (`trips_user_id_unique` means a second account would get its own separate trip,
so sharing requires a shared account). Magic links go to the account's email, so signing
in the partner's device means forwarding a link once; the session then persists.

Roughly 90% of place write-ups will happen at home in Sydney after the trip, in long
sessions. That single fact drives most of the design decisions below.

---

## Scope — 9 items

### 1. Edit an existing expense
Currently expenses can only be added, toggled paid, or deleted — there's no edit.

**Approach:** reuse the existing inline `.add-form` in `BudgetPanel.tsx` (it is NOT a
modal — it's always mounted, toggled by an `.open` class). Add
`editingId: string | null` state, an `openEditForm(e: Expense)` that prefills the six
form state vars, and branch `handleSubmit` between `addExpense` and `updateExpense`.

**No store or repository changes needed.** `updateExpense` already exists
(`useTripStore.ts:575`) and takes a whole `Expense`; `upsertExpense` on all three
repositories already handles updates.

Gotchas:
- Set `currencyManual = true` when prefilling, or a later "Attach to" change will
  clobber the saved currency.
- Preserve `id`, `tripId`, `itemId` and `paid` — spread from the original. `handleSubmit`
  currently hardcodes `paid: false`.
- The form's toggle button and submit button currently share the accessible name
  "Add expense", which is why existing tests use
  `getAllByRole('button', { name: 'Add expense' })[0]`. Changing the submit label to
  "Save changes" in edit mode affects those queries.

### 2. Show cents
Amounts are already **stored** correctly as major-unit floats (`12.34` stays `12.34`) —
decimals are only lost at render.

**One function:** `fmtMoney` at `BudgetPanel.tsx:22` does
`Math.round(amount).toLocaleString('en-AU')`. Decision: **2 decimals everywhere** —
expense rows, per-currency chips, category breakdown AND summary totals.

~6 existing test assertions hard-code whole-unit strings and will fail:
`BudgetPanel.test.tsx:155` (`'A$225'`), `BudgetPanel.integration.test.tsx:79, 93, 103,
127, 141`. Their comments even document the rounding. Update them alongside.

### 3. Place `description` + `selfReview`
Two optional free-text fields on `Place`. Text only — **no media, ever**. `description`
is pre-visit notes; `selfReview` is a blog-style post-visit write-up.

**No `visited` status.** A non-empty `selfReview` IS the signal that a place was visited,
surfaced as a jade "Reviewed" tag on the card. This deliberately avoids widening the
`PlaceStatus` enum, the Postgres check constraint, autoplan, and map marker colours.

**UI: a modal**, opened from the place card. Chosen over an inline card-expand
alternative (`mockup/place-detail-inline.html`, **rejected — delete this file**) because
expanding a card inside a CSS grid stretches its whole row and leaves dead space above
neighbours' footers. Reuses `src/components/Modal.tsx` unchanged.

### 4. Local draft + explicit save (prose fields ONLY)
**This deliberately breaks the app's write-through model, for these two fields only.**

- Draft is cached locally and continuously as the user types.
- It survives modal close, tab switch, and full page reload.
- Only pressing "Save changes" writes to the DB.

**Why:** losing prose to a flaky connection is the expensive failure; instant
consistency is worth nothing for a trip journal. Side benefit — writing works fully
offline, sidestepping the unresolved offline-write UX gap on the one surface where it
hurts most.

**Scoped to the prose fields.** Expenses, day assignment and adding places stay
immediate write-through. Making a checkbox need a Save button would be worse.

Consequences:
- A draft lives on the device it was typed on and is invisible on the other device
  until saved. Inherent to the approach.
- **No confirm-on-close** — closing is non-destructive, and guarding a safe action
  trains people to dismiss prompts. But **"Discard draft" IS destructive** and does
  need a confirmation.
- Needs an "unsaved changes" indicator in two places: in the modal, and on the card in
  the grid (a draft you've forgotten about is otherwise invisible).

### 5. `updatedAt` + append-both conflict resolution
Two users on two devices means the same place can be edited twice.

**Resolution is deliberately crude: keep both.** If the remote row changed since the
draft was started, append the incoming remote text below the user's text with a visible
separator. Nothing is ever discarded. No merge UI, no pick-a-version dialog.

Chosen over proper optimistic concurrency with a resolution dialog because at a user
count of 2 the crude answer is defensible and much less work. Rejected as overkill:
realtime subscriptions, CRDTs/Yjs, operational transforms, event sourcing.

**This still requires an `updatedAt` column** — detection is needed either way, or it
would append on every single save. What was skipped is the resolution *UI*, not the
schema change.

Implement as a **conditional update** (`update ... where id = $id and updated_at =
$base`), not read-compare-write — same effort, no race window. Zero rows back means
re-read, append, write again.

> ### 🔴 The sentinel string must be byte-identical across layers
> The separator (`— Also written on another device —`) is stored **in the text**, and
> the renderer detects it to swap in a visual divider. Storing it in the data is
> correct — the merged text IS the data, and the boundary must survive export/import.
> But backend and frontend must share **one exported constant**. If each hardcodes its
> own and they differ by a character, users see a raw sentinel line sitting in their
> prose. It typechecks fine and only surfaces in real use.

### 6. Delete confirmation for places
The card's trash icon deletes with no confirmation. That was fine for a bare pin; it now
destroys a description and review with no undo.

The confirmation should say **what is actually being lost** — deleting a pin with no
prose is a different act from deleting one with three paragraphs. Must handle an
unsaved draft on the deleted place. The trash icon is a 26px `.icon-btn`, below the 44px
touch guideline; acceptable for secondary destructive actions per the design system, but
worth growing here given the raised stakes.

### 7. `Place.note` → `description` migration (REMOVES `note`)
Decided to do this now, while there's little data. `note` (the one-line teaser)
disappears entirely; content folds into `description`.

`src/data/seed.ts` has **zero** `note:` values, so a fresh install has no note data —
any notes are user-typed. The migration must still **copy** rather than drop.

> ### 🔴 `ItineraryItem` ALSO has a `note` field and it is UNRELATED
> Only `Place.note` is removed. `ItineraryItem.note` stays exactly as-is.
> **Never do a project-wide find-and-replace on `note`** — it breaks itinerary stop
> notes while typechecking cleanly.
>
> - `Place.note` (remove): `supabaseTripRepository.ts:90,106,123`,
>   `PlacesPanel.tsx:189`, `MapPanel.tsx:312`, `AddPlaceModal.tsx:229`
> - `ItineraryItem.note` (LEAVE ALONE): `ItineraryPanel.tsx:198,237,249`,
>   `supabaseTripRepository.ts:142,154,167`

UI consequences: the place card shows a **truncated `description` excerpt** instead of
the italic `.place-note` line (long prose in a grid card is the risk — decide truncation
deliberately). The Add Place modal's single-line "Note" input becomes a description
field — consider whether the add flow should offer full long-form writing or hand off to
the detail modal, since adding a place and writing about it are different moments.

### 8. Remove tap-to-drop-a-pin
The user never wanted it. Net deletion:
- `AddPlaceMode = 'search' | 'pin'` collapses to a single path — removes branching at
  `AddPlaceModal.tsx:177, 212, 238-242, 260`, the `point` prop, and `.pin-context-card`
- `MapPanel.tsx`: remove `ClickToAdd` (262-266), `handleMapTap` (69), the `onMapClick`
  prop threading (128, 191, 201, 210), and the `.map-add-hint` badge
- `App.tsx:101` comment + handler; `.pin-context-card` / `.map-add-hint` in `index.css`
- `AddPlaceModal.test.tsx` likely covers pin mode

Do NOT remove `Icon name="pin"` usages — that's the places icon, unrelated.

**Consequence:** there is then no way to adjust a pin's position at all. A wrong
coordinate means delete and re-add. Draggable pins would fix it; deliberately NOT in
scope.

### 9. Paste Google Maps coordinates when adding manually
Today the manual fallback drops the pin at the **city centroid** and tells the user to
"fine-tune its position once you're back online" (`AddPlaceModal.tsx:334-335`). So every
manually-added place currently lands in the middle of the city.

**Accept a pasted Google Maps URL as well as a bare `31.2304, 121.4737` pair.** Google
produces several shapes: the right-click copy-coordinates pair, `/maps/@lat,lng,15z`
URLs, and place URLs with `!3d`/`!4d` fragments. Parse all of them.

Nominatim search **stays** as the fast path; coordinates are the reliable fallback
replacing the centroid guess. (Nominatim's China coverage is patchy, so coordinates will
likely be the common path.)

> ### 🔴 UNVERIFIED: the GCJ-02 datum offset
> China mandates a coordinate system (GCJ-02, "Mars coordinates") that applies a
> deliberate nonlinear offset to true WGS-84 positions. Google Maps serves GCJ-02 for
> Chinese locations. This app's Leaflet/OpenStreetMap tiles are WGS-84. So coordinates
> copied from Google Maps for a Chinese POI are expected to plot roughly **300–600m
> off** — consistently, and in a plausible-looking direction rather than obviously
> broken.
>
> A GCJ-02 → WGS-84 conversion is ~40 lines with no dependency. **Verify empirically
> before building it in:** paste coordinates for somewhere unambiguous and check the pin
> lands on the building, not in the river. If no offset appears, skip the conversion.
> This was never tested — do not assume either way.
>
> Note item 8 removes tap-to-drop, which was the only WGS-84-native input method. That
> raises the stakes on getting this right.

---

## Workstream state

| Workstream | State |
| --- | --- |
| Design — Option A chosen | ✅ modal direction approved by the user |
| ux-designer rounds 1–3 | ✅ complete (mockup, review fixes, draft model) |
| ux-designer round 4 | ✅ complete — delete confirmation + `note`→`description` |
| ux-designer round 5 | ❌ NOT SENT — items 8 and 9, plus the two carry-overs below |
| ux-reviewer | ⏸ ran once (changes requested, all addressed). **Needs a final pass once design settles.** |
| backend-impl | ⚠️ was RUNNING at session end — items 3,4,5,7. Report never reviewed. |
| GCJ-02 conversion (item 9) | ❌ not briefed to backend yet |
| frontend-engineer | ❌ not started, by design — sequenced after backend |
| code-reviewer / qa-tester | ❌ not started |

**Agreed sequencing: backend first, then frontend.** Both touch the persistence seam;
racing them there was judged not worth it.

### Carry-overs for designer round 5

1. **`mockup/mockup.html` still contains `note`.** Round 4 only updated
   `place-detail-modal.html`. The main mockup's Map-tab `.pin-detail-note` and its own
   Add Place modal are untouched and still show the old one-line note field. The
   designer flagged this rather than reaching outside its brief — correct call, but it
   means the *visual spec itself* now disagrees with the approved design until someone
   fixes it.
2. **`line-clamp` CSS compat warning** at `place-detail-modal.html:211` — the card
   excerpt uses `-webkit-line-clamp` without the standard `line-clamp` alongside it.

### Round 4 decisions worth knowing

- Delete confirmation reuses the **inline two-step panel**, not `Modal.tsx` — a
  full-screen modal would pull focus from the card whose name and tags the warning
  references. The warning is content-aware: it names the word count of a review being
  destroyed, mentions an unsaved draft if one exists, and says plainly when a pin has
  nothing written on it.
- The trash trigger grew from 26px to 36px, and the actual destructive click happens on
  a full-size button in the follow-up panel.
- Card excerpt uses CSS `-webkit-line-clamp`, **not** a JS character cut — screen
  readers still get the full text, and truncation stays honest at any card width.
- Old `note` text was folded in per-place: dropped as redundant where a real description
  already existed, promoted to *be* the description where it was the only text.

> **Start a FRESH ux-designer for round 5.** This agent's context is very large after
> four rounds (~450k tokens on the last one alone). Point a new one at
> `mockup/place-detail-modal.html`, `mockup/DESIGN-SYSTEM.md` and this file instead of
> resuming it.

---

## Migrations — three paths, none applied

The repo's rule (`db.ts:42-46`, `exportImport.ts:35-39`) is that the JSON import path
and the in-place IndexedDB upgrade **share one transform function**. Follow it.

1. **Dexie `version(3)`** — copy `note` → `description`, delete `note`, backfill
   `updatedAt`. No `.stores()` change; these fields need no index.
2. **Snapshot `version: 3`** + `migrateSnapshotV2ToV3`, wired into `parseSnapshot`'s
   dispatch. v1 → v2 → v3 must still chain for an old export.
3. **`supabase/migrations/0002_*.sql`** — add `description`, `self_review`,
   `updated_at`; backfill from `note`; drop `note`; **and `create or replace` the entire
   `import_trip_snapshot` function**, which enumerates place columns explicitly at
   `0001_init.sql:171-178`. Miss that and JSON imports silently drop the new fields with
   no error.

> **`0001_init.sql` is already applied to the live project. `0002` is NOT.**
> It must be applied manually via the Supabase dashboard after review. No agent should
> run DDL against the live project.

---

## Verification (none of this has been done)

- `npm run build`, `npm run lint`, `npm test` all green. ~215 tests; the
  `RouteStrip.tsx` `only-export-components` lint warning is pre-existing — don't chase it.
- Migration tests: `dbMigration.test.ts` shows the pattern — seed a raw old-version
  Dexie, then assert the real repository reads back migrated values.
- **Manual, in a real browser** (cannot be done headless):
  - Write a review, close the modal, reload the page — draft still there.
  - Write a review offline, then save when back online.
  - Conflict: edit the same place on two devices, save both, confirm both texts survive
    with a correctly-rendered divider (not a raw sentinel).
  - Paste a Google Maps URL for a known Chinese landmark — **does the pin land on the
    building?** This is the GCJ-02 test.
  - Delete a place with a written review; confirm the dialog says what's being lost.
  - Budget: cents render correctly in all 6 `fmtMoney` call sites, both themes.

---

## Related

- `mockup/DESIGN-SYSTEM.md` — **new this session.** Tokens, semantic colour vocabulary,
  the mandatory `-soft-ink` contrast rule, component patterns, breakpoints, a11y floor.
  Wired into `CLAUDE.md` and the ux-designer / ux-reviewer / frontend-engineer agent
  defs. Read it before any UI work.
- `mockup/place-detail-modal.html` — the approved design.
- `mockup/place-detail-inline.html` — **rejected, delete it.**

## Deferred, deliberately

- Draggable pins (see item 8's consequence)
- Folding `note`'s conceptual role back in if `description` proves too heavy for the
  card excerpt
- Whether the Add Place flow should offer long-form writing at all
