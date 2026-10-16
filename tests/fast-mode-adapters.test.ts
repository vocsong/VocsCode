import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexOptions } from '@openai/codex-sdk';
import type { HarnessContext } from '../src/main/harness/types';
import type { HarnessId, ModelRef, ProviderConfig, SessionEvent, SessionMeta } from '../src/shared/types';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import { AsyncQueue, deferred } from '../src/main/util/async';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), flags: vi.fn(), interrupt: vi.fn(), request: vi.fn(), spawn: vi.fn(),
  codex: vi.fn(), startThread: vi.fn(), resumeThread: vi.fn(), runStreamed: vi.fn(),
  openai: vi.fn(), anthropic: vi.fn(), notifications: new Map<string, (p: unknown) => void>()
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor(options: CodexOptions) { mocks.codex(options); }
  startThread(options: unknown) { return mocks.startThread(options); }
  resumeThread(id: string, options: unknown) { return mocks.resumeThread(id, options); }
} }));
vi.mock('../src/main/harness/spawn', () => ({ spawnTool: mocks.spawn }));
vi.mock('../src/main/harness/jsonrpc', () => ({ JsonRpcStdioClient: class {
  request = mocks.request;
  onNotification(method: string, cb: (p: unknown) => void) { mocks.notifications.set(method, cb); }
  onServerRequest() {}
  async close() {}
} }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: mocks.openai } }; } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { stream: mocks.anthropic }; } }));

import { ClaudeAdapter } from '../src/main/harness/claude';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { CodexExecAdapter } from '../src/main/harness/codex-exec';
import { NativeAdapter } from '../src/main/harness/native';
import { anthropicStep, openaiStep, type StepParams } from '../src/main/harness/native/drivers';

const OPENAI: ProviderConfig = { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', hasApiKey: true, enabled: true, models: [] };
const ANTHROPIC: ProviderConfig = { ...OPENAI, id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' };
const GPT: ModelRef = { provider: 'openai', model: 'gpt-5.4' };
const OPUS: ModelRef = { provider: 'anthropic', model: 'claude-opus-4-8' };
let messages: AsyncQueue<Record<string, unknown>>;
const adapters: { dispose(): Promise<void> }[] = [];

function fixture(harness: HarnessId, fastMode?: boolean, model = harness === 'claude' ? OPUS : GPT, providers = [OPENAI, ANTHROPIC]) {
  const settings = defaultSettings();
  settings.claude.settingSources = [];
  settings.providers = providers;
  const meta: SessionMeta = {
    id: 'fast-session', title: 'Fast mode', cwd: process.cwd(), createdAt: 1, updatedAt: 1,
    config: { harness, projectRoot: process.cwd(), permissionMode: 'ask', model, ...(fastMode === undefined ? {} : { fastMode }) },
    status: 'idle', harnessRef: {}, usage: emptyUsage()
  };
  const events: SessionEvent[] = [];
  const ctx = {
    sessionId: meta.id, sessionDir: process.cwd(), session: () => meta, settings: () => settings,
    runtime: { resolve: () => ({ path: process.execPath, source: 'system' }) },
    permissionMode: () => 'ask', effort: () => undefined, getApiKey: async () => 'test-key',
    mcpServers: async () => [], ownedMcpIds: () => [], log: vi.fn(),
    emit: (event: SessionEvent) => events.push(event), requestApproval: async () => ({ optionId: 'deny' }),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    updateRef: (patch: object) => Object.assign(meta.harnessRef, patch),
    readJson: async () => null, writeJson: vi.fn(async () => {})
  } as unknown as HarnessContext;
  return { ctx, meta, events, settings };
}
function track<T extends { dispose(): Promise<void> }>(adapter: T): T { adapters.push(adapter); return adapter; }
function turns(events: SessionEvent[]) { return events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn'); }
function completeCodex(status = 'completed') {
  mocks.notifications.get('turn/completed')!({ turn: { id: 'turn', status, error: null } });
}
function params(provider = OPENAI, model = GPT.model, fastMode = true): StepParams {
  return { provider, model, fastMode, apiKey: 'test', system: 'test', history: [{ role: 'user', text: 'hello' }], tools: [], signal: new AbortController().signal, onText: vi.fn(), onReasoning: vi.fn() };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.notifications.clear();
  messages = new AsyncQueue();
  mocks.query.mockReturnValue({
    [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), applyFlagSettings: mocks.flags,
    setModel: vi.fn(), supportedModels: async () => [], supportedCommands: async () => [],
    interrupt: mocks.interrupt, close: () => messages.close()
  });
  mocks.request.mockImplementation(async (method: string) => {
    if (method === 'model/list') return { data: [{ id: GPT.model, model: GPT.model, displayName: 'GPT', supportedReasoningEfforts: [], inputModalities: [], serviceTiers: [{ id: 'fast' }], isDefault: true }] };
    if (method.startsWith('thread/')) return { thread: { id: 'thread' }, model: GPT.model, modelProvider: 'openai', reasoningEffort: null, serviceTier: 'fast' };
    return { turn: { id: 'turn' } };
  });
  const thread = { id: 'thread', runStreamed: mocks.runStreamed };
  mocks.startThread.mockReturnValue(thread);
  mocks.resumeThread.mockReturnValue(thread);
  mocks.runStreamed.mockImplementation(async () => ({ events: (async function* () {
    yield { type: 'thread.started', thread_id: 'thread' };
    yield { type: 'turn.started' };
    yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
  })() }));
  mocks.openai.mockImplementation(async () => (async function* () {
    yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], service_tier: 'priority' };
  })());
  mocks.anthropic.mockImplementation(() => Object.assign((async function* () {})(), {
    finalMessage: async () => ({ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' }, stop_reason: 'end_turn' })
  }));
});
afterEach(async () => { messages.close(); await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose())); });

describe('Claude Fast mode SDK boundary', () => {
  it.each([undefined, false, true])('explicitly opts in only when requested (%s), including resume', async (enabled) => {
    const { ctx, meta } = fixture('claude', enabled);
    meta.harnessRef.claudeSessionId = 'saved-claude';
    await track(new ClaudeAdapter(ctx)).start();
    expect(mocks.query.mock.calls[0][0].options).toMatchObject({ settings: { fastMode: enabled === true }, resume: 'saved-claude' });
    expect(meta.fastModeStatus?.state).toBe(enabled ? 'requested' : 'off');
  });

  it('uses the passed toggle before config persistence, and leaves a refused toggle unchanged', async () => {
    const { ctx, meta } = fixture('claude', false);
    const adapter = track(new ClaudeAdapter(ctx));
    await adapter.start();
    await adapter.setFastMode(true);
    expect(mocks.flags).toHaveBeenLastCalledWith({ fastMode: true });
    expect(meta.config.fastMode).toBe(false);
    expect(meta.fastModeStatus?.state).toBe('requested');
    mocks.flags.mockRejectedValueOnce(new Error('policy refused'));
    await expect(adapter.setFastMode(false)).rejects.toThrow('policy refused');
    expect(meta.fastModeStatus?.state).toBe('requested');
    await adapter.setFastMode(false);
    expect(mocks.flags).toHaveBeenLastCalledWith({ fastMode: false });
    expect(meta.fastModeStatus?.state).toBe('off');
    expect(mocks.interrupt).not.toHaveBeenCalled();
  });

  it('normalizes observed activation, cooldown and disabled reasons without inventing on', async () => {
    const { ctx, meta, events } = fixture('claude', true);
    const adapter = track(new ClaudeAdapter(ctx));
    await adapter.start();
    await adapter.send({ text: 'hello', mode: 'now' });
    for (const [state, reason, expected] of [['on', undefined, 'on'], ['cooldown', undefined, 'cooldown'], ['off', 'sdk_opt_in_required', 'unavailable']] as const) {
      messages.push({ type: 'system', subtype: 'status', fast_mode_state: state, fast_mode_disabled_reason: reason });
      await vi.waitFor(() => expect(meta.fastModeStatus?.state).toBe(expected));
    }
    expect(meta.fastModeStatus?.detail).toBe('sdk_opt_in_required');
    messages.push({ type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1 });
    await vi.waitFor(() => expect(turns(events)).toHaveLength(1));
    expect(turns(events)[0]).toMatchObject({ item: { status: 'completed' } });
    expect(adapter.busy).toBe(false);
  });

  it('does not enable a third-party endpoint', async () => {
    const { ctx, meta } = fixture('claude', true, OPUS, [{ ...ANTHROPIC, baseUrl: 'https://gateway.example' }]);
    const adapter = track(new ClaudeAdapter(ctx));
    await adapter.start();
    expect(mocks.query.mock.calls[0][0].options.settings.fastMode).toBe(false);
    expect(meta.fastModeStatus?.state).toBe('unavailable');
    await expect(adapter.setFastMode(true)).rejects.toThrow('custom endpoints');
  });

  it('removes the paid flag on unsupported model changes and restores the request on supported Opus', async () => {
    const { ctx, meta } = fixture('claude', true);
    const adapter = track(new ClaudeAdapter(ctx));
    await adapter.start();
    await adapter.setModel({ provider: 'anthropic', model: 'claude-opus-4-7' });
    expect(mocks.flags).toHaveBeenLastCalledWith({ fastMode: false });
    expect(meta.fastModeStatus?.state).toBe('unavailable');
    await adapter.setModel(OPUS);
    expect(mocks.flags).toHaveBeenLastCalledWith({ fastMode: true });
    expect(meta.fastModeStatus?.state).toBe('requested');
  });

  it('resets each new turn and marks an explicit Fast rejection unavailable', async () => {
    const { ctx, meta, events } = fixture('claude', true);
    const adapter = track(new ClaudeAdapter(ctx));
    await adapter.start();
    await adapter.send({ text: 'first', mode: 'now' });
    messages.push({ type: 'result', subtype: 'success', total_cost_usd: 0, fast_mode_state: 'on' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus?.state).toBe('on');
    await adapter.send({ text: 'second', mode: 'now' });
    expect(meta.fastModeStatus?.state).toBe('requested');
    messages.push({ type: 'result', subtype: 'error_during_execution', errors: ['Fast mode access denied'], is_error: true, total_cost_usd: 0 });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus).toMatchObject({ state: 'unavailable', detail: 'Fast mode access denied' });
    expect(turns(events)).toMatchObject([{ item: { status: 'completed' } }, { item: { status: 'failed' } }]);
  });
});

describe('terminal Fast-mode status boundaries', () => {
  it('does not call a successful Claude standard fallback a successful Fast activation', async () => {
    const { ctx, meta, events } = fixture('claude', true, { provider: 'anthropic', model: 'claude-opus-5' });
    const adapter = track(new ClaudeAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    messages.push({ type: 'system', subtype: 'status', fast_mode_state: 'on' });
    await vi.waitFor(() => expect(meta.fastModeStatus?.state).toBe('on'));
    // Captured live with explicit startup and runtime flag-tier opt-in: org policy denied it.
    messages.push({ type: 'result', subtype: 'success', fast_mode_state: 'off', fast_mode_disabled_reason: 'preference', total_cost_usd: 0 });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus).toEqual({ state: 'unavailable', detail: 'preference' });
    expect(turns(events)).toMatchObject([{ item: { status: 'completed' } }]);
  });

  it('classifies an accepted app-server turn’s terminal rejection, not just turn/start refusal', async () => {
    const { ctx, meta, events } = fixture('codex', true);
    const adapter = track(new CodexAppServerAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    mocks.notifications.get('error')!({ error: { message: 'Fast account access rejected' }, willRetry: false });
    expect(meta.fastModeStatus).toMatchObject({ state: 'unavailable', detail: 'Fast account access rejected' });
    mocks.notifications.get('turn/completed')!({ turn: { id: 'turn', status: 'failed', error: { message: 'Fast account access rejected' } } });
    expect(turns(events)).toMatchObject([{ item: { status: 'failed' } }]);
    expect(adapter.busy).toBe(false);
  });

  it.each(['event', 'throw'] as const)('classifies exec %s provider rejection as unavailable with one failed turn', async (mode) => {
    const { ctx, meta, events } = fixture('codex-exec', true);
    mocks.runStreamed.mockImplementationOnce(async () => ({ events: (async function* () {
      yield { type: 'turn.started' };
      if (mode === 'throw') throw new Error('Fast account access rejected');
      yield { type: 'turn.failed', error: { message: 'Fast account access rejected' } };
    })() }));
    const adapter = track(new CodexExecAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus).toMatchObject({ state: 'unavailable', detail: 'Fast account access rejected' });
    expect(turns(events)).toMatchObject([{ item: { status: 'failed' } }]);
    expect(mocks.runStreamed).toHaveBeenCalledTimes(1);
  });

  it('keeps exec cancellation distinct from a provider refusal', async () => {
    const { ctx, meta, events } = fixture('codex-exec', true);
    mocks.runStreamed.mockImplementationOnce(async (_input: unknown, options: { signal: AbortSignal }) => ({ events: (async function* () {
      yield { type: 'turn.started' };
      await new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error('cancelled'));
        else options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    })() }));
    const adapter = track(new CodexExecAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(mocks.runStreamed).toHaveBeenCalledTimes(1));
    await adapter.interrupt();
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus?.state).toBe('requested');
    expect(turns(events)).toMatchObject([{ item: { status: 'interrupted' } }]);
    expect(mocks.runStreamed).toHaveBeenCalledTimes(1);
  });

  it('prices exec premium usage instead of the standard catalog', async () => {
    const { ctx, events } = fixture('codex-exec', true);
    mocks.runStreamed.mockImplementationOnce(async () => ({ events: (async function* () {
      yield { type: 'turn.completed', usage: { input_tokens: 200_000, cached_input_tokens: 100_000, output_tokens: 100_000 } };
    })() }));
    const adapter = track(new CodexExecAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(turns(events)).toMatchObject([{ item: { status: 'completed', costUsd: 3.55 } }]);
  });
});

describe('Codex runtime-advertised Fast capabilities', () => {
  it.each(['codex', 'codex-exec'] as const)('uses the exact advertised priority tier on %s', async (harness) => {
    const original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method: string) => method === 'model/list'
      ? { data: [{ model: GPT.model, serviceTiers: [{ id: 'priority' }], additionalSpeedTiers: ['fast'], isDefault: true }] }
      : original(method));
    const { ctx, meta, events } = fixture(harness, true);
    const adapter = track(harness === 'codex' ? new CodexAppServerAdapter(ctx) : new CodexExecAdapter(ctx));
    await adapter.start();
    if (harness === 'codex') expect(mocks.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ serviceTier: 'priority', config: expect.objectContaining({ service_tier: 'priority' }) }));
    else expect(mocks.codex).toHaveBeenLastCalledWith(expect.objectContaining({ config: expect.objectContaining({ service_tier: 'priority', features: { fast_mode: true } }) }));
    await adapter.send({ text: 'hello', mode: 'now' });
    if (harness === 'codex') {
      mocks.notifications.get('thread/tokenUsage/updated')!({ tokenUsage: { total: { inputTokens: 200_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0 }, last: { totalTokens: 300_000 }, modelContextWindow: 1_000_000 } });
      completeCodex();
      expect(turns(events)[0]).toMatchObject({ item: { costUsd: 3.55 } });
    }
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus?.state).toBe('requested');
  });

  it.each(['codex', 'codex-exec'] as const)('does not send premium flags for a selected model missing from the runtime catalog on %s', async (harness) => {
    const original = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method: string) => method === 'model/list'
      ? { data: [{ model: 'gpt-6-astra', serviceTiers: [{ id: 'priority' }], isDefault: true }] }
      : original(method));
    const { ctx, meta } = fixture(harness, true);
    const adapter = track(harness === 'codex' ? new CodexAppServerAdapter(ctx) : new CodexExecAdapter(ctx));
    await adapter.start();
    expect(meta.fastModeStatus).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('available model catalog') });
    if (harness === 'codex') expect(mocks.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ serviceTier: 'default' }));
    else expect(mocks.codex).toHaveBeenLastCalledWith(expect.objectContaining({ config: expect.objectContaining({ service_tier: 'default', features: { fast_mode: false } }) }));
  });
});

describe('Codex app-server Fast mode protocol boundary', () => {
  it.each([undefined, true])('sets explicit startup/resume tiers and features (%s)', async (enabled) => {
    const { ctx, meta } = fixture('codex', enabled);
    meta.harnessRef.codexThreadId = 'saved-thread';
    await track(new CodexAppServerAdapter(ctx)).start();
    expect(mocks.spawn.mock.calls[0][1]).toContain('features.fast_mode=true');
    expect(mocks.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({
      threadId: 'saved-thread', serviceTier: enabled ? 'fast' : 'default',
      config: expect.objectContaining({ features: { fast_mode: true }, service_tier: enabled ? 'fast' : 'default' })
    }));
    expect(meta.fastModeStatus?.state).toBe(enabled ? 'requested' : 'off');
  });

  it('changes the next turn tier without interrupting, and preserves completion/cancellation', async () => {
    const { ctx, meta, events } = fixture('codex', false);
    const adapter = track(new CodexAppServerAdapter(ctx));
    await adapter.start();
    await adapter.setFastMode(true);
    await adapter.send({ text: 'hello', mode: 'now' });
    expect(mocks.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ serviceTier: 'fast' }));
    expect(meta.config.fastMode).toBe(false);
    expect(meta.fastModeStatus?.state).toBe('requested');
    mocks.notifications.get('thread/settings/updated')!({ threadId: 'thread', threadSettings: { serviceTier: 'priority' } });
    expect(meta.fastModeStatus?.state).toBe('requested');
    completeCodex();
    await adapter.setFastMode(false);
    await adapter.send({ text: 'hello', mode: 'now' });
    expect(mocks.request).toHaveBeenLastCalledWith('turn/start', expect.objectContaining({ serviceTier: 'default' }));
    await adapter.interrupt();
    expect(mocks.request).toHaveBeenLastCalledWith('turn/interrupt', { threadId: 'thread', turnId: 'turn' });
    completeCodex('interrupted');
    expect(turns(events)).toHaveLength(2);
    expect(turns(events)).toMatchObject([{ item: { status: 'completed' } }, { item: { status: 'interrupted' } }]);
    expect(adapter.busy).toBe(false);
    expect(meta.fastModeStatus?.state).toBe('off');
  });

  it('respects advertised missing tiers and custom routes, and recovers from a rejected turn', async () => {
    const { ctx, meta } = fixture('codex', true);
    mocks.request.mockImplementationOnce(async () => ({})).mockImplementationOnce(async () => ({ data: [{ model: GPT.model, serviceTiers: [] }] }));
    const adapter = track(new CodexAppServerAdapter(ctx));
    await adapter.start();
    expect(meta.fastModeStatus?.state).toBe('unavailable');
    expect(mocks.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ serviceTier: 'default' }));
    mocks.request.mockRejectedValueOnce(new Error('turn refused'));
    await expect(adapter.send({ text: 'hello', mode: 'now' })).rejects.toThrow('turn refused');
    expect(adapter.busy).toBe(false);
  });
});

describe('Codex exec SDK Fast mode boundary', () => {
  it('sets SDK config on startup and rebuilds resumed threads on toggles without trusting stale config', async () => {
    const { ctx, meta, events } = fixture('codex-exec', false);
    meta.harnessRef.codexThreadId = 'saved-thread';
    const adapter = track(new CodexExecAdapter(ctx));
    await adapter.start();
    expect(mocks.codex).toHaveBeenLastCalledWith(expect.objectContaining({ config: { features: { fast_mode: false }, service_tier: 'default' } }));
    await adapter.setFastMode(true);
    expect(mocks.codex).toHaveBeenLastCalledWith(expect.objectContaining({ config: { features: { fast_mode: true }, service_tier: 'fast' } }));
    expect(meta.config.fastMode).toBe(false);
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(mocks.resumeThread).toHaveBeenCalledWith('saved-thread', expect.any(Object));
    expect(turns(events)).toMatchObject([{ item: { status: 'completed' } }]);
    expect(meta.fastModeStatus?.state).toBe('requested');
    await adapter.setFastMode(false);
    expect(mocks.codex).toHaveBeenLastCalledWith(expect.objectContaining({ config: { features: { fast_mode: false }, service_tier: 'default' } }));
    expect(meta.fastModeStatus?.state).toBe('off');
  });

  it('keeps a constructor refusal transactional and resumes normal standard turns', async () => {
    const { ctx, meta } = fixture('codex-exec');
    const adapter = track(new CodexExecAdapter(ctx));
    await adapter.start();
    mocks.codex.mockImplementationOnce(() => { throw new Error('config refused'); });
    await expect(adapter.setFastMode(true)).rejects.toThrow('config refused');
    expect(meta.fastModeStatus?.state).toBe('off');
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
  });
});

describe('native Fast mode provider boundary', () => {
  it('sends OpenAI fast only on first-party supported models and recognizes priority responses', async () => {
    const p = params();
    p.onFastMode = vi.fn();
    await openaiStep(p);
    expect(mocks.openai).toHaveBeenLastCalledWith(expect.objectContaining({ service_tier: 'fast' }), expect.any(Object));
    expect(p.onFastMode).toHaveBeenCalledWith(true, 'OpenAI reported service tier: priority');
    for (const p of [params({ ...OPENAI, baseUrl: 'https://gateway.example' }), params(OPENAI, 'gpt-4.1'), params(OPENAI, 'gpt-5.3-codex-spark'), params({ ...OPENAI, id: 'openrouter', kind: 'openrouter' })]) {
      await openaiStep(p);
      expect(mocks.openai.mock.calls.at(-1)![0]).not.toHaveProperty('service_tier');
    }
  });

  it('sends Anthropic speed and its beta header only for supported first-party Opus', async () => {
    const p = params(ANTHROPIC, OPUS.model);
    p.onFastMode = vi.fn();
    await anthropicStep(p);
    expect(mocks.anthropic).toHaveBeenLastCalledWith(expect.objectContaining({ speed: 'fast' }), expect.objectContaining({ headers: { 'anthropic-beta': 'fast-mode-2026-02-01' } }));
    expect(p.onFastMode).toHaveBeenCalledWith(true, 'Anthropic reported speed: fast');
    for (const p of [params(ANTHROPIC, 'claude-sonnet-4-6'), params(ANTHROPIC, 'claude-opus-4-7'), params({ ...ANTHROPIC, baseUrl: 'https://gateway.example' }, OPUS.model), params(ANTHROPIC, OPUS.model, false)]) {
      await anthropicStep(p);
      expect(mocks.anthropic.mock.calls.at(-1)![0]).not.toHaveProperty('speed');
      expect(mocks.anthropic.mock.calls.at(-1)![1]).not.toHaveProperty('headers');
    }
  });

  it('restores requested mode, toggles both ways before persistence, and completes exactly once per turn', async () => {
    const { ctx, meta, events } = fixture('native', true);
    const adapter = track(new NativeAdapter(ctx));
    await adapter.start();
    expect(meta.fastModeStatus?.state).toBe('requested');
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus?.state).toBe('on');
    await adapter.setFastMode(false);
    await adapter.send({ text: 'standard', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(mocks.openai.mock.calls.at(-1)![0].service_tier).toBe('default');
    expect(meta.config.fastMode).toBe(true);
    expect(meta.fastModeStatus?.state).toBe('off');
    expect(turns(events)).toHaveLength(2);
    expect(turns(events)).toMatchObject([{ item: { status: 'completed' } }, { item: { status: 'completed' } }]);
    await adapter.setFastMode(true);
    await adapter.setModel({ provider: 'openai', model: 'gpt-4.1' });
    expect(meta.fastModeStatus?.state).toBe('unavailable');
    await expect(adapter.setFastMode(true)).rejects.toThrow('not available');
  });

  it.each([
    ['openai', GPT, 3.55],
    ['anthropic', OPUS, 7.35]
  ] as const)('prices observed %s Fast usage at published premium rates, including cache tokens', async (provider, model, cost) => {
    const { ctx, events } = fixture('native', true, model);
    if (provider === 'openai') mocks.openai.mockImplementationOnce(async () => (async function* () {
      yield { choices: [], service_tier: 'priority', usage: { prompt_tokens: 200_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 100_000 } } };
    })());
    else mocks.anthropic.mockImplementationOnce(() => Object.assign((async function* () {})(), {
      finalMessage: async () => ({ content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100_000, output_tokens: 100_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 100_000, speed: 'fast' }, stop_reason: 'end_turn' })
    }));
    const adapter = track(new NativeAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(turns(events)).toHaveLength(1);
    expect(turns(events)[0]).toMatchObject({ item: { status: 'completed', costUsd: cost } });
  });

  it('does not substitute standard pricing when a Fast rate is unknown', async () => {
    const { ctx, events } = fixture('native', true, { provider: 'openai', model: 'gpt-6-future' });
    const adapter = track(new NativeAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(events).toContainEqual(expect.objectContaining({ type: 'item.upsert', item: expect.objectContaining({ kind: 'info', level: 'warn', text: expect.stringContaining('Reported spend excludes these requests') }) }));
  });

  it('resets previously observed on to requested and reports a rejected premium request as unavailable', async () => {
    const { ctx, meta, events } = fixture('native', true);
    const adapter = track(new NativeAdapter(ctx));
    await adapter.send({ text: 'first', mode: 'now' });
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus?.state).toBe('on');
    const pending = deferred<never>();
    mocks.openai.mockReturnValueOnce(pending.promise);
    await adapter.send({ text: 'second', mode: 'now' });
    expect(meta.fastModeStatus?.state).toBe('requested');
    await vi.waitFor(() => expect(mocks.openai).toHaveBeenCalledTimes(2));
    pending.reject(new Error('Fast tier unavailable'));
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(meta.fastModeStatus).toMatchObject({ state: 'unavailable', detail: 'Fast tier unavailable' });
    expect(turns(events)).toMatchObject([{ item: { status: 'completed' } }, { item: { status: 'failed' } }]);
  });

  it('cancels one premium request without retrying or claiming effective Fast mode', async () => {
    const { ctx, meta, events } = fixture('native', true);
    mocks.openai.mockImplementationOnce((_body: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const adapter = track(new NativeAdapter(ctx));
    await adapter.send({ text: 'hello', mode: 'now' });
    await vi.waitFor(() => expect(mocks.openai).toHaveBeenCalledTimes(1));
    await adapter.interrupt();
    await vi.waitFor(() => expect(adapter.busy).toBe(false));
    expect(turns(events)).toMatchObject([{ item: { status: 'interrupted' } }]);
    expect(meta.fastModeStatus?.state).toBe('requested');
    expect(mocks.openai).toHaveBeenCalledTimes(1);
  });
});
