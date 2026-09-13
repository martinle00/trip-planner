---
"ctpapp": minor
---

A place can now be on **several days** and under **several categories**.

- **Days:** the day dropdown on Places cards and the Map pin panel is replaced by day chips.
  Tap any number of them. Each chosen day gets its own itinerary stop, and turning a day
  off removes only that stop. Changing a place from one day to another moves its existing
  stop, so a start time or note set on it isn't lost. On the Map, a place shows in the
  day-view of every day it's on, and a day filter highlights it on each of them. In the
  Itinerary, "Add stop" now offers places already scheduled on other days.
- **Categories:** Add Place and Place Detail pick categories with chips instead of a single
  select. The first one picked is the primary and sets the place's icon. Cards, the pin
  panel and the detail modal list every category, and a category filter matches a place
  on any of them.

Requires migration `0009_place_categories.sql` on the Supabase project. Place saves fail
until it is applied.
