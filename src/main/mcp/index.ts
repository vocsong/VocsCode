/**
 * Ties the two MCP stores together: what a session actually gets, and what the two UI surfaces
 * need to show. The one place that knows about settings, the repo file and the secret store at
 * the same time; adapters only ever see the resolved list through `ctx.mcpServers()`.
 */
import type { AppSettings, HarnessId, McpBuiltinInfo, McpProjectInfo, McpProjectState, McpServerDef } from '../../shared/types';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import { which } from '../runtime';
import { builtinEntries, effectiveEntries, effectiveServers, normalizeStdio, resolveVars, type ResolvedServer } from './effective';
import { globalStores, projectStores, readProjectMcp, readStores } from './file';
import { GITNEXUS_SERVER_ID, gitnexusBaseDef, gitnexusSharedRoots, isBuiltinServerId, isGitnexusIndexed, readGitnexusRegistry, realGitnexusHome, visibleGitnexusEntries } from './gitnexus';
import { VOCS_MEMORY_SERVER_ID, hasMemoryWiki, memoryServerDef, vocsMemoryBaseDef } from './memory';

export * from './effective';
export * from './file';
export * from './gitnexus';
export * from './indexer';
export * from './memory';
export { inspectServer, type InspectOptions } from './client';

/** Keychain id for a variable referenced as `${NAME}` in an MCP definition. */
export function secretKeyFor(varName: string): string {
  return `mcp:${varName}`;
}

export interface McpHostDeps {
  getSecret: (id: string) => Promise<string | undefined>;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** The shared GitNexus MCP endpoint, started lazily. Null when unavailable. */
  sharedGitnexus?: () => Promise<string | null>;
  /** Path to the scope proxy the harness spawns in place of the GitNexus binary. */
  gitnexusProxyPath?: string;
  /** Path to resources/mcp/vocs-memory.mjs, the Layer 2 wiki server. */
  memoryServerPath?: string;
  /** userData path, so the memory server can recall session history (search.db). */
  memoryUserData?: string;
}

export interface SessionScope {
  settings: AppSettings;
  /** Where the session runs; a worktree has its own checkout of the repo file. */
  cwd: string;
  /** The key the per-repo switches are stored under, shared with the main checkout. */
  projectRoot: string;
  harness: HarnessId;
  /** The worktree's branch name, when the session runs in one (branch-scope wiki pages). */
  branch?: string;
}

function stateFor(settings: AppSettings, projectRoot: string): McpProjectState {
  return settings.mcpProjectState?.[projectRoot] ?? {};
}

/** The app-shipped built-in servers, with the installed binary preferred over `npx`. */
function builtinDefs(): McpServerDef[] {
  return [gitnexusBaseDef(which(GITNEXUS_SERVER_ID)), vocsMemoryBaseDef()];
}

/**
 * The ids this app defines itself. A harness that loads its own MCP config alongside what this app
 * injects has to be told to keep them off when the session does not get them.
 */
export function builtinServerIds(): string[] {
  return builtinDefs().map((def) => def.id);
}

/**
 * Harnesses whose MCP config this app writes, so it can also switch an owned name off there. Codex
 * loads `~/.codex/config.toml` underneath whatever it is handed; a harness this app only exports to
 * keeps whatever its own store declares.
 */
const CLAIMING_HARNESSES: HarnessId[] = ['codex', 'codex-exec'];

/** Whether an owned server name can be kept off in that harness's own config. */
export function canClaimBuiltins(harness: HarnessId): boolean {
  return CLAIMING_HARNESSES.includes(harness);
}

/**
 * The harness spawns the scope proxy, which talks to the one shared server and pins every call to
 * the repos this session is allowed to see. Null when the repo is not indexed or the shared server
 * cannot start, so we inject nothing rather than a broken server.
 */
async function sharedGitnexusDef(scope: SessionScope, def: McpServerDef, deps: McpHostDeps): Promise<McpServerDef | null> {
  if (!deps.sharedGitnexus || !deps.gitnexusProxyPath) return null;
  const registry = await readGitnexusRegistry(realGitnexusHome());
  if (!isGitnexusIndexed(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd })) return null;
  const allow = visibleGitnexusEntries(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd, sharedRoots: gitnexusSharedRoots(scope.settings) }).map((e) => ({ name: e.name, path: e.path }));
  const url = await deps.sharedGitnexus();
  if (!url) return null;
  const node = which('node');
  return {
    ...def,
    transport: 'stdio',
    command: node ?? process.execPath,
    args: [deps.gitnexusProxyPath],
    env: {
      ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
      VOCS_GITNEXUS_URL: url,
      VOCS_GITNEXUS_PRIMARY: scope.projectRoot,
      VOCS_GITNEXUS_ALLOW: JSON.stringify(allow)
    }
  };
}

/** Built-ins the session actually gets, materialized against the shared server. */
async function resolveBuiltins(scope: SessionScope, state: McpProjectState, deps: McpHostDeps): Promise<ResolvedServer[]> {
  const support = HARNESS_BY_ID[scope.harness].capabilities.mcp;
  const defs = builtinDefs();
  const chosen = builtinEntries({ builtin: defs, state, globalDisabled: scope.settings.mcpDisabledBuiltins, harness: scope.harness, support }).filter((e) => e.enabled);
  const out: ResolvedServer[] = [];
  for (const { def } of chosen) {
    let materialized: McpServerDef | null = def;
    if (def.id === GITNEXUS_SERVER_ID) {
      materialized = await sharedGitnexusDef(scope, def, deps);
      if (!materialized) continue;
    } else if (def.id === VOCS_MEMORY_SERVER_ID) {
      if (!(await hasMemoryWiki(scope))) continue;
      materialized = memoryServerDef(scope, def, { memoryServerPath: deps.memoryServerPath, memoryUserData: deps.memoryUserData, log: deps.log });
      if (!materialized) continue;
    }
    const resolved = await resolveVars(materialized, { env: process.env, secret: (name) => deps.getSecret(secretKeyFor(name)) });
    if (resolved.missing.length) deps.log?.('warn', `mcp ${def.id}: no value for ${resolved.missing.join(', ')}`);
    out.push({ ...resolved, def: normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }) });
  }
  return out;
}

/**
 * The servers one session should be started with: merged, switched, `${VAR}`-resolved and with
 * stdio commands normalized for the platform.
 */
export async function resolveForSession(scope: SessionScope, deps: McpHostDeps): Promise<ResolvedServer[]> {
  const support = HARNESS_BY_ID[scope.harness].capabilities.mcp;
  if (support !== 'inject' && support !== 'client') return [];
  const state = stateFor(scope.settings, scope.projectRoot);
  const globals = (scope.settings.mcpServers ?? []).filter((d) => !isBuiltinServerId(d.id));
  const repo = await readProjectMcp(scope.cwd);
  const repoDefs = repo.servers.filter((d) => !isBuiltinServerId(d.id));
  const chosen = effectiveServers({ global: globals, repo: repoDefs, state, harness: scope.harness, support, builtin: builtinDefs() });
  if (repo.error) deps.log?.('warn', `mcp: ${repo.file} could not be used: ${repo.error}`);
  const out: ResolvedServer[] = await resolveBuiltins(scope, state, deps);
  for (const def of chosen) {
    const resolved = await resolveVars(def, { env: process.env, secret: (name) => deps.getSecret(secretKeyFor(name)) });
    if (resolved.missing.length) deps.log?.('warn', `mcp ${def.id}: no value for ${resolved.missing.join(', ')}`);
    out.push({ ...resolved, def: normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }) });
  }
  if (out.length) deps.log?.('debug', `mcp: ${out.length} server(s) for ${scope.harness} (${support}): ${out.map((r) => r.def.id).join(', ')}`);
  return out;
}

/** Everything the right-panel tab renders for one session. */
export async function projectInfo(scope: SessionScope): Promise<McpProjectInfo> {
  const support = HARNESS_BY_ID[scope.harness].capabilities.mcp;
  const globals = (scope.settings.mcpServers ?? []).filter((d) => !isBuiltinServerId(d.id));
  const repo = await readProjectMcp(scope.cwd);
  const repoDefs = repo.servers.filter((d) => !isBuiltinServerId(d.id));
  const state = stateFor(scope.settings, scope.projectRoot);
  const detected = (await readStores(projectStores(scope.cwd))).filter((s) => s.exists);
  const defs = builtinDefs();
  const injectable = support === 'inject' || support === 'client';
  const registry = await readGitnexusRegistry(realGitnexusHome());
  const indexed = isGitnexusIndexed(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd });
  const wiki = await hasMemoryWiki(scope);
  const globalDisabled = scope.settings.mcpDisabledBuiltins ?? [];
  const builtin: McpBuiltinInfo[] = defs.map((def) => {
    const off = globalDisabled.includes(def.id) || (state.disabledBuiltin ?? []).includes(def.id);
    if (def.id === VOCS_MEMORY_SERVER_ID) {
      return {
        def,
        enabled: injectable && !off && wiki,
        disabledGlobally: globalDisabled.includes(def.id),
        shared: false,
        indexed: wiki,
        claimed: canClaimBuiltins(scope.harness),
        note: wiki ? 'Reads .vocs-code/wiki in this project.' : 'No project wiki yet — generate one from the Knowledge panel.'
      };
    }
    return {
      def,
      // The one shared server is on by default; the MCP page can switch it off everywhere, and
      // this switch keeps a single repo out of it.
      enabled: injectable && !globalDisabled.includes(def.id) && !(state.disabledBuiltin ?? []).includes(def.id),
      disabledGlobally: globalDisabled.includes(def.id),
      shared: state.gitnexusGlobal === true,
      indexed,
      claimed: canClaimBuiltins(scope.harness)
    };
  });
  return {
    projectRoot: scope.projectRoot,
    file: repo.file,
    display: repo.file.replace(/\\/g, '/'),
    exists: repo.exists,
    repo: repoDefs,
    error: repo.error,
    global: globals,
    state,
    builtin,
    detected,
    effective: [
      ...builtinEntries({ builtin: defs, state, globalDisabled, harness: scope.harness, support }),
      ...effectiveEntries({ global: globals, repo: repoDefs, state, harness: scope.harness, support, builtin: defs })
    ],
    harness: scope.harness,
    support
  };
}

/** The harness-native global stores, for the MCP page's read-only tabs. */
export async function globalStoreInfo() {
  return readStores(globalStores());
}

/** Merges `servers` into a list by id, replacing same-id entries. */
export function mergeById(into: McpServerDef[], servers: McpServerDef[]): McpServerDef[] {
  const out = into.slice();
  for (const s of servers) {
    const at = out.findIndex((x) => x.id === s.id);
    if (at >= 0) out[at] = s;
    else out.push(s);
  }
  return out;
}
