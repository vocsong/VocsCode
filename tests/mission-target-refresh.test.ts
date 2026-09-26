/** V12: real temporary bare remote, real target advancement/three-way application and CAS. */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '../src/main/runtime';
import { MissionWorkspaces, type MissionBaseline, type MissionWorkspace, type TargetFetchAuthorization } from '../src/main/mission/workspaces';

let root: string, source: string, remote: string, upstream: string, storage: string;
let service: MissionWorkspaces, baseline: MissionBaseline, integration: MissionWorkspace;
let held: Set<string>;
const git = (cwd: string, args: string[]): string => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.toString() || String(result.error));
  return result.stdout.toString().trim();
};
const write = (cwd: string, file: string, value: string) => fs.writeFile(path.join(cwd, file), value);
const text = (cwd: string, file: string) => fs.readFile(path.join(cwd, file), 'utf8');
const restart = () => new MissionWorkspaces({ root: storage, quiescence: { acquire: async (cwd) => {
  if (held.has(cwd)) return null;
  held.add(cwd);
  return { assertQuiescent: async () => { if (!held.has(cwd)) throw new Error('Lease lost'); }, release: () => { held.delete(cwd); } };
} } });
const authorize = async (_request: TargetFetchAuthorization) => undefined;
const observe = (operationId: string, approval = authorize) => service.observeApprovedTarget({ missionId: 'm01', operationId, remote: 'origin', targetBranch: 'target', authorize: approval });
async function advance(file: string, content: string): Promise<string> {
  await write(upstream, file, content); git(upstream, ['add', '.']); git(upstream, ['commit', '-m', `Fixture target ${file}`]);
  git(upstream, ['push', 'origin', 'HEAD:refs/heads/target']);
  return git(upstream, ['rev-parse', 'HEAD']);
}
async function preserved() {
  return {
    head: git(source, ['rev-parse', 'HEAD']), branch: git(source, ['symbolic-ref', 'HEAD']),
    index: await fs.readFile(git(source, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])),
    status: git(source, ['status', '--porcelain=v1', '--untracked-files=all']),
    file: await text(source, 'source.txt'),
    fetchHead: await fs.readFile(path.join(source, '.git', 'FETCH_HEAD')).catch(() => undefined),
    tracking: git(source, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes']),
  };
}
async function accept(file: string, value: string, attemptId = 'a1') {
  const worker = await service.provision({ missionId: 'm01', baseline, role: 'worker', attemptId });
  await write(worker.cwd, file, value);
  const candidate = await service.captureCandidate(worker.id, attemptId);
  return service.integrate({ missionId: 'm01', candidateId: candidate.id, expectedAccepted: await service.acceptedRevision('m01'), check: async () => true });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-target-'));
  source = path.join(root, 'source'); remote = path.join(root, 'remote.git'); upstream = path.join(root, 'upstream'); storage = path.join(root, 'storage');
  await fs.mkdir(source); git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Target Fixture']); git(source, ['config', 'user.email', 'target@example.invalid']);
  git(source, ['config', 'commit.gpgsign', 'false']); git(source, ['config', 'core.autocrlf', 'false']);
  await write(source, 'source.txt', 'original\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'Common ancestor']);
  git(root, ['init', '--bare', remote]); git(source, ['remote', 'add', 'origin', remote]); git(source, ['push', 'origin', 'HEAD:refs/heads/target']);
  git(root, ['clone', '-c', 'core.autocrlf=false', '-b', 'target', remote, upstream]);
  git(upstream, ['config', 'user.name', 'Target Fixture']); git(upstream, ['config', 'user.email', 'target@example.invalid']);
  git(upstream, ['config', 'commit.gpgsign', 'false']); git(upstream, ['config', 'core.autocrlf', 'false']);
  // The clean source has its own history, so replacing its tree with the target would lose work.
  await write(source, 'local.txt', 'local baseline\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'Source-only baseline']);
  held = new Set(); service = restart();
  const probe = await service.probeBaseline(source); if (!probe.ok) throw new Error(probe.message); baseline = probe.baseline;
  integration = await service.provision({ missionId: 'm01', baseline, role: 'integration' });
});
afterEach(async () => {
  vi.restoreAllMocks(); expect(held.size).toBe(0);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('approved target observation and retained integration', () => {
  it('integrates an initially divergent remote, then its advancement, preserving baseline, source edits and Mission work', async () => {
    const target = await advance('remote.txt', 'initial target\n');
    const accepted = await accept('mission.txt', 'mission result\n');
    await write(source, 'source.txt', 'user resumed after baseline\n');
    await write(source, 'untracked.txt', 'user work\n');
    const before = await preserved();
    const approval = vi.fn(authorize);
    const observation = await observe('initial', approval);
    expect(observation.commitSha).toBe(target);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval.mock.calls[0][0]).toMatchObject({ cwd: integration.cwd, remoteUrl: remote, args: expect.arrayContaining(['fetch', '--no-write-fetch-head', '--refmap=', remote]) });
    const first = await service.integrateObservedTarget({ missionId: 'm01', observationId: observation.id, expectedAccepted: accepted.revision, check: async ({ workspace, revision, observation: actual }) => {
      expect(actual).toEqual(observation);
      expect(await text(workspace.cwd, 'remote.txt')).toBe('initial target\n');
      expect(await text(workspace.cwd, 'local.txt')).toBe('local baseline\n');
      expect(await text(workspace.cwd, 'mission.txt')).toBe('mission result\n');
      expect(await service.contentIdentity(workspace.cwd)).toEqual(revision);
      const verifier = await service.provisionVerification({ missionId: 'm01', operationId: 'target-check', revision });
      expect(await service.contentIdentity(verifier.cwd)).toEqual(revision);
      return true;
    } });
    expect(first.status).toBe('accepted');
    expect(first.revision.baseCommitSha).toBe(baseline.revision.baseCommitSha);
    expect(await service.integratedTargetObservation('m01')).toEqual(observation);
    expect(await service.baseline('m01')).toEqual(baseline);
    expect(await service.acceptedChangedPaths('m01')).toEqual(['mission.txt', 'remote.txt']);
    await fs.unlink(path.join(upstream, 'source.txt'));
    const nextTarget = await advance('remote.txt', 'advanced target\n');
    const secondObservation = await observe('advance');
    expect(secondObservation.commitSha).toBe(nextTarget);
    const second = await service.integrateObservedTarget({ missionId: 'm01', observationId: secondObservation.id, expectedAccepted: first.revision, check: async ({ workspace }) => {
      expect(await text(workspace.cwd, 'remote.txt')).toBe('advanced target\n');
      expect(await text(workspace.cwd, 'mission.txt')).toBe('mission result\n');
      await expect(text(workspace.cwd, 'source.txt')).rejects.toMatchObject({ code: 'ENOENT' });
      return true;
    } });
    expect(second.status).toBe('accepted');
    service = restart();
    expect(await service.integratedTargetObservation('m01')).toEqual(secondObservation);
    expect(await service.acceptedRevision('m01')).toEqual(second.revision);
    expect(await service.acceptedChangedPaths('m01')).toEqual(['mission.txt', 'remote.txt', 'source.txt']);
    expect(await service.baseline('m01')).toEqual(baseline);
    const refreshed = await service.materializeAccepted(integration.id, integration.fingerprint);
    expect(await service.contentIdentity(refreshed.cwd)).toEqual(second.revision);
    expect(git(source, ['rev-list', '--branches', '--count'])).toBe('2'); // No checkpoint commits.
    expect(await preserved()).toEqual(before);
    expect(await text(source, 'untracked.txt')).toBe('user work\n');
  }, 60_000);

  it('retains exact conflicting stages and markers across restart without reapplying the target', async () => {
    const accepted = await accept('source.txt', 'mission conflicting edit\n');
    await advance('source.txt', 'remote conflicting edit\n');
    const observation = await observe('conflict'); const before = await preserved();
    const check = vi.fn(async () => true);
    const input = { missionId: 'm01', observationId: observation.id, expectedAccepted: accepted.revision, check };
    const result = await service.integrateObservedTarget(input);
    expect(result.status).toBe('conflict'); expect(check).not.toHaveBeenCalled();
    const stages = git(result.workspace!.cwd, ['ls-files', '--unmerged']);
    expect(stages).not.toBe(''); expect(await text(result.workspace!.cwd, 'source.txt')).toContain('<<<<<<<');
    service = restart();
    expect(await service.integrateObservedTarget(input)).toEqual(result);
    expect(git(result.workspace!.cwd, ['ls-files', '--unmerged'])).toBe(stages);
    expect(await service.cleanup(result.workspace!.id)).toMatchObject({ removed: false });
    expect(await service.acceptedRevision('m01')).toEqual(accepted.revision);
    expect(await service.integratedTargetObservation('m01')).toBeUndefined();
    expect(await preserved()).toEqual(before);
  }, 30_000);

  it.each(['rejected', 'changed'] as const)('does not promote %s target checks or treat a retry as another apply', async (status) => {
    await advance('remote.txt', 'unchecked target\n'); const observation = await observe(status);
    const check = vi.fn(async ({ workspace }: { workspace: MissionWorkspace }) => {
      if (status === 'changed') await write(workspace.cwd, 'remote.txt', 'changed during checks\n');
      return status === 'changed';
    });
    const input = { missionId: 'm01', observationId: observation.id, expectedAccepted: baseline.revision, check };
    const result = await service.integrateObservedTarget(input);
    expect(result.status).toBe(status);
    service = restart(); expect(await service.integrateObservedTarget(input)).toEqual(result);
    expect(check).toHaveBeenCalledTimes(1);
    expect(await service.acceptedRevision('m01')).toEqual(baseline.revision);
    expect(await service.integratedTargetObservation('m01')).toBeUndefined();
  }, 30_000);

  it('denies fetch before network/object/ref effects and rejects arbitrary or foreign observations', async () => {
    const head = await advance('remote.txt', 'private target\n');
    const before = await preserved();
    const original = runtime.runCapture; const calls: string[][] = [];
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => { calls.push(args); return original(cmd, args, opts); });
    await expect(observe('denied', async () => { throw new Error('Fetch denied'); })).rejects.toThrow('Fetch denied');
    expect(calls.some((args) => args.includes('fetch') || args.includes('ls-remote'))).toBe(false);
    expect(spawnSync('git', ['cat-file', '-e', head], { cwd: source, windowsHide: true }).status).not.toBe(0);
    await expect(service.integrateObservedTarget({ missionId: 'm01', observationId: head, expectedAccepted: baseline.revision, check: async () => true })).rejects.toBeDefined();
    const observed = await observe('valid');
    await service.provision({ missionId: 'm02', baseline, role: 'integration' });
    await expect(service.integrateObservedTarget({ missionId: 'm02', observationId: observed.id, expectedAccepted: baseline.revision, check: async () => true })).rejects.toMatchObject({ code: 'not_owned' });
    await expect(service.observeApprovedTarget({ missionId: 'm01', operationId: 'valid', remote: 'origin', targetBranch: 'another', authorize })).rejects.toMatchObject({ code: 'not_owned' });
    expect(await preserved()).toEqual(before);
  }, 30_000);

  it('reconciles an acknowledged-loss fetch from its exact retained ref without fetching again', async () => {
    const head = await advance('remote.txt', 'first observed\n');
    const original = runtime.runCapture; let fetches = 0;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      const result = await original(cmd, args, opts);
      if (args.includes('fetch')) { fetches++; throw new Error('Lost fetch acknowledgment'); }
      return result;
    });
    await expect(observe('lost')).rejects.toThrow('Lost fetch');
    await advance('remote.txt', 'later remote\n');
    service = restart(); const recovered = await observe('lost');
    expect(recovered.commitSha).toBe(head); expect(fetches).toBe(1);
    expect(await observe('lost')).toEqual(recovered);
  }, 30_000);

  it('never turns an unacknowledged absent fetch into a later head under the same identity', async () => {
    await advance('remote.txt', 'first head\n'); const original = runtime.runCapture; let fetches = 0;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      if (args.includes('fetch')) { fetches++; throw new Error('Fetch not dispatched'); }
      return original(cmd, args, opts);
    });
    await expect(observe('lost-before')).rejects.toThrow('not dispatched');
    service = restart(); await expect(observe('lost-before')).rejects.toThrow('uncertain');
    expect(fetches).toBe(1);
  });

  it('rejects a target advanced between observation and fetch without changing any working tree', async () => {
    await advance('remote.txt', 'first head\n'); const before = await preserved();
    const original = runtime.runCapture; let raced = false;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      if (args.includes('fetch') && !raced) { raced = true; await advance('remote.txt', 'raced head\n'); }
      return original(cmd, args, opts);
    });
    await expect(observe('race')).rejects.toThrow('advanced during fetch');
    service = restart(); await expect(observe('race')).rejects.toThrow('advanced during fetch');
    expect(await service.acceptedRevision('m01')).toEqual(baseline.revision);
    expect(await preserved()).toEqual(before);
    const recovered = await observe('new-operation'); expect(recovered.commitSha).toBe(git(upstream, ['rev-parse', 'HEAD']));
  }, 30_000);

  it('retains an interrupted apply and cannot replay it even after acknowledgment loss', async () => {
    await advance('remote.txt', 'target\n'); const observation = await observe('apply');
    const original = runtime.runCapture; let applies = 0;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      const result = await original(cmd, args, opts);
      if (args.includes('apply')) { applies++; throw new Error('Lost apply acknowledgment'); }
      return result;
    });
    const check = vi.fn(async () => true);
    const input = { missionId: 'm01', observationId: observation.id, expectedAccepted: baseline.revision, check };
    await expect(service.integrateObservedTarget(input)).rejects.toThrow('Lost apply');
    service = restart(); await expect(service.integrateObservedTarget(input)).rejects.toThrow('will not be reapplied');
    expect(applies).toBe(1); expect(check).not.toHaveBeenCalled();
    expect(await service.acceptedRevision('m01')).toEqual(baseline.revision);
    const files = await fs.readdir(path.join(storage, 'target-integrations'));
    const receipt = JSON.parse(await text(path.join(storage, 'target-integrations'), files[0]));
    expect(await text(path.join(storage, 'worktrees', receipt.workspaceId), 'remote.txt')).toBe('target\n');
  }, 30_000);

  it.each(['git', 'receipt'] as const)('recovers a successful atomic promotion after lost %s acknowledgment without apply or check replay', async (failure) => {
    await advance('remote.txt', 'target\n'); const observation = await observe(`promote-${failure}`);
    const original = runtime.runCapture; const rename = fs.rename.bind(fs); let lost = false, applies = 0;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      const result = await original(cmd, args, opts);
      if (args.includes('apply')) applies++;
      if (!lost && failure === 'git' && args.includes('update-ref') && args.includes('--stdin')) { lost = true; throw new Error('Lost promotion acknowledgment'); }
      return result;
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!lost && failure === 'receipt' && String(to).includes('target-integrations') && JSON.parse(await fs.readFile(from, 'utf8')).status === 'accepted') { lost = true; throw new Error('Lost promotion acknowledgment'); }
      return rename(from, to);
    });
    const check = vi.fn(async () => true);
    const input = { missionId: 'm01', observationId: observation.id, expectedAccepted: baseline.revision, check };
    await expect(service.integrateObservedTarget(input)).rejects.toThrow('Lost promotion');
    service = restart(); const recovered = await service.integrateObservedTarget(input);
    expect(recovered.status).toBe('accepted'); expect(lost).toBe(true); expect(applies).toBe(1); expect(check).toHaveBeenCalledTimes(1);
    expect(await service.acceptedRevision('m01')).toEqual(recovered.revision);
    expect(await service.integratedTargetObservation('m01')).toEqual(observation);
    expect(await service.integrateObservedTarget(input)).toEqual(recovered);
  }, 30_000);

  it('fails the accepted-tree CAS without advancing the integrated target pointer', async () => {
    const worker = await service.provision({ missionId: 'm01', baseline, role: 'worker', attemptId: 'race' });
    await write(worker.cwd, 'other.txt', 'concurrent result\n'); const other = await service.captureCandidate(worker.id, 'race');
    await advance('remote.txt', 'target\n'); const observation = await observe('cas');
    const acceptedRef = git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions']).split('\n').find((ref) => ref.endsWith('/accepted'))!;
    const result = await service.integrateObservedTarget({ missionId: 'm01', observationId: observation.id, expectedAccepted: baseline.revision, check: async () => {
      git(source, ['update-ref', acceptedRef, other.revision.contentHash, baseline.revision.contentHash]); return true;
    } });
    expect(result.status).toBe('stale'); expect(await service.acceptedRevision('m01')).toEqual(other.revision);
    expect(await service.integratedTargetObservation('m01')).toBeUndefined();
    expect(git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions'])).not.toContain('target-promotions');
  }, 30_000);
});
