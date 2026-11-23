import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { resolveIntelligenceSettings, type GraphIndexStatus, type IntelligenceSettings, type ReflectionMode } from '../../../../shared/intelligence';
import { invoke } from '../../api';
import { Badge, Button, Spinner } from '../ui';
import { InlineError, REFLECTION_PRIVACY_NOTICE, shortDate } from './controls';
import { readIntelligence, useScopeGuard, type IntelligenceSectionProps } from './useIntelligence';

const GRAPH_POLL_MS = 3_000;
const GRAPH_DISCOVERY_MS = 45_000;
// Let an observed job finish (snapshot preparation plus the bundled worker's build timeout).
const GRAPH_JOB_WATCH_MS = 5 * 60_000;

/** Watch only the graph in this visible Sources visit. A slow read never holds the action lock. */
function useGraphStatus(sessionId: string, projectId: string, snapshot: GraphIndexStatus, watchStatus: boolean) {
  const [observed, setObserved] = useState<{ basis: GraphIndexStatus; graph: GraphIndexStatus }>();
  const reading = useRef(false);

  useLayoutEffect(() => {
    if (!watchStatus) return;
    let timer: number | undefined;
    let generation = 0;
    let startedAt = 0;
    let deadline = 0;
    const visible = () => document.visibilityState !== 'hidden';
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
      ++generation;
    };
    const poll = async () => {
      if (Date.now() >= deadline || !visible()) { stop(); return; }
      if (reading.current) return;
      const request = generation;
      reading.current = true;
      try {
        const { project, graph } = await readIntelligence(sessionId);
        if (request !== generation || project.id !== projectId || !visible()) return;
        // Do not publish the accompanying settings or overwrite a newer snapshot from an action.
        setObserved({ basis: snapshot, graph });
        if (graph.indexing) deadline = startedAt + GRAPH_JOB_WATCH_MS;
        else if (!graph.enabled || !graph.installed || graph.error || (graph.indexed && !graph.stale)) stop();
      } catch {
        // A background status read is best-effort; keep the last visible status.
      } finally {
        reading.current = false;
      }
    };
    const watch = () => {
      stop();
      if (!visible()) return;
      startedAt = Date.now();
      deadline = startedAt + (snapshot.indexing ? GRAPH_JOB_WATCH_MS : GRAPH_DISCOVERY_MS);
      timer = window.setInterval(() => void poll(), GRAPH_POLL_MS);
    };
    watch();
    document.addEventListener('visibilitychange', watch);
    return () => { stop(); document.removeEventListener('visibilitychange', watch); };
  }, [sessionId, projectId, snapshot, watchStatus]);

  return observed?.basis === snapshot ? observed.graph : snapshot;
}

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
  const { project, gateway } = view;
  const reflectionNote = useId();
  const settings = resolveIntelligenceSettings(view.settings);
  const { enabled, excludedProjects } = settings.graphify;
  const projectEnabled = !excludedProjects.includes(project.id);
  const capture = useScopeGuard();
  const [indexRequested, setIndexRequested] = useState(false);
  const graph = useGraphStatus(sessionId, project.id, view.graph, !busy && enabled && projectEnabled && view.graph.enabled && view.graph.installed);
  const indexing = indexRequested || graph.indexing;

  const patch = (change: Partial<IntelligenceSettings>) => run(async (current) => {
    await invoke('settings:update', { intelligence: { ...settings, ...change } });
    if (current()) return readIntelligence(sessionId);
  });
  const index = () => run(async (current) => {
    const visible = capture();
    setIndexRequested(true);
    try {
      return await invoke('intelligence:graph:index', { sessionId });
    } finally {
      if (current() && visible()) setIndexRequested(false);
    }
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
        <h3>Graphify code index</h3>
        <p className="muted small">Graphify is built in. When enabled, it automatically indexes committed code by revision in Git workspaces you open. Indexing runs locally: no model, cloud service, or separate download.</p>
        <SourceSwitch label="Enable Graphify" testId="setting-graphify" checked={enabled} disabled={busy} onChange={(checked) => void patch({ graphify: { enabled: checked, excludedProjects } })} />
        <SourceSwitch label="Enable for this project" testId="setting-graphify-project" checked={projectEnabled} disabled={busy || !enabled} onChange={(checked) => void patch({
          graphify: { enabled, excludedProjects: checked ? excludedProjects.filter((id) => id !== project.id) : [...excludedProjects, project.id] }
        })} />
        <div className="intelligence-row" role="status" data-testid="graph-status">
          <Badge tone={graph.installed ? 'neutral' : 'amber'}>{graph.installed ? `Bundled${graph.version ? ` · ${graph.version}` : ''}` : 'Unavailable'}</Badge>
          <Badge tone={graph.indexed ? 'green' : 'neutral'}>{graph.indexed ? 'Indexed' : 'Not indexed'}</Badge>
          {indexing && <Badge tone="blue">Indexing</Badge>}
          {graph.stale && <Badge tone="amber">Stale</Badge>}
        </div>
        {!graph.installed && <p className="muted small">The bundled Graphify worker is unavailable in this build. The wiki, memory, and other sources still work.</p>}
        {graph.revision && <p className="muted small">Revision <code title={graph.revision}>{graph.revision.slice(0, 12)}</code></p>}
        {(graph.nodes !== undefined || graph.edges !== undefined) && <p className="muted small">{[graph.nodes !== undefined && `${graph.nodes} nodes`, graph.edges !== undefined && `${graph.edges} edges`].filter(Boolean).join(' · ')}</p>}
        {graph.indexedAt && <p className="muted small">Indexed <time dateTime={graph.indexedAt}>{shortDate(graph.indexedAt)}</time></p>}
        <InlineError>{graph.error}</InlineError>
        <div className="intelligence-actions">
          <Button size="sm" data-testid="graph-index" disabled={busy || indexing || !enabled || !projectEnabled || !graph.enabled || !graph.installed} onClick={() => void index()}>{indexing ? <><Spinner size={12} /> Indexing…</> : graph.indexed ? 'Refresh index' : 'Build index'}</Button>
          <Button size="sm" data-testid="graph-clear" disabled={busy || indexing} onClick={() => void run(() => invoke('intelligence:graph:clear', { sessionId }))}>Clear cache</Button>
        </div>
      </section>
    </div>
  );
}
