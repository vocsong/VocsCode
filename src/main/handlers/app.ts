/** App info, updates, desktop shell affordances, window controls, focus tracking, and Processes panel handlers. */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TEXT_EXPORT_MAX_BYTES } from '../../shared/ipc';
import { HARNESSES } from '../../shared/harness-meta';
import type { DoctorReport, HarnessAvailability, HarnessId, UpdateState } from '../../shared/types';
import { isOutsideWorkspace } from '../harness/permissions';
import { spawnTool } from '../harness/spawn';
import { which } from '../runtime';
import { errorMessage } from '../util/async';
import { localAbsolutePath, type HandlerContext } from './context';

export function registerAppHandlers(ctx: HandlerContext): void {
  const { deps, handle, pickedFolders, launchEditor } = ctx;
  const { settings, secrets, sessions, runtime } = deps;

  handle('app:info', () => ({
    version: deps.desktop.appVersion(),
    platform: process.platform,
    userData: deps.desktop.userDataPath(),
    isPackaged: deps.desktop.isPackaged()
  }));

  const idleUpdate: UpdateState = { status: 'idle' };
  handle('update:state', () => deps.updater?.get() ?? idleUpdate);
  handle('update:check', () => deps.updater?.check() ?? idleUpdate);
  handle('update:download', () => deps.updater?.download() ?? idleUpdate);
  handle('update:install', () => {
    deps.updater?.install();
  });

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
    if (!m) return;
    const target = path.isAbsolute(p) ? p : path.resolve(m.cwd, p);
    if (isOutsideWorkspace(m.cwd, target, path)) return;
    await deps.desktop.openPath(target);
  });

  // Reveal, never launch: a reply can name a file outside the session (a bundle in another repo),
  // and the file manager can point at it without reading or running it. Network and device paths
  // are refused before anything touches the filesystem, so a link cannot make Windows reach out to
  // a remote share.
  handle('app:showInFolder', async ({ sessionId, path: p }) => {
    if (!sessions.get(sessionId)) return { ok: false, error: 'Session not found' };
    const target = localAbsolutePath(p);
    if (!target) return { ok: false, error: 'Only local absolute paths can be shown in their folder' };
    try {
      await fs.stat(target);
    } catch {
      return { ok: false, error: `${target} was not found` };
    }
    deps.desktop.showItemInFolder(target);
    return { ok: true };
  });

  // Editor launches are scoped to the session's project root: a compromised renderer cannot use
  // this channel as an arbitrary process launcher. Global skills use their own exact-file channel.
  handle('app:openInEditor', async ({ path: p, line, sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    const target = path.isAbsolute(p) ? p : path.resolve(session.cwd, p);
    if (isOutsideWorkspace(session.config.projectRoot || session.cwd, target, path)) return { ok: false, error: 'Path is outside the session workspace' };
    return launchEditor(target, line);
  });

  handle('app:openTerminal', async ({ cwd }) => {
    try {
      if (process.platform === 'win32') {
        // cmd.exe parses the `start` command itself; keep cwd as one process argument rather
        // than interpolating it into a command string. Quotes/newlines cannot be represented
        // safely by that built-in command, so reject them at the boundary.
        if (/["%\r\n]/.test(cwd)) return { ok: false, error: 'Terminal path contains an unsupported quote, percent sign, or newline' };
        const wt = which('wt');
        const child = wt
          ? spawnTool(wt, ['-d', cwd], { detached: true, stdio: 'ignore' })
          : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '', '/D', cwd, 'cmd.exe'], { detached: true, stdio: 'ignore', windowsHide: false });
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
    const picked = res.canceled ? null : res.filePaths[0] ?? null;
    if (picked) pickedFolders.add(picked);
    return { path: picked };
  });

  handle('app:diag', ({ kind, ms, detail }) => {
    deps.log('warn', `renderer ${kind} ${ms}ms${detail ? ` (${detail})` : ''}`);
  });

  // Exceptions are invisible once the renderer window is blank; they belong in the same log as
  // everything else, clipped so one runaway stack cannot fill it.
  handle('app:rendererError', ({ message, stack, source }) => {
    const where = source ? ` at ${source}` : '';
    const trace = stack ? `\n${stack.slice(0, 4000)}` : '';
    deps.log('error', `renderer error${where}: ${message.slice(0, 2000)}${trace}`);
  });

  handle('app:notify', async ({ title, body }) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
    const s = settings.get();
    if (!s.notifications) return;
    await deps.desktop.notify(title.slice(0, 200), body.slice(0, 200));
  });

  handle('app:fileSaveAs', async (input) => {
    const { content, suggestedName } = z
      .strictObject({
        content: z.string().max(TEXT_EXPORT_MAX_BYTES).refine((text) => Buffer.byteLength(text, 'utf8') <= TEXT_EXPORT_MAX_BYTES, 'Text export exceeds the 1 MiB limit.'),
        suggestedName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.md$/, 'Choose a Markdown filename, not a path.')
      })
      .parse(input);
    const res = await deps.desktop.showSaveDialog({
      defaultPath: path.join(deps.desktop.documentsPath(), suggestedName),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { path: null };
    if (!path.isAbsolute(res.filePath)) throw new Error('Save As did not return an absolute destination.');
    await fs.writeFile(res.filePath, content, 'utf8');
    return { path: res.filePath };
  });

  handle('window:toggleFullScreen', () => deps.desktop.toggleFullScreen());
  handle('window:reload', () => deps.desktop.reload());
  handle('window:toggleDevTools', () => deps.desktop.toggleDevTools());
  handle('window:zoom', ({ direction }) => {
    const r = deps.desktop.zoom(direction);
    return { zoomFactor: r ?? 1 };
  });
  handle('window:edit', ({ command }) => deps.desktop.edit(command));

  // The renderer reports where the desktop is; a paired browser reads it and follows the push.
  handle('desktop:setFocus', ({ sessionId }) => deps.desktopFocus?.setSession(sessionId));
  handle('desktop:setVisible', (input) => deps.desktopFocus?.setVisible(z.strictObject({ sessionIds: z.array(z.string()).max(32) }).parse(input).sessionIds));
  handle('desktop:focus', () => deps.desktopFocus?.state() ?? { sessionId: null, at: 0, windowFocused: false });

  // The Processes panel. Ending is validated by the tracker against a fresh sample, so a stale row
  // or a reused PID can never end a process the app did not start.
  handle('processes:list', () => deps.processes?.list() ?? { sampledAt: Date.now(), processes: [], error: 'Process tracking is not running.' });
  handle('processes:end', ({ targets }) => {
    if (!deps.processes) return { ended: 0, failed: [] };
    const valid = (Array.isArray(targets) ? targets : []).filter((t) => Number.isInteger(t?.pid) && t.pid > 0 && Number.isFinite(t?.startedAt));
    return deps.processes.end(valid);
  });
}
