/** Real Git receipts: an interrupted integration is not permission to replay its effects. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '../src/main/runtime';
import { MissionWorkspaces, type IntegrationCheck, type MissionBaseline, type MissionWorkspace } from '../src/main/mission/workspaces';

let root: string, source: string, storage: string;
let service: MissionWorkspaces, baseline: MissionBaseline;
let held: Set<string>;
const gitBytes = (cwd: string, args: string[]): Buffer => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.toString() || String(result.error));
  return result.stdout;
};
const git = (cwd: string, args: string[]): string => gitBytes(cwd, args).toString().trim();
const write = (cwd: string, file: string, value: string) => fs.writeFile(path.join(cwd, file), value);
const text = (cwd: string, file: string) => fs.readFile(path.join(cwd, file), 'utf8');
const restart = () => new MissionWorkspaces({ root: storage, quiescence: { acquire: async (cwd) => {
  if (held.has(cwd)) return null;
  held.add(cwd);
  return { assertQuiescent: async () => { if (!held.has(cwd)) throw new Error('Lease lost'); }, release: () => { held.delete(cwd); } };
} } });
const manifest = (id: string) => path.join(storage, 'workspaces', `${id}.json`);
const inputFor = (candidateId: string, check = vi.fn(async (_attempt: IntegrationCheck) => true)) => ({ missionId: 'm01', candidateId, expectedAccepted: baseline.revision, check });
async function candidate(id = 'c_one', value = 'candidate\n') {
  const worker = await service.provision({ missionId: 'm01', baseline, role: 'worker', attemptId: id });
  await write(worker.cwd, 'a.txt', value);
  return service.captureCandidate(worker.id, id, id);
}
async function preserved(cwd = source) {
  return {
    head: gitBytes(cwd, ['rev-parse', 'HEAD']),
    index: await fs.readFile(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])),
    status: gitBytes(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    bytes: await fs.readFile(path.join(cwd, 'a.txt')),
  };
}
async function attempts(): Promise<Array<MissionWorkspace & { integration?: { status: string } }>> {
  const files = await fs.readdir(path.join(storage, 'workspaces'));
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await text(path.join(storage, 'workspaces'), file))));
  return records.filter((record) => record.role === 'integration-attempt');
}
function failPromotion(when: 'before' | 'after') {
  const original = runtime.runCapture;
  let failures = 0;
  const effects = { applies: 0, worktrees: 0, transactions: 0 };
  const spy = vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
    if (args.includes('apply')) effects.applies++;
    if (args.includes('worktree') && args.includes('add')) effects.worktrees++;
    if (!args.includes('update-ref') || !args.includes('--stdin')) return original(cmd, args, opts);
    effects.transactions++;
    if (failures) return original(cmd, args, opts);
    failures++;
    if (when === 'after') expect((await original(cmd, args, opts)).code).toBe(0);
    throw new Error(`Lost ${when} promotion acknowledgment`);
  });
  return { effects, restore: () => { expect(failures).toBe(1); spy.mockRestore(); } };
}

/** Observe both transport and filesystem boundaries; even mkdir(existing) is a forbidden write. */
async function readOnly<T>(inspect: (reader: MissionWorkspaces) => Promise<T>): Promise<T> {
  const reader = new MissionWorkspaces({ root: storage, quiescence: { acquire: async () => { throw new Error('Inspection acquired writer admission'); } } });
  const mutations = ['mkdir', 'writeFile', 'rename', 'link', 'rm', 'copyFile', 'open'] as const;
  const spies = mutations.map((method) => vi.spyOn(fs, method).mockImplementation(async () => { throw new Error(`Inspection called fs.${method}`); }));
  const original = runtime.runCapture;
  const gitSpy = vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
    if (!args.some((arg) => ['rev-parse', 'cat-file', 'ls-tree'].includes(arg))) throw new Error(`Inspection ran mutating/unexpected Git: ${args.join(' ')}`);
    return original(cmd, args, opts);
  });
  try { return await inspect(reader); } finally { gitSpy.mockRestore(); for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); } }
}
const promotionRefs = () => git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions']).split('\n').filter((ref) => ref.includes('/candidate-promotions/'));

beforeEach(async () => {
  // Short fixture paths keep loose-ref tests meaningful on Windows without core.longpaths.
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mi-')); source = path.join(root, 's'); storage = path.join(root, 'o');
  await fs.mkdir(source); git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Integration Receipt Fixture']); git(source, ['config', 'user.email', 'integration-receipt@example.invalid']);
  git(source, ['config', 'commit.gpgsign', 'false']); git(source, ['config', 'core.autocrlf', 'false']);
  await write(source, 'a.txt', 'base\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'Fixture baseline']);
  held = new Set(); service = restart();
  const probe = await service.probeBaseline(source); if (!probe.ok) throw new Error(probe.message); baseline = probe.baseline;
});
afterEach(async () => {
  vi.restoreAllMocks(); expect(held.size).toBe(0);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('candidate integration identity', () => {
  it('returns one accepted operation across restart without a second check or workspace, including empty deltas', async () => {
    const captured = await candidate('c_empty', 'base\n'); const input = inputFor(captured.id);
    const before = await preserved();
    const first = await service.integrate(input);
    expect(first.status).toBe('accepted'); expect(first.revision).toEqual(baseline.revision);
    service = restart();
    expect(await service.integrate(input)).toEqual(first);
    expect(input.check).toHaveBeenCalledTimes(1);
    expect(await attempts()).toHaveLength(1);
    expect(input.check.mock.calls[0][0].workspace).toMatchObject({ id: first.workspace!.id, operationId: first.workspace!.id, baseRevision: baseline.revision });
    expect(await preserved()).toEqual(before);
  }, 30_000);

  it.each(['before', 'after'] as const)('reconciles a lost %s-CAS acknowledgment with one apply/check and one immutable marker', async (when) => {
    const captured = await candidate(); const input = inputFor(captured.id);
    await write(source, 'a.txt', 'user resumed\n'); git(source, ['add', 'a.txt']); await write(source, 'a.txt', 'user unstaged\n');
    const before = await preserved(), workerBefore = await preserved((await service.workspace(captured.workspaceId)).cwd);
    const failure = failPromotion(when);
    await expect(service.integrate(input)).rejects.toThrow('promotion acknowledgment');
    const retained = (await attempts())[0];
    const receiptFile = path.join(storage, 'candidate-integrations', `${retained.id}.json`);
    const receiptBefore = await fs.readFile(receiptFile);
    service = restart();
    const checked = await service.inspectIntegration(input);
    if (when === 'after') expect(checked).toMatchObject({ status: 'accepted', revision: captured.revision, workspace: { id: retained.id } });
    else expect(checked).toBeUndefined();
    expect(await fs.readFile(receiptFile)).toEqual(receiptBefore);
    const recovered = await service.integrate(input);
    expect(recovered).toMatchObject({ status: 'accepted', revision: captured.revision, workspace: { id: retained.id, baseRevision: baseline.revision } });
    expect(await service.integrate(input)).toEqual(recovered);
    expect(input.check).toHaveBeenCalledTimes(1);
    expect(failure.effects).toEqual({ applies: 1, worktrees: 1, transactions: when === 'before' ? 2 : 1 });
    failure.restore();
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toEqual(recovered);
    expect(await attempts()).toHaveLength(1); expect(promotionRefs()).toHaveLength(1);
    expect(promotionRefs()[0].length).toBeLessThan(120);
    expect(await service.acceptedRevision('m01')).toEqual(captured.revision);
    expect(await preserved()).toEqual(before);
    expect(await preserved((await service.workspace(captured.workspaceId)).cwd)).toEqual(workerBefore);
  }, 30_000);

  it.each(['before', 'after'] as const)('reconciles lost accepted-metadata acknowledgment %s publication without replay', async (when) => {
    const captured = await candidate(); const input = inputFor(captured.id); const before = await preserved();
    const rename = fs.rename.bind(fs); let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).includes('candidate-integrations') && JSON.parse(await fs.readFile(from, 'utf8')).status === 'accepted') {
        failed = true;
        if (when === 'after') await rename(from, to);
        throw new Error('Lost receipt acknowledgment');
      }
      return rename(from, to);
    });
    await expect(service.integrate(input)).rejects.toThrow('Lost receipt acknowledgment');
    vi.restoreAllMocks(); expect(failed).toBe(true);
    const files = await fs.readdir(path.join(storage, 'candidate-integrations'));
    expect(files).toHaveLength(1);
    const receiptFile = path.join(storage, 'candidate-integrations', files[0]), receiptBefore = await fs.readFile(path.join(storage, 'candidate-integrations', files[0]));
    const confirmed = await readOnly((reader) => reader.inspectIntegration(input));
    expect(confirmed).toMatchObject({ status: 'accepted', revision: captured.revision });
    expect(await fs.readFile(receiptFile)).toEqual(receiptBefore);
    service = restart(); expect(await service.integrate(input)).toEqual(confirmed);
    expect(input.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1); expect(promotionRefs()).toHaveLength(1);
    expect(await preserved()).toEqual(before);
  }, 30_000);

  it.each(['before', 'after'] as const)('retains an uncertain apply %s its Git effect and never reapplies or checks it', async (when) => {
    const captured = await candidate(); const input = inputFor(captured.id); const before = await preserved();
    const original = runtime.runCapture; let applies = 0;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      if (!args.includes('apply')) return original(cmd, args, opts);
      applies++;
      if (when === 'after') expect((await original(cmd, args, opts)).code).toBe(0);
      throw new Error('Lost apply acknowledgment');
    });
    await expect(service.integrate(input)).rejects.toThrow('Lost apply acknowledgment');
    const retained = (await attempts())[0], retainedBefore = await preserved((await attempts())[0].cwd);
    service = restart();
    await expect(service.integrate(input)).rejects.toThrow('will not be reapplied or rechecked');
    expect(applies).toBe(1); expect(input.check).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
    expect(await attempts()).toHaveLength(1); expect(promotionRefs()).toEqual([]);
    expect(await text(retained.cwd, 'a.txt')).toBe(when === 'after' ? 'candidate\n' : 'base\n');
    expect(await preserved(retained.cwd)).toEqual(retainedBefore); expect(await preserved()).toEqual(before);
  }, 30_000);

  it('does not repeat a check whose outcome was not durably recorded', async () => {
    const captured = await candidate(); const input = inputFor(captured.id); const before = await preserved();
    const rename = fs.rename.bind(fs); let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).includes('candidate-integrations') && JSON.parse(await fs.readFile(from, 'utf8')).status === 'promoting') {
        failed = true; throw new Error('Lost check receipt acknowledgment');
      }
      return rename(from, to);
    });
    await expect(service.integrate(input)).rejects.toThrow('Lost check receipt acknowledgment');
    vi.restoreAllMocks(); expect(failed).toBe(true);
    const retained = (await attempts())[0], retainedBefore = await preserved((await attempts())[0].cwd);
    service = restart(); await expect(service.integrate(input)).rejects.toThrow('will not be reapplied or rechecked');
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
    expect(input.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1); expect(promotionRefs()).toEqual([]);
    expect(await preserved(retained.cwd)).toEqual(retainedBefore); expect(await preserved()).toEqual(before);
  }, 30_000);

  it('writes its stable intent before worktree effects and recovers only that provisioning attempt', async () => {
    const captured = await candidate(); const input = inputFor(captured.id); const before = await preserved();
    const original = runtime.runCapture; let failed = false;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      const result = await original(cmd, args, opts);
      if (!failed && args.includes('worktree') && args.includes('add')) {
        failed = true;
        const records = await attempts(); const receipts = await fs.readdir(path.join(storage, 'candidate-integrations'));
        expect(records).toHaveLength(1); expect(receipts).toEqual([`${records[0].id}.json`]);
        expect(JSON.parse(await text(path.join(storage, 'candidate-integrations'), receipts[0]))).toMatchObject({ workspaceId: records[0].id, candidateId: captured.id, expected: baseline.revision, status: 'prepared' });
        throw new Error('Lost worktree acknowledgment');
      }
      return result;
    });
    await expect(service.integrate(input)).rejects.toThrow('Lost worktree acknowledgment');
    vi.restoreAllMocks(); expect(failed).toBe(true);
    const retained = (await attempts())[0];
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
    service = restart(); const result = await service.integrate(input);
    expect(result).toMatchObject({ status: 'accepted', workspace: { id: retained.id, branch: retained.branch } });
    expect(input.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1); expect(await preserved()).toEqual(before);
  }, 30_000);

  it('retains a conflict and its exact unmerged index and bytes across retry', async () => {
    const left = await candidate('c_left', 'left\n'), right = await candidate('c_right', 'right\n');
    const accepted = await service.integrate(inputFor(left.id)); const input = { ...inputFor(right.id), expectedAccepted: accepted.revision };
    const before = await preserved();
    const first = await service.integrate(input); expect(first.status).toBe('conflict');
    const stages = git(first.workspace!.cwd, ['ls-files', '--unmerged']); expect(stages).not.toBe('');
    const retainedBefore = await preserved(first.workspace!.cwd);
    expect(retainedBefore.bytes.toString()).toContain('<<<<<<<');
    service = restart(); expect(await service.integrate(input)).toEqual(first);
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
    expect(input.check).not.toHaveBeenCalled(); expect(await attempts()).toHaveLength(2);
    expect(git(first.workspace!.cwd, ['ls-files', '--unmerged'])).toBe(stages);
    expect(await service.cleanup(first.workspace!.id)).toMatchObject({ removed: false });
    expect(await preserved(first.workspace!.cwd)).toEqual(retainedBefore); expect(await preserved()).toEqual(before);
  }, 45_000);

  it.each(['rejected', 'changed'] as const)('retains %s checks without another check or workspace', async (status) => {
    const captured = await candidate();
    const input = inputFor(captured.id, vi.fn(async ({ workspace }: IntegrationCheck) => {
      if (status === 'changed') await write(workspace.cwd, 'a.txt', 'changed during checks\n');
      return status === 'changed';
    }));
    const first = await service.integrate(input); expect(first.status).toBe(status);
    const before = await preserved(first.workspace!.cwd);
    service = restart(); expect(await service.integrate(input)).toEqual(first);
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
    expect(input.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1); expect(promotionRefs()).toEqual([]);
    expect(await preserved(first.workspace!.cwd)).toEqual(before);
  }, 30_000);

  it('does not infer one operation from another operation producing the same accepted tree', async () => {
    const firstCandidate = await candidate('c_first', 'base\n'), secondCandidate = await candidate('c_second', 'base\n');
    const firstInput = inputFor(firstCandidate.id), secondInput = inputFor(secondCandidate.id);
    const first = await service.integrate(firstInput), second = await service.integrate(secondInput);
    expect(first.revision).toEqual(second.revision); expect(first.workspace!.id).not.toBe(second.workspace!.id);
    expect(promotionRefs()).toHaveLength(2);
    const marker = promotionRefs().find((ref) => ref.endsWith(`/${first.workspace!.id}`))!;
    // A missing marker is not repaired or inferred from accepted, even when another marker has
    // the exact same tree. Fixture corruption only; production never deletes these receipts.
    git(source, ['update-ref', '-d', marker]);
    expect(await readOnly((reader) => reader.inspectIntegration(firstInput))).toBeUndefined();
    expect(await readOnly((reader) => reader.inspectIntegration(secondInput))).toEqual(second);
    service = restart(); await expect(service.integrate(firstInput)).rejects.toThrow('Missing candidate promotion acknowledgment');
    expect(await service.integrate(secondInput)).toEqual(second);
    expect(firstInput.check).toHaveBeenCalledTimes(1); expect(secondInput.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(2);
  }, 45_000);

  it('returns the exact historical operation after later acceptance and binds retries to the original base', async () => {
    const captured = await candidate(), input = inputFor(captured.id);
    const first = await service.integrate(input);
    const later = await candidate('c_later', 'later\n'), laterInput = { ...inputFor(later.id), expectedAccepted: first.revision };
    const second = await service.integrate(laterInput); expect(second.status).toBe('accepted');
    expect(second.revision).not.toEqual(first.revision);
    expect(second.workspace!.baseRevision).toEqual(first.revision);
    service = restart();
    const reordered = { ...input, expectedAccepted: { contentHash: baseline.revision.contentHash, baseCommitSha: baseline.revision.baseCommitSha } };
    expect(await readOnly((reader) => reader.inspectIntegration(reordered))).toEqual(first);
    expect(await service.integrate(reordered)).toEqual(first);
    expect(await readOnly((reader) => reader.inspectIntegration({ ...laterInput, expectedAccepted: baseline.revision }))).toBeUndefined();
    expect(await service.acceptedRevision('m01')).toEqual(second.revision);
    expect(input.check).toHaveBeenCalledTimes(1); expect(laterInput.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(2);
  }, 45_000);

  it('keeps CAS failure terminal and does not create a promotion marker', async () => {
    const captured = await candidate(), concurrent = await candidate('c_other', 'concurrent\n');
    const acceptedRef = git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions']).split('\n').find((ref) => ref.endsWith('/accepted'))!;
    const input = inputFor(captured.id, vi.fn(async (_attempt: IntegrationCheck) => { git(source, ['update-ref', acceptedRef, concurrent.revision.contentHash, baseline.revision.contentHash]); return true; }));
    const result = await service.integrate(input); expect(result).toMatchObject({ status: 'stale', revision: concurrent.revision });
    service = restart(); expect(await service.integrate(input)).toEqual(result);
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
    expect(promotionRefs()).toEqual([]); expect(input.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1);
  }, 30_000);

  it('keeps legacy namespaces and retained refs, and refuses unmarked legacy attempts without replay', async () => {
    const captured = await candidate(); const input = inputFor(captured.id);
    const file = path.join(storage, 'missions', 'm01.json'), mission = JSON.parse(await fs.readFile(file, 'utf8'));
    const legacy = `refs/vocs-missions/${createHash('sha256').update(await fs.realpath(storage)).digest('hex').slice(0, 20)}/m01`;
    git(source, ['update-ref', `${legacy}/accepted`, baseline.revision.contentHash]);
    git(source, ['update-ref', `${legacy}/retained/w_old/c_old/tree`, baseline.revision.contentHash]);
    await fs.writeFile(file, JSON.stringify({ ...mission, acceptedRef: `${legacy}/accepted` }));
    service = restart(); const result = await service.integrate(input);
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toEqual(result);
    expect(git(source, ['rev-parse', mission.acceptedRef])).toBe(baseline.revision.contentHash);
    expect(git(source, ['rev-parse', `${legacy}/retained/w_old/c_old/tree`])).toBe(baseline.revision.contentHash);
    const recordFile = manifest(result.workspace!.id), record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    delete record.operationId;
    await fs.writeFile(recordFile, JSON.stringify(record));
    await fs.unlink(path.join(storage, 'candidate-integrations', `${record.id}.json`));
    git(source, ['update-ref', '-d', promotionRefs()[0]]);
    const refs = git(source, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/vocs-missions']), recordBefore = await fs.readFile(recordFile), retainedBefore = await preserved(record.cwd);
    expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
    service = restart(); await expect(service.integrate(input)).rejects.toThrow('Legacy candidate integration');
    expect(input.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1);
    expect(git(source, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/vocs-missions'])).toBe(refs);
    expect(await fs.readFile(recordFile)).toEqual(recordBefore); expect(await preserved(record.cwd)).toEqual(retainedBefore);
  }, 30_000);
});

describe('read-only receipt inspection', () => {
  it('does not initialize missing storage or provision a missing candidate/target attempt', async () => {
    const absent = path.join(root, 'absent', 'store'), originalStorage = storage;
    storage = absent;
    const input = { missionId: 'm01', candidateId: 'c_missing', observationId: 'o_missing', expectedAccepted: baseline.revision };
    try {
      expect(await readOnly((reader) => reader.inspectIntegration(input))).toBeUndefined();
      expect(await readOnly((reader) => reader.inspectTargetIntegration(input))).toBeUndefined();
      await expect(fs.lstat(path.dirname(absent))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { storage = originalStorage; }
    const captured = await candidate();
    expect(await readOnly((reader) => reader.inspectIntegration(inputFor(captured.id)))).toBeUndefined();
    expect(await readOnly((reader) => reader.inspectTargetIntegration(input))).toBeUndefined();
    expect(await attempts()).toHaveLength(0);
  }, 30_000);

  it('requires exact workspace and Git marker identities, not just an accepted JSON status', async () => {
    const captured = await candidate(), input = inputFor(captured.id), result = await service.integrate(input);
    const file = manifest(result.workspace!.id), original = await fs.readFile(file), record = JSON.parse(original.toString());
    await fs.writeFile(file, JSON.stringify({ ...record, baseRevision: captured.revision }));
    await expect(readOnly((reader) => reader.inspectIntegration(input))).rejects.toMatchObject({ code: 'not_owned' });
    await fs.writeFile(file, original);
    git(source, ['update-ref', promotionRefs()[0], baseline.revision.contentHash]);
    await expect(readOnly((reader) => reader.inspectIntegration(input))).rejects.toMatchObject({ code: 'storage' });
    expect(input.check).toHaveBeenCalledTimes(1); expect(await attempts()).toHaveLength(1);
  }, 30_000);

  it('does not finish a target promotion whose CAS has not happened', async () => {
    await service.provision({ missionId: 'm01', baseline, role: 'integration' });
    git(source, ['remote', 'add', 'origin', source]);
    const observation = await service.observeApprovedTarget({ missionId: 'm01', operationId: 'before', remote: 'origin', targetBranch: 'main', authorize: async () => undefined });
    const check = vi.fn(async () => true), input = { missionId: 'm01', observationId: observation.id, expectedAccepted: baseline.revision, check };
    const failure = failPromotion('before');
    await expect(service.integrateObservedTarget(input)).rejects.toThrow('promotion acknowledgment'); failure.restore();
    const before = await preserved(), records = await attempts(), refs = git(source, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/vocs-missions']);
    expect(await readOnly((reader) => reader.inspectTargetIntegration(input))).toBeUndefined();
    expect(await attempts()).toEqual(records);
    expect(git(source, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/vocs-missions'])).toBe(refs);
    expect(await preserved()).toEqual(before); expect(check).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('inspects the existing target key and exact Git receipt after lost promotion acknowledgment, without repairs', async () => {
    await service.provision({ missionId: 'm01', baseline, role: 'integration' });
    git(source, ['remote', 'add', 'origin', source]);
    const observation = await service.observeApprovedTarget({ missionId: 'm01', operationId: 'observe', remote: 'origin', targetBranch: 'main', authorize: async () => undefined });
    const check = vi.fn(async () => true), input = { missionId: 'm01', observationId: observation.id, expectedAccepted: baseline.revision, check };
    const failure = failPromotion('after');
    await expect(service.integrateObservedTarget(input)).rejects.toThrow('promotion acknowledgment'); failure.restore();
    const id = `t_${createHash('sha256').update(JSON.stringify(['m01', observation.id, baseline.revision])).digest('hex')}`;
    const file = path.join(storage, 'target-integrations', `${id}.json`), before = await fs.readFile(file), sourceBefore = await preserved();
    const confirmed = await readOnly((reader) => reader.inspectTargetIntegration(input));
    expect(confirmed).toMatchObject({ status: 'accepted', revision: baseline.revision, workspace: { id, baseRevision: baseline.revision } });
    expect(await fs.readFile(file)).toEqual(before); expect(await preserved()).toEqual(sourceBefore);
    expect(check).toHaveBeenCalledTimes(1);
    // An unrelated/missing observation can never borrow the same accepted content as proof.
    expect(await readOnly((reader) => reader.inspectTargetIntegration({ ...input, observationId: 'o_unrelated' }))).toBeUndefined();
    const marker = git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions']).split('\n').find((ref) => ref.includes('/target-promotions/'))!;
    git(source, ['update-ref', '-d', marker]);
    expect(await readOnly((reader) => reader.inspectTargetIntegration(input))).toBeUndefined();
    expect(await fs.readFile(file)).toEqual(before);
  }, 45_000);
});
