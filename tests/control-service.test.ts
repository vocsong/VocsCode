import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CONTROL_RETRY_GRACE_MS, ControlJournal } from '../src/main/control/journal';
import { CONTROL_OPEN_WINDOWS_PER_CONTROLLER, CONTROL_OPERATIONS_PER_CONTROLLER, ControlService } from '../src/main/control/service';
import type { ControlResourceGuard } from '../src/main/control/workspace';
import { MissionStore, type MissionState } from '../src/main/mission/store';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred } from '../src/main/util/async';
import { writeJson } from '../src/main/util/fs';
import { CONTROL_SCOPES, type ControllerPrincipal, type ControlOperation, type ControlGrantInput } from '../src/shared/control';
import type { SessionManager } from '../src/main/session-manager';
import type { SessionMeta } from '../src/shared/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

type DiscoveryMethod = 'projects.list' | 'sessions.list' | 'sessions.get';

async function fixture(persist = writeJson, workspaceRevision = () => 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-control-'));
  roots.push(root);
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const settings = defaultSettings();
  settings.folders = [project]; settings.defaultHarness = 'native'; settings.defaultPermissionMode = 'ask';
  const meta: SessionMeta = { id: 's_test', title: 'A session', createdAt: 1, updatedAt: 1, config: { harness: 'native', permissionMode: 'ask', projectRoot: project }, cwd: project, status: 'idle', harnessRef: {}, usage: emptyUsage() };
  let now = Date.now();
  const principal: ControllerPrincipal = { accountId: 'vocs-v1', controllerId: randomUUID(), scopes: [...CONTROL_SCOPES], validUntil: now + 30_000 };
  const journal = new ControlJournal(root, persist, () => now);
  await journal.load();
  const dispatch = vi.fn();
  const start = vi.fn();
  const runControlled = vi.fn(async (_id: string, _input: unknown, context: { inputId: string; beforeStart(): Promise<void>; beforeDispatch(): Promise<void> }) => {
    await context.beforeStart(); start(); await context.beforeDispatch(); dispatch();
    return { outcome: 'succeeded' as const, inputId: context.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: ['answer'] };
  });
  const createControlled = vi.fn(async () => meta);
  const interruptControlled = vi.fn();
  const transcript = vi.fn(async () => [
    { kind: 'assistant', id: 'answer', ts: 1, text: 'hello' },
    { kind: 'approval', id: 'secret', ts: 2, request: { questions: [{ secret: true, question: 'secret question content' }] } },
  ]);
  const rows = [meta];
  const list = vi.fn<SessionManager['list']>(() => rows);
  const sessions = { list, get: (id: string) => rows.find((row) => id === row.id), runControlled, createControlled, interruptControlled, transcript } as unknown as SessionManager;
  const guard = vi.fn<ControlResourceGuard>(async () => undefined);
  const service = new ControlService({ journal, sessions, settings: () => settings, guard, workspaceRevision, now: () => now });
  const state = await service.ownerState();
  const projectId = state.projects[0]!.id;
  const grant: ControlGrantInput = { accountId: principal.accountId, controllerId: principal.controllerId, name: 'Test controller', projectIds: [projectId], scopes: [...CONTROL_SCOPES], permissionModes: ['ask'], harnesses: ['native'], expiresAt: now + 10_000_000 };
  await service.grant(grant);
  await service.setEnabled(true);
  const window = await service.handle(principal, { method: 'windows.create', params: { instanceId: state.instanceId } }) as { admissionWindowId: string };
  const params = { instanceId: state.instanceId, projectId, sessionId: meta.id, admissionWindowId: window.admissionWindowId, idempotencyKey: 'same-intent', text: 'unique-prompt-content' };
  const discover = (method: DiscoveryMethod) => service.handle(principal, { method, params: {
    instanceId: state.instanceId, ...(method !== 'projects.list' && { projectId }), ...(method === 'sessions.get' && { sessionId: meta.id }),
  } });
  return { root, project, settings, meta, rows, list, principal, journal, dispatch, start, runControlled, createControlled, interruptControlled, transcript, sessions, guard, service, state, projectId, grant, params, discover,
    advance(ms: number) { now += ms; principal.validUntil = now + 30_000; } };
}

async function duringDiscovery(f: Awaited<ReturnType<typeof fixture>>, method: DiscoveryMethod, change: () => Promise<void>,
  matches: (resource: Parameters<ControlResourceGuard>[0]) => boolean = (resource) => method === 'projects.list' ? !!resource.projectRoot : !!resource.sessionId,
) {
  const entered = deferred<void>(), resume = deferred<void>();
  const guard = f.guard.getMockImplementation()!;
  let paused = false;
  f.guard.mockImplementation(async (resource) => {
    await guard(resource);
    if (paused || !matches(resource)) return;
    paused = true;
    entered.resolve();
    await resume.promise;
  });
  const result = f.discover(method).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await Promise.race([entered.promise, result.then(() => { throw new Error('Discovery finished before reaching the selected guard'); })]);
    await change();
  } finally {
    resume.resolve();
    await result;
    f.guard.mockImplementation(guard);
  }
  return result;
}

it('returns the existing discovery metadata without scheduling Git refreshes or writing the control journal', async () => {
  const f = await fixture();
  f.list.mockClear();
  const transaction = vi.spyOn(f.journal, 'transaction');
  const summary = { id: f.meta.id, title: f.meta.title, status: 'idle', harness: 'native', permissionMode: 'ask', model: undefined, ownerActionNeeded: false };
  await expect(f.discover('projects.list')).resolves.toEqual({ items: [{ id: f.projectId, name: 'project' }], nextOffset: null });
  await expect(f.discover('sessions.list')).resolves.toStrictEqual({ items: [summary], nextOffset: null });
  await expect(f.discover('sessions.get')).resolves.toStrictEqual(summary);
  expect(f.list.mock.calls).toEqual([[{ refreshGit: false }]]);
  expect(transaction).not.toHaveBeenCalled();
});

it.each([
  ['projects.list', 'revoke'], ['projects.list', 'regrant'], ['sessions.list', 'revoke'],
  ['sessions.list', 'disable and reenable'], ['sessions.get', 'regrant'],
] as const)('denies in-flight %s after desktop %s', async (method, action) => {
  const f = await fixture();
  const result = await duringDiscovery(f, method, async () => {
    if (action === 'disable and reenable') {
      await f.service.setEnabled(false);
      await f.service.setEnabled(true);
    } else {
      await f.service.revoke(f.journal.snapshot().grants[0]!.id);
      if (action === 'regrant') await f.service.grant(f.grant);
    }
  });
  expect(result).toMatchObject({ error: { code: 'denied' } });
  if (action !== 'revoke') await expect(f.discover(method)).resolves.toBeDefined();
});

it.each(['moved', 'was replaced'] as const)('filters an earlier checked session that %s during a later session guard', async (change) => {
  const f = await fixture();
  const later = { ...structuredClone(f.meta), id: 's_later' };
  f.rows.push(later);
  const result = await duringDiscovery(f, 'sessions.list', async () => {
    if (change === 'moved') {
      const outside = path.join(f.root, 'outside');
      await fs.mkdir(outside);
      f.meta.cwd = outside;
    } else f.rows[0] = { ...f.meta, createdAt: f.meta.createdAt + 1 };
  }, ({ sessionId }) => sessionId === later.id);
  expect(result).toEqual({ value: { items: [expect.objectContaining({ id: later.id })], nextOffset: null } });
});

it.each(['projects.list', 'sessions.list', 'sessions.get'] as const)('does not publish %s for a directory replaced during its guard', async (method) => {
  const f = await fixture();
  const directory = method === 'projects.list' ? f.project : path.join(f.project, 'worktree');
  if (method !== 'projects.list') { await fs.mkdir(directory); f.meta.cwd = directory; }
  const result = await duringDiscovery(f, method, async () => {
    await fs.rename(directory, `${directory}-previous`);
    await fs.mkdir(directory);
  });
  if (method === 'sessions.get') expect(result).toMatchObject({ error: { code: 'denied' } });
  else expect(result).toEqual({ value: { items: [], nextOffset: null } });
});

it.each(['projects.list', 'sessions.list', 'sessions.get'] as const)('denies %s across Mission ownership publication even if snapshotting fails', async (method) => {
  type OwnershipState = MissionState & { owned: boolean };
  let journal: MissionStore<OwnershipState> | undefined;
  const f = await fixture(writeJson, () => journal?.publicationRevision ?? 0);
  const store = journal = new MissionStore<OwnershipState>(f.root, { validate: () => true, snapshotEvery: 1 });
  const id = 'mission-test';
  await store.create({ id, schemaVersion: 1, revision: 0, lastEventSequence: 0, owned: false }, {
    actor: 'user:test', expectedRevision: 0, idempotencyKey: 'create', kind: 'create',
  });
  f.guard.mockImplementation(async ({ projectRoot, sessionId }) => {
    const resource = method === 'projects.list' ? projectRoot === f.state.projects[0]!.canonicalRoot : sessionId === f.meta.id;
    if (resource && store.get(id)?.owned) throw new Error('Mission-owned resource');
  });
  const result = await duringDiscovery(f, method, async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected snapshot failure'));
    try {
      await expect(store.transact(id, { actor: 'user:test', expectedRevision: 1, idempotencyKey: 'own', kind: 'own' }, (draft) => {
        draft.owned = true;
      })).rejects.toMatchObject({ code: 'BLOCKED' });
      expect(store.get(id)?.owned).toBe(true);
    } finally { rename.mockRestore(); }
  });
  expect(result).toMatchObject({ error: { code: 'denied' } });
  if (method === 'sessions.get') await expect(f.discover(method)).rejects.toMatchObject({ code: 'denied' });
  else await expect(f.discover(method)).resolves.toEqual({ items: [], nextOffset: null });
});

it('deduplicates concurrent mutation requests and commits one receipt/event sequence without prompt content', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.service.handle(f.principal, { method: 'sessions.send', params: f.params }), f.service.handle(f.principal, { method: 'sessions.send', params: f.params })]) as ControlOperation[];
  expect(a!.id).toBe(b!.id);
  await f.service.settle();
  expect(f.runControlled).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.journal.snapshot().operations).toHaveLength(1);
  expect(f.journal.snapshot().operations[0]).toMatchObject({ state: 'succeeded', outputIds: ['answer'], turnId: 'turn' });
  expect(f.journal.snapshot().events.map((e) => e.state)).toEqual(['accepted', 'dispatched', 'succeeded']);
  expect(await fs.readFile(f.journal.file, 'utf8')).not.toContain('unique-prompt-content');
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: { ...f.params, text: 'different' } })).rejects.toMatchObject({ code: 'conflict' });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it('does not dispatch invalid, cross-instance, cross-controller, ungranted or escalated requests', async () => {
  const f = await fixture();
  for (const [principal, params] of [
    [f.principal, { ...f.params, mode: 'steer' }],
    [f.principal, { ...f.params, instanceId: randomUUID() }],
    [{ ...f.principal, accountId: 'github:123' }, f.params],
    [{ ...f.principal, controllerId: randomUUID() }, f.params],
    [{ ...f.principal, scopes: ['control:discover'] }, f.params],
    [{ ...f.principal, validUntil: f.principal.validUntil - 30_001 }, f.params],
    [f.principal, { ...f.params, projectId: 'other' }],
    [f.principal, { ...f.params, sessionId: '../secret' }],
  ]) await expect(f.service.handle(principal, { method: 'sessions.send', params })).rejects.toBeDefined();
  f.meta.config.permissionMode = 'full-auto';
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).rejects.toMatchObject({ code: 'denied' });
  expect(f.runControlled).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.journal.snapshot().operations).toHaveLength(0);
});

it('rechecks local revocation after runtime preparation and never dispatches the admitted input', async () => {
  const f = await fixture();
  let ready!: () => void;
  const wait = new Promise<void>((resolve) => { ready = resolve; });
  f.runControlled.mockImplementationOnce(async (_id, _input, control) => {
    await wait;
    await control.beforeDispatch();
    f.dispatch();
    return { outcome: 'succeeded', inputId: control.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: [] };
  });
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  await f.service.revoke(f.journal.snapshot().grants[0]!.id);
  ready(); await f.service.settle();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.journal.snapshot().operations[0]!.state).toBe('failed');
});

it.each(['revoke and regrant', 'disable and reenable', 'replace grant'] as const)('never revives admitted work after %s', async (action) => {
  const f = await fixture();
  let ready!: () => void;
  const wait = new Promise<void>((resolve) => { ready = resolve; });
  f.runControlled.mockImplementationOnce(async (_id, _input, control) => {
    await wait;
    await control.beforeDispatch();
    f.dispatch();
    return { outcome: 'succeeded', inputId: control.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: [] };
  });
  const receipt = await f.service.handle(f.principal, { method: 'sessions.send', params: f.params }) as ControlOperation;
  try {
    if (action === 'disable and reenable') {
      await f.service.setEnabled(false);
      await f.service.setEnabled(true);
    } else {
      if (action === 'revoke and regrant') await f.service.revoke(f.journal.snapshot().grants[0]!.id);
      await f.service.grant(f.grant);
    }
  } finally { ready(); await f.service.settle(); }
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.journal.snapshot().operations).toEqual([expect.objectContaining({ id: receipt.id, state: 'failed' })]);
  expect(f.journal.snapshot().events.map((event) => event.state)).toEqual(['accepted', 'failed']);
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).resolves.toMatchObject({ id: receipt.id, state: 'failed' });
  expect(f.runControlled).toHaveBeenCalledTimes(1);
  const recovered = new ControlJournal(f.root); await recovered.load();
  expect(recovered.snapshot().operations[0]).toMatchObject({ id: receipt.id, state: 'failed' });
});

it('does not create using a captured configuration after the owner narrows its grant', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  f.guard.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { entered(); await wait; });
  const { sessionId: _id, text: _text, ...params } = f.params;
  await f.service.handle(f.principal, { method: 'sessions.create', params });
  await paused;
  try { await f.service.grant({ ...f.grant, harnesses: ['pi'] }); }
  finally { release(); await f.service.settle(); }
  expect(f.createControlled).not.toHaveBeenCalled();
  expect(f.journal.snapshot().operations.map((op) => op.state)).toEqual(['failed']);
  expect(f.journal.snapshot().events.map((event) => event.state)).toEqual(['accepted', 'failed']);
});

it('does not cancel pending work for another controller or a previously revoked grant', async () => {
  const f = await fixture();
  const oldGrantId = f.journal.snapshot().grants[0]!.id;
  await f.service.grant(f.grant);
  const other = { ...f.grant, controllerId: randomUUID() };
  await f.service.grant(other);
  let ready!: () => void;
  const wait = new Promise<void>((resolve) => { ready = resolve; });
  f.runControlled.mockImplementationOnce(async (_id, _input, control) => {
    await wait; await control.beforeDispatch(); f.dispatch();
    return { outcome: 'succeeded', inputId: control.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: [] };
  });
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  try {
    await f.service.revoke(oldGrantId);
    await f.service.revoke(f.journal.snapshot().grants.find((grant) => grant.controllerId === other.controllerId)!.id);
    expect(f.journal.snapshot().operations[0]!.state).toBe('accepted');
  } finally { ready(); await f.service.settle(); }
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.journal.snapshot().operations[0]!.state).toBe('succeeded');
});

it('keeps already-dispatched work and its terminal evidence when authority is withdrawn', async () => {
  const f = await fixture();
  let ready!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { ready = resolve; });
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  f.runControlled.mockImplementationOnce(async (_id, _input, control) => {
    await control.beforeDispatch(); f.dispatch(); entered(); await wait;
    return { outcome: 'succeeded', inputId: control.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: ['answer'] };
  });
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  await dispatched;
  try {
    await f.service.revoke(f.journal.snapshot().grants[0]!.id);
    await f.service.setEnabled(false);
    expect(f.journal.snapshot().operations[0]!.state).toBe('dispatched');
    expect(f.interruptControlled).not.toHaveBeenCalled();
  } finally { ready(); await f.service.settle(); }
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.journal.snapshot().operations[0]).toMatchObject({ state: 'succeeded', outputIds: ['answer'] });
  expect(f.journal.snapshot().events.map((event) => event.state)).toEqual(['accepted', 'dispatched', 'succeeded']);
});

it('serializes runtime failure with a revocation commit without falsely disabling control', async () => {
  let pause = false, saving!: () => void, save!: () => void, failRuntime!: () => void;
  const savingStarted = new Promise<void>((resolve) => { saving = resolve; });
  const saveGate = new Promise<void>((resolve) => { save = resolve; });
  const runtimeGate = new Promise<void>((resolve) => { failRuntime = resolve; });
  const f = await fixture(async (file, data) => {
    if (pause) { pause = false; saving(); await saveGate; }
    await writeJson(file, data);
  });
  f.runControlled.mockImplementationOnce(async () => { await runtimeGate; throw new Error('runtime preparation failed'); });
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  const transaction = vi.spyOn(f.journal, 'transaction');
  pause = true;
  const revoking = f.service.revoke(f.journal.snapshot().grants[0]!.id).then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await savingStarted;
    failRuntime();
    await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(2));
  } finally { save(); failRuntime(); await f.service.settle(); }
  expect(await revoking).not.toHaveProperty('error');
  await expect(f.service.ownerState()).resolves.toMatchObject({ enabled: true });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.journal.snapshot().operations[0]!.state).toBe('failed');
  expect(f.journal.snapshot().events.map((event) => event.state)).toEqual(['accepted', 'failed']);
});

it('commits cancellation and revocation together or neither on storage failure', async () => {
  let fail = false;
  const f = await fixture(async (file, data) => { if (fail) throw new Error('disk full'); await writeJson(file, data); });
  let ready!: () => void;
  const wait = new Promise<void>((resolve) => { ready = resolve; });
  f.runControlled.mockImplementationOnce(async (_id, _input, control) => {
    await wait; await control.beforeDispatch(); f.dispatch();
    return { outcome: 'succeeded', inputId: control.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: [] };
  });
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  const before = f.journal.snapshot();
  const durableBefore = await fs.readFile(f.journal.file, 'utf8');
  try {
    fail = true;
    await expect(f.service.revoke(before.grants[0]!.id)).rejects.toMatchObject({ code: 'storage_unavailable' });
    expect(f.journal.snapshot()).toEqual(before);
    expect(await fs.readFile(f.journal.file, 'utf8')).toBe(durableBefore);
    fail = false;
    await f.service.revoke(before.grants[0]!.id);
  } finally { fail = false; ready(); await f.service.settle(); }
  expect(f.dispatch).not.toHaveBeenCalled();
  const recovered = new ControlJournal(f.root); await recovered.load();
  expect(recovered.snapshot().grants[0]!.revokedAt).toBeDefined();
  expect(recovered.snapshot().operations[0]!.state).toBe('failed');
});

it('remains usable when canceled preparation finishes after its receipt was safely pruned', async () => {
  const f = await fixture();
  let ready!: () => void;
  const wait = new Promise<void>((resolve) => { ready = resolve; });
  f.runControlled.mockImplementationOnce(async (_id, _input, control) => {
    await wait; await control.beforeDispatch(); f.dispatch();
    return { outcome: 'succeeded', inputId: control.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: [] };
  });
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  try {
    await f.service.revoke(f.journal.snapshot().grants[0]!.id);
    f.advance(3_600_001 + CONTROL_RETRY_GRACE_MS);
    await f.service.grant({ ...f.grant, expiresAt: f.principal.validUntil + 60_000 });
    expect(f.journal.snapshot().operations).toHaveLength(0);
  } finally { ready(); await f.service.settle(); }
  expect(f.dispatch).not.toHaveBeenCalled();
  await expect(f.service.handle(f.principal, { method: 'capabilities', params: {} })).resolves.toMatchObject({ instanceId: f.state.instanceId });
});

it('keeps retry receipts through expiry plus grace, then refuses late retries without replay', async () => {
  const f = await fixture();
  await f.service.grant({ ...f.grant, expiresAt: Date.now() + 3 * CONTROL_RETRY_GRACE_MS });
  const receipt = await f.service.handle(f.principal, { method: 'sessions.send', params: f.params }) as ControlOperation;
  await f.service.settle();
  f.advance(3_600_001);
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).resolves.toMatchObject({ id: receipt.id, state: 'succeeded' });
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: { ...f.params, idempotencyKey: 'new' } })).rejects.toMatchObject({ code: 'expired' });
  expect(f.journal.snapshot().operations).toHaveLength(1);
  f.advance(CONTROL_RETRY_GRACE_MS);
  await f.service.setEnabled(true); // A successful transaction commits eligible retention cleanup.
  expect(f.journal.snapshot().operations).toHaveLength(0);
  expect(f.journal.snapshot().events).toHaveLength(0);
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).rejects.toMatchObject({ code: 'expired' });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it('separates transcript permission and withholds secret/approval groups entirely', async () => {
  const f = await fixture();
  const params = { instanceId: f.state.instanceId, projectId: f.projectId, sessionId: f.meta.id };
  await expect(f.service.handle({ ...f.principal, scopes: ['control:discover'] }, { method: 'sessions.transcript', params })).rejects.toMatchObject({ code: 'denied' });
  expect(f.transcript).not.toHaveBeenCalled();
  const result = await f.service.handle(f.principal, { method: 'sessions.transcript', params });
  expect(JSON.stringify(result)).toContain('hello');
  expect(JSON.stringify(result)).not.toContain('secret question content');
  await expect(f.service.handle(f.principal, { method: 'approval.resolve', params: {} })).rejects.toBeDefined();
});

it('withholds the tool call that carried an owner-only question and its answer, on any page', async () => {
  const f = await fixture();
  const answer = 'owner-typed-answer';
  f.transcript.mockImplementation(async () => [
    { kind: 'tool', id: 'question-call', ts: 1, name: 'ask_user', input: { question: 'Which account?' }, output: answer, status: 'done' },
    { kind: 'tool', id: 'ordinary-call', ts: 2, name: 'bash', input: { command: 'npm test' }, output: 'tests passed', status: 'done' },
    { kind: 'approval', id: 'bash-card', ts: 3, request: { kind: 'command', toolItemId: 'ordinary-call', options: [] }, decision: { optionId: 'allow' } },
    { kind: 'approval', id: 'question-card', ts: 4, request: { kind: 'question', toolItemId: 'question-call', questions: [{ id: 'q', question: 'Which account?' }] }, decision: { optionId: 'allow', answers: { q: answer } } },
  ] as never);
  const params = { instanceId: f.state.instanceId, projectId: f.projectId, sessionId: f.meta.id };
  // The tool call is on the first page; the card that makes it owner-only is on the next.
  const first = await f.service.handle(f.principal, { method: 'sessions.transcript', params: { ...params, limit: 2 } }) as { items: Array<{ id: string; kind: string; output?: string }> };
  const second = await f.service.handle(f.principal, { method: 'sessions.transcript', params: { ...params, offset: 2, limit: 2 } });
  expect(JSON.stringify([first, second])).not.toContain(answer);
  expect(first.items[0]).toMatchObject({ id: 'question-call', kind: 'info' });
  // An ordinary approved tool call stays readable; only its approval card is replaced.
  expect(first.items[1]).toMatchObject({ id: 'ordinary-call', kind: 'tool', output: 'tests passed' });
});

it.each(['workspace', 'permission mode'] as const)('rechecks the session %s after reading its transcript', async (change) => {
  const f = await fixture();
  const outside = path.join(f.root, 'other');
  await fs.mkdir(outside);
  f.transcript.mockImplementationOnce(async () => {
    if (change === 'workspace') f.meta.cwd = outside;
    else f.meta.config.permissionMode = 'full-auto';
    return [{ kind: 'assistant', id: 'answer', ts: 1, text: 'must not escape the old grant' }];
  });
  await expect(f.service.handle(f.principal, { method: 'sessions.transcript', params: { instanceId: f.state.instanceId, projectId: f.projectId, sessionId: f.meta.id } })).rejects.toMatchObject({ code: 'denied' });
  expect(f.transcript).toHaveBeenCalledTimes(1);
});

it('rejects replaced project roots and managed aliases before privileged calls', async () => {
  const f = await fixture();
  f.guard.mockRejectedValueOnce(new Error('Mission-owned'));
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).rejects.toBeDefined();
  await fs.rename(f.project, `${f.project}-old`); await fs.mkdir(f.project);
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.runControlled).not.toHaveBeenCalled();
});

it.each(['outside', 'prefix sibling', 'junction escape'] as const)('refuses a moved workspace (%s) under its old project grant', async (kind) => {
  const f = await fixture();
  const outside = kind === 'prefix sibling' ? `${f.project}-other` : path.join(f.root, 'other');
  await fs.mkdir(outside);
  f.meta.cwd = outside; // moveTo deliberately retains config.projectRoot when switching directories.
  if (kind === 'junction escape') {
    f.meta.cwd = path.join(f.project, 'redirected');
    await fs.symlink(outside, f.meta.cwd, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const params = { instanceId: f.state.instanceId, projectId: f.projectId, sessionId: f.meta.id };
  await expect(f.service.handle(f.principal, { method: 'sessions.list', params: { instanceId: f.state.instanceId, projectId: f.projectId } })).resolves.toEqual({ items: [], nextOffset: null });
  for (const method of ['sessions.get', 'sessions.transcript'] as const) {
    await expect(f.service.handle(f.principal, { method, params })).rejects.toMatchObject({ code: 'denied' });
  }
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).rejects.toMatchObject({ code: 'denied' });
  expect(f.runControlled).not.toHaveBeenCalled();
  expect(f.transcript).not.toHaveBeenCalled();
  expect(f.journal.snapshot().operations).toHaveLength(0);
});

it('continues to authorize ordinary sessions in app-managed project worktrees', async () => {
  const f = await fixture();
  f.meta.cwd = path.join(f.project, '.vocs-code', 'worktrees', 'topic');
  await fs.mkdir(f.meta.cwd, { recursive: true });
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  await f.service.settle();
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  expect(f.journal.snapshot().operations[0]!.state).toBe('succeeded');
});

it('inherits project defaults and rejects unapproved creation modes rather than widening them', async () => {
  const f = await fixture();
  f.settings.folderSessionDefaults = { [f.project]: { harness: 'native', permissionMode: 'ask', useWorktree: false, modelByHarness: { native: { provider: 'p', model: 'm' } } } };
  const { sessionId: _id, text: _text, ...params } = f.params;
  await f.service.handle(f.principal, { method: 'sessions.create', params }); await f.service.settle();
  expect(f.createControlled).toHaveBeenCalledTimes(1);
  expect(f.createControlled.mock.calls[0]).toEqual([{ config: expect.objectContaining({ harness: 'native', permissionMode: 'ask', useWorktree: false, model: { provider: 'p', model: 'm' } }) }, expect.any(String), await fs.realpath(f.project)]);
  f.settings.folderSessionDefaults[f.project]!.permissionMode = 'full-auto';
  await f.service.handle(f.principal, { method: 'sessions.create', params: { ...params, idempotencyKey: 'other' } }); await f.service.settle();
  expect(f.createControlled).toHaveBeenCalledTimes(1);
  expect(f.journal.snapshot().operations.map((op) => op.state)).toEqual(['succeeded', 'failed']);
});

it('creates a remote Cursor session in a tier Cursor offers, never an unsandboxed Ask', async () => {
  const f = await fixture();
  f.settings.defaultHarness = 'cursor';
  await f.service.grant({ ...f.grant, harnesses: ['cursor'], permissionModes: ['ask', 'plan'] });
  const { sessionId: _id, text: _text, ...params } = f.params;
  await f.service.handle(f.principal, { method: 'sessions.create', params }); await f.service.settle();
  expect(f.createControlled).toHaveBeenCalledTimes(1);
  expect(f.createControlled.mock.calls[0]).toEqual([{ config: expect.objectContaining({ harness: 'cursor', permissionMode: 'plan' }) }, expect.any(String), await fs.realpath(f.project)]);
  // A grant that only allows the requested Ask no longer matches the tier Cursor would run.
  await f.service.grant({ ...f.grant, harnesses: ['cursor'], permissionModes: ['ask'] });
  await f.service.handle(f.principal, { method: 'sessions.create', params: { ...params, idempotencyKey: 'ask-only' } }); await f.service.settle();
  expect(f.createControlled).toHaveBeenCalledTimes(1);
  expect(f.journal.snapshot().operations.map((op) => op.state)).toEqual(['succeeded', 'failed']);
});

it('persists authority only after a successful write and fails closed on corrupt journal reads', async () => {
  const f = await fixture();
  let fail = false;
  const journal = new ControlJournal(path.join(f.root, 'failure'), async (file, data) => { if (fail) throw new Error('disk full'); await writeJson(file, data); });
  await journal.load();
  fail = true;
  await expect(journal.transaction((s) => { s.enabled = true; })).rejects.toMatchObject({ code: 'storage_unavailable' });
  expect(journal.snapshot().enabled).toBe(false);
  const recovered = new ControlJournal(path.join(f.root, 'failure')); await recovered.load();
  expect(recovered.snapshot().enabled).toBe(false);
  await fs.writeFile(journal.file, '{ corrupt');
  const corrupt = new ControlJournal(path.join(f.root, 'failure'));
  await expect(corrupt.load()).rejects.toMatchObject({ code: 'storage_unavailable' });
  expect(() => corrupt.snapshot()).toThrow('storage_unavailable');
});

it('marks nonterminal restart work unknown, keeps completed receipts immutable, and never replays', async () => {
  const f = await fixture();
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params }); await f.service.settle();
  const complete = f.journal.snapshot().operations[0]!;
  await f.journal.transaction((s) => { s.operations.push({ ...complete, id: randomUUID(), state: 'dispatched', idempotencyKey: 'lost' }); });
  const restored = new ControlJournal(f.root); await restored.load();
  expect(restored.snapshot().operations.map((op) => op.state)).toEqual(['succeeded', 'unknown']);
  expect(restored.snapshot().operations[0]).toEqual(complete);
  await expect(restored.transaction((s) => { s.operations[0]!.state = 'dispatched'; })).rejects.toMatchObject({ code: 'conflict' });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});

it.each(['move', 'archive', 'replacement'] as const)('publishes no transcript when a %s lands during its final resource guard', async (change) => {
  const f = await fixture();
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  let sessionGuards = 0;
  f.guard.mockImplementation(async (resource?: { sessionId?: string }) => {
    if (!resource?.sessionId || ++sessionGuards !== 2) return;
    if (change === 'move') f.meta.cwd = outside; // moveTo keeps config.projectRoot.
    else if (change === 'archive') f.meta.archived = true;
    else f.meta.createdAt = 2; // A different session now answers to the same ID.
  });
  await expect(f.service.handle(f.principal, { method: 'sessions.transcript', params: { instanceId: f.state.instanceId, projectId: f.projectId, sessionId: f.meta.id } })).rejects.toMatchObject({ code: 'denied' });
  expect(sessionGuards).toBe(2);
  expect(f.transcript).toHaveBeenCalledTimes(1);
});

it('keeps admission capacity for other controllers and reclaims a revoked controller\'s empty windows', async () => {
  const f = await fixture(async () => undefined); // Real transitions; skip one fsync per window.
  const call = (principal: ControllerPrincipal) => f.service.handle(principal, { method: 'windows.create', params: { instanceId: f.state.instanceId } });
  const other: ControllerPrincipal = { ...f.principal, controllerId: randomUUID() };
  await f.service.grant({ ...f.grant, controllerId: other.controllerId });
  const receipt = await f.service.handle(f.principal, { method: 'sessions.send', params: f.params }) as ControlOperation;
  await f.service.settle();
  // The fixture's window holds a receipt; fill the rest of this controller's share.
  for (let i = 1; i < CONTROL_OPEN_WINDOWS_PER_CONTROLLER; i++) await call(f.principal);
  await expect(call(f.principal)).rejects.toMatchObject({ code: 'busy' });
  await expect(call(other)).resolves.toMatchObject({ admissionWindowId: expect.any(String) });
  const own = () => f.journal.snapshot().windows.filter((w) => w.controllerId === f.principal.controllerId);
  expect(own()).toHaveLength(CONTROL_OPEN_WINDOWS_PER_CONTROLLER);
  await f.service.revoke(f.journal.snapshot().grants.find((g) => g.controllerId === f.principal.controllerId && !g.revokedAt)!.id);
  await call(other);
  // Only the window holding retry evidence survives; the other principal's windows are untouched.
  expect(own().map((w) => w.id)).toEqual([f.params.admissionWindowId]);
  expect(f.journal.snapshot().operations).toEqual([expect.objectContaining({ id: receipt.id, state: 'succeeded' })]);
  expect(f.journal.snapshot().windows.filter((w) => w.controllerId === other.controllerId)).toHaveLength(2);
});

it('does not count windows kept only as retry evidence toward the open-window share', async () => {
  const f = await fixture(async () => undefined);
  await f.service.handle(f.principal, { method: 'sessions.send', params: f.params });
  await f.service.settle();
  // A day of used, expired windows, each still holding a receipt through the retry grace.
  await f.journal.transaction((s) => {
    const receipt = s.operations[0]!;
    const expired = s.windows[0]!.expiresAt - 3_600_001;
    for (let i = 0; i < CONTROL_OPEN_WINDOWS_PER_CONTROLLER; i++) {
      const id = randomUUID();
      s.windows.push({ id, accountId: receipt.accountId, controllerId: receipt.controllerId, expiresAt: expired });
      s.operations.push({ ...receipt, id: randomUUID(), admissionWindowId: id });
    }
  });
  await expect(f.service.handle(f.principal, { method: 'windows.create', params: { instanceId: f.state.instanceId } })).resolves.toMatchObject({ admissionWindowId: expect.any(String) });
  expect(f.journal.snapshot().windows).toHaveLength(CONTROL_OPEN_WINDOWS_PER_CONTROLLER + 2);
});

it('reclaims an expired empty window at once instead of holding it through the retry grace', async () => {
  const f = await fixture();
  await f.service.handle(f.principal, { method: 'windows.create', params: { instanceId: f.state.instanceId } });
  expect(f.journal.snapshot().windows).toHaveLength(2);
  f.advance(3_600_001);
  await f.service.setEnabled(true);
  expect(f.journal.snapshot().windows).toEqual([]);
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: f.params })).rejects.toMatchObject({ code: 'expired' });
  expect(f.runControlled).not.toHaveBeenCalled();
});

it('caps one controller\'s retained receipts without consuming another controller\'s share', async () => {
  const f = await fixture(async () => undefined);
  const other: ControllerPrincipal = { ...f.principal, controllerId: randomUUID() };
  await f.service.grant({ ...f.grant, controllerId: other.controllerId });
  const first = await f.service.handle(f.principal, { method: 'sessions.send', params: f.params }) as ControlOperation;
  await f.service.settle();
  // Retained terminal receipts, as earlier admissions in the same window would have left them.
  await f.journal.transaction((s) => {
    for (let i = 1; i < CONTROL_OPERATIONS_PER_CONTROLLER; i++) s.operations.push({ ...s.operations[0]!, id: randomUUID(), idempotencyKey: `k${i}` });
  });
  expect(f.journal.snapshot().operations.filter((op) => op.controllerId === f.principal.controllerId && op.id !== first.id)).toHaveLength(CONTROL_OPERATIONS_PER_CONTROLLER - 1);
  await expect(f.service.handle(f.principal, { method: 'sessions.send', params: { ...f.params, idempotencyKey: 'over' } })).rejects.toMatchObject({ code: 'busy' });
  const window = await f.service.handle(other, { method: 'windows.create', params: { instanceId: f.state.instanceId } }) as { admissionWindowId: string };
  await expect(f.service.handle(other, { method: 'sessions.send', params: { ...f.params, admissionWindowId: window.admissionWindowId } })).resolves.toMatchObject({ state: 'accepted' });
  await f.service.settle();
});
