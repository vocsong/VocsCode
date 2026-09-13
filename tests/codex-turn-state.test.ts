/**
 * Offline tests for the Codex app-server turn lifecycle. A turn that outlives the old five-minute
 * request timeout must stay busy while notifications stream (issue #130), and a late turn/start
 * response must not resurrect a finished turn.
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent } from '../src/shared/types';

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function fixture() {
  const events: SessionEvent[] = [];
  const ctx = {
    emit: (e: SessionEvent) => events.push(e),
    session: () => ({ cwd: process.cwd(), usage: {} }),
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
      (method: string) =>
        new Promise((resolve, reject) => {
          pending.push({ method, resolve, reject });
        })
    ),
    onNotification: (method: string, handler: (params: unknown) => void) => notifications.set(method, handler),
    onServerRequest: vi.fn()
  };
  (adapter as unknown as { rpc: unknown; threadId: string }).rpc = rpc;
  (adapter as unknown as { threadId: string }).threadId = 'thread-1';
  (adapter as unknown as { wireNotifications: (client: unknown) => void }).wireNotifications(rpc);
  const statuses = () => events.filter((e): e is Extract<SessionEvent, { type: 'status' }> => e.type === 'status').map((e) => e.status);
  const complete = (status: 'completed' | 'failed' = 'completed') =>
    notifications.get('turn/completed')!({ turn: { id: 'turn-1', status, error: null, durationMs: 12 } });
  return { adapter, events, pending, statuses, complete };
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
