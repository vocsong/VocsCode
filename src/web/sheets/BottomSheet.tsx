/** One modal panel from the bottom of the screen (a centered dialog on wide screens). Escape closes
 *  it, focus moves into it on open and returns to whatever opened it on close. */
import React, { useEffect, useRef } from 'react';

export function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="w-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="w-sheet" ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="w-sheet-grab" aria-hidden />
        <h2 className="w-sheet-title">{title}</h2>
        <div className="w-sheet-body">{children}</div>
      </div>
    </div>
  );
}
