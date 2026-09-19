/**
 * MCP page: the global server list this app injects, plus a read-only look at each harness's own
 * store so a definition can be copied across. Per-repo servers live on the right-panel MCP tab.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { McpServerDef, McpStoreInfo } from '../../../shared/types';
import { MCP_BUILTIN_IDS } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { McpServerForm, emptyServer, serverSummary } from './McpServerForm';
import { CuaCard } from './CuaCard';
import { askConfirm, Badge, Button, EmptyState, Icon, Spinner, Toggle } from './ui';

const OWN_TAB = 'vocs-code';

export function McpView() {
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const openVesta = useStore((s) => s.openVesta);
  const settings = useStore((s) => s.settings);
  const [stores, setStores] = useState<McpStoreInfo[] | null>(null);
  const [tab, setTab] = useState<string>(OWN_TAB);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<McpServerDef | null>(null);

  const servers = useMemo(() => settings?.mcpServers ?? [], [settings]);
  // The built-in is not a user entry; a same-named leftover in the store is inert and hidden here.
  const userServers = useMemo(() => servers.filter((d) => !MCP_BUILTIN_IDS.includes(d.id)), [servers]);
  const builtinOff = (id: string) => (settings?.mcpDisabledBuiltins ?? []).includes(id);
  const setBuiltinGlobally = (id: string, on: boolean) => {
    const cur = settings?.mcpDisabledBuiltins ?? [];
    return invoke('settings:update', { mcpDisabledBuiltins: on ? cur.filter((x) => x !== id) : [...new Set([...cur, id])] });
  };

  const load = useCallback(async () => {
    try {
      setStores(await invoke('mcp:stores', undefined));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      setStores([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (list: McpServerDef[]) => {
    await invoke('settings:update', { mcpServers: list });
  };

  const upsert = async (def: McpServerDef) => {
    const exists = userServers.some((s) => s.id === def.id);
    await save(exists ? userServers.map((s) => (s.id === def.id ? { ...s, ...def } : s)) : [...userServers, def]);
    setEditing(null);
    toast(exists ? 'Server updated' : 'Server added', 'success');
  };

  const remove = async (def: McpServerDef) => {
    const ok = await askConfirm({ title: `Remove "${def.id}"?`, body: <>It stops being offered to every harness. Nothing on disk is deleted.</>, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    await save(userServers.filter((s) => s.id !== def.id));
    if (editing?.id === def.id) setEditing(null);
  };

  const importFrom = async (defs: McpServerDef[]) => {
    const r = await invoke('mcp:import', { servers: defs, to: 'global' });
    if (!r.ok) return toast(r.error ?? 'Import failed', 'error');
    toast(defs.length === 1 ? `Copied ${defs[0].id}` : `Copied ${defs.length} servers`, 'success');
    setTab(OWN_TAB);
  };

  const q = query.trim().toLowerCase();
  const match = (d: McpServerDef) => !q || d.id.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q) || serverSummary(d).toLowerCase().includes(q);
  const activeStore = stores?.find((s) => s.id === tab);
  const shown = tab === OWN_TAB ? userServers.filter(match) : (activeStore?.servers ?? []).filter(match);

  return (
    <div className="skills mcp-page">
      <div className="skills-top">
        <div className="skills-title">
          <Button variant="ghost" size="sm" icon="chevronRight" className="rot180" onClick={() => setView('chat')} title="Back" />
          <Icon name="server" size={16} /> MCP servers
          <span className="muted small">
            {userServers.length} global{userServers.length === 1 ? '' : ''}
          </span>
        </div>
        <div className="skills-actions">
          <div className="skills-search">
            <Icon name="search" size={14} />
            <input placeholder="Filter servers" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Button size="sm" icon="refresh" onClick={() => void load()} title="Re-read the harness stores">
            Refresh
          </Button>
          <Button size="sm" icon="sparkles" onClick={() => openVesta('Set up this MCP server for me: ')} title="Describe or paste a server and let Vesta configure it">
            Set up with Vesta
          </Button>
          <Button variant="primary" size="sm" icon="plus" onClick={() => { setTab(OWN_TAB); setEditing(emptyServer()); }}>
            Add server
          </Button>
        </div>
      </div>

      <div className="skills-tabs">
        <button type="button" className={`atab ${tab === OWN_TAB ? 'active' : ''}`} onClick={() => setTab(OWN_TAB)}>
          Vocs Code
          <span className="atab-count">{userServers.length}</span>
        </button>
        {(stores ?? []).map((s) => (
          <button key={s.id} type="button" className={`atab ${tab === s.id ? 'active' : ''}`} title={s.path} onClick={() => setTab(s.id)}>
            {s.label}
            <span className="atab-count">{s.servers.length}</span>
          </button>
        ))}
      </div>

      <div className="mcp-body">
        {tab === OWN_TAB ? (
          <>
            <p className="mcp-intro muted small">
              These servers are offered to every harness that can take them — Claude, both Codex adapters, ACP agents and pi. Cursor reads its own store instead.
              Per-repo servers live on a session's <span className="mono">MCP</span> panel tab.
            </p>
            <div className="mcp-card">
              <div className="mcp-row-head">
                <Toggle checked={!builtinOff('gitnexus')} onChange={(v) => void setBuiltinGlobally('gitnexus', v)} />
                <Icon name="server" size={12} />
                <span className="mcp-name">GitNexus</span>
                <Badge tone="blue">built-in</Badge>
              </div>
              <div className="muted small">
                Ships with Vocs Code — one shared process serves every indexed repo, and each session
                sees only its own graph (plus any repo you share). Turn it off for a single repo on
                that repo's MCP panel tab.
              </div>
            </div>
            <CuaCard />
            {userServers.length === 0 && !editing && (
              <EmptyState icon="server" title="No MCP servers yet">
                <p>An MCP server gives your agents extra tools — a code host, a database, a browser. Add one here and every harness that supports MCP picks it up on its next session.</p>
                <Button variant="primary" icon="plus" onClick={() => setEditing(emptyServer())}>
                  Add your first server
                </Button>
              </EmptyState>
            )}
            {shown.map((def) =>
              editing && editing.id === def.id ? (
                <div key={def.id} className="mcp-card editing">
                  <McpServerForm value={editing} takenIds={[...userServers.map((s) => s.id), ...MCP_BUILTIN_IDS]} onSave={(d) => void upsert(d)} onCancel={() => setEditing(null)} />
                </div>
              ) : (
                <div key={def.id} className="mcp-card">
                  <div className="mcp-row-head">
                    <Toggle checked={!def.disabled} onChange={(v) => void save(userServers.map((s) => (s.id === def.id ? { ...s, disabled: v ? undefined : true } : s)))} />
                    <span className="mcp-name">{def.id}</span>
                    <Badge tone={def.transport === 'stdio' ? 'neutral' : 'blue'}>{def.transport}</Badge>
                    {def.harnesses?.map((h) => (
                      <Badge key={h} tone="purple">
                        {h}
                      </Badge>
                    ))}
                    <span className="spacer" />
                    <Button size="sm" variant="ghost" icon="edit" title="Edit" onClick={() => setEditing({ ...def })} />
                    <Button size="sm" variant="ghost" icon="trash" title="Remove" onClick={() => void remove(def)} />
                  </div>
                  <code className="mcp-cmd mono">{serverSummary(def)}</code>
                  {def.description && <div className="mcp-desc muted small">{def.description}</div>}
                </div>
              )
            )}
            {editing && !userServers.some((s) => s.id === editing.id) && (
              <div className="mcp-card editing">
                <McpServerForm value={editing} takenIds={[...userServers.map((s) => s.id), ...MCP_BUILTIN_IDS]} onSave={(d) => void upsert(d)} onCancel={() => setEditing(null)} />
              </div>
            )}
            {q && shown.length === 0 && userServers.length > 0 && <div className="skill-none">No servers match “{query}”.</div>}
          </>
        ) : (
          <HarnessStore store={activeStore} loading={stores === null} shown={shown} onImport={importFrom} />
        )}
      </div>
    </div>
  );
}

function HarnessStore({ store, loading, shown, onImport }: { store: McpStoreInfo | undefined; loading: boolean; shown: McpServerDef[]; onImport: (defs: McpServerDef[]) => void }) {
  if (loading) {
    return (
      <div className="skills-loading">
        <Spinner size={14} /> Reading harness stores…
      </div>
    );
  }
  if (!store) return <div className="skill-none">Unknown store.</div>;
  return (
    <>
      <div className="mcp-store-head">
        <span className="skill-root-path mono" title={store.path}>
          {store.display}
        </span>
        {!store.exists && <Badge tone="neutral">not present</Badge>}
        <span className="spacer" />
        {store.servers.length > 0 && (
          <Button size="sm" icon="download" onClick={() => onImport(store.servers)}>
            Copy all to Vocs Code
          </Button>
        )}
      </div>
      <p className="mcp-intro muted small">Read-only. {store.label} loads these itself; copy one here to have this app offer it to the other harnesses too.</p>
      {store.error && <div className="skills-error">{store.error}</div>}
      {store.exists && store.servers.length === 0 && !store.error && <div className="skill-none">No MCP servers configured.</div>}
      {shown.map((def) => (
        <div key={def.id} className="mcp-card">
          <div className="mcp-row-head">
            <span className="mcp-name">{def.id}</span>
            <Badge tone={def.transport === 'stdio' ? 'neutral' : 'blue'}>{def.transport}</Badge>
            {def.disabled && <Badge tone="amber">disabled</Badge>}
            <span className="spacer" />
            <Button size="sm" variant="ghost" icon="download" title="Copy to Vocs Code" onClick={() => onImport([def])}>
              Copy
            </Button>
          </div>
          <code className="mcp-cmd mono">{serverSummary(def)}</code>
        </div>
      ))}
    </>
  );
}
