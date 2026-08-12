---
'ctpapp': minor
---

The trip's journey is now editable. "Edit journey" — the first row in Settings — opens a
sheet where each leg has a nights field (typed or stepped ±1), up/down reordering and a
remove control, plus a trip start date that shifts everything at once. Leg dates are shown, not typed: legs
run back to back, so changing one leg re-dates the rest automatically. A day trip is the
exception and has its own date picker, bounded to the days its parent city actually has.
Cities can also be added: name it, and it goes on the end with one night for the arrows
and the stepper to place. Edits are held as a draft and applied in a single batch on
Save, so a nights stepper doesn't fire a write per tap.

Note that the app only knows the original ten cities' currency and map centre, so
expenses on an added city outside China default to CNY (overridable per expense), and a
place quick-added there without a map pin lands on a rough default. Renaming a city is
not possible yet — the name is what places, expenses and days are filed under.

Removing a leg says exactly what it will cost before it does anything — days removed,
itinerary stops deleted, places and expenses affected, and whether a day trip goes with
it. Saved places in a removed city are **kept**, not deleted, and now appear in a "Not on
this trip" group at the bottom of the Places tab (they were previously invisible in the
UI while still occupying rows in the database).

Days that survive an edit keep their identity, so the itinerary you have already built
stays attached to them even when the whole trip shifts on the calendar — see PHASE10.md,
which also covers why the day cascade is done explicitly rather than left to Postgres's
foreign keys, and why queued writes now replay in dependency order rather than queue
order.
