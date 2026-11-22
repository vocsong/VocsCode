/**
 * Transport-agnostic handler registry: every invoke channel, bound once, Electron-free.
 * ipc.ts binds it to Electron's ipcMain; the remote host (docs/REMOTE-ACCESS.md) binds
 * the same registry to its WebSocket transport. Electron affordances arrive via
 * DesktopBridge, push delivery via deps.push.
 *
 * Domain handlers live under `src/main/handlers/*`; this module wires shared cross-cutting
 * guards, policy checks, and lifecycle hooks into one registry.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcChannel, IpcRequest, IpcResponse } from '../shared/ipc';
import { desktopOwnerError } from '../shared/ipc-policy';
import type { SessionMeta } from '../shared/types';
import { spawnTool } from './harness/spawn';
import type { GitnexusIndexReason } from './mcp';
import { ModelCatalogCache } from './model-catalog-cache';
import { which } from './runtime';
import { errorMessage } from './util/async';
import { registerAppWindowHandlers } from './handlers/app-window';
import { registerGitFsHandlers } from './handlers/git-fs';
import { registerHarnessesPiHandlers } from './handlers/harnesses-pi';
import { registerKnowledgeIntelligenceHandlers } from './handlers/knowledge-intelligence';
import { registerMcpCuaProcessesHandlers } from './handlers/mcp-cua-processes';
import { createMissionBoundaryGuard } from './handlers/mission-guard';
import { registerMissionHandlers } from './handlers/missions';
import { registerRemoteHandlers } from './handlers/remote-control';
import { registerSessionHandlers } from './handlers/sessions';
import { registerSettingsProvidersHandlers } from './handlers/settings-providers';
import { registerTerminalAnalyticsHandlers } from './handlers/terminal-analytics';
import type { HandlerContext, HandlerDeps, HandlerRegistry, KnowledgeScope } from './handlers/types';

export type { DesktopBridge, HandlerDeps, HandlerRegistry, MissionHandlerService, OpenDialogOptions, SaveDialogOptions } from './handlers/types';

/** A handler holding the host process this long has already frozen the UI; say so. */
const SLOW_HANDLER_MS = 1000;

export function createHandlerRegistry(deps: HandlerDeps): HandlerRegistry {
  const { settings, sessions } = deps;
  const handlers = new Map<IpcChannel, (req: never) => unknown>();
  const disposers: Array<() => Promise<void> | void> = [];

  // Built on first use: a registry that never lists models must not need a userData path.
  let modelCatalogCache: ModelCatalogCache | undefined;
  const modelCatalog = (): ModelCatalogCache => {
    if (modelCatalogCache) return modelCatalogCache;
    let dir: string | undefined;
    try { dir = deps.desktop.userDataPath(); } catch { dir = undefined; }
    return (modelCatalogCache = new ModelCatalogCache(dir, { log: deps.log }));
  };

  let housekeepSettingsWrites = 0;
  const housekeepWriteGuard = {
    isSavingRecentDays: () => housekeepSettingsWrites > 0,
    track: async <T>(active: boolean, fn: () => Promise<T>): Promise<T> => {
      if (active) housekeepSettingsWrites++;
      try { return await fn(); }
      finally { if (active) housekeepSettingsWrites--; }
    }
  };

  // Folders the local user picked in this run. A freshly picked folder is in neither settings.folders
  // nor any session yet, so the per-folder git probes would refuse it; the native dialog is
  // proof enough that the user chose the path, and no remote client can reach app:pickFolder.
  const pickedFolders = new Set<string>();
  const knownFolder = (projectRoot: string) =>
    pickedFolders.has(projectRoot) || settings.get().folders.includes(projectRoot) || sessions.list().some((s) => s.config.projectRoot === projectRoot);

  const launchEditor = async (p: string, line?: number): Promise<{ ok: boolean; error?: string }> => {
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
  };

  const scheduleGitnexus = (session: SessionMeta, reason: GitnexusIndexReason): void => {
    deps.gitnexusIndexer?.schedule({ cwd: session.cwd, projectRoot: session.config.projectRoot, reason });
  };

  const knowledgeScopeOf = (sessionId: string): KnowledgeScope => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return { projectRoot: m.config.projectRoot, cwd: m.cwd, ...(m.worktreeBranch ? { branch: m.worktreeBranch } : {}) };
  };

  const missionGuard = createMissionBoundaryGuard(deps);

  function handle<K extends IpcChannel>(channel: K, fn: (req: IpcRequest<K>) => Promise<IpcResponse<K>> | IpcResponse<K>): void {
    handlers.set(channel, fn as (req: never) => unknown);
  }

  async function invokeChannel(channel: string, req: unknown, actor: 'user' | 'agent' | 'desktop' = 'user'): Promise<unknown> {
    if (actor !== 'desktop') {
      const ownerError = desktopOwnerError(channel, req);
      if (ownerError) throw new Error(ownerError);
    }
    const fn = handlers.get(channel as IpcChannel);
    if (!fn) {
      deps.log('warn', `ipc: unknown channel ${channel}`);
      throw new Error(`Unknown channel: ${channel}`);
    }
    const t0 = Date.now();
    try {
      // Undefined for the synchronous paths (most channels, every keystroke): nothing to await.
      const guard = missionGuard.guardMissionBoundary(channel, req, actor === 'desktop' ? 'user' : actor);
      if (guard) await guard;
      return await fn(req as never);
    } catch (e) {
      // The renderer shows the message as a toast, but a toast is gone in seconds; the log line
      // is what a bug report has. Only the channel and the error — never the request, which for
      // secrets:set is the key itself.
      deps.log('warn', `ipc ${channel} failed: ${errorMessage(e)}`);
      throw e;
    } finally {
      const ms = Date.now() - t0;
      if (ms >= SLOW_HANDLER_MS) deps.log('warn', `slow ipc ${channel}: ${ms}ms`);
    }
  }

  const ctx: HandlerContext = {
    deps,
    handle,
    invokeChannel,
    missionGuard,
    onShutdown: (fn) => disposers.push(fn),
    pickedFolders,
    knownFolder,
    launchEditor,
    scheduleGitnexus,
    knowledgeScopeOf,
    modelCatalog,
    housekeepWriteGuard,
    slowHandlerMs: SLOW_HANDLER_MS
  };

  registerAppWindowHandlers(ctx);
  registerMissionHandlers(ctx);
  registerSettingsProvidersHandlers(ctx);
  registerHarnessesPiHandlers(ctx);
  registerMcpCuaProcessesHandlers(ctx);
  registerSessionHandlers(ctx);
  registerRemoteHandlers(ctx);
  registerGitFsHandlers(ctx);
  registerKnowledgeIntelligenceHandlers(ctx);
  registerTerminalAnalyticsHandlers(ctx);

  return {
    channels: () => Array.from(handlers.keys()),
    invoke: invokeChannel,
    assertControlResource: async ({ sessionId, projectRoot }) => {
      const target = sessionId ? missionGuard.sessionFor(sessionId).cwd : projectRoot;
      if (!target || !path.isAbsolute(target)) throw new Error('Invalid control resource.');
      await fs.realpath(target); // Unlike legacy desktop probes, automation never falls back on a failed canonical read.
      if (sessionId) await missionGuard.assertOrdinarySession(sessionId);
      else await missionGuard.assertOrdinaryWorkspace(target);
    },
    shutdown: async () => {
      await Promise.all(disposers.map((fn) => fn()));
    }
  };
}
