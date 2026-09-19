/**
 * Right-panel MCP configuration for the current repository.
 * Repo-defined servers stay inert until explicitly enabled here.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MEMORY_GUIDE_MARKDOWN } from '../../../shared/memory-guide';
import type { McpProjectInfo, McpServerDef, SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { McpServerForm, emptyServer, serverSummary } from './McpServerForm';
import { CuaCard } from './CuaCard';
import { askConfirm, Badge, Button, EmptyState, Icon, Spinner, Toggle } from './ui';

export function McpTab({ session }: { session: SessionMeta }) {
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const [info, setInfo] = useState<McpProjectInfo | null>(null);
  const [editing, setEditing] = useState<McpServerDef | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
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

  const patchState = async (patch: Parameters<typeof invoke<'mcp:project:state'>>[1]['patch']) => {
    setBusy(true);
    try {
      setInfo(await invoke('mcp:project:state', { sessionId: session.id, patch }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setRepoEnabled = (id: string, on: boolean) => {
    const cur = info?.state.enabledRepo ?? [];
    return patchState({ ...info?.state, enabledRepo: on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id) });
  };

  const setBuiltinEnabled = (id: string, on: boolean) => {
    const cur = info?.state.disabledBuiltin ?? [];
    return patchState({ ...info?.state, disabledBuiltin: on ? cur.filter((x) => x !== id) : [...new Set([...cur, id])] });
  };

  const setGitnexusShared = (on: boolean) => patchState({ ...info?.state, gitnexusGlobal: on });

  const indexGitnexus = async () => {
    if (indexing) return;
    setIndexing(true);
    try {
      const result = await invoke('mcp:project:index', { sessionId: session.id });
      if (!result.ok) {
        toast(result.error ?? 'GitNexus indexing failed', 'error');
        return;
      }
      toast('GitNexus index updated', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setIndexing(false);
    }
  };

  const copyGuide = () => {
    void navigator.clipboard
      .writeText(MEMORY_GUIDE_MARKDOWN)
      .then(() => toast('Snippet copied — paste it into AGENTS.md', 'success'))
      .catch(() => toast('Could not copy the snippet', 'error'));
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
    if (!exists) await setRepoEnabled(def.id, true);
    setEditing(null);
    toast(exists ? 'Server updated' : 'Server added to .mcp.json', 'success');
  };

  const removeRepo = async (def: McpServerDef) => {
    const ok = await askConfirm({ title: `Remove "${def.id}" from .mcp.json?`, body: <>The entry is deleted from the repo file, which is shared with everyone working on it.</>, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    await saveRepo((info?.repo ?? []).filter((s) => s.id !== def.id));
  };

  if (!info) {
    return (
      <div className="mcp-loading">
        <Spinner size={14} /> Reading MCP configuration…
      </div>
    );
  }

  const builtin = info.builtin.find((entry) => entry.def.id === 'gitnexus');
  const cua = info.builtin.find((entry) => entry.def.id === 'cua-driver');
  const pending = info.repo.filter((d) => !(info.state.enabledRepo ?? []).includes(d.id));

  return (
    <div className="mcp-tab">
      <section className="mcp-section" data-testid="mcp-global-section">
        <div className="mcp-section-head">
          <h3>Global</h3>
          <span className="spacer" />
          <Badge tone="neutral">shared server</Badge>
        </div>
        <div className="mcp-card mcp-guide" data-testid="memory-guide">
          <button type="button" className="mcp-guide-toggle" aria-expanded={guideOpen} data-testid="memory-guide-toggle" onClick={() => setGuideOpen((v) => !v)}>
            <Icon name={guideOpen ? 'chevron' : 'chevronRight'} size={12} />
            <Icon name="brain" size={12} />
            <span className="mcp-name">Teach your agents to use these</span>
            <span className="spacer" />
            <span className="muted small">AGENTS.md snippet</span>
          </button>
          {guideOpen && (
            <>
              <div className="muted small">
                Agents reach for these servers far more often when the project tells them to. Paste this into your <code>AGENTS.md</code> (or <code>CLAUDE.md</code>) so every
                session checks the code graph, the wiki and past sessions before falling back to grep.
              </div>
              <div className="mcp-index-row">
                <span className="muted small">Markdown, ready to paste.</span>
                <Button size="sm" icon="copy" data-testid="memory-guide-copy" onClick={copyGuide}>Copy snippet</Button>
              </div>
              <pre className="mcp-guide-body mono" data-testid="memory-guide-text">{MEMORY_GUIDE_MARKDOWN}</pre>
            </>
          )}
        </div>
        {builtin && (
          <div className="mcp-card" data-testid="gitnexus-card">
            <div className="mcp-row-head">
              <Icon name="server" size={12} />
              <span className="mcp-name">gitnexus</span>
              <Badge tone="blue">built-in</Badge>
              <span className="spacer" />
              {builtin.disabledGlobally && <Badge tone="amber">off everywhere</Badge>}
              {builtin.enabled && builtin.indexed && <Badge tone="green">indexed</Badge>}
            </div>
            <div className="muted small">One shared GitNexus server gives this session access to this repo's code graph.</div>
            <div className="mcp-control-list">
              <Toggle checked={builtin.enabled} disabled={busy || builtin.disabledGlobally} onChange={(v) => void setBuiltinEnabled(builtin.def.id, v)} label="Enable GitNexus for this repo" />
              <Toggle checked={builtin.shared} disabled={busy} onChange={(v) => void setGitnexusShared(v)} label="Share this repo's graph with other repos" />
            </div>
            <div className="mcp-index-row">
              <span className="muted small">{builtin.indexed ? 'Index is ready.' : 'Index this repo to enable GitNexus queries.'}</span>
              <Button size="sm" variant={builtin.indexed ? 'ghost' : 'primary'} icon="refresh" disabled={indexing} data-testid="gitnexus-index" onClick={() => void indexGitnexus()}>
                {indexing ? 'Indexing…' : builtin.indexed ? 'Re-index' : 'Index repo'}
              </Button>
            </div>
          </div>
        )}
        {info.builtin
          .filter((entry) => entry.def.id !== 'gitnexus' && entry.def.id !== 'cua-driver')
          .map((entry) => (
            <div key={entry.def.id} className="mcp-card" data-testid={`builtin-${entry.def.id}`}>
              <div className="mcp-row-head">
                <Icon name="book" size={12} />
                <span className="mcp-name">{entry.def.id}</span>
                <Badge tone="blue">built-in</Badge>
                <span className="spacer" />
                {entry.disabledGlobally && <Badge tone="amber">off everywhere</Badge>}
                {entry.enabled && <Badge tone="green">on</Badge>}
              </div>
              <div className="muted small">{entry.note ?? entry.def.description}</div>
              <div className="mcp-control-list">
                <Toggle checked={entry.enabled} disabled={busy || entry.disabledGlobally || !entry.indexed} onChange={(v) => void setBuiltinEnabled(entry.def.id, v)} label={`Enable ${entry.def.id} for this repo`} />
              </div>
            </div>
          ))}
        {cua && <CuaCard compact repo={{ enabled: cua.enabled, disabled: busy || cua.disabledGlobally === true, onChange: (v) => void setBuiltinEnabled('cua-driver', v) }} />}
      </section>

      <section className="mcp-section" data-testid="mcp-repo-section">
        <div className="mcp-section-head">
          <h3>This repo</h3>
          <span className="spacer" />
          <Button size="sm" variant="primary" icon="plus" data-testid="mcp-add-server" onClick={() => setEditing(emptyServer())}>
            Add MCP server
          </Button>
        </div>
        <div className="mcp-path mono" title={info.file}>{info.exists ? info.display : `${info.display} (not created yet)`}</div>
        {info.error && <div className="skills-error">{info.error}</div>}
        {pending.length > 0 && (
          <div className="mcp-trust">
            <div className="mcp-trust-head"><Icon name="alert" size={13} /> Review servers before enabling them</div>
            <div className="muted small">These programs came from the shared repo configuration.</div>
            {pending.map((d) => (
              <div key={d.id} className="mcp-trust-row">
                <div className="mcp-trust-main"><span className="mcp-name">{d.id}</span><code className="mcp-cmd mono">{serverSummary(d)}</code></div>
                <Button size="sm" disabled={busy} onClick={() => void setRepoEnabled(d.id, true)}>Enable</Button>
              </div>
            ))}
          </div>
        )}
        {info.repo.length === 0 && !editing && !info.error && (
          <EmptyState icon="server" title="No servers in this repo"><p>Add an MCP server when this project needs extra tools.</p></EmptyState>
        )}
        {info.repo.map((d) => editing?.id === d.id ? (
          <div key={d.id} className="mcp-card editing"><McpServerForm value={editing} portableOnly takenIds={info.repo.map((s) => s.id)} sessionId={session.id} onSave={(x) => void upsertRepo(x)} onCancel={() => setEditing(null)} /></div>
        ) : (
          <div key={d.id} className="mcp-card">
            <div className="mcp-row-head">
              <Toggle checked={(info.state.enabledRepo ?? []).includes(d.id)} disabled={busy} onChange={(v) => void setRepoEnabled(d.id, v)} label={<span className="sr-only">Enable {d.id}</span>} />
              <span className="mcp-name">{d.id}</span>
              <Badge tone={d.transport === 'stdio' ? 'neutral' : 'blue'}>{d.transport}</Badge>
              <span className="spacer" />
              <Button size="sm" variant="ghost" icon="edit" title={`Edit ${d.id}`} onClick={() => setEditing({ ...d })} />
              <Button size="sm" variant="ghost" icon="trash" title={`Remove ${d.id}`} onClick={() => void removeRepo(d)} />
            </div>
            <code className="mcp-cmd mono">{serverSummary(d)}</code>
            {d.description && <div className="mcp-desc muted small">{d.description}</div>}
          </div>
        ))}
        {editing && !info.repo.some((s) => s.id === editing.id) && (
          <div className="mcp-card editing"><McpServerForm value={editing} portableOnly takenIds={info.repo.map((s) => s.id)} sessionId={session.id} onSave={(x) => void upsertRepo(x)} onCancel={() => setEditing(null)} /></div>
        )}
      </section>
    </div>
  );
}
