import React, { useEffect, useState } from 'react';
import type { MissionRecord } from '../../../../shared/mission';
import { invoke } from '../../api';
import { MISSION_MANAGED_REASON } from '../../missions';
import { DiffView } from '../DiffView';
import { Button, Spinner } from '../ui';
import './mission.css';

export function MissionWorkspacePicker({ record, value, onChange }: { record: MissionRecord; value: string; onChange: (value: string) => void }) {
  const selected = record.workspaces.find((workspace) => workspace.id === value) ?? record.workspaces.find((workspace) => workspace.role === 'integration');
  return <div className="mission-ui mission-workspace">
    <label>Read-only workspace <select aria-label="Mission workspace" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Mission result · accepted integration</option>{record.workspaces.filter((workspace) => ['lead', 'worker'].includes(workspace.role) && !workspace.cleanedAt).map((workspace) => {
      const attempt = record.attempts.find((a) => a.workspaceId === workspace.id);
      return <option value={workspace.id} key={workspace.id}>{workspace.role === 'lead' ? 'Lead tool workspace' : `${attempt?.profile?.name ?? attempt?.taskId ?? 'Specialist'} workspace`} · unaccepted changes</option>;
    })}</select></label>
    <p className="mono small">{selected?.path ?? 'Integration workspace is not provisioned yet.'}</p>
    <p className="small muted">The lead's coding tools and interactive terminal use its own worktree, not the accepted integration result.</p>
  </div>;
}

export function MissionChanges({ record, workspaceId }: { record: MissionRecord; workspaceId: string }) {
  const [data, setData] = useState<{ diff: string; error?: string }>();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let stale = false;
    setData(undefined);
    setError(undefined);
    invoke('git:diff', { sessionId: record.leadSessionId, missionWorkspaceId: workspaceId || undefined }).then((value) => { if (!stale) setData(value); }).catch((e) => { if (!stale) setError(String(e.message ?? e)); });
    return () => { stale = true; };
  }, [record.leadSessionId, record.revision, workspaceId, nonce]);
  return <div className="mission-ui pad" data-testid="mission-changes"><div className="row gap8"><strong>{workspaceId ? 'Agent workspace · unaccepted changes' : 'Mission result'}</strong><Button size="sm" onClick={() => setNonce((n) => n + 1)}>Refresh diff</Button></div>
    <p className="muted small">{MISSION_MANAGED_REASON}</p>
    {!data && !error && <Spinner />}{(error || data?.error) && <p role="alert">{error ?? data?.error}</p>}{data && <DiffView diff={data.diff} />}
  </div>;
}
