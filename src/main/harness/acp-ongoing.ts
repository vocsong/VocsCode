/** Ongoing activity tracking for ACP child sessions, v2 terminals, background tools, and extension task snapshots. */
import { sameOngoingItems } from '../../shared/ongoing';
import type { OngoingItem, OngoingKind, SessionEvent, TranscriptItem } from '../../shared/types';

type AcpChildSession = {
  id: string;
  label: string;
  agent?: string;
  startedAt: number;
  toolUses: number;
};

type AcpLiveTerminal = {
  id: string;
  label: string;
  startedAt: number;
  background?: boolean;
};

const ACP_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'canceled', 'removed', 'exited', 'idle', 'done', 'error']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isExplicitlyBackground(meta: unknown, rawInput: unknown): boolean {
  const m = asRecord(meta);
  if (m && (m.background === true || m.isBackground === true || m.is_background === true)) return true;
  const input = asRecord(rawInput);
  if (input && (input.background === true || input.run_in_background === true || input.isBackground === true)) return true;
  return false;
}

function acpOngoingKind(rawKind: unknown, rawType: unknown): OngoingKind {
  const s = String(rawKind ?? rawType ?? '').toLowerCase();
  if (s.includes('subagent') || s.includes('agent') || s.includes('teammate')) return 'subagent';
  if (s.includes('hook')) return 'hook';
  return 'task';
}

function acpOngoingDetail(rawDetail: unknown, rawType: unknown): string | undefined {
  const s = typeof rawDetail === 'string' && rawDetail.trim() ? rawDetail.trim() : typeof rawType === 'string' && rawType.trim() ? rawType.trim() : undefined;
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower.includes('cron')) return 'cron';
  if (lower.includes('schedule')) return 'schedule';
  if (lower.includes('timer')) return 'timer';
  if (lower.includes('bash') || lower.includes('shell') || lower.includes('command')) return 'local_bash';
  if (lower.includes('workflow')) return 'local_workflow';
  return s;
}

export class AcpOngoingTracker {
  /** Child/subagent ACP sessions reported via `session/update` with a non-parent `sessionId`. */
  private childSessions = new Map<string, AcpChildSession>();
  /** ACP v2 `terminal_update` live terminals (no exitStatus yet). */
  private liveTerminals = new Map<string, AcpLiveTerminal>();
  /** Explicitly backgrounded or out-of-turn tool calls still in progress. */
  private backgroundTools = new Map<string, OngoingItem>();
  /** Authoritative replace-list tasks from `background_tasks_changed` (when supported). */
  private snapshotTasks = new Map<string, OngoingItem>();
  /** Edge-tracked background tasks/subagents/schedules from extension notifications. */
  private edgeTasks = new Map<string, OngoingItem>();
  private lastEmittedThreads: OngoingItem[] = [];
  private lastEmittedTasks: OngoingItem[] = [];

  constructor(
    private readonly deps: {
      emit: (event: SessionEvent) => void;
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
      isTurnActive: () => boolean;
      sessionId: () => string | null;
      agentTag: () => string;
    }
  ) {}

  emitThreads(): void {
    const items: OngoingItem[] = [...this.childSessions.values()].map((child) => ({
      id: `thread:${child.id}`,
      kind: 'subagent',
      agent: child.agent,
      label: child.label,
      startedAt: child.startedAt,
      ...(child.toolUses > 0 ? { toolUses: child.toolUses } : {})
    }));
    if (sameOngoingItems(this.lastEmittedThreads, items)) return;
    this.lastEmittedThreads = items;
    this.deps.emit({ type: 'ongoing', source: 'threads', items });
  }

  emitTasks(): void {
    const merged = new Map<string, OngoingItem>();
    for (const [k, item] of this.snapshotTasks) merged.set(k, item);
    for (const [k, item] of this.edgeTasks) merged.set(k, item);
    for (const [k, item] of this.backgroundTools) merged.set(k, item);
    const turnActive = this.deps.isTurnActive();
    for (const term of this.liveTerminals.values()) {
      // During an active foreground turn, regular terminals are already shown in tool cards;
      // surface explicitly-backgrounded terminals immediately and all live terminals once idle.
      if (turnActive && !term.background) continue;
      merged.set(`terminal:${term.id}`, {
        id: `terminal:${term.id}`,
        kind: 'task',
        detail: 'terminal',
        label: term.label,
        startedAt: term.startedAt
      });
    }
    const items = [...merged.values()];
    if (sameOngoingItems(this.lastEmittedTasks, items)) return;
    this.lastEmittedTasks = items;
    this.deps.emit({ type: 'ongoing', source: 'tasks', items });
  }

  clear(): void {
    this.childSessions.clear();
    this.liveTerminals.clear();
    this.backgroundTools.clear();
    this.snapshotTasks.clear();
    this.edgeTasks.clear();
    this.emitThreads();
    this.emitTasks();
  }

  onChildSessionUpdate(childSessionId: string, u: Record<string, unknown> & { sessionUpdate: string }): void {
    const existing = this.childSessions.get(childSessionId);
    const meta = asRecord(u._meta);
    const metaState = typeof meta?.state === 'string'
      ? meta.state.toLowerCase()
      : typeof meta?.status === 'string'
        ? meta.status.toLowerCase()
        : '';
    if (metaState && ACP_TERMINAL_STATUSES.has(metaState)) {
      if (this.childSessions.delete(childSessionId)) this.emitThreads();
      return;
    }
    if (u.sessionUpdate === 'state_update') {
      const state = typeof u.state === 'string' ? u.state.toLowerCase() : '';
      if (ACP_TERMINAL_STATUSES.has(state)) {
        if (this.childSessions.delete(childSessionId)) this.emitThreads();
        return;
      }
      if (!existing) {
        this.childSessions.set(childSessionId, {
          id: childSessionId,
          label: typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : 'Subagent',
          agent: typeof meta?.agent === 'string' && meta.agent.trim() ? meta.agent.trim() : undefined,
          startedAt: Date.now(),
          toolUses: 0
        });
        this.emitThreads();
      }
      return;
    }
    if (u.sessionUpdate === 'session_info_update') {
      const title = typeof u.title === 'string' ? u.title.trim() : '';
      if (title) {
        const next: AcpChildSession = existing
          ? { ...existing, label: title }
          : { id: childSessionId, label: title, startedAt: Date.now(), toolUses: 0 };
        this.childSessions.set(childSessionId, next);
        this.emitThreads();
      }
      return;
    }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update' || u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') {
      const next: AcpChildSession = existing
        ? { ...existing }
        : {
            id: childSessionId,
            label: typeof u.title === 'string' && u.title.trim() ? u.title.trim() : typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim() : 'Subagent',
            agent: typeof meta?.agent === 'string' && meta.agent.trim() ? meta.agent.trim() : undefined,
            startedAt: Date.now(),
            toolUses: 0
          };
      if (u.sessionUpdate === 'tool_call') next.toolUses += 1;
      this.childSessions.set(childSessionId, next);
      this.emitThreads();
    }
  }

  onTerminalUpdate(raw: Record<string, unknown>): void {
    const terminalId = typeof raw.terminalId === 'string' ? raw.terminalId : typeof raw.terminal_id === 'string' ? raw.terminal_id : '';
    if (!terminalId) return;
    if (raw.exitStatus !== undefined && raw.exitStatus !== null) {
      if (this.liveTerminals.delete(terminalId)) this.emitTasks();
      return;
    }
    const existing = this.liveTerminals.get(terminalId);
    const label = typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : existing?.label ?? 'Terminal command';
    const background = existing?.background || isExplicitlyBackground(raw._meta, raw);
    this.liveTerminals.set(terminalId, { id: terminalId, label, startedAt: existing?.startedAt ?? Date.now(), background });
    this.emitTasks();
  }

  applyBackgroundTasksSnapshot(rawTasks: unknown): void {
    if (!Array.isArray(rawTasks)) return;
    const prev = this.snapshotTasks;
    const next = new Map<string, OngoingItem>();
    const now = Date.now();
    for (const entry of rawTasks) {
      const rec = asRecord(entry);
      if (!rec || rec.ambient === true) continue;
      const id = String(rec.task_id ?? rec.taskId ?? rec.id ?? '').trim();
      if (!id) continue;
      const status = typeof rec.status === 'string' ? rec.status.toLowerCase() : '';
      if (status && ACP_TERMINAL_STATUSES.has(status)) continue;
      const key = `task:${id}`;
      const existing = prev.get(key);
      const kind = acpOngoingKind(rec.kind, rec.task_type ?? rec.taskType ?? rec.type);
      const detail = acpOngoingDetail(rec.detail, rec.task_type ?? rec.taskType ?? rec.type);
      const label = String(rec.description ?? rec.label ?? rec.title ?? rec.command ?? id).trim() || id;
      const agent = typeof rec.agent === 'string' ? rec.agent : typeof rec.agent_type === 'string' ? rec.agent_type : undefined;
      const startedAt = typeof rec.startedAt === 'number' && rec.startedAt > 0
        ? rec.startedAt
        : typeof rec.started_at === 'number' && rec.started_at > 0
          ? rec.started_at
          : existing?.startedAt ?? now;
      next.set(key, { id: key, kind, ...(detail ? { detail } : {}), ...(agent ? { agent } : {}), label, startedAt });
    }
    this.snapshotTasks = next;
    this.emitTasks();
  }

  applyOngoingEdgeUpdate(eventName: string, raw: Record<string, unknown>): void {
    if (raw.ambient === true) return;
    const id = String(raw.task_id ?? raw.taskId ?? raw.scheduleId ?? raw.schedule_id ?? raw.subagentId ?? raw.subagent_id ?? raw.runId ?? raw.id ?? '').trim();
    if (!id) return;
    const lowerEvent = eventName.toLowerCase();
    const isSubagentEvent = lowerEvent.includes('subagent');
    const isScheduleEvent = lowerEvent.includes('schedule') || lowerEvent.includes('cron') || lowerEvent.includes('timer');
    const key = isSubagentEvent ? `subagent:${id}` : isScheduleEvent ? `schedule:${id}` : `task:${id}`;
    const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : typeof raw.state === 'string' ? raw.state.toLowerCase() : '';
    if (raw.active === false || raw.removed === true || (status && ACP_TERMINAL_STATUSES.has(status))) {
      if (this.edgeTasks.delete(key)) this.emitTasks();
      return;
    }
    const existing = this.edgeTasks.get(key);
    const kind: OngoingKind = isSubagentEvent ? 'subagent' : acpOngoingKind(raw.kind, raw.task_type ?? raw.taskType ?? raw.type);
    const detail = isScheduleEvent
      ? acpOngoingDetail(raw.detail ?? 'schedule', raw.type ?? 'schedule')
      : acpOngoingDetail(raw.detail, raw.task_type ?? raw.taskType ?? raw.type);
    const label = String(raw.description ?? raw.label ?? raw.title ?? raw.prompt ?? raw.command ?? existing?.label ?? id).trim() || id;
    const agent = typeof raw.agent === 'string' ? raw.agent : typeof raw.role === 'string' ? raw.role : existing?.agent;
    const startedAt = typeof raw.startedAt === 'number' && raw.startedAt > 0
      ? raw.startedAt
      : typeof raw.started_at === 'number' && raw.started_at > 0
        ? raw.started_at
        : existing?.startedAt ?? Date.now();
    this.edgeTasks.set(key, { id: key, kind, ...(detail ? { detail } : {}), ...(agent ? { agent } : {}), label, startedAt });
    this.emitTasks();
  }

  onExtNotification(method: string, params: Record<string, unknown>): void {
    const rec = asRecord(params);
    if (!rec) return;
    const targetSession = typeof rec.sessionId === 'string' ? rec.sessionId : typeof rec.session_id === 'string' ? rec.session_id : undefined;
    const parentSession = this.deps.sessionId();
    const suffix = method.split('/').pop()?.toLowerCase() ?? method.toLowerCase();
    if (suffix === 'state_update' || suffix === 'stateupdate') {
      if (targetSession && parentSession && targetSession !== parentSession) {
        this.onChildSessionUpdate(targetSession, { ...rec, sessionUpdate: 'state_update' });
      }
      return;
    }
    if (targetSession && parentSession && targetSession !== parentSession) return;
    if (suffix === 'terminal_update' || suffix === 'terminalupdate') {
      this.onTerminalUpdate(rec);
      return;
    }
    if (suffix === 'background_tasks_changed' || suffix === 'backgroundtaskschanged') {
      this.applyBackgroundTasksSnapshot(rec.tasks ?? rec.items);
      return;
    }
    if (
      suffix === 'background_task_update' ||
      suffix === 'backgroundtaskupdate' ||
      suffix === 'subagent_update' ||
      suffix === 'subagentupdate' ||
      suffix === 'schedule_update' ||
      suffix === 'scheduleupdate'
    ) {
      this.applyOngoingEdgeUpdate(suffix, rec);
      return;
    }
    this.deps.log('debug', `[acp:${this.deps.agentTag()}] unhandled extNotification: ${method}`);
  }

  syncBackgroundTool(
    item: Extract<TranscriptItem, { kind: 'tool' }>,
    raw: { toolCallId: string; name?: string | null; kind?: string | null; rawInput?: unknown; _meta?: Record<string, unknown> | null }
  ): void {
    const bgKey = `tool:${raw.toolCallId}`;
    if (item.status !== 'running') {
      if (this.backgroundTools.delete(bgKey)) this.emitTasks();
    } else if (!this.deps.isTurnActive() || isExplicitlyBackground(raw._meta, raw.rawInput) || this.backgroundTools.has(bgKey)) {
      const prev = this.backgroundTools.get(bgKey);
      const meta = asRecord(raw._meta);
      const kind = acpOngoingKind(meta?.kind, raw.name ?? raw.kind);
      const detail = acpOngoingDetail(meta?.detail, raw.name ?? (raw.kind === 'execute' ? 'local_bash' : undefined));
      const label = (item.summary ?? item.title ?? raw.name ?? item.name ?? raw.toolCallId).trim();
      this.backgroundTools.set(bgKey, {
        id: bgKey,
        kind,
        ...(detail ? { detail } : {}),
        ...(typeof meta?.agent === 'string' && meta.agent.trim() ? { agent: meta.agent.trim() } : {}),
        label,
        startedAt: prev?.startedAt ?? item.ts
      });
      this.emitTasks();
    }
  }
}
