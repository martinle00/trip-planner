// Mirrors the mockup's updateStickyOffsets(): keeps --topbar-h / --tabbar-h /
// --itnav-h custom properties in sync with the real rendered heights of the
// sticky topbar, tabbar and (on the Itinerary tab) the quick-nav bar, so the
// stacked sticky headers sit flush instead of overlapping content.

import { useEffect } from 'react';

export function useStickyOffsets(deps: unknown[]): void {
  useEffect(() => {
    const root = document.documentElement.style;

    function update() {
      const topbar = document.querySelector<HTMLElement>('.topbar');
      const tabbar = document.querySelector<HTMLElement>('.tabbar');
      const itnav = document.getElementById('itQuickNav');
      if (topbar) root.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
      // Below the mobile breakpoint .tabbar becomes a fixed bottom dock (see
      // index.css's `@media (max-width:719px)` override) instead of sticky
      // top chrome — it no longer belongs to the STICKY TOP stack that
      // .it-quicknav / .map-day-quicknav position themselves under, so it
      // shouldn't contribute to --tabbar-h in that state (it would otherwise
      // push those sub-bars down by the height of a bar that's no longer
      // even at the top of the screen). Checked via computed style rather
      // than duplicating the breakpoint's pixel value here — this hook only
      // needs to know "is it acting as top-of-stack chrome right now", not
      // the exact width that decides it.
      const tabbarInTopStack = tabbar && getComputedStyle(tabbar).position !== 'fixed';
      root.setProperty('--tabbar-h', tabbarInTopStack ? `${tabbar!.offsetHeight}px` : '0px');
      root.setProperty('--itnav-h', itnav ? `${itnav.offsetHeight}px` : '0px');
    }

    update();
    window.addEventListener('resize', update);

    const observed: Element[] = [];
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      for (const sel of ['.topbar', '.tabbar', '#itQuickNav']) {
        const el = document.querySelector(sel);
        if (el) {
          ro.observe(el);
          observed.push(el);
        }
      }
    }

    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
