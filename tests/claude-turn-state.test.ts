/** Claude adapter busy-state: the CLI can start turns on its own (queued/steered messages), so the
 *  adapter must observe turn start from the message stream, not just send(). Regression coverage
 *  for the "Interrupted but still continuing with no stop button" bug. */
import type { SessionEvent, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/main/harness/claude';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function stubCtx(): { ctx: HarnessContext; events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: '.', permissionMode: 'ask' },
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

/** handle() is private; drive it directly with SDK-shaped messages. */
function feed(adapter: ClaudeAdapter, msg: Record<string, unknown>): void {
  (adapter as unknown as { handle: (m: unknown, q: unknown) => void }).handle(msg as never, null);
}

const streamEvent = (deltaType: string, text = 'hi') => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: deltaType, text } }
});

describe('Claude adapter turn-state tracking', () => {
  it('marks busy and emits running when the CLI starts a turn without a send() (queued message after interrupt)', () => {
    const { ctx, events } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    expect(a.busy).toBe(false);
    feed(a, { type: 'result', subtype: 'success', duration_ms: 1000, terminal_reason: 'aborted_streaming' });
    expect(a.busy).toBe(false);
    // The interrupted turn just ended; the CLI now processes a queued/steered message on its own.
    feed(a, streamEvent('text_delta'));
    expect(a.busy).toBe(true);
    const statuses = events.filter((e) => e.type === 'status');
    expect(statuses.at(-1)).toEqual({ type: 'status', status: 'running' });
  });

  it('marks busy on a bare assistant message while idle', () => {
    const { ctx, events } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    feed(a, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], model: 'claude-x' } });
    expect(a.busy).toBe(true);
    expect(events.filter((e) => e.type === 'status').at(-1)).toEqual({ type: 'status', status: 'running' });
  });

  it('does not double-emit running during a normal busy turn, and returns to idle at the result', () => {
    const { ctx, events } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    feed(a, streamEvent('thinking_delta', 'hmm'));
    feed(a, streamEvent('text_delta', 'hello'));
    feed(a, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], model: 'claude-x' } });
    const running = events.filter((e) => e.type === 'status' && e.status === 'running');
    expect(running).toHaveLength(1);
    feed(a, { type: 'result', subtype: 'success', duration_ms: 500 });
    expect(a.busy).toBe(false);
    expect(events.filter((e) => e.type === 'status').at(-1)).toEqual({ type: 'status', status: 'idle' });
  });

  it('a tool result user message does not flip idle to running', () => {
    const { ctx } = stubCtx();
    const a = new ClaudeAdapter(ctx);
    feed(a, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } });
    expect(a.busy).toBe(false);
  });
});