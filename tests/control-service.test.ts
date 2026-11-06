import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CONTROL_RETRY_GRACE_MS, ControlJournal } from '../src/main/control/journal';
import { ControlService } from '../src/main/control/service';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import { writeJson } from '../src/main/util/fs';
import { CONTROL_SCOPES, type ControllerPrincipal, type ControlOperation, type ControlGrantInput } from '../src/shared/control';
import type { SessionManager } from '../src/main/session-manager';
import type { SessionMeta } from '../src/shared/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(persist = writeJson) {
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
  const runControlled = vi.fn(async (_id: string, _input: unknown, context: { inputId: string; beforeDispatch(): Promise<void> }) => {
    await context.beforeDispatch(); dispatch();
    return { outcome: 'succeeded' as const, inputId: context.inputId, runtimeId: 'runtime', turnId: 'turn', outputIds: ['answer'] };
  });
  const createControlled = vi.fn(async () => meta);
  const interruptControlled = vi.fn();
  const transcript = vi.fn(async () => [
    { kind: 'assistant', id: 'answer', ts: 1, text: 'hello' },
    { kind: 'approval', id: 'secret', ts: 2, request: { questions: [{ secret: true, question: 'secret question content' }] } },
  ]);
  const sessions = { list: () => [meta], get: (id: string) => id === meta.id ? meta : undefined, runControlled, createControlled, interruptControlled, transcript } as unknown as SessionManager;
  const guard = vi.fn(async () => undefined);
  const service = new ControlService({ journal, sessions, settings: () => settings, guard, now: () => now });
  const state = await service.ownerState();
  const projectId = state.projects[0]!.id;
  const grant: ControlGrantInput = { accountId: principal.accountId, controllerId: principal.controllerId, name: 'Test controller', projectIds: [projectId], scopes: [...CONTROL_SCOPES], permissionModes: ['ask'], harnesses: ['native'], expiresAt: now + 10_000_000 };
  await service.grant(grant);
  await service.setEnabled(true);
  const window = await service.handle(principal, { method: 'windows.create', params: { instanceId: state.instanceId } }) as { admissionWindowId: string };
  const params = { instanceId: state.instanceId, projectId, sessionId: meta.id, admissionWindowId: window.admissionWindowId, idempotencyKey: 'same-intent', text: 'unique-prompt-content' };
  return { root, project, settings, meta, principal, journal, dispatch, runControlled, createControlled, interruptControlled, transcript, sessions, guard, service, state, projectId, grant, params,
    advance(ms: number) { now += ms; principal.validUntil = now + 30_000; } };
}

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
  expect(f.createControlled.mock.calls[0]).toEqual([{ config: expect.objectContaining({ harness: 'native', permissionMode: 'ask', useWorktree: false, model: { provider: 'p', model: 'm' } }) }, expect.any(String)]);
  f.settings.folderSessionDefaults[f.project]!.permissionMode = 'full-auto';
  await f.service.handle(f.principal, { method: 'sessions.create', params: { ...params, idempotencyKey: 'other' } }); await f.service.settle();
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
