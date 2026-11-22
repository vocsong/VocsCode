/**
 * MCP server management, Cua Driver computer-use, and tracked-process IPC handlers.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  clearCuaVersionCache,
  cuaBaseDef,
  cuaDefState,
  cuaInstallCommand,
  CuaPreviewSession,
  cuaStatus,
  globalStoreInfo,
  inspectServer,
  mergeById,
  normalizeStdio,
  projectInfo,
  readProjectMcp,
  readStore,
  resolveVars,
  secretKeyFor,
  toMcpJsonTable,
  writeProjectMcp
} from '../mcp';
import { clearWhichCache, runCapture, which } from '../runtime';
import { mcpServersSaveError, normalizeMcpProjectState, normalizeMcpServers } from '../settings';
import { errorMessage } from '../util/async';
import type { HandlerContext } from './types';

export function registerMcpCuaProcessesHandlers(ctx: HandlerContext): void {
  const { deps, handle } = ctx;
  const { settings, secrets, sessions } = deps;

  // MCP. Every definition coming back from the renderer goes through normalizeMcpServers first,
  // so a malformed (or hostile) entry can never reach a harness or a file on disk.
  const mcpScope = (sessionId: string) => {
    const m = sessions.get(sessionId);
    if (!m) throw new Error('Session not found');
    return { settings: settings.get(), cwd: m.cwd, projectRoot: m.config.projectRoot, harness: m.config.harness, managed: !!m.mission, readOnly: m.config.permissionMode === 'plan' };
  };
  handle('mcp:stores', () => globalStoreInfo());
  handle('mcp:project', ({ sessionId }) => projectInfo(mcpScope(sessionId)));
  handle('mcp:project:save', async ({ sessionId, servers }) => {
    const scope = mcpScope(sessionId);
    const next = normalizeMcpServers(servers);
    const refused = mcpServersSaveError(next, (await readProjectMcp(scope.cwd)).servers);
    if (refused) return { ok: false, error: refused };
    const r = await writeProjectMcp(scope.cwd, next);
    if (!r.ok) deps.log('warn', `[${sessionId}] could not write ${r.file}: ${r.error ?? 'unknown error'}`);
    return { ok: r.ok, error: r.error };
  });
  handle('mcp:project:state', async ({ sessionId, patch }) => {
    const scope = mcpScope(sessionId);
    const next = normalizeMcpProjectState({ ...(settings.get().mcpProjectState ?? {}), [scope.projectRoot]: patch });
    await settings.update({ mcpProjectState: next });
    return projectInfo({ ...scope, settings: settings.get() });
  });
  handle('mcp:project:index', async ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    if (!deps.gitnexusIndexer) return { ok: false, error: 'GitNexus indexing is unavailable in this run.' };
    return deps.gitnexusIndexer.index({ cwd: session.config.projectRoot || session.cwd, projectRoot: session.config.projectRoot, reason: 'manual' });
  });
  handle('mcp:inspect', async ({ def, sessionId }) => {
    const [checked] = normalizeMcpServers([def]);
    if (!checked) return { ok: false, error: 'Incomplete server definition', tools: [], durationMs: 0 };
    const resolved = await resolveVars(checked, { env: process.env, secret: (name) => secrets.get(secretKeyFor(name)) });
    const cwd = sessionId ? sessions.get(sessionId)?.cwd : undefined;
    const result = await inspectServer(normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }), { cwd });
    if (result.ok) deps.log('debug', `mcp ${checked.id}: inspected in ${result.durationMs}ms, ${result.tools.length} tool(s)`);
    else deps.log('warn', `mcp ${checked.id}: inspect failed after ${result.durationMs}ms: ${result.error ?? 'unknown error'}`);
    return result;
  });
  handle('mcp:import', async ({ servers, to, sessionId }) => {
    const incoming = normalizeMcpServers(servers);
    // Sentence punctuation also avoids electron-vite's ESM shim mistaking this literal for an import.
    if (!incoming.length) return { ok: false, error: 'No MCP servers to import.' };
    if (to === 'global') {
      const current = settings.get().mcpServers ?? [];
      const merged = mergeById(current, incoming);
      const refused = mcpServersSaveError(merged, current);
      if (refused) return { ok: false, error: refused };
      await settings.update({ mcpServers: merged });
      return { ok: true };
    }
    if (!sessionId) return { ok: false, error: 'No session' };
    const scope = mcpScope(sessionId);
    const current = await readProjectMcp(scope.cwd);
    if (current.error) return { ok: false, error: current.error };
    const merged = mergeById(current.servers, incoming);
    const refused = mcpServersSaveError(merged, current.servers);
    if (refused) return { ok: false, error: refused };
    const r = await writeProjectMcp(scope.cwd, merged);
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

  // Computer use. The renderer only ever reads status and screenshots; the mode and opt-in live in
  // settings, and the driver's own authorization is fixed when its runtime starts.
  const cuaPreview = new CuaPreviewSession();
  handle('cua:status', () => cuaStatus(settings.get()));
  handle('cua:preview', () => cuaPreview.capture(settings.get()));

  // The Processes panel. Ending is validated by the tracker against a fresh sample, so a stale row
  // or a reused PID can never end a process the app did not start.
  handle('processes:list', () => deps.processes?.list() ?? { sampledAt: Date.now(), processes: [], error: 'Process tracking is not running.' });
  handle('processes:end', ({ targets }) => {
    if (!deps.processes) return { ended: 0, failed: [] };
    const valid = (Array.isArray(targets) ? targets : []).filter((t) => Number.isInteger(t?.pid) && t.pid > 0 && Number.isFinite(t?.startedAt));
    return deps.processes.end(valid);
  });
  // The built-in's "Test connection": a real MCP handshake against `cua-driver mcp`, the same
  // thing the user-server rows offer, so an install that lies about its tools is visible.
  handle('cua:test', async () => {
    const current = settings.get();
    const def = cuaBaseDef(current);
    if (def.disabled) return { ok: false, error: cuaDefState(current).note, tools: [], durationMs: 0 };
    const resolved = await resolveVars(def, { env: process.env, secret: (name) => secrets.get(secretKeyFor(name)) });
    const result = await inspectServer(normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }), {});
    if (result.ok) deps.log('debug', `cua: ${result.tools.length} tool(s) in ${result.durationMs}ms`);
    else deps.log('warn', `cua: test failed: ${result.error ?? 'unknown error'}`);
    return result;
  });
  // Installs the driver on the user's behalf, but only after the renderer has confirmed (the UI
  // shows the exact command). Nothing here decides on its own to run a remote script.
  handle('cua:install', async () => {
    const command = cuaInstallCommand();
    if (!command) return { ok: false, command: '', error: 'No Cua Driver installer for this platform.' };
    deps.log('info', `cua: running the official installer: ${command.display}`);
    const result = await runCapture(command.file, command.args, { timeoutMs: 300_000 });
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-4_000);
    // The PATH/install-dir memo and the version cache must not keep reporting the pre-install state.
    clearWhichCache();
    clearCuaVersionCache();
    const ok = result.code === 0;
    if (!ok) deps.log('warn', `cua: installer exited ${result.code ?? 'null'}${result.timedOut ? ' (timed out)' : ''}`);
    return { ok, command: command.display, ...(output ? { output } : {}), ...(ok ? {} : { error: result.timedOut ? 'The installer timed out.' : 'The installer exited with an error; see its output.' }) };
  });
}
