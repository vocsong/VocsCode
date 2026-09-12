/**
 * Right-panel MCP tab: the servers this repo defines in `.mcp.json`, the global ones, and what
 * the running session will actually get. A repo-defined server stays inert until it is enabled
 * here, so cloning a repo never starts someone else's program (docs/MCP.md §8).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { McpProjectInfo, McpServerDef, McpSkipReason, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { useStore } from '../store';
import { McpServerForm, emptyServer, serverSummary } from './McpServerForm';
import { askConfirm, Badge, Button, EmptyState, Icon, Spinner, Toggle } from './ui';

const SKIP_LABEL: Record<McpSkipReason, string> = {
  disabled: 'off for this repo',
  'not-enabled': 'not enabled here',
  shadowed: 'replaced by the repo server of the same name',
  'harness-filtered': 'restricted to other harnesses',
  'not-injected': 'this harness reads its own store'
};

export function McpTab({ session }: { session: SessionMeta }) {
  const toast = useStore((s) => s.toast);
  const setView = useStore((s) => s.setView);
  const settings = useStore((s) => s.settings);
  const [info, setInfo] = useState<McpProjectInfo | null>(null);
  const [editing, setEditing] = useState<McpServerDef | null>(null);
  const [busy, setBusy] = useState(false);
  const liveId = useRef(session.id);

  const load = useCallback(async () => {
    const sid = session.id;
    liveId.current = sid;
    try {
      const r = await invoke('mcp:project', { sessionId: sid });
      if (liveId.current === sid) setInfo(r);
    } catch (e) {
      if (liveId.current === sid) toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }, [session.id, toast]);

  useEffect(() => {
    void load();
  }, [load, settings?.mcpServers, settings?.mcpProjectState]);

  const support = info?.support ?? HARNESS_BY_ID[session.config.harness].capabilities.mcp;
  const harnessName = HARNESS_BY_ID[session.config.harness].name;
  const active = useMemo(() => (info?.effective ?? []).filter((e) => e.enabled), [info]);
  const pending = useMemo(() => (info?.repo ?? []).filter((d) => !(info?.state.enabledRepo ?? []).includes(d.id)), [info]);

  const patchState = async (patch: Parameters<typeof invoke<'mcp:project:state'>>[1]['patch']) => {
    setBusy(true);
    try {
      setInfo(await invoke('mcp:project:state', { sessionId: session.id, patch }));
    } finally {
      setBusy(false);
    }
  };

  const setRepoEnabled = (id: string, on: boolean) => {
    const cur = info?.state.enabledRepo ?? [];
    return patchState({ ...info?.state, enabledRepo: on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id) });
  };

  const setGlobalEnabled = (id: string, on: boolean) => {
    const cur = info?.state.disabledGlobal ?? [];
    return patchState({ ...info?.state, disabledGlobal: on ? cur.filter((x) => x !== id) : [...new Set([...cur, id])] });
  };

  const saveRepo = async (servers: McpServerDef[]) => {
    const r = await invoke('mcp:project:save', { sessionId: session.id, servers });
    if (!r.ok) {
      toast(r.error ?? 'Could not write .mcp.json', 'error');
      return false;
    }
    await load();
    return true;
  };

  const upsertRepo = async (def: McpServerDef) => {
    const list = info?.repo ?? [];
    const exists = list.some((s) => s.id === def.id);
    if (!(await saveRepo(exists ? list.map((s) => (s.id === def.id ? def : s)) : [...list, def]))) return;
    // A server you just typed here is one you trust; anything a teammate added still waits.
    if (!exists) await setRepoEnabled(def.id, true);
    setEditing(null);
    toast(exists ? 'Server updated' : 'Server added to .mcp.json', 'success');
  };

  const removeRepo = async (def: McpServerDef) => {
    const ok = await askConfirm({ title: `Remove "${def.id}" from .mcp.json?`, body: <>The entry is deleted from the repo file, which is shared with everyone working on it.</>, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    await saveRepo((info?.repo ?? []).filter((s) => s.id !== def.id));
  };

  const importDetected = async (servers: McpServerDef[], label: string) => {
    const r = await invoke('mcp:import', { servers, to: 'repo', sessionId: session.id });
    if (!r.ok) return toast(r.error ?? 'Import failed', 'error');
    await load();
    toast(`Imported ${servers.length} server${servers.length === 1 ? '' : 's'} from ${label}`, 'success');
  };

  const exportToCursor = async () => {
    const r = await invoke('mcp:export', { sessionId: session.id, to: 'cursor' });
    toast(r.ok ? 'Written to .cursor/mcp.json' : r.error ?? 'Export failed', r.ok ? 'success' : 'error');
  };

  if (!info) {
    return (
      <div className="mcp-loading">
        <Spinner size={14} /> Reading MCP configuration…
      </div>
    );
  }

  return (
    <div className="mcp-tab">
      {pending.length > 0 && (
        <div className="mcp-trust">
          <div className="mcp-trust-head">
            <Icon name="alert" size={13} /> This repo defines {pending.length} MCP server{pending.length === 1 ? '' : 's'} that {pending.length === 1 ? 'is' : 'are'} not enabled here.
          </div>
          <div className="muted small">Each one is a program this app would start for you. Enable only the ones you trust.</div>
          {pending.map((d) => (
            <div key={d.id} className="mcp-trust-row">
              <div className="mcp-trust-main">
                <span className="mcp-name">{d.id}</span>
                <code className="mcp-cmd mono">{serverSummary(d)}</code>
              </div>
              <Button size="sm" disabled={busy} onClick={() => void setRepoEnabled(d.id, true)}>
                Enable
              </Button>
            </div>
          ))}
        </div>
      )}

      <section className="mcp-section">
        <div className="mcp-section-head">
          <h3>This repo</h3>
          <span className="spacer" />
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setEditing(emptyServer())}>
            Add
          </Button>
        </div>
        <div className="mcp-path mono" title={info.file}>
          {info.exists ? info.display : `${info.display} (not created yet)`}
        </div>
        {info.error && <div className="skills-error">{info.error}</div>}
        {info.repo.length === 0 && !editing && !info.error && (
          <EmptyState icon="server" title="No servers in this repo">
            <p>
              A server added here is written to <span className="mono">.mcp.json</span> at the repo root, so everyone working on the project gets the definition — but each of you enables it separately.
            </p>
          </EmptyState>
        )}
        {info.repo.map((d) =>
          editing?.id === d.id ? (
            <div key={d.id} className="mcp-card editing">
              <McpServerForm value={editing} portableOnly takenIds={info.repo.map((s) => s.id)} sessionId={session.id} onSave={(x) => void upsertRepo(x)} onCancel={() => setEditing(null)} />
            </div>
          ) : (
            <div key={d.id} className="mcp-card">
              <div className="mcp-row-head">
                <Toggle checked={(info.state.enabledRepo ?? []).includes(d.id)} onChange={(v) => void setRepoEnabled(d.id, v)} />
                <span className="mcp-name">{d.id}</span>
                <Badge tone={d.transport === 'stdio' ? 'neutral' : 'blue'}>{d.transport}</Badge>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon="edit" title="Edit" onClick={() => setEditing({ ...d })} />
                <Button size="sm" variant="ghost" icon="trash" title="Remove" onClick={() => void removeRepo(d)} />
              </div>
              <code className="mcp-cmd mono">{serverSummary(d)}</code>
              {d.description && <div className="mcp-desc muted small">{d.description}</div>}
            </div>
          )
        )}
        {editing && !info.repo.some((s) => s.id === editing.id) && (
          <div className="mcp-card editing">
            <McpServerForm value={editing} portableOnly takenIds={info.repo.map((s) => s.id)} sessionId={session.id} onSave={(x) => void upsertRepo(x)} onCancel={() => setEditing(null)} />
          </div>
        )}
      </section>

      <section className="mcp-section">
        <div className="mcp-section-head">
          <h3>Global</h3>
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => setView('mcp')}>
            Manage
          </Button>
        </div>
        {info.global.length === 0 && <div className="skill-none">No global servers. Add them on the MCP page.</div>}
        {info.global.map((d) => (
          <div key={d.id} className="mcp-card compact">
            <div className="mcp-row-head">
              <Toggle checked={!d.disabled && !(info.state.disabledGlobal ?? []).includes(d.id)} onChange={(v) => void setGlobalEnabled(d.id, v)} />
              <span className="mcp-name">{d.id}</span>
              <Badge tone={d.transport === 'stdio' ? 'neutral' : 'blue'}>{d.transport}</Badge>
              {d.disabled && <Badge tone="amber">off everywhere</Badge>}
            </div>
            <code className="mcp-cmd mono">{serverSummary(d)}</code>
          </div>
        ))}
      </section>

      {info.detected.length > 0 && (
        <section className="mcp-section">
          <div className="mcp-section-head">
            <h3>Detected in this repo</h3>
          </div>
          {info.detected.map((s) => (
            <div key={s.path} className="mcp-card compact">
              <div className="mcp-row-head">
                <span className="mcp-name">{s.label}</span>
                <Badge tone="neutral">{s.servers.length}</Badge>
                <span className="spacer" />
                {s.servers.length > 0 && (
                  <Button size="sm" variant="ghost" icon="download" onClick={() => void importDetected(s.servers, s.label)}>
                    Import
                  </Button>
                )}
              </div>
              <code className="mcp-cmd mono">{s.display}</code>
              {s.error && <div className="skills-error">{s.error}</div>}
            </div>
          ))}
        </section>
      )}

      <section className="mcp-section">
        <div className="mcp-section-head">
          <h3>In this session</h3>
        </div>
        {support === 'inherit' && (
          <div className="mcp-note">
            {harnessName} reads its own MCP configuration and takes nothing from this app. Write this repo's servers out to <span className="mono">.cursor/mcp.json</span> instead.
            <div className="row gap8 pad-t">
              <Button size="sm" icon="upload" onClick={() => void exportToCursor()}>
                Export to .cursor/mcp.json
              </Button>
            </div>
          </div>
        )}
        {support === 'none' && <div className="mcp-note">{harnessName} has no MCP support in the installed version, so nothing is passed to it.</div>}
        {(support === 'inject' || support === 'client') && (
          <>
            {active.length === 0 ? (
              <div className="skill-none">No servers active for this session.</div>
            ) : (
              active.map((e) => (
                <div key={`${e.scope}:${e.def.id}`} className="mcp-card compact">
                  <div className="mcp-row-head">
                    <Icon name="server" size={12} />
                    <span className="mcp-name">{e.def.id}</span>
                    <Badge tone={e.scope === 'repo' ? 'green' : 'neutral'}>{e.scope}</Badge>
                  </div>
                </div>
              ))
            )}
            <div className="muted small pad-t">
              Configured, not probed — {harnessName} connects when the session starts. Changes apply to the next session on this repo.
            </div>
          </>
        )}
        {info.effective.filter((e) => !e.enabled && e.reason !== 'not-enabled').length > 0 && (
          <div className="mcp-skipped">
            {info.effective
              .filter((e) => !e.enabled && e.reason !== 'not-enabled')
              .map((e) => (
                <div key={`${e.scope}:${e.def.id}`} className="muted small">
                  <span className="mono">{e.def.id}</span> — {SKIP_LABEL[e.reason ?? 'disabled']}
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
