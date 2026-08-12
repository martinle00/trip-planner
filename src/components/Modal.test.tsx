// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from './Modal';

/** A parent that rebuilds `onClose` on every render — the common shape, and
 *  the one that used to steal focus back to the close button on each
 *  keystroke because the focus-trap effect listed `onClose` as a dependency. */
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [text, setText] = useState('');
  return (
    <Modal open onClose={() => onClose()} labelledBy="t">
      <h2 id="t">Title</h2>
      <button aria-label="Close">x</button>
      <input aria-label="City" value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

describe('Modal', () => {
  it('keeps focus in the field while typing, even when onClose is unstable', () => {
    render(<Harness />);

    const input = screen.getByLabelText('City') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'Bei' } });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'Beijing' } });

    expect(input).toHaveFocus();
    expect(input.value).toBe('Beijing');
  });

  it('closes on Escape using the latest onClose', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Xi' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
