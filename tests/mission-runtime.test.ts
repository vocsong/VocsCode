/** Production Mission composition with a scripted harness boundary, never live-provider certification. */
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRuntime } from '../src/main/mission/runtime';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext, MissionReadiness } from '../src/main/harness/types';
import type { TerminalManager } from '../src/main/terminal';
import type { MissionRecord, MissionView } from '../src/shared/mission';
import { createManagedPiOwnershipIntent, recordUnlaunchedManagedPiIntent, type ManagedPiOwnershipIntent } from '../src/main/harness/pi-ownership';
import type { UserInput } from '../src/shared/types';
import { missionFixture } from './support/mission-fixture';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
let root: string, project: string, sessions: SessionManager, runtime: MissionRuntime;
let settings: ReturnType<typeof defaultSettings>;
let settingsChanged: () => void;
let readiness: MissionReadiness;
let contexts: HarnessContext[], clients: Client[];
let sent: ReturnType<typeof vi.fn<(input: UserInput) => void>>, changes: ReturnType<typeof vi.fn<(view: MissionView) => void>>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-runtime-')); project = path.join(root, 'project'); await fs.mkdir(project);
  const userData = path.join(root, 'data');
  const store = new SessionStore(userData); await store.load();
  settings = defaultSettings(); settings.mcpDisabledBuiltins = ['gitnexus', 'vocs-memory', 'cua-driver']; settings.providers = [];
  settings.mission = missionFixture().config;
  contexts = []; clients = []; sent = vi.fn(); changes = vi.fn();
  readiness = { ready: true, tools: ['read'], model: { provider: 'fixture', model: 'frontier' }, modelAvailable: true, connectionAvailable: true };
  vi.mocked(createAdapter).mockImplementation((_id, ctx): HarnessAdapter => {
    contexts.push(ctx);
    let fixtureIntent: ManagedPiOwnershipIntent | undefined;
    return { id: _id, busy: false,
      start: async () => {
        // This scripted harness never launches an OS process. Bind a truthful not-started
        // receipt for recovery composition, distinct from the actual host check Job below.
        if (_id === 'pi') fixtureIntent = await createManagedPiOwnershipIntent(ctx.sessionDir, { sessionId: ctx.sessionId, missionId: ctx.session().mission!.missionId, generation: ctx.session().mission!.generation });
        const server = (await ctx.mcpServers()).find((s) => s.def.id === 'vocs-mission')!;
        const client = new Client({ name: 'mission-runtime-fixture', version: '1' }); clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(server.def.url!), { requestInit: { headers: server.def.headers } }));
        expect((await client.listTools()).tools.some((t) => t.name === 'mission_read')).toBe(true);
        ctx.emit({ type: 'status', status: 'idle' });
      },
      missionReadiness: async () => structuredClone(readiness),
      listModels: async () => [{ id: 'frontier', provider: 'fixture', displayName: 'Fixture frontier' }],
      send: async (input) => { sent(input); ctx.emit({ type: 'status', status: 'running' }); },
      interrupt: async () => undefined, dispose: async () => { if (fixtureIntent) { await recordUnlaunchedManagedPiIntent(fixtureIntent); fixtureIntent = undefined; } },
      setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined,
    };
  });
  sessions = new SessionManager({ store, settings: { get: () => settings } as SettingsStore, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
    withWorkspaceDispatch: (meta, dispatch) => runtime.admission.dispatch(meta.cwd, dispatch),
  });
  runtime = new MissionRuntime({ userData, sessions, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), settings: { get: () => settings, onChange: (listener) => { settingsChanged = () => listener(settings); return () => undefined; } }, terminals: { activity: () => [], closeManagedSession: async () => undefined, reconcileOwnership: async () => undefined } as unknown as TerminalManager, changed: changes, log: vi.fn() });
  await runtime.load();
});
afterEach(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const start = () => runtime.service.create({ idempotencyKey: 'runtime-test', projectRoot: project, objective: 'Investigate without changing code', mode: 'interactive_plan', permissionMode: 'auto' });
const wait = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 20 });

async function gitProject() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Mission Runtime Test'); git('config', 'user.email', 'mission-runtime@example.invalid'); git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(project, 'probe.cjs'), "require('node:fs').writeFileSync(process.argv[2], 'This must not run without authorization.');\n");
  git('add', '.'); git('commit', '-m', 'Fixture baseline');
}
let toolRequestNumber = 0;
async function modelTool(missionId: string, name: string, payload: Record<string, unknown>) {
  const idempotencyKey = `${name}-runtime-${++toolRequestNumber}`;
  for (let n = 0; ; n++) {
    try { return await clients.at(-1)!.callTool({ name, arguments: { expectedRevision: runtime.service.get(missionId)!.revision, idempotencyKey, payload } }); }
    catch (e) { if (n === 4 || !/revision/i.test(String(e))) throw e; }
  }
}

describe('Production Mission runtime boundary', () => {
  it('wakes queued Mission work only after automatic compaction actually settles', async () => {
    const mission = await start(); await wait(() => expect(sent).toHaveBeenCalledTimes(1));
    settings.autoCompactionThreshold = '100k';
    let finish!: (result: boolean) => void;
    const operation = new Promise<boolean>((resolve) => { finish = resolve; });
    const adapter = vi.mocked(createAdapter).mock.results[0].value as HarnessAdapter;
    adapter.compact = vi.fn(() => operation);
    await runtime.service.sendUser(mission.leadSessionId, { text: 'Continue with the queued investigation after compaction' }, 'compaction-message');
    await modelTool(mission.id, 'mission_yield', { events: ['user'] });
    const ctx = contexts[0];
    ctx.emit({ type: 'usage', totals: { ...sessions.get(mission.leadSessionId)!.usage, contextTokens: 100_001 } });
    ctx.emit({ type: 'item.upsert', item: { id: 'compacting-turn', kind: 'turn', ts: Date.now(), status: 'completed' } });
    ctx.emit({ type: 'status', status: 'idle' });
    await wait(() => expect(adapter.compact).toHaveBeenCalledTimes(1));
    ctx.emit({ type: 'item.upsert', item: { id: 'compaction-end-info', kind: 'info', ts: Date.now(), level: 'info', text: 'Context compaction completed.' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessions.activity(mission.leadSessionId)).toMatchObject({ compacting: true, quiescent: false });
    expect(sent).toHaveBeenCalledTimes(1);
    finish(true); // No further adapter event or user input follows the RPC resolution.
    await wait(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(runtime.service.get(mission.id)!.progress.completedTurns).toBe(1);
    expect(sent.mock.calls[1][0].text).toContain('queued investigation');
  });
  it('allows model mutations after durable usage-only updates without bypassing real stale-revision conflicts', async () => {
    settings.mission!.limits.maxTokens = 100_000;
    settings.mission!.limits.maxBudgetUsd = 10;
    const mission = await start(); await wait(() => expect(sent).toHaveBeenCalledTimes(1));
    const client = clients[0];
    for (let index = 1; index <= 3; index++) {
      const read = await client.callTool({ name: 'mission_read', arguments: { payload: {} } });
      const observed = (read.structuredContent as { result: MissionRecord }).result;
      contexts[0].emit({ type: 'usage', totals: { ...sessions.get(mission.leadSessionId)!.usage, inputTokens: index * 100, costUsd: index / 100 } });
      await wait(() => expect(runtime.service.get(mission.id)!.lastEventSequence).toBeGreaterThan(observed.lastEventSequence));
      // Real providers publish the just-completed response's usage before its tool call.
      // There is deliberately no fresh read, retry, revision substitution or fake tool host.
      const request = { expectedRevision: observed.revision, idempotencyKey: `usage-profile-${index}`, payload: { profile: { id: `scout-${index}`, revision: 1, name: `Scout ${index}`, purpose: 'Investigate safely', instructions: 'Read and report facts', tierId: 5, contextRefs: [], requestedTools: ['read'], sourceAccess: 'read_only', resultExpectations: 'Evidence-backed findings' } } };
      expect((await client.callTool({ name: 'mission_profile_upsert', arguments: request })).isError).toBe(false);
      expect((await client.callTool({ name: 'mission_profile_upsert', arguments: request })).isError).toBe(false);
      await expect(client.callTool({ name: 'mission_profile_upsert', arguments: { ...request, idempotencyKey: `actually-stale-${index}` } })).rejects.toThrow(/MISSION_REVISION_CONFLICT/);
    }
    expect(runtime.service.get(mission.id)!.profiles).toHaveLength(3);
    const saved = runtime.service.get(mission.id)!;
    await runtime.store.load(mission.id);
    expect(runtime.service.get(mission.id)).toEqual(saved);
    expect(saved.operations.find((operation) => operation.payload.budgetUsage)?.payload.budgetUsage).toEqual({ tokens: 300, costUsd: 0.03 });
    expect(saved.lastEventSequence).toBe(saved.revision + 3);
  });
  it('refreshes an initially divergent approved target through real MCP, captured checks and the immutable source boundary', async () => {
    await gitProject();
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    await fs.mkdir(path.join(project, '.vocs-code'));
    await fs.writeFile(path.join(project, '.vocs-code', 'mission-delivery.json'), JSON.stringify({ version: 1, endpoint: 'open_pr', remote: 'origin', targetBranch: 'main', allowPush: true, allowMerge: false, checks: [] }));
    await fs.writeFile(path.join(project, 'target.test.cjs'), "const {test}=require('node:test');test('approved target really present',()=>require('node:assert').equal(require('node:fs').readFileSync('upstream.txt','utf8'),'remote-change'));\n");
    git(project, 'add', '.'); git(project, 'commit', '-m', 'Mission delivery fixture');
    const sourceHead = git(project, 'rev-parse', 'HEAD'), sourceIndex = await fs.readFile(path.join(project, '.git', 'index'));
    const remote = path.join(root, 'remote.git'), upstream = path.join(root, 'upstream');
    git(root, 'init', '--bare', '--initial-branch=main', remote); git(project, 'remote', 'add', 'origin', remote); git(project, 'push', 'origin', 'main');
    git(root, 'clone', remote, upstream); git(upstream, 'config', 'user.name', 'Mission Runtime Test'); git(upstream, 'config', 'user.email', 'mission-runtime@example.invalid'); git(upstream, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(upstream, 'upstream.txt'), 'remote-change'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Divergent target'); git(upstream, 'push', 'origin', 'main');
    const targetHead = git(upstream, 'rev-parse', 'HEAD');
    const mission = await runtime.service.create({ idempotencyKey: 'target-check', projectRoot: project, objective: 'Refresh only the approved target', mode: 'autonomous', permissionMode: 'full-auto' });
    await wait(() => expect(sent).toHaveBeenCalledTimes(1));
    const current = runtime.service.get(mission.id)!;
    const check = { id: 'target-check', name: 'Target content check', kind: 'test', command: 'node --test target.test.cjs', criterionIds: ['target'], required: true, heavy: true, timeoutMs: 10_000, testReport: { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 } };
    await modelTool(mission.id, 'mission_plan_update', { expectedPlanRevision: current.planRevision, plan: { ...current.plan, criteria: [{ id: 'target', description: 'The exact remote content is integrated', required: true, evidenceKinds: ['test'] }] }, checks: [check] });
    await modelTool(mission.id, 'mission_phase_set', { phase: 'executing' });
    await expect(modelTool(mission.id, 'mission_integration_request', { target: 'approved', expectedContentHash: current.acceptedRevision!.contentHash, remote: 'unapproved' })).rejects.toThrow();
    await modelTool(mission.id, 'mission_integration_request', { target: 'approved', expectedContentHash: current.acceptedRevision!.contentHash });
    await modelTool(mission.id, 'mission_yield', { events: ['integration'] });
    contexts[0].emit({ type: 'item.upsert', item: { id: 'planning-turn', kind: 'turn', ts: Date.now(), status: 'completed' } }); contexts[0].emit({ type: 'status', status: 'idle' });
    await vi.waitFor(() => {
      const record = runtime.service.get(mission.id)!;
      expect(record.operations.find((op) => op.kind === 'integrate'), JSON.stringify(record.operations)).toMatchObject({ state: 'succeeded' });
    }, { timeout: 60_000 });
    const refreshed = runtime.service.get(mission.id)!;
    expect(refreshed.baseline).toEqual(current.baseline); expect(refreshed.acceptedRevision).not.toEqual(current.acceptedRevision);
    expect(refreshed.deliveryPolicy.targetHead).toBe(targetHead);
    expect(refreshed.evidence).toEqual([expect.objectContaining({ result: 'passed', provenance: 'host_executed', executedTests: 1, skippedTests: 0, sourceRevision: refreshed.acceptedRevision })]);
    expect(refreshed.status).not.toBe('completed'); expect(refreshed.delivery).toBeUndefined();
    expect(await runtime.workspaces.acceptedChangedPaths(mission.id)).toEqual(['upstream.txt']);
    await wait(() => expect(sent).toHaveBeenCalledTimes(2));
    await fs.writeFile(path.join(upstream, 'later.txt'), 'later-target-change'); git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Advanced target'); git(upstream, 'push', 'origin', 'main');
    const advancedHead = git(upstream, 'rev-parse', 'HEAD');
    await modelTool(mission.id, 'mission_integration_request', { target: 'approved', expectedContentHash: refreshed.acceptedRevision!.contentHash });
    await modelTool(mission.id, 'mission_yield', { events: ['integration'] });
    contexts.at(-1)!.emit({ type: 'item.upsert', item: { id: 'refresh-turn', kind: 'turn', ts: Date.now(), status: 'completed' } }); contexts.at(-1)!.emit({ type: 'status', status: 'idle' });
    await vi.waitFor(() => expect(runtime.service.get(mission.id)!.operations.filter((op) => op.kind === 'integrate' && op.state === 'succeeded')).toHaveLength(2), { timeout: 60_000 });
    const advanced = runtime.service.get(mission.id)!;
    expect(advanced.deliveryPolicy.targetHead).toBe(advancedHead); expect(advanced.baseline).toEqual(current.baseline);
    expect(advanced.evidence.filter((evidence) => !evidence.invalidatedBy)).toEqual([expect.objectContaining({ result: 'passed', executedTests: 1, sourceRevision: advanced.acceptedRevision })]);
    expect(advanced.status).not.toBe('completed');
    expect(await runtime.workspaces.acceptedChangedPaths(mission.id)).toEqual(['later.txt', 'upstream.txt']);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(sourceHead); expect(await fs.readFile(path.join(project, '.git', 'index'))).toEqual(sourceIndex);
    expect(await fs.stat(path.join(project, 'upstream.txt')).catch(() => null)).toBeNull();
  }, 90_000);

  it.each(['deny', 'allow'] as const)('executes a real host check only after an actual %s approval with a committed owned intent', async (optionId) => {
    await gitProject();
    settings.mission!.presets[0].harnessId = 'pi';
    const mission = await runtime.service.create({ idempotencyKey: 'host-check', projectRoot: project, objective: 'Exercise the host verification boundary', mode: 'autonomous', permissionMode: 'ask' });
    await wait(() => expect(sent, JSON.stringify({ status: runtime.service.get(mission.id)?.status, blockers: runtime.service.get(mission.id)?.blockers, operations: runtime.service.get(mission.id)?.operations })).toHaveBeenCalledTimes(1));
    const marker = path.join(project, 'must-not-exist.txt');
    const check = { id: 'owned-check', name: 'Owned host check', kind: 'build' as const, command: optionId === 'deny' ? `node probe.cjs "${marker}"` : 'node -e "console.log(\'approved-runtime-check\')"', criterionIds: ['check'], required: true, heavy: true, timeoutMs: 10_000 };
    const current = runtime.service.get(mission.id)!;
    await modelTool(mission.id, 'mission_plan_update', { expectedPlanRevision: current.planRevision, plan: { ...current.plan, criteria: [{ id: 'check', description: 'Actually execute the approved host check', required: true, evidenceKinds: ['build'] }] }, checks: [check] });
    await modelTool(mission.id, 'mission_phase_set', { phase: 'executing' });
    let approvalId: string | undefined;
    const unsubscribe = sessions.subscribe((env) => { if (env.sessionId === mission.leadSessionId && env.event.type === 'approval.request') approvalId = env.event.request.id; });
    await modelTool(mission.id, 'mission_verification_request', { checkId: check.id });
    await modelTool(mission.id, 'mission_yield', { events: ['verification'] });
    contexts[0].emit({ type: 'item.upsert', item: { id: 'planning-turn', kind: 'turn', ts: Date.now(), status: 'completed' } });
    contexts[0].emit({ type: 'status', status: 'idle' });
    await wait(() => expect(approvalId).toBeTypeOf('string'));
    expect(runtime.service.get(mission.id)?.evidence).toEqual([]);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    await sessions.respondApproval(mission.leadSessionId, approvalId!, { optionId });
    await vi.waitFor(() => expect(runtime.service.get(mission.id)?.evidence).toHaveLength(1), { timeout: 30_000 });
    unsubscribe();
    const evidence = runtime.service.get(mission.id)!.evidence[0];
    expect(evidence).toMatchObject({ provenance: 'host_executed', checkId: check.id, result: optionId === 'allow' ? 'passed' : 'blocked', sourceRevision: current.acceptedRevision });
    const artifacts = await Promise.all(evidence.artifactIds.map(async (id) => (await runtime.store.readArtifact(mission.id, id)).toString('utf8')));
    expect(artifacts.join('\n')).toContain(optionId === 'allow' ? 'approved-runtime-check' : 'not approved by the user');
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    expect(runtime.verification.active()).toEqual([]);
    const checks = runtime.service.get(mission.id)!.operations.filter((operation) => operation.kind === 'verify');
    expect(checks).toHaveLength(2);
    expect(checks.filter((operation) => operation.payload.executionKind === 'coordination')).toHaveLength(1);
    expect(checks.filter((operation) => operation.payload.executionKind === 'process')).toHaveLength(1);
    if (optionId === 'deny') await wait(() => expect(runtime.service.get(mission.id)!.status).toBe('paused'));
    else await wait(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(sent).toHaveBeenCalledTimes(optionId === 'allow' ? 2 : 1);
    await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
    const userData = path.join(root, 'data'), store = new SessionStore(userData); await store.load();
    sessions = new SessionManager({ store, settings: { get: () => settings } as SettingsStore, runtime: {} as never,
      analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as never,
      getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(), withWorkspaceDispatch: (meta, dispatch) => runtime.admission.dispatch(meta.cwd, dispatch) });
    runtime = new MissionRuntime({ userData, sessions, settings: { get: () => settings, onChange: () => () => undefined }, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'),
      terminals: { activity: () => [], closeManagedSession: async () => undefined, reconcileOwnership: async () => undefined } as unknown as TerminalManager, changed: changes, log: vi.fn() });
    await runtime.load();
    const restored = runtime.service.get(mission.id)!;
    expect(restored.status, JSON.stringify(restored.blockers)).toBe('paused');
    expect(restored.evidence).toHaveLength(1); expect(restored.operations.filter((operation) => operation.kind === 'verify')).toHaveLength(2);
    expect(restored.blockers.filter((blocker) => !blocker.resolvedAt)).toEqual([]);
    expect(sent).toHaveBeenCalledTimes(optionId === 'allow' ? 2 : 1);
  }, 60_000);

  it('feeds saved account limits through production settings wiring and queues without changing accounts', async () => {
    settings.mission!.limits.accountLimits = { fixture: 1 };
    settingsChanged();
    const first = await start();
    await wait(() => expect(sent).toHaveBeenCalledTimes(1));
    const second = await runtime.service.create({ idempotencyKey: 'second-account-turn', projectRoot: project, objective: 'Another Mission on the same account', mode: 'interactive_plan', permissionMode: 'auto' });
    await wait(() => expect(runtime.scheduler.snapshot().queued).toEqual([expect.objectContaining({ missionId: second.id, kind: 'lead', accountId: 'fixture' })]));
    expect(runtime.scheduler.snapshot().active).toEqual([expect.objectContaining({ missionId: first.id, accountId: 'fixture' })]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sessions.get(second.leadSessionId)?.config.model).toEqual({ provider: 'fixture', model: 'frontier' });
    // Only a real settings notification changes runtime capacity; no test-only scheduler injection.
    settings.mission!.limits.accountLimits = { fixture: 2 };
    settingsChanged();
    await wait(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(runtime.scheduler.snapshot().queued).toEqual([]);
    expect(runtime.scheduler.snapshot().active.map((entry) => entry.accountId)).toEqual(['fixture', 'fixture']);
    expect(sessions.list().filter((entry) => entry.mission).every((entry) => entry.config.model?.model === 'frontier')).toBe(true);
  });

  it('connects the actual authenticated Mission broker before the exact observed model receives a prompt', async () => {
    const mission = await start();
    await wait(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(contexts).toHaveLength(1); expect(clients).toHaveLength(1);
    expect(runtime.service.get(mission.id)).toMatchObject({ status: 'running', phase: 'planning', leadSessionId: contexts[0].sessionId });
    expect(runtime.service.get(mission.id)?.executionAuthorization).toBeUndefined();
    expect(changes).toHaveBeenCalled();
    expect(sessions.get(mission.leadSessionId)?.config.model).toEqual({ provider: 'fixture', model: 'frontier' });
  });
  it.each([
    ['missing handshake', { ready: false, reason: 'Gate not loaded' }],
    ['wrong observed model', { model: { provider: 'fixture', model: 'cheaper' } }],
    ['unobserved model', { model: undefined }],
    ['missing exact credentials', { connectionAvailable: false }],
    ['unavailable model', { modelAvailable: false }],
  ] as Array<[string, Partial<MissionReadiness>]>)('never sends a prompt on %s', async (_name, patch) => {
    readiness = { ...readiness, ...patch };
    const mission = await start();
    await wait(() => expect(runtime.service.get(mission.id)?.status).toBe(patch.connectionAvailable === false ? 'paused' : 'blocked'));
    if (patch.connectionAvailable === false) expect(runtime.service.get(mission.id)!.operations.find((op) => op.payload.failure)?.payload.failure).toMatchObject({ kind: 'provider', code: 'credentials_unavailable', recovery: 'user_action' });
    expect(sent).not.toHaveBeenCalled();
    expect(runtime.service.get(mission.id)?.blockers.some((b) => b.resolvedAt === undefined)).toBe(true);
  });
  it('refuses an explicit effort that the runtime did not report rather than inheriting the app default', async () => {
    settings.defaultEffort = 'high';
    settings.mission!.presets[0].reasoning = { kind: 'explicit', value: 'high' };
    const mission = await start();
    await wait(() => expect(runtime.service.get(mission.id)?.status).toBe('blocked'));
    expect(sent).not.toHaveBeenCalled();
    expect(runtime.service.get(mission.id)?.blockers.map((b) => b.message).join(' ')).toMatch(/reasoning/i);
  });
  it('does not use another account because a separate connection cannot be attested', async () => {
    settings.mission!.presets[0].model.connectionId = 'other-account';
    const mission = await start();
    await wait(() => expect(runtime.service.get(mission.id)?.status).toBe('blocked'));
    expect(sent).not.toHaveBeenCalled();
  });
});
