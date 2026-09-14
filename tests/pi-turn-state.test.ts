/** Pi adapter turn-end state: pi reports turn failures via the assistant message's
 *  stopReason ('error'/'aborted'), not as a dedicated event, and agent_end can be
 *  followed by an automatic retry. Regression coverage for turns silently stopping
 *  halfway with the transcript showing "Turn complete". */
import type { SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { describe, expect, it } from 'vitest';
import { PiAdapter } from '../src/main/harness/pi';
import { toolCallFromItem } from '../src/main/analytics';

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

/**
 * Makes send() usable without spawning pi: a child handle satisfies the start guard, and the RPC
 * round-trips are stubbed so prompt/get_session_stats resolve immediately.
 */
function prime(adapter: PiAdapter): void {
  const priv = adapter as unknown as {
    child: unknown;
    extensionCapabilities: Set<string>;
    request: (type: string) => Promise<unknown>;
  };
  priv.child = {};
  // send() refuses to prompt unless both readiness capabilities were advertised.
  priv.extensionCapabilities = new Set(['approvals', 'tools']);
  priv.request = async (type: string) => (type === 'get_session_stats' ? { tokens: { input: 100, output: 40 }, cost: 0.02 } : {});
}

const turns = (events: SessionEvent[]): TranscriptItem[] =>
  events.filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert').map((e) => e.item as TranscriptItem).filter((i) => i.kind === 'turn');

describe('Pi adapter tool outcomes', () => {
  function toolResult(events: SessionEvent[], id: string) {
    return events.filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert')
      .map((e) => e.item).filter((i): i is Extract<TranscriptItem, { kind: 'tool' }> => i.kind === 'tool' && i.id === id).at(-1)!;
  }

  it('records correlated host denials separately from execution errors and never reports a write', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    for (const id of ['denied', 'failed', 'success']) feed(a, { type: 'tool_execution_start', toolCallId: id, toolName: 'write', args: { path: id + '.txt' } });
    feed(a, { type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'VCODE_TOOL_BLOCKED::' + JSON.stringify({ toolCallId: 'denied', toolName: 'write' }) });
    for (const id of ['denied', 'failed', 'success']) feed(a, { type: 'tool_execution_end', toolCallId: id, toolName: 'write', isError: id !== 'success', result: { content: [{ type: 'text', text: 'The user declined this action in Vocs Code.' }] } });
    expect(toolResult(events, 'denied')).toMatchObject({ status: 'declined' });
    expect(toolResult(events, 'denied').changes).toBeUndefined();
    expect(toolCallFromItem(toolResult(events, 'denied'))?.usage).toMatchObject({ calls: 1, declined: 1, errors: 0 });
    expect(toolResult(events, 'failed')).toMatchObject({ status: 'error' });
    expect(toolResult(events, 'failed').changes).toBeUndefined();
    expect(toolResult(events, 'success')).toMatchObject({ status: 'done', changes: [{ path: 'success.txt', kind: 'update' }] });
    // A duplicate terminal event cannot relabel the counted outcome.
    feed(a, { type: 'tool_execution_end', toolCallId: 'denied', toolName: 'write', isError: false, result: {} });
    expect(toolResult(events, 'denied').status).toBe('declined');
  });

  it('ignores unknown ids, wrong tool names and error text that resembles the protocol', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, { type: 'tool_execution_start', toolCallId: 'call', toolName: 'bash', args: { command: 'exit 1' } });
    for (const block of [{ toolCallId: 'missing', toolName: 'bash' }, { toolCallId: 'call', toolName: 'write' }]) {
      feed(a, { type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'VCODE_TOOL_BLOCKED::' + JSON.stringify(block) });
    }
    feed(a, { type: 'tool_execution_end', toolCallId: 'call', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'VCODE_TOOL_BLOCKED::{"toolCallId":"call","toolName":"bash"}' }] } });
    expect(toolResult(events, 'call').status).toBe('error');
  });

  it('links a host approval to its tool and records host cancellation as declined', async () => {
    const { ctx, events } = stubCtx();
    let linked: string | undefined;
    ctx.requestApproval = async (draft) => { linked = draft.toolItemId; return { optionId: 'deny' }; };
    const a = new PiAdapter(ctx);
    feed(a, { type: 'tool_execution_start', toolCallId: 'call', toolName: 'bash', args: { command: 'echo blocked' } });
    feed(a, { type: 'extension_ui_request', id: 'approval', method: 'select', title: 'VCODE_APPROVAL::' + JSON.stringify({ tool: 'bash', toolCallId: 'call', input: { command: 'echo blocked' } }) });
    await settle();
    feed(a, { type: 'tool_execution_end', toolCallId: 'call', toolName: 'bash', isError: true, result: {} });
    expect(linked).toBe('call');
    expect(toolResult(events, 'call').status).toBe('declined');
  });
});

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

  it('counts a completed turn sent through the normal send() path', async () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    prime(a);
    // send() sets turnStartedAt before pi emits agent_start; both turns must still be counted.
    await a.send({ text: 'one' });
    feed(a, { type: 'agent_start' });
    feed(a, { type: 'agent_end', messages: [] });
    await settle();
    await a.send({ text: 'two' });
    feed(a, { type: 'agent_start' });
    feed(a, { type: 'agent_end', messages: [] });
    await settle();
    const usages = events.filter((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usages.at(-1)?.totals.turns).toBe(2);
  });

  it('publishes streamed usage before turn completion and reconciles the final session total', async () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    prime(a);
    await a.send({ text: 'stream' });
    feed(a, { type: 'agent_start' });
    feed(a, { type: 'message_start', message: { role: 'assistant', content: [] } });
    feed(a, {
      type: 'message_update',
      usage: { input: 100, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 104, cost: { input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
    });
    const live = events.filter((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage').at(-1);
    expect(live?.totals).toMatchObject({ inputTokens: 100, outputTokens: 4, costUsd: 0.01, turns: 0 });

    // The provider's final stats include the rest of the response. The provisional streamed
    // sample must not be added a second time when that cumulative snapshot arrives.
    feed(a, {
      type: 'message_update',
      usage: { input: 100, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 108, cost: { input: 0, output: 0.015, cacheRead: 0, cacheWrite: 0, total: 0.015 } },
      assistantMessageEvent: { type: 'text_delta', delta: ' more' }
    });
    feed(a, { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 100, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.015 } } } });
    feed(a, { type: 'agent_end', messages: [] });
    await settle();
    const final = events.filter((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage').at(-1);
    expect(final?.totals).toMatchObject({ inputTokens: 100, outputTokens: 40, costUsd: 0.02, turns: 1 });
    await a.dispose();
  });

  it('does not report an epoch-long wall time when a turn ends with no recorded start', async () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    prime(a);
    // pi can emit agent_end on its own; without a start, duration must stay unknown, not Date.now().
    feed(a, { type: 'agent_end', messages: [] });
    await settle();
    const turn = turns(events).at(-1) as Extract<TranscriptItem, { kind: 'turn' }>;
    expect(turn.durationMs).toBeUndefined();
  });

  it('reports a failed compaction instead of a bogus compacted message', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, { type: 'compaction_end', aborted: false, result: null, errorMessage: 'Compaction failed: quota exceeded' });
    const infos = events.filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert').map((e) => e.item as Extract<TranscriptItem, { kind: 'info' }>).filter((i) => i.kind === 'info');
    expect(infos.at(-1)?.text).toBe('Compaction failed: quota exceeded');
  });
});

describe('Pi adapter subagent reporting', () => {
  it('records a background completion once, as an analytics event and a transcript note', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    const details = { id: 'a1', description: 'Find things', status: 'completed', toolUses: 37, totalTokens: 51127, totalCost: 0.1558, durationMs: 1000 };
    feed(a, { type: 'message_end', message: { role: 'custom', customType: 'subagent-notification', details } });
    const sub = events.find((e): e is Extract<SessionEvent, { type: 'subagent' }> => e.type === 'subagent');
    expect(sub?.completion).toMatchObject({ agentId: 'a1', status: 'completed', toolUses: 37, costUsd: 0.1558, tokens: 51127 });
    expect(events.some((e) => e.type === 'item.upsert' && e.item.kind === 'info' && /Find things/.test(e.item.text))).toBe(true);
    // The same run reported again (e.g. by get_subagent_result) must not be counted twice.
    feed(a, { type: 'message_end', message: { role: 'custom', customType: 'subagent-notification', details } });
    expect(events.filter((e) => e.type === 'subagent')).toHaveLength(1);
  });

  it('records a group notification for every run it carries', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, {
      type: 'message_end',
      message: { role: 'custom', customType: 'subagent-notification', details: { id: 'g1', status: 'completed', toolUses: 1, others: [{ id: 'g2', status: 'error', toolUses: 2 }] } }
    });
    expect(events.filter((e) => e.type === 'subagent').map((e) => (e as Extract<SessionEvent, { type: 'subagent' }>).completion.agentId)).toEqual(['g1', 'g2']);
  });

  it('records a foreground Agent result and ignores a background spawn placeholder', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    feed(a, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'Agent', args: {} });
    feed(a, { type: 'tool_execution_end', toolCallId: 't1', toolName: 'Agent', isError: false, result: { content: [{ type: 'text', text: 'spawned' }], details: { agentId: 'bg', status: 'background', toolUses: 0 } } });
    expect(events.some((e) => e.type === 'subagent')).toBe(false);
    feed(a, { type: 'tool_execution_start', toolCallId: 't2', toolName: 'Agent', args: {} });
    feed(a, { type: 'tool_execution_end', toolCallId: 't2', toolName: 'Agent', isError: false, result: { content: [{ type: 'text', text: 'done' }], details: { agentId: 'fg', modelName: 'claude haiku 4.5', status: 'completed', toolUses: 5, cost: 0.02 } } });
    expect(events.find((e): e is Extract<SessionEvent, { type: 'subagent' }> => e.type === 'subagent')?.completion).toMatchObject({ agentId: 'fg', toolUses: 5, costUsd: 0.02 });
  });

  it('attributes a subagent that reports a qualified name to that provider, not to the first model with the same id', () => {
    const { ctx, events } = stubCtx();
    const a = new PiAdapter(ctx);
    // One slug offered by two providers — an aggregator and the vendor itself. The wrong one is
    // listed first, so a fuzzy pass alone would attribute the run (and its spend) to the wrong
    // provider; only an exact match on the qualified name routes it correctly.
    (a as unknown as { models: unknown[] }).models = [
      { id: 'claude-opus-5', provider: 'openrouter', displayName: 'Claude Opus 5' },
      { id: 'claude-opus-5', provider: 'anthropic', displayName: 'Claude Opus 5' }
    ];
    feed(a, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'Agent', args: {} });
    feed(a, {
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'Agent',
      isError: false,
      result: { content: [{ type: 'text', text: 'done' }], details: { agentId: 'fg', modelName: 'anthropic/claude-opus-5', status: 'completed', toolUses: 3, cost: 0.02 } }
    });
    const sub = events.find((e): e is Extract<SessionEvent, { type: 'subagent' }> => e.type === 'subagent');
    expect(sub?.completion.model).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    // The same route the user reads on the subagent's info line.
    expect(events.some((e) => e.type === 'item.upsert' && e.item.kind === 'info' && e.item.text.includes('anthropic/claude-opus-5'))).toBe(true);
  });
});
