/**
 * Ties the two MCP stores together: what a session actually gets, and what the two UI surfaces
 * need to show. The one place that knows about settings, the repo file and the secret store at
 * the same time; adapters only ever see the resolved list through `ctx.mcpServers()`.
 */
import type { AppSettings, HarnessId, McpBuiltinInfo, McpProjectInfo, McpProjectState, McpRejectedServer, McpServerDef } from '../../shared/types';
import { MCP_BUILTIN_IDS } from '../../shared/types';
import { mcpIdIssues } from '../../shared/mcp-ids';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import { resolveIntelligenceSettings } from '../../shared/intelligence';
import { which } from '../runtime';
import { builtinEntries, effectiveEntries, effectiveServers, normalizeStdio, resolveVars, type ResolvedServer } from './effective';
import { globalStores, projectStores, readProjectMcp, readStores } from './file';
import { GITNEXUS_SERVER_ID, gitnexusBaseDef, gitnexusSharedRoots, isBuiltinServerId, isGitnexusIndexed, readGitnexusRegistry, realGitnexusHome, visibleGitnexusEntries } from './gitnexus';
import { MEMORY_GATEWAY_TOKEN_ENV, VOCS_MEMORY_SERVER_ID, hasMemoryWiki, memoryServerDef, vocsMemoryBaseDef } from './memory';
import { MISSION_GATEWAY_TOKEN_ENV, missionServerDef } from './mission';
import { CUA_SERVER_ID, cuaBaseDef, cuaDefState } from './cua';
import { missionSupport } from '../../shared/mission-mode';
import type { MissionGatewayAttachment, MissionGatewayPort } from '../mission-mode/contracts';

export * from './effective';
export * from './file';
export * from './gitnexus';
export * from './indexer';
export * from './memory';
export * from './mission';
export * from './cua';
export * from './cua-preview';
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
  /** Mints this session's gateway endpoint and capability token; null when the gateway is off. */
  memoryGateway?: (sessionId: string) => { url: string; token: string } | null;
  /**
   * Connected Vocs MCP Hub connections (`main/vocs-hub.ts`): loopback proxy servers carrying an
   * app-minted bearer, never the Hub token. Empty while nothing is connected.
   */
  hubServers?: () => Promise<ResolvedServer[]>;
  /**
   * The Mission gateway, handed over only for a session in a mission. Its attachment decides: a
   * session it does not attach gets no `vocs-mission` server. `ensureAttachment`, when present,
   * opens the listener on first use.
   */
  missionGateway?: MissionGatewayPort & { ensureAttachment?(sessionId: string): Promise<MissionGatewayAttachment | null> };
  /** Path to resources/mcp/vocs-mission.mjs, the Mission tools' stdio client. */
  missionServerPath?: string;
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
  /** The session being started, so a per-session capability can be bound to it. */
  sessionId?: string;
  /** Legacy memory cannot enforce a read-only capability. */
  readOnly?: boolean;
}

function stateFor(settings: AppSettings, projectRoot: string): McpProjectState {
  return settings.mcpProjectState?.[projectRoot] ?? {};
}

/**
 * User and repository servers that are never loaded for their name, with the reason the MCP surfaces
 * show. The repo list is the file as written, including an entry under a built-in's exact id.
 */
export function rejectedServers(globals: readonly McpServerDef[], repo: readonly McpServerDef[]): McpRejectedServer[] {
  return [
    ...mcpIdIssues(repo).map((issue): McpRejectedServer => ({ id: issue.id, scope: 'repo', reason: issue.reason })),
    ...mcpIdIssues(globals).map((issue): McpRejectedServer => ({ id: issue.id, scope: 'global', reason: issue.reason }))
  ];
}

/** The app-shipped built-in servers, with the installed binary preferred over `npx`. */
function builtinDefs(settings: AppSettings): McpServerDef[] {
  return [gitnexusBaseDef(which(GITNEXUS_SERVER_ID)), vocsMemoryBaseDef(), cuaBaseDef(settings)];
}

/**
 * The ids this app defines itself. A harness that loads its own MCP config alongside what this app
 * injects has to be told to keep them off when the session does not get them. Static: an apparatus
 * name is owned whether or not the current settings enable it, so a same-name entry left in a
 * harness's own store is switched off rather than started beside ours.
 */
export function builtinServerIds(): string[] {
  return [...MCP_BUILTIN_IDS];
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
  const defs = builtinDefs(scope.settings);
  const chosen = builtinEntries({ builtin: defs, state, globalDisabled: scope.settings.mcpDisabledBuiltins, harness: scope.harness, support }).filter((e) => e.enabled);
  const out: ResolvedServer[] = [];
  for (const { def } of chosen) {
    let materialized: McpServerDef | null = def;
    if (def.id === GITNEXUS_SERVER_ID) {
      materialized = await sharedGitnexusDef(scope, def, deps);
      if (!materialized) continue;
    } else if (def.id === VOCS_MEMORY_SERVER_ID) {
      if (!deps.memoryServerPath) continue;
      let memoryGateway: ReturnType<NonNullable<McpHostDeps['memoryGateway']>> = null;
      if (resolveIntelligenceSettings(scope.settings.intelligence).gateway) {
        // An unavailable or revoked gateway may never turn a scoped server into a direct disk reader.
        memoryGateway = scope.sessionId ? (deps.memoryGateway?.(scope.sessionId) ?? null) : null;
        if (!memoryGateway) continue;
      } else if (scope.readOnly || !(await hasMemoryWiki(scope))) continue;
      materialized = memoryServerDef(scope, def, { memoryServerPath: deps.memoryServerPath, memoryUserData: deps.memoryUserData, memoryGateway, log: deps.log });
      if (!materialized) continue;
    }
    const resolved = await resolveVars(materialized, { env: process.env, secret: (name) => deps.getSecret(secretKeyFor(name)) });
    if (resolved.missing.length) deps.log?.('warn', `mcp ${def.id}: no value for ${resolved.missing.join(', ')}`);
    // The capability token is a secret like any `${VAR}`-resolved value: an adapter that flattens
    // its MCP config into argv must hand it over through the environment instead.
    if (def.id === VOCS_MEMORY_SERVER_ID && resolved.def.env?.[MEMORY_GATEWAY_TOKEN_ENV]) resolved.secretEnvKeys.push(MEMORY_GATEWAY_TOKEN_ENV);
    out.push({ ...resolved, def: normalizeStdio(resolved.def, { which: (cmd) => which(cmd) }) });
  }
  return out;
}

/**
 * Connected Hub connections, as app-owned servers. The app-wide and per-repo built-in switches keep
 * them off like any other app server. A broker failure leaves the session without them rather than
 * failing its start.
 */
async function resolveHub(scope: SessionScope, state: McpProjectState, deps: McpHostDeps): Promise<ResolvedServer[]> {
  if (!deps.hubServers) return [];
  const off = new Set([...(scope.settings.mcpDisabledBuiltins ?? []), ...(state.disabledBuiltin ?? [])]);
  try {
    return (await deps.hubServers()).filter((server) => !off.has(server.def.id));
  } catch {
    deps.log?.('warn', 'mcp: Vocs MCP Hub connections are unavailable for this session');
    return [];
  }
}

/**
 * The Mission tools' server, for a session the gateway attaches (it is in a live mission) on a
 * harness that can take one of the roles. Not one of `builtinDefs`: no MCP-tab or per-repo switch
 * can turn it off, and nothing about it exists for an ordinary session. A gateway failure leaves
 * the session without the tools rather than failing its start.
 */
async function resolveMission(scope: SessionScope, deps: McpHostDeps): Promise<ResolvedServer[]> {
  const gateway = deps.missionGateway;
  if (!gateway || !scope.sessionId || !deps.missionServerPath) return [];
  const support = missionSupport(scope.harness);
  if (!support.lead && !support.builder) return [];
  let attachment: MissionGatewayAttachment | null;
  try {
    attachment = gateway.ensureAttachment ? await gateway.ensureAttachment(scope.sessionId) : gateway.attach(scope.sessionId);
  } catch {
    deps.log?.('warn', 'mcp: the Mission gateway is unavailable for this session');
    return [];
  }
  const def = missionServerDef({ missionServerPath: deps.missionServerPath, attachment });
  if (!def) return [];
  // The capability token is a secret: an adapter that flattens its MCP config into argv must hand
  // it over through the environment instead.
  return [{ def: normalizeStdio(def, { which: (cmd) => which(cmd) }), missing: [], secretEnvKeys: [MISSION_GATEWAY_TOKEN_ENV], secretHeaderKeys: [] }];
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
  const chosen = effectiveServers({ global: globals, repo: repoDefs, state, harness: scope.harness, support, builtin: builtinDefs(scope.settings) });
  if (repo.error) deps.log?.('warn', `mcp: ${repo.file} could not be used: ${repo.error}`);
  for (const r of rejectedServers(globals, repo.servers)) deps.log?.('warn', `mcp ${r.id} (${r.scope}) not loaded: ${r.reason}`);
  const out: ResolvedServer[] = await resolveBuiltins(scope, state, deps);
  out.push(...await resolveMission(scope, deps));
  out.push(...await resolveHub(scope, state, deps));
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
  const defs = builtinDefs(scope.settings);
  const injectable = support === 'inject' || support === 'client';
  const registry = await readGitnexusRegistry(realGitnexusHome());
  const indexed = isGitnexusIndexed(registry, { projectRoot: scope.projectRoot, cwd: scope.cwd });
  const wiki = await hasMemoryWiki(scope);
  const usesGateway = resolveIntelligenceSettings(scope.settings.intelligence).gateway;
  const globalDisabled = scope.settings.mcpDisabledBuiltins ?? [];
  const cua = cuaDefState(scope.settings);
  const builtin: McpBuiltinInfo[] = defs.map((def) => {
    const off = globalDisabled.includes(def.id) || (state.disabledBuiltin ?? []).includes(def.id);
    if (def.id === VOCS_MEMORY_SERVER_ID) {
      return {
        def,
        enabled: injectable && !off && (usesGateway || (!scope.readOnly && wiki)),
        disabledGlobally: globalDisabled.includes(def.id),
        shared: false,
        indexed: usesGateway || wiki,
        claimed: canClaimBuiltins(scope.harness),
        note: usesGateway ? 'Uses the app’s scoped memory gateway; a wiki is optional.'
          : scope.readOnly ? 'Legacy memory is not available in Plan mode.'
          : wiki ? 'Legacy mode: reads .vocs-code/wiki in this project.' : 'No project wiki yet — generate one from the Knowledge panel.'
      };
    }
    if (def.id === CUA_SERVER_ID) {
      return {
        def,
        // Opt-in: the app-wide switch is `settings.cua.enabled`, carried on the def as `disabled`.
        enabled: injectable && !off && !def.disabled,
        disabledGlobally: globalDisabled.includes(def.id),
        shared: false,
        // Reused for Cua as "has what it needs to start"; the repo toggle disables on it.
        indexed: cua.installed,
        claimed: canClaimBuiltins(scope.harness),
        note: cua.note
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
    rejected: rejectedServers(globals, repo.servers),
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
