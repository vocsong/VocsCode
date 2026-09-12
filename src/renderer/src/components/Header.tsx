import React, { useEffect, useState } from 'react';
import type { EffortLevel, ModelInfo, PermissionMode, SessionMeta } from '../../../shared/types';
import { EFFORT_LEVELS, HARNESS_BY_ID, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { basename, fmtCost, fmtTokens, harnessShort } from '../format';
import { archiveSession } from '../sessionActions';
import { useSessionModels } from '../models';
import { useStore } from '../store';
import { Badge, Button, Dropdown, Icon, MenuItem, StatusDot } from './ui';
import { ForkIntoDropdown } from './ForkInto';
import { ModelPicker } from './ModelPicker';



export function Header({ session }: { session: SessionMeta }) {
  const { models, loading: modelsLoading, error: modelsError } = useSessionModels(session);
  const panelOpen = useStore((s) => s.panelOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const toast = useStore((s) => s.toast);
  const showThinking = useStore((s) => s.showThinking);
  const toggleThinking = useStore((s) => s.toggleThinking);
  const [branch, setBranch] = useState<string | undefined>();
  const changesVersion = useStore((s) => s.changesVersion);
  const h = HARNESS_BY_ID[session.config.harness];

  useEffect(() => {
    invoke('git:summary', { sessionId: session.id })
      .then((g) => setBranch(g.branch))
      .catch(() => setBranch(undefined));
  }, [session.id, changesVersion]);

  const current = session.activeModel ?? session.config.model;
  const currentInfo = models.find((m) => current && m.id === current.model && m.provider === current.provider);
  const effortOptions = currentInfo?.supportedEfforts?.length ? currentInfo.supportedEfforts : [...EFFORT_LEVELS];
  const mode = session.config.permissionMode;
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  const ctxPct = session.usage.contextWindow && session.usage.contextTokens ? Math.min(100, Math.round((session.usage.contextTokens / session.usage.contextWindow) * 100)) : null;

  const setModel = async (m: ModelInfo) => {
    try {
      await invoke('sessions:setModel', { id: session.id, model: { provider: m.provider, model: m.id } });
    } catch (e) {
      toast(`Model switch failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <header className="header">
      <div className="header-title">
        <StatusDot status={session.status} />
        <span className="header-name" title={session.title}>
          {session.title}
        </span>
        <Badge tone="neutral" title={h.name}>
          {harnessShort(session.config.harness)}
          {session.config.harness === 'acp' && session.config.acpAgent ? ` · ${session.config.acpAgent}` : ''}
        </Badge>
        <button type="button" className="header-path" title={session.cwd} onClick={() => void invoke('app:openPath', { path: session.cwd, sessionId: session.id })}>
          <Icon name="folder" size={12} /> {basename(session.cwd)}
        </button>
        {branch && (
          <button type="button" className="header-path" title={`Branch ${branch} — open the Git panel`} onClick={() => setPanelTab('branches')}>
            <Icon name="branch" size={12} /> {branch}
          </button>
        )}
        {session.statusDetail && busy && <span className="header-status muted">{session.statusDetail}</span>}
        <span className="spacer" />
        <Button variant={panelOpen ? 'subtle' : 'ghost'} size="sm" icon="layout" onClick={() => togglePanel()} title="Toggle panel (Ctrl+J)" aria-label="Toggle panel" />
      </div>

      <div className="header-controls">
        <div className="header-pills">
        <Dropdown align="right" width={380} trigger={(open) => <button type="button" className={`pill ${open ? 'open' : ''}`} title="Model"><Icon name="sparkles" size={13} /> {current?.model ?? 'default model'} <Icon name="chevron" size={12} /></button>}>
          {(close) => (
            <ModelPicker
              models={models}
              loading={modelsLoading}
              error={modelsError}
              selected={current}
              emptyText={
                h.capabilities.liveModelSwitch
                  ? 'No models available.'
                  : 'No models available (this harness cannot switch models live).'
              }
              onSelect={(m) => {
                close();
                if (m) void setModel(m);
              }}
            />
          )}
        </Dropdown>

        {h.capabilities.effort && (
          <Dropdown align="right" width={200} trigger={(open) => <button type="button" className={`pill ${open ? 'open' : ''}`} title="Reasoning effort"><Icon name="brain" size={13} /> {session.activeEffort ?? session.config.effort ?? 'effort'} <Icon name="chevron" size={12} /></button>}>
            {(close) => (
              <>
                {effortOptions.map((l) => (
                  <MenuItem key={l} active={(session.activeEffort ?? session.config.effort) === l} onClick={() => { close(); void invoke('sessions:setEffort', { id: session.id, effort: l as EffortLevel }).catch((e) => toast(String(e.message ?? e), 'error')); }}>
                    {l}
                  </MenuItem>
                ))}
              </>
            )}
          </Dropdown>
        )}

        <Dropdown align="right" width={300} trigger={(open) => <button type="button" className={`pill mode-${mode} ${open ? 'open' : ''}`} title={PERMISSION_MODE_LABELS[mode].description}><Icon name="shield" size={13} /> {PERMISSION_MODE_LABELS[mode].short} <Icon name="chevron" size={12} /></button>}>
          {(close) => (
            <>
              {h.capabilities.permissionModes.map((m) => (
                <MenuItem key={m} active={m === mode} hint={PERMISSION_MODE_LABELS[m].description} onClick={() => { close(); void invoke('sessions:setPermissionMode', { id: session.id, mode: m as PermissionMode }); }}>
                  {PERMISSION_MODE_LABELS[m].label}
                </MenuItem>
              ))}
            </>
          )}
        </Dropdown>

        <button type="button" className="pill" title={`Input ${fmtTokens(session.usage.inputTokens)} · Output ${fmtTokens(session.usage.outputTokens)} · Cache read ${fmtTokens(session.usage.cacheReadTokens)}${ctxPct !== null ? ` · Context ${ctxPct}%` : ''}`} onClick={() => useStore.getState().setPanelTab('usage')}>
          <Icon name="chart" size={13} /> {fmtCost(session.usage.costUsd)}
          {ctxPct !== null && (
            <span className="ctx-bar" title={`Context ${ctxPct}% used`}>
              <span style={{ width: `${ctxPct}%` }} />
            </span>
          )}
        </button>

        </div>

        <div className="header-actions">
          <Button variant="ghost" size="sm" icon={showThinking ? 'eye' : 'eyeOff'} onClick={toggleThinking} title={showThinking ? 'Hide thinking' : 'Show thinking'} aria-label={showThinking ? 'Hide thinking' : 'Show thinking'} />
          <ForkIntoDropdown
            session={session}
            onForked={(f) => useStore.getState().setActive(f.id)}
            trigger={() => <Button variant="ghost" size="sm" icon="fork" title="Fork into another harness" aria-label="Fork session" />}
          />
          <Button
            variant="ghost"
            size="sm"
            icon="archive"
            title={session.worktreeBranch ? 'Archive & remove worktree' : 'Archive'}
            aria-label="Archive session"
            onClick={() => void archiveSession(session, toast)}
          />
        </div>
      </div>
    </header>
  );
}
