/** One modal panel from the bottom of the screen (a centered dialog on wide screens). */
import React from 'react';

export function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="w-sheet-backdrop" role="presentation" onClick={onClose}>
      <div className="w-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="w-sheet-grab" aria-hidden />
        <h2 className="w-sheet-title">{title}</h2>
        <div className="w-sheet-body">{children}</div>
      </div>
    </div>
  );
}
