import React, { useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { FAST_MODE_COST_WARNING, fastModeSupport } from '../../../shared/fast-mode';
import { canInvoke } from '../api';
import { setSessionFastMode } from '../sessionActions';
import { useStore } from '../store';
import { askConfirm, Spinner } from './ui';

/** The switch is the request; only runtime status can say that Fast mode is actually on. */
export function FastModePill({ session }: { session: SessionMeta }) {
  const providers = useStore((s) => s.settings?.providers);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const support = fastModeSupport(session.config.harness, session.activeModel ?? session.config.model, providers);
  const busy = session.status === 'running' || session.status === 'starting' || session.status === 'awaiting';
  const requested = !!session.config.fastMode;
  const state = session.fastModeStatus?.state ?? (requested ? 'requested' : 'off');
  const reason = !canInvoke('sessions:setFastMode') ? 'Fast mode cannot be changed from this connection.' : !requested && !support.supported ? support.reason ?? 'Fast mode is not supported on this route.' : busy ? 'Stop the session before changing Fast mode.' : undefined;
  const detail = [reason, !support.supported ? support.reason : undefined, session.fastModeStatus?.detail, error].filter(Boolean).join(' ');

  const change = async () => {
    if (pending || reason) return;
    setPending(true);
    setError(undefined);
    try {
      if (!requested && !await askConfirm({ title: 'Enable Fast mode?', body: FAST_MODE_COST_WARNING, confirmLabel: 'Enable Fast mode' })) return;
      await setSessionFastMode(session.id, !requested);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="row gap6">
      <button type="button" className="pill" role="switch" aria-label="Request Fast mode" aria-checked={requested} aria-busy={pending} disabled={pending || !!reason} title={detail || FAST_MODE_COST_WARNING} onClick={() => void change()}>
        {pending && <Spinner size={11} />} Fast · {state}
      </button>
      {error && <span role="alert" className="small">Fast mode change failed: {error}</span>}
    </span>
  );
}
