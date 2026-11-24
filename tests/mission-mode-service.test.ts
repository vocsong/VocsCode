/**
 * MissionService against the real SessionManager and SessionStore, scripted adapters and a temp git
 * repository: turning a session into a Lead, Builders and their limit, host messages that wait for
 * an idle boundary and arrive combined, the failed-check block, approvals routed to the Lead or kept
 * with the user, restart without dispatch and the one Resume message, and record writes that fail.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { MissionService, type MissionRecord } from '../src/main/mission-mode/service';
import type { MissionGatewayPort } from '../src/main/mission-mode/contracts';
import type { MissionTool, MissionToolArgs } from '../src/shared/mission-mode';
import type { ApprovalDecision, SessionMeta, TranscriptItem, UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
// Pass-through, except that the test can make the mission record's write fail.
const disk = vi.hoisted(() => ({ failMission: false }));
vi.mock('../src/main/util/fs', async (original) => {
  const real = await original<typeof import('../src/main/util/fs')>();
  return {
    ...real,
    writeJson: vi.fn((file: string, data: unknown, opts?: { mode?: number }) =>
      disk.failMission && path.basename(file) === 'mission.json' ? Promise.reject(new Error('disk full')) : real.writeJson(file, data, opts))
  };
});

const DELAY = 40;
const settle = (ms = DELAY * 6) => new Promise((resolve) => setTimeout(resolve, ms));

let tmp: string;
let userData: string;
let repo: string;
let store: SessionStore;
let manager: SessionManager;
let service: MissionService;
let settings: ReturnType<typeof defaultSettings>;
let runtimes: ReturnType<typeof scripted>[];
let deps: ReturnType<typeof dependencies>;
let gateway: { attach: Mock<MissionGatewayPort['attach']>; revoke: Mock<MissionGatewayPort['revoke']> };

const git = (args: string[], cwd: string) =>
  new Promise<string>((resolve, reject) => execFile('git', args, { cwd }, (e, stdout, stderr) => (e ? reject(new Error(`${args.join(' ')}: ${stderr || e.message}`)) : resolve(String(stdout).trim()))));

function scripted(ctx: HarnessContext) {
  const runtime = {
    ctx,
    /** The session's Mission identity at the moment each message reached the harness. */
    missionAtSend: [] as (SessionMeta['mission'] | undefined)[],
    adapter: {
      id: 'native', busy: false,
      start: vi.fn<HarnessAdapter['start']>(async () => undefined),
      send: vi.fn(async (_input: UserInput) => {
        runtime.missionAtSend.push(ctx.session().mission);
        ctx.emit({ type: 'status', status: 'running' });
      }),
      interrupt: vi.fn(async () => undefined),
      dispose: vi.fn<HarnessAdapter['dispose']>(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setEffort: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
    } satisfies HarnessAdapter,
    finish: (status: 'completed' | 'failed' = 'completed') => {
      ctx.emit({ type: 'item.upsert', item: { id: `turn_${Math.random().toString(36).slice(2)}`, kind: 'turn', ts: Date.now(), status } });
      ctx.emit({ type: 'status', status: 'idle' });
    },
  };
  return runtime;
}

function dependencies(sessionStore: SessionStore) {
  return {
    store: sessionStore,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordUserInputs: vi.fn(), flush: vi.fn(async () => undefined), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn(), recordSubagent: vi.fn() } as unknown as AnalyticsStore,
    getSecret: vi.fn<(_providerId: string) => Promise<string | undefined>>(async () => undefined),
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  };
}

function boot(sessionStore: SessionStore, deliveryDelayMs = DELAY) {
  deps = dependencies(sessionStore);
  let svc: MissionService | undefined;
  const mgr = new SessionManager({ ...deps, mission: () => svc });
  svc = new MissionService({
    sessions: mgr,
    sessionDir: (id) => sessionStore.sessionDir(id),
    settings: () => settings,
    appInstructions: { mission: async () => undefined },
    gateway: () => gateway,
    log: vi.fn(),
    deliveryDelayMs,
  });
  return { mgr, svc };
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-svc-')));
  userData = path.join(tmp, 'userData');
  repo = path.join(tmp, 'project');
  await fs.mkdir(repo, { recursive: true });
  await git(['init', '-q'], repo);
  await git(['checkout', '-qb', 'develop'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'core.autocrlf', 'false'], repo);
  await fs.writeFile(path.join(repo, 'README.md'), '# project\n');
  await git(['add', 'README.md'], repo);
  await git(['commit', '-qm', 'init'], repo);
  store = new SessionStore(userData);
  await store.load();
  settings = defaultSettings();
  runtimes = [];
  gateway = { attach: vi.fn<MissionGatewayPort['attach']>(() => null), revoke: vi.fn<MissionGatewayPort['revoke']>() };
  disk.failMission = false;
  ({ mgr: manager, svc: service } = boot(store));
  vi.mocked(createAdapter).mockReset().mockImplementation((_id, ctx) => {
    const runtime = scripted(ctx);
    runtimes.push(runtime);
    return runtime.adapter;
  });
});

afterEach(async () => {
  service.dispose();
  await manager.stopAll();
  await manager.flushPendingPersists();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------------------------

const runtimesOf = (sessionId: string) => runtimes.filter((r) => r.ctx.sessionId === sessionId);
const runtimeOf = (sessionId: string) => runtimesOf(sessionId).at(-1)!;
const sent = (sessionId: string) => runtimesOf(sessionId).flatMap((r) => r.adapter.send.mock.calls.map(([input]) => input.text));
const approvalNotices = () => deps.notify.mock.calls.filter(([, title]) => String(title).includes('approval needed'));

async function ordinary(title = 'Plain'): Promise<SessionMeta> {
  return manager.create({ title, config: { harness: 'native', projectRoot: repo, permissionMode: 'full-auto', model: { provider: 'local', model: 'exact-model' } } });
}

/** A Lead whose first turn already ended, so it is idle. */
async function idleLead(task = 'Add a rate limiter to the API'): Promise<{ leadId: string; missionId: string }> {
  const s = await ordinary();
  const { leadId } = await service.start({ sessionId: s.id, input: { text: task } });
  await vi.waitFor(() => expect(sent(leadId)).toHaveLength(1));
  runtimeOf(leadId).finish();
  return { leadId, missionId: manager.get(leadId)!.mission!.missionId };
}

function tool<T extends MissionTool>(sessionId: string, missionId: string, role: 'lead' | 'builder', name: T, args: MissionToolArgs[T]) {
  return service.call({ sessionId, missionId, role, tool: name, args });
}

async function startBuilder(leadId: string, missionId: string, title: string, own = false): Promise<{ builderId: string; sessionId: string }> {
  const result = await tool(leadId, missionId, 'lead', 'start_builder', { title, task: `Do ${title}`, ...(own ? { own_worktree: true } : {}) });
  expect(result.isError, result.text).toBeFalsy();
  const view = service.get(leadId)!;
  const b = view.builders.find((x) => x.title === title)!;
  // The renderer finds the Builder by the ids in the result.
  expect(result.text).toContain(b.id);
  expect(result.text).toContain(b.sessionId);
  return { builderId: b.id, sessionId: b.sessionId };
}

const record = async (leadId: string) => JSON.parse(await fs.readFile(path.join(store.sessionDir(leadId), 'mission.json'), 'utf8')) as MissionRecord;
const builderState = (leadId: string, builderId: string) => service.get(leadId)!.builders.find((b) => b.id === builderId)!.state;
const missionItems = async (id: string) => (await manager.transcript(id)).filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user' && i.origin === 'mission');

// ---------------------------------------------------------------------------------------------

describe('starting a mission', () => {
  it('turns an empty session into the Lead, in Plan, on its own mission/<slug> worktree, and sends the task as the user', async () => {
    const s = await ordinary();
    const { leadId } = await service.start({ sessionId: s.id, input: { text: 'Add a rate limiter to the API' } });
    expect(leadId).toBe(s.id);
    const lead = manager.get(leadId)!;
    expect(lead.mission).toMatchObject({ role: 'lead', state: 'running' });
    expect(lead.config.permissionMode).toBe('plan');
    expect(lead.worktreeBranch).toMatch(/^mission\/.+/);
    expect(lead.cwd.startsWith(path.join(repo, '.vocs-code', 'worktrees'))).toBe(true);
    expect(await git(['branch', '--list', lead.worktreeBranch!], repo)).toContain(lead.worktreeBranch);
    const saved = await record(leadId);
    expect(saved).toMatchObject({ v: 1, id: lead.mission!.missionId, leadId, state: 'running', git: true, baseBranch: 'develop', leadBranch: lead.worktreeBranch, leadWorktree: lead.cwd, leadWorktreeOwned: true });
    await vi.waitFor(() => expect(sent(leadId)).toEqual(['Add a rate limiter to the API']));
    // The first runtime already ran as the Lead, and the message is the user's own.
    expect(runtimeOf(leadId).missionAtSend[0]).toMatchObject({ role: 'lead' });
    const user = (await manager.transcript(leadId)).find((i) => i.kind === 'user');
    expect(user).toMatchObject({ text: 'Add a rate limiter to the API' });
    expect(user && 'origin' in user ? user.origin : undefined).toBeUndefined();
    const prompt = await service.instructions(lead);
    expect(prompt).toContain('you are the Lead');
    expect(prompt!.trimEnd().split('\n## ').at(-1)).toMatch(/^Mission rules/);
  });

  it('hands a session with history to a new Lead with that conversation, leaving the source untouched', async () => {
    const src = await ordinary('Parser work');
    await manager.send(src.id, { text: 'Explain the parser' });
    runtimeOf(src.id).finish();
    const before = structuredClone(manager.get(src.id)!);
    const { leadId } = await service.start({ sessionId: src.id, input: { text: 'Now split it into modules' } });
    expect(leadId).not.toBe(src.id);
    const lead = manager.get(leadId)!;
    expect(lead.mission).toMatchObject({ role: 'lead', state: 'running' });
    expect(lead.config.permissionMode).toBe('plan');
    expect(lead.worktreeBranch).toMatch(/^mission\//);
    expect(lead.forkedFrom).toBe(src.id);
    await vi.waitFor(() => expect(sent(leadId)).toHaveLength(1));
    // The carried conversation leads the first message; the user's words end it.
    expect(sent(leadId)[0]).toContain('Explain the parser');
    expect(sent(leadId)[0].endsWith('Now split it into modules')).toBe(true);
    const after = manager.get(src.id)!;
    expect(after.mission).toBeUndefined();
    expect({ cwd: after.cwd, worktreeBranch: after.worktreeBranch, config: after.config }).toEqual({ cwd: before.cwd, worktreeBranch: before.worktreeBranch, config: before.config });
    expect(sent(src.id)).toEqual(['Explain the parser']);
  });

  it('creates a New Session Lead without dispatching its prompt until it leads', async () => {
    const meta = await service.createLead({
      config: { harness: 'native', projectRoot: repo, permissionMode: 'plan', useWorktree: true, branchPrefix: 'mission', model: { provider: 'local', model: 'exact-model' } },
      initialPrompt: 'Add pagination to the list endpoint'
    });
    expect(meta.mission).toMatchObject({ role: 'lead' });
    expect(meta.worktreeBranch).toMatch(/^mission\//);
    await vi.waitFor(() => expect(sent(meta.id)).toEqual(['Add pagination to the list endpoint']));
    expect(runtimesOf(meta.id)).toHaveLength(1);
    expect(runtimeOf(meta.id).missionAtSend).toEqual([expect.objectContaining({ role: 'lead' })]);
    expect(await record(meta.id)).toMatchObject({ leadWorktreeOwned: true, leadBranch: meta.worktreeBranch, baseBranch: 'develop' });
  });
});

describe('Builders and host messages', () => {
  it('runs at most three Builders at once', async () => {
    const { leadId, missionId } = await idleLead();
    for (const title of ['one', 'two', 'three']) await startBuilder(leadId, missionId, title);
    const fourth = await tool(leadId, missionId, 'lead', 'start_builder', { title: 'four', task: 'Do four' });
    expect(fourth).toMatchObject({ isError: true });
    expect(fourth.text).toMatch(/At most 3 Builders/);
    expect(service.get(leadId)!.builders).toHaveLength(3);
    expect(manager.list().filter((s) => s.mission?.role === 'builder')).toHaveLength(3);
  });

  it('wakes an idle Lead exactly once for two reports that arrive close together', async () => {
    // A debounce long enough to see: the second report lands well inside it.
    const debounce = 400;
    service.dispose();
    ({ mgr: manager, svc: service } = boot(store, debounce));
    const { leadId, missionId } = await idleLead();
    const b1 = await startBuilder(leadId, missionId, 'api');
    const b2 = await startBuilder(leadId, missionId, 'docs');
    await vi.waitFor(() => expect([sent(b1.sessionId).length, sent(b2.sessionId).length]).toEqual([1, 1]), { timeout: 3_000 });
    expect(sent(b1.sessionId)[0]).toContain('Do api');
    const first = await tool(b1.sessionId, missionId, 'builder', 'report_done', { summary: 'API limited', verification: ['npm test: pass'] });
    await settle(100);
    const second = await tool(b2.sessionId, missionId, 'builder', 'report_done', { summary: 'Docs written', verification: ['npm run lint: pass'] });
    expect([first.isError, second.isError]).toEqual([undefined, undefined]);
    await vi.waitFor(() => expect(sent(leadId)).toHaveLength(2), { timeout: 3_000 });
    await settle(debounce * 2);
    expect(sent(leadId)).toHaveLength(2);
    expect(sent(leadId)[1]).toContain('Builder 1 (b1) "api" reports done');
    expect(sent(leadId)[1]).toContain('Builder 2 (b2) "docs" reports done');
    const cards = await missionItems(leadId);
    expect(cards).toHaveLength(1);
    expect(cards[0].mission).toEqual({ kind: 'report' });
    expect([builderState(leadId, b1.builderId), builderState(leadId, b2.builderId)]).toEqual(['done', 'done']);
  });

  it('holds a question for a busy Lead until its turn ends; the asking Builder waits on the Lead', async () => {
    const s = await ordinary();
    const { leadId } = await service.start({ sessionId: s.id, input: { text: 'Refactor the cache' } });
    await vi.waitFor(() => expect(sent(leadId)).toHaveLength(1));
    const missionId = manager.get(leadId)!.mission!.missionId;
    // The Lead's first turn is still running while it starts a Builder.
    const b1 = await startBuilder(leadId, missionId, 'cache');
    await vi.waitFor(() => expect(sent(b1.sessionId)).toHaveLength(1));
    const asked = await tool(b1.sessionId, missionId, 'builder', 'ask_lead', { question: 'LRU or LFU?' });
    expect(asked.isError).toBeFalsy();
    expect(builderState(leadId, b1.builderId)).toBe('waiting_lead');
    expect(manager.get(b1.sessionId)!.mission?.builderState).toBe('waiting_lead');
    await settle();
    expect(sent(leadId)).toHaveLength(1);
    runtimeOf(leadId).finish();
    await vi.waitFor(() => expect(sent(leadId)).toHaveLength(2));
    expect(sent(leadId)[1]).toContain('LRU or LFU?');
    expect((await missionItems(leadId))[0].mission).toEqual({ kind: 'question', builderId: 'b1' });
  });

  it('tells the Lead when a Builder ends its turn without reporting', async () => {
    const { leadId, missionId } = await idleLead();
    const b1 = await startBuilder(leadId, missionId, 'api');
    await vi.waitFor(() => expect(sent(b1.sessionId)).toHaveLength(1));
    runtimeOf(b1.sessionId).ctx.emit({ type: 'item.upsert', item: { id: 'a1', kind: 'assistant', ts: Date.now(), text: 'I looked around.' } });
    runtimeOf(b1.sessionId).finish();
    await vi.waitFor(() => expect(sent(leadId)).toHaveLength(2));
    expect(sent(leadId)[1]).toMatch(/ended its turn without report_done[\s\S]*I looked around\./);
    expect(builderState(leadId, b1.builderId)).toBe('waiting_lead');
  });

  it('blocks message_builder after the third failed check until the user writes to the Lead', async () => {
    const { leadId, missionId } = await idleLead();
    const b1 = await startBuilder(leadId, missionId, 'api');
    for (let i = 0; i < 2; i++) expect((await tool(leadId, missionId, 'lead', 'record_check', { builderId: 'b1', passed: false })).isError).toBeFalsy();
    const third = await tool(leadId, missionId, 'lead', 'record_check', { builderId: 'b1', passed: false, note: 'still broken' });
    expect(third.text).toMatch(/ask the user/i);
    expect(service.get(leadId)).toMatchObject({ state: 'waiting_user', blockedOnUser: ['b1'] });
    const refused = await tool(leadId, missionId, 'lead', 'message_builder', { builderId: 'b1', text: 'Try again' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/after the user replies/);
    await manager.send(leadId, { text: 'Retry once more with the new API' });
    await vi.waitFor(() => expect(service.get(leadId)).toMatchObject({ state: 'running', blockedOnUser: [] }));
    const allowed = await tool(leadId, missionId, 'lead', 'message_builder', { builderId: 'b1', text: 'Try again' });
    expect(allowed.isError).toBeFalsy();
    expect(service.get(leadId)!.builders[0].failedChecks).toBe(3);
    expect(b1.builderId).toBe('b1');
  });
});

describe('Builder permission requests', () => {
  const options = [
    { id: 'allow', label: 'Allow', kind: 'allow' as const },
    { id: 'always', label: 'Always', kind: 'allow_always' as const },
    { id: 'deny', label: 'Deny', kind: 'deny' as const }
  ];

  async function builderAsks(command: string) {
    const { leadId, missionId } = await idleLead();
    const b1 = await startBuilder(leadId, missionId, 'api');
    await vi.waitFor(() => expect(sent(b1.sessionId)).toHaveLength(1));
    let decision: ApprovalDecision | undefined;
    const cwd = manager.get(leadId)!.cwd;
    void runtimeOf(b1.sessionId).ctx.requestApproval({ kind: 'command', title: `Run ${command}`, command, cwd, options }).then((d) => { decision = d; });
    await vi.waitFor(() => expect(sent(leadId)).toHaveLength(2));
    const requestId = /Request id: (\S+)/.exec(sent(leadId)[1])?.[1];
    expect(requestId).toBeTruthy();
    return { leadId, missionId, b1, requestId: requestId!, decision: () => decision };
  }

  it('runs a request confined to the mission once the Lead allows it, without asking the user', async () => {
    const { leadId, missionId, b1, requestId, decision } = await builderAsks('rm -rf build');
    expect(sent(leadId)[1]).toContain('The Builder waits for you');
    expect(approvalNotices()).toHaveLength(0);
    const answered = await tool(leadId, missionId, 'lead', 'answer_request', { requestId, decision: 'allow' });
    expect(answered.isError).toBeFalsy();
    await vi.waitFor(() => expect(decision()).toEqual({ optionId: 'allow' }));
    const card = (await manager.transcript(b1.sessionId)).find((i) => i.kind === 'approval' && i.id === requestId);
    expect(card).toMatchObject({ decidedBy: 'lead', request: { mission: { route: 'lead', status: 'with_lead' } } });
    expect(approvalNotices()).toHaveLength(0);
  });

  it('keeps a publish request with the user: the Lead’s allow is only a recommendation', async () => {
    const { leadId, missionId, b1, requestId, decision } = await builderAsks('git push origin HEAD');
    expect(approvalNotices()).toHaveLength(1);
    expect(sent(leadId)[1]).toContain('Only the user can approve this');
    const answered = await tool(leadId, missionId, 'lead', 'answer_request', { requestId, decision: 'allow', note: 'Needed for the release check' });
    expect(answered.isError).toBeFalsy();
    await settle();
    expect(decision()).toBeUndefined();
    expect(approvalNotices()).toHaveLength(1);
    const card = (await manager.transcript(b1.sessionId)).find((i) => i.kind === 'approval' && i.id === requestId);
    expect(card).toMatchObject({ request: { mission: { route: 'user', status: 'with_user', recommendation: { verdict: 'allow', note: 'Needed for the release check' } } } });
    expect(card && 'decision' in card ? card.decision : undefined).toBeUndefined();
    const mirror = (await manager.transcript(leadId)).find((i) => i.kind === 'approval' && i.id === requestId);
    expect(mirror).toMatchObject({ request: { sessionId: b1.sessionId, mission: { recommendation: { verdict: 'allow' } } } });
    expect(service.get(leadId)!.state).toBe('waiting_user');
    // The user answers on the mirrored card: the Builder's request is the one that resolves.
    await manager.respondApproval(b1.sessionId, requestId, { optionId: 'deny' });
    await vi.waitFor(() => expect(decision()).toEqual({ optionId: 'deny' }));
    await vi.waitFor(async () => expect((await manager.transcript(leadId)).find((i) => i.kind === 'approval' && i.id === requestId)).toMatchObject({ decision: { optionId: 'deny' }, decidedBy: 'user', decidedAt: expect.any(Number) }));
    await vi.waitFor(() => expect(service.get(leadId)!.state).toBe('running'));
  });
});

describe('restart and persistence', () => {
  it('comes back interrupted without dispatching anything, and Resume sends one message naming each Builder', async () => {
    const { leadId, missionId } = await idleLead();
    const b1 = await startBuilder(leadId, missionId, 'api');
    const b2 = await startBuilder(leadId, missionId, 'docs', true);
    await vi.waitFor(() => expect([sent(b1.sessionId).length, sent(b2.sessionId).length]).toEqual([1, 1]));
    const b2Branch = manager.get(b2.sessionId)!.worktreeBranch!;
    expect(b2Branch).toMatch(/^mission\/.+-b2$/);
    // Quit: the service stops listening first, then the sessions stop.
    service.dispose();
    await manager.stopAll();
    await manager.flushPendingPersists();

    const reloaded = new SessionStore(userData);
    await reloaded.load();
    vi.mocked(createAdapter).mockClear();
    runtimes = [];
    ({ mgr: manager, svc: service } = boot(reloaded));
    store = reloaded;
    await service.recover();
    expect(service.get(leadId)).toMatchObject({ state: 'interrupted' });
    expect(service.get(leadId)!.builders.map((b) => b.state)).toEqual(['stopped', 'stopped']);
    expect(manager.get(leadId)!.mission?.state).toBe('interrupted');
    expect(manager.get(b1.sessionId)!.mission?.builderState).toBe('stopped');
    expect((await record(leadId)).state).toBe('interrupted');
    expect(service.identity(leadId)).toEqual({ missionId, role: 'lead' });
    expect(service.identity(b1.sessionId)).toBeNull();
    await settle();
    expect(createAdapter).not.toHaveBeenCalled();

    await service.resume(leadId);
    expect(sent(leadId)).toHaveLength(1);
    expect(sent(leadId)[0]).toContain('Builder 1 "api" (b1): was working; shares your worktree.');
    expect(sent(leadId)[0]).toContain(`Builder 2 "docs" (b2): was working; own worktree on \`${b2Branch}\`, not landed.`);
    expect((await missionItems(leadId)).map((i) => i.mission)).toEqual([{ kind: 'resume' }]);
    expect(service.get(leadId)!.state).toBe('running');
    await settle();
    expect(sent(leadId)).toHaveLength(1);
    expect(vi.mocked(createAdapter).mock.calls.map(([, ctx]) => ctx.sessionId)).toEqual([leadId]);
    await expect(service.resume(leadId)).rejects.toThrow(/Only an interrupted mission/);
  });

  it('recovers every other mission when one of them fails to load', async () => {
    const first = await idleLead('Add a rate limiter to the API');
    const second = await idleLead('Write the release notes');
    service.dispose();
    await manager.stopAll();
    await manager.flushPendingPersists();
    const reloaded = new SessionStore(userData);
    await reloaded.load();
    vi.mocked(createAdapter).mockClear();
    runtimes = [];
    ({ mgr: manager, svc: service } = boot(reloaded));
    store = reloaded;
    // The first mission recovered hits a failure while its rows are updated.
    vi.spyOn(manager, 'setMission').mockImplementationOnce(() => { throw new Error('injected row failure'); });
    await expect(service.recover()).resolves.toBeUndefined();
    expect([first, second].map(({ leadId }) => service.get(leadId)?.state)).toEqual(['interrupted', 'interrupted']);
    await settle();
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('runs at startup only once the session-list push fan-out exists', () => {
    // recover() updates the Lead and Builder rows (setMission), which pushes the session list
    // through index.ts's fan-out. Declared after recovery, that first push threw: recovery stopped
    // after one mission, whose sessions were never indexed, so their events were dropped.
    const source = readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const fanOut = source.indexOf('const pushAll = ');
    const recovery = source.indexOf('missionRef.recover()');
    expect(fanOut, 'index.ts must declare the push fan-out').toBeGreaterThan(-1);
    expect(recovery, 'index.ts must recover the missions at startup').toBeGreaterThan(-1);
    expect(fanOut).toBeLessThan(recovery);
  });

  it('leaves the mission unchanged and reports it when the record cannot be written', async () => {
    const { leadId, missionId } = await idleLead();
    const b1 = await startBuilder(leadId, missionId, 'api');
    await vi.waitFor(() => expect(sent(b1.sessionId)).toHaveLength(1));
    disk.failMission = true;
    const check = await tool(leadId, missionId, 'lead', 'record_check', { builderId: 'b1', passed: false });
    expect(check).toMatchObject({ isError: true });
    expect(check.text).toMatch(/could not be saved.*nothing changed/);
    const asked = await tool(b1.sessionId, missionId, 'builder', 'ask_lead', { question: 'Which header?' });
    expect(asked).toMatchObject({ isError: true });
    expect(service.get(leadId)!.builders[0]).toMatchObject({ state: 'working', failedChecks: 0 });
    expect(manager.get(b1.sessionId)!.mission?.builderState).toBe('working');
    await settle();
    expect(sent(leadId)).toHaveLength(1);
    disk.failMission = false;
    expect((await tool(leadId, missionId, 'lead', 'record_check', { builderId: 'b1', passed: false })).isError).toBeFalsy();
    expect(service.get(leadId)!.builders[0].failedChecks).toBe(1);
    expect((await record(leadId)).builders[0].failedChecks).toBe(1);
  });
});

describe('finishing without a remote', () => {
  it('ends on the local branch with the report, reported to the Lead once it is idle', async () => {
    const { leadId, missionId } = await idleLead();
    const result = await tool(leadId, missionId, 'lead', 'finish_mission', { task: 'Add a rate limiter', done: ['Limiter'], decisions: [], files: ['src/limit.ts'], verification: ['npm test: pass'] });
    expect(result.isError).toBeFalsy();
    expect(result.text).toMatch(/^Finishing/);
    await vi.waitFor(() => expect(service.get(leadId)!.state).toBe('done_local'));
    await vi.waitFor(() => expect(sent(leadId)).toHaveLength(2));
    expect(sent(leadId)[1]).toMatch(/No PR was opened: There is no origin remote/);
    expect((await record(leadId)).report).toContain('## Task');
    expect(existsSync(manager.get(leadId)!.cwd)).toBe(true);
  });
});
