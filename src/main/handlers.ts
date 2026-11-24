/**
 * Transport-agnostic handler registry: every invoke channel, bound once, Electron-free.
 *
 * `ipc.ts` binds it to Electron's `ipcMain`; the remote host (`docs/REMOTE-ACCESS.md`) binds the
 * same registry to its WebSocket transport. Electron affordances arrive via `DesktopBridge`, push
 * delivery via `deps.push`, and domain channels live under `src/main/handlers/`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcChannel, IpcRequest, IpcResponse } from '../shared/ipc';
import { isIntelligenceOwnerRequest } from '../shared/intelligence';
import type { HarnessAvailability, HarnessId, SessionMeta } from '../shared/types';
import { spawnTool } from './harness/spawn';
import type { GitnexusIndexReason } from './mcp';
import { ModelCatalogCache } from './model-catalog-cache';
import { clearRuntimeProbeCache, which } from './runtime';
import { errorMessage } from './util/async';
import { registerAccountRemoteHandlers } from './handlers/account-remote';
import { registerAppHandlers } from './handlers/app';
import {
  isMissionCreate,
  sessionIdSchema,
  SLOW_HANDLER_MS,
  type DesktopBridge,
  type HandlerContext,
  type HandlerDeps,
  type HandlerRegistry,
  type OpenDialogOptions,
  type SaveDialogOptions
} from './handlers/context';
import { registerGitFsHandlers } from './handlers/git-fs';
import { registerHarnessHandlers } from './handlers/harnesses';
import { registerKnowledgeTerminalHandlers } from './handlers/knowledge-terminal';
import { registerMcpCuaHandlers } from './handlers/mcp-cua';
import { registerSessionHandlers } from './handlers/sessions';
import { registerSettingsProviderHandlers } from './handlers/settings-providers';

export type { DesktopBridge, HandlerDeps, HandlerRegistry, OpenDialogOptions, SaveDialogOptions };

export function createHandlerRegistry(deps: HandlerDeps): HandlerRegistry {
  const { settings, sessions } = deps;
  const handlers = new Map<IpcChannel, (req: never) => unknown>();
  const shutdownHooks: Array<() => Promise<void> | void> = [];

  const availabilityCache = new Map<HarnessId, { at: number; value: HarnessAvailability }>();
  let availabilityGen = 0;
  const invalidateAvailability = () => {
    availabilityGen++;
    availabilityCache.clear();
    clearRuntimeProbeCache();
  };

  // Built on first use: a registry that never lists models must not need a userData path.
  let modelCatalogCache: ModelCatalogCache | undefined;
  const modelCatalog = (): ModelCatalogCache => {
    if (modelCatalogCache) return modelCatalogCache;
    let dir: string | undefined;
    try {
      dir = deps.desktop.userDataPath();
    } catch {
      dir = undefined;
    }
    return (modelCatalogCache = new ModelCatalogCache(dir, { log: deps.log }));
  };

  // Folders the local user picked in this run. A freshly picked folder is in neither settings.folders
  // nor any session yet, so the per-folder git probes would refuse it; the native dialog is proof
  // enough that the user chose the path, and no remote client can reach app:pickFolder.
  const pickedFolders = new Set<string>();

  let housekeepSettingsWrites = 0;

  function handle<K extends IpcChannel>(channel: K, fn: (req: IpcRequest<K>) => Promise<IpcResponse<K>> | IpcResponse<K>): void {
    handlers.set(channel, fn as (req: never) => unknown);
  }

  const sessionFor = (id: unknown): SessionMeta => {
    const session = sessions.get(sessionIdSchema.parse(id));
    if (!session) throw new Error('Session not found');
    return session;
  };

  const cwdOf = (sessionId: string): string => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return m.cwd;
  };

  const knowledgeScopeOf = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return { projectRoot: m.config.projectRoot, cwd: m.cwd, ...(m.worktreeBranch ? { branch: m.worktreeBranch } : {}) };
  };

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

  /** Agent tools cannot export through the desktop chooser, and Antigravity takes direct user prompts only. */
  function guardAgentBoundary(channel: string, input: unknown): void {
    if (channel === 'app:fileSaveAs') throw new Error('User export cannot originate from an agent tool.');
    const req = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (channel === 'sessions:send' && typeof req.id === 'string' && sessions.get(req.id)?.config.harness === 'antigravity') {
      throw new Error('Antigravity sessions are driven by direct user prompts.');
    }
    if (channel === 'sessions:create') {
      const config = req.config && typeof req.config === 'object' ? (req.config as Record<string, unknown>) : {};
      if (config.harness === 'antigravity') throw new Error('Antigravity sessions are driven by direct user prompts.');
      if (isMissionCreate(channel, req)) throw new Error('Mission mode requires the local desktop owner.');
    }
    if (channel.startsWith('mission:')) throw new Error('Mission mode requires the local desktop owner.');
  }

  async function invokeChannel(channel: string, req: unknown, actor: 'user' | 'agent' | 'desktop' = 'user'): Promise<unknown> {
    if (channel.startsWith('vocsAccount:') && actor !== 'desktop') throw new Error('Vocs account sign-in requires the local desktop owner.');
    if (channel.startsWith('control:') && actor !== 'desktop') throw new Error('External control grants require the local desktop owner.');
    if (channel.startsWith('housekeep:') && actor !== 'desktop') throw new Error('Housekeep requires the local desktop owner.');
    if (isIntelligenceOwnerRequest(channel, req) && actor !== 'desktop') throw new Error('Intelligence settings and memory management require the local desktop owner.');
    if (channel === 'harness:login' && actor !== 'desktop') throw new Error('Harness sign-in requires the local desktop owner.');
    if (channel.startsWith('subscriptions:') && actor !== 'desktop') throw new Error('Subscription usage requires the local desktop owner.');
    if (channel === 'fs:writeText' && actor !== 'desktop') throw new Error('Saving workspace text requires the local desktop owner.');
    // Mission mode pushes a branch and opens a PR on the user's behalf: the desktop owner only.
    if ((channel.startsWith('mission:') || isMissionCreate(channel, req)) && actor !== 'desktop') throw new Error('Mission mode requires the local desktop owner.');
    const fn = handlers.get(channel as IpcChannel);
    if (!fn) {
      deps.log('warn', `ipc: unknown channel ${channel}`);
      throw new Error(`Unknown channel: ${channel}`);
    }
    const t0 = Date.now();
    try {
      if (actor === 'agent') guardAgentBoundary(channel, req);
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
    sessionFor,
    cwdOf,
    knowledgeScopeOf,
    pickedFolders,
    launchEditor,
    scheduleGitnexus,
    availabilityCache,
    availabilityGeneration: () => availabilityGen,
    invalidateAvailability,
    modelCatalog,
    trackHousekeepWrite: async (work) => {
      housekeepSettingsWrites++;
      try {
        return await work();
      } finally {
        housekeepSettingsWrites--;
      }
    },
    isHousekeepWriting: () => housekeepSettingsWrites > 0,
    onShutdown: (fn) => {
      shutdownHooks.push(fn);
    }
  };

  registerAccountRemoteHandlers(ctx);
  registerAppHandlers(ctx);
  registerSettingsProviderHandlers(ctx);
  registerHarnessHandlers(ctx);
  registerMcpCuaHandlers(ctx);
  registerSessionHandlers(ctx);
  registerGitFsHandlers(ctx);
  registerKnowledgeTerminalHandlers(ctx);

  return {
    channels: () => Array.from(handlers.keys()),
    invoke: invokeChannel,
    assertControlResource: async ({ sessionId, projectRoot }) => {
      const target = sessionId ? sessionFor(sessionId).cwd : projectRoot;
      if (!target || !path.isAbsolute(target)) throw new Error('Invalid control resource.');
      await fs.realpath(target); // Unlike legacy desktop probes, automation never falls back on a failed canonical read.
    },
    shutdown: async () => {
      await Promise.all(shutdownHooks.map((fn) => fn()));
    }
  };
}
