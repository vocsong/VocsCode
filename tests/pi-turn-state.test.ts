/** Pi adapter turn-end state: pi reports turn failures via the assistant message's
 *  stopReason ('error'/'aborted'), not as a dedicated event, and agent_end can be
 *  followed by an automatic retry. Regression coverage for turns silently stopping
 *  halfway with the transcript showing "Turn complete". */
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { describe, expect, it } from 'vitest';
import { PiAdapter } from '../src/main/harness/pi';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function stubCtx(): { ctx: HarnessContext; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'pi', projectRoot: '.', permissionMode: 'ask' },
    cwd: '.',
    status: 'idle',
    harnessRef: {},
    usage: { ...ZERO_USAGE }
  };
  const ctx = {
    sessionId: 's1',
    session: () => meta,
    settings: () => ({ claude: { settingSources: [], useProviderKey: false }, pi: { extraArgs: [] } }) as never,
    runtime: {} as never,
    sessionDir: '.',
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => undefined,
    emit: (e: SessionEvent) => events.push(e),
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
  return { ctx, events };
}

/** handleLine is private; drive it directly with RPC-mode events. */
function feed(adapter: PiAdapter, ev: Record<string, unknown>): void {
  (adapter as unknown as { handleLine: (line: string) => void }).handleLine(JSON.stringify(ev));
}

/** finishTurn awaits a get_session_stats round-trip that rejects (no child process). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const turns = (events: SessionEvent[]): TranscriptItem[] =>
  events.filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert').map((e) => e.item as TranscriptItem).filter((i) => i.kind === 'turn');

describe('Pi adapter turn-state tracking', () => {
  it('marks a turn failed when pi ends it with an error stopReason', async () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, { type: 'agent_start' });
    feed(a, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limited', content: [] } });
    feed(a, { type: 'agent_end', messages: [] });
    await settle();
    const turn = turns(events).at(-1) as Extract<TranscriptItem, { kind: 'turn' }>;
    expect(turn.status).toBe('failed');
    expect(turn.error).toBe('429 rate limited');
  });

  it('does not finish the turn while an automatic retry is pending', async () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, { type: 'agent_start' });
    feed(a, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded', content: [] } });
    feed(a, { type: 'agent_end', messages: [], willRetry: true });
    await settle();
    expect(turns(events)).toHaveLength(0);
    // The retry succeeds: final agent_end completes the turn normally.
    feed(a, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } });
    feed(a, { type: 'agent_end', messages: [], willRetry: false });
    await settle();
    const turn = turns(events).at(-1) as Extract<TranscriptItem, { kind: 'turn' }>;
    expect(turn.status).toBe('completed');
  });

  it('marks an aborted turn as interrupted', async () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, { type: 'agent_start' });
    feed(a, { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', content: [] } });
    feed(a, { type: 'agent_end', messages: [] });
    await settle();
    const turn = turns(events).at(-1) as Extract<TranscriptItem, { kind: 'turn' }>;
    expect(turn.status).toBe('interrupted');
    expect(turn.error).toBeUndefined();
  });

  it('reports a failed compaction instead of a bogus compacted message', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, { type: 'compaction_end', aborted: false, result: null, errorMessage: 'Compaction failed: quota exceeded' });
    const infos = events.filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert').map((e) => e.item as Extract<TranscriptItem, { kind: 'info' }>).filter((i) => i.kind === 'info');
    expect(infos.at(-1)?.text).toBe('Compaction failed: quota exceeded');
  });
});
