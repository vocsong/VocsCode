/**
 * Normalized ongoing background activity for a session, independent of whether the parent turn
 * is currently running or idle. Keep this file free of Node/Electron/DOM imports.
 *
 * Autonomous agent work (`subagent` | `task` | `hook`) rides on `SessionMeta.ongoing` (ephemeral,
 * never persisted across restarts). Desktop-only OS process activity rides separately on
 * `ProcessSummary.bySession` so OS PIDs and command lines stay out of session metadata.
 */
export type OngoingKind = 'subagent' | 'task' | 'hook';

/** Independent producer channel for `SessionEvent { type: 'ongoing' }` (replace semantics per source). */
export type OngoingSource = 'tasks' | 'hooks' | 'wakeup' | 'threads';

export interface OngoingItem {
  /** Stable per-session key, e.g. `subagent:<runId>`, `task:<taskId>`, `hook:<hookId>`, `thread:<threadId>`. */
  id: string;
  kind: OngoingKind;
  /** Short human label: agent description, command summary, or hook name. */
  label: string;
  /** Secondary context: e.g. task type (`local_bash`), hook event (`Stop`), or agent type. */
  detail?: string;
  /** Epoch ms when this item started. */
  startedAt: number;
  /** Subagent run id when inspectable in the Subagents tab. */
  runId?: string;
  /** Subagent type name (e.g. `Explore`, `general-purpose`). */
  agent?: string;
  turns?: number;
  toolUses?: number;
  /** True when the user can stop this specific item directly (e.g. Pi subagent via `subagents:stop`). */
  canStop?: boolean;
}

/** True when the session has live autonomous background work (subagents, background tasks, hooks). */
export function hasOngoingWork(session: { ongoing?: readonly OngoingItem[] } | undefined): boolean {
  return !!session?.ongoing && session.ongoing.length > 0;
}

/** Count of currently running subagent items in a session's ongoing activity. */
export function runningSubagentCount(session: { ongoing?: readonly OngoingItem[] } | undefined): number {
  if (!session?.ongoing?.length) return 0;
  let count = 0;
  for (const item of session.ongoing) if (item.kind === 'subagent') count++;
  return count;
}

/** True when a session has either an active parent turn or live autonomous background work. */
export function isSessionActiveWork(session: { status: 'idle' | 'starting' | 'running' | 'awaiting' | 'error' | 'stopped' | 'pr' | 'merged'; ongoing?: readonly OngoingItem[] }): boolean {
  return session.status === 'starting' || session.status === 'running' || session.status === 'awaiting' || hasOngoingWork(session);
}

/** Short label for sidebar pills and compact badges (e.g. `1 subagent`, `2 hooks`, `3 ongoing`). */
export function ongoingBadgeLabel(items: readonly OngoingItem[]): string {
  if (items.length === 0) return '';
  let subagents = 0;
  let tasks = 0;
  let hooks = 0;
  for (const item of items) {
    if (item.kind === 'subagent') subagents++;
    else if (item.kind === 'hook') hooks++;
    else tasks++;
  }
  const kinds = (subagents > 0 ? 1 : 0) + (tasks > 0 ? 1 : 0) + (hooks > 0 ? 1 : 0);
  if (kinds > 1) return `${items.length} ongoing`;
  if (subagents > 0) return `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`;
  if (hooks > 0) return `${hooks} ${hooks === 1 ? 'hook' : 'hooks'}`;
  if (tasks === 1 && items[0]?.detail === 'wakeup') return 'Continuing…';
  return `${tasks} ${tasks === 1 ? 'task' : 'tasks'}`;
}

/** Headline for the transcript tail's ongoing-activity strip. */
export function ongoingStripHeadline(items: readonly OngoingItem[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) {
    const item = items[0]!;
    if (item.kind === 'subagent') return item.agent ? `Background ${item.agent} running` : 'Background subagent running';
    if (item.kind === 'hook') return item.detail ? `${item.detail} hook running` : 'Hook running';
    if (item.detail === 'wakeup') return 'Delivering subagent result…';
    if (item.detail === 'local_bash' || item.detail === 'terminal') return 'Background command running';
    if (item.detail === 'local_workflow') return 'Background workflow running';
    if (item.detail === 'mcp_task') return 'Background MCP task running';
    if (item.detail === 'schedule' || item.detail === 'cron') return 'Scheduled task pending';
    if (item.detail === 'timer') return 'Timer running';
    return 'Background task running';
  }
  let subagents = 0;
  let tasks = 0;
  let hooks = 0;
  for (const item of items) {
    if (item.kind === 'subagent') subagents++;
    else if (item.kind === 'hook') hooks++;
    else tasks++;
  }
  const parts: string[] = [];
  if (subagents) parts.push(`${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`);
  if (tasks) parts.push(`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`);
  if (hooks) parts.push(`${hooks} ${hooks === 1 ? 'hook' : 'hooks'}`);
  return `${parts.join(', ')} running in background`;
}

/** Structural equality for ongoing lists so unchanged updates do not trigger redundant pushes. */
export function sameOngoingItems(a: readonly OngoingItem[] | undefined, b: readonly OngoingItem[] | undefined): boolean {
  const listA = a ?? [];
  const listB = b ?? [];
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i++) {
    const x = listA[i]!;
    const y = listB[i]!;
    if (
      x.id !== y.id ||
      x.kind !== y.kind ||
      x.label !== y.label ||
      x.detail !== y.detail ||
      x.startedAt !== y.startedAt ||
      x.runId !== y.runId ||
      x.agent !== y.agent ||
      x.turns !== y.turns ||
      x.toolUses !== y.toolUses ||
      x.canStop !== y.canStop
    ) {
      return false;
    }
  }
  return true;
}
