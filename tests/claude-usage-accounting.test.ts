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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncQueue, deferred } from '../src/main/util/async';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { ClaudeAdapter } from '../src/main/harness/claude';

const ANTHROPIC: ProviderConfig = { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', hasApiKey: false, models: [], enabled: true };
const OPENCODE_GO: ProviderConfig = { id: 'opencode-go', kind: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', hasApiKey: false, models: [], enabled: true };
/** OpenRouter names GLM by vendor, and this row exists in no bundled catalog — only in the provider's own. */
const OPENROUTER: ProviderConfig = {
  id: 'openrouter',
  kind: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  hasApiKey: false,
  enabled: true,
  models: [{ id: 'z-ai/glm-5.3-flash', provider: 'openrouter', displayName: 'GLM 5.3 Flash', contextWindow: 1_000_000, pricing: { input: 0.075, output: 0.25, cacheRead: 0.015 } }]
};

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };
const DEEPSEEK: ModelRef = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' };
const GLM: ModelRef = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' };
/** What Claude Code charges for a model it has no row for: $5/$25/$0.50 per Mtok. */
const GLM_CLI_USD = (1_000_000 * 5 + 200_000 * 25 + 20_000_000 * 0.5) / 1_000_000;
/** What the endpoint's own rates make the same tokens worth. */
const GLM_LIVE_USD = (1_000_000 * 0.075 + 200_000 * 0.25 + 20_000_000 * 0.015) / 1_000_000;
/** Wall-clock fixtures start here; 0 is the adapter's "no turn start observed" sentinel. */
const T0 = 1_752_600_000_000;

function settings(providers: ProviderConfig[]): AppSettings {
  return { claude: { runtime: 'auto', useProviderKey: false, settingSources: [] }, providers } as unknown as AppSettings;
}

function stubCtx(s: AppSettings, model: ModelRef | undefined, events: SessionEvent[], overrides: Partial<SessionMeta> = {}): HarnessContext {
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'claude', projectRoot: '.', permissionMode: 'ask', model },
    cwd: '.',
    status: 'idle',
    harnessRef: {},
    ...overrides,
    usage: { ...ZERO_USAGE, ...overrides.usage }
  };
  return {
    sessionId: 's1',
    session: () => meta,
    settings: () => s,
    runtime: { resolve: () => ({ path: process.execPath, source: 'system' }) },
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

  it('prices a gateway-only model from the endpoint catalog that knows it', async () => {
    // The model's id carries the vendor, so nothing in the bundled catalogs resolves it and the CLI
    // falls back to its own default rate — $20 here where the endpoint charges $0.425. The row is in
    // the provider's cached models, which is the only place it has ever existed.
    const events: SessionEvent[] = [];
    const adapter = await startedAdapter([ANTHROPIC, OPENROUTER], GLM, events);
    feed(adapter, turnStarted);
    feed(adapter, {
      type: 'result',
      subtype: 'success',
      duration_ms: 60_000,
      usage: { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { 'z-ai/glm-5.3-flash': { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadInputTokens: 20_000_000, cacheCreationInputTokens: 0, costUSD: GLM_CLI_USD, contextWindow: 1_000_000, costBasis: 'unknown' } }
    });

    const turn = turnItem(events);
    expect(turn?.kind === 'turn' ? turn.costUsd : undefined).toBeCloseTo(GLM_LIVE_USD, 9);
    expect(lastUsage(events)?.totals.costUsd).toBeCloseTo(GLM_LIVE_USD, 9);
  });

  it('accounts for an exact gateway context variant at its own rate, not its base rate', async () => {
    const base = 'anthropic/claude-sonnet-5';
    const model = `${base}[1m]`;
    const provider: ProviderConfig = {
      ...OPENROUTER,
      models: [
        { id: base, provider: 'openrouter', displayName: 'Base', pricing: { input: 2, output: 10 } },
        { id: model, provider: 'openrouter', displayName: 'Variant', pricing: { input: 3, output: 15, cacheRead: 0.4, cacheWrite: 4 } }
      ]
    };
    const events: SessionEvent[] = [];
    const adapter = await startedAdapter([ANTHROPIC, provider], { provider: provider.id, model }, events);
    try {
      feed(adapter, turnStarted);
      feed(adapter, {
        type: 'result',
        subtype: 'success',
        duration_ms: 1_000,
        modelUsage: {
          [model]: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 100_000, costUSD: 11.625, contextWindow: 1_000_000, costBasis: 'unknown' }
        }
      });

      // $3 input + $3 output + $0.80 cache read + $0.40 cache write, not the base row's $4.65.
      const turns = events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn');
      expect(turns).toHaveLength(1);
      expect(turnItem(events)).toMatchObject({ kind: 'turn', status: 'completed', costUsd: 7.2 });
      expect(lastUsage(events)?.totals).toMatchObject({ inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000, costUsd: 7.2, turns: 1 });
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
    } finally {
      await adapter.dispose();
    }
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

describe('Claude process lifecycle accounting', () => {
  /** One CLI process's cumulative counters for the session's model, priced by the CLI's own default
   *  rate because it has no row for it — the catalog's rate is what the totals end up carrying. */
  function result(inputTokens: number, outputTokens: number): Record<string, unknown> {
    return {
      type: 'result',
      subtype: 'success',
      duration_ms: 1_000,
      modelUsage: {
        'deepseek-v4.1-flash': {
          inputTokens,
          outputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: (inputTokens * 5 + outputTokens * 25) / 1_000_000,
          contextWindow: 1_000_000,
          costBasis: 'unknown'
        }
      }
    };
  }

  /** An adapter over a session that has already recorded work, the way a resume finds it. */
  function newAdapter(events: SessionEvent[], meta: Partial<SessionMeta> = {}): ClaudeAdapter {
    queryMock.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, setModel: vi.fn(), close: vi.fn(), interrupt: vi.fn() });
    return new ClaudeAdapter(stubCtx(settings([ANTHROPIC, OPENCODE_GO]), DEEPSEEK, events, meta));
  }

  const turnRows = (events: SessionEvent[]): Extract<SessionEvent, { type: 'item.upsert' }>[] =>
    events.filter((e): e is Extract<SessionEvent, { type: 'item.upsert' }> => e.type === 'item.upsert' && e.item.kind === 'turn');

  it('counts the first turn of a resumed process, whose counters restart at zero', async () => {
    const before: SessionEvent[] = [];
    const first = newAdapter(before);
    await first.start();
    feed(first, turnStarted);
    feed(first, result(1_000_000, 1_000));
    // $0.15 in / $0.60 out per Mtok: the catalog's rate for that process's counters.
    const recorded = lastUsage(before)!.totals;
    expect(recorded.costUsd).toBeCloseTo(0.1506, 9);

    // The resume: a new CLI process, whose first result reports only what that process spent, so
    // every counter arrives below what the session already holds. `meta.usage` is what the store
    // would have written for the session after the first process.
    const after: SessionEvent[] = [];
    const second = newAdapter(after, { usage: recorded });
    await second.start();
    feed(second, turnStarted);
    feed(second, result(100_000, 100));

    const turn = turnItem(after);
    expect(turn?.kind === 'turn' ? turn.costUsd : undefined).toBeCloseTo(0.01506, 9);
    expect(turn?.kind === 'turn' ? turn.usage?.inputTokens : undefined).toBe(100_000);
    expect(lastUsage(after)?.totals).toMatchObject({ inputTokens: 1_100_000, outputTokens: 1_100 });
    expect(lastUsage(after)?.totals.costUsd).toBeCloseTo(0.16566, 9);
  });

  it('closes a turn the process ended in the middle of, so its usage lands in the ledger too', async () => {
    const events: SessionEvent[] = [];
    const adapter = new ClaudeAdapter(stubCtx(settings([ANTHROPIC, OPENCODE_GO]), DEEPSEEK, events));
    feed(adapter, turnStarted);
    // The response streams its counters and then the process goes away: no `result` is ever coming.
    feed(adapter, { type: 'stream_event', event: { type: 'message_start', message: { model: 'deepseek-v4.1-flash', usage: { input_tokens: 1_000, output_tokens: 10 } } } });
    feed(adapter, { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });

    await adapter.dispose();

    const turn = turnItem(events);
    expect(turn?.kind === 'turn' && turn.status).toBe('interrupted');
    // Tokens included: left open they belong to no row, and the headline spend reads higher than
    // the turns under it until the next turn silently absorbs them.
    expect(turn?.kind === 'turn' ? turn.usage : undefined).toEqual({ inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(lastUsage(events)?.totals).toMatchObject({ inputTokens: 1_000, outputTokens: 40, turns: 1 });
  });

  it('emits no second turn for work a `result` already closed', async () => {
    const events: SessionEvent[] = [];
    const adapter = newAdapter(events);
    await adapter.start();
    feed(adapter, turnStarted);
    feed(adapter, result(1_000_000, 1_000));
    expect(turnRows(events)).toHaveLength(1);

    await adapter.dispose();

    // Closing a turn that already ended would charge the session twice for the same work.
    expect(turnRows(events)).toHaveLength(1);
    expect(lastUsage(events)?.totals).toMatchObject({ turns: 1 });
    expect(lastUsage(events)?.totals.costUsd).toBeCloseTo(0.1506, 9);
  });
});

describe('Claude subscription observation', () => {
  const init = { type: 'system', subtype: 'init', session_id: 'sdk1', apiKeySource: 'none' };
  const account = { apiProvider: 'firstParty', subscriptionType: 'Claude Max' };
  const sample = (info: Record<string, unknown> = {}) => ({
    type: 'rate_limit_event', session_id: 'sdk1',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.25, resetsAt: T0 / 1_000 + 120, ...info }
  });

  async function open(s = settings([ANTHROPIC]), meta: Partial<SessionMeta> = {}) {
    const events: SessionEvent[] = [];
    const ctx = { ...stubCtx(s, undefined, events, meta), updateMeta: vi.fn(), updateRef: vi.fn(), log: vi.fn() };
    const frames = new AsyncQueue<{ message: object; handled(): void } | Error>();
    const sdk = {
      async *[Symbol.asyncIterator]() {
        for await (const frame of frames) {
          if (frame instanceof Error) throw frame;
          yield frame.message;
          frame.handled();
        }
      },
      close: () => frames.close(),
      accountInfo: vi.fn().mockResolvedValue(account),
      supportedModels: vi.fn().mockResolvedValue([]),
      supportedCommands: vi.fn().mockResolvedValue([]),
      getUsage: vi.fn(), getSettings: vi.fn(), applyFlagSettings: vi.fn(), streamInput: vi.fn()
    };
    queryMock.mockReturnValueOnce(sdk);
    const adapter = new ClaudeAdapter(ctx);
    expect(adapter.observedSubscriptionWindows()).toEqual([]);
    await adapter.start();
    return { adapter, sdk, events, ctx, frames, emit: (message: object) => new Promise<void>((handled) => frames.push({ message, handled })) };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    for (const key of [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_UNIX_SOCKET',
      'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
      '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL'
    ]) vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('observes ordinary turns only, without touching the normalized stream or querying the provider', async () => {
    const { adapter, sdk, emit, events, ctx } = await open();
    try {
      await emit(sample()); // An event without an ordinary turn's init is not enough.
      expect(sdk.accountInfo).not.toHaveBeenCalled();
      await emit(init);
      await emit(turnStarted);
      const count = events.length;
      const sideEffects = [ctx.updateMeta, ctx.updateRef, ctx.log].map((fn) => fn.mock.calls.length);
      await emit(sample());
      await emit(sample({ rateLimitType: 'seven_day', utilization: 1, resetsAt: T0 / 1_000 + 3_600 }));
      const windows = adapter.observedSubscriptionWindows();
      expect(windows).toEqual([
        { name: '5-hour limit', remainingFraction: 0.75, resetAt: new Date(T0 + 120_000).toISOString(), observedAt: T0, expiresAt: T0 + 120_000 },
        { name: 'Weekly limit', remainingFraction: 0, resetAt: new Date(T0 + 3_600_000).toISOString(), observedAt: T0, expiresAt: T0 + 600_000 }
      ]);
      windows[0]!.remainingFraction = 0;
      expect(adapter.observedSubscriptionWindows()[0]?.remainingFraction).toBe(0.75);
      expect(events).toHaveLength(count);
      expect([ctx.updateMeta, ctx.updateRef, ctx.log].map((fn) => fn.mock.calls.length)).toEqual(sideEffects);
      expect(ctx.session().usage).toEqual(ZERO_USAGE);
      expect(sdk.accountInfo).toHaveBeenCalledOnce();
      expect(queryMock).toHaveBeenCalledOnce();
      for (const fn of [sdk.getUsage, sdk.getSettings, sdk.applyFlagSettings, sdk.streamInput]) expect(fn).not.toHaveBeenCalled();
      expect(queryMock.mock.calls[0]?.[0].prompt.size).toBe(0);
      await emit({ type: 'result', subtype: 'success', duration_ms: 1_000, total_cost_usd: 0.25 });
      expect(lastUsage(events)?.totals).toEqual({ ...ZERO_USAGE, turns: 1, costUsd: 0.25 });
      expect(adapter.observedSubscriptionWindows()).toHaveLength(2);
      vi.setSystemTime(T0 + 120_000);
      expect(adapter.observedSubscriptionWindows().map((w) => w.name)).toEqual(['Weekly limit']);
      vi.setSystemTime(T0 + 600_000);
      expect(adapter.observedSubscriptionWindows()).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  it.each([
    { name: 'configured gateway', providers: [{ ...ANTHROPIC, baseUrl: 'https://gateway.example.test' }] },
    { name: 'app key route', useProviderKey: true },
    { name: 'effective custom endpoint', env: ['ANTHROPIC_BASE_URL', 'https://api.anthropic.com.example.test'] },
    { name: 'inherited API key', env: ['ANTHROPIC_API_KEY', 'test-api-key'] },
    { name: 'inherited bearer', env: ['ANTHROPIC_AUTH_TOKEN', 'test-bearer'] },
    { name: 'other cloud', env: ['CLAUDE_CODE_USE_BEDROCK', '1'] },
    { name: 'CLI-managed key', apiKeySource: '/login managed key' }
  ])('refuses $name despite a subscription-shaped event', async ({ providers, useProviderKey, env, apiKeySource }) => {
    if (env) vi.stubEnv(env[0]!, env[1]);
    const s = settings(providers ?? [ANTHROPIC]);
    s.claude.useProviderKey = useProviderKey ?? false;
    const { adapter, sdk, emit } = await open(s);
    try {
      await emit({ ...init, apiKeySource: apiKeySource ?? init.apiKeySource });
      await emit(sample());
      expect(adapter.observedSubscriptionWindows()).toEqual([]);
      expect(sdk.accountInfo).not.toHaveBeenCalled();
    } finally {
      await adapter.dispose();
    }
  });

  it.each(['gateway', 'vertex', undefined])('requires cached first-party account provenance (got %s)', async (apiProvider) => {
    const { adapter, sdk, emit } = await open();
    try {
      sdk.accountInfo.mockResolvedValue({ ...account, apiProvider });
      await emit(init);
      await emit(sample());
      expect(sdk.accountInfo).toHaveBeenCalledOnce();
      expect(adapter.observedSubscriptionWindows()).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  it('rejects malformed, model-specific, and extra-usage samples', async () => {
    const { adapter, emit } = await open();
    try {
      await emit(init);
      for (const info of [
        { utilization: Number.NaN }, { utilization: 1.1 }, { utilization: -0.01 }, { utilization: undefined },
        { resetsAt: T0 }, { resetsAt: T0 / 1_000 }, { resetsAt: Infinity },
        { rateLimitType: 'seven_day_opus' }, { rateLimitType: 'overage' }, { rateLimitType: 'seven_day_overage_included' },
        { isUsingOverage: true }, { overageInUse: true }
      ]) {
        await emit(sample(info));
        expect(adapter.observedSubscriptionWindows()).toEqual([]);
      }
      await emit(sample({ status: 'allowed', utilization: 0, resetsAt: undefined }));
      expect(adapter.observedSubscriptionWindows()).toEqual([{
        name: '5-hour limit', remainingFraction: 1, observedAt: T0, expiresAt: T0 + 600_000
      }]);
      await emit(sample({ utilization: undefined }));
      expect(adapter.observedSubscriptionWindows()).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  it.each(['stopped', 'error', 'disposed'] as const)('forgets observations when the Query is %s', async (ending) => {
    const { adapter, emit, events, frames } = await open();
    try {
      await emit(init);
      await emit(sample({}));
      expect(adapter.observedSubscriptionWindows()).toHaveLength(1);
      if (ending === 'disposed') {
        const late = emit(sample({ utilization: 0.1 }));
        await adapter.dispose();
        await late;
      } else {
        if (ending === 'error') frames.push(new Error('mock stream failure'));
        else frames.close();
        await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'status', status: ending }));
      }
      expect(adapter.observedSubscriptionWindows()).toEqual([]);
    } finally {
      if (ending !== 'disposed') await adapter.dispose();
    }
  });

  it('never carries observations across a session id change or new Query, even with a pending account check', async () => {
    const first = await open();
    const pending = deferred<typeof account>();
    first.sdk.accountInfo.mockReturnValue(pending.promise);
    await first.emit(init);
    await first.emit(sample());
    expect(first.adapter.observedSubscriptionWindows()).toEqual([]);
    await first.emit({ ...init, session_id: 'sdk2' });
    pending.resolve(account);
    await first.emit(sample()); // The old id's event is late.
    expect(first.adapter.observedSubscriptionWindows()).toEqual([]);
    await first.emit({ ...sample(), session_id: 'sdk2' });
    expect(first.adapter.observedSubscriptionWindows()).toHaveLength(1);
    await first.adapter.dispose();
    const resumed = await open(settings([ANTHROPIC]), { harnessRef: { claudeSessionId: 'sdk2' } });
    try {
      await resumed.emit({ ...init, session_id: 'sdk2' });
      expect(resumed.adapter.observedSubscriptionWindows()).toEqual([]);
    } finally {
      await resumed.adapter.dispose();
    }
  });
});
