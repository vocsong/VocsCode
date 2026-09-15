/**
 * Two ways a Claude session's numbers were wrong whenever the model was not one Claude Code ships
 * prices for, or the turn fanned out to subagents.
 *
 * Spend: the CLI flags a model it cannot price as `costBasis: 'unknown'` and charges its own default
 * rate — $5/$25/$0.50 per Mtok — so a DeepSeek V4.1 Flash session that really cost $2.38 was
 * reported as $203. Turn length: `duration_ms` measures the CLI's own agent loop and drops the wall
 * time its subagents spend working, while the tokens counted for the turn (cumulative `modelUsage`)
 * include them, so one 343s turn with 153k output tokens read as 16,637 tok/s.
 *
 * Fixtures are the numbers a real session produced (22 turns, 3,143 tool calls, 8-13 parallel
 * subagents per turn). Regression coverage for "session spend stats are suspicious and the tok/s is
 * crazy".
 */
import type { AppSettings, ModelRef, ProviderConfig, SessionEvent, SessionMeta } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter } from '../src/main/harness/claude';

const ANTHROPIC: ProviderConfig = { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', hasApiKey: false, models: [], enabled: true };
const OPENCODE_GO: ProviderConfig = { id: 'opencode-go', kind: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', hasApiKey: false, models: [], enabled: true };

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
const DEEPSEEK: ModelRef = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
/** Wall-clock fixtures start here; 0 is the adapter's "no turn start observed" sentinel. */
const T0 = 1_752_600_000_000;

function settings(providers: ProviderConfig[]): AppSettings {
  return { claude: { runtime: 'auto', useProviderKey: false, settingSources: [] }, providers } as unknown as AppSettings;
}

function stubCtx(s: AppSettings, model: ModelRef | undefined, events: SessionEvent[]): HarnessContext {
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: '.', permissionMode: 'ask', model },
    cwd: '.',
    status: 'idle',
    harnessRef: {},
    usage: { ...ZERO_USAGE }
  };
  return {
    sessionId: 's1',
    session: () => meta,
    settings: () => s,
    runtime: { resolve: () => undefined },
    sessionDir: '.',
    permissionMode: () => 'ask' as const,
    effort: () => undefined,
    getApiKey: async () => 'sk-go',
    mcpServers: async () => [],
    ownedMcpIds: () => [],
    emit: (e: SessionEvent) => events.push(e),
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: () => {},
    updateMeta: () => {},
    log: () => {},
    readJson: async () => null,
    writeJson: async () => {}
  } as unknown as HarnessContext;
}

/** handle() is private; drive it directly with SDK-shaped messages. */
function feed(adapter: ClaudeAdapter, msg: Record<string, unknown>): void {
  (adapter as unknown as { handle: (m: unknown, q: unknown) => void }).handle(msg as never, null);
}

/** A turn the CLI started and the app watched, with no send(). */
const turnStarted = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } } };

function turnItem(events: SessionEvent[]): Extract<SessionEvent, { type: 'item.upsert' }>['item'] | undefined {
  return events
    .filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert' && e.item.kind === 'turn')
    .at(-1)?.item;
}

function lastUsage(events: SessionEvent[]): Extract<SessionEvent, { type: 'usage' }> | undefined {
  return events.filter((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage').at(-1);
}

/** The counters and cost a full DeepSeek V4.1 Flash session reported, priced at the CLI's default rate. */
const SESSION = {
  inputTokens: 2_830_944,
  outputTokens: 1_832_816,
  cacheReadInputTokens: 286_052_992,
  cacheCreationInputTokens: 0,
  costUSD: 203.0
};
/** $0.15 in / $0.60 out / $0.003 cache-read per Mtok, the catalog row for deepseek-v4.1-flash. */
const CATALOG_COST = 2.382490176;

afterEach(() => {
  vi.useRealTimers();
  queryMock.mockReset();
});

describe('Claude session spend accounting', () => {
  /** start() is the production path that fixes the provider for the process, and the provider is what
   *  decides whose catalog prices the model. */
  async function startedAdapter(providers: ProviderConfig[], model: ModelRef, events: SessionEvent[]): Promise<ClaudeAdapter> {
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, setModel: vi.fn(), close: vi.fn(), interrupt: vi.fn() });
    const adapter = new ClaudeAdapter(stubCtx(settings(providers), model, events));
    await adapter.start();
    return adapter;
  }

  it('prices a model the CLI could not price from the app catalog, not the CLI default rate', async () => {
    const events: SessionEvent[] = [];
    const adapter = await startedAdapter([ANTHROPIC, OPENCODE_GO], DEEPSEEK, events);
    feed(adapter, turnStarted);
    feed(adapter, {
      type: 'result',
      subtype: 'success',
      duration_ms: 300_000,
      total_cost_usd: SESSION.costUSD,
      usage: { input_tokens: 179_569, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'deepseek-v4.1-flash': { ...SESSION, contextWindow: 1_000_000, costBasis: 'unknown' } }
    });

    expect(lastUsage(events)?.totals.costUsd).toBeCloseTo(CATALOG_COST, 4);
    // The turn carries what the turn added, not the running total.
    const turn = turnItem(events);
    expect(turn?.kind === 'turn' && turn.costUsd).toBeCloseTo(CATALOG_COST, 4);
  });

  it('keeps the spend the CLI priced itself, on its own list or a managed rate', async () => {
    const events: SessionEvent[] = [];
    const adapter = await startedAdapter([ANTHROPIC, OPENCODE_GO], DEEPSEEK, events);
    feed(adapter, {
      type: 'result',
      subtype: 'success',
      duration_ms: 1000,
      total_cost_usd: 0.2,
      modelUsage: { 'claude-sonnet-5': { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.2, contextWindow: 200_000, costBasis: 'list' } }
    });
    expect(lastUsage(events)?.totals.costUsd).toBeCloseTo(0.2, 6);
  });

  it('leaves the CLI figure alone when the catalog has no row for the model either', async () => {
    const events: SessionEvent[] = [];
    const adapter = await startedAdapter([ANTHROPIC, OPENCODE_GO], DEEPSEEK, events);
    feed(adapter, {
      type: 'result',
      subtype: 'success',
      duration_ms: 1000,
      modelUsage: { 'mystery-model-9': { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 7.5, contextWindow: 100_000, costBasis: 'unknown' } }
    });
    expect(lastUsage(events)?.totals.costUsd).toBeCloseTo(7.5, 6);
  });

  it('still reports a result that carries no modelUsage at all', async () => {
    const events: SessionEvent[] = [];
    const adapter = await startedAdapter([ANTHROPIC, OPENCODE_GO], DEEPSEEK, events);
    feed(adapter, { type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 0.5 });
    expect(lastUsage(events)?.totals.costUsd).toBeCloseTo(0.5, 6);
  });
});

describe('Claude turn duration accounting', () => {
  it('reports the wall clock the app watched, not the CLI agent loop that stops before its subagents', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings([ANTHROPIC]), undefined, events));
    feed(adapter, turnStarted);
    vi.setSystemTime(T0 + 343_052);
    feed(adapter, {
      type: 'result',
      subtype: 'success',
      duration_ms: 9_199,
      total_cost_usd: 0.1,
      modelUsage: { 'claude-sonnet-5': { inputTokens: 179_569, outputTokens: 153_045, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1, contextWindow: 200_000 } }
    });

    const turn = turnItem(events);
    expect(turn?.kind === 'turn' && turn.durationMs).toBe(343_052);
    // The output speed the panel derives from that pair, over the session's own clock.
    const speed = turn?.kind === 'turn' ? ((turn.usage?.outputTokens ?? 0) / (turn.durationMs ?? 1)) * 1000 : 0;
    expect(speed).toBeCloseTo(446.1, 1);
  });

  it('falls back to the SDK duration when no turn start was observed', () => {
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings([ANTHROPIC]), undefined, events));
    feed(adapter, { type: 'result', subtype: 'success', duration_ms: 1_234, total_cost_usd: 0.1 });
    const turn = turnItem(events);
    expect(turn?.kind === 'turn' && turn.durationMs).toBe(1_234);
  });

  it('measures the next turn from its own start, not from the end of the last one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings([ANTHROPIC]), undefined, events));
    feed(adapter, turnStarted);
    vi.setSystemTime(T0 + 60_000);
    feed(adapter, { type: 'result', subtype: 'success', duration_ms: 9_000, total_cost_usd: 0.1 });
    vi.setSystemTime(T0 + 500_000); // idle between turns: the user reading the reply
    feed(adapter, turnStarted);
    vi.setSystemTime(T0 + 512_000);
    feed(adapter, { type: 'result', subtype: 'success', duration_ms: 9_000, total_cost_usd: 0.2 });

    const turns = events.filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert' && e.item.kind === 'turn');
    expect(turns.map((t) => (t.item.kind === 'turn' ? t.item.durationMs : 0))).toEqual([60_000, 12_000]);
  });
});
