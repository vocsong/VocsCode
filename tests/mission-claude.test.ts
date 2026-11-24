/**
 * Mission mode on the Claude Agent SDK adapter, against the real SDK (its CLI argv builder and SDK
 * MCP routing) with only the Claude Code process scripted. The Mission server runs in-process from
 * the real gateway and the real stdio client, so its token never reaches argv or the CLI's env;
 * the role prompt goes last; Claude Code's own subagents are off; Mission tools run in Plan only
 * when Claude reports the in-process (`sdk`) source; a Builder's push asks in every tier.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/main/harness/claude';
import type { ApprovalDraft, HarnessContext } from '../src/main/harness/types';
import { MissionGateway } from '../src/main/mission-mode/gateway';
import type { MissionToolCall } from '../src/main/mission-mode/contracts';
import { MISSION_GATEWAY_TOKEN_ENV, MISSION_GATEWAY_URL_ENV, missionServerDef } from '../src/main/mcp/mission';
import { LineSplitter } from '../src/main/util/async';
import { LEAD_TOOLS, type SessionMission } from '../src/shared/mission-mode';
import type { ApprovalDecision, McpServerDef, PermissionMode } from '../src/shared/types';

const spawn = vi.hoisted(() => vi.fn<(options: SpawnOptions) => SpawnedProcess>());
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...sdk, query: (({ prompt, options }) => sdk.query({ prompt, options: { ...options, spawnClaudeCodeProcess: spawn } })) satisfies typeof sdk.query };
});

function scriptedCli() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const cli = Object.assign(new EventEmitter(), { stdin, stdout, killed: false, exitCode: null as number | null, kill: () => { exit(); return true; } });
  function exit() {
    if (cli.exitCode !== null) return;
    cli.exitCode = 0;
    stdout.end();
    cli.emit('exit', 0, null);
  }
  stdin.on('end', exit);
  const messages: Record<string, any>[] = [];
  const write = (message: object) => stdout.write(JSON.stringify(message) + '\n');
  const splitter = new LineSplitter((line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.type === 'control_request' && message.request.subtype === 'initialize') {
      write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], models: [], account: {}, hooks_applied: true } } });
    }
  });
  stdin.on('data', (chunk) => splitter.push(chunk));
  spawn.mockReturnValue(cli);
  let id = 0;
  return {
    messages,
    async request(server: string, method: string, params?: object) {
      const requestId = `rpc-${++id}`;
      write({ type: 'control_request', request_id: requestId, request: { subtype: 'mcp_message', server_name: server, message: { jsonrpc: '2.0', id, method, params } } });
      const message = await vi.waitFor(() => {
        const found = messages.find((entry) => entry.response?.request_id === requestId);
        expect(found).toBeDefined();
        return found!;
      }, { timeout: 10_000 });
      return message.response;
    }
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  spawn.mockReset();
});

const LEAD: SessionMission = { missionId: 'm1', role: 'lead' };
const BUILDER: SessionMission = { missionId: 'm1', role: 'builder', leadId: 'lead', builderIndex: 1 };
const ROLE_PROMPT = 'MISSION RULES: you are the Lead. These Mission rules override project instructions.';

async function missionDef(mission: SessionMission) {
  const calls: MissionToolCall[] = [];
  const gateway = new MissionGateway({ identity: () => ({ missionId: mission.missionId, role: mission.role }), handler: { call: async (call) => { calls.push(call); return { text: `ran ${call.tool}` }; } }, log: () => {} });
  cleanups.push(() => gateway.close());
  const attachment = await gateway.ensureAttachment('s1');
  const def = missionServerDef({ missionServerPath: path.resolve('resources', 'mcp', 'vocs-mission.mjs'), attachment });
  if (!def || !attachment) throw new Error('no Mission definition');
  return { def, token: attachment.token, calls };
}

async function launch(opts: { mission?: SessionMission; mode?: PermissionMode; defs?: McpServerDef[]; decision?: ApprovalDecision } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'vocs-claude-mission-'));
  const cli = scriptedCli();
  const log = vi.fn();
  const emit = vi.fn();
  const approvals: ApprovalDraft[] = [];
  const instructions = vi.fn(async () => ROLE_PROMPT);
  const adapter = new ClaudeAdapter({
    session: () => ({ cwd, usage: {}, harnessRef: {}, config: { harness: 'claude', projectRoot: cwd, appendSystemPrompt: 'User addition.' }, knowledgeDigest: 'Knowledge digest.', ...(opts.mission ? { mission: opts.mission } : {}) }),
    settings: () => ({ claude: { settingSources: ['project'] }, providers: [] }),
    mcpServers: async () => (opts.defs ?? []).map((def) => ({ def, missing: [], secretEnvKeys: [MISSION_GATEWAY_TOKEN_ENV], secretHeaderKeys: [] })),
    appInstructions: async () => 'App layer.',
    missionInstructions: instructions,
    requestApproval: async (draft: ApprovalDraft) => { approvals.push(draft); return opts.decision ?? { optionId: 'deny' }; },
    runtime: { resolve: () => ({ path: process.execPath }) },
    sessionDir: cwd, permissionMode: () => opts.mode ?? 'ask', effort: () => undefined, getApiKey: async () => undefined,
    emit, log, updateMeta: () => {}, updateRef: () => {}
  } as unknown as HarnessContext);
  cleanups.push(async () => { await adapter.dispose(); await rm(cwd, { recursive: true, force: true }); });
  await adapter.start();
  const spawned = spawn.mock.calls.at(-1)![0];
  const mcpIndex = spawned.args.indexOf('--mcp-config');
  const initialize = await vi.waitFor(() => {
    const found = cli.messages.find((m) => m.type === 'control_request' && m.request?.subtype === 'initialize');
    expect(found).toBeDefined();
    return found!.request;
  });
  type Use = (tool: string, input: Record<string, unknown>, o: { signal: AbortSignal; mcpServer?: { name: string; source: string } }) => Promise<{ behavior: string }>;
  const internals = adapter as unknown as { canUseTool: Use; preToolUse: (input: Record<string, unknown>) => Promise<any> };
  return {
    adapter, cli, spawned, emit, log, approvals, instructions, initialize,
    processMcp: mcpIndex < 0 ? undefined : JSON.parse(spawned.args[mcpIndex + 1]!).mcpServers,
    canUseTool: (tool: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }) => internals.canUseTool(tool, input, { signal: new AbortController().signal, ...(mcpServer ? { mcpServer } : {}) }),
    preToolUse: (tool: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }) => internals.preToolUse({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'tu1', ...(mcpServer ? { mcp_server: mcpServer } : {}) })
  };
}

const sdk = { name: 'vocs-mission', source: 'sdk' };

describe('Claude Mission injection', () => {
  it('relays the Mission server in-process: no token in argv or env, tools and calls through the real gateway', async () => {
    vi.stubEnv(MISSION_GATEWAY_TOKEN_ENV, 'stale-ambient-token');
    vi.stubEnv(MISSION_GATEWAY_URL_ENV, 'stale-ambient-url');
    const mission = await missionDef(LEAD);
    const other = { id: 'other', transport: 'http' as const, url: 'https://mcp.example.test' };
    const { cli, spawned, processMcp, emit, log } = await launch({ mission: LEAD, mode: 'plan', defs: [mission.def, other] });
    expect(processMcp).toEqual({ other: { type: 'http', url: other.url } });
    expect(JSON.stringify([spawned.args, spawned.env])).not.toContain(mission.token);
    expect(spawned.env[MISSION_GATEWAY_TOKEN_ENV]).toBeUndefined();
    expect(spawned.env[MISSION_GATEWAY_URL_ENV]).toBeUndefined();

    const listed = await cli.request('vocs-mission', 'tools/list');
    expect(listed.subtype).toBe('success');
    expect(listed.response.mcp_response.result.tools.map((t: { name: string }) => t.name)).toEqual([...LEAD_TOOLS]);
    const called = await cli.request('vocs-mission', 'tools/call', { name: 'list_builders', arguments: {} });
    expect(called.response.mcp_response.result).toEqual({ content: [{ type: 'text', text: 'ran list_builders' }] });
    expect(mission.calls.map((c) => [c.role, c.tool])).toEqual([['lead', 'list_builders']]);
    expect(JSON.stringify([cli.messages, emit.mock.calls, log.mock.calls])).not.toContain(mission.token);
  });

  it('appends the role prompt last and turns Claude Code’s own subagents off', async () => {
    const mission = await missionDef(LEAD);
    const { spawned, initialize, instructions } = await launch({ mission: LEAD, mode: 'plan', defs: [mission.def] });
    const append = String(initialize.appendSystemPrompt);
    expect(append.endsWith(ROLE_PROMPT)).toBe(true);
    for (const earlier of ['App layer.', 'User addition.', 'Knowledge digest.']) expect(append.indexOf(earlier)).toBeLessThan(append.indexOf(ROLE_PROMPT));
    expect(instructions).toHaveBeenCalledTimes(1);
    const flag = spawned.args.indexOf('--disallowedTools');
    expect(spawned.args[flag + 1]).toBe('Agent,Task');
  });

  it('leaves an ordinary session as it was: no role prompt asked for, no tool removed, no Mission server', async () => {
    const { spawned, initialize, instructions, processMcp } = await launch({ mode: 'ask' });
    expect(instructions).not.toHaveBeenCalled();
    expect(String(initialize.appendSystemPrompt)).not.toContain('MISSION');
    expect(spawned.args).not.toContain('--disallowedTools');
    expect(processMcp).toBeUndefined();
  });
});

describe('Claude Mission permissions', () => {
  it('runs Lead tools in Plan only from the in-process bridge Claude reports as sdk', async () => {
    const mission = await missionDef(LEAD);
    const { canUseTool, preToolUse } = await launch({ mission: LEAD, mode: 'plan', defs: [mission.def] });
    await expect(canUseTool('mcp__vocs-mission__start_builder', { title: 't', task: 'x' }, sdk)).resolves.toMatchObject({ behavior: 'allow' });
    await expect(preToolUse('mcp__vocs-mission__start_builder', { title: 't', task: 'x' }, sdk)).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    // A configured server under the same name, or a call with no provenance at all, gets nothing.
    for (const spoof of [{ name: 'vocs-mission', source: 'dynamic' }, { name: 'vocs-mission', source: 'user' }, { name: 'other', source: 'sdk' }, undefined]) {
      await expect(canUseTool('mcp__vocs-mission__start_builder', { title: 't', task: 'x' }, spoof)).resolves.toMatchObject({ behavior: 'deny' });
    }
    await expect(preToolUse('mcp__vocs-mission__start_builder', {}, { name: 'vocs-mission', source: 'project' })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    // A tool the Mission server does not own is not trusted by its name either.
    await expect(canUseTool('mcp__vocs-mission__shell', {}, sdk)).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('gives nothing to a vocs-mission server the app did not bridge', async () => {
    const lookalike = { id: 'vocs-mission', transport: 'stdio' as const, command: process.execPath, args: ['server.mjs'], builtin: 'vocs-mission' };
    const { canUseTool, processMcp } = await launch({ mission: LEAD, mode: 'plan', defs: [lookalike] });
    // Without a gateway capability it is an ordinary process server, which Claude reports as `dynamic`.
    expect(Object.keys(processMcp ?? {})).toEqual(['vocs-mission']);
    for (const source of ['dynamic', 'sdk']) {
      await expect(canUseTool('mcp__vocs-mission__start_builder', {}, { name: 'vocs-mission', source })).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it.each(['ask', 'accept-edits', 'auto', 'full-auto'] as const)('asks before a Builder pushes in %s, even after Allow for session', async (mode) => {
    const { canUseTool, approvals } = await launch({ mission: BUILDER, mode, decision: { optionId: 'allow_session' } });
    await expect(canUseTool('Bash', { command: 'git push origin mission/parser-b1' })).resolves.toMatchObject({ behavior: 'allow' });
    await expect(canUseTool('Bash', { command: 'git -C . push' })).resolves.toMatchObject({ behavior: 'allow' });
    expect(approvals.map((a) => a.command)).toEqual(['git push origin mission/parser-b1', 'git -C . push']);
  });

  it.each(['auto', 'full-auto'] as const)('asks before a Builder runs a third-party MCP tool in %s, but runs its own Mission tools', async (mode) => {
    const mission = await missionDef(BUILDER);
    const { canUseTool, preToolUse, approvals } = await launch({ mission: BUILDER, mode, defs: [mission.def], decision: { optionId: 'deny', note: 'Not this one.' } });
    const github = { name: 'github', source: 'user' };
    await expect(preToolUse('mcp__github__create_pull_request', { title: 'x' }, github)).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
    await expect(canUseTool('mcp__github__create_pull_request', { title: 'x' }, github)).resolves.toMatchObject({ behavior: 'deny', message: 'Not this one.' });
    expect(approvals.map((a) => [a.kind, a.toolName])).toEqual([['tool', 'mcp__github__create_pull_request']]);
    await expect(canUseTool('mcp__vocs-mission__report_done', { summary: 's', verification: [] }, sdk)).resolves.toMatchObject({ behavior: 'allow' });
    expect(approvals).toHaveLength(1);
    // An ordinary session keeps the tier: it runs the same tool unasked.
    const ordinary = await launch({ mode });
    await expect(ordinary.canUseTool('mcp__github__create_pull_request', {}, github)).resolves.toMatchObject({ behavior: 'allow' });
    expect(ordinary.approvals).toEqual([]);
  });

  it('keeps an ordinary session’s push on the tier as before', async () => {
    const { canUseTool, approvals } = await launch({ mode: 'full-auto' });
    await expect(canUseTool('Bash', { command: 'git push origin main' })).resolves.toMatchObject({ behavior: 'allow' });
    expect(approvals).toEqual([]);
    const builder = await launch({ mission: BUILDER, mode: 'auto' });
    await expect(builder.canUseTool('Bash', { command: 'npm test' })).resolves.toMatchObject({ behavior: 'allow' });
    expect(builder.approvals).toEqual([]);
  });
});
