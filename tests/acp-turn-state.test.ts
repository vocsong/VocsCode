/**
 * Offline tests for the ACP adapter (issue #135). The spawn module is mocked to hand the adapter a
 * fake child built from PassThrough streams, and the test itself acts as the ACP agent by speaking
 * newline-delimited JSON-RPC over those streams. The real @agentclientprotocol/sdk framing and
 * dispatch are exercised; only the child process is fake.
 */
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import type { ApprovalDraft, HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { ResolvedServer } from '../src/main/mcp/effective';
import type { HarnessRef, PermissionMode, SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import { createAdapter } from '../src/main/harness/registry';
import { ANTIGRAVITY_CANCEL_GRACE_MS, ANTIGRAVITY_PROMPT_QUIET_MS } from '../src/main/harness/acp';
import { deferred } from '../src/main/util/async';

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
  adapter: HarnessAdapter;
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
const tempDirs: string[] = [];
const antigravityBin = path.join(os.tmpdir(), 'fake-agy.exe');
const antigravityModes: acp.SessionModeState = {
  currentModeId: 'auto',
  availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }]
};

function makeHarness(opts: { harness?: 'acp' | 'antigravity'; ref?: HarnessRef; permissionMode?: PermissionMode; cwd?: string } = {}): Harness {
  const harness = opts.harness ?? 'acp';
  const cwd = opts.cwd ?? '/proj';
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
    config: { harness, projectRoot: cwd, permissionMode: opts.permissionMode ?? 'auto', acpAgent: 'test-agent' },
    cwd,
    status: 'idle',
    harnessRef: { ...(opts.ref ?? {}) },
    usage: emptyUsage()
  };
  const ctx = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => settings,
    runtime: {
      runtimePaths: { appRuntimeDir: '/tmp' },
      resolve: vi.fn((id: string) => id === 'agy' ? { path: antigravityBin } : null)
    },
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
    mcpServers: async () => [],
    ownedMcpIds: () => []
  } as unknown as HarnessContext;
  const adapter = createAdapter(harness, ctx);
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
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const h of created) {
      await h.adapter.dispose().catch(() => undefined);
      h.child.stdin.destroy();
      h.child.stdout.destroy();
      h.child.stderr.destroy();
    }
    for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it('uses the official Antigravity account launch and resumes an existing session', async () => {
    const credentialVars = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS'];
    for (const name of credentialVars) vi.stubEnv(name, 'fake-credential-setting');
    vi.stubEnv('VOCS_ACP_TEST_MARKER', 'keep');
    const h = makeHarness({ harness: 'antigravity', permissionMode: 'ask', ref: { acpSessionId: 'agy-saved' } });
    const getApiKey = vi.fn(async () => 'fake-vault-key');
    h.ctx.getApiKey = getApiKey;
    scriptBasics(h, { sessionCapabilities: { resume: {} } });
    h.agent.on('session/resume', () => ({ modes: antigravityModes }));
    h.agent.on('session/set_mode', () => ({}));

    await h.adapter.start();

    expect(h.ctx.runtime.resolve).toHaveBeenCalledExactlyOnceWith('agy');
    expect(getApiKey).not.toHaveBeenCalled();
    expect(spawnState.spawnCalls).toHaveLength(1);
    const [{ file, args, opts }] = spawnState.spawnCalls;
    expect(file).toBe(antigravityBin);
    expect(args).toEqual(['--settings', expect.any(String), 'acp']);
    expect(JSON.parse(args[1])).toMatchObject({ modelProvider: '', toolPermission: 'strict', allowNonWorkspaceAccess: false });
    expect(opts.env.VOCS_ACP_TEST_MARKER).toBe('keep');
    for (const name of credentialVars) expect(opts.env).not.toHaveProperty(name);
    expect(h.agent.requests.map((r) => r.method)).toEqual(['initialize', 'session/resume', 'session/set_mode']);
    expect(h.agent.requests[1].params.sessionId).toBe('agy-saved');
    expect(h.meta.harnessRef.acpSessionId).toBe('agy-saved');
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' });
  });

  it.each([
    { mode: 'ask', modeId: 'default', stopReason: 'end_turn', turnStatus: 'completed', approvalCount: 1 },
    { mode: 'plan', modeId: 'plan', stopReason: 'cancelled', turnStatus: 'interrupted', approvalCount: 0 }
  ] as const)('honors Antigravity $mode during a tool request and records the turn', async ({ mode, modeId, stopReason, turnStatus, approvalCount }) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-antigravity-acp-'));
    let finishCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => { finishCancelled = resolve; });
    try {
      const marker = path.join(cwd, 'command-marker.txt');
      const h = makeHarness({ harness: 'antigravity', permissionMode: mode, cwd });
      const decide = vi.fn(async (_draft: ApprovalDraft) => ({ optionId: 'deny' }));
      h.ctx.requestApproval = decide;
      scriptBasics(h);
      h.agent.on('session/new', () => ({ sessionId: 'sess-1', modes: antigravityModes }));
      h.agent.on('session/set_mode', () => ({}));
      const toolResponses: unknown[] = [];
      h.agent.on('session/prompt', async ({ sessionId }) => {
        const response = await h.agent.serverRequest('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 'write-marker', kind: 'execute', title: 'Write test marker', rawInput: { command: 'write-marker' } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
        });
        if (response.result?.outcome?.optionId === 'allow') await fs.writeFile(marker, 'command ran');
        h.agent.notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used: 37, size: 2_000 } });
        toolResponses.push(response.result);
        if (stopReason === 'cancelled') await cancelled;
        else h.agent.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } });
        return { stopReason };
      });

      await h.adapter.start();
      expect(h.agent.requests.filter((r) => r.method === 'session/set_mode').map((r) => r.params)).toEqual([{ sessionId: 'sess-1', modeId }]);
      await h.adapter.send({ text: 'Check the command approval.' });
      await vi.waitFor(() => expect(toolResponses).toEqual([{ outcome: { outcome: 'selected', optionId: 'deny' } }]));
      expect(decide).toHaveBeenCalledTimes(approvalCount);
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      if (stopReason === 'cancelled') {
        await h.adapter.interrupt();
        await vi.waitFor(() => expect(h.agent.requests.filter((r) => r.method === 'session/cancel').map((r) => r.params)).toEqual([{ sessionId: 'sess-1' }]));
        finishCancelled();
      }
      await vi.waitFor(() => expect(h.adapter.busy).toBe(false));

      expect(turnItems(h.items).map((item) => item.status)).toEqual([turnStatus]);
      const assistants = [...h.items.values()].filter((i) => i.kind === 'assistant');
      expect(assistants.map((i) => i.text)).toEqual(stopReason === 'cancelled' ? [] : ['PONG']);
      const usage = h.events.filter((e) => e.type === 'usage');
      expect(usage.map(({ totals }) => [totals.contextTokens, totals.contextWindow])).toEqual([[37, 2_000], [37, 2_000]]);
      expect(h.events.filter((e) => e.type === 'status').map((e) => e.status)).toEqual(['idle', 'running', 'idle']);
    } finally {
      finishCancelled();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { mode: 'accept-edits', kind: 'edit', command: undefined, prompted: false, outcome: 'allow-once' },
    { mode: 'accept-edits', kind: 'execute', command: 'npm test', prompted: true, outcome: 'deny' },
    { mode: 'auto', kind: 'execute', command: 'npm test', prompted: false, outcome: 'allow-once' },
    { mode: 'auto', kind: 'execute', command: 'sudo rm -rf /', prompted: true, outcome: 'deny' },
    { mode: 'full-auto', kind: 'execute', command: 'sudo rm -rf /', prompted: false, outcome: 'allow-once' }
  ] as const)('applies Antigravity $mode to a $kind request ($command) with one-time grants only', async ({ mode, kind, command, prompted, outcome }) => {
    // The outside-project check follows real paths, so the project directory has to exist.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-antigravity-tier-'));
    tempDirs.push(cwd);
    const h = makeHarness({ harness: 'antigravity', permissionMode: mode, cwd });
    const decide = vi.fn(async (_draft: ApprovalDraft) => ({ optionId: 'deny' }));
    h.ctx.requestApproval = decide;
    scriptBasics(h);
    h.agent.on('session/new', () => ({ sessionId: 'sess-1', modes: antigravityModes }));
    h.agent.on('session/set_mode', () => ({}));
    const toolResponses: unknown[] = [];
    h.agent.on('session/prompt', async ({ sessionId }) => {
      const response = await h.agent.serverRequest('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'tool-1', kind, title: 'Tool', rawInput: command ? { command } : { path: 'a.txt' }, locations: [{ path: path.join(cwd, 'a.txt') }] },
        options: [
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
        ]
      });
      toolResponses.push(response.result);
      return { stopReason: 'end_turn' };
    });

    await h.adapter.start();
    // Only Plan switches the CLI's own mode; the rest stay `default` under the strict tool policy.
    expect(h.agent.requests.filter((r) => r.method === 'session/set_mode').map((r) => r.params)).toEqual([{ sessionId: 'sess-1', modeId: 'default' }]);
    await h.adapter.send({ text: 'Run the tool.' });
    await vi.waitFor(() => expect(toolResponses).toEqual([{ outcome: { outcome: 'selected', optionId: outcome } }]));
    expect(decide).toHaveBeenCalledTimes(prompted ? 1 : 0);
    if (prompted) expect(decide.mock.calls[0][0].options.map((o) => o.id)).toEqual(['allow-once', 'deny']);
    await vi.waitFor(() => expect(h.adapter.busy).toBe(false));
    expect(turnItems(h.items).map((item) => item.status)).toEqual(['completed']);
  });

  it('preserves the Antigravity session when Google sign-in is required to resume it', async () => {
    const h = makeHarness({ harness: 'antigravity', permissionMode: 'ask', ref: { acpSessionId: 'agy-saved' } });
    scriptBasics(h, { sessionCapabilities: { resume: {} } });
    h.agent.on('session/resume', () => { throw new Error('Authentication required'); });

    await expect(h.adapter.start()).rejects.toThrow(/sign in with google/i);
    expect(h.agent.requests.map((r) => r.method)).toEqual(['initialize', 'session/resume']);
    expect(h.meta.harnessRef.acpSessionId).toBe('agy-saved');
    expect(infoTexts(h.items, 'warn')).toEqual([]);
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

  it('resolves a relative MCP command to an absolute path and skips the ones it cannot', async () => {
    const h = makeHarness();
    // The wrapped form normalizeStdio leaves on Windows is a bare `cmd`; ACP rejects any bare command.
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    const servers: ResolvedServer[] = [
      { def: { id: 'gitnexus', transport: 'stdio', command: shell, args: ['/c', 'npx', '-y', 'gitnexus@latest', 'mcp'] }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] },
      { def: { id: 'ghost', transport: 'stdio', command: 'vocs-code-mcp-not-installed' }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] }
    ];
    h.ctx.mcpServers = async () => servers;
    // dsh fails session/new outright on a relative command; the handshake must still complete.
    h.agent.on('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }));
    h.agent.on('session/new', (params) => {
      for (const [i, s] of (params.mcpServers as AnyRecord[]).entries()) {
        if (!path.isAbsolute(s.command as string)) throw new Error(`mcpServers[${i}].command must be an absolute path`);
      }
      return { sessionId: 'sess-mcp' };
    });

    await h.adapter.start();

    const req = h.agent.requests.find((r) => r.method === 'session/new');
    const sent = req?.params.mcpServers as AnyRecord[];
    expect(sent.map((s) => s.name)).toEqual(['gitnexus']);
    expect(path.isAbsolute(sent[0].command)).toBe(true);
    expect(h.meta.harnessRef.acpSessionId).toBe('sess-mcp');
    expect(infoTexts(h.items, 'warn').some((t) => /ghost/.test(t))).toBe(true);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' });
  });

  it('decodes dsh-style tuple model values and maps refs back to the raw option value', async () => {
    const h = makeHarness();
    const configOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']),
        options: [
          {
            group: 'deepseek-official',
            name: 'DeepSeek',
            options: [
              { value: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']), name: 'DeepSeek V4 Flash' },
              { value: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']), name: 'DeepSeek V4 Pro' }
            ]
          }
        ]
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }]
      }
    ];
    h.agent.on('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }));
    h.agent.on('session/new', () => ({ sessionId: 'sess-dsh', configOptions }));
    h.agent.on('session/set_config_option', (params: AnyRecord) => {
      expect(params.value).toBe(JSON.stringify(['deepseek-official', 'deepseek-v4-pro']));
      return { configOptions: [{ ...configOptions[0], currentValue: params.value }, configOptions[1]] };
    });
    await h.adapter.start();

    // The catalog exposes clean provider/model refs, not the raw JSON tuples dsh sends.
    const modelsEvent = h.events.find((e) => e.type === 'models') as AnyRecord;
    expect(modelsEvent.models).toHaveLength(2);
    expect(modelsEvent.models[0]).toMatchObject({ id: 'deepseek-v4-flash', provider: 'deepseek-official', displayName: 'DeepSeek V4 Flash' });
    expect(h.meta.activeModel).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' });
    expect(h.meta.activeEffort).toBe('high');

    await h.adapter.setModel({ provider: 'deepseek-official', model: 'deepseek-v4-pro' });
    const setReq = h.agent.requests.find((r) => r.method === 'session/set_config_option');
    expect(setReq?.params.configId).toBe('model');
    expect(setReq?.params.value).toBe(JSON.stringify(['deepseek-official', 'deepseek-v4-pro']));
    expect(h.meta.activeModel).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' });
    const modelsEvents = h.events.filter((e) => e.type === 'models') as AnyRecord[];
    expect(modelsEvents.at(-1)!.models[1]).toMatchObject({ id: 'deepseek-v4-pro', isDefault: true });
  });

  it('leaves effort unknown when the agent offers no level the app models', async () => {
    const h = makeHarness();
    h.agent.on('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }));
    h.agent.on('session/new', () => ({
      sessionId: 'sess-auto',
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model 1' }] },
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'auto',
          options: [{ value: 'auto', name: 'Auto' }, { value: 'none', name: 'None' }]
        }
      ]
    }));
    await h.adapter.start();

    // `[]` would claim the model takes no effort, and the app would disable its effort controls.
    const modelsEvent = h.events.find((e) => e.type === 'models') as AnyRecord;
    expect(modelsEvent.models).toEqual([expect.objectContaining({ id: 'm1', supportedEfforts: undefined })]);
  });

  it('keeps plain string model values untouched for agents that do not use tuples', async () => {
    const h = makeHarness();
    h.agent.on('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }));
    h.agent.on('session/new', () => ({
      sessionId: 'sess-plain',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gemini-2.5-pro',
          options: [{ value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }]
        }
      ]
    }));
    await h.adapter.start();
    const modelsEvent = h.events.find((e) => e.type === 'models') as AnyRecord;
    expect(modelsEvent.models).toEqual([expect.objectContaining({ id: 'gemini-2.5-pro', provider: 'test-agent', displayName: 'Gemini 2.5 Pro' })]);
    expect(h.meta.activeModel).toEqual({ provider: 'test-agent', model: 'gemini-2.5-pro' });
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

  it('publishes the agent’s advertised commands and sends a picked one as /name prompt text', async () => {
    const h = makeHarness();
    scriptBasics(h);
    const prompts: AnyRecord[] = [];
    h.agent.on('session/prompt', (params) => {
      prompts.push(params);
      return { stopReason: 'end_turn' };
    });
    await h.adapter.start();
    h.agent.notify('session/update', {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'web', description: 'Search the web', input: { hint: 'query to search for' } },
          { name: 'plan', description: 'Draft a plan' }
        ]
      }
    });
    await vi.waitFor(() => expect(h.meta.harnessCommandList).toBeDefined());
    expect(h.meta.harnessCommandList).toEqual([
      { name: 'web', description: 'Search the web', argumentHint: 'query to search for', kind: 'command' },
      { name: 'plan', description: 'Draft a plan', kind: 'command' }
    ]);
    expect(h.meta.harnessCommands).toEqual(['web', 'plan']);

    // The list is replaced, not merged, when the agent re-advertises.
    h.agent.notify('session/update', { sessionId: 'sess-1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'web', description: 'Search' }] } });
    await vi.waitFor(() => expect(h.meta.harnessCommands).toEqual(['web']));

    await h.adapter.send({ text: '/web vocs code' });
    await vi.waitFor(() => expect(h.adapter.busy).toBe(false));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toEqual([expect.objectContaining({ type: 'text', text: '/web vocs code' })]);
  });

  it('keeps a quiet Antigravity reply, records a failure, and never replays a queued message', async () => {
    vi.useFakeTimers();
    const h = makeHarness({ harness: 'antigravity', permissionMode: 'ask' });
    scriptBasics(h);
    h.agent.on('session/new', () => ({ sessionId: 'sess-1', modes: antigravityModes }));
    h.agent.on('session/set_mode', () => ({}));
    const finish = deferred<{ stopReason: string }>();
    h.agent.on('session/prompt', () => finish.promise);
    const update = (update: AnyRecord) => h.agent.notify('session/update', { sessionId: 'sess-1', update });
    await h.adapter.start();
    await h.adapter.send({ text: 'first' });
    await h.adapter.send({ text: 'queued' });
    update({ sessionUpdate: 'tool_call', toolCallId: 'work', title: 'Working', status: 'in_progress' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply' } });
    await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PROMPT_QUIET_MS);
    expect(h.adapter.busy).toBe(true); // A known running tool prevents an automatic stop.
    expect(turnItems(h.items)).toEqual([]);
    const approval = deferred<{ optionId: string }>();
    h.ctx.requestApproval = vi.fn(() => approval.promise);
    const request = h.agent.serverRequest('session/request_permission', {
      sessionId: 'sess-1', toolCall: { toolCallId: 'pending', title: 'Run pwd', kind: 'execute', rawInput: { command: 'pwd' } },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'work', status: 'completed' });
    await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PROMPT_QUIET_MS);
    expect(h.ctx.requestApproval).toHaveBeenCalledOnce();
    expect(h.adapter.busy).toBe(true); // Time spent waiting for approval is not quiet time.
    approval.resolve({ optionId: 'allow' });
    expect(await request).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PROMPT_QUIET_MS - 1);
    expect(h.adapter.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.adapter.busy).toBe(false);
    expect(turnItems(h.items)).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringContaining('without confirming') })]);
    expect([...h.items.values()].filter((item) => item.kind === 'assistant')).toEqual([expect.objectContaining({ text: 'Reply', streaming: false })]);
    expect(h.meta.queued).toBe(0);
    expect(infoTexts(h.items, 'warn')).toEqual([expect.stringContaining('Queued messages were not sent')]);
    expect(h.events.at(-1)).toMatchObject({ type: 'status', status: 'stopped' });

    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
    finish.resolve({ stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PROMPT_QUIET_MS);
    expect(turnItems(h.items)).toHaveLength(1);
    expect(h.agent.requests.filter(({ method }) => method === 'session/prompt')).toHaveLength(1);
    expect([...h.items.values()].filter((item) => item.kind === 'assistant')).toEqual([expect.objectContaining({ text: 'Reply', streaming: false })]);
    expect(h.events.at(-1)).toMatchObject({ type: 'status', status: 'stopped' });
  });

  it('keeps interrupt bounded when Antigravity never returns its prompt result', async () => {
    vi.useFakeTimers();
    const h = makeHarness({ harness: 'antigravity' });
    scriptBasics(h);
    h.agent.on('session/new', () => ({ sessionId: 'sess-1', modes: antigravityModes }));
    h.agent.on('session/set_mode', () => ({}));
    h.agent.on('session/prompt', () => deferred().promise);
    await h.adapter.start();
    await h.adapter.send({ text: 'still thinking' });
    await h.adapter.interrupt();
    await vi.advanceTimersByTimeAsync(ANTIGRAVITY_CANCEL_GRACE_MS - 1);
    expect(h.agent.requests.filter(({ method }) => method === 'session/cancel')).toHaveLength(1);
    expect(h.adapter.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(turnItems(h.items)).toEqual([expect.objectContaining({ status: 'interrupted', error: expect.stringContaining('did not acknowledge') })]);
    expect(h.adapter.busy).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ type: 'status', status: 'stopped' });
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

  describe('tier contract for generic ACP agents', () => {
    const vendorOptions = [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' }
    ];
    const ask = (h: Harness, toolCallId: string, extra: AnyRecord = {}, options: AnyRecord[] = vendorOptions) =>
      h.agent.serverRequest('session/request_permission', {
        sessionId: 'sess-1',
        toolCall: { toolCallId, kind: 'execute', title: 'Run tests', rawInput: { command: 'npm test' }, ...extra },
        options
      });

    /** A project directory holding a junction (`linked`) that leads to a sibling outside it. */
    async function linkedProject(): Promise<{ cwd: string; elsewhere: string }> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-acp-link-'));
      tempDirs.push(root);
      const cwd = path.join(root, 'project');
      const elsewhere = path.join(root, 'elsewhere');
      await fs.mkdir(cwd);
      await fs.mkdir(elsewhere);
      await fs.symlink(elsewhere, path.join(cwd, 'linked'), 'junction');
      return { cwd, elsewhere };
    }

    it('answers an "always allow" choice with the one-time option and keeps the grant app-side', async () => {
      const h = makeHarness({ permissionMode: 'ask' });
      const decide = vi.fn(async (_draft: ApprovalDraft) => ({ optionId: 'always' }));
      h.ctx.requestApproval = decide;
      scriptBasics(h);
      await h.adapter.start();

      const first = await ask(h, 'tc1');
      expect(first.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
      expect(decide).toHaveBeenCalledTimes(1);
      // The card offers the vendor's "always" as a session grant, not a persistent rule.
      expect(decide.mock.calls[0][0].options.find((o) => o.id === 'always')).toMatchObject({ kind: 'allow_session', label: 'Allow for session' });

      // The same kind is now allowed app-side, and still answered one-time.
      const second = await ask(h, 'tc2');
      expect(second.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
      expect(decide).toHaveBeenCalledTimes(1);
      // A dangerous command is never covered by the session grant.
      const dangerous = await ask(h, 'tc3', { rawInput: { command: 'sudo rm -rf /' } });
      expect(decide).toHaveBeenCalledTimes(2);
      expect(dangerous.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    });

    it('forwards the chosen "always" option only when the agent offered no one-time option', async () => {
      const h = makeHarness({ permissionMode: 'ask' });
      h.ctx.requestApproval = vi.fn(async () => ({ optionId: 'always' }));
      scriptBasics(h);
      await h.adapter.start();
      const res = await ask(h, 'tc1', {}, [vendorOptions[0], vendorOptions[2]]);
      expect(res.result).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    });

    it('clears a session grant on a tier change so the next request prompts again', async () => {
      const h = makeHarness({ permissionMode: 'ask' });
      const decide = vi.fn(async (_draft: ApprovalDraft) => ({ optionId: 'always' }));
      h.ctx.requestApproval = decide;
      scriptBasics(h);
      await h.adapter.start();
      await ask(h, 'tc1');
      await ask(h, 'tc2');
      expect(decide).toHaveBeenCalledTimes(1);

      h.meta.config.permissionMode = 'accept-edits';
      await h.adapter.setPermissionMode('accept-edits');
      decide.mockImplementation(async () => ({ optionId: 'no' }));
      const after = await ask(h, 'tc3');
      expect(decide).toHaveBeenCalledTimes(2);
      expect(after.result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    });

    it('answers allow_once in Full access even when the agent lists "always" first', async () => {
      const h = makeHarness({ permissionMode: 'full-auto' });
      scriptBasics(h);
      await h.adapter.start();
      const res = await ask(h, 'tc1', { rawInput: { command: 'sudo rm -rf /' } });
      expect(res.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
      expect(h.approvals).toHaveLength(0);
    });

    it('asks in Auto for a tool location that leads out of the project through a link', async () => {
      const { cwd } = await linkedProject();
      const h = makeHarness({ permissionMode: 'auto', cwd });
      const decide = vi.fn(async (_draft: ApprovalDraft) => ({ optionId: 'no' }));
      h.ctx.requestApproval = decide;
      scriptBasics(h);
      await h.adapter.start();

      const inside = await ask(h, 'tc1', { kind: 'edit', rawInput: {}, locations: [{ path: path.join(cwd, 'a.txt') }] });
      expect(inside.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
      expect(decide).not.toHaveBeenCalled();

      const linked = await ask(h, 'tc2', { kind: 'edit', rawInput: {}, locations: [{ path: path.join(cwd, 'linked', 'a.txt') }] });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide.mock.calls[0][0].description).toMatch(/outside/i);
      expect(linked.result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    });

    it('asks in Auto before fs/write_text_file writes through a link that leaves the project', async () => {
      const { cwd, elsewhere } = await linkedProject();
      const h = makeHarness({ permissionMode: 'auto', cwd });
      const decide = vi.fn(async (_draft: ApprovalDraft) => ({ optionId: 'deny' }));
      h.ctx.requestApproval = decide;
      scriptBasics(h);
      await h.adapter.start();

      const inside = await h.agent.serverRequest('fs/write_text_file', { sessionId: 'sess-1', path: path.join(cwd, 'in.txt'), content: 'in' });
      expect(inside.error).toBeUndefined();
      expect(await fs.readFile(path.join(cwd, 'in.txt'), 'utf8')).toBe('in');
      expect(decide).not.toHaveBeenCalled();

      const escaped = await h.agent.serverRequest('fs/write_text_file', { sessionId: 'sess-1', path: path.join(cwd, 'linked', 'out.txt'), content: 'out' });
      expect(decide).toHaveBeenCalledTimes(1);
      expect(escaped.error).toBeDefined();
      await expect(fs.stat(path.join(elsewhere, 'out.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
