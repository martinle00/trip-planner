// Scrolls a tab to the section for the city selected in the topbar timeline.
// The timeline's selection is lifted to App and outlives tab switches, so the
// Places and Itinerary tabs open on the leg you were last looking at instead
// of at the top of the whole trip.

import { useEffect, useRef } from 'react';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * `resolveTargetId` maps the city to the DOM id to scroll to, or null when
 * there's nothing on screen for it. It's read at scroll time, not captured, so
 * it may close over per-render state.
 *
 * The first scroll after mount is instant: the tab has just replaced another
 * one, and smooth-scrolling from the top of a long list looks like the page
 * lurching. A later change (tapping the timeline while already on this tab) is
 * smooth, so the jump stays legible.
 *
 * Deferred a tick because App's `useStickyOffsets` runs after this effect (a
 * parent's effects run after its children's) and the `scroll-margin-top`
 * these targets use reads the offsets it writes.
 */
export function useFocusCity(focusCity: string | undefined, resolveTargetId: (city: string) => string | null): void {
  const resolveRef = useRef(resolveTargetId);
  resolveRef.current = resolveTargetId;
  const mounted = useRef(false);

  useEffect(() => {
    const instant = !mounted.current;
    mounted.current = true;
    if (!focusCity) return;
    const timer = window.setTimeout(() => {
      const id = resolveRef.current(focusCity);
      const el = id ? document.getElementById(id) : null;
      // Optional call: jsdom has no scrollIntoView.
      el?.scrollIntoView?.({ behavior: instant || prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [focusCity]);
}
