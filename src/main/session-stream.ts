/**
 * Streaming transcript checkpointing, live-item persistence flushing, and ephemeral ongoing-work
 * reconciliation for SessionManager.
 */
import type { AppSettings, OngoingItem, SessionEvent, SessionMeta, TranscriptItem } from '../shared/types';
import { hasOngoingWork, sameOngoingItems } from '../shared/ongoing';
import { subagentSupport } from '../shared/subagents';
import type { ActiveSession } from './session-types';

/**
 * A streaming answer lives in memory until it settles, so a crash would lose all of it. It is
 * checkpointed to the transcript no more often than this, and only once its text and thinking have
 * grown by STREAM_CHECKPOINT_GROWTH of the last copy: every checkpoint appends the whole item, and
 * geometric growth keeps the bytes written under (1 + 1/growth)× the final size however long it
 * streams. A crash loses at most the last interval of text or its last fifth, whichever is more.
 */
const STREAM_CHECKPOINT_MS = 2_000;
const STREAM_CHECKPOINT_GROWTH = 0.25;

export interface SessionStreamHost {
  getActive(id: string): ActiveSession | undefined;
  getSession(id: string): SessionMeta | undefined;
  isControlled(id: string): boolean;
  isViewing(id: string): boolean;
  settings(): AppSettings;
  appendTranscript(sessionId: string, item: TranscriptItem): void;
  writeTranscriptItem(sessionId: string, item: TranscriptItem): Promise<void>;
  publish(sessionId: string, event: SessionEvent): void;
  schedulePersist(meta: SessionMeta): void;
  pushSessions(): void;
  notify(sessionId: string, title: string, body: string): void;
  advanceGoalContinuation(meta: SessionMeta, active: ActiveSession): void;
}

export class SessionStreamController {
  constructor(private readonly host: SessionStreamHost) {}

  /**
   * Persists every live item changed since its last write. A streaming answer is skipped while its
   * harness may still finish it; with `settle` the harness is gone, so the partial answer is saved
   * as final and the renderer is told it stopped streaming.
   */
  async flushLive(sessionId: string, active: ActiveSession, settle = false): Promise<void> {
    if (settle) this.resetCheckpoints(active);
    for (const id of [...active.dirty]) {
      const item = active.liveItems.get(id);
      if (!item) continue;
      const streaming = item.kind === 'assistant' && item.streaming;
      if (streaming && !settle) continue;
      const saved: TranscriptItem = streaming ? { ...item, streaming: false } : item;
      await this.host.writeTranscriptItem(sessionId, saved);
      active.dirty.delete(id);
      if (streaming) {
        active.liveItems.set(id, saved);
        this.host.publish(sessionId, { type: 'item.upsert', item: saved });
      }
    }
  }

  /**
   * Appends a copy of a streaming answer once it is due under STREAM_CHECKPOINT_MS and
   * STREAM_CHECKPOINT_GROWTH, so a crash mid-response leaves the partial text on disk. An item
   * that has grown enough but was written too recently is picked up by a timer, so a stream that
   * goes quiet is still saved; one that has not grown enough waits for its next delta.
   */
  checkpointStream(sessionId: string, active: ActiveSession, item: Extract<TranscriptItem, { kind: 'assistant' }>): void {
    const checkpoints = (active.checkpoints ??= new Map());
    const now = Date.now();
    const size = item.text.length + (item.thinking?.length ?? 0);
    const last = checkpoints.get(item.id);
    // The first sighting starts the clock; nothing is worth saving before the first interval.
    if (!last) {
      checkpoints.set(item.id, { at: now, size: 0 });
      if (size > 0) this.scheduleCheckpoint(sessionId, active, STREAM_CHECKPOINT_MS);
      return;
    }
    if (size - last.size < Math.max(1, Math.ceil(last.size * STREAM_CHECKPOINT_GROWTH))) return;
    const wait = last.at + STREAM_CHECKPOINT_MS - now;
    if (wait > 0) {
      this.scheduleCheckpoint(sessionId, active, wait);
      return;
    }
    checkpoints.set(item.id, { at: now, size });
    // Copied: the live item keeps mutating while the append waits its turn in the write queue.
    this.host.appendTranscript(sessionId, { ...item });
  }

  resetCheckpoints(active: ActiveSession): void {
    if (active.checkpointTimer) clearTimeout(active.checkpointTimer);
    active.checkpointTimer = null;
    active.checkpoints?.clear();
  }

  /**
   * Recomputes the session's live `meta.ongoing` list from running `nativeChildren` (`subagent.run`)
   * plus per-source `ongoing` events (`tasks`, `hooks`, `wakeup`, `threads`). Deduplicates subagents
   * reported on both channels by `runId` (preferring the richer `subagent.run` metadata), pushes
   * immediately when changed (without persisting to disk), and schedules the post-settlement check
   * when all autonomous background work finishes.
   */
  syncOngoing(sessionId: string, active: ActiveSession): void {
    if (this.host.getActive(sessionId) !== active || active.tearingDown) return;
    const meta = this.host.getSession(sessionId);
    if (!meta) return;
    const canStopSubagent = subagentSupport(meta.config.harness).control;
    const items: OngoingItem[] = [];
    const seenRunIds = new Set<string>();
    const seenIds = new Set<string>();
    for (const [runId, child] of active.nativeChildren ?? []) {
      if (!child.running) continue;
      seenRunIds.add(runId);
      const id = `subagent:${runId}`;
      seenIds.add(id);
      items.push({
        id,
        kind: 'subagent',
        label: child.description?.trim() || child.agent || 'Subagent',
        ...(child.agent ? { agent: child.agent } : {}),
        runId,
        ...(child.turns !== undefined ? { turns: child.turns } : {}),
        ...(child.toolUses !== undefined ? { toolUses: child.toolUses } : {}),
        startedAt: child.startedAt,
        canStop: canStopSubagent
      });
    }
    for (const sourceItems of active.ongoingBySource?.values() ?? []) {
      for (const item of sourceItems) {
        if (item.runId && seenRunIds.has(item.runId)) continue;
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        items.push(item);
      }
    }
    items.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    const prev = meta.ongoing;
    const prevHadOngoing = !!prev?.length;
    const next = items.length ? items : undefined;
    if (!sameOngoingItems(prev, next)) {
      meta.ongoing = next;
      this.host.pushSessions();
    }
    if (next && active.ongoingSettleTimer) {
      clearTimeout(active.ongoingSettleTimer);
      active.ongoingSettleTimer = null;
    } else if (prevHadOngoing && !next && (active.deferredTurnNotice || active.deferredGoalContinuation)) {
      if (active.ongoingSettleTimer) clearTimeout(active.ongoingSettleTimer);
      active.ongoingSettleTimer = setTimeout(() => {
        active.ongoingSettleTimer = null;
        this.onOngoingSettled(sessionId, active);
      }, 150);
      active.ongoingSettleTimer.unref?.();
    }
  }

  private scheduleCheckpoint(sessionId: string, active: ActiveSession, wait: number): void {
    if (active.checkpointTimer) return;
    active.checkpointTimer = setTimeout(() => {
      active.checkpointTimer = null;
      if (this.host.getActive(sessionId) !== active) return;
      for (const id of [...(active.checkpoints?.keys() ?? [])]) {
        const item = active.liveItems.get(id);
        if (item?.kind === 'assistant' && item.streaming) this.checkpointStream(sessionId, active, item);
        else active.checkpoints.delete(id);
      }
    }, wait);
    active.checkpointTimer.unref?.();
  }

  /**
   * Fires after autonomous background work empties and no new parent turn took over within the brief
   * handoff window: delivers the deferred "done · not viewed" mark / OS notification and resumes any
   * deferred app-driven `/goal` continuation.
   */
  private onOngoingSettled(sessionId: string, active: ActiveSession): void {
    if (this.host.getActive(sessionId) !== active || active.tearingDown) return;
    const meta = this.host.getSession(sessionId);
    if (!meta || hasOngoingWork(meta) || meta.status !== 'idle' || active.adapter.busy) return;
    const notice = active.deferredTurnNotice;
    active.deferredTurnNotice = null;
    if (notice) {
      if (!meta.archived && !this.host.isViewing(meta.id)) {
        meta.unseenAt = Date.now();
        if (notice.status === 'failed') meta.unseenFailed = true;
        else delete meta.unseenFailed;
        this.host.schedulePersist(meta);
        this.host.pushSessions();
      }
      if (this.host.settings().notifications) {
        this.host.notify(
          meta.id,
          meta.title,
          notice.status === 'completed' ? 'Background work finished' : `Turn ${notice.status}${notice.error ? `: ${notice.error}` : ''}`
        );
      }
    }
    const deferredGoal = active.deferredGoalContinuation;
    active.deferredGoalContinuation = null;
    if (deferredGoal && !this.host.isControlled(meta.id) && meta.goal === deferredGoal.goal && meta.goal.status === 'active' && meta.goal.autoContinue) {
      this.host.advanceGoalContinuation(meta, active);
    }
  }
}
