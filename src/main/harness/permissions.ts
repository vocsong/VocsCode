import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ApprovalOption, FileChange, PermissionMode } from '../../shared/types';
import type { ApprovalDraft } from './types';
import { isDangerousCommand, isMissionUserCommand } from './types';

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
  action: { mutating: boolean; isEdit: boolean; command?: string; sessionAllowed?: boolean; outsideWorkspace?: boolean; missionBuilder?: boolean }
): GateVerdict {
  if (!action.mutating) return 'allow';
  if (mode === 'plan') return 'deny';
  // A Mission Builder never publishes or elevates on its own, in any tier: the app pushes the
  // mission branch once, and everything else of that class goes to the user through the Lead.
  if (action.missionBuilder && action.command && isMissionUserCommand(action.command)) return 'ask';
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

/** True when `target` (absolute or relative to cwd) resolves outside cwd. */
export function isOutsideWorkspace(cwd: string, target: string | undefined, pathMod: { resolve: (...p: string[]) => string; relative: (a: string, b: string) => string; isAbsolute: (p: string) => boolean }): boolean {
  if (!target) return false;
  const abs = pathMod.resolve(cwd, target);
  const rel = pathMod.relative(pathMod.resolve(cwd), abs);
  return rel.startsWith('..') || pathMod.isAbsolute(rel);
}

/**
 * True when `target` lies outside `cwd` once symlinks and junctions are followed; the check every
 * harness uses for "anything outside the project". Missing descendants are resolved through their
 * nearest existing ancestor. Uncertainty prompts.
 */
export async function requiresPathApproval(cwd: string, target: string): Promise<boolean> {
  const outside = (root: string, file: string) => {
    const rel = path.relative(root, file);
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  };
  const absolute = path.resolve(cwd, target);
  if (outside(path.resolve(cwd), absolute)) return true;
  try {
    const root = await fs.realpath(cwd);
    const missing: string[] = [];
    let ancestor = absolute;
    for (;;) {
      try {
        await fs.lstat(ancestor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return true;
        missing.unshift(path.basename(ancestor));
        ancestor = parent;
        continue;
      }
      // A dangling link or inaccessible realpath throws rather than authorizing its descendants.
      return outside(root, path.join(await fs.realpath(ancestor), ...missing));
    }
  } catch { return true; }
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
