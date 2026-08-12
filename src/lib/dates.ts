// Date formatting helpers. All trip dates are ISO "YYYY-MM-DD" strings parsed
// as *local* calendar dates (never through `new Date(iso)` directly, which
// would interpret them as UTC midnight and can shift the displayed day).

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

/** `iso` shifted by `n` calendar days (negative shifts backwards). Goes
 *  through the local-date convention above rather than adding milliseconds,
 *  so a DST boundary can't land the result on the previous evening. */
export function addDaysISO(iso: string, n: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier).
 *  Computed on UTC-normalised midnights so a DST transition inside the range
 *  can't produce a 23- or 25-hour day and round the count off by one. */
export function daysBetweenISO(from: string, to: string): number {
  const a = parseISODate(from);
  const b = parseISODate(to);
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86_400_000);
}

/** Every ISO date in `[from, to)`, ascending. Empty when `to <= from`. */
export function datesBetweenISO(from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = 0, n = daysBetweenISO(from, to); i < n; i++) {
    out.push(addDaysISO(from, i));
  }
  return out;
}

/** "Mon 10" */
export function fmtWeekdayDay(iso: string): string {
  const d = parseISODate(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
}

/** "Mon 10 Nov" */
export function fmtWeekdayDayMonth(iso: string): string {
  const d = parseISODate(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "10 Nov" */
export function fmtDayMonth(iso: string): string {
  const d = parseISODate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "9/11", "10/11" — bare numeric day/month, no leading zeros. Phase 6 item 3:
 *  the map day quick-nav's mobile-only short form of the full `dayLabel`
 *  ("Day 2 · Mon 9 Nov"), which elongates and breaks the chip row at narrow
 *  widths. Same parse-as-local-date convention as every other formatter here. */
export function fmtShortNumeric(iso: string): string {
  const d = parseISODate(iso);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/** "Sat 7 – Mon 9 Nov" — city arrival/departure range, mockup style. */
export function fmtRange(startIso: string, endIso: string): string {
  return `${fmtWeekdayDay(startIso)} – ${fmtWeekdayDayMonth(endIso)}`;
}

/** "7–9 Nov" — compact form used in the route strip. */
export function fmtCompactRange(startIso: string, endIso: string): string {
  const a = parseISODate(startIso);
  const b = parseISODate(endIso);
  if (a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}`;
  }
  return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
}
