// Initial-letter avatar for a trip member. Extracted from BudgetPanel in
// Phase 6 because it now has three consumers across two features: the
// companions list (which moved into the Settings modal, item 6), the Budget
// tab's By-person card, and an expense row's "Paid by".
//
// COLOUR (Phase 6 item 8): `color` is a BARE `--m-*` token family name
// without the leading `--` (e.g. 'm-denim'), exactly as stored on
// `TripMember.color` — see that field's contract in schema.ts. It is drawn
// from a small FIXED swatch set, never a free colour, because only a
// curated set can be pre-verified for `-soft-ink` contrast in both themes
// (see mockup/DESIGN-SYSTEM.md's "Member colour palette").
//
// The soft/soft-ink pairing here is the `-soft-ink` rule from DESIGN-SYSTEM
// §2, which exists because real contrast failures have shipped: the swatch
// hue itself is used only for the ring (a decorative border), while the
// TEXT sits on `-soft` and takes `-soft-ink`. Never put `--m-x` directly on
// `--m-x-soft` as text.
//
// `undefined` means "no colour assigned" — the neutral default below, never
// a guessed or hash-derived swatch. Deliberate: a member without a chosen
// colour must look unset, not silently auto-assigned, or the picker's
// "no selection" state becomes unreadable.

interface MemberAvatarProps {
  name: string;
  /** Bare `--m-*` family name (no leading `--`), or undefined for unset. */
  color?: string;
  size?: 'xs';
}

export function MemberAvatar({ name, color, size }: MemberAvatarProps) {
  const initial = (name.trim().charAt(0) || '?').toUpperCase();
  const styled = color
    ? {
        background: `var(--${color}-soft)`,
        color: `var(--${color}-soft-ink)`,
        borderColor: `var(--${color})`,
      }
    : undefined;
  return (
    <span
      className={`member-avatar${size ? ` member-avatar-${size}` : ''}${color ? ' has-colour' : ''}`}
      style={styled}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
