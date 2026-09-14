/**
 * The Layer 2 built-in MCP server: one stdio process per session serving the project wiki.
 *
 * Like GitNexus, the app owns the definition and injects it through the normal resolver, so every
 * harness with `inject`/`client` support gets the same five tools with no adapter code. Unlike
 * GitNexus there is no shared process and no cross-repo surface: the wiki lives in the project
 * root, and a worktree session additionally sees its own checkout's wiki root for branch-scope
 * pages. A project with no wiki gets no server at all rather than a tool that answers nothing.
 *
 * No Electron imports.
 */
import path from 'node:path';
import { KNOWLEDGE_DIR, type KnowledgeScope } from '../../shared/knowledge';
import type { McpServerDef } from '../../shared/types';
import { which } from '../runtime';
import { exists } from '../util/fs';

export const VOCS_MEMORY_SERVER_ID = 'vocs-memory';

/** Where a project's working wiki lives; the one path the whole feature hangs off. */
export function memoryRoot(scope: Pick<KnowledgeScope, 'projectRoot'>): string {
  return path.join(scope.projectRoot, KNOWLEDGE_DIR);
}

/** The worktree's own wiki, or null when the session runs in the project root. */
export function memoryBranchRoot(scope: Pick<KnowledgeScope, 'cwd' | 'projectRoot'>): string | null {
  if (path.resolve(scope.cwd) === path.resolve(scope.projectRoot)) return null;
  return path.join(scope.cwd, KNOWLEDGE_DIR);
}

export async function hasMemoryWiki(scope: Pick<KnowledgeScope, 'projectRoot' | 'cwd'>): Promise<boolean> {
  if (await exists(memoryRoot(scope))) return true;
  const branch = memoryBranchRoot(scope);
  return branch ? exists(branch) : false;
}

/** The built-in definition, before the per-session env is attached. */
export function vocsMemoryBaseDef(): McpServerDef {
  return {
    id: VOCS_MEMORY_SERVER_ID,
    transport: 'stdio',
    command: 'node',
    args: [],
    description: 'Project knowledge wiki (architecture, decisions, conventions, gotchas)'
  };
}

interface MemoryHostDeps {
  /** Path to resources/mcp/vocs-memory.mjs. */
  memoryServerPath?: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Materializes the server for one session: the app's node (or Electron in Node mode, exactly as the
 * GitNexus proxy does) plus the two wiki roots. Null when the repo has no wiki yet, or the app was
 * built without the script.
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
      VOCS_MEMORY_ROOT: memoryRoot(scope),
      ...(branchRoot ? { VOCS_MEMORY_BRANCH_ROOT: branchRoot } : {}),
      ...(scope.branch ? { VOCS_MEMORY_BRANCH: scope.branch } : {})
    }
  };
}
