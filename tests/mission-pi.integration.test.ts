/** Real installed Pi, real shipped gates/bridge, production adapter, offline scripted model.
 * The only launch seam adds a deterministic provider extension; policy args/env and process-tree
 * containment still come from PiAdapter and the production Job supervisor.
 */
import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent, SessionMeta } from '../src/shared/types';
import { MissionToolBroker } from '../src/main/mission/tools';
import { LineSplitter } from '../src/main/util/async';
import { piIntegrationPaths, type PiEvent, type ScriptedCall } from './pi-offline-runner';
import type { OwnedWindowsJobOptions } from '../src/main/owned-windows-job';
import { missionFixture } from './support/mission-fixture';

const run = vi.hoisted(() => ({ cli: '', agentDir: '', extensions: [] as string[], omitExtension: '', events: [] as PiEvent[], children: [] as ChildProcess[], args: [] as string[] }));
vi.mock('../src/main/owned-windows-job', async (original) => {
  const actual = await original<typeof import('../src/main/owned-windows-job')>();
  return { ...actual, launchOwnedWindowsJob: (options: OwnedWindowsJobOptions<ChildProcess>) => {
    const args = options.args; run.args = args;
    const activeArgs = run.omitExtension ? args.filter((arg, index) => !(arg === '-e' && args[index + 1]?.endsWith(run.omitExtension)) && !arg.endsWith(run.omitExtension)) : args;
    const owned = actual.launchOwnedWindowsJob({
      ...options, executable: process.execPath, commandLine: undefined,
      args: [run.cli, ...activeArgs, '--offline', '--no-themes',
        ...run.extensions.flatMap((file) => ['-e', file]), '-e', path.resolve('tests/fixtures/pi-scripted-provider.mjs')],
    });
    run.children.push(owned.process);
    const lines = new LineSplitter((line) => { try { run.events.push(JSON.parse(line)); } catch { /* adapter owns logs */ } });
    owned.process.stdout?.on('data', (data: Buffer) => lines.push(data));
    return owned;
  } };
});

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const roots: string[] = [];
const adapters: PiAdapter[] = [];
const brokers: MissionToolBroker[] = [];
const externalServers: Server[] = [];
const call = (id: string, name: string, args: Record<string, unknown>): ScriptedCall => ({ id, name, arguments: args });
const ends = (events: PiEvent[]) => events.filter((event) => event.type === 'tool_execution_end');
const output = (event: PiEvent) => event.result.content.map((part: PiEvent) => part.text ?? '').join('\n');

async function until(predicate: () => boolean, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(diagnostic());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(options: { readOnly?: boolean; questionId?: string; requested?: string[]; lateTool?: boolean; omitExtension?: string } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mission-pi-real-')); roots.push(root);
  const cwd = path.join(root, 'workspace'); const agentDir = path.join(root, 'agent');
  await fs.mkdir(cwd); await fs.mkdir(agentDir); await fs.mkdir(path.join(cwd, '.pi'));
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'MISSION_PROJECT_RULES_PRESERVED');
  // Neither global nor project extensions may run, even if project settings are otherwise trusted.
  const evil = path.join(root, 'auto-extension.mjs');
  await fs.writeFile(evil, `import { writeFileSync } from 'node:fs'; export default function(pi) { writeFileSync(${JSON.stringify(path.join(root, 'AUTO_EXTENSION_EXECUTED'))}, 'BAD'); pi.registerTool({ name:'subagent', description:'forbidden', parameters:{type:'object',properties:{}}, execute:async()=>({content:[]}) }); }`);
  const settings = { compaction: { enabled: false }, retry: { enabled: false }, extensions: [evil], defaultThinkingLevel: 'medium', defaultProjectTrust: 'always' };
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ extensions: [evil] }));
  run.agentDir = agentDir; run.events = []; run.extensions = []; run.omitExtension = options.omitExtension ?? '';
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir); vi.stubEnv('PI_OFFLINE', '1'); vi.stubEnv('PI_TELEMETRY', '0');
  if (options.lateTool) {
    const late = path.join(root, 'late-extension.mjs');
    // This adversarial fixture is explicit test instrumentation, never a user extraArg.
    await fs.writeFile(late, `import { writeFileSync } from 'node:fs'; export default function(pi) { pi.on('before_agent_start', () => { pi.registerTool({ name:'late_fanout', description:'must never run', parameters:{type:'object',properties:{}}, execute:async()=> { writeFileSync(${JSON.stringify(path.join(root, 'LATE_EXECUTED'))}, 'BAD'); return {content:[]}; } }); pi.setActiveTools([...pi.getActiveTools(),'late_fanout']); }); }`);
    run.extensions = [late];
  }
  const invoke = vi.fn(async (_binding, name) => ({ operation: name, revision: 2 }));
  const broker = new MissionToolBroker({ validate: () => {}, invoke }); brokers.push(broker); await broker.start();
  const server = broker.attach({ missionId: 'm1', ...(options.questionId ? { questionId: options.questionId } : {}), actor: { kind: 'lead', sessionId: 's1', generation: 1 } });
  const events: SessionEvent[] = []; const logs: string[] = [];
  const meta: SessionMeta = {
    id: 's1', title: 'Mission', createdAt: 0, updatedAt: 0, cwd, status: 'idle', harnessRef: {},
    config: { harness: 'pi', projectRoot: cwd, permissionMode: 'full-auto', model: { provider: 'vocs-offline', model: 'scripted' }, appendSystemPrompt: 'MISSION_APPEND_PRESERVED' },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    mission: { missionId: 'm1', role: 'lead', generation: 1, sourceAccess: options.readOnly || options.questionId ? 'read_only' : 'assigned_workspace', requestedTools: options.requested ?? [], reasoningDefault: true, ...(options.questionId ? { questionId: options.questionId } : {}) },
  };
  const approve = vi.fn(async () => ({ optionId: 'deny' }));
  const ctx = {
    sessionId: 's1', session: () => meta, sessionDir: path.join(root, 'session'),
    settings: () => ({ pi: { extraArgs: [] }, providers: [] }),
    runtime: { resolve: () => ({ path: run.cli, source: 'installed' }), resource: (...parts: string[]) => path.resolve('resources', ...parts) },
    permissionMode: () => meta.config.permissionMode, effort: () => undefined, getApiKey: async () => undefined,
    mcpServers: async () => [server], ownedMcpIds: () => ['vocs-mission'], requestApproval: approve,
    emit: (event: SessionEvent) => events.push(event), log: (_level: string, message: string) => logs.push(message),
    updateRef: (patch: object) => Object.assign(meta.harnessRef, patch), updateMeta: (patch: object) => Object.assign(meta, patch),
  } as unknown as HarnessContext;
  const adapter = new PiAdapter(ctx); adapters.push(adapter);
  const prompt = async (calls: ScriptedCall[]) => {
    const from = run.events.length; const normalizedFrom = events.length;
    await adapter.send({ text: JSON.stringify({ calls }) });
    await until(() => run.events.slice(from).some((event) => event.type === 'agent_settled') && events.slice(normalizedFrom).some((event) => event.type === 'item.upsert' && event.item.kind === 'turn'), () => JSON.stringify({ logs, events: run.events.slice(-8) }));
    const results = run.events.slice(from);
    expect(results.filter((event) => event.type === 'agent_settled')).toHaveLength(1);
    expect(events.slice(normalizedFrom).filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn')).toHaveLength(1);
    expect(adapter.busy).toBe(false);
    expect(events.slice(normalizedFrom).filter((event) => event.type === 'error')).toHaveLength(0);
    return results;
  };
  return { root, cwd, agentDir, meta, ctx, events, logs, broker, server, adapter, prompt, approve, invoke };
}

describe.skipIf(!enabled)('managed Mission on real installed Pi (offline model)', () => {
  beforeAll(() => { run.cli = piIntegrationPaths().cli; }); // Selected but absent/wrong runtime FAILS.
  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
    await Promise.all(externalServers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
    expect(run.children.splice(0).every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })));
    vi.unstubAllEnvs();
  });

  it('proves the shipped Mission gate/core/MCP readiness and absence of registered native delegation', async () => {
    const h = await setup(); await h.adapter.start();
    const metadata = run.events.find((event) => event.message?.startsWith?.('PI_FIXTURE_TOOLS::'));
    const { active, tools } = JSON.parse(metadata!.message.slice('PI_FIXTURE_TOOLS::'.length));
    expect(await h.adapter.missionReadiness()).toEqual({ ready: true, tools: active, model: { provider: 'vocs-offline', model: 'scripted' }, modelAvailable: true, connectionAvailable: true });
    expect(h.meta.activeEffort).toBeUndefined(); // Real non-reasoning model reports off, not configured medium.
    expect(run.events.filter((event) => event.type === 'agent_start')).toHaveLength(0);
    expect(active).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash', 'rg', 'glob', 'ls', 'mission_read', 'mission_plan_update', 'mission_report']));
    expect(tools.map((tool: PiEvent) => tool.name)).not.toEqual(expect.arrayContaining(['subagent']));
    for (const name of ['subagent', 'subagent_result', 'subagent_steer', 'Agent', 'Task', 'ask_question']) expect(tools.map((tool: PiEvent) => tool.name)).not.toContain(name);
    expect(await fs.readdir(h.root)).not.toContain('AUTO_EXTENSION_EXECUTED');
    expect(await fs.readdir(h.agentDir)).not.toContain('agents');
    expect(run.args).not.toContain('--thinking');
    const events = await h.prompt([call('delegate', 'subagent', { task: 'should not execute' })]);
    expect(ends(events)).toHaveLength(1); expect(ends(events)[0].isError).toBe(true);
    expect(await fs.readdir(path.join(h.root, 'session', 'pi'))).not.toContain('subagents');
    const prompt = JSON.parse(events.find((event) => event.message?.startsWith?.('PI_FIXTURE_PROMPT::'))!.message.slice('PI_FIXTURE_PROMPT::'.length)).systemPrompt;
    expect(prompt).toContain('MISSION_PROJECT_RULES_PRESERVED'); expect(prompt).toContain('MISSION_APPEND_PRESERVED');
  });

  it('answers in an installed model conversation while its host-bound question scope rejects all execution tools', async () => {
    const h = await setup({ questionId: 'genuine-user-question' }); h.meta.config.permissionMode = 'plan';
    await h.adapter.start().catch((error) => { throw new Error(`${error}\n${h.logs.join('\n')}\n${JSON.stringify(h.events)}`); });
    expect((await h.adapter.missionReadiness()).tools).toEqual(['mission_read', 'mission_context_read']);
    await fs.writeFile(path.join(h.root, 'session', 'pi', 'permission-mode.txt'), 'full-auto');
    const events = await h.prompt([
      call('retained', 'mission_read', { payload: {} }),
      call('context', 'mission_context_read', { payload: { ref: 'retained-output' } }),
      call('plan', 'mission_plan_update', { expectedRevision: 1, idempotencyKey: 'forged', payload: { questionId: 'genuine-user-question', readOnly: true } }),
      call('delegate', 'mission_task_delegate', { expectedRevision: 1, idempotencyKey: 'delegate', payload: {} }),
      call('check', 'mission_verification_request', { expectedRevision: 1, idempotencyKey: 'check', payload: {} }),
      call('deliver', 'mission_finish_request', { expectedRevision: 1, idempotencyKey: 'finish', payload: {} }),
      call('write', 'write', { path: 'forbidden.txt', content: 'BAD' }),
      call('shell', 'bash', { command: 'printf BAD > forbidden-shell.txt' }),
    ]);
    expect(ends(events)).toHaveLength(8); expect(ends(events).filter((event) => event.isError)).toHaveLength(6);
    expect(h.invoke.mock.calls.map(([, name]) => name)).toEqual(['mission_read', 'mission_context_read']);
    expect(h.events.some((event) => event.type === 'item.upsert' && event.item.kind === 'assistant' && !!event.item.text)).toBe(true);
    expect(h.approve).not.toHaveBeenCalled(); expect(await fs.readdir(h.cwd)).toEqual(['.pi', 'AGENTS.md']);
  });

  it.each([true, false])('Plan coordinates but cannot write or advertise writes after permission widening (read-only source: %s)', async (readOnly) => {
    const h = await setup({ readOnly }); h.meta.config.permissionMode = 'plan'; await h.adapter.start(); await h.adapter.setPermissionMode('full-auto');
    const readiness = await h.adapter.missionReadiness();
    expect(readiness.ready).toBe(true);
    for (const name of ['write', 'edit', 'bash', 'powershell']) expect(readiness.tools).not.toContain(name);
    expect(readiness.tools).toEqual(expect.arrayContaining(['read', 'mission_read', 'mission_plan_update']));
    const events = await h.prompt([
      call('read', 'mission_read', { payload: {} }),
      call('plan', 'mission_plan_update', { expectedRevision: 1, idempotencyKey: 'update1', payload: { expectedPlanRevision: 0, plan: missionFixture().plan } }),
      call('write', 'write', { file_path: 'forbidden.txt', content: 'BAD' }),
      call('shell', 'bash', { command: 'printf BAD > forbidden-shell.txt' }),
      call('spoof', 'mcp__vocs_mission__mission_authorize_execution', { payload: {} }),
    ]);
    expect(ends(events)).toHaveLength(5); expect(ends(events).filter((event) => event.isError), JSON.stringify(ends(events))).toHaveLength(3);
    expect(h.invoke).toHaveBeenCalledTimes(2); expect(h.approve).not.toHaveBeenCalled();
    expect(await fs.readdir(h.cwd)).toEqual(['.pi', 'AGENTS.md']);
    expect(output(ends(events).find((event) => event.toolCallId === 'plan')!)).toContain('mission_plan_update');
    const token = h.server.def.headers!.Authorization.replace('Bearer ', '');
    expect(JSON.stringify([run.events, h.events, h.logs, run.args])).not.toContain(token);
    const files = await fs.readdir(h.root, { recursive: true, withFileTypes: true });
    for (const file of files.filter((entry) => entry.isFile())) expect(await fs.readFile(path.join(file.parentPath, file.name), 'utf8')).not.toContain(token);
  });

  it.each(['untrusted', 'vocs_memory'])('retains the read-only ceiling for MCP %s even if it claims readOnly and the mode file is widened', async (serverId) => {
    const h = await setup({ readOnly: true });
    const mutate = vi.fn();
    const external = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const message = JSON.parse(body);
        if (message.method === 'tools/call') mutate();
        const result = message.method === 'tools/list'
          ? { tools: [{ name: 'mutate', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
          : message.method === 'initialize'
            ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'untrusted', version: '1' } }
            : { content: [{ type: 'text', text: 'BAD' }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
    });
    externalServers.push(external);
    await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
    h.ctx.mcpServers = async () => [h.server, { def: { id: serverId, transport: 'http', url: `http://127.0.0.1:${(external.address() as AddressInfo).port}` }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] }];
    await h.adapter.start();
    await fs.writeFile(path.join(h.root, 'session', 'pi', 'permission-mode.txt'), 'full-auto');
    expect((await h.adapter.missionReadiness()).tools).not.toContain(`mcp__${serverId}__mutate`);
    const events = await h.prompt([call('other', `mcp__${serverId}__mutate`, {}), call('read', 'mission_read', { payload: {} })]);
    expect(ends(events)).toHaveLength(2); expect(ends(events).filter((event) => event.isError)).toHaveLength(1);
    expect(mutate).not.toHaveBeenCalled(); expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('clears queued work before abort and releases the turn only at the real drain boundary', async () => {
    const h = await setup(); await h.adapter.start();
    const from = run.events.length; const normalizedFrom = h.events.length;
    await h.adapter.send({ text: JSON.stringify({ calls: [call('cancel-shell', 'bash', { command: 'printf STARTED; sleep 20; printf BAD > late.txt' })] }) });
    await until(() => run.events.slice(from).some((event) => event.type === 'tool_execution_update' && JSON.stringify(event.partialResult).includes('STARTED')), () => JSON.stringify(run.events.slice(-8)));
    await h.adapter.send({ text: JSON.stringify({ calls: [call('must-not-run', 'write', { path: 'queued.txt', content: 'BAD' })] }), mode: 'queue' });
    await h.adapter.interrupt();
    await until(() => run.events.slice(from).some((event) => event.type === 'agent_settled') && !h.adapter.busy, () => JSON.stringify(run.events.slice(-8)));
    const events = run.events.slice(from);
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_settled')).toHaveLength(1);
    expect(ends(events)).toHaveLength(1); expect(ends(events)[0]).toMatchObject({ toolCallId: 'cancel-shell', isError: true });
    const terminal = h.events.slice(normalizedFrom).filter((event) => event.type === 'item.upsert' && event.item.kind === 'turn');
    expect(terminal).toHaveLength(1); expect(terminal[0]).toMatchObject({ item: { status: 'interrupted' } });
    const after = await h.prompt([call('after-cancel', 'read', { path: 'AGENTS.md' })]);
    expect(ends(after)).toHaveLength(1); expect(ends(after)[0]).toMatchObject({ toolCallId: 'after-cancel', isError: false });
    expect(await fs.readdir(h.cwd)).toEqual(['.pi', 'AGENTS.md']);
  });

  it('stops a detached tool descendant before managed disposal returns, even after the real turn settled', async () => {
    const h = await setup(); await h.adapter.start();
    const armed = path.join(h.root, 'descendant-ready'); const late = path.join(h.root, 'late-write');
    const launcher = path.join(h.cwd, 'launch-detached.cjs');
    await fs.writeFile(launcher, `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(armed)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'UNSAFE'), 5000);`)}], { detached: true, stdio: 'ignore' }); child.unref();`);
    const quote = (value: string) => `'${value.replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`;
    const events = await h.prompt([call('detached', 'bash', { command: `${quote(process.execPath)} ${quote(launcher)}` })]);
    expect(ends(events)).toHaveLength(1); expect(ends(events)[0]).toMatchObject({ toolCallId: 'detached', isError: false });
    await until(() => existsSync(armed), () => 'The detached tool child did not start');
    expect(await fs.readFile(armed, 'utf8')).toBe('ready');
    await h.adapter.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5300));
    expect(await fs.readdir(h.root)).not.toContain('late-write');
    expect(await h.adapter.missionReadiness()).toMatchObject({ ready: false, tools: [] });
  }, 30000);

  it('rejects unknown fan-out even when a late extension registers and activates it', async () => {
    const h = await setup({ lateTool: true }); await h.adapter.start();
    const events = await h.prompt([call('late', 'late_fanout', {})]);
    expect(ends(events)).toHaveLength(1); expect(ends(events)[0].isError).toBe(true);
    expect(output(ends(events)[0])).toContain('allowlist');
    expect(await fs.readdir(h.root)).not.toContain('LATE_EXECUTED');
  });

  it('routes heavy checks/delivery to the host and consumes the token before any permitted shell executes', async () => {
    const h = await setup(); await h.adapter.start();
    const events = await h.prompt([
      call('build', 'bash', { command: 'npm run build' }),
      call('push', 'bash', { command: 'git push origin HEAD' }),
      call('env', 'bash', { command: 'printf "ephemeral=%s" "$VOCS_CODE_MCP_EPHEMERAL"' }),
      call('file', 'write', { path: 'normal.txt', content: 'OK' }),
    ]);
    expect(ends(events)).toHaveLength(4); expect(ends(events).filter((event) => event.isError)).toHaveLength(2);
    expect(output(ends(events).find((event) => event.toolCallId === 'build')!)).toContain('mission_verification_request');
    expect(output(ends(events).find((event) => event.toolCallId === 'env')!)).toBe('ephemeral=');
    expect(await fs.readFile(path.join(h.cwd, 'normal.txt'), 'utf8')).toBe('OK');
  });

  it('enforces requested tool subsets against live tool discovery and rejects unknown requests at startup', async () => {
    const h = await setup({ requested: ['read'] }); await h.adapter.start();
    const events = await h.prompt([call('write', 'write', { path: 'forbidden.txt', content: 'BAD' }), call('read', 'read', { path: 'AGENTS.md' })]);
    expect(ends(events)).toHaveLength(2); expect(ends(events).filter((event) => event.isError)).toHaveLength(1);
    expect(await fs.readdir(h.cwd)).not.toContain('forbidden.txt');
    await h.adapter.dispose();
    const invalid = await setup({ requested: ['subagent'] });
    await expect(invalid.adapter.send({ text: 'not accepted' })).rejects.toThrow('unavailable or prohibited');
    expect(invalid.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
  });

  it.each(['mission', 'mcp', 'approvals', 'tools'])('refuses before a model prompt when the actual shipped %s extension is absent', async (name) => {
    const h = await setup({ omitExtension: `vocs-code-${name}.ts` });
    await expect(h.adapter.send({ text: 'must not execute' })).rejects.toThrow();
    expect(h.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
    expect(run.events.filter((event) => event.type === 'agent_start')).toHaveLength(0);
    expect(await h.adapter.missionReadiness()).toMatchObject({ ready: false, tools: [] });
  });

  it('refuses an unavailable actual model rather than counting a configured preset or fallback as proof', async () => {
    const h = await setup(); h.meta.config.model = { provider: 'vocs-offline', model: 'not-an-installed-model' };
    await expect(h.adapter.send({ text: 'must not execute' })).rejects.toThrow();
    expect(run.events.filter((event) => event.type === 'agent_start')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
  });

  it('refuses the selected connection without auth even though a different provider is available', async () => {
    const h = await setup();
    await fs.writeFile(path.join(h.agentDir, 'models.json'), JSON.stringify({ providers: { 'mission-no-auth': {
      baseUrl: 'http://127.0.0.1:1/never-used', api: 'openai-completions', models: [{ id: 'unavailable' }],
    } } }));
    h.meta.config.model = { provider: 'mission-no-auth', model: 'unavailable' };
    await expect(h.adapter.send({ text: 'must not execute' })).rejects.toThrow(/connection|model/i);
    expect(run.events.filter((event) => event.type === 'agent_start')).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
    expect(await h.adapter.missionReadiness()).toMatchObject({ ready: false, tools: [] });
  });

  it('fails startup, without an idle status or prompt, when the required Mission connection fails', async () => {
    const h = await setup(); await h.broker.close();
    await expect(h.adapter.send({ text: 'must not execute' })).rejects.toThrow('pi exited (1)');
    expect(h.logs.join('\n')).toContain('Required Mission MCP handshake failed');
    expect(h.events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
    expect(run.events.filter((event) => event.type === 'agent_start')).toHaveLength(0);
    expect(h.logs.join('\n')).not.toContain(h.server.def.headers!.Authorization);
  });
});
