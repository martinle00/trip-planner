# Design System — China Trip Planner

Read this **before** designing, reviewing or implementing any UI in this project.

**`src/index.css` is the source of truth.** This document explains the *reasoning* that
raw CSS can't carry — what each token means, when you're required to use which one, and
which conventions are load-bearing. If the two ever disagree, the CSS wins and this file
is wrong; fix it.

`mockup/mockup.html` is the visual spec the app is built to match. Tokens in
`src/index.css` were ported from it.

---

## 1. The look

Warm paper, not grey chrome. Cream/off-white backgrounds (`--paper: #FAF7F2`), warm
brown-black ink, a Chinese-red accent, and a serif display face for titles against a
system sans for body text. Every shadow is tinted warm (`rgba(60,40,20,…)`), never
neutral black. Generous pill radii (`--radius-full`) on interactive chrome.

It should feel like a travel journal, not a dashboard.

---

## 2. Tokens

All tokens are CSS custom properties on `:root`. **Never hardcode a hex value in a
component.** If you need a colour that isn't here, that's a design decision — raise it,
don't invent it.

### Surfaces & text

| Token | Role |
| --- | --- |
| `--paper` | App background. The base layer. |
| `--paper-raised` | Cards, modals, popovers — anything sitting *above* the page. |
| `--paper-sunk` | Inset wells: input backgrounds, hover states, secondary chips. |
| `--ink` | Primary text. |
| `--ink-soft` | Secondary text, metadata, labels. |
| `--ink-faint` | Tertiary — placeholders, disabled, uppercase field labels. |
| `--line` | Default borders and separators. |
| `--line-strong` | Emphasised borders, input outlines, dashed affordances. |

Three surface levels only. Don't stack a raised card inside a raised card — use
`--paper-sunk` for the inner well.

### Semantic colour vocabulary

This is the part most often got wrong. Each colour **means something**; using one
decoratively breaks the language.

| Token | Means | Used for |
| --- | --- | --- |
| `--accent` (Chinese red) | Primary action, current selection | Primary buttons, active route node, focus rings, error rate-state |
| `--jade` (green) | Paid / done / positive / confirmed | Paid toggle, category bars, "Synced" pill, save confirmations |
| `--gold` (amber) | Owed / pending / stale / needs attention | Unpaid, missing exchange rate, offline banner |
| `--ink` | Neutral emphasis | Active tab background (light theme) |

Each has a `-soft` background variant (`--accent-soft`, `--jade-soft`, `--gold-soft`)
for tinted pills and callouts.

### ⚠️ The `-soft-ink` rule — non-negotiable

**Never put `--jade`, `--gold` or `--accent` as *text* on their own `-soft` background.**
They fail WCAG AA. Use the `-soft-ink` companion:

```css
/* WRONG — --gold on --gold-soft is ~3.3:1, fails AA for body text */
.offline-banner{ background:var(--gold-soft); color:var(--gold); }

/* RIGHT */
.offline-banner{ background:var(--gold-soft); color:var(--gold-soft-ink); }
```

Measured ratios that drove this: `--jade` on `--jade-soft` is **4.07:1** (fails the
4.5:1 needed for 12px/600 text); `--gold` on `--gold-soft` is **~3.3:1**.

The rule in one line: **`--jade`/`--gold` are reserved for dots, borders and decorative
fills. `--jade-soft-ink`/`--gold-soft-ink` are for text and icons.**
`--accent-soft-ink` follows the same pattern.

### Two categorical palettes — keep them apart

- **Day palette** — `--d-blue --d-amber --d-moss --d-plum --d-teal --d-terra --d-indigo
  --d-olive --d-grey`. Assigned per itinerary day; drives map pin colour, day dots and
  the tinted left border on `.assign-select`.
- **City-identity palette** — `--d-sky --d-rose --d-violet` (plus reuse from above).
  Places tab section headers and city dots only.

These were deliberately chosen to **avoid the hue zones owned by `--jade` (paid) and
`--gold` (owed)** so the categorical and semantic vocabularies never visually collide.
If you add a categorical colour, respect that constraint.

### Member colour palette (`--m-*`) — Phase 6

A **third** categorical pool, added for `TripMember.color?`. Purpose is narrower than
the day/city palettes above: it colours the **member avatar ring and member chip
only**. It is never used for the By-person budget bar, which stays `--jade` — see
§7 and the rule below.

Six fixed swatches, pick-one-of-N (not a free colour picker — an arbitrary user hue
can't be pre-verified against the `-soft-ink` rule):

| Token | Hue (°) | Light `base` | Light `-soft` | Light `-soft-ink` | Dark `base`/`-soft-ink` | Dark `-soft` |
| --- | --- | --- | --- | --- | --- | --- |
| `--m-chartreuse` | 78 | `#8FAE47` | `#EAF1DA` | `#506321` | `#AFCA72` | `#293215` |
| `--m-denim` | 221 | `#4768AE` | `#DAE1F1` | `#213663` | `#728ECA` | `#151E32` |
| `--m-periwinkle` | 253 | `#5D47AE` | `#DFDAF1` | `#302163` | `#9281CF` | `#1C1532` |
| `--m-orchid` | 289 | `#9B47AE` | `#EDDAF1` | `#572163` | `#BD7ACC` | `#2D1532` |
| `--m-berry` | 326 | `#AE4781` | `#F1DAE7` | `#632147` | `#CA72A4` | `#321526` |
| `--m-sand` | 40 (desaturated) | `#847E71` | `#E8E6E3` | `#403B30` | `#A8A194` | `#272520` |

**Hue selection method.** The wheel is already dense — `--accent`, `--jade`, `--gold`
and the nine `--d-*`/city tokens occupy roughly one hue every 20–35°. Rather than
eyeball six more, every candidate hue was checked for angular clearance from all
existing tokens, with two bands *excluded outright* regardless of clearance:
~350–20° (`--accent`) and ~20–55° (`--gold`/`--d-amber`) — the two zones the rule
above says must stay clear — plus ~140–185° (`--jade`/`--d-teal`). `--m-chartreuse`
(78°), `--m-denim` (221°), `--m-periwinkle` (253°) and `--m-orchid` (289°) all land
in genuinely open gaps (≥20° clearance both sides). `--m-berry` (326°, ~17° from
`--d-plum` at 309° and ~14° from `--d-rose` at 340°) is the tightest saturated pick —
the best of a crowded neighbourhood, not a wide-open slot.

`--m-sand` is the deliberate exception: its hue angle (40°) sits *inside* the excluded
gold band. It's included anyway because at its actual saturation (≤14%, versus
`--gold`'s ~60%+) it reads as a neutral warm taupe, not amber — the hue-number
collision doesn't survive contact with the eye. Verified side-by-side in the mockup
swatch grid (`mockup/phase6-nav-settings-expenses.html` §8), not just asserted here.
Every avatar/chip also always prints the member's name alongside the colour (same
posture Phase 5 already took when it shipped members with *no* colour at all) — colour
is reinforcement, never the sole signifier.

**Contrast, measured per token, both themes** (`-soft-ink` text on `-soft` fill):

| Token | Light ratio | Dark ratio |
| --- | --- | --- |
| `--m-chartreuse` | 5.75:1 | 7.38:1 |
| `--m-denim` | 9.04:1 | 5.10:1 |
| `--m-periwinkle` | 10.13:1 | 5.21:1 |
| `--m-orchid` | 8.82:1 | 5.39:1 |
| `--m-berry` | 8.66:1 | 5.08:1 |
| `--m-sand` | 8.94:1 | 5.97:1 |

All clear the 4.5:1 AA floor in both themes, but **not by a uniform margin, and that's
the point of measuring rather than assuming**: every dark-theme `base`/`-soft-ink` was
built from the same HSL recipe (hue varies, saturation/lightness held constant per
role) as a starting point, and two of six — `--m-periwinkle` and `--m-orchid` —
initially computed under 4.5:1 (as low as 4.38:1) at that shared lightness. HSL
lightness isn't perceptually uniform across hues (a blue-violet at L65% is not as
luminant as a yellow-green at L65% — green dominates the luminance formula's weights).
Both were nudged 2–4 points lighter in dark mode specifically, and only those two,
until each independently measured ≥5:1. **Never carry a `-soft`/`-soft-ink` pair
forward from a formula without checking the actual ratio** — this is the second time
in this document a plausible-looking recipe produced a token that failed AA (see the
raw jade-on-jade-soft example in the rule above) and had to be corrected against the
real numbers.

**The rule this section exists to state:** `--m-*` colours the avatar ring and the
member chip. It never touches the By-person bar fill (stays `--jade` — "money already
accounted for," same as By-category) and it never becomes body text on its own
`-soft` background without going through the `-soft-ink` companion, same as every
other soft-tinted token in this document.

### Radius, shadow, type

```
--radius-sm: 8px     inputs, small controls
--radius-md: 14px    cards, modals-on-desktop, wells
--radius-lg: 20px    large containers, map, bottom-sheet top corners
--radius-full: 999px pills, chips, buttons, tags

--shadow-sm  resting cards          --shadow-md  hover / floating panels
--shadow-lg  modals only
```

- `--font-display` — serif (Songti SC / Noto Serif SC / Georgia). **Titles only:**
  trip title, panel titles, city headings, modal titles.
- `--font-body` — system sans. Everything else.
- `--font-mono` — **all numbers the user compares or scans**: money, times, coordinates,
  rate chips, badges. Pair with `.tabular` (`font-variant-numeric: tabular-nums`) for
  columns of figures.

Base body size is **15px / 1.5**. Common steps: 11px uppercase labels, 12.5px secondary,
13.5px controls, 14.5px card titles.

---

## 3. Theming — light and dark are both mandatory

Three parallel declarations, and **all three must be updated together**:

1. `:root{…}` — light defaults
2. `@media (prefers-color-scheme: dark){ :root{…} }` — system preference
3. `:root[data-theme="dark"]` / `:root[data-theme="light"]` — explicit user override,
   which must beat the media query in both directions

Dark isn't an inversion — it's a hand-tuned warm-dark palette. Accent lightens to
`#E2735F`, and `--tab-active-bg` flips from `--ink` to `--accent` because a near-black
active tab disappears on a dark background.

Because everything is tokenised, **a correctly built component themes for free.** If
you find yourself writing a dark-mode override for a new component, you hardcoded a
colour somewhere.

---

## 4. Component patterns

Reuse these. Adding a second way to do something one of these already does is the most
common review rejection.

**Buttons** — `.btn` base, then `.btn-primary` (accent fill), `.btn-ghost` (transparent),
`.btn-sm`, `.btn-block`, `.btn-icon` (38px circle). All pill-radius, `scale(.97)` on
`:active`.

**`.icon-btn`** — 26px bare icon button for in-card actions (delete, reorder). Note:
26px is below the 44px touch-target guideline; it's accepted for secondary destructive
actions in dense lists, but **don't use it for a primary action.**

**`.card`** — `--paper-raised` + `--line` border + `--radius-md` + `--shadow-sm`. The
universal container.

**`.chip`** — filter toggles, pill-shaped, `.active` inverts to ink-on-paper.
**`.tag`** — 11px/700 non-interactive metadata label.
**`.status-pill`** — state with a leading dot.

**Modal** — `.overlay` + `.modal`. **Mobile-first bottom sheet:** below 720px it's
bottom-anchored, full-width, rounded top corners only, sliding up. At ≥720px it becomes
a centred dialog with `max-width:620px`. `src/components/Modal.tsx` handles overlay
click, Escape, focus trap and focus restore — use it, don't rebuild it.

**Inline `.add-form`** — always mounted, `display:none` until `.open`. The established
pattern for add/edit forms embedded in a panel (see the Budget tab).

**Empty states** — dashed `--line-strong` border, `--paper-sunk` fill, centred icon at
`opacity:.5`, a bold line and a `max-width:~30ch` explanation. Never a bare "No items".

**Tinted left border as status** — a 4px `border-left` in a categorical colour, solid
when assigned, `dashed` when unassigned/wishlist. Used by `.city-section` and
`.assign-select`. This is the app's shorthand for "which day/city does this belong to".

**Confirmation** — `.flash-confirm`, a brief jade box-shadow pulse. Preferred over toasts.

---

## 5. Layout

- Shell maxes at **1180px**, centred.
- Breakpoints: **480 / 600 / 640 / 720 / 860 / 1000px**. Reuse these; don't add new ones.
- Places grid: 1 col → 2 at 640 → 3 at 1000. Summary grid: 1 → 2 at 480 → 3 at 640.
- **Sticky stacking is coordinated by measured JS variables** — `--topbar-h`,
  `--tabbar-h`, `--itnav-h`, set by `src/hooks/useStickyOffsets.ts` and composed into
  `--sticky-stack`. Anything new that sticks or needs `scroll-margin-top` must use these,
  not a magic number.
- Standard page padding 16px; card padding 12–16px.

### Mobile-succinct

**Rule: below the 720px breakpoint, trip chrome (nav, identity, secondary labels — not
content) shows the minimum needed to stay usable, not the fullest form that fits.**
Phone screens don't get a scroll-triggered "condense" escape hatch the way desktop does
(the condensing header in `App.tsx`/`useCondenseHeader.ts` is gated `>=720px`) — mobile's
succinct form has to be the *permanent* default, since there's no larger state to reveal
later by scrolling. Practical consequences, both introduced in Phase 5:

- **Topbar utility row** (Export/Import/sync pill/Auto-plan/Sign out) collapses to
  icon-only unconditionally below 720px — the exact same `.btn-collapsible` /
  `.is-collapsed` visual treatment the desktop condense state already uses, just gated by
  `@media (max-width:719px)` instead of a scroll-driven class. One mechanism, two
  triggers — see `mockup/phase5-mobile-and-expenses.html` item 1.
- **Route-strip nodes** drop to a single-line, city-name-only pill below the same
  threshold (full two-line "city + date range" node is a desktop-only luxury) — see that
  file's item 3.

`719px`, not a new breakpoint: it's the `max-width` complement of the `720px` entry
already listed above, matching the existing mobile/desktop split (bottom tab dock,
condensing-header gate) so "mobile mode" stays one threshold across the app, not several.

**The a11y catch:** succinct ≠ deleted. If the hidden content is (or is part of) an
interactive element's *only* accessible name — e.g. a route-node button whose name comes
entirely from its own visible text (city + date) — dropping it needs the
`.visually-hidden`-style clip technique (stays in the DOM, stays in the accessible name),
not `display:none` (removes it for AT users too, unless there's a specific, stated reason
that's fine — see the desktop `is-condensed` route-date treatment in `src/index.css`,
which does use `display:none` deliberately, with that reasoning written down in a code
comment next to it). Never justify a `display:none` on "it's just secondary text" alone —
say why AT users specifically don't need it either, or clip it.

---

## 6. Accessibility — the floor

- **Contrast:** WCAG AA. Obey the `-soft-ink` rule in §2.
- **Focus:** the global `:focus-visible` ring is a 2px accent outline with 2px offset.
  Never remove it without an equally visible replacement.
- **Reduced motion:** a global `prefers-reduced-motion` rule flattens all animation to
  ~0ms. Beware: if an element's *visibility* depends on an animation, it will break. See
  the `.sync-indicator` fade, which is deliberately gated behind
  `@media (prefers-reduced-motion: no-preference)` so reduced-motion users get a legible
  static chip instead of an invisible one.
- Icon-only controls need `aria-label`. Live regions use `role="status"`.
- Hide text with `.visually-hidden` (stays in the a11y tree), **not** `display:none`.

---

## 7. Rules that keep getting broken

1. **No hardcoded colours.** Token or nothing.
2. **Obey the `-soft-ink` rule.** It exists because real contrast failures shipped.
3. **Mobile first.** This is an installed PWA; the phone is the primary target. Design
   at 390px, then widen. Modals are bottom sheets on phones.
4. **Both themes, every time.**
5. **Mono for scannable numbers**, serif for titles, sans for everything else.
6. **Don't invent a second pattern** for something in §4.
7. **Semantic colours mean things.** Jade is not "a nice green" — it means paid/done.
8. **Comment the *why*.** The stylesheet documents rationale, not restatement of the
   rule. Match that standard.
9. **Mobile = as succinct as possible, but clip, don't strip.** See §5's "Mobile-succinct"
   subsection. Dropping secondary chrome below 720px is correct; dropping it from the
   accessible name too needs its own justification, not an assumption.

---

## 8. Design workflow

Non-trivial UI goes through `mockup/` before implementation: **ux-designer →
ux-reviewer → frontend-engineer / backend-impl → code-reviewer → qa-tester**
(see `.claude/agents/`).

Mockups are self-contained static HTML — inline CSS/JS, no external assets or CDN links —
and must demonstrate empty *and* filled states, plus a real ~390px phone rendering.
