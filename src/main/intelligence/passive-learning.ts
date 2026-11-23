import type { SessionMeta, TranscriptItem } from '../../shared/types';
import { redactSecrets } from '../log';
import type { IntelligenceContext } from './service';

// These limits hold even if many sessions overlap. No full transcript read or polling is needed.
const MAX_TRACKED = 64;
const MAX_QUEUE = 32;
const MAX_ANSWER = 4_096;
const MAX_NOTE = 360;
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const LESSON = /^(?:[-*]\s+)?(?:\*\*)?(?:lesson(?: learned)?|takeaway|gotcha)\s*(?:\*\*)?:\s*(?:\*\*)?\s*(.+)$/i;

export interface PassiveObservation {
  inputId: string;
  answerId: string;
  kind: 'lesson' | 'episode';
  text: string;
}

type Pending = {
  scope: IntelligenceContext;
  inputId: string;
  answer?: { id: string; text: string };
  hasWork: boolean;
};
type SessionState = { lastTurnAt: number; pending?: Pending; ambiguous: boolean };

function scopeOf(session: SessionMeta | undefined): IntelligenceContext | undefined {
  if (!session?.config?.projectRoot || !session.cwd || session.archived || session.mission || session.controlCreation || session.config.permissionMode === 'plan') return undefined;
  return { sessionId: session.id, projectRoot: session.config.projectRoot, cwd: session.cwd, branch: session.worktreeBranch };
}

function sameScope(a: IntelligenceContext, b: IntelligenceContext | undefined): boolean {
  return !!b && a.projectRoot === b.projectRoot && a.cwd === b.cwd && a.branch === b.branch;
}

/** Copy only short, complete prose lines. Tool output, inputs, thinking and code blocks never enter the ledger. */
function takeaway(answer: string, hasWork: boolean): Pick<PassiveObservation, 'kind' | 'text'> | undefined {
  // Drop the excerpt entirely when a recognizable credential spans a line boundary.
  // This is a best-effort filter, not a DLP guarantee; excerpts require review for model recall.
  if (/-----BEGIN|\[redacted\]|:\/\/[^\s/@]+:[^\s/@]+@/i.test(answer) || redactSecrets(answer) !== answer) return;
  let fence: string | undefined;
  let outcome: string | undefined;
  for (const raw of answer.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    // Only top-level prose; also skip the rest after a possible raw HTML block opener.
    if (/^ {0,3}</.test(raw)) break;
    const line = raw.trim();
    if (!line || /^(?: {4}| *\t)/.test(raw) || /^[>#|{]/.test(line)) continue;
    const match = LESSON.exec(line);
    const text = (match ? match[1] : line).trim();
    if (text.length < 36 || text.length > MAX_NOTE || !/\p{L}/u.test(text)) continue;
    if (/[\u0000-\u001f]/.test(text)) continue;
    if (match) return { kind: 'lesson', text };
    if (hasWork && !outcome && text.length >= 64) outcome = text;
  }
  if (outcome) return { kind: 'episode', text: outcome };
}

/** Observes committed upserts only, not renderer events or transcript imports. No knowledge is trusted or sent automatically. */
export class PassiveLearning {
  private readonly sessions = new Map<string, SessionState>();
  private readonly jobs = new Map<string, { sessionId: string; controller: AbortController }>();
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private closed = false;

  constructor(private readonly deps: {
    enabled: () => boolean;
    session: (id: string) => SessionMeta | undefined;
    capture: (ctx: IntelligenceContext, observation: PassiveObservation, current: () => boolean) => Promise<void>;
    failed: () => void;
  }) {}

  prepare(id: string, item: TranscriptItem): (() => void) | undefined {
    if (item.kind !== 'user' && item.kind !== 'assistant' && item.kind !== 'tool' && item.kind !== 'turn') return;
    if (this.closed || !this.deps.enabled() || (item.kind === 'assistant' && item.streaming)) return;
    const generation = this.generation;
    const scope = scopeOf(this.deps.session(id));
    if (!scope) { this.discard(id); return; }
    return () => {
      if (!this.closed && generation === this.generation && this.deps.enabled() && sameScope(scope, scopeOf(this.deps.session(id)))) this.observe(scope, item);
    };
  }

  private observe(scope: IntelligenceContext, item: Extract<TranscriptItem, { kind: 'user' | 'assistant' | 'tool' | 'turn' }>): void {
    const id = scope.sessionId;
    let state = this.sessions.get(id);
    if (item.kind === 'user') {
      if (!state) {
        state = { lastTurnAt: -1, ambiguous: false };
        if (this.sessions.size >= MAX_TRACKED) this.sessions.delete(this.sessions.keys().next().value!);
        this.sessions.set(id, state);
      }
      // The store can append a second copy of a recently committed upsert during a live flush.
      if (item.ts <= state.lastTurnAt || state.pending?.inputId === item.id) return;
      if (state.pending || (item.queuedAs && item.queuedAs !== 'now')) {
        state.pending = undefined;
        state.ambiguous = true;
        return;
      }
      if (!state.ambiguous && item.userInput?.sessionId === id && item.userInput.tokens >= 4 && ID.test(item.id) && !item.text.slice(0, 128).trimStart().startsWith('/')) {
        state.pending = { scope, inputId: item.id, hasWork: false };
      }
      return;
    }
    if (!state || item.ts <= state.lastTurnAt) return;
    const pending = state.pending;
    if (item.kind === 'turn') {
      state.lastTurnAt = item.ts;
      state.pending = undefined;
      state.ambiguous = false;
      if (item.carried || item.status !== 'completed' || !pending?.answer || !sameScope(pending.scope, scope)) return;
      const note = takeaway(pending.answer.text, pending.hasWork);
      if (note) this.schedule(scope, { inputId: pending.inputId, answerId: pending.answer.id, ...note });
    } else if (pending && sameScope(pending.scope, scope)) {
      if (item.kind === 'tool') {
        if (!item.parentId && item.status === 'done' && (item.exitCode == null || item.exitCode === 0) && (item.hint === 'edit' || item.hint === 'execute')) pending.hasWork = true;
      } else if (item.phase !== 'commentary' && item.phase !== 'plan' && ID.test(item.id)) {
        // Cut at a complete line; never turn half of a long line into a valid candidate.
        const sample = item.text.slice(0, MAX_ANSWER);
        const text = item.text.length > MAX_ANSWER ? sample.slice(0, Math.max(0, sample.lastIndexOf('\n'))) : sample;
        pending.answer = text.trim() ? { id: item.id, text } : undefined;
      }
    }
  }

  discard(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const job of this.jobs.values()) if (job.sessionId === sessionId) job.controller.abort();
  }

  reset(): void {
    this.generation++;
    this.sessions.clear();
    for (const job of this.jobs.values()) job.controller.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sessions.clear();
    // Finish the bounded queue while the ledger is still open. Pending turns aren't captured on quit.
    await this.queue;
  }

  private schedule(scope: IntelligenceContext, observation: PassiveObservation): void {
    const key = `${scope.sessionId}/${observation.inputId}`;
    if (this.jobs.has(key) || this.jobs.size >= MAX_QUEUE) return;
    const controller = new AbortController();
    this.jobs.set(key, { sessionId: scope.sessionId, controller });
    const current = () => !controller.signal.aborted && this.deps.enabled() && sameScope(scope, scopeOf(this.deps.session(scope.sessionId)));
    this.queue = this.queue.then(async () => {
      // Yield to transcript/UI work before the SQLite write.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!current()) return;
      await this.deps.capture({ ...scope, signal: controller.signal }, observation, current);
    }).catch(() => {
      if (!controller.signal.aborted) this.deps.failed();
    }).finally(() => this.jobs.delete(key));
  }
}
