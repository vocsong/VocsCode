/** Settings -> production Mission runtime -> real SessionManager, with a controlled adapter.
 * The held writer is canceled by the owned adapter, not by a test-side settings predicate. */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { createManagedPiOwnershipIntent, recordUnlaunchedManagedPiIntent, type ManagedPiOwnershipIntent } from '../src/main/harness/pi-ownership';
import { MissionRuntime } from '../src/main/mission/runtime';
import type { MissionTaskContract } from '../src/main/mission/state';
import { SessionManager } from '../src/main/session-manager';
import { SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { TerminalManager } from '../src/main/terminal';
import { deferred } from '../src/main/util/async';
import type { MissionRecord } from '../src/shared/mission';
import { missionFixture } from './support/mission-fixture';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
let root: string, project: string, settings: SettingsStore, sessions: SessionManager, runtime: MissionRuntime;
let actors: ReturnType<typeof actor>[], sequence: number;
const wait = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 20 });

function actor(ctx: HarnessContext) {
  let intent: ManagedPiOwnershipIntent | undefined, work: Promise<void> | undefined, canceled = false;
  const release = deferred<void>(), toolReady = deferred<void>();
  const client = new Client({ name: 'held-mission-writer', version: '1' });
  const modelDispatch = vi.fn();
  const adapter = {
    id: 'pi', busy: false,
    start: vi.fn(async () => {
      const owner = ctx.session().mission!;
      // No OS child exists in this controlled adapter. Recovery still receives an exact
      // unlaunched-owner receipt; this is not live Pi/process-tree certification.
      intent = await createManagedPiOwnershipIntent(ctx.sessionDir, { missionId: owner.missionId, sessionId: ctx.sessionId, generation: owner.generation });
      const server = (await ctx.mcpServers()).find((entry) => entry.def.id === 'vocs-mission')!;
      await client.connect(new StreamableHTTPClientTransport(new URL(server.def.url!), { requestInit: { headers: server.def.headers } }));
      ctx.emit({ type: 'status', status: 'idle' });
    }),
    missionReadiness: async () => ({ ready: true, tools: ['read', 'write'], model: ctx.session().config.model!, modelAvailable: true, connectionAvailable: true }),
    listModels: async () => [{ provider: ctx.session().config.model!.provider, id: ctx.session().config.model!.model, displayName: 'Exact fixture model' }],
    send: vi.fn(async () => {
      modelDispatch(); ctx.emit({ type: 'status', status: 'running' });
      if (ctx.session().mission!.sourceAccess !== 'assigned_workspace') return;
      await fs.writeFile(path.join(ctx.session().cwd, 'partial.txt'), 'retained partial work\n');
      ctx.emit({ type: 'item.upsert', item: { id: 'held-write', kind: 'tool', name: 'write', status: 'running', ts: Date.now() } });
      work = (async () => {
        await release.promise;
        if (!canceled) {
          await fs.writeFile(path.join(ctx.session().cwd, 'after-revocation.txt'), 'continued writer\n');
          modelDispatch();
        }
        ctx.emit({ type: 'item.upsert', item: { id: 'held-write', kind: 'tool', name: 'write', status: 'done', ts: Date.now() } });
      })();
      toolReady.resolve();
    }),
    interrupt: vi.fn(async () => { canceled = true; }),
    dispose: vi.fn(async () => {
      // Cancellation acknowledgment is not teardown. Keep the actor owned until its held
      // tool has actually returned, then publish the positive process-owner receipt.
      canceled = true;
      await work;
      if (intent) { await recordUnlaunchedManagedPiIntent(intent); intent = undefined; }
    }),
    setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined,
  } satisfies HarnessAdapter;
  return { ctx, adapter, client, modelDispatch, release, toolReady, settled: () => work,
    finish: () => {
      ctx.emit({ type: 'item.upsert', item: { id: `turn-${++sequence}`, kind: 'turn', ts: Date.now(), status: 'completed' } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-live-revocation-')); project = path.join(root, 'project');
  await fs.mkdir(project); const userData = path.join(root, 'data');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Mission Revocation Test'); git('config', 'user.email', 'revocation@example.invalid'); git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(project, 'baseline.txt'), 'untouched source\n'); git('add', '.'); git('commit', '-m', 'Fixture baseline');
  settings = new SettingsStore(userData); await settings.load();
  const config = missionFixture().config;
  config.presets[0].harnessId = 'pi'; config.presets[0].model.provider = 'lead-connection';
  config.presets.push({ ...config.presets[0], id: 'worker', model: { provider: 'worker-connection', model: 'specialist' } });
  config.tiers[2].presetIds = ['worker']; config.limits.maxConcurrentAgentTurnsGlobal = 4;
  await settings.update({ folders: [project], mission: config, mcpDisabledBuiltins: ['gitnexus', 'vocs-memory', 'cua-driver'],
    providers: ['lead-connection', 'worker-connection'].map((id) => ({ id, kind: 'openai-compatible', name: id, enabled: true, hasApiKey: true, models: [] })),
  });
  const store = new SessionStore(userData); await store.load(); actors = []; sequence = 0;
  vi.mocked(createAdapter).mockImplementation((_id, ctx) => { const created = actor(ctx); actors.push(created); return created.adapter; });
  sessions = new SessionManager({ store, settings, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
    withWorkspaceDispatch: (meta, dispatch) => runtime.admission.dispatch(meta.cwd, dispatch),
  });
  runtime = new MissionRuntime({ userData, sessions, settings, changed: vi.fn(), log: vi.fn(),
    terminals: { activity: () => [], closeManagedSession: async () => undefined, reconcileOwnership: async () => undefined } as unknown as TerminalManager,
  });
  await runtime.load();
});
afterEach(async () => {
  // Always release gates, including a red regression run or an unsupported-interrupt case.
  for (const item of actors) { item.adapter.interrupt.mockReset().mockImplementation(async () => undefined); item.release.resolve(); }
  await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  for (const item of actors) await item.client.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function currentActor(id: string) { return actors.findLast((item) => item.ctx.sessionId === id)!; }
async function tool(record: MissionRecord, name: string, payload: Record<string, unknown>) {
  const idempotencyKey = `${name}-${++sequence}`;
  for (let retry = 0; ; retry++) {
    try {
      const response = await currentActor(record.leadSessionId).client.callTool({ name, arguments: { expectedRevision: runtime.service.get(record.id)!.revision, idempotencyKey, payload } });
      return (response.structuredContent as { result: { sessionId: string; attemptId: string } }).result;
    } catch (error) { if (retry >= 5 || !/revision/i.test(String(error))) throw error; }
  }
}
async function startWriter(role: 'lead' | 'worker', leadAlsoWrites = false) {
  const record = await runtime.service.create({ idempotencyKey: 'live-revocation', projectRoot: project, objective: 'Implement only in owned workspaces', mode: 'autonomous', permissionMode: 'full-auto' });
  await wait(() => expect(currentActor(record.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  await tool(record, 'mission_profile_upsert', { profile: { id: 'writer', revision: 1, name: 'Writer', purpose: 'Implement the task', instructions: 'Write only in the assigned workspace', tierId: 3, contextRefs: [], requestedTools: ['read', 'write'], sourceAccess: 'assigned_workspace', resultExpectations: 'Report retained changes' } });
  const task: MissionTaskContract = { id: 'implementation', revision: 1, specificationRevision: 1, objective: 'Write the feature', scope: 'partial.txt', ownedPaths: ['partial.txt'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: ['write'], criteria: [], verificationIds: [], assignment: role === 'lead' ? { kind: 'lead' } : { kind: 'worker', profileId: 'writer', profileRevision: 1 }, required: true };
  await tool(record, 'mission_plan_update', { expectedPlanRevision: 0, plan: { ...runtime.service.get(record.id)!.plan, criteria: [{ id: 'outcome', description: 'The bounded change is evidenced', required: true, evidenceKinds: ['behavior'] }] }, tasks: [task, ...(leadAlsoWrites ? [{ ...task, id: 'lead-implementation', assignment: { kind: 'lead' as const } }] : [])] });
  await tool(record, 'mission_phase_set', { phase: 'executing' });
  const attempt = await tool(record, role === 'lead' ? 'mission_task_claim' : 'mission_task_delegate', role === 'lead' ? { taskId: task.id } : { taskId: task.id, presetId: 'worker', reason: 'Explicit configured specialist' });
  if (role === 'lead') currentActor(record.leadSessionId).finish();
  await wait(() => {
    expect(currentActor(attempt.sessionId)?.adapter.send).toHaveBeenCalledTimes(1);
    expect(sessions.activity(attempt.sessionId).tools).toBe(1);
  });
  const writer = currentActor(attempt.sessionId); await writer.toolReady.promise;
  expect(sessions.activity(attempt.sessionId)).toMatchObject({ active: true, turn: true, tools: 1, quiescent: false });
  if (leadAlsoWrites) {
    await tool(record, 'mission_task_claim', { taskId: 'lead-implementation' });
    currentActor(record.leadSessionId).finish();
    await wait(() => expect(sessions.activity(record.leadSessionId).tools).toBe(1));
  }
  return { record, attempt, writer };
}

describe('Active Mission live configuration revocation', () => {
  it.each([
    ['lead', 'preset'], ['worker', 'preset'], ['worker', 'removed preset'], ['worker', 'provider'], ['worker', 'removed provider'], ['worker', 'credentials'], ['worker', 'project provider'], ['worker', 'project account'],
  ] as const)('interrupts a writable %s on %s revocation, retaining partial work and capacity until teardown', async (role, reason) => {
    const { record, attempt, writer } = await startWriter(role);
    const pinned = structuredClone(runtime.service.get(record.id)!.config), pinnedAttempt = structuredClone(runtime.service.get(record.id)!.attempts[0].preset);
    const cwd = writer.ctx.session().cwd, oldActors = actors.length;
    const revoked = vi.spyOn(runtime.service.broker, 'revoke');
    const config = structuredClone(settings.get().mission!);
    if (reason === 'preset' || reason === 'removed preset') {
      const id = role === 'lead' ? 'frontier' : 'worker';
      if (reason === 'preset') config.presets.find((p) => p.id === id)!.enabled = false;
      else { config.presets = config.presets.filter((p) => p.id !== id); for (const tier of config.tiers) tier.presetIds = tier.presetIds.filter((p) => p !== id); }
      if (role === 'lead') delete config.defaultLeadPresetId;
      await settings.update({ mission: config });
    } else if (reason.startsWith('project')) {
      await settings.update({ missionProjects: { [project]: { schemaVersion: 1, revision: 1, ...(reason === 'project provider' ? { allowedProviderIds: ['lead-connection'] } : { allowedConnectionIds: ['lead-connection'] }) } } });
    } else {
      const providers = structuredClone(settings.get().providers);
      if (reason === 'provider') providers.find((p) => p.id === 'worker-connection')!.enabled = false;
      else if (reason === 'credentials') providers.find((p) => p.id === 'worker-connection')!.hasApiKey = false;
      await settings.update({ providers: reason === 'removed provider' ? providers.filter((p) => p.id !== 'worker-connection') : providers });
    }
    // Settings notification synchronously closes admission and bearer capabilities. Neither
    // the callback nor the interrupt acknowledgment is asserted as evidence of quiescence.
    expect(revoked).toHaveBeenCalledWith(record.id);
    await expect(runtime.scheduler.acquire({ missionId: record.id, ownerId: 'after-revocation', kind: 'worker' })).rejects.toThrow(/admission|admitting/i);
    await expect(writer.client.callTool({ name: 'mission_read', arguments: { payload: {} } })).rejects.toThrow(/401|authorized/i);
    await wait(() => expect(writer.adapter.interrupt).toHaveBeenCalledTimes(1));
    await wait(() => expect(writer.adapter.dispose).toHaveBeenCalledTimes(1));
    expect(runtime.service.get(record.id)!.status).toBe('pausing');
    expect(runtime.service.isQuiescent(runtime.service.get(record.id)!)).toBe(false);
    expect(runtime.scheduler.snapshot().active).toContainEqual(expect.objectContaining({ ownerId: expect.any(String), missionId: record.id, accountId: writer.ctx.session().config.model!.provider }));
    expect(sessions.activity(attempt.sessionId)).toMatchObject({ active: true, tearingDown: true, quiescent: false });
    writer.release.resolve(); await writer.settled();
    await wait(() => expect(runtime.service.get(record.id)!.status).toBe('paused'));
    const retained = runtime.service.get(record.id)!;
    expect(retained.attempts).toEqual([expect.objectContaining({ id: attempt.attemptId, status: 'terminal', outcome: 'interrupted', preset: pinnedAttempt })]);
    expect(retained.config).toEqual(pinned); expect(retained.leadPreset).toEqual(pinned.presets[0]); expect(retained.configHistory).toEqual([]);
    expect(retained.workspaces.every((entry) => !entry.cleanedAt)).toBe(true); expect(retained.candidates).toEqual([]);
    expect(await fs.readFile(path.join(cwd, 'partial.txt'), 'utf8')).toBe('retained partial work\n');
    expect(await fs.stat(path.join(cwd, 'after-revocation.txt')).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(project, 'partial.txt')).catch(() => null)).toBeNull();
    expect(writer.modelDispatch).toHaveBeenCalledTimes(1); expect(actors).toHaveLength(oldActors);
    expect(runtime.scheduler.snapshot().active).toEqual([]); expect(runtime.scheduler.snapshot().queued).toEqual([]);
    expect(retained.operations.filter((operation) => operation.kind === 'interrupt')).toEqual([expect.objectContaining({ state: 'succeeded' })]);
    expect(sessions.activity(attempt.sessionId)).toMatchObject({ active: false, quiescent: true });
    expect((await sessions.transcript(attempt.sessionId)).some((item) => item.kind === 'tool' && item.id === 'held-write')).toBe(true);
  }, 30_000);

  it('interrupts every owned writer before waiting for a slow lead teardown', async () => {
    const { record, writer } = await startWriter('worker', true);
    const lead = currentActor(record.leadSessionId);
    await settings.update({ missionProjects: { [project]: { schemaVersion: 1, revision: 1, allowedProviderIds: [] } } });
    await wait(() => {
      expect(lead.adapter.interrupt).toHaveBeenCalledTimes(1); expect(writer.adapter.interrupt).toHaveBeenCalledTimes(1);
      expect(lead.adapter.dispose).toHaveBeenCalledTimes(1); expect(writer.adapter.dispose).toHaveBeenCalledTimes(1);
    });
    expect(runtime.scheduler.snapshot().active).toHaveLength(2);
    lead.release.resolve(); await lead.settled();
    await wait(() => expect(runtime.scheduler.snapshot().active).toHaveLength(1));
    expect(runtime.service.get(record.id)!.status).toBe('pausing');
    expect(sessions.activity(writer.ctx.sessionId).quiescent).toBe(false);
    writer.release.resolve(); await writer.settled();
    await wait(() => expect(runtime.service.get(record.id)!.status).toBe('paused'));
    for (const item of [lead, writer]) {
      expect(item.modelDispatch).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(path.join(item.ctx.session().cwd, 'partial.txt'), 'utf8')).toBe('retained partial work\n');
      expect(await fs.stat(path.join(item.ctx.session().cwd, 'after-revocation.txt')).catch(() => null)).toBeNull();
    }
    expect(runtime.service.get(record.id)!.attempts.map((attempt) => attempt.outcome)).toEqual(['interrupted', 'interrupted']);
    expect(runtime.scheduler.snapshot().active).toEqual([]);
  }, 30_000);

  it('does not apply enabled library/tier edits or revoke legitimate pinned old versions', async () => {
    const { record, writer } = await startWriter('worker');
    const pinned = structuredClone(runtime.service.get(record.id)!.config);
    const config = structuredClone(settings.get().mission!);
    for (const preset of config.presets) { preset.revision++; preset.name += ' edited'; preset.model.model += '-replacement'; }
    config.tiers[2].presetIds = []; config.tiers[4].presetIds = ['worker']; config.defaultLeadPresetId = 'worker'; config.revision++;
    await settings.update({ mission: config });
    expect(runtime.service.get(record.id)!.status).toBe('running');
    expect(runtime.service.get(record.id)!.config).toEqual(pinned); expect(runtime.service.get(record.id)!.configHistory).toEqual([]);
    expect(writer.adapter.interrupt).not.toHaveBeenCalled(); expect(writer.adapter.dispose).not.toHaveBeenCalled();
    expect((await writer.client.callTool({ name: 'mission_read', arguments: { payload: {} } })).isError).toBe(false);
    writer.release.resolve(); await writer.settled();
    expect(writer.modelDispatch).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(writer.ctx.session().cwd, 'after-revocation.txt'), 'utf8')).toBe('continued writer\n');
    expect(writer.ctx.session().config.model).toEqual(pinned.presets[1].model);
  }, 30_000);

  it('keeps unsupported interruption uncertain and fenced instead of claiming pause or freeing capacity', async () => {
    const { record, writer } = await startWriter('lead');
    writer.adapter.interrupt.mockRejectedValue(new Error('Runtime interruption is unsupported'));
    const config = structuredClone(settings.get().mission!); config.presets[0].enabled = false; delete config.defaultLeadPresetId;
    await settings.update({ mission: config });
    await wait(() => expect(sessions.activity(record.leadSessionId).uncertain).toBe(true));
    await wait(() => expect(runtime.service.get(record.id)!.blockers.some((entry) => /did not stop.*unsupported/.test(entry.message))).toBe(true));
    expect(runtime.service.get(record.id)!.status).toBe('pausing');
    expect(runtime.service.isQuiescent(runtime.service.get(record.id)!)).toBe(false);
    expect(runtime.scheduler.snapshot().active).toHaveLength(1);
    expect(runtime.service.get(record.id)!.attempts[0].status).toBe('running');
    await expect(runtime.service.control({ missionId: record.id, expectedRevision: runtime.service.get(record.id)!.revision, idempotencyKey: 'unsafe-resume', control: { action: 'resume' } })).rejects.toThrow(/paused|reconciled/i);
    await expect(writer.client.callTool({ name: 'mission_read', arguments: { payload: {} } })).rejects.toThrow(/401|authorized/i);
    expect(writer.modelDispatch).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(writer.ctx.session().cwd, 'partial.txt'), 'utf8')).toBe('retained partial work\n');
  }, 30_000);
});
