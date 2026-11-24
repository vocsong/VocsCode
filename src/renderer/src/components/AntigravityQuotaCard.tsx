import React, { useState } from 'react';
import type { AntigravityQuota } from '../../../shared/harness-setup';
import { canInvoke, invoke, invokeErrorMessage, isWeb } from '../api';
import { Meter } from './analytics/charts';
import { Button } from './ui';

type QuotaState = { kind: 'idle' | 'loading' } | { kind: 'ready'; quota: AntigravityQuota } | { kind: 'error'; message: string };

/** Account quota is an explicit desktop-only read, not session telemetry. */
export function AntigravityQuotaCard() {
  const [state, setState] = useState<QuotaState>({ kind: 'idle' });
  const canCheck = !isWeb && canInvoke('harness:antigravityQuota');
  const busy = state.kind === 'loading';

  const check = async () => {
    if (!canCheck || busy) return;
    setState({ kind: 'loading' });
    try {
      const quota = await invoke('harness:antigravityQuota', undefined);
      setState({ kind: 'ready', quota });
    } catch (error) {
      setState({ kind: 'error', message: invokeErrorMessage(error) });
    }
  };

  return (
    <section className="usage-block usage-quota" aria-label="Antigravity account quota">
      <div className="usage-block-head">
        <h5>Antigravity account quota</h5>
        {canCheck && <Button size="sm" variant="subtle" icon="refresh" disabled={busy} onClick={() => void check()}>
          {state.kind === 'ready' ? 'Refresh quota' : 'Check quota'}
        </Button>}
      </div>
      <div className="usage-note" role="status">
        {!canCheck ? 'Account quota is available in the desktop app.' : busy ? 'Checking Antigravity quota…' : 'Remaining quota on your Google account, shared across sessions.'}
      </div>
      {canCheck && state.kind === 'error' && <div className="callout warn" role="alert">{state.message}</div>}
      {canCheck && state.kind === 'ready' && state.quota.groups.map((group) => (
        <div className="usage-quota-group" key={group.name}>
          <strong>{group.name}</strong>
          {group.buckets.map((bucket) => <Meter
            key={bucket.name}
            label={bucket.name}
            value={bucket.remainingFraction}
            sub={bucket.resetAt ? `Resets ${new Date(bucket.resetAt).toLocaleString()}` : undefined}
          />)}
        </div>
      ))}
    </section>
  );
}
