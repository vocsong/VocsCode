import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fastMode, { PI_FAST_MODE_COMMAND, PI_FAST_MODE_MARKER } from '../resources/pi/vocs-code-fast-mode';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent } from '../src/shared/types';

const spawn = vi.hoisted(() => ({ spawnTool: vi.fn(), shutdownChild: vi.fn(), usesWindowsCommandShim: () => false }));
vi.mock('../src/main/harness/spawn', () => spawn);
vi.mock('../src/main/pi-agents', () => ({ installPiAgentOverrides: async () => {} }));
type API = Parameters<typeof fastMode>[0];
type Handler = Parameters<API['on']>[1];
type Ctx = Parameters<Handler>[1];
const openai = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' };
const codex = { provider: 'openai-codex', id: 'gpt-5.4', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };
const opus = { provider: 'anthropic', id: 'claude-opus-4-8', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' };
const unsupported = [
  { ...openai, provider: 'openrouter' }, { ...openai, provider: 'custom' },
  { ...openai, baseUrl: 'https://proxy.example/v1' }, { ...openai, api: 'azure-openai-responses' },
  { ...openai, id: 'gpt-5.3-codex-spark' }, { ...openai, id: 'gpt-4.1' },
  { ...opus, id: 'claude-opus-4-6' }, { ...opus, id: 'claude-opus-4-7' }, { ...opus, id: 'claude-sonnet-5' },
  { ...opus, baseUrl: 'https://api.anthropic.com.evil.test' },
];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function extension(enabled: string | undefined, model: Ctx['model'] = openai, notify = vi.fn()) {
  vi.stubEnv('VOCS_CODE_PI_NONCE', 'test-session');
  vi.stubEnv('VOCS_CODE_FAST_MODE', enabled);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Parameters<API['registerCommand']>[1]>();
  const ctx: Ctx = { model, isIdle: () => true, ui: { notify } };
  fastMode({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => { commands.set(name, command); } });
  const fire = (name: string, event: Parameters<Handler>[0] = {}) => handlers.get(name)?.(event, ctx);
  return { ctx, fire, notify, command: (choice: unknown) => commands.get(PI_FAST_MODE_COMMAND)!.handler(JSON.stringify(choice), ctx) };
}

// Real shipped extension hooks, not copies of the payload transformation.
describe('Pi Fast mode provider request boundary', () => {
  it.each([openai, codex, { ...openai, id: 'gpt-6' }, { ...openai, api: 'openai-completions' }])('requests priority without touching reasoning: $provider/$api', async (model) => {
    const ext = extension('1', model);
    const payload = { model: model.id, reasoning: { effort: 'high' }, messages: [], temperature: 0.5 };
    expect(await ext.fire('before_provider_request', { payload })).toEqual({ ...payload, service_tier: 'priority' });
    expect(payload).not.toHaveProperty('service_tier');
    await ext.fire('after_provider_response', { status: 200 });
    const states = ext.notify.mock.calls.filter(([message]) => message.startsWith(PI_FAST_MODE_MARKER)).map(([message]) => JSON.parse(message.slice(PI_FAST_MODE_MARKER.length)).state);
    expect(states).toEqual(['requested']); // HTTP success is not a confirmed service tier.
  });
  it.each([opus, { ...opus, id: 'claude-opus-5' }, { ...opus, id: 'claude-opus-5-1' }])('sends Anthropic speed and additive beta, not effort: $id', async (model) => {
    const ext = extension('1', model);
    const payload = { model: model.id, betas: ['existing-beta'], thinking: { type: 'adaptive' }, output_config: { effort: 'max' } };
    expect(await ext.fire('before_provider_request', { payload })).toEqual({ ...payload, speed: 'fast', betas: ['existing-beta', 'fast-mode-2026-02-01'] });
    expect(payload.betas).toEqual(['existing-beta']);
  });
  it.each([...unsupported, undefined])('never sends fast fields to unsupported effective models: %j', async (model) => {
    const ext = extension('1'); ext.ctx.model = model;
    const payload = { model: model?.id, messages: [] };
    expect(await ext.fire('before_provider_request', { payload })).toBeUndefined();
    expect(payload).not.toHaveProperty('service_tier'); expect(payload).not.toHaveProperty('speed'); expect(payload).not.toHaveProperty('betas');
  });
  it.each([undefined, 'true', 'false'])('does not mutate requests when initial env is invalid: %j', async (enabled) => {
    const ext = extension(enabled);
    expect(await ext.fire('before_provider_request', { payload: { model: openai.id } })).toBeUndefined();
  });
  it.each([openai, codex, opus])('overrides inherited Fast fields on/off without losing unrelated payload: $provider', async (model) => {
    const ext = extension('0', model);
    const payload = model.provider === 'anthropic'
      ? { speed: 'fast', betas: ['existing-beta', 'fast-mode-2026-02-01'], thinking: { type: 'adaptive' } }
      : { service_tier: 'priority', reasoning: { effort: 'high' } };
    const off = model.provider === 'anthropic'
      ? { betas: ['existing-beta'], thinking: { type: 'adaptive' } }
      : { service_tier: 'default', reasoning: { effort: 'high' } };
    expect(await ext.fire('before_provider_request', { payload })).toEqual(off);
    await ext.command({ nonce: 'test-session', enabled: true, revision: 1, requestId: 'on' });
    const on = await ext.fire('before_provider_request', { payload: off });
    expect(on).toEqual(model.provider === 'anthropic' ? { ...off, speed: 'fast', betas: payload.betas } : { ...off, service_tier: 'priority' });
    await ext.command({ nonce: 'test-session', enabled: false, revision: 2, requestId: 'off' });
    expect(await ext.fire('before_provider_request', { payload: on })).toEqual(off);
    expect(payload).toEqual(model.provider === 'anthropic'
      ? { speed: 'fast', betas: ['existing-beta', 'fast-mode-2026-02-01'], thinking: { type: 'adaptive' } }
      : { service_tier: 'priority', reasoning: { effort: 'high' } });
  });
  it.each(unsupported)('leaves unsupported payloads unchanged even when disabled: %j', async (model) => {
    const ext = extension('0', model);
    const payload = { service_tier: 'priority', speed: 'fast', betas: ['existing-beta'] };
    expect(await ext.fire('before_provider_request', { payload })).toBeUndefined();
    expect(payload).toEqual({ service_tier: 'priority', speed: 'fast', betas: ['existing-beta'] });
  });
  it('validates bridge identity, boolean, revision and idle state before mutation', async () => {
    const ext = extension('0');
    const choice = { nonce: 'test-session', enabled: true, revision: 1, requestId: 'req-1' };
    for (const invalid of [{ ...choice, nonce: 'other' }, { ...choice, enabled: 'true' }, { ...choice, revision: 0 }, { ...choice, requestId: '' }]) {
      await expect(ext.command(invalid)).rejects.toThrow('Invalid Pi Fast mode bridge');
    }
    ext.ctx.isIdle = () => false;
    await expect(ext.command(choice)).rejects.toThrow('while idle');
    expect(await ext.fire('before_provider_request', { payload: {} })).toEqual({ service_tier: 'default' });
    ext.ctx.isIdle = () => true;
    await ext.command(choice);
    await expect(ext.command(choice)).rejects.toThrow('Invalid Pi Fast mode bridge');
    expect(await ext.fire('before_provider_request', { payload: {} })).toEqual({ service_tier: 'priority' });
    await ext.command({ ...choice, enabled: false, revision: 2, requestId: 'req-2' });
    expect(await ext.fire('before_provider_request', { payload: {} })).toEqual({ service_tier: 'default' });
  });
  it('uses the model switched into, reports unsupported/error/cooldown honestly, and never claims on', async () => {
    const ext = extension('1');
    ext.ctx.model = opus;
    await ext.fire('model_select', { model: opus });
    expect(await ext.fire('before_provider_request', { payload: {} })).toMatchObject({ speed: 'fast' });
    await ext.fire('after_provider_response', { status: 429 });
    await ext.fire('message_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: 'secret provider payload' } });
    ext.ctx.model = unsupported[0];
    await ext.fire('model_select', { model: unsupported[0] });
    expect(await ext.fire('before_provider_request', { payload: {} })).toBeUndefined();
    const messages = ext.notify.mock.calls.map(([message]) => message);
    expect(messages.some((message) => message.includes('secret provider payload'))).toBe(false);
    expect(messages.map((message) => JSON.parse(message.slice(PI_FAST_MODE_MARKER.length)).state)).toEqual(['requested', 'requested', 'cooldown', 'unavailable', 'unavailable']);
  });
});

async function host(options: { enabled?: boolean; model?: Ctx['model']; noExtension?: boolean; staleAck?: boolean; commandError?: boolean; resumed?: boolean; stats?: { cost: number } } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'vocs-pi-fast-')); roots.push(root);
  const commands: Record<string, any>[] = [];
  const events: SessionEvent[] = [];
  const payloads: unknown[] = [];
  const meta = { cwd: root, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }, harnessRef: options.resumed ? { piSessionFile: path.join(root, 'resume.jsonl') } : {},
    config: { model: { provider: openai.provider, model: openai.id }, fastMode: options.enabled, projectRoot: root },
    fastModeStatus: undefined as { state: string; detail?: string } | undefined };
  let ext: ReturnType<typeof extension>;
  let emit: (event: Record<string, unknown>) => void;
  spawn.spawnTool.mockImplementation((_bin, _args, opts) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    emit = (event) => { stdout.write(JSON.stringify(event) + '\n'); };
    const notify = vi.fn((message: string) => {
      if (options.staleAck && message.startsWith(PI_FAST_MODE_MARKER)) {
        const payload = JSON.parse(message.slice(PI_FAST_MODE_MARKER.length));
        if (payload.requestId) message = PI_FAST_MODE_MARKER + JSON.stringify({ ...payload, nonce: 'foreign-session' });
      }
      emit({ type: 'extension_ui_request', method: 'notify', message });
    });
    ext = extension(opts.env.VOCS_CODE_FAST_MODE, options.model ?? openai, notify);
    // The real child inherits its own environment, never this test helper's default nonce.
    const original = notify.getMockImplementation()!;
    notify.mockImplementation((message) => original(message.replaceAll('test-session', opts.env.VOCS_CODE_PI_NONCE)));
    const stdin = new Writable({ write(chunk, _encoding, done) {
      const command = JSON.parse(chunk.toString()); commands.push(command);
      void (async () => {
        let data: unknown = {};
        if (command.type === 'get_state') {
          for (const capability of ['approvals', 'tools', 'subagents']) notify('VCODE_PI_READY::' + JSON.stringify({ version: 1, nonce: opts.env.VOCS_CODE_PI_NONCE, capability }));
          if (!options.noExtension) await ext.fire('session_start');
          data = { model: ext.ctx.model };
        } else if (command.type === 'get_available_models') data = { models: [] };
        else if (command.type === 'get_session_stats') data = options.stats ?? {};
        else if (command.type === 'set_model') {
          ext.ctx.model = command.provider === 'anthropic' ? { ...opus, id: command.modelId } : { ...openai, provider: command.provider, id: command.modelId };
          await ext.fire('model_select', { model: ext.ctx.model });
        } else if (command.type === 'prompt' && command.message.startsWith(`/${PI_FAST_MODE_COMMAND} `)) {
          if (options.commandError) throw new Error('injected bridge failure');
          const choice = JSON.parse(command.message.slice(PI_FAST_MODE_COMMAND.length + 2));
          // The factory captured the child nonce, represented here by the isolated test nonce.
          await ext.command({ ...choice, nonce: choice.nonce === opts.env.VOCS_CODE_PI_NONCE ? 'test-session' : choice.nonce });
        } else if (command.type === 'prompt') {
          const payload = { model: ext.ctx.model?.id, messages: [], reasoning: { effort: 'high' } };
          payloads.push(await ext.fire('before_provider_request', { payload }) ?? payload);
        }
        emit({ type: 'response', id: command.id, success: true, data });
      })().catch((error) => {
        // Pi catches extension command errors and reports command:<name>, then returns RPC success.
        if (command.type === 'prompt' && command.message.startsWith(`/${PI_FAST_MODE_COMMAND} `)) {
          emit({ type: 'extension_error', extensionPath: `command:${PI_FAST_MODE_COMMAND}`, error: error.message });
          emit({ type: 'response', id: command.id, success: true });
        } else emit({ type: 'response', id: command.id, success: false, error: error.message });
      });
      done();
    } });
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin });
    return child;
  });
  spawn.shutdownChild.mockImplementation(async (child) => { child.emit('close', 0); });
  const ctx = {
    session: () => meta, settings: () => ({ pi: {}, providers: [] }),
    runtime: { resolve: () => ({ path: '/fake/pi' }), resource: (...parts: string[]) => path.join(root, 'resources', ...parts) },
    sessionDir: root, permissionMode: () => 'ask', effort: () => undefined, getApiKey: async () => undefined, mcpServers: async () => [],
    emit: (event: SessionEvent) => events.push(event), log: () => {}, updateRef: () => {}, updateMeta: (patch: unknown) => Object.assign(meta, patch),
  } as unknown as HarnessContext;
  return { adapter: new PiAdapter(ctx), meta, commands, events, payloads, emit: (event: Record<string, unknown>) => emit(event) };
}

describe('Pi adapter nonce-bound Fast mode RPC bridge', () => {
  it('defaults off despite inherited env, toggles on/off with acknowledgement and adds no reasoning RPC or user turns', async () => {
    vi.stubEnv('VOCS_CODE_FAST_MODE', '1');
    const h = await host(); await h.adapter.start();
    expect(spawn.spawnTool.mock.calls[0][2].env.VOCS_CODE_FAST_MODE).toBe('0');
    expect(spawn.spawnTool.mock.calls[0][1]).toEqual(expect.arrayContaining([expect.stringContaining('vocs-code-fast-mode.ts')]));
    expect(h.meta.fastModeStatus?.state).toBe('off');
    await h.adapter.setFastMode(true);
    expect(h.meta.fastModeStatus?.state).toBe('requested');
    await h.adapter.setFastMode(false);
    expect(h.meta.fastModeStatus?.state).toBe('off');
    expect(h.commands.filter((command) => command.type === 'prompt')).toHaveLength(2);
    expect(h.commands.filter((command) => command.type === 'set_thinking_level')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'item.upsert')).toHaveLength(0);
    await h.adapter.send({ text: 'normal turn' });
    expect(h.payloads).toEqual([{ model: openai.id, messages: [], reasoning: { effort: 'high' }, service_tier: 'default' }]);
    await expect(h.adapter.setFastMode(true)).rejects.toThrow('while idle');
    await h.adapter.interrupt(); expect(h.commands.at(-1)?.type).toBe('abort');
    await h.adapter.dispose();
  });
  it('restores requested Fast mode on resume but filters using the actual restored model, and follows subsequent model switches', async () => {
    const h = await host({ enabled: true, resumed: true, model: unsupported[0] });
    await h.adapter.start();
    expect(spawn.spawnTool.mock.calls[0][1]).toContain('--session');
    expect(h.meta.fastModeStatus?.state).toBe('unavailable');
    await h.adapter.setModel({ provider: 'anthropic', model: opus.id });
    expect(h.meta.fastModeStatus?.state).toBe('requested');
    await h.adapter.send({ text: 'fast turn' });
    expect(h.payloads).toEqual([{ model: opus.id, messages: [], reasoning: { effort: 'high' }, speed: 'fast', betas: ['fast-mode-2026-02-01'] }]);
    h.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], stopReason: 'stop' } });
    h.emit({ type: 'agent_end' });
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn' && event.item.status === 'completed')).toHaveLength(1));
    expect(h.meta.fastModeStatus?.state).toBe('requested');
    await h.adapter.dispose();
  });
  it.each([
    { model: openai, cacheWrite: 0, expected: 0.0355 },
    { model: opus, cacheWrite: 1000, expected: 0.0735 },
  ])('estimates requested Fast cost for the actual resumed model, reconciles streaming/stats once and keeps off turns standard: $model.provider', async ({ model, cacheWrite, expected }) => {
    const stats = { cost: 0.02 };
    const h = await host({ enabled: true, resumed: true, model, stats });
    await h.adapter.start(); await h.adapter.send({ text: 'fast' });
    h.emit({ type: 'message_start', message: { role: 'assistant', provider: model.provider, model: model.id } });
    h.emit({ type: 'message_update', usage: { input: 500, output: 500, cacheRead: 500, cacheWrite: cacheWrite / 2, cost: { total: 0.01 } } });
    h.emit({ type: 'message_end', message: { role: 'assistant', provider: model.provider, model: model.id, stopReason: 'stop', usage: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite, cost: { total: 0.02 } } } });
    h.emit({ type: 'agent_end' });
    const turns = () => h.events.filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn').map((event) => (event as Extract<SessionEvent, { type: 'item.upsert' }>).item);
    await vi.waitFor(() => expect(turns()).toHaveLength(1));
    expect(turns()[0]).toMatchObject({ status: 'completed', costUsd: expect.closeTo(expected, 8) });
    expect(h.events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({ totals: { costUsd: expect.closeTo(expected, 8), turns: 1 } });
    expect(h.meta.fastModeStatus?.state).toBe('requested');
    expect(h.meta.fastModeStatus?.detail).toContain('estimate');
    await h.adapter.setFastMode(false); stats.cost = 0.03;
    await h.adapter.send({ text: 'standard' });
    h.emit({ type: 'message_start', message: { role: 'assistant', provider: model.provider, model: model.id } });
    h.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 1000, output: 1000, cost: { total: 0.01 } } } });
    h.emit({ type: 'agent_end' });
    await vi.waitFor(() => expect(turns()).toHaveLength(2));
    expect(turns()[1]).toMatchObject({ costUsd: expect.closeTo(0.01, 8) });
    expect(h.events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({ totals: { costUsd: expect.closeTo(expected + 0.01, 8), turns: 2 } });
    await h.adapter.dispose();
  });
  it.each([{ ...openai, id: 'gpt-6' }, codex])('surfaces missing requested Fast pricing instead of implying the standard estimate is full spend: $provider/$id', async (model) => {
    const h = await host({ enabled: true, model, stats: { cost: 0.01 } });
    await h.adapter.start(); await h.adapter.send({ text: 'fast' });
    h.emit({ type: 'message_start', message: { role: 'assistant', provider: model.provider, model: model.id } });
    h.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 1000, output: 1000, cost: { total: 0.01 } } } });
    h.emit({ type: 'agent_end' });
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn')).toHaveLength(1));
    expect(h.meta.fastModeStatus?.detail).toContain('pricing is unavailable');
    expect(h.events.some((event) => event.type === 'item.upsert' && event.item.kind === 'info' && event.item.level === 'warn' && event.item.text.includes('standard-rate estimate'))).toBe(true);
    await h.adapter.dispose();
  });
  it('does not apply first-party premiums to an unsupported restored provider', async () => {
    const h = await host({ enabled: true, model: unsupported[0], stats: { cost: 0.01 } });
    await h.adapter.start(); await h.adapter.send({ text: 'unsupported' });
    h.emit({ type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: openai.id } });
    h.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 1000, output: 1000, cost: { total: 0.01 } } } });
    h.emit({ type: 'agent_end' });
    await vi.waitFor(() => expect(h.events.filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn')).toHaveLength(1));
    expect(h.events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({ totals: { costUsd: 0.01 } });
    await h.adapter.dispose();
  });
  it('requires extension readiness when requested and never sends a prompt without it', async () => {
    const h = await host({ enabled: true, noExtension: true });
    await expect(h.adapter.send({ text: 'blocked' })).rejects.toThrow('fast-mode');
    expect(h.commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
  });
  it('rejects invalid values and unsupported model changes explicitly, disposing an unconfirmed runtime', async () => {
    const h = await host({ model: unsupported[0] }); await h.adapter.start();
    await expect(h.adapter.setFastMode('true' as unknown as boolean)).rejects.toThrow('boolean');
    expect(h.commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    await expect(h.adapter.setFastMode(true)).rejects.toThrow('unavailable');
    expect(spawn.shutdownChild).toHaveBeenCalledTimes(1);
    expect(h.meta.fastModeStatus?.state).toBe('unavailable');
  });
  it('propagates bridge failure without silently committing a preference', async () => {
    const h = await host({ commandError: true }); await h.adapter.start();
    await expect(h.adapter.setFastMode(true)).rejects.toThrow('injected bridge failure');
    expect(h.meta.config.fastMode).toBeUndefined();
    expect(h.meta.fastModeStatus?.state).toBe('unavailable');
    expect(spawn.shutdownChild).toHaveBeenCalledTimes(1);
  });
  it('does not accept a foreign-session acknowledgement even when RPC says success', async () => {
    const h = await host({ staleAck: true }); await h.adapter.start();
    vi.useFakeTimers();
    const changed = h.adapter.setFastMode(true);
    const rejected = expect(changed).rejects.toThrow('Pi Fast mode acknowledgement');
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    expect(h.meta.config.fastMode).toBeUndefined();
    expect(h.meta.fastModeStatus?.state).toBe('unavailable');
    expect(spawn.shutdownChild).toHaveBeenCalledTimes(1);
  });
});
