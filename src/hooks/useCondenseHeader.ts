// Drives the desktop-only "condensing header" refinement approved in
// mockup/header-nav-hierarchy.html (#v3-condense): past a scroll threshold
// the sticky topbar shrinks (eyebrow/subtitle drop, title collapses, the
// utility row goes icon-only, route-strip nodes shrink to city pills) to
// give the Map tab's day chips / Add place more room alongside the
// still-sticky header. Mobile is untouched — it keeps the approved Variant 3
// bottom tab dock instead (see index.css's `@media (max-width:719px)` block
// on .tabbar) and never runs this hook's observer at all.
//
// Per the mockup's own engineering note, this prefers an IntersectionObserver
// over a scroll listener: cheaper (no per-frame scroll handling), and the
// hysteresis the mockup's live demo hand-tuned via two scroll-pixel constants
// (condense past 88px, re-expand only below 32px — far enough apart that
// hovering near either number can't flap the state) falls out for free from
// the sentinel's own height. The sentinel (rendered by App.tsx as the first
// child of <main>, see .condense-sentinel in index.css) spans exactly that
// 56px band in the document; "not intersecting the viewport at all" means
// it's fully scrolled past -> condense, "fully intersecting" means it's back
// in view -> re-expand, and anything in between (partially visible) leaves
// the current state alone. That partial band IS the hysteresis.

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

// Same >=720px threshold Modal.tsx's bottom-sheet/dialog switch and the Map
// save-bar's sizing already use elsewhere in this app — and, critically, the
// exact complement of the `@media (max-width:719px)` breakpoint that turns
// the tabbar into the mobile bottom dock. Keeping both expressed against this
// one constant is what guarantees a resize/rotation can never leave the
// condensing header active at the same time as the bottom dock: the two are
// partitioned by construction, not by hoping two independently-tuned numbers
// happen to agree.
const DESKTOP_QUERY = '(min-width: 720px)';

export function useCondenseHeader(sentinelRef: RefObject<HTMLElement | null>): boolean {
  const [condensed, setCondensed] = useState(false);
  // Read inside the IntersectionObserver callback without re-subscribing the
  // effect on every condense/expand toggle.
  const condensedRef = useRef(false);
  condensedRef.current = condensed;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DESKTOP_QUERY);
    let observer: IntersectionObserver | undefined;

    function attach() {
      const el = sentinelRef.current;
      if (!el || typeof IntersectionObserver === 'undefined') return;
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry.isIntersecting) {
            if (!condensedRef.current) setCondensed(true);
          } else if (entry.intersectionRatio >= 1) {
            if (condensedRef.current) setCondensed(false);
          }
          // Anything else (partially visible, ratio between 0 and 1) is the
          // hysteresis band — deliberately no-op.
        },
        { threshold: [0, 1] },
      );
      observer.observe(el);
    }
    function detach() {
      observer?.disconnect();
      observer = undefined;
      setCondensed(false);
    }
    function sync() {
      if (mql.matches) attach();
      else detach();
    }

    sync();
    mql.addEventListener('change', sync);
    return () => {
      mql.removeEventListener('change', sync);
      observer?.disconnect();
    };
  }, [sentinelRef]);

  return condensed;
}
