# PHASE 8 — Offline writes, and the By-person split

Working notes for Phase 8. Read this before touching the persistence layer or the
Budget tab's By-person card. Same structure as `PHASE4.md`/`PHASE5.md`/`PHASE6.md`:
scope, decisions + rationale, traps.

> **Released as 0.8.0** — see `CHANGELOG.md`. Phase 8 also introduced
> `@changesets/cli`; the repo had no version at all before this (`0.0.0`), so **0.7.0**
> was set retroactively as "the app through Phase 7".
>
> **STATUS (2026-07-31): both items IMPLEMENTED.** Build clean, lint clean (only the
> known `RouteStrip.tsx:13` warning), **584 tests green**. Dexie schema is v6.
> **Nothing has been verified in a real browser** — the offline round-trip in
> particular is jsdom + `fake-indexeddb` only. See "Outstanding" at the bottom.

---

## Item 1 — Offline writes: durable outbox + user-gated sync

### Why

The trip this app exists for is spent in China, where Supabase is expected to be
unreachable **for a day or more at a time** (VPN blocked, patchy roaming). Until now a
mutation made offline simply *failed*: `SyncedTripRepository` wrote remote-first and
mirrored the cache only on success, deliberately, because there is no merge logic.
`CLAUDE.md` had listed the fallout as unfinished business since Phase 4.

### What changed

```
OutboxTripRepository( SyncedTripRepository( Supabase, Dexie ), Dexie )
```

`TripRepository` is **unchanged** — this is exactly the swap the seam exists for. New:
`data/outboxRepository.ts` (the queue), `data/outboxTripRepository.ts` (the wrapper),
Dexie `version(6)`'s `outbox` table, `useTripStore.syncOutbox`, and the topbar pill's
pending states + sync sheet in `App.tsx`.

### Decisions and rationale

1. **This inverts "no silent divergence", on purpose.** The old model's whole point was
   that the cache never held anything the server hadn't accepted. An outbox *is*
   divergence. What makes it not-silent is the pending count and the fact that nothing
   uploads without a tap. `CLAUDE.md`'s sync section was **rewritten**, not appended to.

2. **Queue only on a recognised connectivity signal — `isConnectivityFailure` defaults
   to FALSE.** An RLS denial, an expired JWT or a constraint violation queued as if it
   were a dropped connection would be retried forever against a server that will never
   accept it, while the UI reported success. **This is the single way this feature can
   silently eat data.** Widening that predicate needs a very good reason.

3. **Coalesce per record, not per operation.** At most one entry per
   `[entity+recordId]`; `queuedAt` carries over from the entry it replaces so the
   staleness clock dates from when the record first went un-uploaded rather than
   resetting on every keystroke. The count shown to the user therefore means "records
   changed", which is what makes the number worth trusting.

4. **Two operations never queue.** `importSnapshot` is a destructive whole-trip replace
   — queued, it would sit for a day and then wipe out everything a collaborator did.
   `updatePlaceIfUnchanged` is a conditional write whose `baseUpdatedAt` is meaningless
   hours later; offline it throws and the prose stays safe in `draftRepository`, which
   exists for exactly that.

5. **No auto-upload, no retry loop.** The user asked for a gate, and a drain stops at
   the first failure: a dead network breaks the next 30 writes too, and firing them all
   costs battery and data on a phone that has neither. Replay is idempotent by id, so a
   partial drain is safe to re-run.

6. **Replay goes through the INNER repository** (`OutboxTripRepository.replayTarget`).
   Through the wrapper, a failure would be caught and re-queued — a drain against a
   still-dead network would silently rewrite the queue and report success.

7. **Blind last-write-wins on replay**, consistent with every other write in the app.
   Not detected, but *disclosed* in the sync sheet. There is no per-record versioning
   for itinerary/expenses and none is planned.

   > Worth knowing: Places DO have optimistic concurrency (`updatePlaceIfUnchanged` /
   > `Place.updatedAt`), so "the project has no versioning" is not quite true. That's a
   > future option for smarter replay; it is not used here.

### Traps

- **The background reconcile will eat the queue.** `init()` revalidates from the remote
  after its cache-first paint — but the remote is *missing* every queued change, so it
  would paint older data over the user's own offline edits and then re-upload them.
  Revalidation is **skipped entirely while the outbox is non-empty**; `syncOutbox()`
  re-runs `init()` after a clean drain. This is NOT the race `mutationVersion` /
  `domainDataInitPatch` guard — that read is legitimately complete, just legitimately
  stale.
- **Reads must bypass the remote while anything is queued**, for the same reason. It
  reads like an optimisation; it's a correctness requirement.
- **Sign-out destroys the queue.** `clearLocalCache()` drops the outbox with everything
  else (a queued write is only permitted to the account that made it), so
  `handleSignOut` refuses while changes are pending.
- **`persistReconciledPlaces` must not fire from a cache paint** — it's documented as
  "only ever from an AUTHORITATIVE read", and with revalidation suppressed no read is.

### UX decisions (from a ux-reviewer design review, pre-implementation)

- **Never auto-raise the sheet.** Connectivity returning changes the pill's label and
  nothing else. A focus-trapping overlay fired by a background network event lands
  mid-form, mid-drag, or while walking one-handed out of a metro — which is the exact
  context this feature exists for.
- **The pill shows the pending count while offline too.** The old rule "never show the
  pill offline" survives, read precisely: never claim to *be syncing* offline. A count
  of unsaved work is a different fact. It is deliberately **not tappable** offline —
  there's nothing tapping could achieve.
- **The label must not collapse at narrow widths** the way `.sync-indicator-label` does
  — a count that vanishes on a phone is useless. 44px target; `aria-live` debounced to
  the settled count so a burst of edits doesn't read out "4… 5… 6…".
- **Equal-weight `[Not now] [Upload]`**, breaking the usual ghost/primary split: "Not
  now" is the safe choice on one bar of signal.
- **The overwrite warning is unnamed**, deviating from the review, which wanted the
  collaborator named. `trip.members` means *budget companions* — people who may have no
  account and have never edited anything. `trip_collaborators` is the real account list
  and nothing loads it client-side. Naming the wrong person is worse than the vaguer
  sentence.

---

## Item 2 — By-person: one stacked split, not a bar per person

### Why (this was a real reporting bug, not a restyle)

`byPerson` opened its loop with `if (!e.paidBy) continue;`. An expense with no payer was
**dropped before anything counted it** — and unlike the orphaned-payer case right below
it, nothing on the card said so. `paidBy` is optional and the add form leaves it unset
by default (`paidByField` starts `''`), so this is routinely a large slice of the data.

Each bar was `r.sum / budget.total`: numerators covering only attributed expenses,
denominator covering all of them. With half the trip unassigned, both people rendered at
~25% and **the missing half was unaccounted for anywhere on screen**. The natural read
is "we've spent half what we've spent".

### What changed

One stacked `.split-track` — a jade segment per payer plus a hatched **Not assigned**
segment — with the per-person amounts as a legend beneath.

### Decisions and rationale

1. **Part-to-whole belongs in a stacked bar.** Independent bars each scaled against a
   shared total are exactly the shape that lets a remainder disappear: nothing in the
   layout is obliged to add up. Stacked, the gap has to occupy width.
2. **Segments wear each member's own `--m-*` swatch**, so the bar matches the avatar
   beside that name in the legend. This **widened DESIGN-SYSTEM §2**, which previously
   reserved the member palette to avatars/chips and held this bar to `--jade`; the
   original reasoning (colour is optional on a member, so it can't be *relied* on) is
   still true, which is why an uncoloured member falls back to `--jade` and those
   fallback segments alternate lightness. The legend remains the authoritative identity.
3. **The unassigned segment is hatched, not coloured.** It isn't a person, and it must
   not read as one. Hatching reads as "missing", which is what it is.
4. **The denominator is the sum of the segments, not `budget.total`.** No-rate expenses
   are excluded from every segment, so dividing by the trip total would leave a silent
   gap at the end of the track meaning "unconvertible" — visually identical to the
   "nobody assigned" gap beside it, when distinguishing those two is the entire point.
   Exclusions stay reported per-row, as before.
5. **The 4% legibility floor is gone.** It drew a visible bar next to `A$0`. A zero
   share is now simply absent.
6. **`role="img"` + a one-sentence `aria-label`.** A stacked bar's segments carry no
   text of their own; without it a screen reader walks a row of silent divs.

### Tap-to-filter: built, then removed

The "Not assigned" row was briefly a button that filtered the list to expenses with no
payer (ux-reviewer round 3, finding 5). **Removed at the user's request** — for a
two-person trip it was surface without a job. The row still reports the gap, which was
the actual defect; only the tap is gone.

Worth recording from the attempt, in case it comes back when the app goes multi-trip:
it needed no general payer-filter axis, only "no payer set" — and the By-person card had
to be **exempt from its own filter**, reading a pre-payer-filter list, or tapping
collapsed the card to 100% unassigned with every member at zero and no visible way back.
Same exemption the rates card has, for the same reason: **a display that drives a filter
can't also be a subject of it.**

### Review round 3

- The legend reused `.cat-label`/`.cat-amt`, but those rules are descendant-scoped to
  `.cat-row` (`index.css:1090-1091`, `:1132`) and `.split-legend-row` isn't one — so the
  legend silently lost the mono font, the 600 weight, right-alignment and label
  truncation that every other number in the panel gets. Both selectors now list
  `.split-legend-row` explicitly. **If you add another row-shaped widget, add it to
  those selector lists too** — this will happen again otherwise.
- Category chips now release on a second press, like the payment chips. The two rows
  look identical and sit one above the other; whichever a user learns first sets the
  expectation for the other.
- Segments alternate lightness (`nth-of-type(even)` at 72% jade). Two segments read fine
  off the 2px gap alone; three or more near-equal ones are two thin same-coloured seams
  in a mostly-solid bar. Alternating **lightness, not hue** — hue would reintroduce the
  member-identity encoding this card deliberately doesn't have.
- A `$0` companion's legend row is `--ink-faint`, so "4 legend rows, 2 bar chunks"
  doesn't read as a rendering bug.

---

## Outstanding

- **Nothing verified in a real browser.** For the outbox specifically: DevTools →
  Offline, edit a place / expense / stop, **reload** (the queue must survive), go back
  online, confirm no sheet appears by itself, tap the pill, upload, confirm the rows
  land in Supabase and the pill returns to `Synced`.
- **The two-device last-write-wins check** — sign in as the second account elsewhere,
  edit the same record while this device is offline, then upload. This is the scenario
  the sync sheet's warning describes, and it has never actually been run.
- **RLS still unverified against the live project** (carried over from Phase 4). It
  matters more now: `isConnectivityFailure` returning false for an RLS denial is what
  keeps a permanently-rejected write out of the queue, and that path has only ever been
  exercised against a fake.
- **The By-person track has not been seen rendered** — segment proportions, the hatch in
  both themes, and the legend at 390px.
