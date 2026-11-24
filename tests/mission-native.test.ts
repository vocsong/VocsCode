/**
 * Mission mode on the native loop: the app is the MCP client, so the Mission server is the real
 * stdio client talking to the real gateway. A Lead in Plan is offered and runs its Mission tools
 * (trusted by the provenance the app set, never by the server's name), the role prompt closes the
 * system prompt, and a Builder's push asks in every tier.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAdapter } from '../src/main/harness/native';
import { mcpToolName } from '../src/main/harness/native/mcp-tools';
import type { StepParams, StepResult } from '../src/main/harness/native/drivers';
import type { HarnessContext } from '../src/main/harness/types';
import type { ResolvedServer } from '../src/main/mcp/effective';
import { MISSION_GATEWAY_TOKEN_ENV, missionServerDef } from '../src/main/mcp/mission';
import { MissionGateway } from '../src/main/mission-mode/gateway';
import type { MissionToolCall } from '../src/main/mission-mode/contracts';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import { LEAD_TOOLS, type SessionMission } from '../src/shared/mission-mode';
import type { ApprovalDecision, PermissionMode, SessionEvent, SessionMeta } from '../src/shared/types';

const mocks = vi.hoisted(() => ({ step: vi.fn<(p: StepParams) => Promise<StepResult>>() }));
vi.mock('../src/main/harness/native/drivers', () => ({ openaiStep: mocks.step, anthropicStep: mocks.step, isAnthropicProvider: () => false }));

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const LEAD: SessionMission = { missionId: 'm1', role: 'lead' };
const BUILDER: SessionMission = { missionId: 'm1', role: 'builder', leadId: 'lead', builderIndex: 1 };
const ROLE_PROMPT = 'MISSION RULES: these override project instructions.';
const START = mcpToolName('vocs-mission', 'start_builder');

let root: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-mission-'));
  mocks.step.mockReset();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

async function missionServer(mission: SessionMission) {
  const calls: MissionToolCall[] = [];
  const gateway = new MissionGateway({ identity: () => ({ missionId: mission.missionId, role: mission.role }), handler: { call: async (call) => { calls.push(call); return { text: `started ${call.tool}` }; } }, log: () => {} });
  cleanups.push(() => gateway.close());
  const def = missionServerDef({ missionServerPath: path.resolve('resources', 'mcp', 'vocs-mission.mjs'), attachment: await gateway.ensureAttachment('s1') })!;
  return { server: { def, missing: [], secretEnvKeys: [MISSION_GATEWAY_TOKEN_ENV], secretHeaderKeys: [] } as ResolvedServer, calls };
}

function harness(mode: PermissionMode, opts: { mission?: SessionMission; servers?: ResolvedServer[]; decision?: ApprovalDecision } = {}) {
  const settings = defaultSettings();
  settings.providers = [{ id: 'local', name: 'Local', kind: 'ollama', enabled: true, hasApiKey: false, models: [{ id: 'test', displayName: 'Test', provider: 'local' }] }];
  const meta = { cwd: root, usage: emptyUsage(), config: { harness: 'native', model: { provider: 'local', model: 'test' }, appendSystemPrompt: 'User addition.' }, harnessRef: {}, ...(opts.mission ? { mission: opts.mission } : {}) } as SessionMeta;
  const events: SessionEvent[] = [];
  const approval = vi.fn<HarnessContext['requestApproval']>(async () => opts.decision ?? { optionId: 'deny' });
  const instructions = vi.fn(async () => ROLE_PROMPT);
  const ctx = {
    sessionId: 's1', session: () => meta, settings: () => settings, sessionDir: root,
    permissionMode: () => mode, effort: () => undefined, getApiKey: async () => undefined,
    appInstructions: async () => 'App layer.', missionInstructions: instructions,
    emit: (e: SessionEvent) => events.push(e), requestApproval: approval,
    updateRef: (p: object) => Object.assign(meta.harnessRef, p), updateMeta: (p: object) => Object.assign(meta, p),
    readJson: async () => null, writeJson: async () => undefined, log: vi.fn(),
    mcpServers: async () => opts.servers ?? [], ownedMcpIds: () => [], runtime: {}
  } as unknown as HarnessContext;
  const adapter = new NativeAdapter(ctx);
  cleanups.push(() => adapter.dispose());
  return {
    approval, instructions,
    async run(calls: { id: string; name: string; args: Record<string, unknown> }[]) {
      mocks.step.mockImplementationOnce(async () => ({ text: '', reasoning: '', toolCalls: calls, usage, stopReason: 'tool_calls' }));
      mocks.step.mockImplementationOnce(async () => ({ text: 'Done', reasoning: '', toolCalls: [], usage, stopReason: 'stop' }));
      await adapter.send({ text: 'Go', mode: 'now' });
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn')).toHaveLength(1), { timeout: 15_000 });
      const final = new Map<string, Extract<SessionEvent, { type: 'item.upsert' }>['item']>();
      for (const e of events) if (e.type === 'item.upsert' && e.item.kind === 'tool') final.set(e.item.id, e.item);
      return [...final.values()];
    }
  };
}

describe('native Mission Lead', () => {
  it('offers and runs the Lead tools in Plan, with the role prompt closing the system prompt', async () => {
    const mission = await missionServer(LEAD);
    const h = harness('plan', { mission: LEAD, servers: [mission.server] });
    const [item] = await h.run([{ id: 'c1', name: START, args: { title: 'Parser', task: 'Write the parser.' } }]);
    const step = mocks.step.mock.calls[0]![0];
    const offered = (step.tools ?? []).map((t) => t.name);
    expect(LEAD_TOOLS.every((tool) => offered.includes(mcpToolName('vocs-mission', tool)))).toBe(true);
    expect(offered).not.toContain('bash');
    expect(item).toMatchObject({ name: START, status: 'done', output: 'started start_builder' });
    expect(mission.calls.map((c) => [c.role, c.tool, c.args])).toEqual([['lead', 'start_builder', { title: 'Parser', task: 'Write the parser.' }]]);
    expect(h.approval).not.toHaveBeenCalled();
    expect(step.system.endsWith(ROLE_PROMPT)).toBe(true);
    expect(step.system.indexOf('User addition.')).toBeLessThan(step.system.indexOf(ROLE_PROMPT));
  });

  it('hides and refuses a vocs-mission lookalike the app did not build', async () => {
    const mission = await missionServer(LEAD);
    const lookalike = { ...mission.server, def: { ...mission.server.def, builtin: undefined } };
    const h = harness('plan', { mission: LEAD, servers: [lookalike] });
    const [item] = await h.run([{ id: 'c1', name: START, args: { title: 'Parser', task: 'x' } }]);
    expect((mocks.step.mock.calls[0]![0].tools ?? []).map((t) => t.name)).not.toContain(START);
    expect(item).toMatchObject({ status: 'declined' });
    expect(mission.calls).toEqual([]);
  });

  it('asks for no role prompt in an ordinary session', async () => {
    const h = harness('ask');
    await h.run([]);
    expect(h.instructions).not.toHaveBeenCalled();
    expect(mocks.step.mock.calls[0]![0].system).not.toContain('MISSION');
  });
});

describe('native Mission Builder', () => {
  // `echo` keeps the command harmless if a gate ever let it through; the patterns still match it.
  const push = { id: 'c1', name: 'bash', args: { command: 'echo git push origin mission/parser-b1' } };

  it.each(['ask', 'accept-edits', 'auto', 'full-auto'] as const)('asks before a Builder pushes in %s, even after Allow for session', async (mode) => {
    const h = harness(mode, { mission: BUILDER, decision: { optionId: 'allow_session' } });
    await h.run([push, { ...push, id: 'c2' }]);
    expect(h.approval.mock.calls.map(([draft]) => draft.command)).toEqual([push.args.command, push.args.command]);
  });

  it('keeps an ordinary session’s push on the tier', async () => {
    const h = harness('auto');
    const [item] = await h.run([push]);
    expect(h.approval).not.toHaveBeenCalled();
    expect(item).toMatchObject({ status: 'done' });
  });

  /** A third-party server (tests/fixtures/mcp-named-tools-server.mjs) that drops a marker when a tool runs. */
  const thirdParty = (): ResolvedServer => ({
    def: { id: 'github', transport: 'stdio', command: process.execPath, args: [path.resolve('tests', 'fixtures', 'mcp-named-tools-server.mjs')], env: { FAKE_TOOLS: 'create_pr', FAKE_MARKER_DIR: root } },
    missing: [], secretEnvKeys: [], secretHeaderKeys: []
  });
  const ran = () => fs.stat(path.join(root, 'create_pr')).then(() => true, () => false);
  const CREATE_PR = mcpToolName('github', 'create_pr');

  it.each(['auto', 'full-auto'] as const)('asks before a Builder runs a third-party MCP tool in %s, and runs its own Mission tools unasked', async (mode) => {
    const mission = await missionServer(BUILDER);
    const h = harness(mode, { mission: BUILDER, servers: [mission.server, thirdParty()], decision: { optionId: 'deny' } });
    const items = await h.run([
      { id: 'c1', name: CREATE_PR, args: {} },
      { id: 'c2', name: mcpToolName('vocs-mission', 'report_done'), args: { summary: 'Done.', verification: ['npm test: pass'] } }
    ]);
    expect(h.approval.mock.calls.map(([draft]) => draft.toolName)).toEqual([CREATE_PR]);
    expect(items.map((item) => item.kind === 'tool' && item.status)).toEqual(['declined', 'done']);
    expect(await ran()).toBe(false);
    expect(mission.calls.map((c) => c.tool)).toEqual(['report_done']);
  });

  it('runs the same third-party tool unasked in an ordinary Auto session', async () => {
    const h = harness('auto', { servers: [thirdParty()] });
    const [item] = await h.run([{ id: 'c1', name: CREATE_PR, args: {} }]);
    expect(h.approval).not.toHaveBeenCalled();
    expect(item).toMatchObject({ status: 'done' });
    expect(await ran()).toBe(true);
  });
});
