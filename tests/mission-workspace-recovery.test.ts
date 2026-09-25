/** Lost acknowledgments exercise real Git side effects and fresh host instances, never fake trees. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '../src/main/runtime';
import { MissionWorkspaces, type MissionBaseline, type WorkspaceQuiescenceProvider } from '../src/main/mission/workspaces';

let root: string;
let source: string;
let storage: string;
let service: MissionWorkspaces;
let baseline: MissionBaseline;
let held: Set<string>;
let busy: Set<string>;

function git(cwd: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.toString() || String(result.error));
  return result.stdout.toString().trim();
}

const write = (cwd: string, name: string, text: string): Promise<void> => fs.writeFile(path.join(cwd, name), text);
const text = (cwd: string, name: string): Promise<string> => fs.readFile(path.join(cwd, name), 'utf8');
const manifest = (id: string): string => path.join(storage, 'workspaces', `${id}.json`);
const worker = (workspaceId = 'w_fixed', attemptId = 'a1', missionId = 'm01') => service.provision({ missionId, baseline, role: 'worker', attemptId, workspaceId });

function restart(): MissionWorkspaces {
  const quiescence: WorkspaceQuiescenceProvider = { acquire: async (cwd) => {
    if (held.has(cwd) || busy.has(cwd)) return null;
    held.add(cwd);
    return {
      assertQuiescent: async () => { if (!held.has(cwd) || busy.has(cwd)) throw new Error('Writer resumed'); },
      release: () => { held.delete(cwd); },
    };
  } };
  return new MissionWorkspaces({ root: storage, quiescence });
}

async function preserved(cwd = source) {
  return {
    head: git(cwd, ['rev-parse', 'HEAD']),
    index: await fs.readFile(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])),
    status: git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
    file: await text(cwd, 'a.txt'),
  };
}

function failGit(match: (args: string[]) => boolean, when: 'before' | 'after') {
  const original = runtime.runCapture;
  let failures = 0;
  const spy = vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
    if (!match(args) || failures) return original(cmd, args, opts);
    failures++;
    if (when === 'after') {
      const result = await original(cmd, args, opts);
      expect(result.code).toBe(0);
    }
    throw new Error(`lost ${when} Git acknowledgment`);
  });
  return { restore: () => { expect(failures).toBe(1); spy.mockRestore(); } };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission recovery-'));
  source = path.join(root, 'source');
  storage = path.join(root, 'owned');
  await fs.mkdir(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Mission Recovery Test']);
  git(source, ['config', 'user.email', 'mission-recovery@example.invalid']);
  git(source, ['config', 'commit.gpgsign', 'false']);
  git(source, ['config', 'core.autocrlf', 'false']);
  await write(source, 'a.txt', 'base\n');
  await write(source, '.gitignore', 'ignored/\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Fixture baseline']);
  held = new Set();
  busy = new Set();
  service = restart();
  const probe = await service.probeBaseline(source);
  if (!probe.ok) throw new Error(probe.message);
  baseline = probe.baseline;
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(held.size).toBe(0);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('stable dispatch and capture receipts', () => {
  it('returns an identical preallocated capture after later writes and scopes complete attempt manifests', async () => {
    const before = await preserved();
    const first = await worker();
    expect(first.id).toBe('w_fixed');
    await write(first.cwd, 'a.txt', 'candidate\n');
    const candidate = await service.captureCandidate(first.id, 'a1', 'c_fixed');
    expect(candidate.id).toBe('c_fixed');
    await write(first.cwd, 'a.txt', 'later uncaptured\n');
    busy.add(first.cwd);
    service = restart();
    expect(await service.captureCandidate(first.id, 'a1', 'c_fixed')).toEqual(candidate);
    busy.delete(first.cwd);
    expect(await service.candidatesForAttempt('m01', 'a1')).toEqual([candidate]);
    expect(await service.candidatesForAttempt('m01', 'a2')).toEqual([]);
    const other = await worker('w_other', 'a1', 'm02');
    await expect(service.captureCandidate(other.id, 'a1', 'c_fixed')).rejects.toMatchObject({ code: 'not_owned' });
    expect(await service.candidatesForAttempt('m02', 'a1')).toEqual([]);
    expect(await service.workspace(first.id)).toEqual({ ...first, fingerprint: candidate.fingerprint });
    expect(await service.cleanup(first.id)).toMatchObject({ removed: false, reason: 'uncaptured' });
    expect(await text(first.cwd, 'a.txt')).toBe('later uncaptured\n');
    expect(await preserved()).toEqual(before);
  });

  it.each(['before', 'after'] as const)('recovers the same capture when its retention write loses the %s acknowledgment', async (when) => {
    const first = await worker();
    await write(first.cwd, 'a.txt', 'candidate\n');
    const failure = failGit((args) => args.includes('update-ref') && args.some((arg) => arg.includes('/retained/') && arg.endsWith('/tree')), when);
    await expect(service.captureCandidate(first.id, 'a1', 'c_fixed')).rejects.toThrow('acknowledgment');
    failure.restore();
    await write(first.cwd, 'a.txt', 'later uncaptured\n');
    service = restart();
    const candidate = await service.captureCandidate(first.id, 'a1', 'c_fixed');
    expect(git(source, ['show', `${candidate.revision.contentHash}:a.txt`])).toBe('candidate');
    expect(await service.captureCandidate(first.id, 'a1', 'c_fixed')).toEqual(candidate);
    expect(await service.candidatesForAttempt('m01', 'a1')).toEqual([candidate]);
    expect(await text(first.cwd, 'a.txt')).toBe('later uncaptured\n');
    expect(await service.cleanup(first.id)).toMatchObject({ removed: false, reason: 'uncaptured' });
  });

  it.each(['before', 'after'] as const)('returns one immutable receipt when candidate publication fails %s the side effect', async (when) => {
    const first = await worker();
    await write(first.cwd, 'a.txt', 'captured before publication\n');
    const before = await preserved();
    const link = fs.link.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (!failed && String(to) === path.join(storage, 'candidates', 'c_fixed.json')) {
        failed = true;
        if (when === 'after') await link(from, to);
        throw Object.assign(new Error('lost candidate publication acknowledgment'), { code: 'EIO' });
      }
      return link(from, to);
    });
    await expect(service.captureCandidate(first.id, 'a1', 'c_fixed')).rejects.toThrow('publication acknowledgment');
    vi.restoreAllMocks();
    expect(failed).toBe(true);
    await write(first.cwd, 'a.txt', 'newer writer bytes\n');
    service = restart();
    const candidate = await service.captureCandidate(first.id, 'a1', 'c_fixed');
    expect(git(source, ['show', `${candidate.revision.contentHash}:a.txt`])).toBe('captured before publication');
    expect(await service.candidatesForAttempt('m01', 'a1')).toEqual([candidate]);
    expect(await service.captureCandidate(first.id, 'a1', 'c_fixed')).toEqual(candidate);
    expect(await text(first.cwd, 'a.txt')).toBe('newer writer bytes\n');
    expect(await preserved()).toEqual(before);
  });

  it('does not reinterpret an interrupted capture as later source bytes', async () => {
    const first = await worker();
    await write(first.cwd, 'a.txt', 'first snapshot\n');
    const failure = failGit((args) => args.includes('add'), 'after');
    await expect(service.captureCandidate(first.id, 'a1', 'c_fixed')).rejects.toThrow('acknowledgment');
    failure.restore();
    await write(first.cwd, 'a.txt', 'later bytes\n');
    service = restart();
    await expect(service.captureCandidate(first.id, 'a1', 'c_fixed')).rejects.toMatchObject({ code: 'drift' });
    expect(await service.candidatesForAttempt('m01', 'a1')).toEqual([]);
    expect(await text(first.cwd, 'a.txt')).toBe('later bytes\n');
  });

  it('retains a drifted capture intent instead of binding it to bytes changed during Git capture', async () => {
    const first = await worker();
    await write(first.cwd, 'a.txt', 'staged\n');
    git(first.cwd, ['add', 'a.txt']);
    await write(first.cwd, 'a.txt', 'original effective\n');
    const indexFile = git(first.cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const indexBefore = await fs.readFile(indexFile);
    const sourceBefore = await preserved();
    const original = runtime.runCapture;
    let changed = 0;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      if (!changed && args.includes('add') && opts?.env?.GIT_INDEX_FILE) {
        changed++;
        await write(first.cwd, 'a.txt', 'changed during capture\n');
      }
      return original(cmd, args, opts);
    });
    await expect(service.captureCandidate(first.id, 'a1', 'c_fixed')).rejects.toMatchObject({ code: 'drift' });
    vi.restoreAllMocks();
    expect(changed).toBe(1);
    service = restart();
    await expect(service.captureCandidate(first.id, 'a1', 'c_fixed')).rejects.toMatchObject({ code: 'drift' });
    expect(await service.candidatesForAttempt('m01', 'a1')).toEqual([]);
    expect(await service.workspaceAt(first.cwd)).toEqual(first);
    const captured = await service.captureCandidate(first.id, 'a1', 'c_new');
    expect(git(source, ['show', `${captured.revision.contentHash}:a.txt`])).toBe('changed during capture');
    expect(git(source, ['show', `${captured.indexContentHash}:a.txt`])).toBe('staged');
    expect(await service.candidatesForAttempt('m01', 'a1')).toEqual([captured]);
    expect(await fs.readFile(indexFile)).toEqual(indexBefore);
    expect(await text(first.cwd, 'a.txt')).toBe('changed during capture\n');
    expect(await preserved()).toEqual(sourceBefore);
  });

  it('rejects case-aliased Mission/workspace/capture identities instead of reassigning their retained receipts', async () => {
    const first = await worker();
    await write(first.cwd, 'a.txt', 'captured\n');
    const captured = await service.captureCandidate(first.id, 'a1', 'c_fixed');
    const before = await preserved(first.cwd);
    const sourceBefore = await preserved();
    const recordBefore = await fs.readFile(manifest(first.id));
    const receiptBefore = await fs.readFile(path.join(storage, 'candidates', 'c_fixed.json'));
    await expect(worker('W_FIXED')).rejects.toMatchObject({ code: 'not_owned' });
    await expect(worker('w_other', 'a1', 'M01')).rejects.toMatchObject({ code: 'unsafe' });
    await expect(service.captureCandidate(first.id, 'a1', 'C_FIXED')).rejects.toMatchObject({ code: 'unsafe' });
    service = restart();
    expect(await service.workspaceAt(first.cwd)).toEqual({ ...first, fingerprint: captured.fingerprint });
    expect(await service.candidatesForAttempt('m01', 'a1')).toEqual([captured]);
    expect(await fs.readFile(manifest(first.id))).toEqual(recordBefore);
    expect(await fs.readFile(path.join(storage, 'candidates', 'c_fixed.json'))).toEqual(receiptBefore);
    expect(await preserved(first.cwd)).toEqual(before);
    expect(await preserved()).toEqual(sourceBefore);
    expect(git(source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(2);
  });

  it.each(['CON', 'nul', 'PrN', 'AUX', 'COM1', 'lpt9', '..', 'trailing.', 'a:b', 'a/b'])('rejects nonportable identity %s before side effects', async (id) => {
    const before = await preserved();
    await expect(worker(id)).rejects.toMatchObject({ code: 'unsafe' });
    await expect(worker('w_ok', id)).rejects.toMatchObject({ code: 'unsafe' });
    await expect(worker('w_ok', 'a1', id)).rejects.toMatchObject({ code: 'unsafe' });
    expect(git(source, ['worktree', 'list', '--porcelain'])).not.toContain('owned');
    expect(await preserved()).toEqual(before);
  });
});

describe('bounded refs and retained lead generations', () => {
  it('captures long nested operation identities using short deterministic refs across restart', async () => {
    const missionId = `m_${'m'.repeat(98)}`, workspaceId = `w_${'w'.repeat(98)}`, attemptId = `a_${'a'.repeat(98)}`, candidateId = `c_${'c'.repeat(98)}`;
    const before = await preserved();
    const first = await worker(workspaceId, attemptId, missionId);
    await write(first.cwd, 'a.txt', 'long operation content\n');
    const candidate = await service.captureCandidate(first.id, attemptId, candidateId);
    const refs = git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions']).split('\n');
    expect(refs.every((ref) => ref.length <= 120)).toBe(true);
    expect(refs.some((ref) => ref.includes(candidateId) || ref.includes(missionId))).toBe(false);
    service = restart();
    expect(await service.captureCandidate(first.id, attemptId, candidateId)).toEqual(candidate);
    expect(git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions']).split('\n')).toEqual(refs);
    expect(git(source, ['show', `${candidate.revision.contentHash}:a.txt`])).toBe('long operation content');
    expect(await preserved()).toEqual(before);
  }, 30_000);

  it('keeps legacy Mission namespaces and retained refs readable without renaming or deleting history', async () => {
    const first = await worker();
    const file = path.join(storage, 'missions', 'm01.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    const legacy = `refs/vocs-missions/${createHash('sha256').update(await fs.realpath(storage)).digest('hex').slice(0, 20)}/m01`;
    git(source, ['update-ref', `${legacy}/accepted`, baseline.revision.contentHash]);
    git(source, ['update-ref', `${legacy}/retained/w_fixed/c_original/tree`, baseline.revision.contentHash]);
    await fs.writeFile(file, JSON.stringify({ ...record, acceptedRef: `${legacy}/accepted` }));
    service = restart();
    expect(await service.acceptedRevision('m01')).toEqual(baseline.revision);
    await write(first.cwd, 'a.txt', 'new captured bytes\n');
    const captured = await service.captureCandidate(first.id, 'a1', 'c_new');
    expect((await service.integrate({ missionId: 'm01', candidateId: captured.id, expectedAccepted: baseline.revision, check: async () => true })).status).toBe('accepted');
    expect(git(source, ['rev-parse', `${legacy}/accepted`])).toBe(captured.revision.contentHash);
    expect(git(source, ['rev-parse', `${legacy}/retained/w_fixed/c_original/tree`])).toBe(baseline.revision.contentHash);
    expect(git(source, ['rev-parse', record.acceptedRef])).toBe(baseline.revision.contentHash);
    service = restart(); expect(await service.candidate(captured.id)).toEqual(captured);
  }, 30_000);

  it('retains explicit lead handover workspaces without selecting or overwriting an old generation', async () => {
    const first = await service.provision({ missionId: 'm01', baseline, role: 'lead', workspaceId: 'lead_first' });
    await write(first.cwd, 'a.txt', 'uncaptured old lead work\n');
    const before = await preserved(first.cwd), sourceBefore = await preserved();
    const second = await service.provision({ missionId: 'm01', baseline, role: 'lead', workspaceId: 'lead_second' });
    expect(second.id).not.toBe(first.id);
    expect(await text(second.cwd, 'a.txt')).toBe('base\n');
    service = restart();
    expect(await service.provision({ missionId: 'm01', baseline, role: 'lead', workspaceId: first.id })).toEqual(first);
    expect(await service.provision({ missionId: 'm01', baseline, role: 'lead', workspaceId: second.id })).toEqual(second);
    await expect(service.provision({ missionId: 'm01', baseline, role: 'lead' })).rejects.toThrow('current host-mapped');
    expect(await preserved(first.cwd)).toEqual(before);
    expect(await preserved()).toEqual(sourceBefore);
    expect(git(source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(3);
  }, 30_000);
});

describe('provision intent reconciliation', () => {
  it.each(['before', 'after'] as const)('recovers baseline ref initialization %s CAS without reprobe of changed user source', async (when) => {
    const failure = failGit((args) => args.includes('update-ref') && args.some((arg) => arg.endsWith('/accepted')), when);
    await expect(worker()).rejects.toThrow('acknowledgment');
    failure.restore();
    await write(source, 'a.txt', 'user resumed\n');
    const before = await preserved();
    service = restart();
    expect(await service.baseline('m01')).toEqual(baseline);
    const recovered = await worker();
    expect(recovered.id).toBe('w_fixed');
    expect(await text(recovered.cwd, 'a.txt')).toBe('base\n');
    expect(await service.acceptedRevision('m01')).toEqual(baseline.revision);
    expect(await preserved()).toEqual(before);
  });

  it.each([
    ['add', 'before'], ['add', 'after'], ['read-tree', 'before'], ['read-tree', 'after'],
  ] as const)('recovers %s %s the Git side effect without creating another branch or worktree', async (command, when) => {
    const before = await preserved();
    const failure = failGit((args) => command === 'add' ? args.includes('worktree') && args.includes('add') : args.includes(command) && args.includes('-u'), when);
    await expect(worker()).rejects.toThrow('acknowledgment');
    failure.restore();
    const intent = JSON.parse(await fs.readFile(manifest('w_fixed'), 'utf8'));
    service = restart();
    const recovered = await service.recoverWorkspace('w_fixed');
    expect(recovered.id).toBe('w_fixed');
    expect(recovered.branch).toBe(intent.branch);
    expect(await worker()).toEqual(recovered);
    expect(await service.reconcile(recovered.id)).toEqual(recovered);
    expect(await service.workspace(recovered.id)).toEqual(recovered);
    expect(git(source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(2);
    expect(git(source, ['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n')).toHaveLength(2);
    expect(await text(recovered.cwd, 'a.txt')).toBe('base\n');
    expect(git(source, ['rev-list', '--branches', '--count'])).toBe('1');
    expect(await preserved()).toEqual(before);
  });

  it.each(['before', 'after'] as const)('recovers a ready metadata write %s its atomic publication', async (when) => {
    const rename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to) === manifest('w_fixed') && JSON.parse(await fs.readFile(from, 'utf8')).state === 'ready') {
        failed = true;
        if (when === 'after') await rename(from, to);
        throw Object.assign(new Error('lost ready metadata acknowledgment'), { code: 'EIO' });
      }
      return rename(from, to);
    });
    await expect(worker()).rejects.toThrow('metadata acknowledgment');
    vi.restoreAllMocks();
    expect(failed).toBe(true);
    service = restart();
    const recovered = await worker();
    expect(recovered.id).toBe('w_fixed');
    expect(await service.workspace(recovered.id)).toEqual(recovered);
    expect(git(source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(2);
  });

  it.each(['content', 'head', 'branch', 'ignored'] as const)('blocks ambiguous %s after a lost checkout acknowledgment and retains all bytes', async (change) => {
    const failure = failGit((args) => args.includes('read-tree') && args.includes('-u'), 'after');
    await expect(worker()).rejects.toThrow('acknowledgment');
    failure.restore();
    const intent = JSON.parse(await fs.readFile(manifest('w_fixed'), 'utf8'));
    if (change === 'content') await write(intent.cwd, 'a.txt', 'uncertain writer\n');
    if (change === 'head') {
      await write(intent.cwd, 'a.txt', 'worker committed\n');
      git(intent.cwd, ['add', '.']);
      git(intent.cwd, ['commit', '-m', 'External worker fixture']);
    }
    if (change === 'branch') git(intent.cwd, ['switch', '-c', 'external']);
    if (change === 'ignored') {
      await fs.mkdir(path.join(intent.cwd, 'ignored'));
      await write(intent.cwd, 'ignored/state', 'uncaptured\n');
    }
    const before = await preserved(intent.cwd);
    const sourceBefore = await preserved();
    service = restart();
    await expect(service.recoverWorkspace('w_fixed')).rejects.toBeDefined();
    await expect(worker()).rejects.toBeDefined();
    expect(await preserved(intent.cwd)).toEqual(before);
    expect(await preserved()).toEqual(sourceBefore);
    if (change === 'ignored') expect(await text(intent.cwd, 'ignored/state')).toBe('uncaptured\n');
    expect(git(source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(2);
  });

  it('does not recreate a vanished initialized accepted ref or adopt an incomplete branch-only add', async () => {
    const failure = failGit((args) => args.includes('worktree') && args.includes('add'), 'before');
    await expect(worker()).rejects.toThrow('acknowledgment');
    failure.restore();
    const intent = JSON.parse(await fs.readFile(manifest('w_fixed'), 'utf8'));
    git(source, ['branch', intent.branch]);
    service = restart();
    await expect(service.recoverWorkspace('w_fixed')).rejects.toMatchObject({ code: 'not_owned' });
    expect(git(source, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
    const mission = JSON.parse(await fs.readFile(path.join(storage, 'missions', 'm01.json'), 'utf8'));
    git(source, ['update-ref', '-d', mission.acceptedRef]);
    await expect(worker('w_new', 'a2')).rejects.toBeDefined();
    expect(git(source, ['for-each-ref', '--format=%(refname)', mission.acceptedRef])).toBe('');
    expect(await text(source, 'a.txt')).toBe('base\n');
  });

  it('keeps every mutating Git operation under a held writer-admission lease', async () => {
    const original = runtime.runCapture;
    let guarded = 0;
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (cmd, args, opts) => {
      let start = 0;
      while (args[start] === '-c' && args[start + 1] !== undefined) start += 2;
      const command = args[start];
      if (['update-ref', 'read-tree', 'write-tree', 'update-index', 'add', 'apply'].includes(command) || (command === 'worktree' && ['add', 'remove'].includes(args[start + 1]))) {
        const cwd = command === 'worktree' ? args[start + 1] === 'add' ? args[args.length - 2] : args[args.length - 1] : opts!.cwd!;
        expect(held.has(cwd)).toBe(true);
        guarded++;
      }
      return original(cmd, args, opts);
    });
    const first = await worker();
    await write(first.cwd, 'a.txt', 'captured\n');
    const captured = await service.captureCandidate(first.id, 'a1', 'c_fixed');
    expect((await service.integrate({ missionId: 'm01', candidateId: captured.id, expectedAccepted: baseline.revision, check: async () => true })).status).toBe('accepted');
    await service.materializeAccepted(first.id, captured.fingerprint);
    expect(await service.cleanup(first.id)).toEqual({ removed: true });
    expect(guarded).toBeGreaterThan(20);
  });

  it('does not write into a busy provision target or replace a ready workspace with changed ownership', async () => {
    const cwd = path.join(storage, 'worktrees', 'w_fixed');
    busy.add(cwd);
    await expect(worker()).rejects.toMatchObject({ code: 'busy' });
    expect(git(source, ['worktree', 'list', '--porcelain'])).not.toContain(cwd.replaceAll('\\', '/'));
    busy.delete(cwd);
    const first = await worker();
    git(first.cwd, ['switch', '-c', 'external']);
    await expect(service.workspace(first.id)).rejects.toMatchObject({ code: 'not_owned' });
    await expect(worker()).rejects.toMatchObject({ code: 'not_owned' });
  });
});

describe('exact revision verification workspaces', () => {
  it('materializes only this Mission\'s host-captured/accepted trees and makes operation retries stable', async () => {
    const before = await preserved();
    const first = await worker();
    await write(first.cwd, 'a.txt', 'captured\n');
    const candidate = await service.captureCandidate(first.id, 'a1', 'c_fixed');
    await write(first.cwd, 'a.txt', 'worker resumed\n');
    const scratch = await service.provisionVerification({ missionId: 'm01', revision: candidate.revision, operationId: 'review1' });
    expect(scratch.role).toBe('verification');
    expect(await service.workspaceAt(scratch.cwd)).toEqual(scratch);
    expect(await service.contentIdentity(scratch.cwd)).toEqual(candidate.revision);
    expect(scratch.baseRevision).toEqual(candidate.revision);
    expect(await text(scratch.cwd, 'a.txt')).toBe('captured\n');
    service = restart();
    expect(await service.provisionVerification({ missionId: 'm01', revision: candidate.revision, operationId: 'review1' })).toEqual(scratch);
    await expect(service.provisionVerification({ missionId: 'm01', revision: baseline.revision, operationId: 'review1' })).rejects.toMatchObject({ code: 'drift' });
    const original = await service.provisionVerification({ missionId: 'm01', revision: baseline.revision, operationId: 'baseline' });
    expect(await text(original.cwd, 'a.txt')).toBe('base\n');
    await worker('w_other', 'a1', 'm02');
    await expect(service.provisionVerification({ missionId: 'm02', revision: candidate.revision, operationId: 'foreign' })).rejects.toMatchObject({ code: 'not_owned' });
    git(first.cwd, ['add', '.']);
    const arbitrary = { ...baseline.revision, contentHash: git(first.cwd, ['write-tree']) };
    await expect(service.provisionVerification({ missionId: 'm01', revision: arbitrary, operationId: 'arbitrary' })).rejects.toMatchObject({ code: 'not_owned' });
    await write(scratch.cwd, 'a.txt', 'reviewer changed it\n');
    await expect(service.provisionVerification({ missionId: 'm01', revision: candidate.revision, operationId: 'review1' })).rejects.toMatchObject({ code: 'drift' });
    expect(await text(scratch.cwd, 'a.txt')).toBe('reviewer changed it\n');
    expect(git(source, ['rev-list', '--branches', '--count'])).toBe('1');
    expect(await preserved()).toEqual(before);
  });

  it.each(['CON', 'nul', 'COM1', 'lpt9'])('rejects nonportable capture and verification identity %s', async (id) => {
    const first = await worker();
    await expect(service.captureCandidate(first.id, 'a1', id)).rejects.toMatchObject({ code: 'unsafe' });
    await expect(service.provisionVerification({ missionId: 'm01', revision: baseline.revision, operationId: id })).rejects.toMatchObject({ code: 'unsafe' });
  });

  it('retains a recorded historical accepted overlay even when no candidate had that combined tree', async () => {
    const first = await worker();
    const second = await worker('w_second', 'a2');
    await write(first.cwd, 'a.txt', 'first\n');
    await write(second.cwd, 'b.txt', 'second\n');
    const ca = await service.captureCandidate(first.id, 'a1', 'c_first');
    const cb = await service.captureCandidate(second.id, 'a2', 'c_second');
    const one = await service.integrate({ missionId: 'm01', candidateId: ca.id, expectedAccepted: baseline.revision, check: async () => true });
    const two = await service.integrate({ missionId: 'm01', candidateId: cb.id, expectedAccepted: one.revision, check: async () => true });
    expect(two.status).toBe('accepted');
    expect(two.revision.contentHash).not.toBe(ca.revision.contentHash);
    expect(two.revision.contentHash).not.toBe(cb.revision.contentHash);
    const third = await worker('w_third', 'a3');
    await write(third.cwd, 'a.txt', 'third\n');
    const cc = await service.captureCandidate(third.id, 'a3', 'c_third');
    const three = await service.integrate({ missionId: 'm01', candidateId: cc.id, expectedAccepted: two.revision, check: async () => true });
    expect(three.status).toBe('accepted');
    service = restart();
    const scratch = await service.provisionVerification({ missionId: 'm01', revision: two.revision, operationId: 'historical' });
    expect(await text(scratch.cwd, 'a.txt')).toBe('first\n');
    expect(await text(scratch.cwd, 'b.txt')).toBe('second\n');
  }, 60_000);

  it('identifies the combined integration-attempt content under its existing lease before it is accepted', async () => {
    const first = await worker();
    const second = await worker('w_second', 'a2');
    await write(first.cwd, 'a.txt', 'first\n');
    await write(second.cwd, 'b.txt', 'second\n');
    const ca = await service.captureCandidate(first.id, 'a1', 'c_first');
    const cb = await service.captureCandidate(second.id, 'a2', 'c_second');
    const sourceBefore = await preserved();
    const one = await service.integrate({ missionId: 'm01', candidateId: ca.id, expectedAccepted: baseline.revision, check: async () => true });
    expect(one.status).toBe('accepted');
    let checks = 0;
    const two = await service.integrate({ missionId: 'm01', candidateId: cb.id, expectedAccepted: one.revision, check: async ({ workspace: attempt, revision }) => {
      expect(held.has(attempt.cwd)).toBe(true);
      expect(await service.workspaceAt(attempt.cwd)).toEqual(attempt);
      expect(attempt.role).toBe('integration-attempt');
      expect(revision.contentHash).not.toBe(ca.revision.contentHash);
      expect(revision.contentHash).not.toBe(cb.revision.contentHash);
      const before = await preserved(attempt.cwd);
      expect(await service.contentIdentity(attempt.cwd)).toEqual(revision);
      expect(await text(attempt.cwd, 'a.txt')).toBe('first\n');
      expect(await text(attempt.cwd, 'b.txt')).toBe('second\n');
      expect(await service.withQuiescence(attempt.cwd, () => service.contentIdentity(attempt.cwd))).toEqual(revision);
      expect(await preserved(attempt.cwd)).toEqual(before);
      expect(held.has(attempt.cwd)).toBe(true);
      checks++;
      return true;
    } });
    expect(checks).toBe(1);
    expect(two.status).toBe('accepted');
    expect(await service.acceptedRevision('m01')).toEqual(two.revision);
    expect(await preserved()).toEqual(sourceBefore);
  }, 60_000);

  it('lets an integrated check request another same-Mission workspace without a recursive queue deadlock', async () => {
    const first = await worker();
    await write(first.cwd, 'a.txt', 'integrated\n');
    const candidate = await service.captureCandidate(first.id, 'a1', 'c_fixed');
    const result = await service.integrate({ missionId: 'm01', candidateId: candidate.id, expectedAccepted: baseline.revision, check: async ({ workspace: attempt }) => {
      expect(await text(attempt.cwd, 'a.txt')).toBe('integrated\n');
      const scratch = await service.provisionVerification({ missionId: 'm01', revision: candidate.revision, operationId: 'integrated-review' });
      expect(await text(scratch.cwd, 'a.txt')).toBe('integrated\n');
      const fresh = await worker('w_check', 'check');
      expect(fresh.id).toBe('w_check');
      return true;
    } });
    expect(result.status).toBe('accepted');
    expect(await service.acceptedRevision('m01')).toEqual(candidate.revision);
  }, 30_000);
});
