/** Actual coordinator/store/session/Git/MCP boundary; only the harness process is scripted. */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { MissionService } from '../src/main/mission/service';
import { MissionStore } from '../src/main/mission/store';
import { assertMissionRecord, type MissionTaskContract } from '../src/main/mission/state';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import { MissionScheduler } from '../src/main/mission/scheduler';
import { MissionVerification } from '../src/main/mission/verification';
import { localMissionDeliveryPolicy } from '../src/main/mission/delivery';
import type { MissionToolName, MissionToolRequest } from '../src/main/mission/tools';
import { createDefaultMissionConfig } from '../src/shared/mission-config';
import type { MissionProfile, MissionRecord } from '../src/shared/mission';
import type { ImageAttachment, UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 15_000, interval: 25 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
let root: string, project: string, data: string;
let service: MissionService, sessions: SessionManager, sessionStore: SessionStore, store: MissionStore<MissionRecord>, scheduler: MissionScheduler;
let config: ReturnType<typeof createDefaultMissionConfig>, sequence: number;
let runtimes: Map<string, ReturnType<typeof scripted>>;
const image: ImageAttachment = { mimeType: 'image/png', name: 'exact visual.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVSUAAAAASUVORK5CYII=' };
function scripted(ctx: HarnessContext) {
  return { ctx, adapter: {
    id: 'native', busy: false, start: vi.fn(async () => undefined), missionReadiness: vi.fn(async () => ({ ready: true, tools: ['read', 'write'] })),
    send: vi.fn(async (_input: UserInput) => { ctx.emit({ type: 'status', status: 'running' }); }), interrupt: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined), setEffort: vi.fn(async () => undefined), setPermissionMode: vi.fn(async () => undefined), compact: vi.fn(async () => true),
  } satisfies HarnessAdapter,
  finish: (id = `turn-${++sequence}`) => { ctx.emit({ type: 'item.upsert', item: { id, kind: 'turn', ts: Date.now(), status: 'completed' } }); ctx.emit({ type: 'status', status: 'idle' }); },
  assistant: (text: string) => ctx.emit({ type: 'item.upsert', item: { id: `assistant-${++sequence}`, kind: 'assistant', ts: Date.now(), text } }),
  tool: (status: 'running' | 'done') => ctx.emit({ type: 'item.upsert', item: { id: 'shell', kind: 'tool', ts: Date.now(), name: 'bash', status } }),
  };
}
async function compose() {
  const settings = defaultSettings(); settings.providers = [];
  sessionStore = new SessionStore(data); await sessionStore.load();
  sessions = new SessionManager({ store: sessionStore, settings: { get: () => settings } as SettingsStore, runtime: {} as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as unknown as AnalyticsStore,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn() });
  store = new MissionStore<MissionRecord>(data, { validate: assertMissionRecord }); await store.load();
  scheduler = new MissionScheduler(config.limits);
  const held = new Set<string>();
  const workspaces = new MissionWorkspaces({ root: path.join(root, 'workspaces'), quiescence: { acquire: async (cwd) => {
    const quiet = () => !sessions.list().some((s) => path.resolve(s.cwd) === path.resolve(cwd) && !sessions.activity(s.id).quiescent);
    if (held.has(cwd) || !quiet()) return null; held.add(cwd);
    return { assertQuiescent: async () => { if (!held.has(cwd) || !quiet()) throw new Error('Lease lost'); }, release: () => { held.delete(cwd); } };
  } } });
  const verification = new MissionVerification({ scheduler, authorize: async () => { throw new Error('Not a verification fixture'); }, contentIdentity: (cwd) => workspaces.contentIdentity(cwd), saveArtifact: (id, bytes) => store.writeArtifact(id, bytes) });
  service = new MissionService({ store, sessions, workspaces, scheduler, verification, settings: () => ({ config }), capabilities: { probe: async (_preset, scope) => {
    const { readiness } = await sessions.prepareManaged(scope.sessionId, scope.generation);
    return { source: 'runtime', runtime: { available: true, authenticated: true }, connectionAvailable: true, modelAvailable: true, projectAllowed: true,
      harnessCapabilities: { interrupt: true }, controlProtocol: readiness.ready, worktreeCwd: true, completionObservation: true, cancellationObservation: true, missionTools: readiness.ready, delegationControl: true, tools: readiness.tools };
  } }, delivery: { resolve: async () => localMissionDeliveryPolicy(), deliver: async () => { throw new Error('Not a delivery fixture'); } } });
}
function current(r: MissionRecord) { return service.get(r.id)!; }
async function rpc(r: MissionRecord, name: MissionToolName, request: MissionToolRequest, sessionId = r.leadSessionId) {
  await service.broker.start();
  const owner = sessions.get(sessionId)!.mission!;
  const attached = service.broker.attach({ missionId: r.id, actor: owner.role === 'lead' ? { kind: 'lead', sessionId, generation: owner.generation } : { kind: 'worker', sessionId, generation: owner.generation, attemptId: owner.attemptId! } });
  const response = await fetch(attached.def.url!, { method: 'POST', headers: { 'Content-Type': 'application/json', ...attached.def.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: request } }) });
  const body = await response.json();
  if (body.error || body.result?.isError) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? body.result.content[0].text);
  return body.result as { structuredContent: { result: any }; content: any[] };
}
async function tool(r: MissionRecord, name: MissionToolName, payload: Record<string, unknown>, sessionId = r.leadSessionId) {
  const idempotencyKey = `tool-${++sequence}`;
  for (let retry = 0; ; retry++) {
    try { return (await rpc(r, name, { expectedRevision: current(r).revision, idempotencyKey, payload }, sessionId)).structuredContent.result; }
    catch (error) { if (retry >= 10 || !/Expected revision/.test(String(error))) throw error; }
  }
}
const profile = (): MissionProfile => ({ id: 'scout', revision: 1, name: 'Scout', purpose: 'Read facts', instructions: 'Read and report', tierId: 3, contextRefs: [], requestedTools: ['read'], sourceAccess: 'read_only', resultExpectations: 'Structured result' });
const task = (id = 'one', patch: Partial<MissionTaskContract> = {}): MissionTaskContract => ({ id, revision: 1, specificationRevision: 1, objective: `Investigate ${id}`, scope: 'feature.txt', ownedPaths: ['feature.txt'], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: ['read'], criteria: [], verificationIds: [], assignment: { kind: 'worker', profileId: 'scout', profileRevision: 1 }, required: true, ...patch });
async function start(mode: 'interactive_plan' | 'autonomous' = 'interactive_plan', tasks = [task()], workerProfile = profile()) {
  const r = await service.create({ idempotencyKey: 'launch', projectRoot: project, objective: 'Preserve the required behavior', mode, permissionMode: 'auto' });
  await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
  await tool(r, 'mission_profile_upsert', { profile: workerProfile });
  await tool(r, 'mission_plan_update', { expectedPlanRevision: 0, plan: { ...current(r).plan, criteria: [{ id: 'required', description: 'Preserve existing names', required: true, evidenceKinds: ['behavior'] }] }, tasks });
  return current(r);
}
async function delegate(r: MissionRecord, taskId = 'one') {
  const a = await tool(r, 'mission_task_delegate', { taskId, presetId: 'standard', reason: 'Bounded assigned investigation' }) as { attemptId: string; sessionId: string };
  await wait(() => expect(runtimes.get(a.sessionId)?.adapter.send).toHaveBeenCalledTimes(1)); return a;
}
async function question(r: MissionRecord, purpose: 'clarification' | 'authorization' = 'clarification') {
  await tool(r, 'mission_question_ask', { question: { id: `question-${++sequence}`, text: 'Which additional behavior is required?', purpose } });
  runtimes.get(r.leadSessionId)!.finish(); await wait(() => expect(sessions.activity(r.leadSessionId).quiescent).toBe(true));
  await wait(() => expect(scheduler.snapshot().active.filter((entry) => entry.kind === 'lead')).toHaveLength(0));
}
async function answer(r: MissionRecord, input: UserInput = { text: 'Also preserve numeric values.' }, key = 'answer') {
  const count = runtimes.get(r.leadSessionId)!.adapter.send.mock.calls.length;
  await service.sendUser(r.leadSessionId, input, key);
  await wait(() => expect(runtimes.get(r.leadSessionId)!.adapter.send).toHaveBeenCalledTimes(count + 1));
}
const material = (r: MissionRecord, affectedTaskIds: string[] = []) => ({ expectedPlanRevision: current(r).planRevision, plan: { ...current(r).plan, behavior: 'Preserve numeric values as well as names.' }, material: { source: { kind: 'user_instruction' }, affectedTaskIds } });
async function restart() {
  await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists(); runtimes.clear();
  await compose(); await service.load();
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-user-')); project = path.join(root, 'project'); data = path.join(root, 'data');
  await fs.mkdir(project); git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Mission Test'); git(project, 'config', 'user.email', 'mission-test@example.invalid'); git(project, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(project, 'feature.txt'), 'original\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'test: baseline');
  config = createDefaultMissionConfig();
  const lead = { id: 'frontier', name: 'Principal', revision: 1, harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets = [lead, { ...lead, id: 'standard', name: 'Scout', model: { provider: 'fixture', model: 'standard' } }]; config.tiers[4].presetIds = ['frontier']; config.tiers[2].presetIds = ['standard']; config.defaultLeadPresetId = 'frontier';
  sequence = 0; runtimes = new Map();
  vi.mocked(createAdapter).mockImplementation((_harness, ctx) => { const runtime = scripted(ctx); runtimes.set(ctx.sessionId, runtime); return runtime.adapter; });
  await compose();
});
afterEach(async () => { await service.close(); await sessions.stopAll(); await sessions.flushPendingPersists(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

describe('host-bound Mission user instructions', () => {
  it('revises an interactive plan from the real delivered answer without model-selected authority or weakened required criteria', async () => {
    const r = await start(); await question(r); await answer(r);
    const before = current(r), input = material(r);
    await expect(tool(r, 'mission_plan_update', { ...input, material: { source: { kind: 'user', actionId: before.questions[0].sourceUserActionId }, affectedTaskIds: [] } })).rejects.toThrow(/user action/);
    await expect(tool(r, 'mission_plan_update', { ...input, material: { source: { kind: 'user_instruction', actionId: before.questions[0].sourceUserActionId }, affectedTaskIds: [] } })).rejects.toThrow();
    await expect(tool(r, 'mission_plan_update', { ...input, plan: { ...input.plan, criteria: [] } })).rejects.toThrow(/required criterion/);
    const request = { expectedRevision: current(r).revision, idempotencyKey: 'interpret-answer', payload: input };
    const result = await rpc(r, 'mission_plan_update', request);
    const updated = current(r);
    expect(updated).toMatchObject({ phase: 'planning', status: 'running', specificationRevision: 2, planRevision: 2, plan: { behavior: input.plan.behavior, criteria: before.plan.criteria } });
    expect(updated.executionAuthorization).toBeUndefined();
    expect(updated.mailbox.find((m) => m.id === updated.questions[0].sourceUserActionId)?.userAction).toMatchObject({ kind: 'answer', appliedPlanRevision: 2, materialBinding: { sessionId: r.leadSessionId, generation: 1 } });
    expect((await rpc(r, 'mission_plan_update', request)).structuredContent).toEqual(result.structuredContent);
    expect(current(r).revision).toBe(updated.revision);
    await expect(tool(r, 'mission_plan_update', material(r))).rejects.toThrow(/unconsumed user instruction/);
    for (const field of ['config', 'leadPreset', 'requestedPermissionMode', 'providerRestrictions', 'deliveryPolicy'] as const) expect(updated[field]).toEqual(before[field]);
  });

  it('cannot borrow an old answer in another turn or treat a permission answer as material-change authority', async () => {
    const r = await start(); await question(r); await answer(r);
    const lead = runtimes.get(r.leadSessionId)!; lead.finish(); await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(3));
    await expect(tool(r, 'mission_plan_update', material(r))).rejects.toThrow(/delivered in this lead turn/);
    await question(r, 'authorization'); await answer(r, { text: 'Yes, this one command.' }, 'authorization-answer');
    await expect(tool(r, 'mission_plan_update', material(r))).rejects.toThrow(/unconsumed user instruction/);
    expect(current(r).specificationRevision).toBe(1); expect(current(r).executionAuthorization).toBeUndefined();
  });

  it('rejects a queued correction before delivery and a delivered correction after its plan context changed', async () => {
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!;
    await service.sendUser(r.leadSessionId, { text: 'Preserve numeric values too.' }, 'queued');
    await expect(tool(r, 'mission_plan_update', material(r))).rejects.toThrow(/unconsumed user instruction/);
    lead.finish(); await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    await tool(r, 'mission_plan_update', { expectedPlanRevision: current(r).planRevision, plan: current(r).plan });
    await expect(tool(r, 'mission_plan_update', material(r))).rejects.toThrow(/current plan\/specification/);
    expect(current(r).specificationRevision).toBe(1);
  });

  it('invalidates the corrected running contract, dependents, old results and proposal while retaining unrelated contracts and partial files', async () => {
    const r = await start('autonomous', [task('one', { requiredTools: ['write'] }), task('dependent', { dependsOn: [{ taskId: 'one', condition: 'accepted_artifact' }] }), task('unrelated')], { ...profile(), sourceAccess: 'assigned_workspace', requestedTools: ['write'] });
    await tool(r, 'mission_phase_set', { phase: 'executing' });
    const worker = await delegate(r); const before = current(r), old = before.attempts[0];
    expect(sessions.get(worker.sessionId)?.mission?.sourceAccess).toBe('assigned_workspace');
    const partial = path.join(sessions.get(worker.sessionId)!.cwd, 'partial.txt'); await fs.writeFile(partial, 'Retain this partial investigation');
    await service.sendUser(r.leadSessionId, { text: 'The one contract must also preserve numeric values.' }, 'running-correction');
    const lead = runtimes.get(r.leadSessionId)!; lead.finish(); await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    await tool(r, 'mission_plan_update', material(r, ['one']));
    await wait(() => expect(current(r).status).toBe('paused'));
    expect(current(r)).toMatchObject({ specificationRevision: 2, phase: 'planning' }); expect(current(r).executionAuthorization).toBeUndefined(); expect(current(r).pendingProposal).toBeUndefined();
    expect(current(r).tasks.filter((t) => t.status === 'superseded').map((t) => t.id)).toEqual(['one', 'dependent']);
    expect(current(r).tasks.find((t) => t.id === 'unrelated')).toEqual(before.tasks.find((t) => t.id === 'unrelated'));
    expect(current(r).attempts[0]).toMatchObject({ id: old.id, taskRevision: old.taskRevision, specificationRevision: 1, status: 'terminal', outcome: 'interrupted' });
    expect(await fs.readFile(partial, 'utf8')).toBe('Retain this partial investigation');
    await expect(tool(r, 'mission_report', { result: { taskId: old.taskId, taskRevision: old.taskRevision, attemptId: old.id, specificationRevision: 1, status: 'candidate', summary: 'Old result', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } }, worker.sessionId)).rejects.toThrow(/authorized|assigned|generation/);
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'resume-replanning', control: { action: 'resume' } });
    await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
    await tool(r, 'mission_plan_update', { expectedPlanRevision: current(r).planRevision, plan: current(r).plan, tasks: [task('one', { revision: old.taskRevision + 1, specificationRevision: 2 }), task('dependent', { revision: 2, specificationRevision: 2, dependsOn: [{ taskId: 'one', condition: 'accepted_artifact' }] })] });
    runtimes.get(r.leadSessionId)!.assistant('The revised plan preserves numeric values. Proceed with execution?');
    await tool(r, 'mission_execution_propose', { proposal: { id: 'new-proposal', specificationRevision: 2, planRevision: current(r).planRevision } });
    runtimes.get(r.leadSessionId)!.finish(); await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    await expect(service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'old-approval', control: { action: 'execute', proposalId: 'new-proposal', specificationRevision: 1 } })).rejects.toThrow(/proposal/);
    await service.sendUser(r.leadSessionId, { text: 'yes, proceed' }, 'new-approval');
    expect(current(r).executionAuthorization).toMatchObject({ kind: 'approved_plan', specificationRevision: 2 });
  });

  it('retains and delivers exact post-launch images once at the safe boundary, including an answered question and restart', async () => {
    const r = await start(); const lead = runtimes.get(r.leadSessionId)!; const writes = vi.spyOn(store, 'retainArtifact');
    const input = { text: 'Use this exact image as the clarification.', images: [image] };
    await Promise.all([service.sendUser(r.leadSessionId, input, 'visual'), service.sendUser(r.leadSessionId, input, 'visual')]);
    expect(writes).toHaveBeenCalledTimes(1); expect(lead.adapter.send).toHaveBeenCalledTimes(1);
    const retained = current(r).mailbox.find((m) => m.userAction)!; expect(retained.attachments).toHaveLength(1); expect(retained.deliveredAt).toBeUndefined();
    expect(JSON.stringify(current(r))).not.toContain(image.data);
    await service.sendUser(r.leadSessionId, input, 'visual'); expect(writes).toHaveBeenCalledTimes(1);
    await expect(service.sendUser(r.leadSessionId, { ...input, images: [{ ...image, data: 'YmFk' }] }, 'visual')).rejects.toThrow(/idempotency/); expect(writes).toHaveBeenCalledTimes(1);
    lead.tool('running'); lead.finish(); expect(lead.adapter.send).toHaveBeenCalledTimes(1);
    lead.tool('done'); await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    expect(lead.adapter.send.mock.calls[1][0].images).toEqual([image]); expect(lead.adapter.send.mock.calls[1][0].text).toContain(retained.attachments![0].ref);
    await question(r); await answer(r, { text: 'This answer includes another image.', images: [{ ...image, name: 'answer.png' }] }, 'visual-answer');
    expect(lead.adapter.send.mock.calls.at(-1)![0].images).toEqual([{ ...image, name: 'answer.png' }]);
    const refs = current(r).mailbox.flatMap((m) => m.attachments ?? []);
    await restart(); expect(current(r).status).toBe('paused'); expect(current(r).mailbox.flatMap((m) => m.attachments ?? [])).toEqual(refs);
    const restartedWrites = vi.spyOn(store, 'retainArtifact'); await service.sendUser(r.leadSessionId, input, 'visual'); expect(restartedWrites).not.toHaveBeenCalled();
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'resume', control: { action: 'resume' } });
    await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
    const content = await rpc(r, 'mission_context_read', { payload: { ref: refs[0].ref, imageIndex: 0 } });
    expect(content.content[1]).toEqual({ type: 'image', data: image.data, mimeType: image.mimeType });
  });

  it('retains queued image instructions across restart and rejects invalid/stale inputs before blob writes', async () => {
    const r = await start(); const writes = vi.spyOn(store, 'retainArtifact');
    await expect(service.sendUser(r.leadSessionId, { text: 'No path capability', images: [{ ...image, path: path.join(project, 'feature.txt') } as ImageAttachment] }, 'invalid-path')).rejects.toThrow();
    await expect(service.control({ missionId: r.id, expectedRevision: current(r).revision - 1, idempotencyKey: 'stale-image', control: { action: 'steer', text: 'Stale', images: [image] } })).rejects.toThrow(/Expected revision/);
    expect(writes).not.toHaveBeenCalled();
    const input = { text: '', images: [image] };
    await service.sendUser(r.leadSessionId, input, 'queued-image');
    const queued = current(r).mailbox.find((item) => item.attachments?.length)!;
    expect(queued.deliveredAt).toBeUndefined(); expect(writes).toHaveBeenCalledTimes(1);
    await restart();
    expect(current(r).mailbox.find((item) => item.id === queued.id)).toEqual(queued);
    const restartWrites = vi.spyOn(store, 'retainArtifact'); await service.sendUser(r.leadSessionId, input, 'queued-image'); expect(restartWrites).not.toHaveBeenCalled();
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'resume-images', control: { action: 'resume' } });
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    expect(runtimes.get(r.leadSessionId)!.adapter.send.mock.calls[0][0].images).toEqual([image]);
    expect(current(r).mailbox.find((item) => item.id === queued.id)?.deliveredAt).toBeDefined();
  });

  it('reuses retained image blobs after a failed state commit rather than writing them again on retry', async () => {
    const r = await start(); const writes = vi.spyOn(store, 'retainArtifact'), transact = store.transact.bind(store);
    const failure = vi.spyOn(store, 'transact').mockImplementation((id, metadata, mutation) => metadata.kind === 'user.steer' ? Promise.reject(new Error('Injected pre-commit failure')) : transact(id, metadata, mutation));
    const input = { text: 'Retain this correction', images: [image] };
    await expect(service.sendUser(r.leadSessionId, input, 'failed-commit')).rejects.toThrow(/Injected pre-commit/);
    expect(current(r).mailbox.filter((item) => item.userAction)).toHaveLength(0); expect(writes).toHaveBeenCalledTimes(1);
    failure.mockRestore();
    await service.sendUser(r.leadSessionId, input, 'failed-commit');
    expect(current(r).mailbox.filter((item) => item.userAction)).toHaveLength(1); expect(writes).toHaveBeenCalledTimes(1);
  });

  it('recovers exact attachment refs after durable blob writes but a failed mailbox append and a new Store instance', async () => {
    const r = await start(), input = { text: 'Retain both exact images', images: [image, { ...image, name: 'second.png' }] };
    const artifactDir = path.join(data, 'missions', r.id, 'artifacts');
    const snapshot = async () => {
      const names = (await fs.readdir(artifactDir, { recursive: true })).sort();
      return Promise.all(names.map(async (name) => {
        const file = path.join(artifactDir, name), stat = await fs.lstat(file);
        return { name, ...(stat.isFile() ? { bytes: await fs.readFile(file), inode: stat.ino, modified: stat.mtimeMs } : {}) };
      }));
    };
    const open = fs.open.bind(fs);
    const failure = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === path.join(data, 'missions', r.id, 'journal.jsonl')) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...writeArgs) => {
          if (String(writeArgs[0]).includes('"kind":"user.steer"')) throw new Error('Injected mailbox append failure after durable attachments');
          return write(...writeArgs);
        });
      }
      return handle;
    });
    await expect(service.sendUser(r.leadSessionId, input, 'crash-before-mailbox')).rejects.toThrow(/Injected mailbox append failure/);
    expect(current(r).mailbox.filter((item) => item.userAction)).toHaveLength(0);
    const retained = await snapshot(); expect(await fs.readdir(artifactDir)).toHaveLength(2);
    failure.mockRestore(); await store.load(r.id); await restart();
    for (const changed of [{ ...input, text: 'Changed request before recovery' }, { ...input, images: [] }, { ...input, images: [{ ...image, data: 'YmFk' }, input.images[1]] }]) {
      await expect(service.sendUser(r.leadSessionId, changed, 'crash-before-mailbox')).rejects.toThrow(/different request|idempotency/i);
      expect(current(r).mailbox.filter((item) => item.userAction)).toHaveLength(0);
    }
    expect(await snapshot()).toEqual(retained);
    await Promise.all([service.sendUser(r.leadSessionId, input, 'crash-before-mailbox'), service.sendUser(r.leadSessionId, input, 'crash-before-mailbox')]);
    const mail = current(r).mailbox.filter((item) => item.userAction);
    expect(mail).toHaveLength(1); expect(mail[0].attachments).toHaveLength(2); expect(new Set(mail[0].attachments!.map((item) => item.ref)).size).toBe(2);
    expect(await snapshot()).toEqual(retained);
    await restart(); await service.sendUser(r.leadSessionId, input, 'crash-before-mailbox');
    expect(current(r).mailbox.filter((item) => item.userAction)).toHaveLength(1); expect(await snapshot()).toEqual(retained);
    await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: 'resume-retained', control: { action: 'resume' } });
    await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
    expect(runtimes.get(r.leadSessionId)!.adapter.send.mock.calls[0][0].images).toEqual(input.images);
    expect(current(r).mailbox.find((item) => item.id === mail[0].id)?.deliveredAt).toBeDefined();
  });

  it('denies unassigned workers and path/selector attacks before any attachment blob read, then permits an explicitly scoped worker', async () => {
    const r = await start(); await question(r); await answer(r, { text: 'Visual evidence', images: [image] });
    const ref = current(r).mailbox.flatMap((m) => m.attachments ?? [])[0].ref;
    const worker = await delegate(r); const reads = vi.spyOn(store, 'readArtifact'); reads.mockClear();
    await expect(service.invoke({ missionId: r.id, actor: { kind: 'worker', sessionId: worker.sessionId, generation: sessions.get(worker.sessionId)!.mission!.generation, attemptId: 'missing-attempt' } }, 'mission_context_read', { payload: { ref, imageIndex: 0 } })).rejects.toThrow(/assigned|authorized|attempt/i);
    for (const payload of [{ ref }, { ref, imageIndex: 0 }, { ref, listImages: true }, { ref: '../outside.png', imageIndex: 0 }]) await expect(rpc(r, 'mission_context_read', { payload }, worker.sessionId)).rejects.toThrow(/assigned/);
    for (const payload of [{ ref: path.join(project, 'feature.txt'), imageIndex: 0 }, { ref, imageIndex: 0, offset: 0 }, { ref, imageIndex: 1 }]) await expect(rpc(r, 'mission_context_read', { payload })).rejects.toThrow();
    expect(reads).not.toHaveBeenCalled();
    const descriptors = await rpc(r, 'mission_context_read', { payload: { ref } }); expect(JSON.stringify(descriptors)).not.toContain(image.data); expect(reads).not.toHaveBeenCalled();
    await tool(r, 'mission_profile_upsert', { profile: { ...profile(), id: 'visual', contextRefs: [ref] } });
    await tool(r, 'mission_plan_update', { expectedPlanRevision: current(r).planRevision, plan: current(r).plan, tasks: [task('visual', { assignment: { kind: 'worker', profileId: 'visual', profileRevision: 1 } })] });
    const assigned = await delegate(r, 'visual');
    expect((await rpc(r, 'mission_context_read', { payload: { ref, imageIndex: 0 } }, assigned.sessionId)).content[1]).toEqual({ type: 'image', mimeType: image.mimeType, data: image.data });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('does not interpret an affirmative carrying images as approval of the pending exact revision', async () => {
    const r = await start(); runtimes.get(r.leadSessionId)!.assistant('Current plan. Proceed with execution?');
    await tool(r, 'mission_execution_propose', { proposal: { id: 'proposal', specificationRevision: 1, planRevision: 1 } });
    runtimes.get(r.leadSessionId)!.finish(); await wait(() => expect(scheduler.snapshot().active).toHaveLength(0));
    await answer(r, { text: 'yes', images: [image] });
    expect(current(r).pendingProposal).toBeUndefined(); expect(current(r).executionAuthorization).toBeUndefined();
    expect(runtimes.get(r.leadSessionId)!.adapter.send.mock.calls.at(-1)![0].images).toEqual([image]);
  });
});

describe('real decision-resolution progress checkpoints', () => {
  it('counts each tool-resolved decision once, not prose, reads, requests, polling or duplicate terminal events', async () => {
    config.limits.progressCheckpointEveryTurns = 1; config.limits.maxNoProgressCheckpoints = 2;
    const r = await start('autonomous'); const lead = runtimes.get(r.leadSessionId)!;
    for (let checkpoint = 1; checkpoint <= 3; checkpoint++) {
      await tool(r, 'mission_decision_request', { decision: { id: `decision-${checkpoint}`, question: 'How should this boundary be preserved?', evidenceIds: [], affectedTaskIds: [] } });
      const before = current(r), request = { expectedRevision: before.revision, idempotencyKey: `resolve-${checkpoint}`, payload: { decisionId: `decision-${checkpoint}`, resolution: `Use the existing verified boundary ${checkpoint}`, rationale: 'Preserves the explicit contract', evidenceIds: [], affectedTaskIds: [] } };
      await rpc(r, 'mission_decision_resolve', request); const updated = current(r);
      expect(updated.progress.lastProgressRevision).toBe(before.revision);
      await rpc(r, 'mission_decision_resolve', request); expect(current(r).revision).toBe(updated.revision); expect(current(r).progress.lastProgressRevision).toBe(before.revision);
      await expect(tool(r, 'mission_decision_resolve', request.payload)).rejects.toThrow(/already resolved/);
      lead.finish(`decision-turn-${checkpoint}`); await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(checkpoint + 1));
      expect(current(r).progress).toMatchObject({ completedTurns: checkpoint, checkpointsWithoutProgress: 0 }); expect(current(r).status).toBe('running');
    }
    const marker = current(r).progress.lastProgressRevision;
    for (let poll = 0; poll < 3; poll++) { lead.assistant('I am still making progress'); await rpc(r, 'mission_read', { payload: {} }); }
    await tool(r, 'mission_decision_request', { decision: { id: 'unresolved', question: 'Still open', evidenceIds: [], affectedTaskIds: [] } });
    expect(current(r).progress.lastProgressRevision).toBe(marker);
    lead.finish('quiet-one'); await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(5));
    expect(current(r).progress).toMatchObject({ completedTurns: 4, checkpointsWithoutProgress: 1 });
    lead.finish('quiet-one'); await new Promise((resolve) => setImmediate(resolve)); expect(current(r).progress.completedTurns).toBe(4);
    lead.finish('quiet-two'); await wait(() => expect(current(r).status).toBe('paused'));
    expect(current(r).progress).toEqual({ completedTurns: 5, checkpointsWithoutProgress: 2, lastProgressRevision: marker });
    expect(current(r).decisions.filter((decision) => decision.resolution)).toHaveLength(3);
    expect(current(r).blockers.filter((blocker) => /no new candidate.*resolved decision/.test(blocker.message))).toHaveLength(1);
  });
});
describe('no-progress checkpoint diagnosis', () => {
  it('gives the lead one diagnosis turn per Resume without resetting the bound; only recorded progress clears it', async () => {
    config.limits.progressCheckpointEveryTurns = 1; config.limits.maxNoProgressCheckpoints = 2;
    const r = await start('autonomous'); const lead = runtimes.get(r.leadSessionId)!;
    const noProgress = () => current(r).blockers.filter((blocker) => /no new candidate.*resolved decision/.test(blocker.message));
    const resume = async (key: string, previous: ReturnType<typeof scripted>) => {
      await service.control({ missionId: r.id, expectedRevision: current(r).revision, idempotencyKey: key, control: { action: 'resume' } });
      // host.recover retired the old lead generation; the diagnosis turn runs in a fresh runtime.
      await wait(() => expect(runtimes.get(r.leadSessionId)).not.toBe(previous));
      await wait(() => expect(runtimes.get(r.leadSessionId)?.adapter.send).toHaveBeenCalledTimes(1));
      await wait(() => expect(sessions.activity(r.leadSessionId).turn).toBe(true));
      return runtimes.get(r.leadSessionId)!;
    };
    lead.finish('quiet-one'); await wait(() => expect(lead.adapter.send).toHaveBeenCalledTimes(2));
    lead.finish('quiet-two'); await wait(() => expect(current(r).status).toBe('paused'));
    expect(noProgress()).toEqual([expect.objectContaining({ id: expect.stringMatching(/^progress_/) })]);
    expect(current(r).progress.checkpointsWithoutProgress).toBe(2);
    const diagnosis = await resume('diagnose-once', lead);
    expect(diagnosis.adapter.send.mock.calls[0][0].text).toMatch(/diagnosis turn/);
    expect(current(r).progress.checkpointsWithoutProgress).toBe(2); // Resume never resets the bound.
    diagnosis.finish('no-diagnosis');
    await wait(() => expect(current(r).status).toBe('paused'));
    expect(noProgress().map((blocker) => blocker.resolvedAt === undefined)).toEqual([false, true]);
    const next = await resume('diagnose-again', diagnosis);
    await tool(r, 'mission_decision_request', { decision: { id: 'no-progress-diagnosis', question: 'Why did repeated turns make no progress?', evidenceIds: [], affectedTaskIds: [] } });
    await tool(r, 'mission_decision_resolve', { decisionId: 'no-progress-diagnosis', resolution: 'Verify the boundary before delegating more work', rationale: 'The retained turns repeated the same unverified plan', evidenceIds: [], affectedTaskIds: [] });
    next.finish('diagnosed');
    await wait(() => expect(next.adapter.send).toHaveBeenCalledTimes(2));
    expect(current(r)).toMatchObject({ status: 'running', progress: { checkpointsWithoutProgress: 0 } });
    expect(current(r).blockers.filter((blocker) => blocker.resolvedAt === undefined)).toEqual([]);
  });
});
