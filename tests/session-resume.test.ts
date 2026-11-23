/**
 * Session-resume-after-restart coverage (issue #136). Persistence is exercised against a real
 * SessionStore + SessionManager (with a stubbed adapter factory), and each harness that has an
 * offline seam gets a focused test proving its resume token reaches that seam or survives a
 * runtime rejection. The live round-trips ship in smoke.live.test.ts behind HARNESS_SMOKE_RESUME.
 *
 * Adapters whose fallback is already covered elsewhere are not duplicated here:
 *   - codex-exec stale resume -> tests/codex-exec-turn-state.test.ts
 *   - acp stale resume        -> tests/acp-turn-state.test.ts
 *   - cursor dead id          -> tests/cursor-harness.test.ts ("a dead id falls back...")
 */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessContext, HarnessAdapter } from '../src/main/harness/types';
import type { HarnessId, HarnessRef, PermissionMode, SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { PiAdapter } from '../src/main/harness/pi';
import { ClaudeAdapter } from '../src/main/harness/claude';
import { NativeAdapter } from '../src/main/harness/native';
import { deferred } from '../src/main/util/async';

type AnyRecord = Record<string, any>;

const mocks = vi.hoisted(() => ({
  spawnChildren: [] as AnyRecord[],
  spawnCalls: [] as { file: string; args: string[]; opts: AnyRecord }[],
  queryCalls: [] as AnyRecord[],
  adapterCalls: [] as { id: HarnessId; ctx: HarnessContext }[]
}));

vi.mock('../src/main/harness/spawn', () => ({
  spawnTool: (file: string, args: string[], opts: AnyRecord) => {
    mocks.spawnCalls.push({ file, args, opts });
    const child = mocks.spawnChildren.shift();
    if (!child) throw new Error('no scripted child process');
    return child;
  },
  shutdownChild: async () => undefined,
  killTree: async () => undefined,
  quoteWin: (arg: string) => arg,
  usesWindowsCommandShim: () => false
}));

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: HarnessId, ctx: HarnessContext) => {
    mocks.adapterCalls.push({ id, ctx });
    return makeStubAdapter();
  }
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: AnyRecord) => {
    mocks.queryCalls.push(args);
    const next = (globalThis as AnyRecord).__nextClaudeQuery as (() => AnyRecord) | undefined;
    return next ? next() : makeFakeClaudeQuery();
  }
}));

function makeStubAdapter(): HarnessAdapter {
  return {
    id: 'native',
    get busy() {
      return false;
    },
    start: async () => undefined,
    send: async () => undefined,
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setEffort: async () => undefined,
    setPermissionMode: async () => undefined,
    dispose: async () => undefined
  } as unknown as HarnessAdapter;
}

function makeFakeClaudeQuery(): AnyRecord {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return {
    close: vi.fn(() => release()),
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    applyFlagSettings: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    [Symbol.asyncIterator]() {
      return (async function* () {
        await done;
      })();
    }
  };
}

let tmpRoot = '';
let sessionCounter = 0;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-resume-'));
});
afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});
const nextSessionDir = (): string => path.join(tmpRoot, `s${++sessionCounter}`);

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
    if (msg.method === undefined) return; // response to a server request: unused here
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

/** Minimal pi RPC peer: answers {type} requests with a response envelope. */
class FakePiServer {
  private buf = '';
  private readonly handlers = new Map<string, (params: AnyRecord) => unknown>();

  constructor(private readonly child: AnyRecord, private readonly ready = true) {
    child.stdin.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
  }

  respond(type: string, data: unknown): this {
    this.handlers.set(type, () => data);
    return this;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx = this.buf.indexOf('\n');
    while (idx >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) {
        const msg = JSON.parse(line) as AnyRecord;
        const data = this.handlers.get(msg.type as string)?.(msg) ?? {};
        if (msg.type === 'get_state' && this.ready) {
          for (const capability of ['approvals', 'tools', 'subagents']) {
            const nonce = mocks.spawnCalls.at(-1)?.opts.env?.VOCS_CODE_PI_NONCE;
            this.child.stdout.write(JSON.stringify({ type: 'extension_ui_request', method: 'notify', id: capability, message: 'VCODE_PI_READY::' + JSON.stringify({ version: 1, nonce, capability, ready: true }) }) + '\n');
          }
        }
        this.child.stdout.write(JSON.stringify({ type: 'response', id: msg.id, success: true, data }) + '\n');
      }
      idx = this.buf.indexOf('\n');
    }
  }
}

interface AdapterHarness {
  ctx: HarnessContext;
  meta: SessionMeta;
  events: SessionEvent[];
  items: Map<string, TranscriptItem>;
  logs: { level: string; message: string }[];
  readJson: ReturnType<typeof vi.fn>;
  writeJson: ReturnType<typeof vi.fn>;
}

function makeAdapterCtx(opts: { harness: HarnessId; ref?: HarnessRef; permissionMode?: PermissionMode; runtime?: AnyRecord }): AdapterHarness {
  const readJson = vi.fn(async (_name: string): Promise<unknown> => null);
  const writeJson = vi.fn(async (_name: string, _data: unknown): Promise<void> => undefined);
  const meta: SessionMeta = {
    id: `s_${opts.harness.replace('-', '_')}`,
    title: 'Resume test',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: opts.harness, projectRoot: '/proj', permissionMode: opts.permissionMode ?? 'ask' },
    cwd: '/proj',
    status: 'idle',
    harnessRef: { ...(opts.ref ?? {}) },
    usage: emptyUsage()
  };
  const events: SessionEvent[] = [];
  const items = new Map<string, TranscriptItem>();
  const logs: { level: string; message: string }[] = [];
  const ctx = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => defaultSettings(),
    runtime: opts.runtime ?? (opts.harness === 'claude'
      ? { resolve: () => ({ path: process.execPath, source: 'system' }) }
      : { resolve: () => null, resource: () => '/tmp/resource' }) as never,
    sessionDir: nextSessionDir(),
    permissionMode: () => meta.config.permissionMode,
    effort: () => undefined,
    getApiKey: async () => undefined,
    emit: (event: SessionEvent) => {
      events.push(event);
      if (event.type === 'item.upsert') items.set(event.item.id, event.item);
    },
    requestApproval: async () => ({ optionId: 'deny' }),
    updateRef: (patch: Partial<HarnessRef>) => {
      meta.harnessRef = { ...meta.harnessRef, ...patch };
    },
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    log: (level: string, message: string) => logs.push({ level, message }),
    readJson,
    writeJson,
    mcpServers: async () => [],
    ownedMcpIds: () => []
  } as unknown as HarnessContext;
  return { ctx, meta, events, items, logs, readJson, writeJson };
}

const infoWithLevel = (items: Map<string, TranscriptItem>, level: 'info' | 'warn' | 'error'): string[] =>
  [...items.values()].filter((i): i is Extract<TranscriptItem, { kind: 'info' }> => i.kind === 'info' && i.level === level).map((i) => i.text);

// ---------------------------------------------------------------------------------------------
// 1. Persistence round-trip: store, then a fresh manager booted from the persisted meta.
// ---------------------------------------------------------------------------------------------

const REFS_BY_HARNESS: Record<HarnessId, HarnessRef> = {
  claude: { claudeSessionId: 'claude-session-1' },
  codex: { codexThreadId: 'codex-thread-1' },
  'codex-exec': { codexThreadId: 'codex-exec-thread-1' },
  cursor: { cursorAgentId: 'cursor-agent-1' },
  pi: { piSessionFile: '/sessions/pi/pi-session-1.jsonl' },
  acp: { acpSessionId: 'acp-session-1' },
  antigravity: { acpSessionId: 'antigravity-session-1' },
  native: { nativeHistory: true }
};

function persistedMeta(harness: HarnessId, ref: HarnessRef): SessionMeta {
  return {
    id: `s_${harness.replace('-', '_')}`,
    title: 'Persisted session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    config: { harness, projectRoot: '/proj', permissionMode: 'ask' },
    cwd: '/proj',
    status: 'idle',
    harnessRef: { ...ref },
    usage: emptyUsage()
  };
}

function makeManagerDeps(store: SessionStore): SessionManagerDeps {
  return {
    store,
    settings: { get: () => defaultSettings() } as never,
    runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn()
  };
}

describe('session resume persistence', () => {
  it('revokes memory access at Stop and does not let a retired runtime mint another grant', async () => {
    const home = path.join(tmpRoot, 'memory-runtime');
    const store = new SessionStore(home);
    await store.load();
    const meta = persistedMeta('native', {});
    meta.cwd = meta.config.projectRoot = home;
    await store.upsert(meta);
    const settings = defaultSettings();
    settings.mcpDisabledBuiltins = ['gitnexus', 'cua-driver'];
    let serial = 0;
    const attach = vi.fn((_id: string) => ({ url: 'http://127.0.0.1:14141/call', token: `test-grant-${++serial}` }));
    const revoke = vi.fn();
    const manager = new SessionManager({ ...makeManagerDeps(store), settings: { get: () => settings } as never, memoryServerPath: '/vocs-memory.mjs', memoryGateway: attach, revokeMemoryGateway: revoke });
    try {
      await manager.send(meta.id, { text: 'Start one runtime' });
      const first = mocks.adapterCalls.at(-1)!.ctx;
      await expect(first.mcpServers()).resolves.toMatchObject([{ def: { id: 'vocs-memory', env: { VOCS_MEMORY_GATEWAY_TOKEN: 'test-grant-1' } } }]);
      await manager.stop(meta.id);
      expect(revoke).toHaveBeenCalledExactlyOnceWith(meta.id);
      await expect(first.mcpServers()).rejects.toThrow(/no longer current/);
      expect(attach).toHaveBeenCalledTimes(1);
      await manager.send(meta.id, { text: 'Start another runtime' });
      await expect(mocks.adapterCalls.at(-1)!.ctx.mcpServers()).resolves.toMatchObject([{ def: { env: { VOCS_MEMORY_GATEWAY_TOKEN: 'test-grant-2' } } }]);
      expect(attach).toHaveBeenCalledTimes(2);
    } finally {
      await manager.stopAll();
    }
  });

  it('round-trips every harness ref through the store and a fresh manager', async () => {
    const dir = path.join(tmpRoot, 'store-roundtrip');
    const store = new SessionStore(dir);
    await store.load();
    for (const [harness, ref] of Object.entries(REFS_BY_HARNESS) as [HarnessId, HarnessRef][]) {
      await store.upsert(persistedMeta(harness, ref));
    }

    // A restart is a brand-new store reading the same on-disk index.
    const freshStore = new SessionStore(dir);
    const loaded = await freshStore.load();
    expect(loaded).toHaveLength(Object.keys(REFS_BY_HARNESS).length);
    for (const [harness, ref] of Object.entries(REFS_BY_HARNESS) as [HarnessId, HarnessRef][]) {
      expect(loaded.find((s) => s.config.harness === harness)?.harnessRef).toEqual(ref);
    }

    // A fresh manager booted from that index hands the adapter a ctx still carrying the token.
    const manager = new SessionManager(makeManagerDeps(freshStore));
    for (const [harness, ref] of Object.entries(REFS_BY_HARNESS) as [HarnessId, HarnessRef][]) {
      mocks.adapterCalls.length = 0;
      const id = `s_${harness.replace('-', '_')}`;
      await manager.send(id, { text: 'continue' });
      expect(mocks.adapterCalls).toHaveLength(1);
      expect(mocks.adapterCalls[0].id).toBe(harness);
      expect(mocks.adapterCalls[0].ctx.session().harnessRef).toEqual(ref);
    }
  });

  it('keeps automated turns and unsupported modes out of Antigravity dispatch', async () => {
    const store = new SessionStore(path.join(tmpRoot, 'antigravity-interactive'));
    await store.load();
    const meta = persistedMeta('antigravity', REFS_BY_HARNESS.antigravity);
    await store.upsert(meta);
    const manager = new SessionManager(makeManagerDeps(store));
    const control = {
      operationId: 'test', inputId: 'u_test', beforeStart: vi.fn(), startAllowed: vi.fn(), beforeDispatch: vi.fn()
    };
    mocks.adapterCalls.length = 0;

    await expect(manager.runControlled(meta.id, { text: 'Say hello' }, control)).rejects.toThrow('direct user prompts');
    await expect(manager.goal(meta.id, 'set', { objective: 'Say hello' })).rejects.toThrow('direct user prompts');
    await expect(manager.setPermissionMode(meta.id, 'yolo' as PermissionMode)).rejects.toThrow('does not offer that permission mode');
    expect(control.beforeStart).not.toHaveBeenCalled();
    expect(mocks.adapterCalls).toHaveLength(0);
    expect(await manager.transcript(meta.id)).toEqual([]);
    expect(manager.get(meta.id)).toMatchObject({ config: { permissionMode: 'ask' }, status: 'idle' });
  });

  it('holds Antigravity turn admission until a permission change is saved', async () => {
    const store = new SessionStore(path.join(tmpRoot, 'antigravity-permissions'));
    await store.load();
    const meta = persistedMeta('antigravity', REFS_BY_HARNESS.antigravity);
    await store.upsert(meta);
    const manager = new SessionManager(makeManagerDeps(store));
    const writing = deferred<void>();
    const finish = deferred<void>();
    const upsert = store.upsert.bind(store);
    vi.spyOn(store, 'upsert').mockImplementationOnce(async (value) => {
      writing.resolve();
      await finish.promise;
      return upsert(value);
    });
    mocks.adapterCalls.length = 0;

    const change = manager.setPermissionMode(meta.id, 'plan');
    await writing.promise;
    try {
      await expect(manager.send(meta.id, { text: 'While permissions change' })).rejects.toThrow('permission update');
      expect(mocks.adapterCalls).toHaveLength(0);
      expect(await manager.transcript(meta.id)).toEqual([]);
    } finally {
      finish.resolve();
    }
    expect((await change).config.permissionMode).toBe('plan');
    await manager.send(meta.id, { text: 'After permissions change' });
    expect(mocks.adapterCalls).toHaveLength(1);
    expect(mocks.adapterCalls[0].ctx.permissionMode()).toBe('plan');
  });

  it.each(['accept-edits', 'auto', 'full-auto'] as const)('saves Antigravity %s and dispatches the next turn under it', async (mode) => {
    const store = new SessionStore(path.join(tmpRoot, `antigravity-${mode}`));
    await store.load();
    const meta = persistedMeta('antigravity', REFS_BY_HARNESS.antigravity);
    await store.upsert(meta);
    const manager = new SessionManager(makeManagerDeps(store));
    mocks.adapterCalls.length = 0;

    expect((await manager.setPermissionMode(meta.id, mode)).config.permissionMode).toBe(mode);
    await manager.send(meta.id, { text: 'Go' });
    expect(mocks.adapterCalls).toHaveLength(1);
    expect(mocks.adapterCalls[0].ctx.permissionMode()).toBe(mode);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Per-adapter resume seams / stale-resume fallback.
// ---------------------------------------------------------------------------------------------

describe('codex app-server resume', () => {
  beforeEach(() => {
    mocks.spawnChildren.length = 0;
    mocks.spawnCalls.length = 0;
  });

  it('accepts restored usage while the resume handshake is pending', async ({ onTestFinished }) => {
    const threadId = 'saved-thread';
    const h = makeAdapterCtx({ harness: 'codex', ref: { codexThreadId: threadId }, runtime: { resolve: () => ({ name: 'codex', path: 'C:/fake/codex.exe' }) } });
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = new FakeJsonRpcServer(child).on('thread/resume', () => {
      const tokenUsage = {
        total: { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
        last: { totalTokens: 15 }, modelContextWindow: 1000
      };
      child.stdout.write(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage } }) + '\n');
      return { thread: { id: threadId }, model: 'gpt-5', modelProvider: 'openai', reasoningEffort: null };
    });
    const adapter = new CodexAppServerAdapter(h.ctx);
    onTestFinished(() => adapter.dispose());
    await adapter.start();

    expect(server.requests.some((r) => r.method === 'thread/start')).toBe(false);
    expect(h.events.filter((e) => e.type === 'usage')).toMatchObject([{ totals: { inputTokens: 10, outputTokens: 5, contextTokens: 15 } }]);
  });

  it('warns and starts a fresh thread when thread/resume is rejected', async () => {
    const h = makeAdapterCtx({ harness: 'codex', ref: { codexThreadId: 'stale' }, runtime: { resolve: () => ({ name: 'codex', path: 'C:/fake/codex.exe' }) } });
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    const server = new FakeJsonRpcServer(child);
    server.on('initialize', () => ({}));
    server.on('thread/resume', () => {
      throw new Error('thread not found');
    });
    server.on('thread/start', () => ({ thread: { id: 'fresh-thread' }, model: 'gpt-5', modelProvider: 'openai', reasoningEffort: null }));
    server.on('model/list', () => ({ data: [] }));
    server.on('thread/unsubscribe', () => ({}));

    const adapter = new CodexAppServerAdapter(h.ctx);
    await adapter.start();

    expect(server.requests.find((r) => r.method === 'thread/resume')?.params.threadId).toBe('stale');
    expect(server.requests.some((r) => r.method === 'thread/start')).toBe(true);
    expect(h.meta.harnessRef.codexThreadId).toBe('fresh-thread');
    expect(infoWithLevel(h.items, 'warn').some((t) => /could not resume codex thread/i.test(t))).toBe(true);
    expect(h.events.some((e) => e.type === 'status' && e.status === 'idle')).toBe(true);
    await adapter.dispose();
  });
});

describe('pi resume seam', () => {
  beforeEach(() => {
    mocks.spawnChildren.length = 0;
    mocks.spawnCalls.length = 0;
  });

  it('refuses a runtime without the required extension handshake before sending any prompt', async () => {
    const h = makeAdapterCtx({ harness: 'pi', runtime: { resolve: () => ({ name: 'pi', path: 'C:/fake/pi.exe' }), resource: () => 'C:/fake/extension.ts' } });
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    new FakePiServer(child, false).respond('get_state', {});
    const commands: string[] = [];
    child.stdin.on('data', (data: Buffer) => commands.push(data.toString('utf8')));
    const adapter = new PiAdapter(h.ctx);
    await expect(adapter.send({ text: 'Must not execute' })).rejects.toThrow(/Missing readiness/);
    expect(commands.some((c) => c.includes('"type":"prompt"'))).toBe(false);
    expect(h.events.some((e) => e.type === 'status' && e.status === 'idle')).toBe(false);
  });

  it('passes the stored session file to the CLI as --session', async () => {
    const h = makeAdapterCtx({
      harness: 'pi',
      ref: { piSessionFile: '/sessions/pi/persisted.jsonl' },
      runtime: { resolve: () => ({ name: 'pi', path: 'C:/fake/pi.exe' }), resource: () => 'C:/fake/approvals.ts' }
    });
    const child = makeFakeChild();
    mocks.spawnChildren.push(child);
    new FakePiServer(child).respond('get_state', { sessionFile: '/sessions/pi/persisted.jsonl', model: { provider: 'anthropic', id: 'claude-sonnet' }, thinkingLevel: 'medium' }).respond('get_available_models', { models: [] });

    const adapter = new PiAdapter(h.ctx);
    await adapter.start();

    expect(mocks.spawnCalls).toHaveLength(1);
    expect(mocks.spawnCalls[0].args).toEqual(expect.arrayContaining(['--session', '/sessions/pi/persisted.jsonl']));
    expect(h.meta.harnessRef.piSessionFile).toBe('/sessions/pi/persisted.jsonl');
    await adapter.dispose();
  });
});

describe('claude resume seam', () => {
  beforeEach(() => {
    mocks.queryCalls.length = 0;
    (globalThis as AnyRecord).__nextClaudeQuery = undefined;
  });

  afterEach(() => {
    (globalThis as AnyRecord).__nextClaudeQuery = undefined;
  });

  it('passes the stored session id to the SDK as options.resume', async () => {
    const h = makeAdapterCtx({ harness: 'claude', ref: { claudeSessionId: 'claude-abc' } });
    (globalThis as AnyRecord).__nextClaudeQuery = () => makeFakeClaudeQuery();
    const adapter = new ClaudeAdapter(h.ctx);
    await adapter.start();
    expect(mocks.queryCalls).toHaveLength(1);
    expect(mocks.queryCalls[0].options.resume).toBe('claude-abc');
    expect(mocks.queryCalls[0].options.forkSession).toBeUndefined();
    await adapter.dispose();
  });

  it('resumes on the model version the session saved, whatever the last process reported', async () => {
    const h = makeAdapterCtx({ harness: 'claude', ref: { claudeSessionId: 'claude-abc' } });
    // The New Session dialog saves Claude's recommendation as the concrete id it resolved to.
    h.meta.config.model = { provider: 'anthropic', model: 'claude-opus-5-5[1m]' };
    h.meta.activeModel = { provider: 'anthropic', model: 'claude-opus-6' };
    (globalThis as AnyRecord).__nextClaudeQuery = () => makeFakeClaudeQuery();
    const adapter = new ClaudeAdapter(h.ctx);
    await adapter.start();
    expect(mocks.queryCalls).toHaveLength(1);
    expect(mocks.queryCalls[0].options).toMatchObject({ resume: 'claude-abc', model: 'claude-opus-5-5[1m]' });
    await adapter.dispose();
  });

  it('honors forkOnResume by forking once and clearing the flag', async () => {
    const h = makeAdapterCtx({ harness: 'claude', ref: { claudeSessionId: 'claude-abc', forkOnResume: true } });
    (globalThis as AnyRecord).__nextClaudeQuery = () => makeFakeClaudeQuery();
    const adapter = new ClaudeAdapter(h.ctx);
    await adapter.start();
    expect(mocks.queryCalls[0].options.resume).toBe('claude-abc');
    expect(mocks.queryCalls[0].options.forkSession).toBe(true);
    expect(h.meta.harnessRef.forkOnResume).toBe(false);
    await adapter.dispose();
  });
});

describe('native resume seam', () => {
  it('reads and repairs the persisted history file on start', async () => {
    const h = makeAdapterCtx({ harness: 'native' });
    const saved = { version: 1, messages: [{ role: 'assistant', text: 'working', toolCalls: [{ id: 'tool-1', name: 'bash', args: { command: 'ls' } }] }] };
    h.readJson.mockImplementation(async (name: string) => (name === 'native-history.json' ? saved : null));

    const adapter = new NativeAdapter(h.ctx);
    await adapter.start();

    expect(h.readJson).toHaveBeenCalledWith('native-history.json');
    expect(h.writeJson).toHaveBeenCalledWith(
      'native-history.json',
      expect.objectContaining({ version: 2, messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', toolCallId: 'tool-1' })]) })
    );
    expect(h.meta.harnessRef.nativeHistory).toBe(true);
    expect(h.events.some((e) => e.type === 'status' && e.status === 'idle')).toBe(true);
    await adapter.dispose();
  });

  it('restores the checkpoint before a user message without retaining later context', async () => {
    const h = makeAdapterCtx({ harness: 'native' });
    const saved = {
      version: 2,
      messages: [{ role: 'user', text: 'before' }, { role: 'assistant', text: 'old branch', toolCalls: [] }],
      boundaries: { u_edit: [{ role: 'user', text: 'before' }] }
    };
    h.readJson.mockImplementation(async (name: string) => (name === 'native-history.json' ? saved : null));

    const adapter = new NativeAdapter(h.ctx);
    await adapter.start();

    await expect(adapter.rewindToUserMessage('u_edit')).resolves.toBe(true);
    expect(h.writeJson).toHaveBeenLastCalledWith(
      'native-history.json',
      expect.objectContaining({ version: 2, messages: [{ role: 'user', text: 'before' }], boundaries: {} })
    );
    await adapter.dispose();
  });
});
