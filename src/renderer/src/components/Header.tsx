import React, { useEffect, useMemo, useState } from 'react';
import type { EffortLevel, ModelInfo, PermissionMode, SessionMeta } from '../../../shared/types';
import { EFFORT_LEVELS, HARNESS_BY_ID, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { basename, fmtCost, fmtTokens } from '../format';
import { useStore } from '../store';
import { Badge, Button, Dropdown, Icon, MenuItem, StatusDot } from './ui';
import { harnessShort } from './Sidebar';

/** Stable fallback so zustand selectors never return a fresh array (React #185 infinite loop). */
const EMPTY: never[] = [];

export function Header({ session }: { session: SessionMeta }) {
  const models = useStore((s) => s.models[session.id] ?? EMPTY);
  const panelOpen = useStore((s) => s.panelOpen);
  const togglePanel = useStore((s) => s.togglePanel);
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

  const grouped = useMemo(() => {
    const g = new Map<string, ModelInfo[]>();
    for (const m of models) g.set(m.provider, [...(g.get(m.provider) ?? EMPTY), m]);
    return [...g.entries()];
  }, [models]);

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
        <button type="button" className="header-path" title={session.cwd} onClick={() => void invoke('app:openPath', { path: session.cwd })}>
          <Icon name="folder" size={12} /> {basename(session.cwd)}
          {branch && (
            <>
              <Icon name="branch" size={12} /> {branch}
            </>
          )}
        </button>
        {session.statusDetail && busy && <span className="header-status muted">{session.statusDetail}</span>}
      </div>

      <div className="header-controls">
        <Dropdown align="right" width={360} trigger={(open) => <button type="button" className={`pill ${open ? 'open' : ''}`} title="Model"><Icon name="sparkles" size={13} /> {current?.model ?? 'default model'} <Icon name="chevron" size={12} /></button>}>
          {(close) => (
            <div className="menu-scroll">
              {grouped.length === 0 && <div className="menu-empty">No model list yet{h.capabilities.liveModelSwitch ? '' : ' (this harness cannot switch models live)'}.</div>}
              {grouped.map(([provider, list]) => (
                <div key={provider}>
                  <div className="menu-group">{provider}</div>
                  {list.map((m) => (
                    <MenuItem key={`${m.provider}/${m.id}`} active={current?.model === m.id && current?.provider === m.provider} hint={m.pricing ? `$${m.pricing.input}/$${m.pricing.output}` : undefined} onClick={() => { close(); void setModel(m); }}>
                      {m.displayName}
                    </MenuItem>
                  ))}
                </div>
              ))}
            </div>
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

        <Button variant="ghost" size="sm" icon={showThinking ? 'eye' : 'eyeOff'} onClick={toggleThinking} title={showThinking ? 'Hide thinking' : 'Show thinking'} />
        {busy && <Button variant="danger" size="sm" icon="stop" onClick={() => void invoke('sessions:interrupt', { id: session.id })} title="Interrupt (Esc)">Stop</Button>}
        <Button variant={panelOpen ? 'subtle' : 'ghost'} size="sm" icon="layout" onClick={() => togglePanel()} title="Toggle panel (Ctrl+J)" />
        <Dropdown align="right" width={220} trigger={() => <Button variant="ghost" size="sm" icon="more" aria-label="More" />}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); void invoke('sessions:compact', { id: session.id }).then((r) => toast(r.ok ? 'Compaction requested' : r.detail ?? 'Not supported', r.ok ? 'success' : 'error')); }}>Compact context</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:export', { id: session.id }).then((r) => r.path && toast(`Exported to ${r.path}`, 'success')); }}>Export Markdown</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:fork', { id: session.id }).then((f) => f && useStore.getState().setActive(f.id)); }}>Fork session</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('app:openInEditor', { path: session.cwd }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error')); }}>Open in editor</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('app:openTerminal', { cwd: session.cwd }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error')); }}>Open terminal here</MenuItem>
              <MenuItem onClick={() => { close(); if (confirm('Clear the visible transcript? Harness state is kept.')) { void invoke('sessions:clearTranscript', { id: session.id }); useStore.getState().clearTranscriptLocal(session.id); } }}>Clear transcript</MenuItem>
              <MenuItem onClick={() => { close(); void invoke('sessions:stop', { id: session.id }); }} disabled={session.status === 'idle' && !busy}>Stop harness process</MenuItem>
            </>
          )}
        </Dropdown>
      </div>
    </header>
  );
}
