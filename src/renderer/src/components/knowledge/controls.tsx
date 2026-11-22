import React, { useId, useState } from 'react';
import type { IntelligenceView } from '../../../../shared/intelligence';
import { Button, Spinner } from '../ui';

export const REFLECTION_PRIVACY_NOTICE = 'Reflection can send excerpts from the session transcript to your configured background model provider to extract candidate lessons.';

export function shortDate(at: string) {
  const date = new Date(at);
  return Number.isNaN(date.valueOf()) ? at : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Keeps failed operations next to the controls that can retry them. */
export function InlineError({ children }: { children?: string }) {
  return children ? <p className="intelligence-error" role="alert">{children}</p> : null;
}

/** Keep the trigger in place so the next Tab reaches the confirmation. */
export function ConfirmAction({ label, detail, testId, busy, onConfirm }: {
  label: string;
  detail: string;
  testId: string;
  busy: boolean;
  onConfirm: () => Promise<boolean>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" disabled={busy} aria-expanded={open} aria-controls={id} data-testid={testId} onClick={() => setOpen(!open)}>{label}</Button>
      <div id={id} className="intelligence-inline" hidden={!open} data-dialog-anchor={open ? true : undefined}>
        {open && <>
          <p className="muted small">{detail}</p>
          <div className="intelligence-actions">
            <Button size="sm" variant="danger" disabled={busy} data-testid={`${testId}-confirm`} onClick={async () => {
              if (await onConfirm()) setOpen(false);
            }}>Confirm {label.toLowerCase()}</Button>
          </div>
        </>}
      </div>
    </>
  );
}

export type PromotionTarget = { to: 'personal' } | { to: 'collection'; collectionId: string };

/** Widening scope always names a destination; listing a collection is not by itself a grant. */
export function PromoteControl({ prefix, view, busy, disabledReason, loadError, onLoad, onPromote }: {
  prefix: 'memory' | 'knowledge';
  view: IntelligenceView | null;
  busy: boolean;
  disabledReason?: string;
  loadError?: string;
  onLoad?: () => void;
  onPromote: (target: PromotionTarget) => Promise<boolean>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const collections = view?.collections.filter((c) => c.members.some((member) => member.projectId === view.project.id)) ?? [];
  const selected = choice === 'personal' || collections.some((c) => c.id === choice) ? choice : '';
  return (
    <>
      <Button size="sm" disabled={busy || !!disabledReason} title={disabledReason} aria-expanded={open && !disabledReason}
        aria-controls={id} data-testid={`${prefix}-promote`} onClick={() => {
          setOpen(!open);
          if (!open && !view) onLoad?.();
        }}>Promote</Button>
      <div id={id} className="intelligence-inline" hidden={!open || !!disabledReason}>
        {open && !disabledReason && (
          !view ? (
            loadError ? <>
              <InlineError>{loadError}</InlineError>
              <Button size="sm" disabled={busy} onClick={onLoad}>Retry</Button>
            </> : <div className="intelligence-row muted small" role="status"><Spinner size={12} /> Reading promotion destinations…</div>
          ) : !view.available ? <InlineError>{view.reason ?? 'The memory ledger is unavailable.'}</InlineError> : (
            <>
              <label className="intelligence-field">Promote to
                <select data-testid={`${prefix}-promote-target`} value={selected} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
                  <option value="" disabled>Choose a destination</option>
                  {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="personal">Personal memory</option>
                </select>
              </label>
              <div className="intelligence-actions">
                <Button size="sm" variant="primary" data-testid={`${prefix}-promote-confirm`} disabled={busy || !selected} onClick={async () => {
                  if (!selected) return;
                  const target: PromotionTarget = selected === 'personal' ? { to: 'personal' } : { to: 'collection', collectionId: selected };
                  if (await onPromote(target)) {
                    setOpen(false);
                    setChoice('');
                  }
                }}>Confirm promotion</Button>
              </div>
            </>
          )
        )}
      </div>
    </>
  );
}
