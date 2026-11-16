/**
 * GitNexus ships with Vocs Code as a built-in MCP server, scoped strictly to the session's repo.
 *
 * GitNexus keeps every index in one global registry (`~/.gitnexus/registry.json`) and its `mcp`
 * command serves all of them, so isolation is ours to build. One `gitnexus serve` process backs
 * every session (see shared-server.ts); what a session may reach is decided here, by the registry
 * entries visible to its repo — the repo itself (matched against `projectRoot` and `cwd`) plus any
 * repo the user promoted to global scope (`mcpProjectState[root].gitnexusGlobal`). The scope proxy
 * enforces that list on every call. No Electron imports.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_BUILTIN_IDS, type AppSettings, type McpServerDef } from '../../shared/types';

export const GITNEXUS_SERVER_ID = MCP_BUILTIN_IDS[0];

/** The one built-in server today; the id list is the shadow/exclusion key everywhere else. */
export function isBuiltinServerId(id: string): boolean {
  return MCP_BUILTIN_IDS.includes(id);
}

/** The built-in definition, before the per-session env is attached. */
export function gitnexusBaseDef(installedPath?: string | null): McpServerDef {
  return installedPath
    ? { id: GITNEXUS_SERVER_ID, transport: 'stdio', command: installedPath, args: ['mcp'], description: 'GitNexus code knowledge graph', builtin: GITNEXUS_SERVER_ID }
    : { id: GITNEXUS_SERVER_ID, transport: 'stdio', command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'], description: 'GitNexus code knowledge graph', builtin: GITNEXUS_SERVER_ID };
}

/** GitNexus's own home resolution: `GITNEXUS_HOME`, else `~/.gitnexus`. */
export function realGitnexusHome(env: NodeJS.ProcessEnv = process.env, homedir: string = os.homedir()): string {
  return env.GITNEXUS_HOME || path.join(homedir, '.gitnexus');
}

/** One entry of GitNexus's global registry. */
export interface GitnexusRegistryEntry {
  name: string;
  path: string;
  [key: string]: unknown;
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Reads `~/.gitnexus/registry.json`; a missing or malformed file yields no entries. */
export async function readGitnexusRegistry(realHome: string): Promise<GitnexusRegistryEntry[]> {
  try {
    const raw = await fs.readFile(path.join(realHome, 'registry.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is GitnexusRegistryEntry => !!e && typeof e === 'object' && typeof (e as { path?: unknown }).path === 'string' && typeof (e as { name?: unknown }).name === 'string');
  } catch {
    return [];
  }
}

/** Project roots the user has promoted to global scope. */
export function gitnexusSharedRoots(settings: AppSettings): string[] {
  const state = settings.mcpProjectState ?? {};
  return Object.entries(state)
    .filter(([, v]) => v?.gitnexusGlobal === true)
    .map(([root]) => root);
}

/** The registry entries a session in `projectRoot` / `cwd` may see, and nothing else. */
export function visibleGitnexusEntries(
  entries: GitnexusRegistryEntry[],
  opts: { projectRoot: string; cwd: string; sharedRoots: string[] }
): GitnexusRegistryEntry[] {
  const wanted = new Set<string>([normalize(opts.projectRoot), normalize(opts.cwd), ...opts.sharedRoots.map(normalize)]);
  return entries.filter((e) => wanted.has(normalize(e.path)));
}

/** Whether the session repo (or its worktree) has an index GitNexus can serve. */
export function isGitnexusIndexed(entries: GitnexusRegistryEntry[], opts: { projectRoot: string; cwd: string }): boolean {
  return visibleGitnexusEntries(entries, { ...opts, sharedRoots: [] }).length > 0;
}

