// @vitest-environment jsdom
//
// Component tests for PlaceDetailModal (Phase 4 items 3/4/5): the local
// draft-then-explicit-save model, the merge-divider rendering for an
// append-both conflict, and the save-error/retry path. Store actions
// (getPlaceDraft/savePlaceDraft/discardPlaceDraft/commitPlaceDraft) are
// stubbed with an in-memory fake keyed by placeId (mirroring how
// AddPlaceModal.test.tsx stubs addPlace) rather than touching real
// Dexie/IndexedDB — "draft persistence across a remount" is proven by
// unmounting and remounting against the SAME fake store, the same way a real
// reload would re-read the same IndexedDB row.
//
// Fake timers are used throughout to assert the 500ms draft-save debounce
// precisely; `flush()` (two 0ms fake-timer advances) drains pending
// microtasks without advancing the debounce clock — same pattern as
// AddPlaceModal.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PlaceDetailModal } from './PlaceDetailModal';
import { useTripStore } from '../../store/useTripStore';
import type { PlaceDraft } from '../../data/draftRepository';
import { appendRemoteIfDifferent } from '../../lib/proseMerge';
import type { Place } from '../../data/schema';

let onlineMock = true;
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineMock,
}));

// The exact copy from the approved mockup — pinned here (not imported, since
// it's intentionally module-private in PlaceDetailModal.tsx) so a test
// failure reads as "the user-facing string changed", not just "a string
// changed somewhere".
const SAVE_ERROR_FALLBACK = "Couldn't save — check your connection. Your draft is still here, safe on this device.";

const PLACE: Place = {
  id: 'place-1',
  tripId: 'trip-1',
  name: 'Hongya Cave',
  category: 'Landmark',
  city: 'Chongqing',
  lat: 1,
  lng: 1,
  status: 'wishlist',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let draftStore: Record<string, { description?: string; selfReview?: string }>;
let commitImpl: (placeId: string) => Promise<{ place: Place; merged: boolean }>;

function resetStore() {
  draftStore = {};
  commitImpl = async (placeId) => {
    const draft = draftStore[placeId];
    const updated: Place = {
      ...PLACE,
      description: draft?.description,
      selfReview: draft?.selfReview,
      updatedAt: new Date().toISOString(),
    };
    delete draftStore[placeId];
    return { place: updated, merged: false };
  };

  useTripStore.setState({
    getPlaceDraft: vi.fn(async (placeId: string): Promise<PlaceDraft | undefined> => {
      const d = draftStore[placeId];
      if (!d) return undefined;
      return { placeId, description: d.description, selfReview: d.selfReview, baseUpdatedAt: PLACE.updatedAt, savedAt: new Date().toISOString() };
    }),
    savePlaceDraft: vi.fn(async (placeId: string, fields: { description?: string; selfReview?: string }) => {
      draftStore[placeId] = { ...draftStore[placeId], ...fields };
    }),
    discardPlaceDraft: vi.fn(async (placeId: string) => {
      delete draftStore[placeId];
    }),
    commitPlaceDraft: vi.fn((placeId: string) => commitImpl(placeId)),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  onlineMock = true;
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

describe('PlaceDetailModal — local draft persistence', () => {
  it('debounce-saves a draft while typing, and it survives a remount (simulating a reload)', async () => {
    const { unmount } = render(
      <PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />,
    );
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    const textarea = screen.getByPlaceholderText(/What should you know before visiting/);
    fireEvent.change(textarea, { target: { value: 'Go at dusk for the lights' } });

    // Not yet — the debounce hasn't fired.
    await flush();
    expect(draftStore['place-1']).toBeUndefined();

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(draftStore['place-1']?.description).toBe('Go at dusk for the lights');

    unmount();

    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Go at dusk for the lights')).toBeInTheDocument();
  });

  it('reports draft existence via onDraftChange as the user types and after discarding', async () => {
    const onDraftChange = vi.fn();
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={onDraftChange} />);
    await flush();

    fireEvent.click(screen.getByText('+ Write a review'));
    fireEvent.change(screen.getByPlaceholderText(/How did it go/), { target: { value: 'Loved it' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(onDraftChange).toHaveBeenCalledWith('place-1', true);

    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' })); // opens the confirm step
    await flush();
    expect(screen.getByText('Discard this draft?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' })); // confirms
    await flush();

    expect(onDraftChange).toHaveBeenCalledWith('place-1', false);
    expect(draftStore['place-1']).toBeUndefined();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
});

describe('PlaceDetailModal — focus stability while typing (code-review regression)', () => {
  it('keeps real DOM focus on the textarea across keystrokes', async () => {
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    const textarea = screen.getByPlaceholderText(/What should you know before visiting/) as HTMLTextAreaElement;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    // Modal.tsx's focus-trap effect is keyed on [open, onClose]. If the
    // `onClose` this component hands to <Modal> isn't a stable identity
    // (e.g. a plain nested function recreated every render), typing —
    // which re-renders this component on every keystroke — re-triggers that
    // effect and re-focuses the modal's first focusable element (or the
    // modal shell itself), yanking real focus out of the textarea after
    // essentially one character. Asserting real `document.activeElement`
    // here, not just the controlled value, is what actually catches that;
    // `fireEvent.change` alone doesn't depend on focus at all.
    for (const value of ['G', 'Go', 'Go a', 'Go at', 'Go at dusk']) {
      fireEvent.change(textarea, { target: { value } });
      expect(document.activeElement).toBe(textarea);
    }
  });
});

describe('PlaceDetailModal — switching places mid-debounce (code-review regression)', () => {
  it("flushes place A's pending draft before place B's editing session starts", async () => {
    const placeB: Place = { ...PLACE, id: 'place-2', name: 'Ciqikou Ancient Town' };

    // PlacesPanel renders exactly one <PlaceDetailModal> and reuses that
    // same component instance for every place, only ever changing the
    // `place` prop — `rerender` is what actually mirrors that (a real
    // unmount+remount would reset every ref, masking the bug this guards).
    const { rerender } = render(
      <PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />,
    );
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    fireEvent.change(screen.getByPlaceholderText(/What should you know before visiting/), {
      target: { value: 'Notes for A' },
    });

    // Switch straight to place B WITHOUT letting A's 500ms debounce fire
    // first — an ordinary "glance at another place mid-thought" interaction.
    rerender(<PlaceDetailModal place={placeB} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    fireEvent.change(screen.getByPlaceholderText(/What should you know before visiting/), {
      target: { value: 'Notes for B' },
    });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    // Neither place's text was silently dropped.
    expect(draftStore['place-1']?.description).toBe('Notes for A');
    expect(draftStore['place-2']?.description).toBe('Notes for B');
  });
});

describe('PlaceDetailModal — merge divider rendering', () => {
  it('renders a visual divider instead of the raw sentinel for already-merged prose', async () => {
    const merged = appendRemoteIfDifferent('my write-up', "partner's write-up")!;
    const place: Place = { ...PLACE, selfReview: merged };
    render(<PlaceDetailModal place={place} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    expect(screen.getByText('my write-up')).toBeInTheDocument();
    expect(screen.getByText("partner's write-up")).toBeInTheDocument();
    expect(screen.getByText('Also written on another device')).toBeInTheDocument();
    // The raw sentinel line (with its em dashes) must never appear as text —
    // only the rendered divider should.
    expect(screen.queryByText(/— Also written on another device —/)).not.toBeInTheDocument();
  });
});

describe('PlaceDetailModal — save', () => {
  it('shows the merge-conflict banner when commitPlaceDraft reports an auto-resolved conflict', async () => {
    commitImpl = async (placeId) => {
      const draft = draftStore[placeId];
      delete draftStore[placeId];
      return { place: { ...PLACE, description: draft?.description, updatedAt: new Date().toISOString() }, merged: true };
    };
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    fireEvent.change(screen.getByPlaceholderText(/What should you know before visiting/), { target: { value: 'Some notes' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await flush();

    expect(screen.getByText(/your partner also edited this on another device/)).toBeInTheDocument();
  });

  it('keeps the draft intact so Save is retryable after a failed commit', async () => {
    useTripStore.setState({ commitPlaceDraft: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Write a review'));
    fireEvent.change(screen.getByPlaceholderText(/How did it go/), { target: { value: 'Great' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await flush();

    // Still in edit mode with the unsaved-changes pill showing, and the
    // draft itself untouched — the whole point of the local-draft model is
    // that a failed save never loses anything typed.
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Great')).toBeInTheDocument();
    expect(draftStore['place-1']?.selfReview).toBe('Great');
  });

  // Code-review fast-follow (QA-flagged): commitPlaceDraft's real failure
  // path runs through SyncedTripRepository -> SupabaseTripRepository ->
  // postgrest-js, which rethrows the raw fetch/network error verbatim for a
  // non-retryable client method — a browser `TypeError: Failed to fetch` for
  // an offline save, in practice. The UI must never render that raw message:
  // the reassurance in the second half of SAVE_ERROR_FALLBACK ("your draft
  // is still here, safe on this device") is the whole point of this feature,
  // and a technical string tells the user nothing about whether their
  // three-paragraph review survived.
  it('never renders the raw error — always the friendly fallback copy, even for a raw TypeError', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawError = new TypeError('Failed to fetch');
    useTripStore.setState({ commitPlaceDraft: vi.fn().mockRejectedValue(rawError) });
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Write a review'));
    fireEvent.change(screen.getByPlaceholderText(/How did it go/), { target: { value: 'Great' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await flush();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(SAVE_ERROR_FALLBACK);
    expect(alert.textContent).not.toContain('Failed to fetch');
    // The real error isn't swallowed either — just not shown to the user.
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), rawError);

    consoleErrorSpy.mockRestore();
  });

  it('short-circuits when offline, without ever attempting the doomed network write', async () => {
    onlineMock = false;
    const commitPlaceDraft = vi.fn();
    useTripStore.setState({ commitPlaceDraft });
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={() => {}} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Write a review'));
    fireEvent.change(screen.getByPlaceholderText(/How did it go/), { target: { value: 'Great' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await flush();

    expect(commitPlaceDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(SAVE_ERROR_FALLBACK);
    expect(screen.getByDisplayValue('Great')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Closing while dirty (Phase 4 item 4's "no confirm-on-close" decision): the
// file-header comment and PHASE4.md are explicit that closing (X / overlay /
// Escape) must NEVER be guarded, because the draft is already safely on disk
// regardless of how the modal closes — only the destructive "Discard draft"
// action gets a confirmation step. None of the tests above ever actually
// trigger `onClose` (X, Escape) at all, so this closes that gap: a
// regression that reintroduced a close-time prompt, or that made Escape stop
// closing the modal, would slip past every existing test untouched.
// ---------------------------------------------------------------------------
describe('PlaceDetailModal — closing while dirty is never guarded (Phase 4 item 4)', () => {
  it('the header X closes immediately while a draft is dirty — no confirmation, draft untouched', async () => {
    const onClose = vi.fn();
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={onClose} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    fireEvent.change(screen.getByPlaceholderText(/What should you know before visiting/), {
      target: { value: 'Half-written thought' },
    });
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    // No "Discard this draft?" confirmation was ever shown.
    expect(screen.queryByText('Discard this draft?')).not.toBeInTheDocument();
    // And the draft itself was never touched by closing.
    expect(draftStore['place-1']?.description).toBe('Half-written thought');
  });

  it('Escape closes immediately from edit mode while dirty — no confirmation', async () => {
    const onClose = vi.fn();
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={onClose} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Write a review'));
    fireEvent.change(screen.getByPlaceholderText(/How did it go/), { target: { value: 'Loved every minute' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard this draft?')).not.toBeInTheDocument();
    expect(draftStore['place-1']?.selfReview).toBe('Loved every minute');
  });

  it('Escape during the discard-confirm step backs out to edit mode instead of closing the modal', async () => {
    const onClose = vi.fn();
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={onClose} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    fireEvent.change(screen.getByPlaceholderText(/What should you know before visiting/), { target: { value: 'x' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' })); // opens the confirm step
    expect(screen.getByText('Discard this draft?')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    // The one destructive step in this whole flow is deliberately NOT
    // skippable via Escape — it steps back to edit instead of closing outright.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard this draft?')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('x')).toBeInTheDocument();
  });

  it('Escape does not abandon an in-flight save', async () => {
    let resolveCommit!: (v: { place: Place; merged: boolean }) => void;
    commitImpl = () => new Promise((resolve) => { resolveCommit = resolve; });
    const onClose = vi.fn();
    render(<PlaceDetailModal place={PLACE} pinColor="var(--d-grey)" onClose={onClose} onDraftChange={() => {}} />);
    await flush();

    fireEvent.click(screen.getByText('+ Add notes'));
    fireEvent.change(screen.getByPlaceholderText(/What should you know before visiting/), { target: { value: 'Saving now' } });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await flush();
    expect(screen.getByText('Saving…')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    resolveCommit({ place: { ...PLACE, description: 'Saving now', updatedAt: new Date().toISOString() }, merged: false });
    await flush();
  });
});
