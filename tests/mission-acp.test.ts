/**
 * Mission mode on the ACP adapter (Builders only: ACP permission requests do not name the tool, so
 * a Lead's Plan could not recognise its Mission tools). The Mission server reaches the agent in
 * `session/new` with an absolute command and its capability in the env list, never on the agent's
 * command line; a Builder's push asks in every tier, "always allow" included. The role prompt is the
 * session manager's first-message preamble, not this adapter's.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import type { ApprovalDraft, HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { createAdapter } from '../src/main/harness/registry';
import { MISSION_GATEWAY_TOKEN_ENV, MISSION_GATEWAY_URL_ENV, missionServerDef } from '../src/main/mcp/mission';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import type { SessionMission } from '../src/shared/mission-mode';
import type { PermissionMode, SessionMeta } from '../src/shared/types';

type AnyRecord = Record<string, any>;

const spawnState = vi.hoisted(() => ({ children: [] as AnyRecord[], spawnCalls: [] as { file: string; args: string[]; opts: AnyRecord }[] }));
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

/** Minimal ACP agent over the fake child's streams: answers requests and sends its own. */
class FakeAgent {
  readonly requests: AnyRecord[] = [];
  private buf = '';
  private serverId = 1;
  private readonly pending = new Map<string, (msg: AnyRecord) => void>();
  constructor(private readonly child: AnyRecord) {
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
      this.pending.get(msg.id)?.(msg);
      this.pending.delete(msg.id);
      return;
    }
    this.requests.push(msg);
    if (msg.id === undefined || msg.id === null) return;
    const result = msg.method === 'initialize' ? { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} } : msg.method === 'session/new' ? { sessionId: 'sess-1' } : {};
    queueMicrotask(() => this.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'));
  }
  request(method: string, params: AnyRecord): Promise<AnyRecord> {
    const id = `srv_${this.serverId++}`;
    const reply = new Promise<AnyRecord>((resolve) => this.pending.set(id, resolve));
    this.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return reply;
  }
}

const BUILDER: SessionMission = { missionId: 'm1', role: 'builder', leadId: 'lead', builderIndex: 1 };
const attachment = { url: 'http://127.0.0.1:4567', token: 'A'.repeat(43) };
const created: { adapter: HarnessAdapter; child: AnyRecord }[] = [];

async function start(mode: PermissionMode, opts: { mission?: SessionMission; choice?: string } = {}) {
  const child = new EventEmitter() as AnyRecord;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 4242, kill: vi.fn() });
  spawnState.children.push(child);
  const agent = new FakeAgent(child);
  const settings = defaultSettings();
  settings.acpAgents = [{ id: 'test-agent', name: 'Test Agent', description: '', command: 'test-agent', args: [] }];
  (settings.binaries as Record<string, string | undefined>)['test-agent'] = 'C:/fake/acp-agent.exe';
  const meta: SessionMeta = {
    id: 's1', title: 't', createdAt: 0, updatedAt: 0,
    config: { harness: 'acp', projectRoot: process.cwd(), permissionMode: mode, acpAgent: 'test-agent' },
    cwd: process.cwd(), status: 'idle', harnessRef: {}, usage: emptyUsage(), ...(opts.mission ? { mission: opts.mission } : {})
  };
  const approvals: ApprovalDraft[] = [];
  const def = missionServerDef({ missionServerPath: path.resolve('resources', 'mcp', 'vocs-mission.mjs'), attachment })!;
  const ctx = {
    sessionId: meta.id, session: () => meta, settings: () => settings,
    runtime: { runtimePaths: { appRuntimeDir: process.cwd() }, resolve: vi.fn(() => null) },
    sessionDir: process.cwd(), permissionMode: () => meta.config.permissionMode, effort: () => undefined, getApiKey: async () => undefined,
    emit: () => undefined,
    requestApproval: async (draft: ApprovalDraft) => { approvals.push(draft); return { optionId: opts.choice ?? 'o1' }; },
    updateRef: () => undefined, updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch), log: () => undefined,
    readJson: async () => null, writeJson: async () => undefined,
    mcpServers: async () => opts.mission ? [{ def, missing: [], secretEnvKeys: [MISSION_GATEWAY_TOKEN_ENV], secretHeaderKeys: [] }] : [],
    ownedMcpIds: () => []
  } as unknown as HarnessContext;
  const adapter = createAdapter('acp', ctx);
  created.push({ adapter, child });
  await adapter.start();
  const ask = (command: string) => agent.request('session/request_permission', {
    sessionId: 'sess-1',
    toolCall: { toolCallId: `tc-${command}`, kind: 'execute', title: command, rawInput: { command } },
    options: [
      { optionId: 'o1', name: 'Allow', kind: 'allow_once' },
      { optionId: 'o3', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'o2', name: 'Deny', kind: 'reject_once' }
    ]
  });
  return { agent, approvals, ask, spawn: spawnState.spawnCalls.at(-1)! };
}

beforeEach(() => {
  spawnState.children.length = 0;
  spawnState.spawnCalls.length = 0;
});
afterEach(async () => {
  for (const { adapter, child } of created.splice(0)) {
    await adapter.dispose().catch(() => undefined);
    child.stdin.destroy();
    child.stdout.destroy();
  }
});

describe('ACP Mission Builder', () => {
  it('hands the agent the Mission server in session/new, never on its command line', async () => {
    const { agent, spawn } = await start('auto', { mission: BUILDER });
    const sent = agent.requests.find((r) => r.method === 'session/new')!.params.mcpServers as AnyRecord[];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: 'vocs-mission', args: [path.resolve('resources', 'mcp', 'vocs-mission.mjs')] });
    expect(path.isAbsolute(sent[0]!.command)).toBe(true);
    expect(sent[0]!.env).toEqual(expect.arrayContaining([{ name: MISSION_GATEWAY_URL_ENV, value: attachment.url }, { name: MISSION_GATEWAY_TOKEN_ENV, value: attachment.token }]));
    expect(JSON.stringify([spawn.file, spawn.args])).not.toContain(attachment.token);
  });

  it.each(['ask', 'accept-edits', 'auto', 'full-auto'] as const)('asks before a Builder pushes in %s, even after an "always allow"', async (mode) => {
    const { ask, approvals } = await start(mode, { mission: BUILDER, choice: 'o3' });
    expect((await ask('git push origin mission/parser-b1')).result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
    expect((await ask('gh release create v1')).result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
    expect(approvals.map((a) => a.command)).toEqual(['git push origin mission/parser-b1', 'gh release create v1']);
  });

  it.each(['auto', 'full-auto'] as const)('asks before a Builder runs what may be a third-party MCP tool in %s', async (mode) => {
    const { agent, approvals } = await start(mode, { mission: BUILDER });
    const request = (kind: string, title: string) => agent.request('session/request_permission', {
      sessionId: 'sess-1', toolCall: { toolCallId: `tc-${kind}-${title}`, kind, title, rawInput: { title: 'x' } },
      options: [{ optionId: 'o1', name: 'Allow', kind: 'allow_once' }, { optionId: 'o2', name: 'Deny', kind: 'reject_once' }]
    });
    // ACP does not name the tool: `other`, an undefined kind, or an MCP-style title all count.
    for (const [kind, title] of [['other', 'create_pull_request'], ['publish', 'Publish'], ['fetch', 'mcp__github__get_pr']]) {
      expect((await request(kind, title)).result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
    }
    expect(approvals.map((a) => a.title)).toEqual(['create_pull_request', 'Publish', 'mcp__github__get_pr']);
    // A plain read stays a read.
    expect((await request('read', 'Read src/a.ts')).result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
    expect(approvals).toHaveLength(3);
    const ordinary = await start(mode);
    expect((await ordinary.agent.request('session/request_permission', {
      sessionId: 'sess-1', toolCall: { toolCallId: 'tc-o', kind: 'other', title: 'create_pull_request', rawInput: {} },
      options: [{ optionId: 'o1', name: 'Allow', kind: 'allow_once' }, { optionId: 'o2', name: 'Deny', kind: 'reject_once' }]
    })).result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
    expect(ordinary.approvals).toEqual([]);
  });

  it('runs a Builder’s ordinary command in Auto and leaves an ordinary session’s push on the tier', async () => {
    const builder = await start('auto', { mission: BUILDER });
    expect((await builder.ask('npm test')).result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
    expect(builder.approvals).toEqual([]);
    for (const mode of ['auto', 'full-auto'] as const) {
      const ordinary = await start(mode);
      expect((await ordinary.ask('git push origin main')).result).toEqual({ outcome: { outcome: 'selected', optionId: 'o1' } });
      expect(ordinary.approvals).toEqual([]);
      expect(ordinary.agent.requests.find((r) => r.method === 'session/new')!.params.mcpServers).toEqual([]);
    }
  });
});
