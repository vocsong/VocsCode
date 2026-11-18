import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalControl, type OpenLocalPipe } from '../src/main/control/local';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred } from '../src/main/util/async';
import { decodeLocalControlTarget, type LocalControlTarget } from '../src/shared/local-control';
import type { SessionMeta } from '../src/shared/types';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((remove) => remove())); });

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-local-control-'));
  cleanup.push(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = await fs.realpath(tmp);
  const project = path.join(root, 'approved'), other = path.join(root, 'approved-sibling');
  await Promise.all([fs.mkdir(project), fs.mkdir(other)]);
  const roots = [project, other];
  const meta = (id: string, folder: string): SessionMeta => ({ id, title: `Title ${id}`, createdAt: 1, updatedAt: 1,
    config: { harness: 'native', permissionMode: 'ask', projectRoot: folder }, cwd: folder, status: 'idle', harnessRef: {}, usage: emptyUsage() });
  const allowed = meta('s_allowed', project);
  const rows = [allowed, meta('s_outside', other), { ...meta('s_moved', project), cwd: other }, { ...meta('s_archived', project), archived: true }];
  const sessions = { list: () => rows, get: (id: string) => rows.find((row) => row.id === id) };
  const guard = vi.fn(async (_resource: { sessionId?: string; projectRoot?: string }) => {});
  const handle: Array<Parameters<OpenLocalPipe>[0]> = [];
  const close = vi.fn();
  const open = vi.fn<OpenLocalPipe>(async (options) => {
    handle.push(options);
    return { pid: 321, started: '137000000000012345', close };
  });
  let revision = 0;
  const control = new LocalControl({ supported: true, userData: root, roots: () => roots, sessions, guard, open, workspaceRevision: () => revision });
  const initial = await control.ownerState();
  const projectId = initial.projects.find((item) => item.name === 'approved')!.id;
  const otherId = initial.projects.find((item) => item.name === 'approved-sibling')!.id;
  const enable = async () => decodeLocalControlTarget((await control.enable({ projectIds: [projectId] })).target!);
  const request = (target: LocalControlTarget, method: string, params: unknown = {}) => ({
    v: target.v, instanceId: target.instanceId, profileId: target.profileId, request: { method, params },
  });
  return { root, project, other, roots, projectId, otherId, rows, allowed, guard, handle, close, open, control, initial, enable, request,
    changedMission: () => { revision++; } };
}

it('does not start a listener until an explicit project selection and returns only bounded ordinary metadata', async () => {
  const f = await fixture();
  expect(f.initial).toMatchObject({ target: null, approvedProjectIds: [] });
  await expect(f.control.enable({ projectIds: [] })).rejects.toBeDefined();
  await expect(f.control.enable({ projectIds: ['unlisted'] })).rejects.toMatchObject({ code: 'denied' });
  expect(f.open).not.toHaveBeenCalled();
  const target = await f.enable();
  const { dispatch } = f.handle[0]!;
  expect(await dispatch(f.request(target, 'capabilities'))).toEqual({ ok: true, result: {
    instanceId: target.instanceId, version: 1, methods: ['capabilities', 'projects.list', 'sessions.list'],
  } });
  expect(await dispatch(f.request(target, 'projects.list', { instanceId: target.instanceId }))).toEqual({ ok: true, result: {
    items: [{ id: f.projectId, name: 'approved' }], nextOffset: null,
  } });
  expect(await dispatch(f.request(target, 'sessions.list', { instanceId: target.instanceId, projectId: f.projectId }))).toEqual({ ok: true, result: {
    items: [{ id: 's_allowed', title: 'Title s_allowed', status: 'idle', harness: 'native' }], nextOffset: null,
  } });
  expect(await dispatch(f.request(target, 'sessions.list', { instanceId: target.instanceId, projectId: f.otherId }))).toEqual({ ok: false, error: 'denied' });
});

it('refuses writes, private reads, wrong targets and principal/path injection before resource checks', async () => {
  const f = await fixture();
  const target = await f.enable();
  const { dispatch } = f.handle[0]!;
  f.guard.mockClear();
  const call = f.request(target, 'sessions.list', { instanceId: target.instanceId, projectId: f.projectId });
  for (const bad of [
    f.request(target, 'sessions.send'), f.request(target, 'sessions.transcript'), { ...call, actor: 'desktop' },
    f.request(target, 'sessions.list', { instanceId: target.instanceId, projectId: f.projectId, path: f.other }),
  ]) expect(await dispatch(bad)).toEqual({ ok: false, error: 'invalid_request' });
  for (const bad of [{ ...call, profileId: '0'.repeat(64) }, { ...call, instanceId: randomUUID() },
    f.request(target, 'sessions.list', { instanceId: randomUUID(), projectId: f.projectId })]) {
    expect(await dispatch(bad)).toEqual({ ok: false, error: 'denied' });
  }
  expect(await dispatch({ ...call, v: 2 })).toEqual({ ok: false, error: 'incompatible' });
  expect(f.guard).not.toHaveBeenCalled();
});

it('rechecks a pending read after revoke; a replacement cannot restore the retired target', async () => {
  const f = await fixture();
  const target = await f.enable();
  const old = f.handle[0]!;
  const reached = deferred<void>(), release = deferred<void>();
  f.guard.mockImplementation(async (resource) => {
    if (resource.sessionId === f.allowed.id) { reached.resolve(); await release.promise; }
  });
  const running = old.dispatch(f.request(target, 'sessions.list', { projectId: f.projectId, instanceId: target.instanceId }));
  await reached.promise;
  expect((await f.control.disable()).target).toBeNull();
  expect(f.close).toHaveBeenCalledTimes(1);
  const next = await f.enable();
  release.resolve();
  expect(await running).toEqual({ ok: false, error: 'denied' });
  expect(next.pipeName).not.toBe(target.pipeName);
  expect(next.instanceId).not.toBe(target.instanceId);
  expect(await old.dispatch(f.request(target, 'capabilities'))).toEqual({ ok: false, error: 'denied' });
  f.handle[1]!.closed();
  expect((await f.control.ownerState()).target).toBeNull();
});

it('does not enable when the project changed between selection and approval or disappears after approval', async () => {
  const f = await fixture();
  await f.enable();
  const target = decodeLocalControlTarget((await f.control.ownerState()).target!);
  await fs.rename(f.project, path.join(f.root, 'moved'));
  await fs.mkdir(f.project);
  const { dispatch } = f.handle[0]!;
  expect(await dispatch(f.request(target, 'projects.list', { instanceId: target.instanceId }))).toEqual({ ok: true, result: { items: [], nextOffset: null } });
  expect(await dispatch(f.request(target, 'sessions.list', { instanceId: target.instanceId, projectId: f.projectId }))).toEqual({ ok: false, error: 'denied' });
  await expect(f.enable()).rejects.toMatchObject({ code: 'denied' });
  expect((await f.control.ownerState()).target).toBeNull();
});

it('removing and re-adding an approved project cannot reactivate the old target', async () => {
  const f = await fixture();
  const target = await f.enable();
  f.roots.splice(f.roots.indexOf(f.project), 1);
  f.control.projectsChanged();
  f.roots.push(f.project);
  f.control.projectsChanged();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(await f.handle[0]!.dispatch(f.request(target, 'capabilities'))).toEqual({ ok: false, error: 'denied' });
  expect((await f.control.ownerState()).target).toBeNull();
});

it('does not publish metadata from a cwd that changed while the workspace guard was pending', async () => {
  const f = await fixture();
  const cwd = path.join(f.project, 'worktree');
  await fs.mkdir(cwd);
  f.allowed.cwd = cwd;
  const target = await f.enable();
  f.guard.mockImplementation(async ({ sessionId }) => {
    if (sessionId === f.allowed.id) {
      await fs.rename(cwd, path.join(f.project, 'previous'));
      await fs.mkdir(cwd);
    }
  });
  expect(await f.handle[0]!.dispatch(f.request(target, 'sessions.list', {
    instanceId: target.instanceId, projectId: f.projectId,
  }))).toEqual({ ok: true, result: { items: [], nextOffset: null } });
});

it('drops a metadata reply when Mission ownership changed during validation', async () => {
  const f = await fixture();
  const target = await f.enable();
  f.guard.mockImplementation(async ({ sessionId }) => { if (sessionId === f.allowed.id) f.changedMission(); });
  expect(await f.handle[0]!.dispatch(f.request(target, 'sessions.list', {
    instanceId: target.instanceId, projectId: f.projectId,
  }))).toEqual({ ok: false, error: 'denied' });
});

it.each(['revoke', 'renderer unload'] as const)('stops an in-progress listener setup on %s', async (reason) => {
  const f = await fixture();
  const spawned = deferred<void>(), ready = deferred<Awaited<ReturnType<OpenLocalPipe>>>();
  f.open.mockImplementationOnce(async (options) => {
    f.handle.push(options);
    spawned.resolve();
    return ready.promise;
  });
  const enabling = f.control.enable({ projectIds: [f.projectId] });
  await spawned.promise;
  if (reason === 'revoke') await f.control.disable();
  else f.control.cancelPendingEnable();
  expect(f.handle[0]!.signal.aborted).toBe(true);
  ready.resolve({ pid: 321, started: '137000000000012345', close: f.close });
  await expect(enabling).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.close).toHaveBeenCalledTimes(1);
  expect((await f.control.ownerState()).target).toBeNull();
});
