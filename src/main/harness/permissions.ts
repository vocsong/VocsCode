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
  action: { mutating: boolean; isEdit: boolean; command?: string; sessionAllowed?: boolean }
): GateVerdict {
  if (!action.mutating) return 'allow';
  if (mode === 'plan') return 'deny';
  if (mode === 'full-auto') return 'allow';
  if (action.sessionAllowed) return 'allow';
  if (mode === 'auto') return action.command && isDangerousCommand(action.command) ? 'ask' : 'allow';
  if (mode === 'accept-edits') return action.isEdit ? 'allow' : 'ask';
  return 'ask';
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
