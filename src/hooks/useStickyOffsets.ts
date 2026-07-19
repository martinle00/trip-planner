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
      if (tabbar) root.setProperty('--tabbar-h', `${tabbar.offsetHeight}px`);
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
