import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalOption, FileChange, PermissionMode } from '../../shared/types';
import type { ApprovalDraft } from './types';
import { isDangerousCommand } from './types';
import { isMissionCoordinationTool, MISSION_SERVER_ID } from '../../../resources/pi/vocs-code-mission';

/** Only the exact reserved app-owned SDK bridge gets coordination authority. A lookalike MCP
 * name or a readOnly annotation from an arbitrary server grants nothing. These operations may
 * mutate Mission records in Plan; broker authorization still forbids source writes/user controls. */
export function isTrustedMissionCoordination(toolName: string, server?: { name: string; source: string }): boolean {
  const prefix = `mcp__${MISSION_SERVER_ID}__`;
  return server?.name === MISSION_SERVER_ID && server.source === 'sdk' && toolName.startsWith(prefix) &&
    isMissionCoordinationTool(server.name, toolName.slice(prefix.length));
}

/** Standard option sets for approval cards. */
export const OPTIONS_ALLOW_DENY: ApprovalOption[] = [
  { id: 'allow', label: 'Allow once', kind: 'allow' },
  { id: 'allow_session', label: 'Allow for session', kind: 'allow_session', description: 'Do not ask again for this tool in this session.' },
  { id: 'deny', label: 'Deny', kind: 'deny' }
];

export const OPTIONS_ALLOW_DENY_NO_SESSION: ApprovalOption[] = [
  { id: 'allow', label: 'Allow', kind: 'allow' },
  { id: 'deny', label: 'Deny', kind: 'deny' }
];

export type GateVerdict = 'allow' | 'deny' | 'ask';

/**
 * Generic gate shared by adapters that implement approvals client-side (pi, acp, native, claude canUseTool).
 * `mutating` says whether the action changes state; `isEdit` marks file edits (accept-edits auto-allows those).
 */
export function gateAction(
  mode: PermissionMode,
  action: { mutating: boolean; isEdit: boolean; command?: string; sessionAllowed?: boolean; outsideWorkspace?: boolean; trustedCoordination?: boolean }
): GateVerdict {
  if (action.trustedCoordination) return 'allow';
  if (!action.mutating) return 'allow';
  if (mode === 'plan') return 'deny';
  if (mode === 'full-auto') return 'allow';
  // Below full access, a dangerous command always prompts, even after "allow for session",
  // and so does any write that leaves the project directory.
  if (action.command && isDangerousCommand(action.command)) return 'ask';
  if (action.outsideWorkspace) return 'ask';
  if (action.sessionAllowed) return 'allow';
  if (mode === 'auto') return 'allow';
  if (mode === 'accept-edits') return action.isEdit ? 'allow' : 'ask';
  return 'ask';
}

/**
 * Resolve `target` through symlinks/junctions (including dangling symlinks and non-existent leaf
 * segments) by walking up to the deepest existing ancestor. Fails closed by throwing on loops.
 */
function resolveRealWithAncestors(target: string, hops = 0): string {
  if (hops > 16) throw new Error('Too many symbolic link levels');
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
  }
  const tail: string[] = [];
  let cur = resolved;
  while (true) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        // Dangling symlink (realpath failed with ENOENT): follow its target so an escape outside
        // cwd is still detected even before the external destination exists.
        const link = fs.readlinkSync(cur);
        const next = path.resolve(path.dirname(cur), link, ...tail.reverse());
        return resolveRealWithAncestors(next, hops + 1);
      }
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return resolved;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/** True when `target` (absolute or relative to cwd) resolves outside cwd, including via symlinks/junctions. */
export function isOutsideWorkspace(
  cwd: string,
  target: string | undefined,
  pathMod: { resolve: (...p: string[]) => string; relative: (a: string, b: string) => string; isAbsolute: (p: string) => boolean; sep?: string }
): boolean {
  if (!target) return false;
  const sep = pathMod.sep ?? (pathMod === path.posix ? '/' : pathMod === path.win32 ? '\\' : path.sep);
  const fold = (p: string) => (pathMod !== path.posix && process.platform === 'win32' ? p.toLowerCase() : p);
  const outside = (base: string, dest: string) => {
    const rel = pathMod.relative(fold(base), fold(dest));
    return rel === '..' || rel.startsWith(`..${sep}`) || pathMod.isAbsolute(rel);
  };
  const resolvedCwd = pathMod.resolve(cwd);
  const abs = pathMod.resolve(resolvedCwd, target);
  if (outside(resolvedCwd, abs)) return true;
  if (pathMod === path && fs.existsSync(resolvedCwd)) {
    try {
      const realCwd = resolveRealWithAncestors(resolvedCwd);
      const realTarget = resolveRealWithAncestors(abs);
      return outside(realCwd, realTarget);
    } catch {
      // Unresolvable symlink loop or unreadable boundary: fail closed so permissions prompt.
      return true;
    }
  }
  return false;
}

export function commandApproval(command: string, cwd?: string, extra?: Partial<ApprovalDraft>): ApprovalDraft {
  return {
    kind: 'command',
    title: 'Run command?',
    command,
    cwd,
    options: OPTIONS_ALLOW_DENY,
    ...extra
  };
}

export function fileChangeApproval(changes: FileChange[], extra?: Partial<ApprovalDraft>): ApprovalDraft {
  const names = changes.map((c) => c.path);
  return {
    kind: 'file_change',
    title: changes.length === 1 ? `Apply change to ${names[0]}?` : `Apply changes to ${changes.length} files?`,
    changes,
    options: OPTIONS_ALLOW_DENY,
    ...extra
  };
}

export function toolApproval(toolName: string, input: unknown, summary?: string, extra?: Partial<ApprovalDraft>): ApprovalDraft {
  return {
    kind: 'tool',
    title: `Allow ${toolName}?`,
    toolName,
    input,
    description: summary,
    options: OPTIONS_ALLOW_DENY,
    ...extra
  };
}

export const PLAN_MODE_DENIAL = 'Plan mode is active: this action would modify state. Describe what you would do instead, or ask the user to switch modes.';
