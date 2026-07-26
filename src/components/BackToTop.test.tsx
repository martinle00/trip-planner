// @vitest-environment jsdom
//
// Phase 6 item 5. Extracted from ItineraryPanel when Places and Budget gained
// the same button — one implementation, three consumers, so a regression here
// hits all three tabs at once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BackToTop } from './BackToTop';

/** jsdom implements neither scrollTo nor real scrolling, so scroll position
 *  is driven directly and the call is asserted on a stub. */
function setScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, writable: true, configurable: true });
  fireEvent.scroll(window);
}

let scrollToSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollToSpy = vi.fn();
  Object.defineProperty(window, 'scrollTo', { value: scrollToSpy, writable: true, configurable: true });
  setScrollY(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const button = () => screen.queryByRole('button', { name: 'Back to top' });

describe('BackToTop', () => {
  it('is not in the DOM at all near the top — not merely hidden', () => {
    render(<BackToTop />);
    // The conditional mount is the whole point: an always-rendered but
    // invisible button is a Tab stop that goes nowhere visible, which is
    // exactly the keyboard/AT trap this avoids. `queryByRole` would still
    // find such a button, so this assertion is what pins the behaviour.
    expect(button()).toBeNull();
  });

  it('appears once scrolled past the threshold, and disappears on the way back up', () => {
    render(<BackToTop />);
    setScrollY(500);
    expect(button()).toBeInTheDocument();

    setScrollY(0);
    expect(button()).toBeNull();
  });

  it('is present immediately on mount when the page is ALREADY scrolled down', () => {
    // Guards the on-mount `onScroll()` call: switching tabs while scrolled
    // down mounts a fresh instance, and without that initial read the button
    // would stay missing until the user happened to scroll again.
    setScrollY(500);
    render(<BackToTop />);
    expect(button()).toBeInTheDocument();
  });

  it('scrolls the window to the top when clicked', () => {
    render(<BackToTop />);
    setScrollY(500);
    fireEvent.click(button() as HTMLElement);

    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('removes its scroll listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<BackToTop />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
