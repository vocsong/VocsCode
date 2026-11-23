/**
 * The Layer 2 built-in MCP server: one stdio process per session serving the project wiki.
 *
 * The app injects this built-in through the normal resolver. The gateway client receives only
 * a runtime capability; it cannot fall back to disk. The standalone, wiki-only definition is
 * used only in explicit legacy mode.
 *
 * No Electron imports.
 */
import path from 'node:path';
import { KNOWLEDGE_BRANCHES_DIR, KNOWLEDGE_DIR, branchSlug, type KnowledgeScope } from '../../shared/knowledge';
import type { McpServerDef } from '../../shared/types';
import { which } from '../runtime';
import { exists } from '../util/fs';

export const VOCS_MEMORY_SERVER_ID = 'vocs-memory';
/** How the stdio server learns where the app's gateway is; the token is a per-session secret. */
export const MEMORY_GATEWAY_URL_ENV = 'VOCS_MEMORY_GATEWAY_URL';
export const MEMORY_GATEWAY_TOKEN_ENV = 'VOCS_MEMORY_GATEWAY_TOKEN';

/** Where a project's working wiki lives; the one path the whole feature hangs off. */
export function memoryRoot(scope: Pick<KnowledgeScope, 'projectRoot'>): string {
  return path.join(scope.projectRoot, KNOWLEDGE_DIR);
}

/** The branch's slice of the project wiki, or null for a session that is not on a branch. */
export function memoryBranchRoot(scope: Pick<KnowledgeScope, 'projectRoot' | 'branch'>): string | null {
  if (!scope.branch) return null;
  return path.join(memoryRoot(scope), KNOWLEDGE_BRANCHES_DIR, branchSlug(scope.branch));
}

export async function hasMemoryWiki(scope: Pick<KnowledgeScope, 'projectRoot'>): Promise<boolean> {
  return exists(memoryRoot(scope));
}

/** The built-in definition, before the per-session env is attached. */
export function vocsMemoryBaseDef(): McpServerDef {
  return {
    id: VOCS_MEMORY_SERVER_ID,
    transport: 'stdio',
    command: 'node',
    args: [],
    description: 'Project knowledge and memory, scoped to this session',
    builtin: VOCS_MEMORY_SERVER_ID
  };
}

interface MemoryHostDeps {
  /** Path to resources/mcp/vocs-memory.mjs. */
  memoryServerPath?: string;
  /**
   * The app-owned gateway endpoint and this session's capability token. Present, the server is a
   * thin client and every tool call is answered by the app; absent, it serves the wiki on its own.
   */
  memoryGateway?: { url: string; token: string } | null;
  /** The app's userData, where search.db and sessions.json live (session history recall). */
  memoryUserData?: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Materializes the server using Node (or Electron in Node mode). Do not hand the thin client
 * local wiki or transcript paths; its only authority is the app-issued bearer capability.
 */
export function memoryServerDef(scope: { projectRoot: string; cwd: string; branch?: string }, def: McpServerDef, deps: MemoryHostDeps): McpServerDef | null {
  if (!deps.memoryServerPath) return null;
  const node = which('node');
  const branchRoot = memoryBranchRoot(scope);
  return {
    ...def,
    transport: 'stdio',
    command: node ?? process.execPath,
    args: [deps.memoryServerPath],
    env: {
      ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
      ...(deps.memoryGateway
        ? { [MEMORY_GATEWAY_URL_ENV]: deps.memoryGateway.url, [MEMORY_GATEWAY_TOKEN_ENV]: deps.memoryGateway.token }
        : {
            VOCS_MEMORY_ROOT: memoryRoot(scope),
            VOCS_MEMORY_PROJECT_ROOT: scope.projectRoot,
            ...(branchRoot ? { VOCS_MEMORY_BRANCH_ROOT: branchRoot } : {}),
            ...(scope.branch ? { VOCS_MEMORY_BRANCH: scope.branch } : {}),
            ...(deps.memoryUserData ? { VOCS_MEMORY_USER_DATA: deps.memoryUserData } : {})
          })
    }
  };
}
