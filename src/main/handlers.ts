/** Transport-agnostic handler registry: every invoke channel, bound once, Electron-free.
 *  ipc.ts binds it to Electron's ipcMain; the remote host (docs/REMOTE-ACCESS.md) binds
 *  the same registry to its WebSocket transport. Electron affordances arrive via
 *  DesktopBridge, push delivery via deps.push. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcChannel, IpcRequest, IpcResponse } from '../shared/ipc';
import { PUSH_CHANNELS } from '../shared/ipc';
import type { AppSettings, DoctorReport, HarnessAvailability, HarnessId } from '../shared/types';
import { HARNESSES } from '../shared/harness-meta';
import { applyModelOverrides, modelOverrideKey } from '../shared/model-overrides';
import { gitBranches, gitBranchesOverview, gitCheckout, gitCommit, gitCreatePr, gitDeleteBranch, gitDiff, gitFetchPrune, gitFolderBranch, gitIssues, gitMergePr, gitPruneWorktrees, gitPullRequests, gitRevertFile, gitStageAll, gitSummary, gitUpdateBranch, gitWorktrees, removeWorktree, type SessionPrQuery } from './git';
import type { AnalyticsStore } from './analytics';
import { isOutsideWorkspace } from './harness/permissions';
import { globalStoreInfo, inspectServer, mergeById, normalizeStdio, projectInfo, readProjectMcp, readStore, resolveVars, secretKeyFor, toMcpJsonTable, writeProjectMcp } from './mcp';
import { listHarnessModels } from './harness/registry';
import { fallbackModels, fetchProviderModels, resolveProviderApiKey, testProvider } from './models/providers';
import { enrichModelContextWindows } from './models/static-models';
import type { RuntimeResolver } from './runtime';
import type { SearchIndex } from './search';
import { which } from './runtime';
import type { SecretStore } from './secrets';
import type { SessionManager } from './session-manager';
import { normalizeMcpProjectState, normalizeMcpServers, type SettingsStore } from './settings';
import { copySkill, createSkill, deleteSkill, listSkills, locateSkillPath, readSkillDoc } from './skills';
import type { TerminalManager } from './terminal';
import { listWorkspaceFiles, readWorkspaceFile } from './workspace-files';
import { errorMessage } from './util/async';
import { spawnTool } from './harness/spawn';

/** Structural dialog options (Electron shapes are cast in ipc.ts, keeping this file Electron-free). */
export interface OpenDialogOptions {
  properties?: string[];
  defaultPath?: string;
}
export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** The Electron affordances handlers need, provided by the host (ipc.ts supplies real ones). */
export interface DesktopBridge {
  appVersion(): string;
  isPackaged(): boolean;
  userDataPath(): string;
  documentsPath(): string;
  electronVersion(): string;
  openExternal(url: string): Promise<void>;
  openPath(p: string): Promise<void>;
  showOpenDialog(opts: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(opts: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
  notify(title: string, body: string): Promise<void>;
  toggleFullScreen(): void;
  reload(): void;
  toggleDevTools(): void;
  /** Returns the resulting zoom factor, or null when there is no window. */
  zoom(direction: 'in' | 'out' | 'reset'): number | null;
  edit(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): void;
}

export interface HandlerDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  sessions: SessionManager;
  terminals: TerminalManager;
  runtime: RuntimeResolver;
  analytics: AnalyticsStore;
  /** Deep session search (FTS5); derived state, safe to rebuild. */
  search: SearchIndex;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Push an async event to the connected client (the window today, remote clients later). */
  push: (channel: string, payload: unknown) => void;
  desktop: DesktopBridge;
}

export interface HandlerRegistry {
  /** Every channel this registry serves — the host binds each to its transport. */
  channels(): IpcChannel[];
  invoke(channel: string, req: unknown): Promise<unknown>;
}

/** A handler holding the host process this long has already frozen the UI; say so. */
const SLOW_HANDLER_MS = 1000;

export function createHandlerRegistry(deps: HandlerDeps): HandlerRegistry {
  const { settings, secrets, sessions, terminals, runtime } = deps;
  const handlers = new Map<IpcChannel, (req: never) => unknown>();
  const availabilityCache = new Map<HarnessId, { at: number; value: HarnessAvailability }>();

  function handle<K extends IpcChannel>(channel: K, fn: (req: IpcRequest<K>) => Promise<IpcResponse<K>> | IpcResponse<K>): void {
    handlers.set(channel, fn as (req: never) => unknown);
  }

  handle('app:info', () => ({ version: deps.desktop.appVersion(), platform: process.platform, userData: deps.desktop.userDataPath(), isPackaged: deps.desktop.isPackaged() }));
  handle('app:doctor', async (): Promise<DoctorReport> => {
    const harnesses = {} as Record<HarnessId, HarnessAvailability>;
    await Promise.all(HARNESSES.map(async (h) => (harnesses[h.id] = await runtime.availability(h.id))));
    const s = settings.get();
    return {
      node: process.versions.node,
      electron: deps.desktop.electronVersion(),
      platform: `${process.platform} ${process.arch}`,
      harnesses,
      providers: s.providers.map((p) => ({ id: p.id, name: p.name, hasKey: secrets.has(p.id), envKeyPresent: !!(p.envKey && process.env[p.envKey]) })),
      userData: deps.desktop.userDataPath()
    };
  });
  handle('app:openExternal', async ({ url }) => {
    if (/^https?:\/\//i.test(url)) await deps.desktop.openExternal(url);
  });
  // Only open paths scoped to the session: a compromised client must not launch arbitrary files.
  handle('app:openPath', async ({ sessionId, path: p }) => {
    const m = sessions.get(sessionId);
    if (!m || isOutsideWorkspace(m.cwd, p, path)) return;
    await deps.desktop.openPath(p);
  });
  handle('app:openInEditor', async ({ path: p, line }) => {
    const s = settings.get();
    const editor = s.binaries.editor?.trim() || 'code';
    const bin = which(editor);
    if (!bin) return { ok: false, error: `Editor "${editor}" not found on PATH. Set it under Settings → Binaries.` };
    try {
      const args = /code/i.test(editor) ? ['--goto', line ? `${p}:${line}` : p] : [p];
      const child = spawnTool(bin, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });
  handle('app:openTerminal', async ({ cwd }) => {
    try {
      if (process.platform === 'win32') {
        const wt = which('wt');
        // `start "" /D <dir> cmd.exe` opens a console already in the project directory.
        const child = wt
          ? spawnTool(wt, ['-d', cwd], { detached: true, stdio: 'ignore' })
          : spawn(process.env.ComSpec || 'cmd.exe', ['/c', `start "" /D "${cwd}" cmd.exe`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: false });
        child.unref();
      } else if (process.platform === 'darwin') {
        const child = spawnTool('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        const term = which('x-terminal-emulator') ?? which('gnome-terminal') ?? which('konsole') ?? which('xterm');
        if (!term) return { ok: false, error: 'No terminal emulator found' };
        const child = spawnTool(term, [], { cwd, detached: true, stdio: 'ignore' });
        child.unref();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });
  handle('app:pickFolder', async ({ defaultPath }) => {
    const res = await deps.desktop.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath });
    return { path: res.canceled ? null : res.filePaths[0] ?? null };
  });
  handle('app:diag', ({ kind, ms, detail }) => {
    deps.log('warn', `renderer ${kind} ${ms}ms${detail ? ` (${detail})` : ''}`);
  });
  handle('app:notify', ({ title, body }) => deps.desktop.notify(title, body));

  handle('window:toggleFullScreen', () => deps.desktop.toggleFullScreen());
  handle('window:reload', () => deps.desktop.reload());
  handle('window:toggleDevTools', () => deps.desktop.toggleDevTools());
  handle('window:zoom', ({ direction }) => {
    const r = deps.desktop.zoom(direction);
    return { zoomFactor: r ?? 1 };
  });
  handle('window:edit', ({ command }) => deps.desktop.edit(command));

  handle('settings:get', () => settings.get());
  handle('settings:update', async (patch) => {
    const next = await settings.update(patch);
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next;
  });

  handle('secrets:set', async ({ providerId, apiKey }) => {
    await secrets.set(providerId, apiKey);
    await syncProviderKeyFlags();
  });
  handle('secrets:clear', async ({ providerId }) => {
    await secrets.clear(providerId);
    await syncProviderKeyFlags();
  });
  handle('secrets:has', ({ providerId }) => secrets.has(providerId));

  async function syncProviderKeyFlags(): Promise<AppSettings> {
    const s = settings.get();
    const providers = s.providers.map((p) => ({ ...p, hasApiKey: secrets.has(p.id) }));
    const next = await settings.update({ providers });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next;
  }

  handle('providers:list', () => {
    const s = settings.get();
    return s.providers.map((p) => {
      const models = enrichModelContextWindows(p.models.length ? p.models : fallbackModels(p), s.providers);
      return { ...p, hasApiKey: secrets.has(p.id), models: applyModelOverrides(models, s.modelOverrides) };
    });
  });
  handle('providers:save', async (provider) => {
    const s = settings.get();
    const idx = s.providers.findIndex((p) => p.id === provider.id);
    const providers = [...s.providers];
    if (idx >= 0) providers[idx] = { ...providers[idx], ...provider, hasApiKey: secrets.has(provider.id) };
    else providers.push({ ...provider, hasApiKey: secrets.has(provider.id), builtin: false });
    const next = await settings.update({ providers });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next.providers;
  });
  handle('providers:delete', async ({ id }) => {
    const s = settings.get();
    const next = await settings.update({ providers: s.providers.filter((p) => p.id !== id || p.builtin) });
    await secrets.clear(id);
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    return next.providers;
  });
  handle('providers:refreshModels', async ({ id }) => {
    const s = settings.get();
    const p = s.providers.find((x) => x.id === id);
    if (!p) return { models: [], error: 'Unknown provider' };
    try {
      const key = await resolveProviderApiKey(p, (pid) => secrets.get(pid));
      const models = await fetchProviderModels(p, key);
      const providers = s.providers.map((x) => (x.id === id ? { ...x, models, modelsUpdatedAt: Date.now() } : x));
      const next = await settings.update({ providers });
      deps.push(PUSH_CHANNELS.settingsChanged, next);
      return { models: applyModelOverrides(enrichModelContextWindows(models, next.providers), next.modelOverrides) };
    } catch (e) {
      const models = enrichModelContextWindows(fallbackModels(p), s.providers);
      return { models: applyModelOverrides(models, s.modelOverrides), error: errorMessage(e) };
    }
  });
  handle('providers:test', async ({ id }) => {
    const p = settings.get().providers.find((x) => x.id === id);
    if (!p) return { ok: false, detail: 'Unknown provider' };
    const key = await resolveProviderApiKey(p, (pid) => secrets.get(pid));
    if (!key && !['ollama', 'lmstudio'].includes(p.kind)) return { ok: false, detail: `No API key stored and ${p.envKey ?? 'no env var'} is not set.` };
    return testProvider(p, key);
  });
  handle('models:setOverride', async ({ provider, model, supportsImages }) => {
    const s = settings.get();
    const key = modelOverrideKey(provider, model);
    const modelOverrides = { ...s.modelOverrides };
    if (supportsImages === null) delete modelOverrides[key];
    else modelOverrides[key] = { ...modelOverrides[key], supportsImages };
    const next = await settings.update({ modelOverrides });
    deps.push(PUSH_CHANNELS.settingsChanged, next);
    // Running sessions already have a model list; re-publish it so the change lands without a restart.
    sessions.republishModels();
    return next.modelOverrides;
  });

  handle('harness:availability', async (req) => {
    const ids: HarnessId[] = req && 'id' in req && req.id ? [req.id] : HARNESSES.map((h) => h.id);
    const out: Partial<Record<HarnessId, HarnessAvailability>> = {};
    await Promise.all(
      ids.map(async (id) => {
        const cached = availabilityCache.get(id);
        if (cached && Date.now() - cached.at < 60_000 && !(req && 'id' in req && req.id)) {
          out[id] = cached.value;
          return;
        }
        const value = await runtime.availability(id);
        availabilityCache.set(id, { at: Date.now(), value });
        out[id] = value;
      })
    );
    return out;
  });
  handle('harness:models', async ({ harness }) => {
    const current = settings.get();
    const result = await listHarnessModels({ harness, settings: current, runtime, getApiKey: (id) => secrets.get(id) });
    return { ...result, models: enrichModelContextWindows(result.models, current.providers) };
  });
  handle('harness:install', async ({ id }) => {
    const r = await runtime.install(id);
    availabilityCache.clear();
    return r;
  });

  handle('skills:list', () => listSkills());
  handle('skills:read', ({ path: p }) => readSkillDoc(p));
  // Only paths main itself listed (a skills root or one of its skill folders) may be revealed.
  handle('skills:reveal', async ({ path: p }) => {
    if (locateSkillPath(p)) await deps.desktop.openPath(path.resolve(p));
  });
  handle('skills:create', (req) => createSkill(req));
  handle('skills:copy', (req) => copySkill(req));
  handle('skills:delete', ({ path: p }) => deleteSkill(p));

  // MCP. Every definition coming back from the renderer goes through normalizeMcpServers first,
  // so a malformed (or hostile) entry can never reach a harness or a file on disk.
  const mcpScope = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return { settings: settings.get(), cwd: m.cwd, projectRoot: m.config.projectRoot, harness: m.config.harness };
  };
  handle('mcp:stores', () => globalStoreInfo());
  handle('mcp:project', ({ sessionId }) => projectInfo(mcpScope(sessionId)));
  handle('mcp:project:save', async ({ sessionId, servers }) => {
    const scope = mcpScope(sessionId);
    const r = await writeProjectMcp(scope.cwd, normalizeMcpServers(servers));
    return { ok: r.ok, error: r.error };
  });
  handle('mcp:project:state', async ({ sessionId, patch }) => {
    const scope = mcpScope(sessionId);
    const next = normalizeMcpProjectState({ ...(settings.get().mcpProjectState ?? {}), [scope.projectRoot]: patch });
    await settings.update({ mcpProjectState: next });
    return projectInfo({ ...scope, settings: settings.get() });
  });
  handle('mcp:inspect', async ({ def, sessionId }) => {
    const [checked] = normalizeMcpServers([def]);
    if (!checked) return { ok: false, error: 'Incomplete server definition', tools: [], durationMs: 0 };
    const resolved = await resolveVars(checked, { env: process.env, secret: (name) => secrets.get(secretKeyFor(name)) });
    const cwd = sessionId ? sessions.get(sessionId)?.cwd : undefined;
    return inspectServer(normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }), { cwd });
  });
  handle('mcp:import', async ({ servers, to, sessionId }) => {
    const incoming = normalizeMcpServers(servers);
    if (!incoming.length) return { ok: false, error: 'Nothing to import' };
    if (to === 'global') {
      await settings.update({ mcpServers: mergeById(settings.get().mcpServers ?? [], incoming) });
      return { ok: true };
    }
    if (!sessionId) return { ok: false, error: 'No session' };
    const scope = mcpScope(sessionId);
    const current = await readProjectMcp(scope.cwd);
    if (current.error) return { ok: false, error: current.error };
    const r = await writeProjectMcp(scope.cwd, mergeById(current.servers, incoming));
    return { ok: r.ok, error: r.error };
  });
  handle('mcp:export', async ({ sessionId }) => {
    const scope = mcpScope(sessionId);
    const current = await readProjectMcp(scope.cwd);
    if (current.error) return { ok: false, error: current.error };
    const target = path.join(scope.cwd, '.cursor', 'mcp.json');
    const existing = await readStore({ id: 'cursor', label: 'Cursor', path: target, format: 'json' });
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify({ mcpServers: toMcpJsonTable(mergeById(existing.servers, current.servers)) }, null, 2) + '\n', 'utf8');
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });

  handle('sessions:list', () => sessions.list());
  handle('sessions:create', (req) => sessions.create(req));
  handle('sessions:get', ({ id }) => sessions.get(id) ?? null);
  handle('sessions:transcript', ({ id }) => sessions.transcript(id));
  handle('sessions:search', (req) => deps.search.search(req));
  handle('sessions:delete', async ({ id, removeWorktree }) => {
    // Shells hold their cwd open; take them down before the worktree is removed.
    const t0 = Date.now();
    await terminals.closeForSession(id);
    const t1 = Date.now();
    await sessions.delete(id, removeWorktree);
    if (Date.now() - t0 >= SLOW_HANDLER_MS) deps.log('warn', `slow delete ${id}: terminals ${t1 - t0}ms, session ${Date.now() - t1}ms`);
  });
  handle('sessions:rename', ({ id, title }) => sessions.patch(id, { title }));
  handle('sessions:label', ({ id, label }) => sessions.patch(id, { statusLabel: label?.trim() || undefined }));
  handle('sessions:archive', ({ id, archived, removeWorktree, forceWorktree }) => sessions.setArchived(id, archived, removeWorktree, forceWorktree));
  handle('sessions:pin', ({ id, pinned }) => sessions.setPinned(id, pinned));
  handle('sessions:pinOrder', ({ ids }) => sessions.setPinOrder(ids));
  handle('sessions:send', ({ id, input }) => sessions.send(id, input));
  handle('sessions:interrupt', ({ id }) => sessions.interrupt(id));
  handle('sessions:stop', ({ id }) => sessions.stop(id));
  handle('sessions:setModel', ({ id, model }) => sessions.setModel(id, model));
  handle('sessions:setEffort', ({ id, effort }) => sessions.setEffort(id, effort));
  handle('sessions:setPermissionMode', ({ id, mode }) => sessions.setPermissionMode(id, mode));
  handle('sessions:compact', ({ id }) => sessions.compact(id));
  handle('sessions:clearTranscript', ({ id }) => sessions.clearTranscript(id));
  handle('sessions:export', async ({ id }) => {
    const md = await sessions.exportMarkdown(id);
    const meta = sessions.get(id);
    const res = await deps.desktop.showSaveDialog({
      defaultPath: path.join(deps.desktop.documentsPath(), `${(meta?.title ?? 'session').replace(/[^\w.-]+/g, '_')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { path: null };
    await fs.writeFile(res.filePath, md, 'utf8');
    return { path: res.filePath };
  });
  handle('sessions:fork', ({ id, harness }) => sessions.fork(id, harness));
  handle('sessions:moveTo', ({ id, cwd }) => sessions.moveTo(id, cwd));
  handle('sessions:goal', ({ id, action, objective, autoContinue, maxIterations }) => sessions.goal(id, action, { objective, autoContinue, maxIterations }));

  handle('approvals:respond', ({ sessionId, requestId, decision }) => sessions.respondApproval(sessionId, requestId, decision));

  // `days: 0` is all time; only an absent request falls back to the 30-day default.
  handle('analytics:summary', (req) => deps.analytics.summary(req && typeof req === 'object' && typeof req.days === 'number' ? Math.max(0, req.days) : 30));

  const cwdOf = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return m.cwd;
  };
  handle('git:folderBranch', ({ projectRoot }) => {
    const known = settings.get().folders.includes(projectRoot) || sessions.list().some((s) => s.config.projectRoot === projectRoot);
    return known ? gitFolderBranch(projectRoot) : {};
  });
  handle('git:summary', ({ sessionId }) => gitSummary(cwdOf(sessionId)));
  handle('git:diff', async ({ sessionId, path: p, staged }) => gitDiff(cwdOf(sessionId), p, staged));
  handle('git:revert', ({ sessionId, path: p }) => gitRevertFile(cwdOf(sessionId), p));
  handle('git:stageAll', ({ sessionId }) => gitStageAll(cwdOf(sessionId)));
  handle('git:commit', ({ sessionId, message }) => gitCommit(cwdOf(sessionId), message));
  // Local /pr and /merge run outside a turn, so nothing else triggers the sidebar's PR state check.
  // The outcome is recorded as a persistent transcript note so it survives a restart (local-only
  // info lines from the renderer do not). PRs opened from another session's agent branch must
  // not be attributed to this one; transcript PR references, the other sessions' branch names
  // and the activity window keep the fallback honest.
  const prQueryOf = async (sessionId: string): Promise<SessionPrQuery> => {
    const m = sessions.get(sessionId);
    if (!m) return {};
    return {
      prRefs: await sessions.sessionPrRefs(sessionId),
      branches: m.worktreeBranch ? [m.worktreeBranch] : [],
      excludeBranches: sessions.list().filter((s) => s.id !== sessionId && s.worktreeBranch).map((s) => s.worktreeBranch!),
      extraRoots: await sessions.knownRepoRoots(sessionId),
      createdAfter: m.createdAt,
      updatedBefore: m.updatedAt
    };
  };
  handle('git:pr', async ({ sessionId, base, head }) => {
    const r = await gitCreatePr(cwdOf(sessionId), base, head);
    sessions.note(sessionId, r.ok ? `PR opened${head ? ` for ${head}` : ''}: ${r.url ?? ''}`.trim() : `PR failed: ${r.output ?? 'unknown error'}`, r.ok ? 'info' : 'error');
    if (r.ok) sessions.refreshGitState(sessionId);
    return r;
  });
  handle('git:merge', async ({ sessionId, base, head }) => {
    // An explicit head branch pins the PR (Branches panel); otherwise the session's own is resolved.
    const r = await gitMergePr(cwdOf(sessionId), base, head, head ? {} : await prQueryOf(sessionId));
    sessions.note(sessionId, r.ok ? `Merged${head ? ` ${head}` : ''}: ${r.url ?? 'PR merged'}` : r.output ?? 'Failed to merge the PR', r.ok ? 'info' : 'error');
    if (r.ok) sessions.refreshGitState(sessionId);
    return r;
  });
  handle('git:branches', ({ sessionId }) => gitBranches(cwdOf(sessionId)));
  handle('git:worktrees', ({ sessionId }) => gitWorktrees(cwdOf(sessionId)));
  handle('git:checkout', ({ sessionId, branch }) => gitCheckout(cwdOf(sessionId), branch));
  handle('git:branchesOverview', ({ sessionId }) => gitBranchesOverview(cwdOf(sessionId)));
  handle('git:deleteBranch', ({ sessionId, branch, force }) => gitDeleteBranch(cwdOf(sessionId), branch, !!force));
  handle('git:updateBranch', ({ sessionId, branch }) => gitUpdateBranch(cwdOf(sessionId), branch));
  // Only registered worktrees may be removed; `path` must match one git reports so the
  // client cannot ask for an arbitrary directory deletion.
  handle('git:removeWorktree', async ({ sessionId, path: p }) => {
    const target = path.resolve(p);
    const { worktrees } = await gitWorktrees(cwdOf(sessionId));
    if (!worktrees.some((w) => w.path === target)) return { ok: false, error: 'Not a registered worktree' };
    try {
      await removeWorktree(cwdOf(sessionId), target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  });
  handle('git:pruneWorktrees', ({ sessionId }) => gitPruneWorktrees(cwdOf(sessionId)));
  handle('git:fetchPrune', ({ sessionId }) => gitFetchPrune(cwdOf(sessionId)));
  handle('git:pullRequests', ({ sessionId }) => gitPullRequests(cwdOf(sessionId)));
  handle('git:issues', ({ sessionId }) => gitIssues(cwdOf(sessionId)));

  handle('fs:list', ({ sessionId, relPath }) => listWorkspaceFiles(cwdOf(sessionId), relPath));
  handle('fs:search', async ({ sessionId, query, limit }) => {
    const root = cwdOf(sessionId);
    const q = query.toLowerCase();
    const max = limit ?? 30;
    const out: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', 'target', '.vocs-code']);
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (out.length >= max || depth > 8) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!skip.has(e.name)) await walk(path.join(dir, e.name), r, depth + 1);
        } else if (!q || fuzzyMatch(r.toLowerCase(), q)) out.push(r);
      }
    };
    await walk(root, '', 0);
    return out;
  });
  handle('fs:read', ({ sessionId, path: p, maxBytes }) => readWorkspaceFile(cwdOf(sessionId), p, maxBytes));

  handle('terminal:list', () => terminals.list());
  handle('terminal:shells', () => terminals.shells());
  handle('terminal:create', ({ sessionId, shell, cols, rows }) => terminals.create(sessionId, { shell, cols, rows }));
  handle('terminal:attach', ({ terminalId, cols, rows }) => terminals.attach(terminalId, cols, rows));
  handle('terminal:detach', ({ terminalId }) => terminals.detach(terminalId));
  handle('terminal:input', ({ terminalId, data }) => terminals.input(terminalId, data));
  handle('terminal:resize', ({ terminalId, cols, rows }) => terminals.resize(terminalId, cols, rows));
  handle('terminal:ack', ({ terminalId, chars }) => terminals.ack(terminalId, chars));
  handle('terminal:kill', ({ terminalId }) => terminals.kill(terminalId));
  handle('terminal:restart', ({ terminalId }) => terminals.restart(terminalId));
  handle('terminal:close', ({ terminalId }) => terminals.close(terminalId));
  handle('terminal:clear', ({ terminalId }) => terminals.clear(terminalId));
  handle('terminal:rename', ({ terminalId, title }) => terminals.rename(terminalId, title));

  return {
    channels: () => Array.from(handlers.keys()),
    async invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel as IpcChannel);
      if (!fn) throw new Error(`Unknown channel: ${channel}`);
      const t0 = Date.now();
      try {
        return await fn(req as never);
      } finally {
        const ms = Date.now() - t0;
        if (ms >= SLOW_HANDLER_MS) deps.log('warn', `slow ipc ${channel}: ${ms}ms`);
      }
    }
  };
}

function fuzzyMatch(hay: string, needle: string): boolean {
  if (hay.includes(needle)) return true;
  let i = 0;
  for (const c of hay) {
    if (c === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}