import React, { useEffect, useId, useRef, useState } from 'react';
import type { KnowledgeUsageVote } from '../../../../shared/knowledge-usage';
import { canInvoke, invoke } from '../../api';
import { Button } from '../ui';
import { InlineError } from './controls';
import { errorMessage, useScopeGuard } from './useIntelligence';

const VOTES = [['helped', 'Helped'], ['not-helpful', 'Not helpful']] as const;
type SendVote = () => Promise<boolean>;

/** A control is keyed by its receipt; accepting a vote never implies a vote on a newer lookup. */
export function LookupFeedback({ sessionId, receipt, label, initialVote, disabled, submit }: {
  sessionId: string;
  receipt: string;
  label: string;
  initialVote?: KnowledgeUsageVote;
  disabled: boolean;
  submit?: (send: SendVote) => Promise<boolean | undefined>;
}) {
  const labelId = useId();
  const capture = useScopeGuard();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(initialVote);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { setSelected(initialVote); }, [initialVote]);

  const rate = async (vote: KnowledgeUsageVote) => {
    const current = capture();
    if (!current() || pending.current || disabled || unavailable || vote === selected) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const send = () => invoke('intelligence:usage:vote', { sessionId, receipt, vote });
      const accepted = await (submit ? submit(send) : send());
      if (!current()) return;
      if (accepted === true) setSelected(vote);
      else if (accepted === false) {
        setUnavailable(true);
        setError('This lookup can no longer be rated. Feedback may have expired or tracking may be off.');
      }
    } catch (e) {
      if (current()) setError(errorMessage(e));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  if (!canInvoke('intelligence:usage:vote')) return null;
  return (
    <div className="knowledge-lookup-feedback" role="group" aria-labelledby={labelId}>
      <div className="intelligence-row">
        <span id={labelId} className="muted small">{label}</span>
        {VOTES.map(([vote, text]) => <Button key={vote} size="sm" variant={selected === vote ? 'primary' : 'default'}
          aria-pressed={selected === vote} disabled={disabled || busy || unavailable} onClick={() => void rate(vote)}>{text}</Button>)}
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}
