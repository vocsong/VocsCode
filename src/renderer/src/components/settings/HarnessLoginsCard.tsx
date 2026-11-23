/**
 * Login state card for harnesses that bring their own credentials, shown next to the key vault.
 * Explicitly refreshes model catalogs, checks CLI updates and updates runtimes in place.
 */
import React, { useRef, useState } from 'react';
import { HARNESSES } from '../../../../shared/harness-meta';
import { harnessStatus } from '../../../../shared/harness-setup';
import type { HarnessId, HarnessUpdate } from '../../../../shared/types';
import { invoke } from '../../api';
import { useStore } from '../../store';
import { Badge, Button, Spinner } from '../ui';

const NPM_LOGIN_HARNESSES = ['claude', 'codex', 'pi'] as const;
const LOGIN_HARNESSES = [...NPM_LOGIN_HARNESSES, 'antigravity'] as const;
type NpmLoginHarness = (typeof NPM_LOGIN_HARNESSES)[number];

export function HarnessLoginsCard() {
  const availability = useStore((s) => s.availability);
  const refresh = useStore((s) => s.refreshAvailability);
  const toast = useStore((s) => s.toast);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updates, setUpdates] = useState<Partial<Record<HarnessId, HarnessUpdate>> | null>(null);
  const [updating, setUpdating] = useState<NpmLoginHarness | null>(null);
  const refreshModels = useStore((s) => s.refreshModelCatalog);
  const modelRefreshPending = useRef(new Set<NpmLoginHarness>());
  const [modelRefreshes, setModelRefreshes] = useState<Partial<Record<HarnessId, { pending: boolean; text?: string; error?: boolean }>>>({});
  const credHome: Partial<Record<HarnessId, string>> = { claude: '~/.claude', codex: '~/.codex', pi: '~/.pi/agent' };

  const checkUpdates = async () => {
    setChecking(true);
    try {
      setUpdates((await invoke('harness:checkUpdates', { ids: [...NPM_LOGIN_HARNESSES] })) ?? {});
    } catch (e) {
      toast(`Could not check for harness updates: ${(e as Error).message}`, 'error');
    } finally {
      setChecking(false);
    }
  };

  const refreshNow = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const update = async (id: NpmLoginHarness) => {
    setUpdating(id);
    try {
      const r = await invoke('harness:install', { id });
      if (!r.ok) { toast(`Update failed: ${r.log.slice(-400)}`, 'error'); return; }
      toast(`Installer finished for ${HARNESSES.find((h) => h.id === id)?.name ?? id}; rechecking the selected runtime.`, 'success');
      await refresh();
      await checkUpdates();
    } catch (e) {
      toast(`Update failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally { setUpdating(null); }
  };

  const refreshRowModels = async (id: NpmLoginHarness) => {
    // Ref guard covers a second click before React has committed the disabled button.
    if (modelRefreshPending.current.has(id)) return;
    modelRefreshPending.current.add(id);
    setModelRefreshes((s) => ({ ...s, [id]: { pending: true } }));
    const nameOf = (harness: HarnessId) => HARNESSES.find((h) => h.id === harness)!.name;
    try {
      // Both Codex adapters use the same runtime but have separate renderer catalog caches.
      const ids: HarnessId[] = id === 'codex' ? ['codex', 'codex-exec'] : [id];
      const results = await Promise.all(ids.map(async (harness) => ({ harness, ...await refreshModels(harness, { refresh: true }) })));
      const failures = results.filter((r) => r.error);
      const error = failures.length > 0;
      const text = error
        ? `Could not refresh models: ${failures.map((r) => `${nameOf(r.harness)}: ${r.error}`).join('; ')}`
        : results.map((r) => `${nameOf(r.harness)}: ${r.models.length} ${r.models.length === 1 ? 'model' : 'models'}`).join('; ');
      setModelRefreshes((s) => ({ ...s, [id]: { pending: false, text, error } }));
      toast(text, error ? 'error' : 'success');
    } catch (e) {
      const text = `Could not refresh ${nameOf(id)} models: ${e instanceof Error ? e.message : String(e)}`;
      setModelRefreshes((s) => ({ ...s, [id]: { pending: false, text, error: true } }));
      toast(text, 'error');
    } finally {
      modelRefreshPending.current.delete(id);
    }
  };

  const summary = updates ? updateSummary(updates) : null;
  return (
    <div className="provider-card">
      <div className="provider-head">
        <span className="provider-name">Harness logins</span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" disabled={checking} onClick={() => void checkUpdates()}>
          {checking ? <Spinner /> : 'Check for updates'}
        </Button>
        <Button size="sm" variant="ghost" icon="refresh" aria-label="Refresh logins" disabled={refreshing} onClick={() => void refreshNow()}>
          {refreshing ? <Spinner /> : 'Refresh logins'}
        </Button>
      </div>
      <div className="provider-body">
        {LOGIN_HARNESSES.map((id) => {
          const h = HARNESSES.find((x) => x.id === id)!;
          const av = availability[id];
          const upd = updates?.[id];
          const modelRefresh = modelRefreshes[id];
          return (
            <div key={id} className="row gap8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>{h.name}</strong>
              <Badge tone={harnessStatus(id, av).tone}>{harnessStatus(id, av).label}</Badge>
              <Button size="sm" variant="ghost" aria-label={`Sign in to ${h.name}`} onClick={() => useStore.getState().openOnboarding(id)}>Sign in / setup</Button>
              {id !== 'antigravity' && <Button size="sm" variant="ghost" icon="refresh" aria-label={`Refresh ${h.name} models`} disabled={modelRefresh?.pending} onClick={() => void refreshRowModels(id)}>
                {modelRefresh?.pending ? <Spinner size={11} /> : null} Refresh models
              </Button>}
              {modelRefresh && <span role="status" className={`muted small${modelRefresh.error ? ' info-error' : ''}`}>
                {modelRefresh.pending ? 'Refreshing models…' : modelRefresh.text}
              </span>}
              <span className="muted small">
                {av?.version ? `${av.version} · ` : ''}
                {id === 'antigravity' ? 'uses the Antigravity CLI’s Google sign-in' : <>uses its own credentials from {credHome[id]}</>}
              </span>
              {id !== 'antigravity' && upd?.newer && (
                <>
                  <span className="spacer" />
                  {upd.updatable ? (
                    <Button size="sm" disabled={updating !== null} title={`Install ${upd.package} ${upd.latest} into Vocs Code's own runtime folder`} onClick={() => void update(id)}>
                      {updating === id ? <Spinner size={11} /> : `Update to ${upd.latest}`}
                    </Button>
                  ) : (
                    <Badge tone="neutral">{upd.latest} available</Badge>
                  )}
                </>
              )}
            </div>
          );
        })}
        {summary && <p className={`muted small${summary.error ? ' info-error' : ''}`}>{summary.text}</p>}
        <p className="muted small">Sign in / setup opens the guide for the runtime Vocs Code actually selected, including bundled binaries. Complete the vendor login, then recheck. Refresh models reloads the catalog without updating a runtime or starting a session. A detected login does not guarantee plan access to every model.</p>
      </div>
    </div>
  );
}

/**
 * What the update check found, in one line: what npm could not be reached for, what is newer but
 * cannot be updated from here and why, or the all-clear. An offered update needs no sentence — the
 * row carries its own button.
 */
function updateSummary(updates: Partial<Record<HarnessId, HarnessUpdate>>): { text: string; error?: boolean } | null {
  const nameOf = (id: HarnessId): string => HARNESSES.find((h) => h.id === id)?.name ?? id;
  const rows = Object.entries(updates) as [HarnessId, HarnessUpdate][];
  const failed = rows.filter(([, u]) => u.error);
  if (failed.length) return { text: `Could not reach npm for ${failed.map(([id]) => nameOf(id)).join(', ')}: ${failed[0][1].error}`, error: true };
  const held = rows.filter(([, u]) => u.newer && !u.updatable);
  if (held.length) return { text: held.map(([id, u]) => `${nameOf(id)} ${u.latest} is newer, but ${u.reason}.`).join(' ') };
  return rows.length ? { text: 'The harness CLIs are up to date.' } : null;
}
