/**
 * Cursor harness adapter tests. The @cursor/sdk module is mocked with a scripted fake
 * (Agent.create/resume, Run stream/steer/cancel, Cursor.models.list) so the adapter's
 * event normalization, permission-mode mapping, steering and resume behavior are all
 * exercised offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta, TranscriptItem, UsageTotals } from '../src/shared/types';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import { defaultSettings } from '../src/main/settings';
import { CURSOR_STATIC_MODELS, emptyUsage } from '../src/main/models/static-models';
import { CursorAdapter } from '../src/main/harness/cursor';
import { errorMessage } from '../src/main/util/async';

type AnyRecord = Record<string, any>;

const sdk = vi.hoisted(() => {
  class AgentBusyError extends Error {}
  return {
    creates: [] as AnyRecord[],
    resumes: [] as { id: string; opts: AnyRecord }[],
    sends: [] as { msg: AnyRecord; opts: AnyRecord; agentId: string }[],
    modelsImpl: null as (() => Promise<AnyRecord[]>) | null,
    AgentBusyError
  };
});

vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: async (opts: AnyRecord) => {
      sdk.creates.push(opts);
      const agentId = `local-agent-${sdk.creates.length}`;
      return {
        agentId,
        close: vi.fn(),
        send: async (msg: AnyRecord, sendOpts: AnyRecord) => {
          sdk.sends.push({ msg, opts: sendOpts, agentId });
          const run = (globalThis as AnyRecord).__nextRun?.() ?? failFast('no scripted run');
          return run;
        }
      };
    },
    resume: async (id: string, opts: AnyRecord) => {
      if ((globalThis as AnyRecord).__resumeFails) throw new Error('agent not found');
      sdk.resumes.push({ id, opts });
      const agentId = `resumed-${sdk.resumes.length}`;
      return {
        agentId,
        close: vi.fn(),
        send: async (msg: AnyRecord, sendOpts: AnyRecord) => {
          sdk.sends.push({ msg, opts: sendOpts, agentId });
          const run = (globalThis as AnyRecord).__nextRun?.() ?? failFast('no scripted run');
          return run;
        }
      };
    }
  },
  Cursor: {
    models: {
      list: async (opts?: AnyRecord) => {
        (globalThis as AnyRecord).__lastModelsCall = opts;
        if (!sdk.modelsImpl) return [];
        return sdk.modelsImpl();
      }
    }
  },
  AgentBusyError: sdk.AgentBusyError
}));

function failFast(m: string): never {
  throw new Error(m);
}

// ---- fake run ----

interface FakeRun {
  id: string;
  status: 'running' | 'finished' | 'error' | 'cancelled';
  error?: { message: string };
  script: AnyRecord[];
  gate?: Promise<void>;
  steerCalls: string[];
  steerAck?: 'complete_delivered' | 'revert_to_followup' | 'throw';
  cancelCalls: number;
  stream(): AsyncGenerator<AnyRecord, void>;
  cancel(): Promise<void>;
  steer(text: string): Promise<string>;
}

function makeRun(script: AnyRecord[], opts: { gate?: Promise<void>; status?: FakeRun['status']; error?: string; steerAck?: FakeRun['steerAck'] } = {}): FakeRun {
  const run: FakeRun = {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    status: opts.status ?? 'finished',
    error: opts.error ? { message: opts.error } : undefined,
    script,
    gate: opts.gate,
    steerCalls: [],
    steerAck: opts.steerAck,
    cancelCalls: 0,
    async *stream() {
      for (const m of script) {
        if (run.gate) await run.gate;
        yield m;
      }
    },
    async cancel() {
      run.cancelCalls += 1;
      run.status = 'cancelled';
    },
    async steer(text: string) {
      run.steerCalls.push(text);
      if (run.steerAck === 'throw') throw new Error('steering unavailable');
      return run.steerAck ?? 'complete_delivered';
    }
  };
  return run;
}

// ---- ctx ----

const appSettings = () => defaultSettings();

function makeCtx(overrides: Partial<SessionMeta> = {}): { ctx: HarnessContext; meta: SessionMeta; events: SessionEvent[]; items: Map<string, TranscriptItem> } {
  const meta: SessionMeta = {
    id: 's1',
    title: 'New session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { harness: 'cursor', projectRoot: '/proj', permissionMode: 'auto', model: { provider: 'cursor', model: 'composer' } },
    cwd: '/proj',
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage(),
    ...overrides
  };
  const events: SessionEvent[] = [];
  const items = new Map<string, TranscriptItem>();
  const ctx: HarnessContext = {
    sessionId: meta.id,
    session: () => meta,
    settings: appSettings,
    runtime: null as unknown as HarnessContext['runtime'],
    sessionDir: '/tmp/s1',
    permissionMode: () => meta.config.permissionMode,
    effort: () => meta.config.effort,
    getApiKey: async (id) => (id === 'cursor' ? 'key-123' : undefined),
    mcpServers: async () => [],
    emit: (event) => {
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
    requestApproval: async (_draft: ApprovalDraft) => ({ optionId: 'allow' }),
    updateRef: (patch) => Object.assign(meta.harnessRef, patch),
    updateMeta: (patch) => Object.assign(meta, patch),
    log: () => undefined,
    readJson: async () => null,
    writeJson: async () => undefined
  };
  return { ctx, meta, events, items };
}

/** Queue the next runs returned by agent.send(), in order. */
function scriptRuns(runs: FakeRun[]): void {
  const queue = [...runs];
  (globalThis as AnyRecord).__nextRun = () => {
    const r = queue.shift();
    if (!r) throw new Error('scripted runs exhausted');
    return r;
  };
}

const usageMsg = (u: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }>) => ({
  type: 'usage',
  agent_id: 'a',
  run_id: 'r',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, ...u }
});

const systemMsg = (model?: string) => ({
  type: 'system',
  subtype: 'init',
  agent_id: 'a',
  run_id: 'r',
  ...(model ? { model: { id: model } } : {})
});

const textMsg = (text: string) => ({ type: 'assistant', agent_id: 'a', run_id: 'r', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const thinkingMsg = (text: string) => ({ type: 'thinking', agent_id: 'a', run_id: 'r', text });
const toolMsg = (callId: string, name: string, status: string, args?: unknown, result?: unknown) => ({
  type: 'tool_call',
  agent_id: 'a',
  run_id: 'r',
  call_id: callId,
  name,
  status,
  args,
  result
});

describe('cursor harness adapter', () => {
  beforeEach(() => {
    sdk.creates.length = 0;
    sdk.resumes.length = 0;
    sdk.sends.length = 0;
    sdk.modelsImpl = async () => [{ id: 'composer', displayName: 'Composer', description: 'Cursor in-house model' }];
    (globalThis as AnyRecord).__resumeFails = false;
    (globalThis as AnyRecord).__nextRun = null;
  });

  afterEach(() => {
    (globalThis as AnyRecord).__nextRun = null;
  });

  it('start is idle and passes the stored key plus config model into Agent.create', async () => {
    const { ctx, events } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    expect(events.some((e) => e.type === 'status' && e.status === 'idle')).toBe(true);
    scriptRuns([makeRun([])]);
    await a.send({ text: 'hi' });
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(sdk.creates).toHaveLength(1);
    const opts = sdk.creates[0];
    expect(opts.apiKey).toBe('key-123');
    expect(opts.model).toEqual({ id: 'composer' });
    expect(opts.mode).toBe('agent');
    expect(opts.local.cwd).toBe('/proj');
    expect(opts.local.sandboxOptions).toEqual({ enabled: true });
    expect(opts.tools).toBeUndefined();
    expect(ctx.session().harnessRef.cursorAgentId).toMatch(/^local-agent-/);
    expect(sdk.sends[0].msg).toEqual({ text: 'hi', images: undefined });
    expect(sdk.sends[0].opts.model).toEqual({ id: 'composer' });
    await a.dispose();
  });

  it('maps plan mode to a read-only allowlist and full-auto to no sandbox', async () => {
    for (const mode of ['plan', 'full-auto'] as const) {
      const { ctx } = makeCtx();
      ctx.session().config.permissionMode = mode;
      const a = new CursorAdapter(ctx);
      await a.start();
      scriptRuns([makeRun([])]);
      await a.send({ text: 'explore' });
      await vi.waitFor(() => expect(a.busy).toBe(false));
      const opts = sdk.creates[sdk.creates.length - 1];
      expect(opts.mode).toBe(mode === 'plan' ? 'plan' : 'agent');
      // The sandbox stays off in plan (the read-only allowlist is the boundary) and in full-auto.
      expect(opts.local.sandboxOptions).toEqual({ enabled: false });
      if (mode === 'plan') {
        expect(opts.tools).toEqual(expect.arrayContaining(['read', 'grep', 'glob']));
        expect(opts.tools).not.toEqual(expect.arrayContaining(['shell', 'edit', 'task']));
      } else {
        expect(opts.tools).toBeUndefined();
      }
      await a.dispose();
    }
  });

  it('normalizes assistant text, thinking, tool calls and usage into SessionEvents', async () => {
    const { ctx, events, items } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    scriptRuns([
      makeRun([
        systemMsg('composer'),
        thinkingMsg('let me look'),
        thinkingMsg('let me look around'),
        textMsg('Hello'),
        toolMsg('c1', 'shell', 'running', { command: 'ls -la' }),
        toolMsg('c1', 'shell', 'completed', { command: 'ls -la' }, { status: 'success', value: { exitCode: 0, stdout: 'file.txt', stderr: '' } }),
        toolMsg('c2', 'edit', 'completed', { file_path: '/proj/src/x.ts' }, 'done'),
        textMsg('Hello, that was the listing.'),
        usageMsg({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 }),
        { type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' }
      ])
    ]);
    await a.send({ text: 'do the thing' });
    await vi.waitFor(() => expect(a.busy).toBe(false));

    const assistants = [...items.values()].filter((i) => i.kind === 'assistant');
    expect(assistants.map((x) => (x.kind === 'assistant' ? x.text : ''))).toEqual(['Hello', 'Hello, that was the listing.']);
    expect(assistants[0].kind === 'assistant' && assistants[0].thinking).toBe('let me look around');
    // Deltas carry one bubble's text exactly once; the second bubble (after tool calls) streams whole.
    const deltas = events.filter((e) => e.type === 'item.delta');
    expect(deltas.filter((e) => e.type === 'item.delta' && e.textDelta).map((e) => (e.type === 'item.delta' ? e.textDelta : ''))).toEqual(['Hello', 'Hello, that was the listing.']);

    const shell = items.get('c1');
    expect(shell && shell.kind === 'tool' && [shell.name, shell.hint, shell.summary, shell.status, shell.exitCode]).toEqual(['shell', 'execute', 'ls -la', 'done', 0]);
    expect(shell && shell.kind === 'tool' && shell.output).toBe('file.txt');
    const edit = items.get('c2');
    expect(edit && edit.kind === 'tool' && edit.changes).toEqual([{ path: '/proj/src/x.ts', kind: 'update' }]);

    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent && usageEvent.type === 'usage' && usageEvent.totals).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2, turns: 1, costUsd: 0 });
    const turn = [...items.values()].find((i) => i.kind === 'turn');
    expect(turn && turn.kind === 'turn' && turn.status).toBe('completed');
    expect(turn && turn.kind === 'turn' && turn.usage).toMatchObject({ inputTokens: 10 });
    await a.dispose();
  });

  it('degrades gracefully on unstable tool arg/result shapes', async () => {
    const { ctx, items } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    scriptRuns([
      makeRun([
        toolMsg('c1', 'someFutureTool', 'completed', { weird: { nested: true } }, { unknownShape: [1, 2, 3] }),
        toolMsg('c2', 'mcp__github__search', 'completed', { query: 'x' }, { content: [{ type: 'text', text: 'found' }] }),
        toolMsg('c3', 'shell', 'error', { command: 'boom' }, { status: 'error', error: { message: 'nope' } })
      ])
    ]);
    await a.send({ text: 'go' });
    await vi.waitFor(() => expect(a.busy).toBe(false));
    const c1 = items.get('c1');
    expect(c1 && c1.kind === 'tool' && c1.status).toBe('done');
    expect(c1 && c1.kind === 'tool' && c1.summary).toBe(JSON.stringify({ weird: { nested: true } }));
    expect(c1 && c1.kind === 'tool' && c1.output).toContain('unknownShape');
    const c2 = items.get('c2');
    expect(c2 && c2.kind === 'tool' && c2.hint).toBe('mcp');
    expect(c2 && c2.kind === 'tool' && c2.output).toBe('found');
    const c3 = items.get('c3');
    expect(c3 && c3.kind === 'tool' && c3.status).toBe('error');
    await a.dispose();
  });

  it('queues follow-ups while busy and drains them after the turn', async () => {
    const { ctx, meta, items } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = makeRun([textMsg('first')], { gate });
    const second = makeRun([textMsg('second')]);
    scriptRuns([first, second]);
    await a.send({ text: 'one', mode: 'now' });
    expect(a.busy).toBe(true);
    await a.send({ text: 'two', mode: 'queue' });
    expect(meta.queued).toBe(1);
    expect(sdk.sends).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(sdk.sends.length).toBe(2));
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(meta.queued).toBe(0);
    const texts = [...items.values()].filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''));
    expect(texts).toEqual(['first', 'second']);
    expect(sdk.sends[1].msg.text).toBe('two');
    await a.dispose();
  });

  it('steering is delivered in-turn, bounced steers become follow-ups', async () => {
    const { ctx, meta, items } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = makeRun([textMsg('working')], { gate });
    const bounced = makeRun([textMsg('after bounce')]);
    scriptRuns([first, bounced]);
    await a.send({ text: 'one', mode: 'now' });
    await a.send({ text: 'focus on x', mode: 'steer' });
    expect(first.steerCalls).toEqual(['focus on x']);
    // complete_delivered: ownership transferred, no follow-up.
    expect(meta.queued ?? 0).toBe(0);
    // A bounce (revert_to_followup) queues the message for after the turn.
    first.steerAck = 'revert_to_followup';
    await a.send({ text: 'and also y', mode: 'steer' });
    expect(first.steerCalls).toEqual(['focus on x', 'and also y']);
    expect(meta.queued).toBe(1);
    release();
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(sdk.sends.length).toBe(2);
    expect(sdk.sends[1].msg.text).toBe('and also y');
    expect([...items.values()].some((i) => i.kind === 'assistant' && i.text === 'after bounce')).toBe(true);
    await a.dispose();
  });

  it('interrupt cancels the run and records an interrupted turn', async () => {
    const { ctx, items } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = makeRun([textMsg('partial')], { gate });
    scriptRuns([run]);
    await a.send({ text: 'long task' });
    await a.interrupt();
    release();
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(run.cancelCalls).toBe(1);
    const turn = [...items.values()].find((i) => i.kind === 'turn');
    expect(turn && turn.kind === 'turn' && turn.status).toBe('interrupted');
    await a.dispose();
  });

  it('resume reuses the stored agent id; a dead id falls back to a fresh agent', async () => {
    const { ctx } = makeCtx();
    ctx.session().harnessRef.cursorAgentId = 'local-stored';
    const a = new CursorAdapter(ctx);
    await a.start();
    scriptRuns([makeRun([])]);
    await a.send({ text: 'again' });
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(sdk.resumes.map((r) => r.id)).toEqual(['local-stored']);
    expect(sdk.creates).toHaveLength(0);
    expect(ctx.session().harnessRef.cursorAgentId).toMatch(/^resumed-/);
    await a.dispose();

    // Broken id: resume throws, the ref is cleared, a fresh agent is created.
    (globalThis as AnyRecord).__resumeFails = true;
    const ctx2 = makeCtx();
    ctx2.meta.harnessRef.cursorAgentId = 'local-gone';
    const b = new CursorAdapter(ctx2.ctx);
    await b.start();
    scriptRuns([makeRun([])]);
    await b.send({ text: 'recover' });
    await vi.waitFor(() => expect(b.busy).toBe(false));
    expect(ctx2.meta.harnessRef.cursorAgentId).toMatch(/^local-agent-/);
    await b.dispose();
  });

  it('setModel is sticky on the next send and updates the session meta', async () => {
    const { ctx, meta } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    await a.setModel({ provider: 'cursor', model: 'gpt-next' });
    expect(meta.activeModel).toEqual({ provider: 'cursor', model: 'gpt-next' });
    scriptRuns([makeRun([])]);
    await a.send({ text: 'with new model' });
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(sdk.sends[0].opts.model).toEqual({ id: 'gpt-next' });
    await a.dispose();
  });

  it('images pass through as base64 SDK images', async () => {
    const { ctx } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    scriptRuns([makeRun([])]);
    await a.send({ text: 'look', images: [{ mimeType: 'image/png', data: 'QUJD', name: 'shot.png' }] });
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(sdk.sends[0].msg.images).toEqual([{ data: 'QUJD', mimeType: 'image/png' }]);
    await a.dispose();
  });

  it('failed runs record a failed turn and the error', async () => {
    const { ctx, items } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    scriptRuns([makeRun([], { status: 'error', error: 'backend exploded' })]);
    await a.send({ text: 'boom' });
    await vi.waitFor(() => expect(a.busy).toBe(false));
    const turn = [...items.values()].find((i) => i.kind === 'turn');
    expect(turn && turn.kind === 'turn' && turn.status).toBe('failed');
    expect(turn && turn.kind === 'turn' && turn.error).toBe('backend exploded');
    expect(items.size > 0).toBe(true);
    await a.dispose();
  });

  it('listModels prefers the live catalog and falls back to the static one', async () => {
    const { ctx } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    const live = await a.listModels();
    expect(live.map((m) => [m.id, m.provider, m.displayName])).toEqual([['composer', 'cursor', 'Composer']]);
    sdk.modelsImpl = () => Promise.reject(new Error('offline'));
    expect(await a.listModels()).toEqual(CURSOR_STATIC_MODELS);
    await a.dispose();
  });

  it('dispose cancels the active run and closes the agent', async () => {
    const { ctx } = makeCtx();
    const a = new CursorAdapter(ctx);
    await a.start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = makeRun([textMsg('partial')], { gate });
    scriptRuns([run]);
    await a.send({ text: 'long' });
    await a.dispose();
    expect(run.cancelCalls).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 10));
    await a.send({ text: 'nope' }).catch((e) => expect(String(e)).toContain('disposed'));
  });

  it('a stale persisted run (AgentBusyError) is recovered with force once', async () => {
    const { ctx, items } = makeCtx();
    ctx.session().harnessRef.cursorAgentId = 'local-wedged';
    const a = new CursorAdapter(ctx);
    await a.start();
    // agent.send rejects with AgentBusyError once (wedged persisted run), then succeeds.
    const busyErr = new (sdk.AgentBusyError as unknown as { new (m: string): Error })('agent busy');
    const goodRun = makeRun([textMsg('recovered')]);
    let attempts = 0;
    (globalThis as AnyRecord).__nextRun = () => {
      attempts += 1;
      if (attempts === 1) throw busyErr;
      return goodRun;
    };
    await a.send({ text: 'unstuck' });
    await vi.waitFor(() => expect(a.busy).toBe(false));
    expect(sdk.sends).toHaveLength(2);
    expect(sdk.sends[0].opts.local).toBeUndefined();
    expect(sdk.sends[1].opts.local).toEqual({ force: true });
    const texts = [...items.values()].filter((i) => i.kind === 'assistant').map((i) => (i.kind === 'assistant' ? i.text : ''));
    expect(texts).toEqual(['recovered']);
    await a.dispose();
  });
});
