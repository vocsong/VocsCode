import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_COMPACTION_PRESETS,
  autoCompactionTokenThreshold,
  hasReachedAutoCompactionThreshold,
} from '../src/shared/compaction';
import type { AppSettings, SessionEvent, SessionMeta, UsageTotals } from '../src/shared/types';
import { defaultSettings, normalizeSettings } from '../src/main/settings';
import { fetchProviderModels } from '../src/main/models/providers';
import { enrichModelContextWindows } from '../src/main/models/static-models';
import { SessionManager } from '../src/main/session-manager';
import { ClaudeAdapter, claudeModelToInfo } from '../src/main/harness/claude';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SettingsStore } from '../src/main/settings';
import type { SessionStore } from '../src/main/store';

const usage = (contextTokens: number, contextWindow?: number): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  turns: 1,
  contextTokens,
  contextWindow,
});

const settleMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('automatic compaction thresholds', () => {
  it('normalizes every preset and rejects malformed persisted values', () => {
    for (const preset of AUTO_COMPACTION_PRESETS) {
      expect(normalizeSettings({ autoCompactionThreshold: preset.value }).autoCompactionThreshold).toBe(preset.value);
    }
    expect(defaultSettings().autoCompactionThreshold).toBeUndefined();
    expect(normalizeSettings({ autoCompactionThreshold: '95%' as never }).autoCompactionThreshold).toBeUndefined();
  });

  it('supports model-relative percentages and absolute token thresholds', () => {
    expect(autoCompactionTokenThreshold('50%', usage(0, 200_000))).toBe(100_000);
    expect(hasReachedAutoCompactionThreshold('75%', usage(149_999, 200_000))).toBe(false);
    expect(hasReachedAutoCompactionThreshold('75%', usage(150_000, 200_000))).toBe(true);
    expect(hasReachedAutoCompactionThreshold('50%', usage(900_000))).toBe(false);
    expect(hasReachedAutoCompactionThreshold('500k', usage(500_000))).toBe(true);
  });

  it('requests compaction once per crossing and re-arms below the threshold', async () => {
    const fixture = compactionFixture('50%');

    fixture.emit({ type: 'usage', totals: usage(100_000, 200_000) });
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.transcript.map((item) => (item.kind === 'info' ? item.text : '')).join('\n')).toContain('50% of context window');

    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(1);

    fixture.emit({ type: 'status', status: 'running' });
    fixture.emit({ type: 'usage', totals: usage(90_000, 200_000) });
    fixture.emit({ type: 'usage', totals: usage(120_000, 200_000) });
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(2);
  });

  it('waits for queued follow-ups before requesting compaction', async () => {
    const fixture = compactionFixture('100k');
    fixture.session.queued = 1;
    fixture.emit({ type: 'usage', totals: usage(125_000) });
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).not.toHaveBeenCalled();

    fixture.session.queued = 0;
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(1);
  });

  it('holds a new turn until asynchronous compaction settles', async () => {
    let finish: () => void = () => undefined;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fixture = compactionFixture('100k', () => operation);
    fixture.emit({ type: 'usage', totals: usage(125_000) });
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();

    const sending = fixture.manager.send(fixture.session.id, { text: 'next turn' });
    await settleMicrotasks();
    expect(fixture.send).not.toHaveBeenCalled();
    finish();
    await sending;
    expect(fixture.send).toHaveBeenCalledWith({ text: 'next turn' });
  });

  it('retries a no-op compaction after more history is available', async () => {
    const fixture = compactionFixture('100k', async () => false);
    fixture.emit({ type: 'usage', totals: usage(125_000) });
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(1);

    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    if (fixture.active.autoCompactionRetryTimer) clearTimeout(fixture.active.autoCompactionRetryTimer);
    fixture.active.autoCompactionRetryTimer = null;
    fixture.active.autoCompactionRetryAt = 0;
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(2);
  });

  it('reevaluates automatically when a no-op backoff expires', async () => {
    vi.useFakeTimers();
    const results: Array<boolean | undefined> = [false, undefined];
    const fixture = compactionFixture('100k', async () => results.shift());
    try {
      fixture.emit({ type: 'usage', totals: usage(125_000) });
      fixture.emit({ type: 'status', status: 'idle' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.compact).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.compact).toHaveBeenCalledTimes(2);
    } finally {
      if (fixture.active.autoCompactionRetryTimer) clearTimeout(fixture.active.autoCompactionRetryTimer);
      vi.useRealTimers();
    }
  });

  it('reports a failed automatic request and backs off instead of looping', async () => {
    const fixture = compactionFixture('100k', async () => {
      throw new Error('quota exceeded');
    });
    fixture.emit({ type: 'usage', totals: usage(125_000) });
    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(1);
    expect(fixture.active.autoCompactionLatched).toBe(false);
    expect(fixture.active.autoCompactionRetryAt).toBeGreaterThan(Date.now());
    expect(fixture.active.autoCompactionRetryTimer).not.toBeNull();
    expect(fixture.transcript.some((item) => item.kind === 'info' && item.text.includes('quota exceeded'))).toBe(true);

    fixture.emit({ type: 'status', status: 'idle' });
    await settleMicrotasks();
    expect(fixture.compact).toHaveBeenCalledTimes(1);
  });
});

describe('adapter compaction coordination', () => {
  it('does not resolve until Claude reports that manual compaction finished', async () => {
    const adapter = new ClaudeAdapter({ emit: vi.fn() } as unknown as HarnessContext);
    (adapter as unknown as { q: object }).q = {};
    let settled = false;
    const compacting = adapter.compact().then(() => {
      settled = true;
    });
    await settleMicrotasks();
    expect(settled).toBe(false);

    (adapter as unknown as { handle: (message: unknown, query: unknown) => void }).handle(
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 150_000, post_tokens: 30_000 } },
      {},
    );
    await compacting;
    expect(settled).toBe(true);
  });

  it('does not resolve until Codex emits thread/compacted', async () => {
    const adapter = new CodexAppServerAdapter({
      emit: vi.fn(),
      session: () => ({ usage: usage(0) }),
    } as unknown as HarnessContext);
    const notifications = new Map<string, (params: unknown) => void>();
    const request = vi.fn(async () => ({}));
    const rpc = {
      request,
      onNotification: (method: string, handler: (params: unknown) => void) => notifications.set(method, handler),
    };
    (adapter as unknown as { rpc: object; threadId: string }).rpc = rpc;
    (adapter as unknown as { threadId: string }).threadId = 'thread-1';
    (adapter as unknown as { wireNotifications: (client: object) => void }).wireNotifications(rpc);

    let settled = false;
    const compacting = adapter.compact().then(() => {
      settled = true;
    });
    await settleMicrotasks();
    expect(request).toHaveBeenCalledWith('thread/compact/start', { threadId: 'thread-1' });
    expect(settled).toBe(false);
    notifications.get('thread/compacted')?.({ threadId: 'thread-1' });
    await compacting;
    expect(settled).toBe(true);
  });
});

describe('model context metadata', () => {
  it('uses Claude canonical model ids to enrich selectable aliases', () => {
    const model = claudeModelToInfo({ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' });
    expect(model.id).toBe('sonnet');
    expect(model.contextWindow).toBe(1_000_000);
  });

  it('preserves reported limits, fills known snapshots, and leaves unknown catalogs honest', () => {
    const providers = defaultSettings().providers;
    const models = enrichModelContextWindows(
      [
        { id: 'claude-opus-5-20260101', provider: 'anthropic', displayName: 'Claude snapshot' },
        { id: 'gpt-5.4-2026-01-01', provider: 'openai', displayName: 'GPT snapshot' },
        { id: 'gpt-5.4-128k', provider: 'openai', displayName: 'Different context variant' },
        { id: 'custom', provider: 'openai', displayName: 'Custom', contextWindow: 64_000 },
        { id: 'auto', provider: 'cursor', displayName: 'Auto' },
      ],
      providers,
    );
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[1].contextWindow).toBe(272_000);
    expect(models[2].contextWindow).toBeUndefined();
    expect(models[3].contextWindow).toBe(64_000);
    expect(models[4].contextWindow).toBeUndefined();
  });

  it('reads common context fields from OpenAI-compatible model catalogs', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'local-chat', object: 'model', created: 0, owned_by: 'local', context_length: 131_072 },
        { id: 'vllm-chat', object: 'model', created: 0, owned_by: 'local', max_model_len: 32_768 },
      ] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const models = await fetchProviderModels(
        { id: 'local', kind: 'openai-compatible', name: 'Local', baseUrl: `http://127.0.0.1:${port}/v1`, hasApiKey: false, models: [], enabled: true },
        undefined,
      );
      expect(models).toHaveLength(2);
      expect(models[0].contextWindow).toBe(131_072);
      expect(models[1].contextWindow).toBe(32_768);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

function compactionFixture(
  threshold: AppSettings['autoCompactionThreshold'],
  compactImpl: () => Promise<boolean | void> = async () => undefined,
) {
  const settings = { ...defaultSettings(), autoCompactionThreshold: threshold };
  const session: SessionMeta = {
    id: 'compact-session',
    title: 'Compact session',
    createdAt: 1,
    updatedAt: 1,
    config: { harness: 'native', projectRoot: 'G:/project', permissionMode: 'ask' },
    cwd: 'G:/project',
    status: 'running',
    harnessRef: {},
    usage: usage(0),
    queued: 0,
  };
  const transcript: Extract<SessionEvent, { type: 'item.upsert' }>['item'][] = [];
  const compact = vi.fn(compactImpl);
  const send = vi.fn(async () => undefined);
  const adapter: HarnessAdapter = {
    id: 'native',
    busy: false,
    start: vi.fn(async () => undefined),
    send,
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setEffort: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    compact,
    dispose: vi.fn(async () => undefined),
  };
  const store = {
    list: () => [session],
    get: (id: string) => (id === session.id ? session : undefined),
    upsert: vi.fn(async () => undefined),
    appendTranscript: vi.fn(async (_id: string, item: (typeof transcript)[number]) => {
      transcript.push(item);
    }),
  } as unknown as SessionStore;
  const manager = new SessionManager({
    store,
    settings: { get: () => settings } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn(),
  });
  const active = {
    adapter,
    approvals: new Map(),
    liveItems: new Map(),
    dirty: new Set<string>(),
    lastAssistantText: '',
    starting: null,
    models: null,
    autoCompactionThreshold: undefined,
    autoCompactionLatched: false,
    autoCompactionRetryAt: 0,
    autoCompactionRetryTimer: null,
    compactionInFlight: null,
  };
  (manager as unknown as { active: Map<string, typeof active> }).active.set(session.id, active);
  const emit = (event: SessionEvent) => (manager as unknown as { emit: (id: string, value: SessionEvent) => void }).emit(session.id, event);
  return { active, compact, emit, manager, send, session, transcript };
}
