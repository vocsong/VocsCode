/**
 * Offline tests for the codex-exec adapter (issue #135). The @openai/codex-sdk is mocked with a
 * scripted Thread so event normalization, usage accumulation, turn-state tracking, stale-resume
 * fallback and interrupt are all exercised without network access or the Codex CLI.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRef, SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import type { HarnessContext } from '../src/main/harness/types';
import { emptyUsage } from '../src/main/models/static-models';
import { CodexExecAdapter } from '../src/main/harness/codex-exec';

type AnyRecord = Record<string, any>;

const sdk = vi.hoisted(() => ({
  codexOptions: [] as AnyRecord[],
  startCalls: [] as AnyRecord[],
  resumeCalls: [] as { id: string; opts: AnyRecord }[]
}));

vi.mock('@openai/codex-sdk', () => {
  class Codex {
    constructor(opts: AnyRecord) {
      sdk.codexOptions.push(opts);
    }
    startThread(opts: AnyRecord) {
      sdk.startCalls.push(opts);
      return scriptedThread();
    }
    resumeThread(id: string, opts: AnyRecord) {
      sdk.resumeCalls.push({ id, opts });
      return scriptedThread();
    }
  }
  return { Codex };
});

interface ThreadSpec {
  id: string;
  events?: AnyRecord[];
  error?: Error;
  gate?: Promise<void>;
  waitForAbort?: boolean;
}

const threadQueue: ThreadSpec[] = [];

function scriptThreads(specs: ThreadSpec[]): void {
  threadQueue.length = 0;
  threadQueue.push(...specs);
  (globalThis as AnyRecord).__nextCodexThread = () => {
    const spec = threadQueue.shift();
    if (!spec) throw new Error('scripted codex threads exhausted');
    return makeThread(spec);
  };
}

function scriptedThread(): AnyRecord {
  const next = (globalThis as AnyRecord).__nextCodexThread as (() => AnyRecord) | undefined;
  if (!next) throw new Error('no scripted codex thread');
  return next();
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

async function* plainEvents(spec: ThreadSpec, signal?: AbortSignal): AsyncGenerator<AnyRecord> {
  for (const ev of spec.events ?? []) {
    if (spec.gate) await spec.gate;
    if (signal?.aborted) throw abortError();
    yield ev;
  }
}

/** A generator that parks on the abort signal, so interrupt() settles the turn. */
async function* abortableEvents(spec: ThreadSpec, signal?: AbortSignal): AsyncGenerator<AnyRecord> {
  yield { type: 'thread.started', thread_id: spec.id };
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  throw abortError();
}

function makeThread(spec: ThreadSpec): AnyRecord {
  return {
    id: spec.id,
    runStreamed: vi.fn(async (_input: unknown, turnOpts?: { signal?: AbortSignal }) => {
      if (spec.error) throw spec.error;
      return { events: spec.waitForAbort ? abortableEvents(spec, turnOpts?.signal) : plainEvents(spec, turnOpts?.signal) };
    })
  };
}

function makeCtx(overrides: Partial<SessionMeta> = {}): { ctx: HarnessContext; meta: SessionMeta; events: SessionEvent[]; items: Map<string, TranscriptItem>; logs: { level: string; message: string }[] } {
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'codex-exec', projectRoot: '.', permissionMode: 'auto' },
    cwd: '/proj',
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage(),
    ...overrides
  };
  const events: SessionEvent[] = [];
  const items = new Map<string, TranscriptItem>();
  const logs: { level: string; message: string }[] = [];
  const ctx = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => ({ claude: { settingSources: [], useProviderKey: false }, pi: { extraArgs: [] }, providers: [] }) as never,
    runtime: { resolve: () => null } as never,
    sessionDir: '/tmp/s1',
    permissionMode: () => meta.config.permissionMode,
    effort: () => undefined,
    getApiKey: async () => undefined,
    emit: (event: SessionEvent) => {
      events.push(event);
      if (event.type === 'item.upsert') items.set(event.item.id, event.item);
      if (event.type === 'item.delta') {
        const it = items.get(event.id);
        if (it?.kind === 'assistant') {
          if (event.textDelta) it.text += event.textDelta;
          if (event.thinkingDelta) it.thinking = (it.thinking ?? '') + event.thinkingDelta;
        }
      }
    },
    requestApproval: async () => ({ optionId: 'deny' }) as never,
    updateRef: (patch: Partial<HarnessRef>) => {
      meta.harnessRef = { ...meta.harnessRef, ...patch };
    },
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    log: (level: string, message: string) => logs.push({ level, message }),
    readJson: async () => null,
    writeJson: async () => undefined,
    mcpServers: async () => [],
    ownedMcpIds: () => []
  } as unknown as HarnessContext;
  return { ctx, meta, events, items, logs };
}

/** The shim npm writes for `@openai/codex`: it runs the package's Node launcher, not a native binary. */
async function writeCodexShim(dir: string): Promise<string> {
  const shim = path.join(dir, 'codex.cmd');
  await fs.writeFile(shim, '@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  return shim;
}

/** The platform package npm installs under `@openai/codex`, holding the native binary the launcher spawns. */
async function writeCodexPlatformBinary(codexPkg: string): Promise<string> {
  const triples: Record<string, string> = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' };
  const triple = triples[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`no Codex target triple for ${process.platform}-${process.arch}`);
  const name = `@openai/codex-${process.platform}-${process.arch}`;
  const platformPkg = path.join(codexPkg, 'node_modules', ...name.split('/'));
  const exe = path.join(platformPkg, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(path.join(codexPkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.0.0' }));
  await fs.writeFile(path.join(platformPkg, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  await fs.writeFile(exe, '');
  return exe;
}

const turnItems = (items: Map<string, TranscriptItem>): Extract<TranscriptItem, { kind: 'turn' }>[] => [...items.values()].filter((i): i is Extract<TranscriptItem, { kind: 'turn' }> => i.kind === 'turn');

const usageEvent = (events: SessionEvent[]): Extract<SessionEvent, { type: 'usage' }> | undefined => [...events].reverse().find((e): e is Extract<SessionEvent, { type: 'usage' }> => e.type === 'usage');

describe('codex-exec adapter', () => {
  beforeEach(() => {
    sdk.codexOptions.length = 0;
    sdk.startCalls.length = 0;
    sdk.resumeCalls.length = 0;
    threadQueue.length = 0;
    (globalThis as AnyRecord).__nextCodexThread = undefined;
  });

  afterEach(() => {
    (globalThis as AnyRecord).__nextCodexThread = undefined;
  });

  it('starts a fresh thread and normalizes items, ref and usage', async () => {
    const { ctx, meta, events, items } = makeCtx();
    scriptThreads([
      {
        id: 'thread-1',
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'turn.started' },
          { type: 'item.started', item: { id: 'm1', type: 'agent_message', text: 'Hel' } },
          { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Hello' } },
          { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Hello' } },
          { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls -la', aggregated_output: '', status: 'in_progress' } },
          { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls -la', aggregated_output: 'file.txt', status: 'completed', exit_code: 0 } },
          { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking' } },
          { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 4, cache_write_input_tokens: 1, reasoning_output_tokens: 2 } }
        ]
      }
    ]);
    const a = new CodexExecAdapter(ctx);
    await a.start();
    // start() only creates the thread; the ref is written once the first turn streams.
    expect(sdk.resumeCalls).toHaveLength(0);
    expect(sdk.startCalls).toHaveLength(1);

    await a.send({ text: 'do it' });
    expect(a.busy).toBe(true);
    expect(events.some((e) => e.type === 'status' && e.status === 'running')).toBe(true);
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(events.at(-1)).toEqual({ type: 'status', status: 'idle' });
    expect(meta.harnessRef.codexThreadId).toBe('thread-1');

    const assistant = items.get('m1');
    expect(assistant && assistant.kind === 'assistant' && assistant.text).toBe('Hello');
    expect(assistant && assistant.kind === 'assistant' && assistant.streaming).toBe(false);
    const tool = items.get('c1');
    expect(tool && tool.kind === 'tool' && [tool.name, tool.status, tool.exitCode, tool.output]).toEqual(['bash', 'done', 0, 'file.txt']);
    const reasoning = items.get('r1');
    expect(reasoning && reasoning.kind === 'assistant' && reasoning.thinking).toBe('thinking');

    // input_tokens includes the cached subset: input is the uncached remainder (10 - 4), while the
    // cached 4 are counted once as cache reads so hit rates and costs do not bill them twice.
    expect(usageEvent(events)?.totals).toMatchObject({ inputTokens: 6, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, reasoningTokens: 2, turns: 1 });
    const turn = turnItems(items).at(-1);
    expect(turn && [turn.status, turn.usage?.inputTokens, turn.usage?.outputTokens]).toEqual(['completed', 6, 5]);
    await a.dispose();
  });

  it('records failed turns and error info items', async () => {
    const { ctx, items } = makeCtx();
    scriptThreads([
      {
        id: 't1',
        events: [
          { type: 'thread.started', thread_id: 't1' },
          { type: 'error', message: 'stream blew up' },
          { type: 'turn.failed', error: { message: 'model refused' } }
        ]
      }
    ]);
    const a = new CodexExecAdapter(ctx);
    await a.start();
    await a.send({ text: 'x' });
    await vi.waitFor(() => expect(a.busy).toBe(false));

    const info = [...items.values()].find((i): i is Extract<TranscriptItem, { kind: 'info' }> => i.kind === 'info' && i.level === 'error');
    expect(info?.text).toBe('stream blew up');
    const turn = turnItems(items).at(-1);
    expect(turn && [turn.status, turn.error]).toEqual(['failed', 'model refused']);
    await a.dispose();
  });

  it('clears a stale thread id, warns, and retries once with a fresh thread', async () => {
    const { ctx, meta, events, items, logs } = makeCtx();
    meta.harnessRef.codexThreadId = 'stale-thread';
    scriptThreads([
      { id: 'stale-thread', error: new Error('thread not found') },
      {
        id: 'fresh-thread',
        events: [
          { type: 'thread.started', thread_id: 'fresh-thread' },
          { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'recovered' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }
        ]
      }
    ]);
    const a = new CodexExecAdapter(ctx);
    await a.start();
    expect(sdk.resumeCalls.map((r) => r.id)).toEqual(['stale-thread']);

    await a.send({ text: 'continue' });
    await vi.waitFor(() => expect(a.busy).toBe(false));

    expect(sdk.startCalls).toHaveLength(1);
    expect(meta.harnessRef.codexThreadId).toBe('fresh-thread');
    expect(logs.some((l) => l.level === 'warn' && /resume failed/i.test(l.message))).toBe(true);
    expect(items.get('m1') && (items.get('m1') as Extract<TranscriptItem, { kind: 'assistant' }>).text).toBe('recovered');
    expect(turnItems(items).at(-1)?.status).toBe('completed');
    await a.dispose();
  });

  it('is busy and running through a gated turn, then idle when it settles', async () => {
    const { ctx, events } = makeCtx();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    scriptThreads([
      {
        id: 't1',
        gate,
        events: [
          { type: 'thread.started', thread_id: 't1' },
          { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }
        ]
      }
    ]);
    const a = new CodexExecAdapter(ctx);
    await a.start();
    await a.send({ text: 'slow' });
    expect(a.busy).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'status', status: 'running' });
    release();
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(events.at(-1)).toEqual({ type: 'status', status: 'idle' });
    await a.dispose();
  });

  it('interrupt aborts the stream and records an interrupted turn', async () => {
    const { ctx, items } = makeCtx();
    scriptThreads([{ id: 't1', waitForAbort: true }]);
    const a = new CodexExecAdapter(ctx);
    await a.start();
    await a.send({ text: 'long' });
    expect(a.busy).toBe(true);
    await a.interrupt();
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(turnItems(items).at(-1)?.status).toBe('interrupted');
    await a.dispose();
  });

  it('prices a completed turn from the model catalog instead of reporting no spend', async () => {
    const { ctx, events, items } = makeCtx({ config: { harness: 'codex-exec', projectRoot: '.', permissionMode: 'auto', model: { provider: 'openai', model: 'gpt-5.6-luna' } } });
    scriptThreads([
      {
        id: 't1',
        events: [
          { type: 'thread.started', thread_id: 't1' },
          { type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 400, cache_write_input_tokens: 100, reasoning_output_tokens: 50 } }
        ]
      }
    ]);
    const a = new CodexExecAdapter(ctx);
    await a.start();
    await a.send({ text: 'go' });
    await vi.waitFor(() => expect(a.busy).toBe(false));

    // 600 uncached in @ $0.20/M + 200 out @ $1.20/M + 400 cache read @ $0.02/M + 100 cache write @ $0.25/M.
    const expected = (600 * 0.2 + 200 * 1.2 + 400 * 0.02 + 100 * 0.25) / 1_000_000;
    const turn = turnItems(items).at(-1);
    expect(turn?.costUsd).toBeCloseTo(expected, 10);
    expect(turn?.usage?.costUsd).toBeCloseTo(expected, 10);
    // The spend the session header and the analytics rollup read is the running total, not the row.
    expect(usageEvent(events)?.totals.costUsd).toBeCloseTo(expected, 10);
    await a.dispose();
  });

  // An app-runtime install of Codex is an npm `codex.cmd` shim. Running the SDK-bundled binary in
  // its place ran an older Codex than the one the model picker listed, so a model only the newer
  // install knew was rejected ("model is not supported when using Codex with a ChatGPT account").
  it('runs the native binary behind an npm codex.cmd shim instead of the SDK-bundled one', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-shim-'));
    try {
      const shim = await writeCodexShim(runtimeDir);
      const native = await writeCodexPlatformBinary(path.join(runtimeDir, 'node_modules', '@openai', 'codex'));
      const { ctx, logs } = makeCtx();
      (ctx as AnyRecord).runtime = { resolve: () => ({ path: shim, source: 'app-runtime' }), runtimePaths: { appRoot: runtimeDir } };
      scriptThreads([{ id: 't1', events: [] }]);
      const a = new CodexExecAdapter(ctx);
      await a.start();

      expect(sdk.codexOptions.at(-1)?.codexPathOverride).toBe(native);
      expect(logs.some((l) => l.message.includes(native) && l.message.includes(shim))).toBe(true);
      await a.dispose();
    } finally {
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
  });

  it('prices a turn at the rates of the model in use when the model changes mid-session', async () => {
    const { ctx, items } = makeCtx({ config: { harness: 'codex-exec', projectRoot: '.', permissionMode: 'auto', model: { provider: 'openai', model: 'gpt-5.6-luna' } } });
    const usage = { input_tokens: 100, output_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 };
    scriptThreads([
      { id: 't1', events: [{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.completed', usage }] },
      { id: 't1', events: [{ type: 'turn.completed', usage }] }
    ]);
    const a = new CodexExecAdapter(ctx);
    await a.start();
    await a.send({ text: 'one' });
    await vi.waitFor(() => expect(a.busy).toBe(false));

    await a.setModel({ provider: 'openai', model: 'gpt-5.6-sol' });
    await a.send({ text: 'two' });
    await vi.waitFor(() => expect(a.busy).toBe(false));

    // Luna is $0.20/$1.20 per M, Sol $5/$30: the second turn must not keep billing at the old rate.
    const costs = turnItems(items).map((t) => t.costUsd ?? 0);
    expect(costs[0]).toBeCloseTo((100 * 0.2 + 100 * 1.2) / 1_000_000, 10);
    expect(costs[1]).toBeCloseTo((100 * 5 + 100 * 30) / 1_000_000, 10);
    await a.dispose();
  });
});
