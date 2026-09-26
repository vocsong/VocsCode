/** Real MCP -> coordinator -> approval -> owned checks. Only model turns are scripted. */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MissionRuntime } from '../src/main/mission/runtime';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { TerminalManager } from '../src/main/terminal';
import type { MissionRecord } from '../src/shared/mission';
import type { UserInput } from '../src/shared/types';
import { missionFixture } from './support/mission-fixture';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
let root: string, project: string, marker: string, diagnostic: string;
let runtime: MissionRuntime, sessions: SessionManager, contexts: HarnessContext[], clients: Client[];
let settings: ReturnType<typeof defaultSettings>, sent: ReturnType<typeof vi.fn<(input: UserInput) => void>>, approvals: string[], sequence: number;
const wait = (check: () => void) => vi.waitFor(check, { timeout: 30_000, interval: 30 });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-progress-')); project = path.join(root, 'project'); await fs.mkdir(project);
  marker = path.join(root, 'spawns.txt'); diagnostic = path.join(root, 'diagnostic.txt');
  await fs.writeFile(diagnostic, 'actual assertion failure');
  await fs.writeFile(path.join(project, 'case.cjs'), `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'spawn\\n'); require('node:test').test('real failure',()=>{throw new Error(fs.readFileSync(${JSON.stringify(diagnostic)},'utf8'));});\n`);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Mission Progress Test'); git('config', 'user.email', 'mission-progress@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  git('add', '.'); git('commit', '-m', 'Fixture baseline');
  const userData = path.join(root, 'data'), store = new SessionStore(userData); await store.load();
  settings = defaultSettings(); settings.providers = []; settings.mcpDisabledBuiltins = ['gitnexus', 'vocs-memory', 'cua-driver']; settings.mission = missionFixture().config;
  settings.mission.limits.maxTaskAttemptsBeforeLeadDiagnosis = 3;
  settings.mission.limits.progressCheckpointEveryTurns = 20;
  settings.mission.limits.maxNoProgressCheckpoints = 3;
  contexts = []; clients = []; approvals = []; sent = vi.fn(); sequence = 0;
  vi.mocked(createAdapter).mockImplementation((id, ctx): HarnessAdapter => {
    contexts.push(ctx);
    return { id, busy: false, start: async () => {
      const server = (await ctx.mcpServers()).find((entry) => entry.def.id === 'vocs-mission')!;
      const client = new Client({ name: 'mission-progress', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(server.def.url!), { requestInit: { headers: server.def.headers } }));
      ctx.emit({ type: 'status', status: 'idle' });
    }, missionReadiness: async () => ({ ready: true, tools: ['read'], model: { provider: 'fixture', model: 'frontier' }, modelAvailable: true, connectionAvailable: true }),
    listModels: async () => [{ id: 'frontier', provider: 'fixture', displayName: 'Fixture' }],
    send: async (input) => { sent(input); ctx.emit({ type: 'status', status: 'running' }); }, interrupt: async () => undefined, dispose: async () => undefined,
    setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined };
  });
  sessions = new SessionManager({ store, settings: { get: () => settings } as SettingsStore, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(), withWorkspaceDispatch: (meta, dispatch) => runtime.admission.dispatch(meta.cwd, dispatch) });
  sessions.subscribe((env) => { if (env.event.type === 'approval.request') approvals.push(env.event.request.id); });
  runtime = new MissionRuntime({ userData, sessions, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), settings: { get: () => settings, onChange: () => () => undefined },
    terminals: { activity: () => [], closeManagedSession: async () => undefined, reconcileOwnership: async () => undefined } as unknown as TerminalManager, changed: vi.fn(), log: vi.fn() });
  await runtime.load();
});
afterEach(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function tool(id: string, name: string, payload: Record<string, unknown>) {
  const idempotencyKey = `fresh-${++sequence}`;
  for (let retry = 0; ; retry++) {
    try { return await clients.at(-1)!.callTool({ name, arguments: { payload, idempotencyKey, expectedRevision: runtime.service.get(id)!.revision } }); }
    catch (error) { if (retry >= 5 || !/MISSION_REVISION_CONFLICT/.test(String(error))) throw error; }
  }
}
async function start(permissionMode: 'ask' | 'full-auto' = 'full-auto') {
  const mission = await runtime.service.create({ idempotencyKey: 'launch', projectRoot: project, objective: 'Verify a genuinely failing check', mode: 'autonomous', permissionMode });
  await wait(() => expect(sent).toHaveBeenCalledTimes(1));
  const current = runtime.service.get(mission.id)!;
  await tool(mission.id, 'mission_plan_update', { expectedPlanRevision: current.planRevision, plan: { ...current.plan, criteria: [{ id: 'actual', description: 'Run the actual assertion', required: true, evidenceKinds: ['test'] }] },
    checks: [{ id: 'actual', name: 'Actual test', kind: 'test', command: 'node --test --test-reporter=tap case.cjs', criterionIds: ['actual'], required: true, heavy: true, timeoutMs: 10_000, testReport: { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 } }] });
  await tool(mission.id, 'mission_phase_set', { phase: 'executing' });
  return runtime.service.get(mission.id)!;
}
async function requestAndYield(id: string) {
  await tool(id, 'mission_verification_request', { checkId: 'actual' });
  await tool(id, 'mission_yield', { events: ['verification'] });
  const ctx = contexts.at(-1)!;
  ctx.emit({ type: 'item.upsert', item: { id: `turn-${++sequence}`, kind: 'turn', ts: Date.now(), status: 'completed' } }); ctx.emit({ type: 'status', status: 'idle' });
}
async function spawns() { return (await fs.readFile(marker, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return ''; })).split('\n').filter(Boolean).length; }
function checks(record: MissionRecord) { return record.operations.filter((operation) => operation.kind === 'verify' && operation.payload.executionKind === 'process'); }

it('bounds fresh-key retries of the same genuinely executed failure, retains all evidence, and requires a recorded diagnosis after Resume', async () => {
  const mission = await start(), limit = mission.config.limits.maxTaskAttemptsBeforeLeadDiagnosis;
  let firstProgress = 0;
  for (let attempt = 1; attempt <= limit; attempt++) {
    await requestAndYield(mission.id);
    await wait(() => expect(runtime.service.get(mission.id)!.evidence).toHaveLength(attempt));
    if (attempt === 1) { firstProgress = runtime.service.get(mission.id)!.progress.lastProgressRevision; expect(firstProgress).toBeGreaterThan(mission.progress.lastProgressRevision); }
    else expect(runtime.service.get(mission.id)!.progress.lastProgressRevision).toBe(firstProgress);
    if (attempt < limit) await wait(() => expect(sent).toHaveBeenCalledTimes(attempt + 1));
  }
  await wait(() => expect(runtime.service.get(mission.id)!.status).toBe('paused'));
  for (let attempt = 0; attempt < limit + 1; attempt++) await expect(tool(mission.id, 'mission_verification_request', { checkId: 'actual' })).rejects.toThrow(/authorized|Unauthorized|403|401/);
  const paused = runtime.service.get(mission.id)!;
  expect(paused.evidence).toHaveLength(limit); expect(checks(paused)).toHaveLength(limit);
  expect(checks(paused).map((check) => check.state)).toEqual(Array(limit).fill('failed'));
  expect(paused.evidence.every((evidence) => evidence.result === 'failed' && evidence.executedTests === 1 && evidence.skippedTests === 0 && evidence.exitCode !== 0)).toBe(true);
  expect(new Set(paused.evidence.map((evidence) => evidence.outcomeHash)).size).toBe(1);
  expect(await spawns()).toBe(limit); expect(approvals).toEqual([]); expect(sent).toHaveBeenCalledTimes(limit);
  expect(runtime.verification.active()).toEqual([]); expect(runtime.scheduler.snapshot().active).toEqual([]);
  const retained = structuredClone(paused.evidence);
  await runtime.store.load(mission.id); expect(runtime.service.get(mission.id)!.evidence).toEqual(retained);
  for (const evidence of retained) expect((await Promise.all(evidence.artifactIds.map((ref) => runtime.store.readArtifact(mission.id, ref)))).map((bytes) => bytes.toString()).join('\n')).toContain('actual assertion failure');
  await runtime.service.control({ missionId: mission.id, expectedRevision: runtime.service.get(mission.id)!.revision, idempotencyKey: 'resume', control: { action: 'resume' } });
  await wait(() => expect(sent).toHaveBeenCalledTimes(limit + 1));
  await expect(tool(mission.id, 'mission_verification_request', { checkId: 'actual' })).rejects.toThrow(/same unsuccessful outcome|diagnos/);
  expect(await spawns()).toBe(limit); expect(checks(runtime.service.get(mission.id)!)).toHaveLength(limit);
  const evidenceIds = [retained.at(-1)!.id];
  await tool(mission.id, 'mission_decision_request', { decision: { id: 'diagnosis', question: 'Diagnose the repeated assertion before retrying', evidenceIds, affectedTaskIds: [] } });
  await tool(mission.id, 'mission_decision_resolve', { decisionId: 'diagnosis', resolution: 'Inspect the changed external diagnostic input before a bounded recheck', rationale: 'The retained assertion identifies the external fixture dependency', evidenceIds, affectedTaskIds: [] });
  await requestAndYield(mission.id);
  await wait(() => expect(runtime.service.get(mission.id)!.evidence).toHaveLength(limit + 1));
  await wait(() => expect(sent).toHaveBeenCalledTimes(limit + 2));
  expect(await spawns()).toBe(limit + 1); expect(runtime.service.get(mission.id)!.status).toBe('running');
  expect(runtime.service.get(mission.id)!.evidence.slice(0, limit)).toEqual(retained);
}, 90_000);

it('counts a changed actual failure output as a new finding, but refuses duplicate pending requests before they can spawn', async () => {
  const mission = await start();
  await tool(mission.id, 'mission_verification_request', { checkId: 'actual' });
  for (let attempt = 0; attempt < mission.config.limits.maxTaskAttemptsBeforeLeadDiagnosis + 1; attempt++) await expect(tool(mission.id, 'mission_verification_request', { checkId: 'actual' })).rejects.toThrow(/pending|in.flight/);
  await tool(mission.id, 'mission_yield', { events: ['verification'] });
  contexts.at(-1)!.emit({ type: 'item.upsert', item: { id: 'first', kind: 'turn', ts: Date.now(), status: 'completed' } }); contexts.at(-1)!.emit({ type: 'status', status: 'idle' });
  await wait(() => expect(sent).toHaveBeenCalledTimes(2));
  const first = runtime.service.get(mission.id)!;
  await fs.writeFile(diagnostic, 'a genuinely different assertion finding');
  await requestAndYield(mission.id); await wait(() => expect(sent).toHaveBeenCalledTimes(3));
  const second = runtime.service.get(mission.id)!;
  expect(second.evidence).toHaveLength(2); expect(checks(second)).toHaveLength(2); expect(await spawns()).toBe(2);
  expect(second.evidence.map((evidence) => evidence.result)).toEqual(['failed', 'failed']);
  expect(second.evidence[1].sourceRevision).toEqual(first.evidence[0].sourceRevision);
  expect(second.evidence[1].outcomeHash).not.toBe(first.evidence[0].outcomeHash);
  expect(second.progress.lastProgressRevision).toBeGreaterThan(first.progress.lastProgressRevision);
  expect(second.status).toBe('running');
}, 60_000);

it('pauses on one actual user denial without implementation attribution, false progress, check spawns or repeated approval cards', async () => {
  const mission = await start('ask');
  await requestAndYield(mission.id); await wait(() => expect(approvals).toHaveLength(1));
  await sessions.respondApproval(mission.leadSessionId, approvals[0], { optionId: 'deny' });
  await wait(() => expect(runtime.service.get(mission.id)!.status).toBe('paused'));
  for (let attempt = 0; attempt <= mission.config.limits.maxTaskAttemptsBeforeLeadDiagnosis; attempt++) await expect(tool(mission.id, 'mission_verification_request', { checkId: 'actual' })).rejects.toThrow(/authorized|Unauthorized|403|401/);
  const paused = runtime.service.get(mission.id)!;
  expect(paused.evidence).toEqual([expect.objectContaining({ result: 'blocked', failure: { kind: 'permission', code: 'approval_denied', source: 'approval', confidence: 'observed', recovery: 'user_action', message: 'Mission operation was not approved by the user.' } })]);
  expect(paused.progress.lastProgressRevision).toBe(mission.progress.lastProgressRevision);
  expect(checks(paused)).toHaveLength(1); expect(checks(paused)[0].state).toBe('failed'); expect(await spawns()).toBe(0);
  expect(approvals).toHaveLength(1); expect(sent).toHaveBeenCalledTimes(1);
  expect(runtime.verification.active()).toEqual([]); expect(runtime.scheduler.snapshot().active).toEqual([]);
  await runtime.store.load(mission.id); expect(runtime.service.get(mission.id)!.evidence).toEqual(paused.evidence);
}, 60_000);
