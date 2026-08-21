---
"ctpapp": minor
---

A place can now be saved **without a location**. Previously, adding a place with no
search result and no pasted coordinate silently dropped it at the centre of its city —
so a food chain with four branches in one city produced four identical pins that looked
exactly like real ones. Leaving the coordinate field blank now saves the place unpinned:
list the candidate branches in the description, and set the location from the place's
detail modal once you've worked out which one fits the day.

Places without a location are excluded from the map (which says how many it left off)
and from Auto-plan, and are tagged "No location" on the Places tab and in the detail
modal.

Needs `supabase/migrations/0007_optional_place_location.sql` applied before a
location-less place can sync.
