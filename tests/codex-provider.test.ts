/**
 * Codex can run models from the app's own OpenAI-wire providers (OpenRouter, DeepSeek, Groq, …)
 * through its `model_providers` seam. These offline tests pin the two production boundaries:
 * the New Session catalog offers those models, and starting a session registers the selected
 * provider with the Responses wire API (Codex 0.153 rejects `chat`) and injects its key — while an
 * OpenAI session never sees another provider's key.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { CodexExecAdapter } from '../src/main/harness/codex-exec';
import { listHarnessModels } from '../src/main/harness/registry';
import { defaultSettings } from '../src/main/settings';
import type { HarnessContext } from '../src/main/harness/types';
import type { AppSettings, HarnessRef, ModelRef, ProviderConfig, SessionEvent, SessionMeta } from '../src/shared/types';
import { CODEX_STATIC_MODELS, emptyUsage } from '../src/main/models/static-models';

type AnyRecord = Record<string, any>;

const mocks = vi.hoisted(() => ({
  shutdown: vi.fn(),
  spawnChildren: [] as AnyRecord[],
  spawnCalls: [] as { file: string; args: string[]; opts: AnyRecord }[]
}));

vi.mock('../src/main/harness/spawn', () => ({
  spawnTool: (file: string, args: string[], opts: AnyRecord) => {
    mocks.spawnCalls.push({ file, args, opts });
    const child = mocks.spawnChildren.shift();
    if (!child) throw new Error('no scripted child process');
    return child;
  },
  shutdownChild: async (child: unknown) => mocks.shutdown(child),
  killTree: async () => undefined,
  quoteWin: (arg: string) => arg,
  usesWindowsCommandShim: () => false
}));

function makeFakeChild(): AnyRecord {
  const child = new EventEmitter() as AnyRecord;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  child.kill = vi.fn();
  return child;
}

/** JSON-RPC peer for the codex app-server (no `jsonrpc` field, matching that transport). */
class FakeJsonRpcServer {
  readonly requests: AnyRecord[] = [];
  private buf = '';
  private readonly handlers = new Map<string, (params: AnyRecord, id: AnyRecord) => unknown>();

  constructor(private readonly child: AnyRecord) {
    child.stdin.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
  }

  on(method: string, handler: (params: AnyRecord, id: AnyRecord) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.dispatch(JSON.parse(line) as AnyRecord);
      idx = this.buf.indexOf('\n');
    }
  }

  private dispatch(msg: AnyRecord): void {
    if (msg.method === undefined) return;
    this.requests.push(msg);
    if (msg.id === undefined || msg.id === null) return;
    Promise.resolve()
      .then(() => this.handlers.get(msg.method)?.(msg.params as AnyRecord, msg.id) ?? {})
      .then(
        (result) => this.write({ id: msg.id, result: result ?? {} }),
        (e: unknown) => this.write({ id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } })
      );
  }

  private write(msg: AnyRecord): void {
    this.child.stdout.write(JSON.stringify(msg) + '\n');
  }
}

const OPENROUTER_MODELS = [
  { id: 'z-ai/glm-4.6', provider: 'openrouter', displayName: 'GLM 4.6', supportsImages: false },
  { id: 'moonshotai/kimi-k2', provider: 'openrouter', displayName: 'Kimi K2', supportsImages: false }
];

function openRouterProvider(): ProviderConfig {
  return {
    id: 'openrouter',
    kind: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    hasApiKey: true,
    envKey: 'OPENROUTER_API_KEY',
    models: OPENROUTER_MODELS,
    builtin: true,
    enabled: true
  };
}

function settingsWithOpenRouter(): AppSettings {
  const base = defaultSettings();
  return { ...base, providers: [...base.providers.filter((p) => p.id !== 'openrouter'), openRouterProvider()] };
}

function makeCtx(meta: SessionMeta, settings: AppSettings, owned: string[] = []): { ctx: HarnessContext; events: SessionEvent[]; keys: string[] } {
  const events: SessionEvent[] = [];
  const keys: string[] = [];
  const ctx = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => settings,
    runtime: { resolve: () => ({ name: 'codex', path: 'C:/fake/codex.exe' }) },
    sessionDir: process.cwd(),
    permissionMode: () => meta.config.permissionMode,
    effort: () => undefined,
    getApiKey: async (id: string) => {
      keys.push(id);
      return id === 'openrouter' ? 'sk-openrouter-test' : undefined;
    },
    emit: (event: SessionEvent) => events.push(event),
    requestApproval: async () => ({ optionId: 'deny' }),
    updateRef: (patch: Partial<HarnessRef>) => Object.assign(meta.harnessRef, patch),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    log: vi.fn(),
    readJson: async () => null,
    writeJson: async () => undefined,
    mcpServers: async () => [],
    ownedMcpIds: () => owned
  } as unknown as HarnessContext;
  return { ctx, events, keys };
}

function makeMeta(model?: ModelRef): SessionMeta {
  return {
    id: 's_codex',
    title: 'Codex provider',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'codex', projectRoot: '/proj', permissionMode: 'ask', model },
    cwd: '/proj',
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage()
  };
}

function scriptServer(child: AnyRecord): FakeJsonRpcServer {
  return new FakeJsonRpcServer(child)
    .on('initialize', () => ({}))
    .on('thread/start', () => ({ thread: { id: 'thread-1' }, model: 'z-ai/glm-4.6', modelProvider: 'openrouter', reasoningEffort: null }))
    .on('model/list', () => ({ data: [] }))
    .on('thread/unsubscribe', () => ({}));
}

beforeEach(() => {
  mocks.shutdown.mockClear();
  mocks.spawnChildren.length = 0;
  mocks.spawnCalls.length = 0;
  // The adapter inherits process.env; clear the provider key so only its own injection can supply one.
  delete process.env.OPENROUTER_API_KEY;
});

describe('codex provider catalog', () => {
  const row = (model: string) => ({ id: model, model, displayName: model, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], isDefault: false });
  const runtime = { resolve: () => ({ path: '/fake/codex', source: 'system' }) } as never;

  it.each(['codex', 'codex-exec'] as const)('discovers newly released models on every page for %s before creating a session', async (harness) => {
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child).on('model/list', (params) => params.cursor
      ? { data: [row('gpt-future-codex')], nextCursor: null }
      : { data: [row('gpt-first-page')], nextCursor: 'page-2' });
    const result = await listHarnessModels({ harness, settings: settingsWithOpenRouter(), runtime, getApiKey: async () => undefined });

    expect(result.error).toBeUndefined();
    expect(result.models.filter((m) => m.provider === 'openai').map((m) => m.id)).toEqual(['gpt-first-page', 'gpt-future-codex']);
    expect(result.models.find((m) => m.id === 'gpt-future-codex')).toMatchObject({ supportsImages: true, supportedEfforts: ['high'] });
    expect(result.models.some((m) => m.provider === 'openrouter')).toBe(harness === 'codex');
    expect(server.requests.filter((r) => r.method === 'model/list').map((r) => r.params)).toEqual([
      { limit: 100, includeHidden: false }, { limit: 100, includeHidden: false, cursor: 'page-2' }
    ]);
    expect(server.requests.some((r) => r.method.startsWith('thread/') || r.method.startsWith('turn/'))).toBe(false);
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('publishes every live model page from a started app-server session', async () => {
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child)
      .on('thread/start', () => ({ thread: { id: 'thread-1' }, model: 'gpt-first-page', modelProvider: 'openai' }))
      .on('model/list', (params) => params.cursor
        ? { data: [row('gpt-future-codex')], nextCursor: null }
        : { data: [row('gpt-first-page')], nextCursor: 'page-2' });
    const { ctx, events } = makeCtx(makeMeta(), defaultSettings());
    const adapter = new CodexAppServerAdapter(ctx);
    try {
      await adapter.start();
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'models')).toHaveLength(1));
      expect(events.filter((e) => e.type === 'models').flatMap((e) => e.models.map((m) => m.id))).toEqual(['gpt-first-page', 'gpt-future-codex']);
      expect(events.some((e) => e.type === 'error')).toBe(false);
    } finally {
      await adapter.dispose();
    }
    expect(server.requests.filter((r) => r.method === 'model/list')).toHaveLength(2);
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('refreshes the catalog on a new discovery request rather than caching a previous release', async () => {
    for (const id of ['gpt-previous', 'gpt-new-release']) {
      const child = makeFakeChild();
      mocks.spawnChildren.push(child);
      scriptServer(child).on('model/list', () => ({ data: [row(id)], nextCursor: null }));
      const result = await listHarnessModels({ harness: 'codex', settings: defaultSettings(), runtime, getApiKey: async () => undefined });
      expect(result.error).toBeUndefined();
      expect(result.models.filter((m) => m.provider === 'openai').map((m) => m.id)).toEqual([id]);
    }
    expect(mocks.shutdown).toHaveBeenCalledTimes(2);
  });

  it('stops a repeating cursor and closes the probe rather than looping indefinitely', async () => {
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child).on('model/list', () => ({ data: [row('gpt-partial')], nextCursor: 'repeat' }));
    const result = await listHarnessModels({ harness: 'codex', settings: defaultSettings(), runtime, getApiKey: async () => undefined });
    expect(result.error).toContain('repeated a pagination cursor');
    expect(server.requests.filter((r) => r.method === 'model/list')).toHaveLength(2);
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('uses the live catalog rather than a static list for the exec adapter', async () => {
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    scriptServer(child).on('model/list', () => ({ data: [row('gpt-future-codex')], nextCursor: null }));
    const { ctx } = makeCtx(makeMeta(), defaultSettings());
    const models = await new CodexExecAdapter(ctx).listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-future-codex']);
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('bounds the whole paginated probe and closes it when a page stalls', async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      mocks.spawnChildren.push(child);
      const server = scriptServer(child).on('model/list', (params) => params.cursor
        ? new Promise(() => undefined)
        : { data: [row('gpt-partial')], nextCursor: 'page-2' });
      const pending = listHarnessModels({ harness: 'codex', settings: defaultSettings(), runtime, getApiKey: async () => undefined });
      await vi.advanceTimersByTimeAsync(20_001);
      const result = await pending;
      expect(result.error).toContain('timed out');
      expect(result.models.some((m) => m.id === 'gpt-partial')).toBe(false);
      expect(server.requests.filter((r) => r.method === 'model/list')).toHaveLength(2);
      expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['empty', 'failure'] as const)('retains the exec fallback on an %s response and tears down its probe', async (mode) => {
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    scriptServer(child).on('model/list', () => {
      if (mode === 'failure') throw new Error('unavailable');
      return { data: [], nextCursor: null };
    });
    const { ctx } = makeCtx(makeMeta(), defaultSettings());
    const models = await new CodexExecAdapter(ctx).listModels();
    expect(models).toEqual(CODEX_STATIC_MODELS);
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('labels an empty live catalog as fallback instead of claiming it is up to date', async () => {
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    scriptServer(child);
    const result = await listHarnessModels({ harness: 'codex-exec', settings: defaultSettings(), runtime, getApiKey: async () => undefined });
    expect(result.models).toEqual(CODEX_STATIC_MODELS);
    expect(result.error).toContain('Codex reported no models');
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('reports a failed later page and keeps fallback models instead of returning a partial catalog', async () => {
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    scriptServer(child).on('model/list', (params) => {
      if (params.cursor) throw new Error('catalog unavailable');
      return { data: [row('gpt-partial')], nextCursor: 'page-2' };
    });
    const result = await listHarnessModels({ harness: 'codex', settings: defaultSettings(), runtime, getApiKey: async () => undefined });
    expect(result.error).toContain('catalog unavailable');
    expect(result.models.some((m) => m.id === 'gpt-partial')).toBe(false);
    expect(result.models.length).toBeGreaterThan(0);
    expect(mocks.shutdown).toHaveBeenCalledExactlyOnceWith(child);
  });

  it('offers configured OpenAI-wire provider models for the codex harness', async () => {
    const { models } = await listHarnessModels({
      harness: 'codex',
      settings: settingsWithOpenRouter(),
      runtime: { resolve: () => null } as never,
      getApiKey: async () => undefined
    });
    expect(models.some((m) => m.provider === 'openrouter' && m.id === 'z-ai/glm-4.6')).toBe(true);
  });

  it('leaves codex-exec on the OpenAI catalog, since it cannot register a provider', async () => {
    const { models } = await listHarnessModels({
      harness: 'codex-exec',
      settings: settingsWithOpenRouter(),
      runtime: { resolve: () => null } as never,
      getApiKey: async () => undefined
    });
    expect(models.some((m) => m.provider === 'openrouter')).toBe(false);
  });

  it('does not offer providers Codex cannot speak to', async () => {
    const base = defaultSettings();
    const settings: AppSettings = { ...base, providers: [...base.providers.filter((p) => p.id !== 'openrouter'), openRouterProvider()] };
    const { models } = await listHarnessModels({ harness: 'codex', settings, runtime: { resolve: () => null } as never, getApiKey: async () => undefined });
    expect(models.some((m) => m.provider === 'anthropic')).toBe(false);
  });
});

describe('codex custom provider wiring', () => {
  it('registers the selected model’s provider with the Responses wire API and injects its key', async () => {
    const meta = makeMeta({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
    const { ctx, keys } = makeCtx(meta, settingsWithOpenRouter());
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child);

    const adapter = new CodexAppServerAdapter(ctx);
    await adapter.start();

    const thread = server.requests.find((r) => r.method === 'thread/start');
    expect(thread?.params.model).toBe('z-ai/glm-4.6');
    expect(thread?.params.modelProvider).toBe('openrouter');
    expect(thread?.params.config?.model_providers?.openrouter).toEqual({
      name: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      env_key: 'OPENROUTER_API_KEY',
      wire_api: 'responses'
    });
    expect(mocks.spawnCalls[0].opts.env.OPENROUTER_API_KEY).toBe('sk-openrouter-test');
    expect(keys).toContain('openrouter');
    await adapter.dispose();
  });

  it('scopes the session catalog to the pinned provider so unusable switches are not offered', async () => {
    const meta = makeMeta({ provider: 'openrouter', model: 'z-ai/glm-4.6' });
    const { ctx } = makeCtx(meta, settingsWithOpenRouter());
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    scriptServer(child);

    const adapter = new CodexAppServerAdapter(ctx);
    await adapter.start();
    const models = await adapter.listModels!();

    expect(models.map((m) => m.id)).toEqual(['z-ai/glm-4.6', 'moonshotai/kimi-k2']);
    expect(models.every((m) => m.provider === 'openrouter')).toBe(true);
    await adapter.dispose();
  });

  it('keeps an OpenAI session free of other providers’ keys and entries', async () => {
    const meta = makeMeta({ provider: 'openai', model: 'gpt-5.6-sol' });
    const { ctx, keys } = makeCtx(meta, settingsWithOpenRouter());
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child);

    const adapter = new CodexAppServerAdapter(ctx);
    await adapter.start();

    const thread = server.requests.find((r) => r.method === 'thread/start');
    expect(thread?.params.modelProvider).toBeFalsy();
    expect(thread?.params.config?.model_providers).toBeUndefined();
    expect(mocks.spawnCalls[0].opts.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(keys).not.toContain('openrouter');
    await adapter.dispose();
  });

  it('switches this app\u2019s own server name off in the thread config when the session gets none', async () => {
    const meta = makeMeta();
    const { ctx } = makeCtx(meta, defaultSettings(), ['gitnexus']);
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = scriptServer(child);

    const adapter = new CodexAppServerAdapter(ctx);
    await adapter.start();

    const thread = server.requests.find((r) => r.method === 'thread/start');
    expect(thread?.params.config?.mcp_servers).toEqual({ gitnexus: { enabled: false } });
    await adapter.dispose();
  });
});
