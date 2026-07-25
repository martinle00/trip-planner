// @vitest-environment jsdom
//
// Component tests for the Map tab's staged-changes Save bar
// (mockup/map-save-changes.html). Deliberately store-free: MapSaveBar takes
// plain props and callbacks, so every state (resting/pending/saving/saved/
// failed/offline/discard-confirm) can be driven directly without a Zustand
// store or repository in the loop — MapPanel's own tests (wiring) don't need
// to re-prove this state machine.
//
// Real timers throughout except the one test that pins the 1500ms
// 'saved'-auto-hide delay — `waitFor`'s own internal polling uses whatever
// timer implementation is active, so mixing it with fake timers elsewhere
// just hangs until the real 5s test timeout.

import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MapSaveBar } from './MapSaveBar';
import type { MapSaveBarProps } from './MapSaveBar';

function renderBar(overrides: Partial<MapSaveBarProps> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onDiscardCity = vi.fn();
  const props: MapSaveBarProps = {
    pendingTotal: 2,
    pendingInCity: 2,
    cityLabel: 'Shanghai',
    hint: null,
    online: true,
    onSave,
    onDiscardCity,
    ...overrides,
  };
  const utils = render(<MapSaveBar {...props} />);
  return { ...utils, onSave, onDiscardCity, props };
}

describe('MapSaveBar — resting / pending', () => {
  it('renders nothing visible when there is nothing staged', () => {
    renderBar({ pendingTotal: 0, pendingInCity: 0 });
    expect(screen.queryByRole('region', { name: 'Map save status' })).not.toBeInTheDocument();
  });

  it('shows the total count, not just the current city\'s count', () => {
    renderBar({ pendingTotal: 3, pendingInCity: 1, hint: '+2 more in Suzhou' });
    expect(screen.getByText('3 unsaved changes')).toBeInTheDocument();
    expect(screen.getByText('+2 more in Suzhou')).toBeInTheDocument();
  });

  it('singularizes the count text at 1', () => {
    renderBar({ pendingTotal: 1, pendingInCity: 1 });
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
  });

  it('names the current city on the Discard button', () => {
    renderBar({ cityLabel: 'Suzhou' });
    expect(screen.getByRole('button', { name: 'Discard (Suzhou)' })).toBeInTheDocument();
  });

  it('disables Discard, with an explanatory hint, when nothing is staged in the current city', () => {
    renderBar({ pendingTotal: 2, pendingInCity: 0, hint: 'All changes are in Suzhou' });
    const discard = screen.getByRole('button', { name: 'Discard (Shanghai)' });
    expect(discard).toBeDisabled();
    expect(discard).toHaveAttribute('title', 'Nothing staged in Shanghai to discard');
    const describedBy = discard.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'Nothing staged in Shanghai to discard',
    );
  });

  it('keeps Save enabled off the cross-city total even when the current city has nothing local', () => {
    renderBar({ pendingTotal: 1, pendingInCity: 0, hint: 'All changes are in Suzhou' });
    expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled();
  });
});

describe('MapSaveBar — offline', () => {
  it('disables Save and shows the offline note, but keeps Discard enabled', () => {
    renderBar({ online: false, pendingTotal: 1, pendingInCity: 1 });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard (Shanghai)' })).not.toBeDisabled();
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
  });

  it('shows the offline note instead of a generic error when both are true at once', () => {
    renderBar({ online: false, pendingTotal: 1, pendingInCity: 1 });
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect(screen.queryByText(/check your connection/)).not.toBeInTheDocument();
  });

  // STACKED MESSAGING precedence (mockup/map-save-changes.html): a save can
  // fail while genuinely online (a real error, correctly shown), and THEN the
  // connection can drop before that failure is dismissed -- offline must win
  // once both are true, not just when the bar starts offline from a fresh
  // render (the case above).
  it('a save that fails while online shows the error, then dropping offline afterwards replaces it with the offline note (not both)', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network down'));
    const { rerender, props } = renderBar({ online: true, onSave });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/check your connection/)).toBeInTheDocument();
    expect(screen.queryByText(/You're offline/)).not.toBeInTheDocument();

    // Connection drops while the error is still showing -- same component
    // instance, same still-staged changes, only `online` flips.
    rerender(<MapSaveBar {...props} online={false} />);

    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect(screen.queryByText(/check your connection/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('MapSaveBar — saving / saved / error', () => {
  async function flush() {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('walks saving -> saved, announces it, and auto-hides after a beat', async () => {
    vi.useFakeTimers();
    try {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const { rerender, props } = renderBar({ onSave });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(screen.getByText('Saving…')).toBeInTheDocument();

      await act(() => flush());
      expect(screen.getByText('Changes saved.')).toBeInTheDocument();

      // A real Save commits the staged changes, so the parent's own
      // pendingTotal/pendingInCity drop to 0 once the store reflects it —
      // simulated here via a prop update, same as MapPanel re-rendering
      // after `stagedAssignments` clears.
      rerender(<MapSaveBar {...props} pendingTotal={0} pendingInCity={0} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
        await flush();
      });
      expect(screen.queryByRole('region', { name: 'Map save status' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('walks saving -> error and keeps staging intact (reassuring copy)', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('network down'));
    renderBar({ onSave });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        "Couldn't save — check your connection. Your changes are still here, safe on this device.",
      ),
    );
    // Still shows the Save/Discard row — retryable, nothing hidden.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});

describe('MapSaveBar — discard confirm', () => {
  it('requires a two-step confirm, names the count and city, and focuses "Keep editing" on open', async () => {
    renderBar({ pendingTotal: 3, pendingInCity: 2, cityLabel: 'Shanghai' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard (Shanghai)' }));
    expect(screen.getByText('Discard 2 unsaved changes in Shanghai?')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus());
  });

  it('"Keep editing" cancels and returns focus to Discard', async () => {
    renderBar({ pendingTotal: 2, pendingInCity: 2 });
    const discardBtn = screen.getByRole('button', { name: 'Discard (Shanghai)' });
    fireEvent.click(discardBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByText('2 unsaved changes')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard (Shanghai)' })).toHaveFocus());
  });

  it('Escape cancels the confirm step, same as "Keep editing"', () => {
    renderBar({ pendingTotal: 2, pendingInCity: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Discard (Shanghai)' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(/Discard 2 unsaved changes/)).not.toBeInTheDocument();
  });

  it('confirming calls onDiscardCity and moves focus to Save when other cities still have staged changes', async () => {
    const onDiscardCity = vi.fn();
    renderBar({ pendingTotal: 3, pendingInCity: 2, onDiscardCity });
    fireEvent.click(screen.getByRole('button', { name: 'Discard (Shanghai)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onDiscardCity).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toHaveFocus());
  });

  it('confirming falls back to the caller-provided focus target when nothing is staged anywhere afterwards', async () => {
    const fallback = document.createElement('button');
    fallback.textContent = 'Map';
    document.body.appendChild(fallback);
    const fallbackFocusRef = { current: fallback };
    const onDiscardCity = vi.fn();
    renderBar({ pendingTotal: 2, pendingInCity: 2, onDiscardCity, fallbackFocusRef });
    fireEvent.click(screen.getByRole('button', { name: 'Discard (Shanghai)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(fallback).toHaveFocus());
    fallback.remove();
  });
});
