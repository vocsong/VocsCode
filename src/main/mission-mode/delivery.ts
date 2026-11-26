/** Debounced, idle-boundary-only host-message delivery queue for Mission Leads and Builders. */
import type { MissionMessageMeta } from '../../shared/mission-mode';
import type { SessionMeta } from '../../shared/types';
import { errorMessage } from '../util/async';
import {
  clip,
  combineInboxEntries,
  DELIVERING,
  inboxOf,
  isActive,
  makeInboxEntry,
  needsRoleReminder,
  RecordWriteError,
  who,
  type DeliveryTarget
} from './format';
import type { InboxEntry, MissionRecord } from './record';

const DELIVERY_DELAY_MS = 1_500;
/** A target that is busy without a fresh event (a runtime still disposing) is looked at again. */
const BUSY_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface MissionDeliverySessionPort {
  get(id: string): SessionMeta | undefined;
  activity(id: string): { turn: boolean; starting: boolean; approvals: number; queued: number; tearingDown: boolean; compacting: boolean; tools: number };
  sendHost(id: string, text: string, meta?: MissionMessageMeta): Promise<unknown>;
  note(id: string, text: string, level?: 'info' | 'warn' | 'error'): void;
}

export interface MissionDeliveryDeps {
  sessions: MissionDeliverySessionPort;
  getRecord: (missionId: string) => MissionRecord | undefined;
  mutate: <T>(missionId: string, fn: (draft: MissionRecord) => T) => Promise<T>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  deliveryDelayMs?: number;
}

export class MissionDeliveryQueue {
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  private readonly delivering = new Set<string>();
  private readonly backoff = new Map<string, { until: number; failures: number }>();
  private disposed = false;

  constructor(private readonly deps: MissionDeliveryDeps) {}

  dispose(): void {
    this.disposed = true;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  forgetMission(missionId: string): void {
    for (const [key, t] of this.timers) {
      if (!key.startsWith(`${missionId}:`)) continue;
      clearTimeout(t.timer);
      this.timers.delete(key);
    }
  }

  /** Between turns: no turn or start in flight, no pending approval, nothing queued, not tearing down. */
  isIdle(sessionId: string): boolean {
    const meta = this.deps.sessions.get(sessionId);
    if (!meta || meta.archived) return false;
    if (meta.status === 'running' || meta.status === 'starting' || meta.status === 'awaiting') return false;
    const a = this.deps.sessions.activity(sessionId);
    return !a.turn && !a.starting && !a.approvals && !a.queued && !a.tearingDown && !a.compacting && !a.tools;
  }

  /** Arms (or brings forward) the delivery of one target's inbox. */
  schedule(missionId: string, target: DeliveryTarget, delay = this.deps.deliveryDelayMs ?? DELIVERY_DELAY_MS): void {
    if (this.disposed) return;
    const key = `${missionId}:${target}`;
    const back = this.backoff.get(key);
    const at = Math.max(Date.now() + delay, back?.until ?? 0);
    const pending = this.timers.get(key);
    if (pending && pending.at <= at) return;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.deliver(missionId, target).catch((e) => this.deps.log('warn', `mission ${missionId}: delivery to ${target} failed: ${errorMessage(e)}`));
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.timers.set(key, { timer, at });
  }

  async enqueue(missionId: string, target: DeliveryTarget, entry: Omit<InboxEntry, 'id' | 'ts'>): Promise<void> {
    await this.deps.mutate(missionId, (d) => {
      const e = makeInboxEntry(entry.kind, entry.text, { builderId: entry.builderId, requestId: entry.requestId });
      if (target === 'lead') d.inbox.lead.push(e);
      else (d.inbox.builders[target] ??= []).push(e);
    });
    this.schedule(missionId, target);
  }

  /** One combined host message, only when the target is between turns. */
  private async deliver(missionId: string, target: DeliveryTarget): Promise<void> {
    const key = `${missionId}:${target}`;
    if (this.delivering.has(key) || this.disposed) return;
    const record = this.deps.getRecord(missionId);
    if (!record || !DELIVERING.has(record.state)) return;
    const builder = target === 'lead' ? undefined : record.builders.find((b) => b.id === target);
    if (target !== 'lead' && (!builder || builder.state === 'stopped' || builder.accepted)) return;
    const sessionId = builder ? builder.sessionId : record.leadId;
    if (!inboxOf(record, target).length) return;
    if (!this.isIdle(sessionId)) {
      // The next status or turn event brings this forward; the poll covers a runtime still disposing.
      this.schedule(missionId, target, BUSY_POLL_MS);
      return;
    }
    this.delivering.add(key);
    let taken: InboxEntry[] = [];
    try {
      taken = await this.deps.mutate(missionId, (d) => {
        const list = inboxOf(d, target);
        if (target === 'lead') d.inbox.lead = [];
        else delete d.inbox.builders[target];
        return list;
      });
      if (!taken.length) return;
      // The record write gave the session a moment: never send into a turn that started meanwhile.
      if (!this.isIdle(sessionId)) {
        await this.putBack(missionId, target, taken);
        taken = [];
        this.schedule(missionId, target, BUSY_POLL_MS);
        return;
      }
      // The kickoff rides with the role prompt itself; later messages re-anchor harnesses without one.
      const { text, meta } = combineInboxEntries(taken, !!builder && needsRoleReminder(builder.harness) && taken.some((e) => e.kind !== 'kickoff'));
      await this.deps.sessions.sendHost(sessionId, text, meta);
      this.backoff.delete(key);
    } catch (e) {
      if (e instanceof RecordWriteError) {
        this.deps.log('warn', `mission ${missionId}: could not take ${target}'s messages: ${e.message}`);
      } else {
        this.deps.log('warn', `mission ${missionId}: could not deliver to ${target}: ${errorMessage(e)}`);
        if (taken.length) await this.putBack(missionId, target, taken).catch(() => undefined);
      }
      const failures = (this.backoff.get(key)?.failures ?? 0) + 1;
      this.backoff.set(key, { failures, until: Date.now() + Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** (failures - 1)) });
      if (failures === 3) this.deliveryStalled(missionId, target, errorMessage(e));
    } finally {
      this.delivering.delete(key);
      const now = this.deps.getRecord(missionId);
      if (now && inboxOf(now, target).length) this.schedule(missionId, target);
    }
  }

  private async putBack(missionId: string, target: DeliveryTarget, entries: InboxEntry[]): Promise<void> {
    await this.deps.mutate(missionId, (d) => {
      if (target === 'lead') d.inbox.lead = [...entries, ...d.inbox.lead];
      else d.inbox.builders[target] = [...entries, ...(d.inbox.builders[target] ?? [])];
    });
  }

  private deliveryStalled(missionId: string, target: DeliveryTarget, error: string): void {
    const record = this.deps.getRecord(missionId);
    if (!record) return;
    if (target === 'lead') {
      this.deps.sessions.note(record.leadId, `Mission messages could not be delivered to the Lead: ${error}. They are kept and retried.`, 'warn');
      return;
    }
    void this.deps.mutate(missionId, (d) => {
      const b = d.builders.find((x) => x.id === target);
      if (!b || !isActive(b)) return;
      b.state = 'failed';
      d.inbox.lead.push(makeInboxEntry('failed', `${who(b)} "${b.title}" could not be reached: ${clip(error, 400)}. Its messages are kept; stop_builder it or try message_builder later.`, { builderId: b.id }));
    }).then(() => this.schedule(missionId, 'lead')).catch(() => undefined);
  }
}
