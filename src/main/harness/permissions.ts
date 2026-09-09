import type { ApprovalOption, FileChange, PermissionMode } from '../../shared/types';
import type { ApprovalDraft } from './types';
import { isDangerousCommand } from './types';

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
  action: { mutating: boolean; isEdit: boolean; command?: string; sessionAllowed?: boolean; outsideWorkspace?: boolean }
): GateVerdict {
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

/** True when `target` (absolute or relative to cwd) resolves outside cwd. */
export function isOutsideWorkspace(cwd: string, target: string | undefined, pathMod: { resolve: (...p: string[]) => string; relative: (a: string, b: string) => string; isAbsolute: (p: string) => boolean }): boolean {
  if (!target) return false;
  const abs = pathMod.resolve(cwd, target);
  const rel = pathMod.relative(pathMod.resolve(cwd), abs);
  return rel.startsWith('..') || pathMod.isAbsolute(rel);
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
