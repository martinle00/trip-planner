// Back-to-top button — Phase 6 item 5, extended in the same phase from the
// Itinerary tab to Places and Budget.
//
// Extracted here rather than copied a third time: the threshold, the reduced-
// motion check, the passive listener and the conditional-mount decision below
// all have to agree across every tab that uses it, and three copies is three
// chances for them to drift.
//
// CONDITIONALLY MOUNTED, deliberately not the "always rendered, opacity and
// pointer-events toggled" approach the mockup demo used: an always-present
// but invisible focusable button is a real keyboard/AT trap — a Tab stop that
// goes nowhere visible. Mounting on demand sidesteps it entirely instead of
// faking it with `tabIndex`/`aria-hidden` bookkeeping. See the `.back-to-top`
// comment in index.css for the styling side of this.

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icons';

/** How far down the page before the button appears. Matches the approved
 *  mockup's hand-tuned threshold. */
const BACK_TO_TOP_THRESHOLD = 220;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function BackToTop() {
  // Whole-page scroll — no tab that uses this has a nested scroll container
  // of its own, so this listens on `window` rather than a ref'd element.
  const [show, setShow] = useState(false);

  useEffect(() => {
    function onScroll() {
      setShow(window.scrollY > BACK_TO_TOP_THRESHOLD);
    }
    // Run once on mount so switching tabs while already scrolled down shows
    // the button immediately, instead of waiting for the next scroll event.
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToTop = useCallback(() => {
    // The `fadein` appearance is already covered by index.css's blanket
    // reduced-motion rule; only this actual scroll call needs its own check
    // — same pattern as RouteStrip.tsx / MapPanel.tsx.
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  if (!show) return null;

  return (
    <button type="button" className="back-to-top" onClick={scrollToTop} aria-label="Back to top" title="Back to top">
      <Icon name="arrow-up" />
    </button>
  );
}
