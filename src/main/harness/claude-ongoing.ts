/** Ongoing activity tracking for Claude background tasks and user/project hooks. */
import type { OngoingItem, SessionEvent } from '../../shared/types';

/** Delay before surfacing a Claude hook as ongoing work, so fast hooks never flicker in the UI. */
const HOOK_VISIBILITY_DELAY_MS = 250;

/** Records a live Claude background task (from `background_tasks_changed` or edge fallback). */
interface LiveBackgroundTask {
  taskId: string;
  taskType: string;
  description: string;
  startedAt: number;
}

/** Records a live user/project Claude hook between `hook_started` and `hook_response`. */
interface LiveHookRun {
  hookId: string;
  hookName: string;
  hookEvent: string;
  startedAt: number;
  visible: boolean;
  timer?: NodeJS.Timeout;
}

export interface SubagentTaskSummary {
  runId: string;
  agent?: string;
  description?: string;
  turns?: number;
  toolUses?: number;
  startedAt?: number;
}

function isInternalHookName(hookName: string | undefined): boolean {
  if (!hookName) return true;
  return hookName === 'callback' || hookName.endsWith(':callback');
}

export class ClaudeOngoingTracker {
  /** Live non-ambient background tasks from `background_tasks_changed` (or edge fallback on older CLIs). */
  private readonly backgroundTasks = new Map<string, LiveBackgroundTask>();
  /** True once this CLI process has emitted the authoritative `background_tasks_changed` level signal. */
  private seenBackgroundTasksSnapshot = false;
  /** Live user/project hooks between `hook_started` and `hook_response`. */
  private readonly activeHooks = new Map<string, LiveHookRun>();
  /** Depth of Vocs Code's own SDK hook callbacks (`preToolUse` / `postToolUse`), never surfaced as user hooks. */
  private internalHookDepth = 0;

  constructor(
    private readonly deps: {
      emit: (event: SessionEvent) => void;
      lookupSubagentByTaskId: (taskId: string) => SubagentTaskSummary | undefined;
    }
  ) {}

  async withInternalHook<T>(fn: () => Promise<T>): Promise<T> {
    this.internalHookDepth++;
    try {
      return await fn();
    } finally {
      this.internalHookDepth = Math.max(0, this.internalHookDepth - 1);
    }
  }

  onBackgroundTasksChanged(tasks: readonly { task_id: string; task_type?: string; description?: string; ambient?: boolean }[]): void {
    this.seenBackgroundTasksSnapshot = true;
    const prev = new Map(this.backgroundTasks);
    this.backgroundTasks.clear();
    const now = Date.now();
    for (const t of tasks) {
      if (!t || typeof t.task_id !== 'string' || !t.task_id || t.ambient === true) continue;
      const existing = prev.get(t.task_id);
      this.backgroundTasks.set(t.task_id, {
        taskId: t.task_id,
        taskType: typeof t.task_type === 'string' ? t.task_type : '',
        description: typeof t.description === 'string' ? t.description : '',
        startedAt: existing?.startedAt ?? now
      });
    }
    this.emitBackgroundTasks();
  }

  onTaskStarted(t: { task_id?: string; task_type?: string; description?: string; is_backgrounded?: boolean; ambient?: boolean; skip_transcript?: boolean }): void {
    // Re-enrich if `background_tasks_changed` arrived before this `task_started` bookend.
    if (this.seenBackgroundTasksSnapshot && t.task_id && this.backgroundTasks.has(t.task_id)) {
      this.emitBackgroundTasks();
    } else if (!this.seenBackgroundTasksSnapshot && t.is_backgrounded && !t.ambient && !t.skip_transcript && t.task_type !== 'local_agent' && typeof t.task_id === 'string' && t.task_id) {
      this.backgroundTasks.set(t.task_id, { taskId: t.task_id, taskType: t.task_type ?? '', description: t.description ?? '', startedAt: Date.now() });
      this.emitBackgroundTasks();
    }
  }

  onTaskUpdated(t: { task_id?: string; patch?: { status?: string } }): void {
    if (!this.seenBackgroundTasksSnapshot && t.task_id) {
      const st = t.patch?.status;
      if ((st === 'completed' || st === 'failed' || st === 'killed') && this.backgroundTasks.delete(t.task_id)) {
        this.emitBackgroundTasks();
      }
    }
  }

  onTaskNotification(t: { task_id?: string }): void {
    if (!this.seenBackgroundTasksSnapshot && t.task_id && this.backgroundTasks.delete(t.task_id)) {
      this.emitBackgroundTasks();
    }
  }

  onHookStarted(msg: { hook_id?: string; hook_name?: string; hook_event?: string }): void {
    const hookId = typeof msg.hook_id === 'string' ? msg.hook_id : '';
    const hookName = typeof msg.hook_name === 'string' ? msg.hook_name : '';
    const hookEvent = typeof msg.hook_event === 'string' ? msg.hook_event : '';
    if (!hookId) return;
    // Skip Vocs Code's own internal SDK callbacks (permission gating / file snapshots).
    if (isInternalHookName(hookName)) return;
    if (this.internalHookDepth > 0 && (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') && !hookName) return;
    const existing = this.activeHooks.get(hookId);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: LiveHookRun = { hookId, hookName, hookEvent, startedAt: Date.now(), visible: false };
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.activeHooks.get(hookId) !== entry) return;
      entry.visible = true;
      this.emitHooks();
    }, HOOK_VISIBILITY_DELAY_MS);
    entry.timer.unref?.();
    this.activeHooks.set(hookId, entry);
  }

  onHookResponse(msg: { hook_id?: string }): void {
    const hookId = typeof msg.hook_id === 'string' ? msg.hook_id : '';
    if (!hookId) return;
    const entry = this.activeHooks.get(hookId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.activeHooks.delete(hookId);
    if (entry.visible) this.emitHooks();
  }

  clear(): void {
    const hadTasks = this.backgroundTasks.size > 0;
    this.backgroundTasks.clear();
    this.seenBackgroundTasksSnapshot = false;
    let hadVisibleHooks = false;
    for (const entry of this.activeHooks.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.visible) hadVisibleHooks = true;
    }
    this.activeHooks.clear();
    if (hadTasks) this.deps.emit({ type: 'ongoing', source: 'tasks', items: [] });
    if (hadVisibleHooks) this.deps.emit({ type: 'ongoing', source: 'hooks', items: [] });
  }

  private emitBackgroundTasks(): void {
    const items: OngoingItem[] = [];
    for (const task of this.backgroundTasks.values()) {
      const run = this.deps.lookupSubagentByTaskId(task.taskId);
      if (run || task.taskType === 'local_agent') {
        items.push({
          id: run ? `subagent:${run.runId}` : `task:${task.taskId}`,
          kind: 'subagent',
          label: run?.description || task.description || 'Subagent',
          ...(run?.agent ? { agent: run.agent } : {}),
          ...(run?.runId ? { runId: run.runId } : {}),
          ...(run?.turns !== undefined ? { turns: run.turns } : {}),
          ...(run?.toolUses !== undefined ? { toolUses: run.toolUses } : {}),
          startedAt: run?.startedAt ?? task.startedAt,
          canStop: false
        });
      } else {
        items.push({
          id: `task:${task.taskId}`,
          kind: 'task',
          label: task.description || task.taskType || 'Background task',
          ...(task.taskType ? { detail: task.taskType } : {}),
          startedAt: task.startedAt,
          canStop: false
        });
      }
    }
    this.deps.emit({ type: 'ongoing', source: 'tasks', items });
  }

  private emitHooks(): void {
    const items: OngoingItem[] = [];
    for (const hook of this.activeHooks.values()) {
      if (!hook.visible) continue;
      items.push({
        id: `hook:${hook.hookId}`,
        kind: 'hook',
        label: hook.hookName || hook.hookEvent || 'Hook',
        ...(hook.hookEvent ? { detail: hook.hookEvent } : {}),
        startedAt: hook.startedAt,
        canStop: false
      });
    }
    this.deps.emit({ type: 'ongoing', source: 'hooks', items });
  }
}
