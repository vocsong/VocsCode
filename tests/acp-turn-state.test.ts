/**
 * Offline tests for the ACP adapter (issue #135). The spawn module is mocked to hand the adapter a
 * fake child built from PassThrough streams, and the test itself acts as the ACP agent by speaking
 * newline-delimited JSON-RPC over those streams. The real @agentclientprotocol/sdk framing and
 * dispatch are exercised; only the child process is fake.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import type { HarnessRef, PermissionMode, SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import { AcpAdapter } from '../src/main/harness/acp';

type AnyRecord = Record<string, any>;

const spawnState = vi.hoisted(() => ({
  children: [] as AnyRecord[],
  spawnCalls: [] as { file: string; args: string[]; opts: AnyRecord }[]
}));

vi.mock('../src/main/harness/spawn', () => ({
  spawnTool: (file: string, args: string[], opts: AnyRecord) => {
    spawnState.spawnCalls.push({ file, args, opts });
    const child = spawnState.children.shift();
    if (!child) throw new Error('no scripted child process');
    return child;
  },
  shutdownChild: async () => undefined,
  killTree: async () => undefined,
  quoteWin: (arg: string) => arg
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

/** Minimal ACP agent: parses ndjson requests from the child's stdin, replies on its stdout. */
class FakeAcpAgent {
  readonly requests: AnyRecord[] = [];
  readonly responses: AnyRecord[] = [];
  private buf = '';
  private serverId = 1;
  private readonly handlers = new Map<string, (params: AnyRecord, id: AnyRecord) => unknown>();
  private readonly pendingServer = new Map<string, (msg: AnyRecord) => void>();

  constructor(private readonly child: AnyRecord) {
    child.stdin.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
  }

  on(method: string, handler: (params: AnyRecord, id: AnyRecord) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  notify(method: string, params: AnyRecord): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Agent -> client request; resolves with the client's response message. */
  serverRequest(method: string, params: AnyRecord): Promise<AnyRecord> {
    const id = `srv_${this.serverId++}`;
    const p = new Promise<AnyRecord>((resolve) => this.pendingServer.set(id, resolve));
    this.write({ jsonrpc: '2.0', id, method, params });
    return p;
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
    if (msg.method === undefined) {
      this.responses.push(msg);
      const resolve = this.pendingServer.get(msg.id as string);
      if (resolve) {
        this.pendingServer.delete(msg.id as string);
        resolve(msg);
      }
      return;
    }
    this.requests.push(msg);
    if (msg.id === undefined || msg.id === null) return; // notification
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(msg.params as AnyRecord, msg.id))
      .then(
        (result) => this.write({ jsonrpc: '2.0', id: msg.id, result }),
        (e: unknown) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } })
      );
  }

  private write(msg: AnyRecord): void {
    this.child.stdout.write(JSON.stringify(msg) + '\n');
  }
}

interface Harness {
  adapter: AcpAdapter;
  agent: FakeAcpAgent;
  child: AnyRecord;
  ctx: HarnessContext;
  meta: SessionMeta;
  events: SessionEvent[];
  items: Map<string, TranscriptItem>;
  approvals: ApprovalDraft[];
  logs: { level: string; message: string }[];
}

const created: Harness[] = [];

function makeHarness(opts: { ref?: HarnessRef; permissionMode?: PermissionMode } = {}): Harness {
  const child = makeFakeChild();
  spawnState.children.push(child);
  const agent = new FakeAcpAgent(child);
  const settings = defaultSettings();
  settings.acpAgents = [{ id: 'test-agent', name: 'Test Agent', description: '', command: 'test-agent', args: [] }];
  (settings.binaries as Record<string, string | undefined>)['test-agent'] = 'C:/fake/acp-agent.exe';
  const approvals: ApprovalDraft[] = [];
  const events: SessionEvent[] = [];
  const items = new Map<string, TranscriptItem>();
  const logs: { level: string; message: string }[] = [];
  const meta: SessionMeta = {
    id: 's1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'acp', projectRoot: '/proj', permissionMode: opts.permissionMode ?? 'auto', acpAgent: 'test-agent' },
    cwd: '/proj',
    status: 'idle',
    harnessRef: { ...(opts.ref ?? {}) },
    usage: emptyUsage()
  };
  const ctx = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => settings,
    runtime: { runtimePaths: { appRuntimeDir: '/tmp' }, resolve: () => null } as never,
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
    requestApproval: async (draft: ApprovalDraft) => {
      approvals.push(draft);
      return { optionId: 'o1' };
    },
    updateRef: (patch: Partial<HarnessRef>) => {
      meta.harnessRef = { ...meta.harnessRef, ...patch };
    },
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    log: (level: string, message: string) => logs.push({ level, message }),
    readJson: async () => null,
    writeJson: async () => undefined,
    mcpServers: async () => []
  } as unknown as HarnessContext;
  const adapter = new AcpAdapter(ctx);
  const h: Harness = { adapter, agent, child, ctx, meta, events, items, approvals, logs };
  created.push(h);
  return h;
}

/** Common start handshake: initialize + create a session. */
function scriptBasics(h: Harness, caps: AnyRecord = {}, sessionId = 'sess-1'): void {
  h.agent.on('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: caps }));
  h.agent.on('session/new', () => ({ sessionId }));
}

const turnItems = (items: Map<string, TranscriptItem>): Extract<TranscriptItem, { kind: 'turn' }>[] => [...items.values()].filter((i): i is Extract<TranscriptItem, { kind: 'turn' }> => i.kind === 'turn');

const infoTexts = (items: Map<string, TranscriptItem>, level?: 'info' | 'warn' | 'error'): string[] =>
  [...items.values()].filter((i): i is Extract<TranscriptItem, { kind: 'info' }> => i.kind === 'info' && (!level || i.level === level)).map((i) => i.text);

describe('acp adapter', () => {
  beforeEach(() => {
    spawnState.children.length = 0;
    spawnState.spawnCalls.length = 0;
    created.length = 0;
  });

  afterEach(async () => {
    for (const h of created) {
      await h.adapter.dispose().catch(() => undefined);
      h.child.stdin.destroy();
      h.child.stdout.destroy();
      h.child.stderr.destroy();
    }
  });

  it('initializes and creates a session when no ref is stored', async () => {
    const h = makeHarness();
    scriptBasics(h, {}, 'sess-new');
    await h.adapter.start();
    const init = h.agent.requests.find((r) => r.method === 'initialize');
    expect(init?.params.clientInfo.name).toBe('vocs-code');
    const created_req = h.agent.requests.find((r) => r.method === 'session/new');
    expect(created_req?.params.cwd).toBe('/proj');
    expect(h.agent.requests.some((r) => r.method === 'session/resume')).toBe(false);
    expect(h.meta.harnessRef.acpSessionId).toBe('sess-new');
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' });
  });

  it('resumes the stored session when the agent advertises resume', async () => {
    const h = makeHarness({ ref: { acpSessionId: 'sess-existing' } });
    h.agent.on('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } } }));
    h.agent.on('session/resume', () => ({}));
    h.agent.on('session/new', () => ({ sessionId: 'sess-new' }));
    await h.adapter.start();
    const resume = h.agent.requests.find((r) => r.method === 'session/resume');
    expect(resume?.params.sessionId).toBe('sess-existing');
    expect(h.agent.requests.some((r) => r.method === 'session/new')).toBe(false);
    expect(h.meta.harnessRef.acpSessionId).toBe('sess-existing');
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' });
  });

  it('warns and falls back to a new session when resume is rejected', async () => {
    const h = makeHarness({ ref: { acpSessionId: 'sess-stale' } });
    h.agent.on('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } } }));
    h.agent.on('session/resume', () => {
      throw new Error('session gone');
    });
    h.agent.on('session/new', () => ({ sessionId: 'sess-new' }));
    await h.adapter.start();
    expect(h.agent.requests.find((r) => r.method === 'session/resume')?.params.sessionId).toBe('sess-stale');
    expect(h.agent.requests.some((r) => r.method === 'session/new')).toBe(true);
    expect(h.meta.harnessRef.acpSessionId).toBe('sess-new');
    expect(infoTexts(h.items, 'warn').some((t) => /could not resume/i.test(t))).toBe(true);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' });
  });

  it('does not attempt resume when the agent does not advertise the capability', async () => {
    const h = makeHarness({ ref: { acpSessionId: 'sess-existing' } });
    scriptBasics(h, {}, 'sess-new');
    await h.adapter.start();
    expect(h.agent.requests.some((r) => r.method === 'session/resume')).toBe(false);
    expect(h.meta.harnessRef.acpSessionId).toBe('sess-new');
  });

  it('assembles assistant text and completes a prompt turn', async () => {
    const h = makeHarness();
    scriptBasics(h);
    h.agent.on('session/prompt', () => {
      h.agent.notify('session/update', { sessionId: 'sess-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } } });
      h.agent.notify('session/update', { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } });
      h.agent.notify('session/update', { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } });
      return { stopReason: 'end_turn' };
    });
    await h.adapter.start();
    await h.adapter.send({ text: 'say hi' });
    expect(h.adapter.busy).toBe(true);
    expect(h.events.some((e) => e.type === 'status' && e.status === 'running')).toBe(true);
    await vi.waitFor(() => expect(h.adapter.busy).toBe(false));

    const assistants = [...h.items.values()].filter((i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant');
    expect(assistants.some((a) => a.text === 'Hello')).toBe(true);
    expect(assistants.some((a) => a.thinking === 'pondering')).toBe(true);
    const deltas = h.events.filter((e): e is Extract<SessionEvent, { type: 'item.delta' }> => e.type === 'item.delta');
    expect(deltas.some((d) => d.textDelta === 'Hel')).toBe(true);
    expect(deltas.some((d) => d.thinkingDelta === 'pondering')).toBe(true);
    expect(turnItems(h.items).at(-1)?.status).toBe('completed');
    expect(h.events.some((e) => e.type === 'usage')).toBe(true);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' });
  });

  it('marks a refusal prompt as a failed turn', async () => {
    const h = makeHarness();
    scriptBasics(h);
    h.agent.on('session/prompt', () => ({ stopReason: 'refusal' }));
    await h.adapter.start();
    await h.adapter.send({ text: 'no' });
    await vi.waitFor(() => expect(h.adapter.busy).toBe(false));
    const turn = turnItems(h.items).at(-1);
    expect(turn?.status).toBe('failed');
    expect(turn?.error).toMatch(/refused/i);
  });

  it('auto-allows in-workspace work but asks outside the workspace below full access', async () => {
    const options = [
      { optionId: 'o1', name: 'Allow', kind: 'allow_once' },
      { optionId: 'o2', name: 'Deny', kind: 'reject_once' }
    ];
    // auto: an in-workspace command is allowed without asking.
    const auto = makeHarness({ permissionMode: 'auto' });
    scriptBasics(auto);
    await auto.adapter.start();
    const allowed = await auto.agent.serverRequest('session/request_permission', {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc1', kind: 'execute', title: 'Run ls', rawInput: { command: 'ls' } },
      options
    });
    expect(auto.approvals).toHaveLength(0);
    expect(allowed.result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });

    // auto: an edit outside the workspace always asks.
    const outside = await auto.agent.serverRequest('session/request_permission', {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc2', kind: 'edit', title: 'Edit outside', locations: [{ path: '/outside/secret.ts' }], rawInput: { file_path: '/outside/secret.ts' } },
      options
    });
    expect(auto.approvals).toHaveLength(1);
    expect(auto.approvals[0].kind).toBe('file_change');
    expect(auto.approvals[0].description).toMatch(/outside/i);
    expect(outside.result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });

    // full-auto: outside-workspace writes are allowed without a prompt.
    const full = makeHarness({ permissionMode: 'full-auto' });
    scriptBasics(full);
    await full.adapter.start();
    const fullAllowed = await full.agent.serverRequest('session/request_permission', {
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc3', kind: 'edit', title: 'Edit outside', locations: [{ path: '/outside/secret.ts' }], rawInput: { file_path: '/outside/secret.ts' } },
      options
    });
    expect(full.approvals).toHaveLength(0);
    expect(fullAllowed.result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
  });

  it('reports stopped and idle when the agent process exits', async () => {
    const h = makeHarness();
    scriptBasics(h);
    await h.adapter.start();
    h.child.emit('close', 0);
    expect(h.adapter.busy).toBe(false);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'stopped', detail: 'Test Agent exited (0)' });
  });
});
