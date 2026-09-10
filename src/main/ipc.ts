/** Registers the typed IPC handlers in the main process and pushes harness events to the renderer. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { IpcChannel, IpcRequest, IpcResponse } from '../shared/ipc';
import { PUSH_CHANNELS } from '../shared/ipc';
import type { AppSettings, DoctorReport, HarnessAvailability, HarnessId } from '../shared/types';
import { HARNESSES } from '../shared/harness-meta';
import { gitCommit, gitDiff, gitRevertFile, gitStageAll, gitSummary } from './git';
import { listHarnessModels } from './harness/registry';
import { fallbackModels, fetchProviderModels, resolveProviderApiKey, testProvider } from './models/providers';
import type { RuntimeResolver } from './runtime';
import { which } from './runtime';
import type { SecretStore } from './secrets';
import type { SessionManager } from './session-manager';
import type { SettingsStore } from './settings';
import type { TerminalManager } from './terminal';
import { errorMessage } from './util/async';
import { spawnTool } from './harness/spawn';

export interface IpcDeps {
  settings: SettingsStore;
  secrets: SecretStore;
  sessions: SessionManager;
  terminals: TerminalManager;
  runtime: RuntimeResolver;
  getWindow: () => BrowserWindow | null;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

function handle<K extends IpcChannel>(channel: K, fn: (req: IpcRequest<K>) => Promise<IpcResponse<K>> | IpcResponse<K>): void {
  ipcMain.handle(channel, async (_e, req: IpcRequest<K>) => fn(req));
}

export function pushToRenderer(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export function registerIpc(deps: IpcDeps): void {
  const { settings, secrets, sessions, terminals, runtime } = deps;
  const availabilityCache = new Map<HarnessId, { at: number; value: HarnessAvailability }>();

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData'), isPackaged: app.isPackaged }));
  handle('app:doctor', async (): Promise<DoctorReport> => {
    const harnesses = {} as Record<HarnessId, HarnessAvailability>;
    await Promise.all(HARNESSES.map(async (h) => (harnesses[h.id] = await runtime.availability(h.id))));
    const s = settings.get();
    return {
      node: process.versions.node,
      electron: process.versions.electron ?? 'unknown',
      platform: `${process.platform} ${process.arch}`,
      harnesses,
      providers: s.providers.map((p) => ({ id: p.id, name: p.name, hasKey: secrets.has(p.id), envKeyPresent: !!(p.envKey && process.env[p.envKey]) })),
      userData: app.getPath('userData')
    };
  });
  handle('app:openExternal', async ({ url }) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
  handle('app:openPath', async ({ path: p }) => {
    await shell.openPath(p);
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
    const win = deps.getWindow();
    const res = await dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), { properties: ['openDirectory', 'createDirectory'], defaultPath });
    return { path: res.canceled ? null : res.filePaths[0] ?? null };
  });
  handle('app:notify', async ({ title, body }) => {
    const { Notification } = await import('electron');
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });

  handle('window:toggleFullScreen', () => {
    const win = deps.getWindow();
    win?.setFullScreen(!win.isFullScreen());
  });
  handle('window:reload', () => {
    deps.getWindow()?.webContents.reload();
  });
  handle('window:toggleDevTools', () => {
    deps.getWindow()?.webContents.toggleDevTools();
  });
  handle('window:zoom', ({ direction }) => {
    const wc = deps.getWindow()?.webContents;
    if (!wc) return { zoomFactor: 1 };
    const next = direction === 'reset' ? 1 : Math.min(2, Math.max(0.6, wc.getZoomFactor() + (direction === 'in' ? 0.1 : -0.1)));
    wc.setZoomFactor(next);
    return { zoomFactor: wc.getZoomFactor() };
  });
  // The renderer has no native menu on Windows/Linux, so the Edit menu drives WebContents directly.
  handle('window:edit', ({ command }) => {
    const wc = deps.getWindow()?.webContents;
    if (!wc) return;
    if (command === 'selectAll') wc.selectAll();
    else wc[command]();
  });

  handle('settings:get', () => settings.get());
  handle('settings:update', async (patch) => {
    const next = await settings.update(patch);
    pushToRenderer(deps.getWindow(), PUSH_CHANNELS.settingsChanged, next);
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
    pushToRenderer(deps.getWindow(), PUSH_CHANNELS.settingsChanged, next);
    return next;
  }

  handle('providers:list', () => settings.get().providers.map((p) => ({ ...p, hasApiKey: secrets.has(p.id), models: p.models.length ? p.models : fallbackModels(p) })));
  handle('providers:save', async (provider) => {
    const s = settings.get();
    const idx = s.providers.findIndex((p) => p.id === provider.id);
    const providers = [...s.providers];
    if (idx >= 0) providers[idx] = { ...providers[idx], ...provider, hasApiKey: secrets.has(provider.id) };
    else providers.push({ ...provider, hasApiKey: secrets.has(provider.id), builtin: false });
    const next = await settings.update({ providers });
    pushToRenderer(deps.getWindow(), PUSH_CHANNELS.settingsChanged, next);
    return next.providers;
  });
  handle('providers:delete', async ({ id }) => {
    const s = settings.get();
    const next = await settings.update({ providers: s.providers.filter((p) => p.id !== id || p.builtin) });
    await secrets.clear(id);
    pushToRenderer(deps.getWindow(), PUSH_CHANNELS.settingsChanged, next);
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
      pushToRenderer(deps.getWindow(), PUSH_CHANNELS.settingsChanged, next);
      return { models };
    } catch (e) {
      return { models: fallbackModels(p), error: errorMessage(e) };
    }
  });
  handle('providers:test', async ({ id }) => {
    const p = settings.get().providers.find((x) => x.id === id);
    if (!p) return { ok: false, detail: 'Unknown provider' };
    const key = await resolveProviderApiKey(p, (pid) => secrets.get(pid));
    if (!key && !['ollama', 'lmstudio'].includes(p.kind)) return { ok: false, detail: `No API key stored and ${p.envKey ?? 'no env var'} is not set.` };
    return testProvider(p, key);
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
  handle('harness:models', async ({ harness }) => listHarnessModels({ harness, settings: settings.get(), runtime, getApiKey: (id) => secrets.get(id) }));
  handle('harness:install', async ({ id }) => {
    const r = await runtime.install(id);
    availabilityCache.clear();
    return r;
  });

  handle('sessions:list', () => sessions.list());
  handle('sessions:create', (req) => sessions.create(req));
  handle('sessions:get', ({ id }) => sessions.get(id) ?? null);
  handle('sessions:transcript', ({ id }) => sessions.transcript(id));
  handle('sessions:delete', async ({ id, removeWorktree }) => {
    // Shells hold their cwd open; take them down before the worktree is removed.
    await terminals.closeForSession(id);
    await sessions.delete(id, removeWorktree);
  });
  handle('sessions:rename', ({ id, title }) => sessions.patch(id, { title }));
  handle('sessions:archive', ({ id, archived }) => sessions.patch(id, { archived }));
  handle('sessions:pin', ({ id, pinned }) => sessions.patch(id, { pinned }));
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
    const win = deps.getWindow();
    const res = await dialog.showSaveDialog(win ?? (undefined as unknown as BrowserWindow), {
      defaultPath: path.join(app.getPath('documents'), `${(meta?.title ?? 'session').replace(/[^\w.-]+/g, '_')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { path: null };
    await fs.writeFile(res.filePath, md, 'utf8');
    return { path: res.filePath };
  });
  handle('sessions:fork', ({ id }) => sessions.fork(id));
  handle('sessions:goal', ({ id, action, objective, autoContinue, maxIterations }) => sessions.goal(id, action, { objective, autoContinue, maxIterations }));

  handle('approvals:respond', ({ sessionId, requestId, decision }) => sessions.respondApproval(sessionId, requestId, decision));

  const cwdOf = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return m.cwd;
  };
  handle('git:summary', ({ sessionId }) => gitSummary(cwdOf(sessionId)));
  handle('git:diff', async ({ sessionId, path: p, staged }) => ({ diff: await gitDiff(cwdOf(sessionId), p, staged) }));
  handle('git:revert', ({ sessionId, path: p }) => gitRevertFile(cwdOf(sessionId), p));
  handle('git:stageAll', ({ sessionId }) => gitStageAll(cwdOf(sessionId)));
  handle('git:commit', ({ sessionId, message }) => gitCommit(cwdOf(sessionId), message));

  handle('fs:list', async ({ sessionId, relPath }) => {
    const root = cwdOf(sessionId);
    const dir = relPath ? path.resolve(root, relPath) : root;
    if (!dir.startsWith(path.resolve(root))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      let size: number | undefined;
      if (e.isFile()) {
        try {
          size = (await fs.stat(abs)).size;
        } catch {
          /* ignore */
        }
      }
      out.push({ name: e.name, path: path.relative(root, abs), isDir: e.isDirectory(), size });
    }
    return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  });
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
  handle('fs:read', async ({ sessionId, path: p, maxBytes }) => {
    const root = cwdOf(sessionId);
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    const buf = await fs.readFile(abs);
    const limit = maxBytes ?? 400_000;
    return { content: buf.subarray(0, limit).toString('utf8'), truncated: buf.length > limit };
  });

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
