/**
 * Mission mode on the Codex app-server adapter, offline against a scripted JSON-RPC peer. A mission
 * session gets the Mission server inline over JSON-RPC (never argv) with the `approve` tool
 * approval mode, the role prompt as developer instructions at thread start and resume, and Codex's
 * own multi-agent tools off. Codex's MCP approval elicitation is accepted only for the Mission
 * server of a mission session. A Builder's push asks in every tier — Full access included, which
 * keeps Codex asking so the gate can see it. Ordinary sessions send exactly what they did before.
 *
 * The elicitation below is the shape codex 0.153.4 sends (captured from the real binary with a
 * scripted model); that `approve` mode runs the tools in a Plan thread was checked the same way,
 * once, outside this suite — it needs the Codex binary and a model turn.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import { MISSION_GATEWAY_TOKEN_ENV, MISSION_GATEWAY_URL_ENV, missionServerDef } from '../src/main/mcp/mission';
import type { ResolvedServer } from '../src/main/mcp/effective';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import type { SessionMission } from '../src/shared/mission-mode';
import type { ApprovalDecision, HarnessRef, PermissionMode, SessionMeta } from '../src/shared/types';

type AnyRecord = Record<string, any>;

const mocks = vi.hoisted(() => ({ spawnChildren: [] as AnyRecord[], spawnCalls: [] as { file: string; args: string[]; opts: AnyRecord }[] }));
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
class FakeCodex {
  readonly requests: AnyRecord[] = [];
  readonly replies = new Map<number | string, AnyRecord>();
  private buf = '';
  private serverId = 1;
  constructor(private readonly child: AnyRecord, private readonly inherited: AnyRecord = {}) {
    child.stdin.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let idx = this.buf.indexOf('\n');
      while (idx >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) this.dispatch(JSON.parse(line) as AnyRecord);
        idx = this.buf.indexOf('\n');
      }
    });
  }
  private dispatch(msg: AnyRecord): void {
    if (msg.method === undefined) {
      this.replies.set(msg.id, msg);
      return;
    }
    this.requests.push(msg);
    if (msg.id === undefined || msg.id === null) return;
    const result = msg.method === 'thread/start' || msg.method === 'thread/resume'
      ? { thread: { id: 'thread-1' }, model: 'gpt-5.1-codex', modelProvider: 'openai', reasoningEffort: null }
      : msg.method === 'config/read' ? { config: { mcp_servers: this.inherited } }
      : msg.method === 'model/list' ? { data: [] }
      : msg.method === 'turn/start' ? { turn: { id: 'turn-1' } }
      : {};
    queueMicrotask(() => this.child.stdout.write(JSON.stringify({ id: msg.id, result }) + '\n'));
  }
  /** Codex → client request; resolves with the client's reply. */
  async serverRequest(method: string, params: AnyRecord): Promise<AnyRecord> {
    const id = `srv-${this.serverId++}`;
    this.child.stdout.write(JSON.stringify({ id, method, params }) + '\n');
    return vi.waitFor(() => {
      const reply = this.replies.get(id);
      if (!reply) throw new Error(`no reply to ${method}`);
      return reply.result;
    });
  }
  find(method: string): AnyRecord {
    const found = this.requests.find((r) => r.method === method);
    if (!found) throw new Error(`${method} was not sent`);
    return found.params;
  }
}

const LEAD: SessionMission = { missionId: 'm1', role: 'lead' };
const BUILDER: SessionMission = { missionId: 'm1', role: 'builder', leadId: 'lead', builderIndex: 1 };
const ROLE_PROMPT = 'MISSION RULES: you are a Mission participant.';
const attachment = { url: 'http://127.0.0.1:4567', token: 'C'.repeat(43) };

function missionServer(): ResolvedServer {
  const def = missionServerDef({ missionServerPath: 'C:/app/resources/mcp/vocs-mission.mjs', attachment })!;
  return { def, missing: [], secretEnvKeys: [MISSION_GATEWAY_TOKEN_ENV], secretHeaderKeys: [] };
}

async function start(opts: { mission?: SessionMission; mode?: PermissionMode; resume?: boolean; servers?: ResolvedServer[]; decision?: ApprovalDecision; inherited?: AnyRecord } = {}) {
  const child = makeFakeChild();
  mocks.spawnChildren.push(child);
  const codex = new FakeCodex(child, opts.inherited);
  const meta: SessionMeta = {
    id: 's1', title: 'Mission', createdAt: 0, updatedAt: 0,
    config: { harness: 'codex', projectRoot: '/proj', permissionMode: opts.mode ?? 'auto' },
    cwd: '/proj', status: 'idle', harnessRef: opts.resume ? { codexThreadId: 'thread-1' } : {}, usage: emptyUsage(),
    ...(opts.mission ? { mission: opts.mission } : {})
  };
  const approvals: ApprovalDraft[] = [];
  const instructions = vi.fn(async () => ROLE_PROMPT);
  const ctx = {
    sessionId: meta.id,
    session: () => meta,
    settings: () => defaultSettings(),
    runtime: { resolve: () => ({ name: 'codex', path: 'C:/fake/codex.exe' }) },
    sessionDir: process.cwd(),
    permissionMode: () => meta.config.permissionMode,
    effort: () => undefined,
    getApiKey: async () => undefined,
    missionInstructions: instructions,
    emit: () => undefined,
    requestApproval: async (draft: ApprovalDraft) => { approvals.push(draft); return opts.decision ?? { optionId: 'deny' }; },
    updateRef: (patch: Partial<HarnessRef>) => Object.assign(meta.harnessRef, patch),
    updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
    log: vi.fn(),
    readJson: async () => null,
    writeJson: async () => undefined,
    mcpServers: async () => opts.servers ?? [],
    ownedMcpIds: () => ['vocs-memory', 'vocs-mission']
  } as unknown as HarnessContext;
  const adapter = new CodexAppServerAdapter(ctx);
  await adapter.start();
  return { adapter, codex, approvals, instructions, spawn: mocks.spawnCalls.at(-1)!, meta };
}

const command = (codex: FakeCodex, cmd: string) => codex.serverRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 't', itemId: `cmd-${cmd}`, command: cmd, cwd: '/proj' });
/** Codex 0.153.4's MCP tool approval, as captured from the real binary. */
const elicitation = (codex: FakeCodex, serverName: string, meta: AnyRecord | null, tool = 'list_builders') =>
  codex.serverRequest('mcpServer/elicitation/request', {
    threadId: 'thread-1', turnId: 't', serverName, mode: 'form', _meta: meta,
    message: `Allow the ${serverName} MCP server to run tool "${tool}"?`, requestedSchema: { type: 'object', properties: {} }
  });

beforeEach(() => {
  mocks.spawnChildren.length = 0;
  mocks.spawnCalls.length = 0;
});

describe('Codex Mission thread configuration', () => {
  it.each([false, true])('sends the Mission server inline, the role prompt as developer instructions and no multi-agent (resume: %s)', async (resume) => {
    const { codex, spawn, adapter } = await start({ mission: LEAD, mode: 'plan', resume, servers: [missionServer()] });
    const params = codex.find(resume ? 'thread/resume' : 'thread/start');
    expect(params.developerInstructions).toBe(ROLE_PROMPT);
    expect(params.config.features).toEqual({ fast_mode: true, multi_agent: false });
    expect(params.config.mcp_servers['vocs-mission']).toMatchObject({
      args: ['C:/app/resources/mcp/vocs-mission.mjs'],
      env: { [MISSION_GATEWAY_URL_ENV]: attachment.url, [MISSION_GATEWAY_TOKEN_ENV]: attachment.token },
      default_tools_approval_mode: 'approve'
    });
    expect(params.config.mcp_servers['vocs-memory']).toEqual({ enabled: false, command: '' });
    // The capability crosses JSON-RPC stdin only, never the command line or the process env.
    expect(JSON.stringify([spawn.file, spawn.args, spawn.opts.env])).not.toContain(attachment.token);
    await adapter.dispose();
  });

  it('keeps an ordinary thread exactly as before', async () => {
    const { codex, instructions, adapter } = await start({ mode: 'plan' });
    const params = codex.find('thread/start');
    expect(params).not.toHaveProperty('developerInstructions');
    expect(params.config.features).toEqual({ fast_mode: true });
    // The reserved name stays off, as Codex suppression always kept it.
    expect(params.config.mcp_servers['vocs-mission']).toEqual({ enabled: false, command: '' });
    expect(instructions).not.toHaveBeenCalled();
    await adapter.dispose();
  });
});

describe('Codex Mission approvals', () => {
  it('accepts Codex’s tool-approval elicitation only for the Mission server of a mission session', async () => {
    const { codex, adapter } = await start({ mission: LEAD, mode: 'plan', servers: [missionServer()] });
    const approval = { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_description: 'List builders', tool_params: {}, tool_params_display: [] };
    const accepted = { action: 'accept', content: {}, _meta: null };
    const declined = { action: 'decline', content: null, _meta: null };
    expect(await elicitation(codex, 'vocs-mission', approval)).toEqual(accepted);
    expect(await elicitation(codex, 'vocs-mission', approval, 'start_builder')).toEqual(accepted);
    // A Builder's tool on a Lead's session, another server, or an elicitation that is not a tool approval.
    expect(await elicitation(codex, 'vocs-mission', approval, 'report_done')).toEqual(declined);
    expect(await elicitation(codex, 'vocs-mission', { ...approval, tool_name: 'land_on_lead' })).toEqual(declined);
    expect(await elicitation(codex, 'other', approval)).toEqual(declined);
    expect(await elicitation(codex, 'vocs-mission', null)).toEqual(declined);
    expect(await elicitation(codex, 'vocs-mission', { codex_approval_kind: 'something_else' })).toEqual(declined);
    await adapter.dispose();
  });

  it('declines every elicitation in an ordinary session, as before', async () => {
    const { codex, adapter, approvals } = await start({ mode: 'auto' });
    expect(await elicitation(codex, 'vocs-mission', { codex_approval_kind: 'mcp_tool_call' })).toEqual({ action: 'decline', content: null, _meta: null });
    expect(await elicitation(codex, 'github', { codex_approval_kind: 'mcp_tool_call' }, 'create_pull_request')).toEqual({ action: 'decline', content: null, _meta: null });
    expect(approvals).toEqual([]);
    await adapter.dispose();
  });

  describe('a Builder and MCP tools the app cannot vouch for', () => {
    const notes: ResolvedServer = { def: { id: 'notes', transport: 'stdio', command: 'node', args: ['notes.mjs'] }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] };
    const memory: ResolvedServer = { def: { id: 'vocs-memory', transport: 'stdio', command: 'node', args: ['memory.mjs'], builtin: 'vocs-memory' }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] };
    // A server from the user's own Codex config that pre-approves its tools, and one switched off.
    const inherited = {
      github: { enabled: true, url: 'https://mcp.github.test', default_tools_approval_mode: 'approve', tools: { create_pull_request: { approval_mode: 'approve' } } },
      parked: { enabled: false, command: 'parked' }
    };
    const approval = { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: { title: 'x' } };

    it('makes Codex ask before every tool but the Mission server’s, its own config’s approvals included', async () => {
      const { codex, adapter } = await start({ mission: BUILDER, mode: 'full-auto', servers: [missionServer(), notes, memory], inherited });
      const servers = codex.find('thread/start').config.mcp_servers;
      expect(servers.github).toEqual({ default_tools_approval_mode: 'prompt', tools: { create_pull_request: { approval_mode: 'prompt' } } });
      expect(servers.notes).toEqual({ command: 'node', args: ['notes.mjs'], default_tools_approval_mode: 'prompt' });
      expect(servers['vocs-memory']).toMatchObject({ default_tools_approval_mode: 'prompt' });
      expect(servers['vocs-mission'].default_tools_approval_mode).toBe('approve');
      expect(servers.parked).toBeUndefined();
      await adapter.dispose();
      // A Lead and an ordinary session send exactly what they did before.
      for (const mission of [LEAD, undefined]) {
        const other = await start({ mission, mode: 'auto', servers: [notes], inherited });
        const sent = other.codex.find('thread/start').config.mcp_servers;
        expect(sent.notes).toEqual({ command: 'node', args: ['notes.mjs'] });
        expect(sent.github).toBeUndefined();
        await other.adapter.dispose();
      }
    });

    it.each(['auto', 'full-auto'] as const)('routes a third-party tool approval to the app in %s and runs trusted built-in tools at once', async (mode) => {
      const { codex, adapter, approvals } = await start({ mission: BUILDER, mode, servers: [missionServer(), memory], inherited, decision: { optionId: 'deny' } });
      expect(await elicitation(codex, 'github', approval, 'create_pull_request')).toEqual({ action: 'decline', content: null, _meta: null });
      expect(approvals).toEqual([expect.objectContaining({ kind: 'tool', toolName: 'github.create_pull_request', input: { title: 'x' } })]);
      expect(await elicitation(codex, 'vocs-memory', approval, 'knowledge_search')).toEqual({ action: 'accept', content: {}, _meta: null });
      expect(await elicitation(codex, 'vocs-mission', approval, 'report_done')).toEqual({ action: 'accept', content: {}, _meta: null });
      // A built-in's tool off the trusted list asks like any other.
      expect(await elicitation(codex, 'vocs-memory', approval, 'knowledge_propose')).toEqual({ action: 'decline', content: null, _meta: null });
      expect(approvals.map((a) => a.toolName)).toEqual(['github.create_pull_request', 'vocs-memory.knowledge_propose']);
      await adapter.dispose();
      const allowing = await start({ mission: BUILDER, mode, servers: [memory], decision: { optionId: 'allow' } });
      expect(await elicitation(allowing.codex, 'github', approval, 'create_pull_request')).toEqual({ action: 'accept', content: {}, _meta: null });
      await allowing.adapter.dispose();
    });

    it('gives a Lead no third-party tool approval', async () => {
      const { codex, adapter, approvals } = await start({ mission: LEAD, mode: 'plan', servers: [missionServer()], inherited });
      expect(await elicitation(codex, 'github', approval, 'create_pull_request')).toEqual({ action: 'decline', content: null, _meta: null });
      expect(approvals).toEqual([]);
      await adapter.dispose();
    });
  });

  it.each(['ask', 'accept-edits', 'auto', 'full-auto'] as const)('asks before a Builder pushes in %s', async (mode) => {
    const { codex, approvals, adapter } = await start({ mission: BUILDER, mode, decision: { optionId: 'allow_session' } });
    expect(await command(codex, 'git push origin mission/parser-b1')).toEqual({ decision: 'accept' });
    expect(await command(codex, 'gh pr create --fill')).toEqual({ decision: 'accept' });
    expect(approvals.map((a) => a.command)).toEqual(['git push origin mission/parser-b1', 'gh pr create --fill']);
    await adapter.dispose();
  });

  it('keeps a Builder’s Full access asking so a push can reach the gate; an ordinary one never asks', async () => {
    const builder = await start({ mission: BUILDER, mode: 'full-auto' });
    expect(builder.codex.find('thread/start').approvalPolicy).toBe('untrusted');
    void builder.adapter.send({ text: 'go' });
    await vi.waitFor(() => expect(builder.codex.find('turn/start').approvalPolicy).toBe('untrusted'));
    expect(await command(builder.codex, 'npm test')).toEqual({ decision: 'accept' });
    expect(builder.approvals).toEqual([]);
    await builder.adapter.dispose();

    const ordinary = await start({ mode: 'full-auto' });
    expect(ordinary.codex.find('thread/start').approvalPolicy).toBe('never');
    void ordinary.adapter.send({ text: 'go' });
    await vi.waitFor(() => expect(ordinary.codex.find('turn/start').approvalPolicy).toBe('never'));
    await ordinary.adapter.dispose();
  });

  it('lets an ordinary Auto session push without asking, as before', async () => {
    const { codex, approvals, adapter } = await start({ mode: 'auto' });
    expect(await command(codex, 'git push origin main')).toEqual({ decision: 'accept' });
    expect(approvals).toEqual([]);
    await adapter.dispose();
  });
});
