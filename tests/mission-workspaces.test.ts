/** Real Git boundaries: no mocked merge, status, worktree, index, or content hashing. */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionWorkspaces, type MissionBaseline, type MissionWorkspace, type WorkspaceQuiescenceProvider } from '../src/main/mission/workspaces';

let root: string;
let source: string;
let storage: string;
let busy: Set<string>;
let held: Set<string>;
let service: MissionWorkspaces;
let baseline: MissionBaseline;

const env = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
});

function gitBytes(cwd: string, args: string[]): Buffer {
  const result = spawnSync('git', args, { cwd, env: env(), maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString() || result.error}`);
  return result.stdout;
}

const git = (cwd: string, args: string[]): string => gitBytes(cwd, args).toString('utf8').trim();
const write = (cwd: string, file: string, value: string | Buffer): Promise<void> => fs.writeFile(path.join(cwd, file), value);
const read = (cwd: string, file: string): Promise<Buffer> => fs.readFile(path.join(cwd, file));

function quiescence(): WorkspaceQuiescenceProvider {
  return {
    acquire: async (cwd) => {
      if (busy.has(cwd) || held.has(cwd)) return null;
      held.add(cwd);
      return {
        assertQuiescent: async () => { if (busy.has(cwd) || !held.has(cwd)) throw new Error('Writer is no longer quiescent'); },
        release: () => { held.delete(cwd); },
      };
    },
  };
}

async function preserved(cwd = source): Promise<{ head: Buffer; index: Buffer; status: Buffer; exclude: Buffer }> {
  return {
    head: gitBytes(cwd, ['rev-parse', 'HEAD']),
    index: await fs.readFile(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])),
    status: gitBytes(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    exclude: await fs.readFile(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])),
  };
}

async function workspace(attemptId: string, missionId = 'm01'): Promise<MissionWorkspace> {
  return service.provision({ missionId, baseline, role: 'worker', attemptId });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission git-'));
  source = path.join(root, 'source');
  storage = path.join(root, 'app owned');
  await fs.mkdir(source);
  git(source, ['init', '--initial-branch=main']);
  // Identity is fixture-local. Never override the agent/user identity via command flags or env.
  git(source, ['config', 'user.name', 'Mission Workspace Test']);
  git(source, ['config', 'user.email', 'mission-workspace-test@example.invalid']);
  git(source, ['config', 'commit.gpgsign', 'false']);
  git(source, ['config', 'core.autocrlf', 'false']);
  git(source, ['config', 'core.filemode', 'false']);
  await write(source, 'a.txt', 'base a\n');
  await write(source, 'b.txt', 'base b\n');
  await write(source, 'delete.txt', 'delete me\n');
  await write(source, 'run.sh', '#!/bin/sh\necho base\n');
  await write(source, '.gitignore', 'ignored/\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Fixture baseline']);
  busy = new Set();
  held = new Set();
  service = new MissionWorkspaces({ root: storage, quiescence: quiescence() });
  const result = await service.probeBaseline(source);
  if (!result.ok) throw new Error(result.message);
  baseline = result.baseline;
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(held.size).toBe(0);
  // Fixture teardown only, not the production cleanup path (which is always non-force Git).
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Mission Git baseline and workspace ownership', () => {
  it('blocks plain, unborn, dirty, and active source inputs without initializing or omitting any changes', async () => {
    const plain = path.join(root, 'plain');
    await fs.mkdir(plain);
    expect(await service.probeBaseline(plain)).toMatchObject({ ok: false, reason: 'not_git' });
    expect(await fs.readdir(plain)).toEqual([]);
    git(plain, ['init', '--initial-branch=main']);
    await write(plain, 'unborn.txt', 'not committed');
    expect(await service.probeBaseline(plain)).toMatchObject({ ok: false, reason: 'unborn' });
    expect(git(plain, ['status', '--porcelain=v1'])).toBe('?? unborn.txt');
    await write(source, 'a.txt', 'staged\n');
    git(source, ['add', 'a.txt']);
    await write(source, 'a.txt', 'unstaged\n');
    await write(source, 'new.txt', 'untracked\n');
    const before = await preserved();
    expect(await service.probeBaseline(source)).toMatchObject({ ok: false, reason: 'dirty', changes: [{ path: 'a.txt', status: 'MM' }, { path: 'new.txt', status: '??' }] });
    await expect(workspace('a1')).rejects.toMatchObject({ code: 'drift' });
    expect(await preserved()).toEqual(before);
    expect(await read(source, 'a.txt')).toEqual(Buffer.from('unstaged\n'));
    busy.add(source);
    expect(await service.probeBaseline(source)).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('blocks dirty source bytes hidden by a matching Git stat cache without refreshing its index', async () => {
    git(source, ['config', 'core.trustctime', 'false']);
    git(source, ['config', 'core.checkStat', 'minimal']);
    const oldTime = new Date('2000-01-01T00:00:00Z');
    await write(source, 'a.txt', 'AAAA');
    await fs.utimes(path.join(source, 'a.txt'), oldTime, oldTime);
    git(source, ['add', 'a.txt']);
    git(source, ['commit', '-m', 'Stat-cache baseline fixture']);
    await write(source, 'a.txt', 'BBBB');
    await fs.utimes(path.join(source, 'a.txt'), oldTime, oldTime);
    expect(git(source, ['status', '--porcelain=v1'])).toBe('');
    const before = await preserved();
    expect(await service.probeBaseline(source)).toMatchObject({ ok: false, reason: 'dirty', changes: [{ path: 'a.txt', status: ' M' }] });
    expect(await preserved()).toEqual(before);
    expect(await read(source, 'a.txt')).toEqual(Buffer.from('BBBB'));
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('never silently omits tracked edits hidden by %s', async (flag) => {
    git(source, ['update-index', flag, 'a.txt']);
    await write(source, 'a.txt', 'hidden local work\n');
    const before = await preserved();
    expect(await service.probeBaseline(source)).toMatchObject({ ok: false, reason: 'unsafe' });
    expect(await preserved()).toEqual(before);
    expect(await read(source, 'a.txt')).toEqual(Buffer.from('hidden local work\n'));
  });

  it('uses the actual source worktree commit and repository root, not the common checkout HEAD', async () => {
    const alternate = path.join(root, 'alternate');
    git(source, ['worktree', 'add', '-b', 'feature', alternate]);
    await write(alternate, 'feature.txt', 'feature\n');
    git(alternate, ['add', '.']);
    git(alternate, ['commit', '-m', 'Feature source']);
    const nested = path.join(alternate, 'nested');
    await fs.mkdir(nested);
    const before = await preserved();
    const result = await service.probeBaseline(nested);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.baseline.sourceRoot).toBe(await fs.realpath(alternate));
    expect(result.baseline.sourceCwd).toBe(await fs.realpath(nested));
    expect(result.baseline.revision.baseCommitSha).toBe(git(alternate, ['rev-parse', 'HEAD']));
    expect(result.baseline.revision.baseCommitSha).not.toBe(baseline.revision.baseCommitSha);
    const worker = await service.provision({ missionId: 'actual', baseline: result.baseline, role: 'worker', attemptId: 'a1' });
    expect(await read(worker.cwd, 'feature.txt')).toEqual(Buffer.from('feature\n'));
    expect(await preserved()).toEqual(before);
  });

  it('provisions separate stable lead/integration and per-attempt workers outside source, including branch-prefix collisions', async () => {
    git(source, ['branch', 'mission']);
    const before = await preserved();
    const lead = await service.provision({ missionId: 'm01', baseline, role: 'lead' });
    const integration = await service.provision({ missionId: 'm01', baseline, role: 'integration' });
    const a = await workspace('a1');
    const b = await workspace('a2');
    expect(new Set([lead.cwd, integration.cwd, a.cwd, b.cwd]).size).toBe(4);
    expect(new Set([lead.branch, integration.branch, a.branch, b.branch]).size).toBe(4);
    for (const item of [lead, integration, a, b]) {
      expect(path.relative(source, item.cwd).startsWith('..')).toBe(true);
      expect(item.branch).toMatch(/^mission-/);
      expect(git(item.cwd, ['rev-parse', 'HEAD'])).toBe(baseline.revision.baseCommitSha);
      expect((await fs.lstat(path.join(item.cwd, '.git'))).isFile()).toBe(true);
    }
    expect(await service.provision({ missionId: 'm01', baseline, role: 'lead' })).toEqual(lead);
    expect(await workspace('a1')).toEqual(a);
    await write(a.cwd, 'a.txt', 'isolated\n');
    expect(await read(b.cwd, 'a.txt')).toEqual(Buffer.from('base a\n'));
    expect(await preserved()).toEqual(before);
  });

  it('rejects storage inside source and never adopts a tampered ownership record or source checkout', async () => {
    const before = await preserved();
    const unsafe = new MissionWorkspaces({ root: path.join(source, '.mission'), quiescence: quiescence() });
    await expect(unsafe.provision({ missionId: 'm01', baseline, role: 'lead' })).rejects.toMatchObject({ code: 'unsafe' });
    expect(await preserved()).toEqual(before);
    const worker = await workspace('a1');
    const manifest = path.join(storage, 'workspaces', `${worker.id}.json`);
    const data = JSON.parse(await fs.readFile(manifest, 'utf8'));
    await fs.writeFile(manifest, JSON.stringify({ ...data, cwd: source }));
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'not_owned' });
    expect(await service.cleanup('unknown')).toMatchObject({ removed: false, reason: 'not_owned' });
    expect(await preserved()).toEqual(before);
    expect(await fs.stat(worker.cwd)).toBeDefined();
  });
});

describe('immutable candidate capture', () => {
  it('captures staged/unstaged, binary, Unicode/untracked, deletion and executable modes without changing either real index', async () => {
    const before = await preserved();
    const worker = await workspace('a1');
    await write(worker.cwd, 'a.txt', 'staged\n');
    git(worker.cwd, ['add', 'a.txt']);
    await write(worker.cwd, 'a.txt', 'effective unstaged\n');
    await write(worker.cwd, 'binary.bin', Buffer.from([0, 255, 13, 10, 200, 0, 1]));
    await write(worker.cwd, 'new space-é.txt', 'added\n');
    await fs.unlink(path.join(worker.cwd, 'delete.txt'));
    git(worker.cwd, ['update-index', '--chmod=+x', 'run.sh']);
    const workerBefore = await preserved(worker.cwd);
    const captured = await service.captureCandidate(worker.id, 'a1');
    expect(captured.changedPaths).toEqual(['a.txt', 'binary.bin', 'delete.txt', 'new space-é.txt', 'run.sh']);
    expect(captured.hostHash).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.revision.baseCommitSha).toBe(baseline.revision.baseCommitSha);
    expect(gitBytes(source, ['show', `${captured.revision.contentHash}:binary.bin`])).toEqual(Buffer.from([0, 255, 13, 10, 200, 0, 1]));
    expect(git(source, ['show', `${captured.revision.contentHash}:a.txt`])).toBe('effective unstaged');
    expect(git(source, ['show', `${captured.indexContentHash}:a.txt`])).toBe('staged');
    expect(git(source, ['ls-tree', captured.revision.contentHash, 'run.sh'])).toMatch(/^100755 /);
    expect(captured.changes.find((change) => change.path === 'delete.txt')).toMatchObject({ status: 'D', newMode: '000000' });
    expect(await preserved(worker.cwd)).toEqual(workerBefore);
    expect(await preserved()).toEqual(before);
    await write(worker.cwd, 'a.txt', 'later work\n');
    await write(worker.cwd, 'binary.bin', 'later binary');
    expect(await service.candidate(captured.id)).toEqual(captured);
    expect(git(source, ['show', `${captured.revision.contentHash}:a.txt`])).toBe('effective unstaged');
    expect(git(source, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('captures actual bytes even when the real index stat cache hides a same-size edit', async () => {
    const sourceBefore = await preserved();
    const worker = await workspace('a1');
    // A valid Git stat-cache hit can hide content without assume-unchanged/skip-worktree flags.
    // Keep the mtime safely older than the index so Git's racy-clean safeguard cannot save us.
    git(worker.cwd, ['config', 'core.trustctime', 'false']);
    git(worker.cwd, ['config', 'core.checkStat', 'minimal']);
    const oldTime = new Date('2000-01-01T00:00:00Z');
    await write(worker.cwd, 'a.txt', 'AAAA');
    await fs.utimes(path.join(worker.cwd, 'a.txt'), oldTime, oldTime);
    git(worker.cwd, ['add', 'a.txt']);
    await write(worker.cwd, 'a.txt', 'BBBB');
    await fs.utimes(path.join(worker.cwd, 'a.txt'), oldTime, oldTime);
    expect(git(worker.cwd, ['diff', '--', 'a.txt'])).toBe('');
    expect(git(worker.cwd, ['show', ':a.txt'])).toBe('AAAA');
    const before = await preserved(worker.cwd);
    const captured = await service.captureCandidate(worker.id, 'a1', 'c_stat');
    expect(gitBytes(source, ['show', `${captured.revision.contentHash}:a.txt`])).toEqual(Buffer.from('BBBB'));
    expect(gitBytes(source, ['show', `${captured.indexContentHash}:a.txt`])).toEqual(Buffer.from('AAAA'));
    expect(captured.revision.contentHash).not.toBe(captured.indexContentHash);
    expect(captured.changedPaths).toEqual(['a.txt']);
    expect(await service.contentIdentity(worker.cwd)).toEqual(captured.revision);
    expect(await preserved(worker.cwd)).toEqual(before);
    expect(await read(worker.cwd, 'a.txt')).toEqual(Buffer.from('BBBB'));
    expect(await preserved()).toEqual(sourceBefore);
  });

  it('retains staged modes and ignored intent-to-add bytes with a split index without altering its shared cache', async () => {
    const worker = await workspace('a1');
    git(worker.cwd, ['config', 'core.splitIndex', 'true']);
    await write(worker.cwd, 'a.txt', 'staged\n');
    git(worker.cwd, ['add', 'a.txt']);
    await write(worker.cwd, 'a.txt', 'unstaged\n');
    git(worker.cwd, ['update-index', '--chmod=+x', 'run.sh']);
    await fs.mkdir(path.join(worker.cwd, 'ignored'));
    await write(worker.cwd, 'ignored/intent.bin', Buffer.from([0, 255, 128, 42]));
    await write(worker.cwd, 'intent.txt', 'intent bytes\n');
    git(worker.cwd, ['add', '--intent-to-add', '--force', 'ignored/intent.bin', 'intent.txt']);
    const shared = git(worker.cwd, ['rev-parse', '--shared-index-path']);
    expect(shared).not.toBe('');
    const sharedFile = path.resolve(worker.cwd, shared);
    const sharedBefore = await fs.readFile(sharedFile);
    const before = await preserved(worker.cwd);
    const sourceBefore = await preserved();
    const captured = await service.captureCandidate(worker.id, 'a1', 'c_intent');
    expect(captured.changedPaths).toEqual(['a.txt', 'ignored/intent.bin', 'intent.txt', 'run.sh']);
    expect(git(source, ['show', `${captured.indexContentHash}:a.txt`])).toBe('staged');
    expect(git(source, ['ls-tree', '-r', '--name-only', captured.indexContentHash])).not.toContain('intent');
    expect(git(source, ['show', `${captured.revision.contentHash}:a.txt`])).toBe('unstaged');
    expect(gitBytes(source, ['show', `${captured.revision.contentHash}:ignored/intent.bin`])).toEqual(Buffer.from([0, 255, 128, 42]));
    expect(git(source, ['show', `${captured.revision.contentHash}:intent.txt`])).toBe('intent bytes');
    expect(git(source, ['ls-tree', captured.revision.contentHash, 'run.sh'])).toMatch(/^100755 /);
    expect(await preserved(worker.cwd)).toEqual(before);
    expect(await fs.readFile(sharedFile)).toEqual(sharedBefore);
    expect(await preserved()).toEqual(sourceBefore);
    expect(await read(worker.cwd, 'ignored/intent.bin')).toEqual(Buffer.from([0, 255, 128, 42]));
  });

  it('refuses an active writer, retains later work on drift, and does not accept a worker-supplied artifact hash', async () => {
    const worker = await workspace('a1');
    busy.add(worker.cwd);
    await expect(service.captureCandidate(worker.id, 'a1')).rejects.toMatchObject({ code: 'busy' });
    busy.delete(worker.cwd);
    await write(worker.cwd, 'a.txt', 'candidate\n');
    const captured = await service.captureCandidate(worker.id, 'a1');
    await write(worker.cwd, 'a.txt', 'human edit after capture\n');
    await expect(service.materializeAccepted(worker.id, captured.fingerprint)).rejects.toMatchObject({ code: 'drift' });
    expect(await read(worker.cwd, 'a.txt')).toEqual(Buffer.from('human edit after capture\n'));
    const artifact = path.join(storage, 'candidates', `${captured.id}.json`);
    const data = JSON.parse(await fs.readFile(artifact, 'utf8'));
    await fs.writeFile(artifact, JSON.stringify({ ...data, changedPaths: ['worker-claim.txt'] }));
    await expect(service.candidate(captured.id)).rejects.toMatchObject({ code: 'storage' });
  });

  it('rejects case-aliased staged paths rather than retaining a tree that cannot be materialized portably', async () => {
    const worker = await workspace('aliases');
    const blob = git(worker.cwd, ['rev-parse', ':a.txt']);
    git(worker.cwd, ['-c', 'core.ignorecase=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},A.txt`]);
    expect(git(worker.cwd, ['ls-files'])).toContain('A.txt');
    const before = await preserved(worker.cwd);
    const sourceBefore = await preserved();
    await expect(service.captureCandidate(worker.id, 'aliases', 'c_alias')).rejects.toMatchObject({ code: 'unsafe' });
    expect(await service.candidatesForAttempt('m01', 'aliases')).toEqual([]);
    expect(await preserved(worker.cwd)).toEqual(before);
    expect(await read(worker.cwd, 'a.txt')).toEqual(Buffer.from('base a\n'));
    expect(await preserved()).toEqual(sourceBefore);
  });

  it.each(['AUX.txt', 'NUL', 'COM1.log'])('rejects the reserved Git path %s before any capture can read a device alias', async (name) => {
    const worker = await workspace('reserved-path');
    const blob = git(worker.cwd, ['rev-parse', ':a.txt']);
    git(worker.cwd, ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},${name}`]);
    const indexFile = git(worker.cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const indexBefore = await fs.readFile(indexFile);
    const sourceBefore = await preserved();
    await expect(service.captureCandidate(worker.id, 'reserved-path', 'c_reserved')).rejects.toMatchObject({ code: 'unsafe' });
    expect(await fs.readFile(indexFile)).toEqual(indexBefore);
    expect(await read(worker.cwd, 'a.txt')).toEqual(Buffer.from('base a\n'));
    expect(await service.candidatesForAttempt('m01', 'reserved-path')).toEqual([]);
    expect(await preserved()).toEqual(sourceBefore);
  });

  it('blocks submodule trees and symlink/junction capture or refresh escapes without touching the target', async () => {
    const worker = await workspace('a1');
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await write(outside, 'secret.txt', 'untouched\n');
    const link = path.join(worker.cwd, 'escape');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(service.captureCandidate(worker.id, 'a1')).rejects.toMatchObject({ code: 'unsafe' });
    await expect(service.materializeAccepted(worker.id, worker.fingerprint)).rejects.toMatchObject({ code: 'unsafe' });
    expect(await read(outside, 'secret.txt')).toEqual(Buffer.from('untouched\n'));
    await fs.unlink(link);
    git(source, ['update-index', '--add', '--cacheinfo', `160000,${baseline.revision.baseCommitSha},submodule`]);
    git(source, ['commit', '-m', 'Unsupported gitlink fixture']);
    await fs.mkdir(path.join(source, 'submodule'));
    expect(await service.probeBaseline(source)).toMatchObject({ ok: false, reason: 'unsafe' });
  });
});

describe('owned content identity and held quiescence', () => {
  it('reads effective code without staging or accounting it and rejects busy or unowned directories', async () => {
    const worker = await workspace('identity');
    await write(worker.cwd, 'a.txt', 'staged\n');
    git(worker.cwd, ['add', 'a.txt']);
    await write(worker.cwd, 'a.txt', 'effective\n');
    await write(worker.cwd, 'new.bin', Buffer.from([0, 255, 7]));
    const before = await preserved(worker.cwd);
    const sourceBefore = await preserved();
    const identity = await service.contentIdentity(worker.cwd);
    expect(identity.baseCommitSha).toBe(baseline.revision.baseCommitSha);
    expect(git(source, ['show', `${identity.contentHash}:a.txt`])).toBe('effective');
    expect(gitBytes(source, ['show', `${identity.contentHash}:new.bin`])).toEqual(Buffer.from([0, 255, 7]));
    expect(await service.workspace(worker.id)).toEqual(worker);
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'uncaptured' });
    expect(await service.isOwnedDirectory(worker.cwd)).toBe(true);
    expect(await service.workspaceAt(worker.cwd)).toEqual(worker);
    await fs.mkdir(path.join(worker.cwd, 'nested'));
    const stray = path.join(storage, 'worktrees', 'unrecorded');
    await fs.mkdir(stray);
    for (const cwd of [source, storage, path.dirname(worker.cwd), path.join(worker.cwd, 'nested'), stray, `${worker.cwd}${path.sep}nested${path.sep}..`]) {
      expect(await service.isOwnedDirectory(cwd)).toBe(false);
      await expect(service.contentIdentity(cwd)).rejects.toBeDefined();
    }
    busy.add(worker.cwd);
    await expect(service.contentIdentity(worker.cwd)).rejects.toMatchObject({ code: 'busy' });
    busy.delete(worker.cwd);
    expect(await preserved(worker.cwd)).toEqual(before);
    expect(await preserved()).toEqual(sourceBefore);
    expect(await read(worker.cwd, 'a.txt')).toEqual(Buffer.from('effective\n'));
  });

  it('reuses only the calling async owner\'s live lease, never a concurrent or expired lease', async () => {
    const worker = await workspace('lease');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void;
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    let runDelayed!: () => void;
    const delay = new Promise<void>((resolve) => { runDelayed = resolve; });
    let delayed!: Promise<unknown>;
    const owner = service.withQuiescence(worker.cwd, async () => {
      expect(held.has(worker.cwd)).toBe(true);
      expect(await service.contentIdentity(worker.cwd)).toEqual(baseline.revision);
      delayed = delay.then(() => service.contentIdentity(worker.cwd));
      entered();
      await proceed;
      expect(held.has(worker.cwd)).toBe(true);
      return 'checked';
    });
    await started;
    try {
      await expect(service.contentIdentity(worker.cwd)).rejects.toMatchObject({ code: 'busy' });
    } finally { resume(); }
    expect(await owner).toBe('checked');
    expect(held.has(worker.cwd)).toBe(false);
    busy.add(worker.cwd);
    const refused = expect(delayed).rejects.toMatchObject({ code: 'busy' });
    runDelayed();
    await refused;
    busy.delete(worker.cwd);
    await expect(service.withQuiescence(worker.cwd, async () => { throw new Error('check failed'); })).rejects.toThrow('check failed');
    expect(held.has(worker.cwd)).toBe(false);
  });

  it('rejects directory/admin junctions and changed branch ownership without touching their targets', async () => {
    const worker = await workspace('ownership');
    const sourceBefore = await preserved();
    const alias = path.join(root, 'alias');
    await fs.symlink(worker.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await service.isOwnedDirectory(alias)).toBe(false);
    await expect(service.contentIdentity(alias)).rejects.toMatchObject({ code: 'not_owned' });
    await fs.unlink(alias);
    const moved = path.join(root, 'moved');
    await fs.rename(worker.cwd, moved);
    await fs.symlink(moved, worker.cwd, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await service.isOwnedDirectory(worker.cwd)).toBe(false);
    await expect(service.contentIdentity(worker.cwd)).rejects.toMatchObject({ code: 'not_owned' });
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'not_owned' });
    expect(await read(moved, 'a.txt')).toEqual(Buffer.from('base a\n'));
    await fs.unlink(worker.cwd);
    await fs.rename(moved, worker.cwd);
    const gitDir = git(worker.cwd, ['rev-parse', '--absolute-git-dir']);
    const movedAdmin = path.join(root, 'moved-admin');
    const indexBefore = await fs.readFile(path.join(gitDir, 'index'));
    await fs.rename(gitDir, movedAdmin);
    await fs.symlink(movedAdmin, gitDir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await service.isOwnedDirectory(worker.cwd)).toBe(false);
    await expect(service.workspaceAt(worker.cwd)).rejects.toMatchObject({ code: 'unsafe' });
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'not_owned' });
    expect(await fs.readFile(path.join(movedAdmin, 'index'))).toEqual(indexBefore);
    await fs.unlink(gitDir);
    await fs.rename(movedAdmin, gitDir);
    git(worker.cwd, ['switch', '-c', 'external-identity']);
    expect(await service.isOwnedDirectory(worker.cwd)).toBe(false);
    await expect(service.contentIdentity(worker.cwd)).rejects.toMatchObject({ code: 'not_owned' });
    expect(await preserved()).toEqual(sourceBefore);
  });

  it('blocks a real sparse-checkout index instead of treating omitted files as candidate deletions', async () => {
    const worker = await workspace('sparse-checkout');
    await fs.mkdir(path.join(worker.cwd, 'hidden'));
    await write(worker.cwd, 'hidden/local.txt', 'staged before sparse\n');
    git(worker.cwd, ['add', 'hidden/local.txt']);
    git(worker.cwd, ['sparse-checkout', 'set', '--no-cone', '/a.txt']);
    expect(git(worker.cwd, ['ls-files', '-v'])).toMatch(/^S /m);
    const before = await preserved(worker.cwd);
    const sourceBefore = await preserved();
    await expect(service.contentIdentity(worker.cwd)).rejects.toMatchObject({ code: 'unsafe' });
    await expect(service.captureCandidate(worker.id, 'sparse-checkout', 'c_sparse')).rejects.toMatchObject({ code: 'unsafe' });
    expect(await preserved(worker.cwd)).toEqual(before);
    expect(await preserved()).toEqual(sourceBefore);
    expect(git(worker.cwd, ['show', ':hidden/local.txt'])).toBe('staged before sparse');
  });

  it.each(['sparse', 'submodule'] as const)('fails closed on %s entries without changing source/index/bytes', async (kind) => {
    const worker = await workspace('unsafe');
    if (kind === 'sparse') {
      git(worker.cwd, ['update-index', '--skip-worktree', 'a.txt']);
      await write(worker.cwd, 'a.txt', 'hidden\n');
    } else {
      git(worker.cwd, ['update-index', '--add', '--cacheinfo', `160000,${baseline.revision.baseCommitSha},submodule`]);
      await fs.mkdir(path.join(worker.cwd, 'submodule'));
    }
    const before = await preserved(worker.cwd);
    const sourceBefore = await preserved();
    await expect(service.contentIdentity(worker.cwd)).rejects.toMatchObject({ code: 'unsafe' });
    await expect(service.captureCandidate(worker.id, 'unsafe', 'c_unsafe')).rejects.toMatchObject({ code: 'unsafe' });
    expect(await preserved(worker.cwd)).toEqual(before);
    expect(await preserved()).toEqual(sourceBefore);
    expect(await read(worker.cwd, 'a.txt')).toEqual(Buffer.from(kind === 'sparse' ? 'hidden\n' : 'base a\n'));
  });
});

describe('checked integration, CAS, and materialization', () => {
  it('serializes concurrent promotion and returns stale without running the second check', async () => {
    const before = await preserved();
    const a = await workspace('a1');
    const b = await workspace('a2');
    await write(a.cwd, 'a.txt', 'accepted a\n');
    await write(b.cwd, 'b.txt', 'accepted b\n');
    const ca = await service.captureCandidate(a.id, 'a1');
    const cb = await service.captureCandidate(b.id, 'a2');
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const first = service.integrate({ missionId: 'm01', candidateId: ca.id, expectedAccepted: baseline.revision, check: async ({ workspace: attempt, revision }) => {
      expect(attempt.cwd).not.toBe(a.cwd);
      expect(revision.contentHash).toBe(ca.revision.contentHash);
      expect(await read(attempt.cwd, 'a.txt')).toEqual(Buffer.from('accepted a\n'));
      entered();
      await finish;
      return true;
    } });
    await checking;
    const secondCheck = vi.fn(async () => true);
    const second = service.integrate({ missionId: 'm01', candidateId: cb.id, expectedAccepted: baseline.revision, check: secondCheck });
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe('accepted');
    expect(two.status).toBe('stale');
    expect(secondCheck).not.toHaveBeenCalled();
    expect(await service.acceptedRevision('m01')).toEqual(ca.revision);
    expect(await preserved()).toEqual(before);
  });

  it('merges immutable deltas into accepted overlays, refreshes a yielded worker, and creates no checkpoint commits', async () => {
    const before = await preserved();
    const a = await workspace('a1');
    const b = await workspace('a2');
    const consumer = await workspace('a3');
    await write(a.cwd, 'a.txt', 'accepted a\n');
    const binary = Buffer.from([0, 255, 128, 13, 10, 0]);
    await write(a.cwd, 'image.bin', binary);
    await fs.unlink(path.join(a.cwd, 'delete.txt'));
    await write(b.cwd, 'b.txt', 'accepted b\n');
    const ca = await service.captureCandidate(a.id, 'a1');
    const cb = await service.captureCandidate(b.id, 'a2');
    await write(a.cwd, 'a.txt', 'a is already writing another candidate\n');
    busy.add(a.cwd);
    const first = await service.integrate({ missionId: 'm01', candidateId: ca.id, expectedAccepted: baseline.revision, check: async () => true });
    expect(first.status).toBe('accepted');
    const second = await service.integrate({ missionId: 'm01', candidateId: cb.id, expectedAccepted: first.revision, check: async ({ workspace: attempt }) => {
      expect(await read(attempt.cwd, 'a.txt')).toEqual(Buffer.from('accepted a\n'));
      expect(await read(attempt.cwd, 'b.txt')).toEqual(Buffer.from('accepted b\n'));
      expect(await read(attempt.cwd, 'image.bin')).toEqual(binary);
      return true;
    } });
    expect(second.status).toBe('accepted');
    expect(await read(a.cwd, 'a.txt')).toEqual(Buffer.from('a is already writing another candidate\n'));
    busy.add(consumer.cwd);
    await expect(service.materializeAccepted(consumer.id, consumer.fingerprint)).rejects.toMatchObject({ code: 'busy' });
    busy.delete(consumer.cwd);
    const refreshed = await service.materializeAccepted(consumer.id, consumer.fingerprint);
    expect(refreshed.baseRevision).toEqual(second.revision);
    expect(await read(consumer.cwd, 'image.bin')).toEqual(binary);
    expect(await read(consumer.cwd, 'a.txt')).toEqual(Buffer.from('accepted a\n'));
    expect(await read(consumer.cwd, 'b.txt')).toEqual(Buffer.from('accepted b\n'));
    await expect(read(consumer.cwd, 'delete.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(consumer.cwd, ['rev-parse', 'HEAD'])).toBe(baseline.revision.baseCommitSha);
    expect(git(source, ['rev-list', '--branches', '--count'])).toBe('1');
    const restarted = new MissionWorkspaces({ root: storage, quiescence: quiescence() });
    expect(await restarted.acceptedRevision('m01')).toEqual(second.revision);
    expect(await restarted.candidate(ca.id)).toEqual(ca);
    expect(await preserved()).toEqual(before);
  });

  it('does not overwrite ignored obstructions when materializing an accepted file', async () => {
    const worker = await workspace('a1');
    const consumer = await workspace('a2');
    await fs.mkdir(path.join(worker.cwd, 'ignored'));
    await write(worker.cwd, 'ignored/state.db', 'accepted file\n');
    git(worker.cwd, ['add', '-f', 'ignored/state.db']);
    const captured = await service.captureCandidate(worker.id, 'a1');
    const integrated = await service.integrate({ missionId: 'm01', candidateId: captured.id, expectedAccepted: baseline.revision, check: async () => true });
    expect(integrated.status).toBe('accepted');
    await fs.mkdir(path.join(consumer.cwd, 'ignored'));
    await write(consumer.cwd, 'ignored/state.db', 'local ignored data\n');
    const before = await preserved(consumer.cwd);
    await expect(service.materializeAccepted(consumer.id, consumer.fingerprint)).rejects.toMatchObject({ code: 'drift' });
    expect(await read(consumer.cwd, 'ignored/state.db')).toEqual(Buffer.from('local ignored data\n'));
    expect(await preserved(consumer.cwd)).toEqual(before);
  });

  it('does not promote when the durable promotion intent fails to write', async () => {
    const worker = await workspace('a1');
    await write(worker.cwd, 'a.txt', 'candidate\n');
    const captured = await service.captureCandidate(worker.id, 'a1');
    const rename = fs.rename.bind(fs);
    let failed = false;
    await expect(service.integrate({ missionId: 'm01', candidateId: captured.id, expectedAccepted: baseline.revision, check: async ({ workspace: attempt }) => {
      const manifest = path.join(storage, 'workspaces', `${attempt.id}.json`);
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === manifest && JSON.parse(await fs.readFile(from, 'utf8')).integration?.status === 'promoting') {
          failed = true;
          throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
        }
        return rename(from, to);
      });
      return true;
    } })).rejects.toThrow('fixture disk failure');
    vi.restoreAllMocks();
    expect(failed).toBe(true);
    const restarted = new MissionWorkspaces({ root: storage, quiescence: quiescence() });
    expect(await restarted.acceptedRevision('m01')).toEqual(baseline.revision);
    expect(await restarted.candidate(captured.id)).toEqual(captured);
  });

  it('retains conflicting and rejected attempts and never advances acceptance on a clean merge alone', async () => {
    const a = await workspace('a1');
    const b = await workspace('a2');
    await write(a.cwd, 'a.txt', 'first\n');
    await write(b.cwd, 'a.txt', 'conflicting second\n');
    const ca = await service.captureCandidate(a.id, 'a1');
    const cb = await service.captureCandidate(b.id, 'a2');
    const rejected = await service.integrate({ missionId: 'm01', candidateId: ca.id, expectedAccepted: baseline.revision, check: async () => false });
    expect(rejected.status).toBe('rejected');
    expect(await service.acceptedRevision('m01')).toEqual(baseline.revision);
    expect(rejected.workspace).toBeDefined();
    expect(await read(rejected.workspace!.cwd, 'a.txt')).toEqual(Buffer.from('first\n'));
    // A known rejection remains immutable. A deliberately new capture is a fresh attempt,
    // not permission to rerun the old candidate/base integration under another check callback.
    const retry = await service.captureCandidate(a.id, 'a1', 'c_retry_rejected');
    const first = await service.integrate({ missionId: 'm01', candidateId: retry.id, expectedAccepted: baseline.revision, check: async () => true });
    expect(first.status).toBe('accepted');
    const check = vi.fn(async () => true);
    const conflict = await service.integrate({ missionId: 'm01', candidateId: cb.id, expectedAccepted: first.revision, check });
    expect(conflict.status).toBe('conflict');
    expect(check).not.toHaveBeenCalled();
    expect(git(conflict.workspace!.cwd, ['ls-files', '--unmerged'])).not.toBe('');
    expect((await read(conflict.workspace!.cwd, 'a.txt')).toString()).toContain('<<<<<<<');
    expect(await service.acceptedRevision('m01')).toEqual(first.revision);
    expect(await read(b.cwd, 'a.txt')).toEqual(Buffer.from('conflicting second\n'));
    expect(await service.cleanup(conflict.workspace!.id)).toMatchObject({ removed: false });
  });

  it('rejects check-time content drift and uses a Git-level CAS even against another process', async () => {
    const worker = await workspace('a1');
    await write(worker.cwd, 'a.txt', 'candidate\n');
    const captured = await service.captureCandidate(worker.id, 'a1');
    const changed = await service.integrate({ missionId: 'm01', candidateId: captured.id, expectedAccepted: baseline.revision, check: async ({ workspace: attempt }) => {
      await write(attempt.cwd, 'a.txt', 'not the checked candidate\n');
      return true;
    } });
    expect(changed.status).toBe('changed');
    expect(await service.acceptedRevision('m01')).toEqual(baseline.revision);
    expect(await read(changed.workspace!.cwd, 'a.txt')).toEqual(Buffer.from('not the checked candidate\n'));
    const ref = git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions']).split('\n').find((name) => name.endsWith('/accepted'))!;
    const retry = await service.captureCandidate(worker.id, 'a1', 'c_retry_changed');
    const cas = await service.integrate({ missionId: 'm01', candidateId: retry.id, expectedAccepted: baseline.revision, check: async () => {
      git(source, ['update-ref', ref, captured.revision.contentHash, baseline.revision.contentHash]);
      return true;
    } });
    expect(cas.status).toBe('stale');
    expect(await service.acceptedRevision('m01')).toEqual(captured.revision);
  });
});

describe('explicit non-force cleanup', () => {
  it('preserves active, uncaptured, changed-after-capture and ignored bytes; removes only positively owned captured work', async () => {
    const before = await preserved();
    const worker = await workspace('a1');
    busy.add(worker.cwd);
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'busy' });
    busy.delete(worker.cwd);
    await write(worker.cwd, 'new.bin', Buffer.from([0, 255, 0, 127]));
    const unaccounted = await preserved(worker.cwd);
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'uncaptured' });
    expect(await preserved(worker.cwd)).toEqual(unaccounted);
    await write(worker.cwd, 'a.txt', 'staged retained\n');
    git(worker.cwd, ['add', 'a.txt']);
    await write(worker.cwd, 'a.txt', 'effective retained\n');
    const captured = await service.captureCandidate(worker.id, 'a1');
    await write(worker.cwd, 'new.bin', 'later');
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'uncaptured' });
    await write(worker.cwd, 'new.bin', Buffer.from([0, 255, 0, 127]));
    await fs.mkdir(path.join(worker.cwd, 'ignored'));
    await write(worker.cwd, 'ignored/state.db', 'uncaptured ignored state');
    expect(await service.cleanup(worker.id)).toMatchObject({ removed: false, reason: 'uncaptured' });
    expect(await read(worker.cwd, 'ignored/state.db')).toEqual(Buffer.from('uncaptured ignored state'));
    await fs.unlink(path.join(worker.cwd, 'ignored/state.db'));
    await fs.rmdir(path.join(worker.cwd, 'ignored'));
    expect(await service.cleanup(worker.id)).toEqual({ removed: true });
    await expect(fs.stat(worker.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(source, ['worktree', 'list', '--porcelain'])).not.toContain(worker.id);
    expect(git(source, ['show', `${captured.indexContentHash}:a.txt`])).toBe('staged retained');
    expect(git(source, ['show', `${captured.revision.contentHash}:a.txt`])).toBe('effective retained');
    expect(gitBytes(source, ['show', `${captured.revision.contentHash}:new.bin`])).toEqual(Buffer.from([0, 255, 0, 127]));
    expect(await service.candidate(captured.id)).toEqual(captured);
    expect(await preserved()).toEqual(before);
  });

  it('can remove a clean workspace but retains a locked worktree instead of forcing removal', async () => {
    const clean = await workspace('clean');
    expect(await service.cleanup(clean.id)).toEqual({ removed: true });
    const locked = await workspace('locked');
    git(source, ['worktree', 'lock', locked.cwd]);
    expect(await service.cleanup(locked.id)).toMatchObject({ removed: false, reason: 'git_refused' });
    expect(await read(locked.cwd, 'a.txt')).toEqual(Buffer.from('base a\n'));
    expect(git(source, ['worktree', 'list', '--porcelain'])).toContain(locked.id);
    git(source, ['worktree', 'unlock', locked.cwd]);
  });
});
