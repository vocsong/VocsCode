/**
 * Offline tests for the Codex app-server turn lifecycle. A turn that outlives the old five-minute
 * request timeout must stay busy while notifications stream (issue #130), and a late turn/start
 * response must not resurrect a finished turn.
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { emptyUsage } from '../src/main/models/static-models';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent } from '../src/shared/types';

interface PendingRequest {
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function fixture() {
  const events: SessionEvent[] = [];
  const ctx = {
    emit: (e: SessionEvent) => events.push(e),
    session: () => ({ cwd: process.cwd(), usage: emptyUsage() }),
    permissionMode: () => 'auto',
    updateMeta: vi.fn(),
    updateRef: vi.fn(),
    log: vi.fn(),
    sessionDir: process.cwd()
  } as unknown as HarnessContext;
  const adapter = new CodexAppServerAdapter(ctx);
  const notifications = new Map<string, (params: unknown) => void>();
  const pending: PendingRequest[] = [];
  const rpc = {
    request: vi.fn(
      (method: string, params: unknown) =>
        new Promise((resolve, reject) => {
          pending.push({ method, params, resolve, reject });
        })
    ),
    onNotification: (method: string, handler: (params: unknown) => void) => notifications.set(method, handler),
    onServerRequest: vi.fn()
  };
  (adapter as unknown as { rpc: unknown; threadId: string }).rpc = rpc;
  (adapter as unknown as { threadId: string }).threadId = 'thread-1';
  (adapter as unknown as { wireNotifications: (client: unknown) => void }).wireNotifications(rpc);
  const statuses = () => events.filter((e): e is Extract<SessionEvent, { type: 'status' }> => e.type === 'status').map((e) => e.status);
  const complete = (status: 'completed' | 'interrupted' = 'completed', id = 'turn-1') =>
    notifications.get('turn/completed')!({ threadId: 'thread-1', turn: { id, status, error: null, durationMs: 12 } });
  return { adapter, events, pending, statuses, complete, notifications };
}

describe('codex turn/start lifecycle', () => {
  it('keeps the turn running past the old five-minute timeout while notifications stream', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, pending, statuses, complete } = fixture();
      const sending = adapter.send({ text: 'long task' });
      expect(adapter.busy).toBe(true);
      expect(statuses()).toContain('running');

      pending[0]!.resolve({ turn: { id: 'turn-1' } });
      await vi.advanceTimersByTimeAsync(400_000);
      expect(adapter.busy).toBe(true);
      expect(statuses()).not.toContain('idle');

      complete();
      await sending;
      expect(adapter.busy).toBe(false);
      expect(statuses()).toContain('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect a completed turn when turn/start resolves late', async () => {
    const { adapter, pending, complete } = fixture();
    const sending = adapter.send({ text: 'hi' });

    complete();
    expect(adapter.busy).toBe(false);
    pending[0]!.resolve({ turn: { id: 'turn-1' } });
    await sending;

    expect((adapter as unknown as { turnId: string | null }).turnId).toBeNull();
    expect(adapter.busy).toBe(false);
  });

  it('records the turn id from an immediate response', async () => {
    const { adapter, pending } = fixture();
    const sending = adapter.send({ text: 'hi' });
    pending[0]!.resolve({ turn: { id: 'turn-9' } });
    await sending;
    expect((adapter as unknown as { turnId: string | null }).turnId).toBe('turn-9');
    expect(adapter.busy).toBe(true);
  });

  it('interrupts the parent and releases queued input only on parent completion', async () => {
    const { adapter, events, pending, complete, notifications, statuses } = fixture();
    const sending = adapter.send({ text: 'parent task' });
    pending[0]!.resolve({ turn: { id: 'turn-1' } });
    await sending;
    await adapter.send({ text: 'follow-up', mode: 'queue' });

    notifications.get('turn/started')!({ threadId: 'child', turn: { id: 'child-turn' } });
    const interrupting = adapter.interrupt();
    expect(pending[1]).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
    pending[1]!.resolve({});
    await interrupting;

    notifications.get('turn/completed')!({ threadId: 'child', turn: { id: 'child-turn', status: 'interrupted', error: null, durationMs: 5 } });
    expect(statuses()).toEqual(['running']);
    expect(pending.map((r) => r.method)).toEqual(['turn/start', 'turn/interrupt']);

    complete('interrupted');
    expect(pending.map((r) => r.method)).toEqual(['turn/start', 'turn/interrupt', 'turn/start']);
    pending[2]!.resolve({ turn: { id: 'turn-2' } });
    await Promise.resolve();
    complete('completed', 'turn-2');
    expect(adapter.busy).toBe(false);
    expect(statuses()).toEqual(['running', 'idle', 'running', 'idle']);
    expect(events.flatMap((e) => e.type === 'item.upsert' && e.item.kind === 'turn' ? [e.item.status] : [])).toEqual(['interrupted', 'completed']);
  });

  it('clears busy and reports idle when turn/start itself fails', async () => {
    const { adapter, pending, statuses } = fixture();
    const err = new Error('transport closed');
    const sending = adapter.send({ text: 'hi' });
    pending[0]!.reject(err);
    await expect(sending).rejects.toThrow('transport closed');
    expect(adapter.busy).toBe(false);
    expect(statuses().filter((s) => s === 'idle')).toHaveLength(1);
  });
});

describe('codex token usage accounting', () => {
  it('stores input tokens excluding the cached subset codex counts inside them', () => {
    const { events, notifications } = fixture();
    notifications.get('thread/tokenUsage/updated')!({
      threadId: 'thread-1',
      tokenUsage: {
        total: { inputTokens: 1_000_000, cachedInputTokens: 900_000, cacheWriteInputTokens: 0, outputTokens: 5_000, reasoningOutputTokens: 1_000, totalTokens: 905_000 },
        last: { totalTokens: 905_000 },
        modelContextWindow: 272_000
      }
    });
    const usage = [...events].reverse().find((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage');
    // Cached tokens are a subset of the input count: 100k uncached + 900k cache reads, not 1.9M prompt tokens.
    expect(usage?.totals).toMatchObject({ inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, reasoningTokens: 1_000 });
  });

  it('prices each sample at the rate of the model that produced it', async () => {
    const { adapter, events, notifications } = fixture();
    const notify = (inputTokens: number, outputTokens: number) =>
      notifications.get('thread/tokenUsage/updated')!({
        threadId: 'thread-1',
        tokenUsage: {
          total: { inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens },
          last: { totalTokens: inputTokens + outputTokens },
          modelContextWindow: null
        }
      });
    const spend = () => [...events].reverse().find((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage')?.totals.costUsd;

    await adapter.setModel({ provider: 'openai', model: 'gpt-5.6-luna' });
    notify(100, 100);
    expect(spend()).toBeCloseTo((100 * 0.2 + 100 * 1.2) / 1_000_000, 10);

    // Sol's rates are 25× Luna's on both counters. The 200 tokens already billed at Luna's rates
    // must keep their price when the model changes mid-session; only the new 200 are Sol's.
    await adapter.setModel({ provider: 'openai', model: 'gpt-5.6-sol' });
    notify(300, 300);
    expect(spend()).toBeCloseTo((100 * 0.2 + 100 * 1.2 + 200 * 5 + 200 * 30) / 1_000_000, 10);
  });
});
