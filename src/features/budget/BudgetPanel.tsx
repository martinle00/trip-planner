// Budget tab — every expense is tracked in whatever currency it was paid
// in; every total below is "live-converted" on every render from the
// trip's currently stored `rates` (see lib/exchangeRates.ts and the
// Trip.rates doc comment in data/schema.ts). This is the redesigned,
// approved multi-currency Budget UI (mockup/mockup.html's Budget section).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTripStore } from '../../store/useTripStore';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { Icon } from '../../components/Icons';
import { MemberAvatar } from '../../components/MemberAvatar';
import { Modal } from '../../components/Modal';
import { BackToTop } from '../../components/BackToTop';
import type { Expense } from '../../data/schema';
import { DAY_PALETTE, EXPENSE_CATEGORIES, defaultCurrencyForCity, orderedCities } from '../../lib/tripView';
import { CURRENCIES, convert, currencySymbol } from '../../lib/exchangeRates';

function categoryColor(category: string): string {
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  return `var(${DAY_PALETTE[hash % DAY_PALETTE.length]})`;
}

function fmtMoney(amount: number, currency: string): string {
  return `${currencySymbol(currency)}${Math.round(amount).toLocaleString('en-AU')}`;
}

/** Per-unit rate legend ("1 CNY ≈ A$0.21") — most pairs are sub-1 in
 *  magnitude, so 2dp normally; step up to 4dp only when 2dp would otherwise
 *  round all the way to zero (e.g. 1 JPY ≈ A$0.0102). */
function fmtRate(amount: number, homeCurrency: string): string {
  const decimals = Math.abs(amount) < 0.005 ? 4 : 2;
  return `${currencySymbol(homeCurrency)}${amount.toFixed(decimals)}`;
}

function exclusionNote(count: number): string | null {
  if (count <= 0) return null;
  return `${count} expense${count === 1 ? '' : 's'} excluded (no rate)`;
}

/** Compact form of the same "no rate" exclusion signal, for the narrow
 *  `.cat-amt-note` slot shared by the By-category and By-person cards (same
 *  convention as their existing "N currencies" note) — PHASE5 trap #4: a
 *  no-rate expense is EXCLUDED from a member's bar total, never silently
 *  summed as 0, and this note is what keeps that exclusion visible instead
 *  of a bar total that quietly falls short with no explanation. */
function exclusionNoteShort(count: number): string | null {
  if (count <= 0) return null;
  return `${count} excl. (no rate)`;
}

type RatesState = 'loading' | 'error' | 'offline' | 'never' | 'stale' | 'fresh';

/** Rates older than this (but not "never refreshed") are flagged stale —
 *  still shown/used, just called out as possibly out of date. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** "2 hours ago" / "3 days ago" / "just now" — coarse, minute-granularity
 *  relative time for the rates-freshness status line. Not a ticking clock:
 *  only recomputed when the component actually re-renders. */
function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 45) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function ratesStatusMessage(state: RatesState, relativeUpdated: string | undefined): string {
  switch (state) {
    case 'loading':
      return 'Fetching latest rates…';
    case 'error':
      return relativeUpdated
        ? `Couldn’t refresh — still showing rates from ${relativeUpdated}`
        : "Couldn’t refresh — still using built-in reference rates";
    case 'offline':
      return relativeUpdated
        ? `You’re offline — showing last-known rates from ${relativeUpdated}`
        : "You’re offline — using built-in reference rates";
    case 'never':
      return 'No rates fetched yet — using built-in reference rates';
    case 'stale':
      return `Rates updated ${relativeUpdated} — may be out of date`;
    case 'fresh':
      return relativeUpdated ? `Rates updated ${relativeUpdated}` : 'Rates updated';
  }
}

interface BudgetPanelProps {
  /** Opens the Settings modal — the home-currency control lives there now
   *  (Phase 6 item 6), so this tab needs a way to point at it. */
  onOpenSettings: () => void;
}

export function BudgetPanel({ onOpenSettings }: BudgetPanelProps) {
  const trip = useTripStore((s) => s.trip);
  const expenses = useTripStore((s) => s.expenses);
  const refreshRates = useTripStore((s) => s.refreshRates);
  const ratesLoading = useTripStore((s) => s.ratesLoading);
  const ratesError = useTripStore((s) => s.ratesError);
  const addExpense = useTripStore((s) => s.addExpense);
  const updateExpense = useTripStore((s) => s.updateExpense);
  const removeExpense = useTripStore((s) => s.removeExpense);
  const online = useOnlineStatus();

  const [formOpen, setFormOpen] = useState(false);
  /** `null` = the form is in ADD mode; an id = editing that expense in
   *  place (Phase 5 item 4 — one inline form, two modes, not a second
   *  modal — see DESIGN-SYSTEM.md §4's `.add-form` entry). */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>(trip?.homeCurrency ?? 'AUD');
  const [currencyManual, setCurrencyManual] = useState(false);
  const [label, setLabel] = useState('');
  /** The expense's "Attach to" city, or '' for "Whole trip" (Phase 6 item 9 —
   *  replaces the removed per-day `dayId`). */
  const [cityField, setCityField] = useState('');
  const [note, setNote] = useState('');
  const [paidByField, setPaidByField] = useState('');
  /** Phase 6 item 11 — "this is already paid" on the ADD form. The form used
   *  to always write `paid: false`, forcing a second click on the row's
   *  toggle for anything logged after the fact (which is most of them). */
  const [paidField, setPaidField] = useState(false);
  /** The expense whose payer is being asked for, after toggling it TO paid
   *  (item 11). `null` = no prompt open. */
  const [payerPromptFor, setPayerPromptFor] = useState<Expense | null>(null);
  /** Phase 6 item 10 — who an expense is shared across. `coversEveryone`
   *  true is the default and maps to `coversMemberIds: undefined`. */
  const [coversEveryone, setCoversEveryone] = useState(true);
  const [coversIds, setCoversIds] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  // Post-refresh "totals just moved" pulse on the summary cards — only on a
  // successful refresh (never on a failed one), and only reacting to a real
  // loading->settled transition rather than any store change.
  const [flash, setFlash] = useState(false);
  const wasLoadingRef = useRef(false);
  const flashTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = ratesLoading;
    if (wasLoading && !ratesLoading && !ratesError) {
      setFlash(true);
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(() => setFlash(false), 800);
    }
  }, [ratesLoading, ratesError]);
  useEffect(
    () => () => {
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const budget = useMemo(() => {
    const byCurrency = new Map<string, number>();
    const byCategory = new Map<string, { amt: number; currencies: Set<string> }>();
    let total = 0;
    let paid = 0;
    let excludedTotal = 0;
    let excludedPaid = 0;
    let excludedUnpaid = 0;
    if (trip) {
      for (const e of expenses) {
        byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.amount);
        const converted = convert(e.amount, e.currency, trip);
        if (converted === undefined) {
          excludedTotal += 1;
          if (e.paid) excludedPaid += 1;
          else excludedUnpaid += 1;
          continue;
        }
        total += converted;
        if (e.paid) paid += converted;
        const cat = byCategory.get(e.category) ?? { amt: 0, currencies: new Set<string>() };
        cat.amt += converted;
        cat.currencies.add(e.currency);
        byCategory.set(e.category, cat);
      }
    }
    const categories = [...byCategory.entries()]
      .map(([cat, v]) => ({ category: cat, amount: v.amt, currencyCount: v.currencies.size }))
      .sort((a, b) => b.amount - a.amount);
    const rateChips = trip
      ? [...byCurrency.keys()]
          .filter((c) => c !== trip.homeCurrency)
          .sort()
          .map((c) => ({ currency: c, value: convert(1, c, trip) }))
          .filter((c): c is { currency: string; value: number } => c.value !== undefined)
      : [];
    return {
      total,
      paid,
      toPay: total - paid,
      excludedTotal,
      excludedPaid,
      excludedUnpaid,
      byCurrency,
      categories,
      rateChips,
    };
  }, [expenses, trip]);

  // Phase 5 item 6 — per-person totals. Reuses `convert()` exactly like the
  // summary/category totals above (PHASE5 trap #4: never sum raw amounts
  // across currencies) and excludes no-rate expenses from a member's bar the
  // same way, with the same visible exclusion note rather than a silent
  // drop. Trap #3: an expense whose `paidBy` no longer resolves to any
  // current member (the member was removed) is neither attributed to a
  // member's bar NOR silently ignored — it's counted separately as
  // `orphanCount` and surfaced with its own note below the bars.
  const byPerson = useMemo(() => {
    const members = trip?.members ?? [];
    const buckets = new Map<string, { sum: number; excluded: number }>();
    for (const m of members) buckets.set(m.id, { sum: 0, excluded: 0 });
    let orphanCount = 0;
    if (trip) {
      for (const e of expenses) {
        if (!e.paidBy) continue;
        const bucket = buckets.get(e.paidBy);
        if (!bucket) {
          orphanCount += 1;
          continue;
        }
        const converted = convert(e.amount, e.currency, trip);
        if (converted === undefined) {
          bucket.excluded += 1;
          continue;
        }
        bucket.sum += converted;
      }
    }
    const rows = members.map((m) => ({ member: m, ...(buckets.get(m.id) ?? { sum: 0, excluded: 0 }) }));
    return { rows, orphanCount };
  }, [expenses, trip]);

  // Sorted by CONVERTED home-currency amount (not raw amount — mixing raw
  // amounts across currencies isn't a meaningful order). No-rate expenses
  // sort to the end since they have no comparable converted value.
  const sortedExpenses = useMemo(() => {
    if (!trip) return expenses;
    return [...expenses].sort((a, b) => {
      const ca = convert(a.amount, a.currency, trip);
      const cb = convert(b.amount, b.currency, trip);
      if (ca === undefined && cb === undefined) return 0;
      if (ca === undefined) return 1;
      if (cb === undefined) return -1;
      return cb - ca;
    });
  }, [expenses, trip]);

  if (!trip) return null;

  const ratesState: RatesState = ratesLoading
    ? 'loading'
    : ratesError
      ? 'error'
      : !online
        ? 'offline'
        : trip.ratesUpdatedAt === undefined
          ? 'never'
          : Date.now() - new Date(trip.ratesUpdatedAt).getTime() > STALE_THRESHOLD_MS
            ? 'stale'
            : 'fresh';
  const relativeUpdated = trip.ratesUpdatedAt ? formatRelativeTime(trip.ratesUpdatedAt) : undefined;
  const statusMessage = ratesStatusMessage(ratesState, relativeUpdated);

  function resetFormFields() {
    setEditingId(null);
    setCategory(EXPENSE_CATEGORIES[0]);
    setAmount('');
    setLabel('');
    setCityField('');
    setNote('');
    setPaidByField('');
    setPaidField(false);
    setCoversEveryone(true);
    setCoversIds([]);
    setCurrency(trip!.homeCurrency);
    setCurrencyManual(false);
  }

  function openForm() {
    resetFormFields();
    setFormOpen(true);
  }

  /** Opens the same inline form pre-filled to edit an existing expense — the
   *  heading/submit label swap to "Editing … / Save changes" in the JSX
   *  below based on `editingId`. PHASE5 trap #3: if `expense.paidBy` no
   *  longer resolves to a current member (the member was removed), the
   *  "Paid by" select opens on "— none —" rather than an orphaned id with no
   *  matching option — resaving without touching it clears the dangling
   *  reference; leaving it untouched (never opening this form) leaves the
   *  orphaned id exactly as it was, still rendering as "—" on the row. */
  function openEdit(expense: Expense) {
    setEditingId(expense.id);
    setCategory(expense.category);
    setAmount(String(expense.amount));
    setCurrency(expense.currency);
    setCurrencyManual(true);
    setLabel(expense.label);
    // Orphan-filtered, matching the `paidBy` prefill below: a city that no
    // longer matches any current `Trip.cities` entry opens as "Whole trip"
    // rather than as a value with no corresponding <option>. Without this the
    // select VISUALLY falls back to "Whole trip" while `cityField` still held
    // the stale name, and re-picking the already-shown option fires no
    // onChange — so there was no way to clear it from this form at all.
    // Re-saving now clears the dangling reference; never opening the form
    // leaves it untouched, still rendered as-is on the row by `cityMeta`.
    setCityField(orderedCities(trip).some((c) => c.name === expense.city) ? (expense.city ?? '') : '');
    setNote(expense.note ?? '');
    setPaidField(expense.paid);
    // Absent means everyone (the field's contract), so only a non-empty
    // list puts the form into subset mode. Orphaned ids (member removed)
    // are filtered out here rather than resurrected into the picker.
    const covers = (expense.coversMemberIds ?? []).filter((id) => (trip?.members ?? []).some((m) => m.id === id));
    setCoversEveryone(covers.length === 0);
    setCoversIds(covers);
    const members = trip?.members ?? [];
    setPaidByField(expense.paidBy && members.some((m) => m.id === expense.paidBy) ? expense.paidBy : '');
    setFormOpen(true);
    window.setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }

  function closeForm() {
    resetFormFields();
    setFormOpen(false);
  }

  /** Header "Add expense" button: switches to a fresh add form. Toggles
   *  closed on a second click ONLY while already open in plain add mode —
   *  clicking it while mid-edit instead resets to add mode (rather than
   *  just closing), so it's never a no-op click from the user's point of
   *  view. */
  function handleHeaderAddClick() {
    if (formOpen && editingId === null) {
      closeForm();
    } else {
      openForm();
    }
  }

  /** Phase 6 item 9: keyed off the city directly. This used to take a day id
   *  and look that day up purely to find its city — dropping `Expense.dayId`
   *  removes the indirection entirely. '' means "Whole trip", for which
   *  `defaultCurrencyForCity(undefined, …)` yields the trip's own default. */
  function handleCityChange(name: string) {
    setCityField(name);
    if (!currencyManual) {
      setCurrency(defaultCurrencyForCity(name || undefined, trip!));
    }
  }

  function handleCurrencyChange(code: string) {
    setCurrency(code);
    setCurrencyManual(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const amt = Number.parseFloat(amount);
    if (!label.trim() || !Number.isFinite(amt)) return;
    const shared = {
      category,
      label: label.trim(),
      amount: amt,
      currency,
      city: cityField || undefined,
      note: note.trim() || undefined,
      paidBy: paidByField || undefined,
      paid: paidField,
      // Phase 6 item 10. `undefined` means "everyone" — never an empty
      // array, which is the degenerate "covers nobody" the field's contract
      // treats as unreachable from this UI. The `.length` guard is the second
      // line of defence behind the interaction rule below (deselecting the
      // last person snaps back to Everyone); `parseSnapshot` is the third,
      // for data arriving by import that never passes through here at all.
      coversMemberIds: coversEveryone || coversIds.length === 0 ? undefined : coversIds,
    };
    if (editingId) {
      const existing = expenses.find((x) => x.id === editingId);
      if (existing) {
        await updateExpense({ ...existing, ...shared });
      }
    } else {
      await addExpense(shared);
    }
    closeForm();
  }

  /** Phase 6 item 11. Toggling an expense TO paid asks who paid it; toggling
   *  it back to unpaid never prompts (there is nothing to capture, and a
   *  prompt on the way down would be pure friction). Two degenerate cases
   *  the design review called out explicitly:
   *    - with NO members defined there is nothing to pick, so it marks paid
   *      immediately rather than trapping the user in an empty prompt;
   *    - an expense that already records a payer doesn't re-ask.
   *  The prompt itself commits the paid flag, so cancelling leaves the
   *  expense exactly as it was — unpaid, unchanged. */
  function handlePaidToggle(expense: Expense) {
    if (expense.paid) {
      void updateExpense({ ...expense, paid: false });
      return;
    }
    if (members.length === 0 || expense.paidBy) {
      void updateExpense({ ...expense, paid: true });
      return;
    }
    setPayerPromptFor(expense);
  }

  /** Commits the pending paid-toggle with the chosen payer. `undefined`
   *  means "mark paid without recording who" — a deliberate escape hatch, so
   *  the prompt can never become a hard gate on marking something paid. */
  function confirmPayer(payerId: string | undefined) {
    const pending = payerPromptFor;
    setPayerPromptFor(null);
    if (!pending) return;
    // Re-looked up by id rather than spreading the snapshot captured when the
    // prompt opened — same as `handleSubmit`'s edit branch, and for the same
    // reason: this app reconciles with the remote in the background, so an
    // expense can change underneath an open prompt, and spreading the stale
    // object would silently clobber that update.
    //
    // If the row is GONE, skip the write entirely — do NOT fall back to the
    // snapshot. `updateExpense` upserts unconditionally, so writing the stale
    // object wouldn't degrade to a no-op, it would RESURRECT an expense
    // deleted on another device mid-prompt, carrying a `paid: true` and a
    // payer that were never confirmed against anything real. The modal blocks
    // in-page deletes, but background sync can still drop the row underneath
    // it.
    const current = expenses.find((x) => x.id === pending.id);
    if (!current) return;
    void updateExpense({ ...current, paid: true, paidBy: payerId ?? current.paidBy });
  }

  function cityMeta(e: Expense): string {
    return e.city?.trim() ? e.city : 'Whole trip';
  }

  const currencyCount = budget.byCurrency.size;
  const totalNote = exclusionNote(budget.excludedTotal);
  const paidNote = exclusionNote(budget.excludedPaid);
  const toPayNote = exclusionNote(budget.excludedUnpaid);
  const summaryCardClass = `card summary-card${flash ? ' flash-confirm' : ''}`;
  const hasExpenses = expenses.length > 0;
  const members = trip.members ?? [];

  return (
    <section className="panel" id="panel-budget" role="tabpanel" aria-labelledby="tab-budget">
      <div className="panel-head">
        <h2 className="panel-title">Budget</h2>
        <span className="panel-hint">
          Every expense keeps its own currency &middot; totals shown in <strong>{trip.homeCurrency}</strong>
        </span>
      </div>

      {/* home currency (what every total below converts to) + live rate
          refresh. One card on purpose: everything under it visually depends
          on it. */}
      <div className="card rates-card">
        <div className="rates-row rates-row-home">
          {/* Phase 6 item 6: the home-currency SELECT moved into Settings —
              it's one-time setup, whereas the refresh/status/rate-chip row
              below is live per-view housekeeping tied to what's on screen,
              so only the setting moved and the housekeeping stayed. The
              value is still shown here because every total on this tab
              depends on it; it just isn't editable from here any more. */}
          <div className="rates-home-field">
            <span className="field-label">Home currency</span>
            <span className="rates-home-readonly tabular">{trip.homeCurrency}</span>
          </div>
          <span className="rates-home-hint">
            Summary, categories &amp; totals below all convert to this &middot;{' '}
            <button type="button" className="rates-home-link" onClick={onOpenSettings}>
              Change in Settings
            </button>
          </span>
        </div>

        {/* announces loading/success/error/offline transitions to screen
            readers — the visible state row only conveys state visually. */}
        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {statusMessage}
          {ratesState !== 'loading' && '.'}
        </p>
        <div className="rates-row rates-row-status">
          <div className={`rates-status-text${ratesState === 'error' ? ' state-error' : ''}`}>
            <span className={`rates-state-dot state-${ratesState}`} aria-hidden="true" />
            <span>{statusMessage}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm rates-refresh-btn"
            disabled={ratesLoading}
            aria-busy={ratesLoading}
            onClick={() => void refreshRates().catch(() => {})}
          >
            <Icon name="refresh" /> {ratesLoading ? 'Refreshing…' : 'Refresh rates'}
          </button>
        </div>

        {budget.rateChips.length > 0 && (
          <div className="rate-chip-row" aria-label="Current exchange rates used for conversion">
            {budget.rateChips.map((r) => (
              <span className="rate-chip" key={r.currency}>
                1 {r.currency} &asymp; {fmtRate(r.value, trip.homeCurrency)}
              </span>
            ))}
          </div>
        )}
      </div>

      {hasExpenses && (
        <>
          <div className="summary-grid">
            <div className={summaryCardClass}>
              <div className="label">Trip total</div>
              <div className="home tabular">{fmtMoney(budget.total, trip.homeCurrency)}</div>
              <div className="summary-sub">
                {`from ${currencyCount} currenc${currencyCount === 1 ? 'y' : 'ies'}`}
                {totalNote && (
                  <>
                    {' '}
                    &middot; <span className="rate-missing-note">{totalNote}</span>
                  </>
                )}
              </div>
            </div>
            <div className={summaryCardClass}>
              <div className="label">Paid / booked</div>
              <div className="home tabular" style={{ color: 'var(--jade)' }}>
                {fmtMoney(budget.paid, trip.homeCurrency)}
              </div>
              <div className="summary-sub">{paidNote && <span className="rate-missing-note">{paidNote}</span>}</div>
            </div>
            <div className={summaryCardClass}>
              <div className="label">Still to pay</div>
              <div className="home tabular" style={{ color: 'var(--gold)' }}>
                {fmtMoney(budget.toPay, trip.homeCurrency)}
              </div>
              <div className="summary-sub">{toPayNote && <span className="rate-missing-note">{toPayNote}</span>}</div>
            </div>
          </div>

          {/* raw subtotal per original currency — a quick sanity check
              against the converted figures above without doing the mental
              math. */}
          <div className="currency-subtotals" aria-label="Subtotal by original currency">
            <span className="field-label">By currency</span>
            {[...budget.byCurrency.keys()].sort().map((cur) => {
              const noRate = trip.rates[cur] === undefined;
              return (
                <span className={`currency-chip${noRate ? ' warn' : ''}`} key={cur}>
                  {fmtMoney(budget.byCurrency.get(cur) ?? 0, cur)} <i>{cur}{noRate ? ' · no rate' : ''}</i>
                </span>
              );
            })}
          </div>

          {budget.categories.length > 0 && (
            <div className="card cat-breakdown">
              <div className="field-label" style={{ marginBottom: 10 }}>
                By category
              </div>
              {budget.categories.map((c) => (
                <div className="cat-row" key={c.category}>
                  {/* Inner <span> is load-bearing, not decoration: the
                      truncation rule is `.cat-row .cat-label span`, so a bare
                      text node here never truncates and a long category name
                      pushes the grid out of alignment with the By-person card
                      below, which does wrap its label. Matches the approved
                      mockup, where both cards wrap. */}
                  <span className="cat-label">
                    <span>{c.category}</span>
                  </span>
                  <div className="cat-bar-track">
                    <div
                      className="cat-bar-fill"
                      style={{ width: `${budget.total ? (c.amount / budget.total) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="cat-amt tabular">
                    <span className="cat-amt-value">{fmtMoney(c.amount, trip.homeCurrency)}</span>
                    {c.currencyCount > 1 && <span className="cat-amt-note">{c.currencyCount} currencies</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Phase 5 item 6 — reuses the identical bar/track/amount layout as
          "By category" above (same jade bar colour on purpose — see the CSS
          comment on `.members-card`/`.by-person-card`). */}
      <div className="card cat-breakdown by-person-card">
        <div className="field-label" style={{ marginBottom: 10 }}>
          By person{' '}
          <span style={{ textTransform: 'none', fontWeight: 600, color: 'var(--ink-faint)' }}>
            &middot; who paid, converted to {trip.homeCurrency}
          </span>
        </div>
        {byPerson.rows.length === 0 ? (
          <p className="panel-hint" style={{ margin: '4px 0 2px' }}>
            No companions yet &mdash; add one above to see who paid what.
          </p>
        ) : (
          <>
            {byPerson.rows.map((r) => {
              // PHASE6 item 7: share of the TRIP TOTAL, matching "By
              // category" above (`c.amount / budget.total`). This used to be
              // `r.sum / byPersonMax` — share of the top payer — which made
              // the identical bar widget mean two different things one card
              // apart: someone covering 90% of the trip rendered exactly like
              // the largest of several small payers. The `Math.max(4, …)`
              // legibility floor is unchanged.
              const pct = Math.max(4, budget.total ? (r.sum / budget.total) * 100 : 0);
              const rowNote = exclusionNoteShort(r.excluded);
              return (
                <div className="cat-row" key={r.member.id}>
                  <span className="cat-label">
                    <MemberAvatar name={r.member.name} color={r.member.color} size="xs" />
                    <span>{r.member.name}</span>
                  </span>
                  <div className="cat-bar-track">
                    <div className="cat-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="cat-amt tabular">
                    <span className="cat-amt-value">{fmtMoney(r.sum, trip.homeCurrency)}</span>
                    {rowNote && <span className="cat-amt-note">{rowNote}</span>}
                  </span>
                </div>
              );
            })}
            {byPerson.orphanCount > 0 && (
              <p className="panel-hint" style={{ margin: '10px 0 0' }}>
                <span className="rate-missing-note">
                  {byPerson.orphanCount} expense{byPerson.orphanCount === 1 ? '' : 's'} excluded &mdash; payer no
                  longer in your companions list
                </span>
              </p>
            )}
          </>
        )}
      </div>

      <div className="panel-head" style={{ marginTop: 22 }}>
        <h3 className="panel-title" style={{ fontSize: '1.05rem' }}>
          All expenses
        </h3>
        <button className="btn btn-primary btn-sm" onClick={handleHeaderAddClick}>
          <Icon name="plus" /> Add expense
        </button>
      </div>

      <form className={`add-form card${formOpen ? ' open' : ''}`} ref={formRef} onSubmit={(e) => void handleSubmit(e)}>
        <div className="add-form-head">
          <h4>{editingId ? 'Editing expense' : 'Add expense'}</h4>
          {editingId && <span className="tag">Editing</span>}
        </div>
        <div className="add-form-grid">
          <div>
            <label htmlFor="e-cat">Category</label>
            <select id="e-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="e-amt">Amount</label>
            <div className="amount-currency-field">
              <select
                aria-label="Currency paid in"
                value={currency}
                onChange={(e) => handleCurrencyChange(e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} {c.symbol}
                  </option>
                ))}
              </select>
              <input
                className="num-input"
                type="number"
                id="e-amt"
                min="0"
                step="any"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>
          <div className="full">
            <label htmlFor="e-label">Label</label>
            <input
              className="text-input"
              style={{ width: '100%' }}
              type="text"
              id="e-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Xi'an noodles"
            />
          </div>
          <div className="full">
            <label htmlFor="e-city">Attach to</label>
            <select id="e-city" value={cityField} onChange={(e) => handleCityChange(e.target.value)}>
              <option value="">Whole trip</option>
              {orderedCities(trip).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="e-paidby">Paid by</label>
            <select id="e-paidby" value={paidByField} onChange={(e) => setPaidByField(e.target.value)}>
              <option value="">&mdash; none &mdash;</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Phase 6 item 11 — log something that's already been paid without
              having to save it and then flip the row's toggle. */}
          <div>
            {/* A plain span, NOT a second <label htmlFor="e-paid">: the
                wrapping label below is already this checkbox's label, and
                two labels pointing at one input give it the compound
                accessible name "Status Already paid". */}
            <span className="field-label">Status</span>
            <label className="checkbox-field">
              <input
                type="checkbox"
                id="e-paid"
                checked={paidField}
                onChange={(ev) => setPaidField(ev.target.checked)}
              />
              <span>Already paid</span>
            </label>
          </div>

          {/* Phase 6 item 10 — who this expense covers. Only shown when there
              are companions to split across; with none defined the whole
              control is meaningless (everyone == you), so it stays hidden
              rather than rendering an empty picker. */}
          {members.length > 0 && (
            <div className="full">
              <span className="field-label" id="covers-label">
                Covers
              </span>
              <div className="covers-control" role="group" aria-labelledby="covers-label">
                <div className="covers-mode">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={coversEveryone}
                    className={`btn btn-sm${coversEveryone ? ' btn-primary' : ' btn-ghost'}`}
                    onClick={() => {
                      setCoversEveryone(true);
                      setCoversIds([]);
                    }}
                  >
                    Everyone
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!coversEveryone}
                    className={`btn btn-sm${!coversEveryone ? ' btn-primary' : ' btn-ghost'}`}
                    onClick={() => setCoversEveryone(false)}
                  >
                    Choose people
                  </button>
                </div>

                {!coversEveryone && (
                  <div className="covers-people">
                    {members.map((m) => {
                      const checked = coversIds.includes(m.id);
                      return (
                        <label className="checkbox-field" key={m.id}>
                          <input
                            type="checkbox"
                            // Explicit, because the avatar beside the name
                            // contributes its initial letter to the label's
                            // text — without this the checkbox's accessible
                            // name comes out as "A Alex".
                            aria-label={m.name}
                            checked={checked}
                            onChange={() => {
                              const next = checked
                                ? coversIds.filter((id) => id !== m.id)
                                : [...coversIds, m.id];
                              // Deselecting the LAST person snaps back to
                              // "Everyone" rather than leaving an empty
                              // selection. That makes the degenerate
                              // "covers nobody" state unreachable from this
                              // UI — see `Expense.coversMemberIds`, which
                              // treats an explicit [] as something only bad
                              // imported data can produce.
                              if (next.length === 0) {
                                setCoversEveryone(true);
                                setCoversIds([]);
                              } else {
                                setCoversIds(next);
                              }
                            }}
                          />
                          <MemberAvatar name={m.name} color={m.color} size="xs" />
                          <span>{m.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="full">
            <label htmlFor="e-note">
              Note <span style={{ textTransform: 'none', fontWeight: 500, color: 'var(--ink-faint)' }}>&middot; optional</span>
            </label>
            <textarea
              className="text-input"
              id="e-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Confirmation numbers, reminders, anything worth remembering…"
            />
          </div>
        </div>
        <p className="panel-hint" style={{ margin: '-2px 0 12px' }}>
          Currency defaults to what you&rsquo;d pay in at that city &mdash; change it to whatever you actually paid in.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary btn-sm">
            {editingId ? 'Save changes' : 'Add expense'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={closeForm}>
            Cancel
          </button>
        </div>
      </form>

      {!hasExpenses && (
        <div className="budget-empty">
          <Icon name="wallet" />
          <strong>No expenses logged yet</strong>
          <span>
            Add flights, hotels and tickets as you book them &mdash; each keeps its own currency and converts to{' '}
            {trip.homeCurrency} automatically.
          </span>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 2 }} onClick={openForm}>
            <Icon name="plus" /> Add your first expense
          </button>
        </div>
      )}

      {hasExpenses && (
        <div className="expense-list" id="expenseList">
          {sortedExpenses.map((e) => {
            const converted = convert(e.amount, e.currency, trip);
            const isFree = e.amount <= 0;
            // PHASE5 trap #3: `e.paidBy` may be set but no longer resolve to
            // any current member (the member was removed) — that's not an
            // error, it renders as unset ("—"), never throws. No `paidBy` at
            // all is the ordinary case and shows nothing here.
            // Resolved to the member OBJECT, not just the name, so the row's
            // avatar can carry that member's `--m-*` colour (Phase 6 item 8)
            // — a colour picked in Settings has to actually show up where
            // members appear, or the setting is decorative.
            const payer = e.paidBy ? members.find((m) => m.id === e.paidBy) : undefined;
            return (
              <div className="card expense" key={e.id}>
                <span className="expense-swatch" style={{ background: categoryColor(e.category) }} />
                <div className="expense-main">
                  <div className="expense-label">{e.label}</div>
                  <div className="expense-meta">
                    <span className="tag">{e.category}</span>
                    <span>{cityMeta(e)}</span>
                    {!isFree && converted === undefined && <span className="tag rate-missing-tag">No rate</span>}
                    {e.paidBy &&
                      (payer ? (
                        <span className="expense-payer">
                          <MemberAvatar name={payer.name} color={payer.color} size="xs" /> Paid by {payer.name}
                        </span>
                      ) : (
                        <span className="expense-payer is-unset">
                          <Icon name="user" /> Paid by &mdash;
                        </span>
                      ))}
                  </div>
                  {e.note?.trim() && <div className="expense-note">{e.note}</div>}
                </div>
                <div className="expense-amt">
                  <div className="orig tabular">{isFree ? 'Free' : fmtMoney(e.amount, e.currency)}</div>
                  {isFree ? (
                    <div className="conv tabular">booked online</div>
                  ) : converted === undefined ? (
                    <div className="conv rate-missing">
                      <Icon name="alert" className="rate-missing-icon" /> no rate yet
                    </div>
                  ) : e.currency === trip.homeCurrency ? (
                    <div className="conv tabular" />
                  ) : (
                    <div className="conv tabular">&asymp; {fmtMoney(converted, trip.homeCurrency)}</div>
                  )}
                </div>
                <label className="paid-toggle">
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={e.paid}
                      onChange={() => handlePaidToggle(e)}
                      aria-label={`Mark ${e.label} as ${e.paid ? 'unpaid' : 'paid'}`}
                    />
                    <span className="track" />
                    <span className="thumb" />
                  </span>
                  <span className="paid-label">{e.paid ? 'Paid' : 'Unpaid'}</span>
                </label>
                <div className="expense-actions-group">
                  <button className="icon-btn" aria-label={`Edit ${e.label}`} onClick={() => openEdit(e)}>
                    <Icon name="edit" />
                  </button>
                  <button
                    className="icon-btn is-danger"
                    aria-label={`Remove ${e.label}`}
                    onClick={() => void removeExpense(e.id)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Phase 6 item 11 — "who paid?" on marking an expense paid. Rendered
          through the shared <Modal>, which already supplies Escape, the
          focus-trap and focus-restore; the design review was explicit that
          this must NOT be a second hand-rolled overlay. Closing without
          choosing leaves the expense unpaid and untouched — the toggle's
          state change is committed by confirmPayer, not before it, so a
          dismissed prompt is a true no-op rather than a half-applied edit. */}
      <Modal
        open={payerPromptFor !== null}
        onClose={() => setPayerPromptFor(null)}
        labelledBy="payerPromptTitle"
      >
        <div className="modal-head">
          <h3 id="payerPromptTitle">Who paid?</h3>
          {/* Not just "Cancel" — the expense form below has its own Cancel
              button, and two identically-named controls in one view is
              ambiguous for anyone navigating by accessible name. */}
          <button className="icon-btn" onClick={() => setPayerPromptFor(null)} aria-label="Close without marking paid">
            <Icon name="close" />
          </button>
        </div>
        <p className="panel-hint">
          Marking <strong>{payerPromptFor?.label}</strong> as paid.
        </p>
        <div className="payer-choices">
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => confirmPayer(m.id)}
            >
              <MemberAvatar name={m.name} color={m.color} size="xs" /> {m.name}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => confirmPayer(undefined)}>
          Mark paid without recording who
        </button>
      </Modal>
      <BackToTop />
    </section>
  );
}

