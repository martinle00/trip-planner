// Generic modal: overlay-click-to-close, Escape to close, focus trap, and
// restores focus to whatever triggered it on close. Mirrors the mockup's
// openAutoPlan()/closeAutoPlan() focus-trap behavior, generalized so any
// dialog in the app can reuse it.

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null);
}

export function Modal({ open, onClose, labelledBy, children }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Read through a ref so the effect below keys on `open` alone. Callers
  // routinely pass an inline/rebuilt `onClose`; with it in the dep array the
  // effect re-ran on every render of the parent, and its initial-focus call
  // yanked focus back to the close button on every keystroke inside the modal.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    if (modal) {
      const focusables = getFocusable(modal);
      (focusables[0] ?? modal).focus();
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !modal) return;
      const items = getFocusable(modal);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('keydown', onKeydown);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        ref={modalRef}
      >
        {children}
      </div>
    </div>
  );
}
