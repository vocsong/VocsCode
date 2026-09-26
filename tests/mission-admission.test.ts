import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionWorkspaceAdmission } from '../src/main/mission/admission';
import type { SessionActivity } from '../src/main/session-manager';
import type { SessionMeta } from '../src/shared/types';
import type { TerminalActivity } from '../src/main/terminal';
import { emptyUsage } from '../src/main/models/static-models';
import { deferred } from '../src/main/util/async';

let root: string, managed: string, other: string;
let sessions: SessionMeta[], terminals: TerminalActivity[], activity: SessionActivity, admission: MissionWorkspaceAdmission;
const idle = (): SessionActivity => ({ active: false, starting: false, turn: false, tools: 0, approvals: 0, compacting: false, queued: 0, tearingDown: false, uncertain: false, quiescent: true });
function session(id: string, cwd: string): SessionMeta {
  return { id, title: id, config: { harness: 'pi', projectRoot: cwd, permissionMode: 'auto' }, cwd, status: 'idle', usage: emptyUsage(), harnessRef: {}, queued: 0, createdAt: 1, updatedAt: 1 };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-admission-'));
  managed = path.join(root, 'managed'); other = path.join(root, 'other');
  await fs.mkdir(managed); await fs.mkdir(other);
  sessions = []; terminals = []; activity = idle();
  admission = new MissionWorkspaceAdmission({ sessions: () => sessions, activity: () => activity, terminals: () => terminals });
});
afterEach(async () => { admission.close(); await fs.rm(root, { recursive: true, force: true }); });

describe('Mission held workspace admission', () => {
  it('holds an exclusive resource across await boundaries and wakes pending ordinary dispatch on release', async () => {
    const lease = await admission.acquire(managed); expect(lease).toBeDefined();
    expect(await admission.acquire(managed)).toBeUndefined();
    const sent = vi.fn(); const pending = admission.wait(managed).then(sent);
    await new Promise((r) => setTimeout(r, 10)); expect(sent).not.toHaveBeenCalled();
    await admission.assertAvailable(other);
    await lease!.assertQuiescent(); await lease!.release(); await pending;
    expect(sent).toHaveBeenCalledTimes(1);
    await admission.assertAvailable(managed);
  });
  it('reserves a not-yet-created worktree through its canonical ancestor and retains the lease after creation', async () => {
    const alias = path.join(root, 'alias'); await fs.symlink(managed, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const future = path.join(managed, 'worktrees', 'new-worktree');
    const lease = await admission.acquire(future); expect(lease).toBeDefined();
    expect(await admission.acquire(path.join(alias, 'worktrees', 'new-worktree'))).toBeUndefined();
    await fs.mkdir(future, { recursive: true });
    await lease!.assertQuiescent();
    await expect(admission.assertAvailable(future)).rejects.toThrow(/reserved/);
    await lease!.release(); await admission.assertAvailable(future);
  });
  it('reserves the entire asynchronous guard and send-acceptance gap, not just an idle poll', async () => {
    const started = deferred<void>(), guard = deferred<void>();
    const send = vi.fn(async () => { started.resolve(); await guard.promise; });
    const pending = admission.dispatch(managed, send);
    await started.promise;
    expect(await admission.acquire(managed)).toBeUndefined();
    expect(await admission.acquire(other)).toBeDefined();
    guard.resolve(); await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(await admission.acquire(managed)).toBeDefined();
  });
  it('dispatches into a folder that was removed under a live runtime instead of failing with ENOENT', async () => {
    const removed = path.join(managed, 'removed-worktree');
    await fs.mkdir(removed);
    await fs.rm(removed, { recursive: true });
    const send = vi.fn(async () => undefined);
    await admission.dispatch(removed, send);
    expect(send).toHaveBeenCalledTimes(1);
    // Its canonical ancestor still collides with a lease on the parent workspace.
    const lease = await admission.acquire(managed);
    const pending = admission.dispatch(removed, send);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(1);
    await lease!.release(); await pending;
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('defers the actual dispatch callback until capture releases its lease', async () => {
    const lease = await admission.acquire(managed), send = vi.fn(async () => undefined);
    const pending = admission.dispatch(managed, send);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).not.toHaveBeenCalled();
    await lease!.release(); await pending;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retains ownership of an ordinary adapter queue that can start without another app send', async () => {
    sessions.push(session('source', managed)); activity = { ...idle(), queued: 1, quiescent: false };
    expect(await admission.acquire(managed)).toBeUndefined();
    activity.queued = 0;
    expect(await admission.acquire(managed)).toBeDefined();
  });
  it('blocks PTY startup and aliases while a snapshot lease is held', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(managed, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const lease = await admission.acquire(managed); expect(lease).toBeDefined();
    expect(() => admission.assertAvailableSync(alias)).toThrow(/settle/i);
    await expect(admission.assertAvailable(alias)).rejects.toThrow(/reserved/i);
    expect(await admission.acquire(alias)).toBeUndefined();
    await lease!.release(); expect(() => admission.assertAvailableSync(alias)).not.toThrow();
  });
  it.each(['turn', 'starting', 'compacting', 'tearingDown', 'uncertain'] as const)('does not acquire while owned %s activity can write', async (flag) => {
    sessions.push(session('source', managed)); activity = { ...idle(), [flag]: true, quiescent: false };
    expect(await admission.acquire(managed)).toBeUndefined();
    expect(await admission.acquire(other)).toBeDefined();
  });
  it('allows an unrelated readonly planning conversation to continue without interrupting it', async () => {
    const source = session('source', managed); source.config.permissionMode = 'plan'; sessions.push(source);
    activity = { ...idle(), active: true, turn: true, quiescent: false };
    const lease = await admission.acquire(managed); expect(lease).toBeDefined(); await lease!.assertQuiescent();
    source.config.permissionMode = 'auto'; await expect(lease!.assertQuiescent()).rejects.toThrow(/write/i);
    await lease!.release();
  });
  it('does not mistake a shell cwd announcement for proof its session workspace has no writer', async () => {
    sessions.push(session('lead', managed));
    terminals.push({ terminalId: 'terminal', sessionId: 'lead', cwd: other, reportedCwd: other, pid: 123, state: 'live', managed: true });
    expect(await admission.acquire(managed)).toBeUndefined();
    terminals[0] = { ...terminals[0], pid: undefined, state: 'uncertain' };
    expect(await admission.acquire(managed)).toBeUndefined();
    terminals = []; // Only positive process-tree teardown retires the activity.
    expect(await admission.acquire(managed)).toBeDefined();
  });
  it('invalidates held leases on shutdown and rejects deferred sends instead of dispatching them', async () => {
    const lease = await admission.acquire(managed);
    const pending = admission.wait(managed); const rejected = expect(pending).rejects.toThrow(/closed/i);
    admission.close(); await rejected;
    await expect(lease!.assertQuiescent()).rejects.toThrow(/lease/i);
    expect(() => admission.assertAvailableSync(managed)).toThrow(/closed/i);
  });
});
