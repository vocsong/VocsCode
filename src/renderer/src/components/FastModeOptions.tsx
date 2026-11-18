import React, { useId, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { FAST_MODE_COST_WARNING, fastModeSupport } from '../../../shared/fast-mode';
import { canInvoke } from '../api';
import { setSessionFastMode } from '../sessionActions';
import { useStore } from '../store';
import { askConfirm, MenuItem, Spinner } from './ui';

const STATUS_LABELS = { off: 'Inactive', requested: 'Requested', on: 'Active', unavailable: 'Unavailable', cooldown: 'Cooldown' };

/** On/Off selects the request; the header reports what the runtime actually did. */
export function FastModeOptions({ session }: { session: SessionMeta }) {
  const labelId = useId();
  const reasonId = useId();
  const providers = useStore((s) => s.settings?.providers);
  const toast = useStore((s) => s.toast);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const support = fastModeSupport(session.config.harness, session.activeModel ?? session.config.model, providers);
  const busy = session.status === 'running' || session.status === 'starting' || session.status === 'awaiting';
  const requested = !!session.config.fastMode;
  const status = session.fastModeStatus;
  const blocked = !canInvoke('sessions:setFastMode') ? 'Fast mode cannot be changed from this connection.' : busy ? 'Stop the session before changing Fast mode.' : undefined;
  const unavailable = !support.supported ? support.reason ?? 'Fast mode is not supported on this route.' : undefined;
  const reason = blocked ?? unavailable;

  const change = async (enabled: boolean) => {
    if (pending || blocked || enabled === requested || (enabled && unavailable)) return;
    setPending(true);
    setError(undefined);
    try {
      if (enabled && !await askConfirm({ title: 'Enable Fast mode?', body: FAST_MODE_COST_WARNING, confirmLabel: 'Enable Fast mode' })) return;
      await setSessionFastMode(session.id, enabled);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      // Clicking in the confirmation dismisses the menu; a failed write still needs a toast.
      toast(`Fast mode change failed: ${message}`, 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="run-more-section" role="group" aria-labelledby={labelId} aria-describedby={reason ? reasonId : undefined} aria-busy={pending}>
      <div className="run-more-label row gap6">
        <span id={labelId}>Fast Mode</span>
        <span className="spacer" />
        {pending ? <Spinner size={11} /> : requested && (
          <span className="menu-item-hint" role="status" title={status?.detail}>{STATUS_LABELS[status?.state ?? 'requested']}</span>
        )}
      </div>
      <MenuItem checked={requested} disabled={pending || !!reason} onClick={() => void change(true)}>On</MenuItem>
      <MenuItem checked={!requested} disabled={pending || !!blocked} onClick={() => void change(false)}>Off</MenuItem>
      {reason && <div className="run-more-note" id={reasonId}>{reason}</div>}
      {error && <div role="alert" className="run-more-note">Fast mode change failed: {error}</div>}
    </div>
  );
}
