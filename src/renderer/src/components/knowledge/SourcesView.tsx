import React, { useId, useState } from 'react';
import { resolveIntelligenceSettings, type IntelligenceSettings, type ReflectionMode } from '../../../../shared/intelligence';
import { invoke } from '../../api';
import { Badge, Button, Spinner } from '../ui';
import { InlineError, REFLECTION_PRIVACY_NOTICE, shortDate } from './controls';
import { readIntelligence, type IntelligenceSectionProps } from './useIntelligence';

/** A visible, keyboard-operable switch with the same target for tests and pointer actions. */
function SourceSwitch({ label, testId, checked, disabled, onChange }: {
  label: string;
  testId: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="intelligence-row intelligence-switch">
      <input type="checkbox" role="switch" data-testid={testId} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label} <span className="muted small" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
    </label>
  );
}

/** Separates app-wide switches from this checkout's derived graph status. */
export function SourcesView({ sessionId, view, busy, run }: IntelligenceSectionProps) {
  const { project, gateway, graph } = view;
  const reflectionNote = useId();
  const settings = resolveIntelligenceSettings(view.settings);
  const projectEnabled = settings.graphify.projects.includes(project.id);
  const [indexRequested, setIndexRequested] = useState(false);
  const indexing = indexRequested || graph.indexing;

  const patch = (change: Partial<IntelligenceSettings>) => run(async (current) => {
    await invoke('settings:update', { intelligence: { ...settings, ...change } });
    if (current()) return readIntelligence(sessionId);
  });

  return (
    <div className="intelligence-view">
      <section className="intelligence-card">
        <h3>Tool gateway</h3>
        <SourceSwitch label="Enable tool gateway" testId="setting-gateway" checked={settings.gateway} disabled={busy} onChange={(gateway) => void patch({ gateway })} />
        <p className="muted small" data-testid="gateway-status">{gateway.listening ? 'Listening' : 'Not listening'} · {gateway.sessions} {gateway.sessions === 1 ? 'session' : 'sessions'} connected</p>
        <p className="muted small">Applies to sessions started after the change. With the gateway off, agents keep the six original wiki tools.</p>
      </section>
      <section className="intelligence-card">
        <p id={reflectionNote} className="intelligence-warning small">{REFLECTION_PRIVACY_NOTICE} In automatic mode this can happen when a session is archived or merged.</p>
        <label className="intelligence-field">Session reflection
          <select data-testid="setting-reflection" aria-describedby={reflectionNote} value={settings.reflection} disabled={busy} onChange={(e) => void patch({ reflection: e.target.value as ReflectionMode })}>
            <option value="off">Off</option>
            <option value="manual">Only when asked</option>
            <option value="auto">When a session is archived or merged</option>
          </select>
        </label>
        <SourceSwitch label="Collections search" testId="setting-collections" checked={settings.collections} disabled={busy} onChange={(collections) => void patch({ collections })} />
        <SourceSwitch label="Personal memory" testId="setting-personal" checked={settings.personalMemory} disabled={busy} onChange={(personalMemory) => void patch({ personalMemory })} />
      </section>
      <section className="intelligence-card">
        <h3>Graphify (optional graph index)</h3>
        <SourceSwitch label="Enable Graphify" testId="setting-graphify" checked={settings.graphify.enabled} disabled={busy} onChange={(enabled) => void patch({ graphify: { ...settings.graphify, enabled } })} />
        <SourceSwitch label="Enable for this project" testId="setting-graphify-project" checked={projectEnabled} disabled={busy || !settings.graphify.enabled} onChange={(checked) => void patch({
          graphify: { ...settings.graphify, projects: checked ? [...settings.graphify.projects, project.id] : settings.graphify.projects.filter((id) => id !== project.id) }
        })} />
        <div className="intelligence-row" data-testid="graph-status">
          <Badge tone={graph.installed ? 'neutral' : 'amber'}>{graph.installed ? `Installed${graph.version ? ` · ${graph.version}` : ''}` : 'Not installed'}</Badge>
          <Badge tone={graph.indexed ? 'green' : 'neutral'}>{graph.indexed ? 'Indexed' : 'Not indexed'}</Badge>
          {graph.stale && <Badge tone="amber">Stale</Badge>}
        </div>
        {!graph.installed && <p className="muted small">Install with <code>uv tool install graphifyy==0.9.115</code>.</p>}
        <p className="muted small">The app runs Graphify in AST-only mode; the index is built locally and no code leaves this machine.</p>
        {graph.revision && <p className="muted small">Revision <code title={graph.revision}>{graph.revision.slice(0, 12)}</code></p>}
        {(graph.nodes !== undefined || graph.edges !== undefined) && <p className="muted small">{[graph.nodes !== undefined && `${graph.nodes} nodes`, graph.edges !== undefined && `${graph.edges} edges`].filter(Boolean).join(' · ')}</p>}
        {graph.indexedAt && <p className="muted small">Indexed <time dateTime={graph.indexedAt}>{shortDate(graph.indexedAt)}</time></p>}
        <InlineError>{graph.error}</InlineError>
        <div className="intelligence-actions">
          <Button size="sm" data-testid="graph-index" disabled={busy || indexing || !settings.graphify.enabled || !projectEnabled || !graph.enabled || !graph.installed} onClick={async () => {
            setIndexRequested(true);
            await run(() => invoke('intelligence:graph:index', { sessionId }));
            setIndexRequested(false);
          }}>{indexing ? <><Spinner size={12} /> Indexing…</> : graph.indexed ? 'Refresh index' : 'Build index'}</Button>
          <Button size="sm" data-testid="graph-clear" disabled={busy || indexing} onClick={() => void run(() => invoke('intelligence:graph:clear', { sessionId }))}>Clear cache</Button>
        </div>
      </section>
    </div>
  );
}
