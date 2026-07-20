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

---

## 8. Design workflow

Non-trivial UI goes through `mockup/` before implementation: **ux-designer →
ux-reviewer → frontend-engineer / backend-impl → code-reviewer → qa-tester**
(see `.claude/agents/`).

Mockups are self-contained static HTML — inline CSS/JS, no external assets or CDN links —
and must demonstrate empty *and* filled states, plus a real ~390px phone rendering.
