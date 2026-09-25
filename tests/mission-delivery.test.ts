import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionDeliveryService, localMissionDeliveryPolicy, type MissionDeliveryRequest } from '../src/main/mission/delivery';
import { runCapture, which, type CaptureResult } from '../src/main/runtime';
import { missionGitHubTarget } from '../src/main/mission/git-boundary';
import { missionFixture } from './support/mission-fixture';

let root: string, repo: string, workspace: string, base: string, tree: string;
const git = async (args: string[], cwd = repo): Promise<string> => {
  const result = await runCapture(which('git') ?? 'git', args, { cwd, timeoutMs: 20_000 });
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-delivery-')); repo = path.join(root, 'repository'); workspace = path.join(root, 'integration');
  await fs.mkdir(repo); await git(['init', '-b', 'main']);
  // Disposable fixture identity, not an override of the developer's repository identity.
  await git(['config', 'user.name', 'Delivery Fixture']); await git(['config', 'user.email', 'delivery@example.invalid']);
  await fs.writeFile(path.join(repo, 'source.txt'), 'original\n'); await git(['add', '.']); await git(['commit', '-m', 'Initial fixture']);
  base = await git(['rev-parse', 'HEAD']);
  await git(['worktree', 'add', '-b', 'mission/integration', workspace, base]);
  await fs.writeFile(path.join(workspace, 'result.txt'), 'verified result\n'); await git(['add', '.'], workspace); tree = await git(['write-tree'], workspace);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function fixture(overrides: { blockers?: string[]; quiescent?: boolean; run?: (file: string, args: string[], cwd: string) => Promise<CaptureResult> } = {}) {
  const revision = { baseCommitSha: base, contentHash: tree };
  const request: MissionDeliveryRequest = {
    mission: missionFixture({ phase: 'delivering', acceptedRevision: revision, baseline: { baseCommitSha: base, contentHash: '' }, workspaces: [{ id: 'integration', role: 'integration', path: workspace, branch: 'mission/integration', base: revision }] }),
    operationId: 'delivery-one', commitMessage: 'feat: Deliver the fixture', report: 'Verified fixture report',
  };
  const authorize = vi.fn(async (_request: MissionDeliveryRequest, _action: string) => undefined);
  const service = new MissionDeliveryService({
    root: path.join(root, 'receipts'), authorize,
    isQuiescent: async () => overrides.quiescent ?? true,
    implementationBlockers: () => overrides.blockers ?? [],
    contentIdentity: async (cwd) => ({ baseCommitSha: base, contentHash: await git(['write-tree'], cwd) }), run: overrides.run,
  });
  return { service, request, authorize };
}

describe('Mission delivery owner', () => {
  it('creates one verified local commit with the configured identity and preserves the source checkout', async () => {
    const { service, request, authorize } = fixture();
    const first = await service.deliver(request);
    const second = await service.deliver(request);
    expect(first).toMatchObject({ endpoint: 'local_commit', status: 'delivered', commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(second.commitSha).toBe(first.commitSha);
    expect(await git(['rev-parse', `${first.commitSha}^{tree}`])).toBe(tree);
    expect(await git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', first.commitSha!])).toBe('Delivery Fixture <delivery@example.invalid>|Delivery Fixture <delivery@example.invalid>');
    expect(await git(['rev-list', '--all', '--count'])).toBe('2');
    expect(await git(['rev-parse', 'HEAD'])).toBe(base);
    expect(await git(['status', '--porcelain'])).toBe('');
    expect(authorize.mock.calls.map((args) => args[1])).toEqual(['commit']);
  });

  it.each([
    { blockers: ['Required live check has not run'], expected: 'prerequisites' },
    { quiescent: false, expected: 'settle' },
  ])('does not create a commit before required gates: $expected', async (options) => {
    const { service, request, authorize } = fixture(options);
    await expect(service.deliver(request)).rejects.toThrow(options.expected);
    expect(await git(['rev-list', '--all', '--count'])).toBe('1');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('recovers a commit/ref update whose acknowledgment was lost without a duplicate commit', async () => {
    let lost = false;
    const run = async (file: string, args: string[], cwd: string) => {
      const result = await runCapture(which(file) ?? file, args, { cwd, timeoutMs: 20_000 });
      if (args[0] === 'update-ref' && !lost) { lost = true; throw new Error('lost local acknowledgment'); }
      return result;
    };
    const { service, request } = fixture({ run });
    await expect(service.deliver(request)).rejects.toThrow('lost local');
    const recovered = await service.deliver(request);
    expect(recovered.status).toBe('delivered');
    expect(await git(['rev-list', '--all', '--count'])).toBe('2');
  });

  it.each(['commit-tree', 'update-ref'] as const)('does not reapply an unacknowledged %s when no branch receipt can confirm it', async (command) => {
    let effects = 0;
    const run = async (file: string, args: string[], cwd: string) => {
      if (args[0] === command) {
        effects++;
        if (command === 'commit-tree') await runCapture(which(file) ?? file, args, { cwd, timeoutMs: 20_000 });
        throw new Error('lost effect acknowledgment');
      }
      return runCapture(which(file) ?? file, args, { cwd, timeoutMs: 20_000 });
    };
    const { service, request } = fixture({ run });
    await expect(service.deliver(request)).rejects.toThrow('lost effect');
    await expect(service.deliver(request)).rejects.toThrow(/acknowledgment/);
    expect(effects).toBe(1);
    expect(await git(['for-each-ref', '--format=%(refname)', 'refs/heads/mission/mission-delivery'])).toBe('');
    expect(await git(['rev-parse', 'HEAD'])).toBe(base);
  });

  it('refuses conflicting reuse of a delivery identity and unverified content changes', async () => {
    const { service, request } = fixture();
    await service.deliver(request);
    await expect(service.deliver({ ...request, commitMessage: 'Different intent' })).rejects.toThrow('conflict');
    await fs.writeFile(path.join(workspace, 'result.txt'), 'unverified edit'); await git(['add', '.'], workspace);
    await expect(service.deliver(request)).rejects.toThrow('verified evidence');
  });

  it('does not infer push/merge/deploy authorization from an objective', () => {
    expect(localMissionDeliveryPolicy()).toMatchObject({ endpoint: 'local_commit', allowPush: false, allowMerge: false, fallback: true, requireIndependentReview: true });
  });
});

function remoteBoundary(endpoint = 'https://github.com/example/fixture.git') {
  const heads = new Map<string, string>([['refs/heads/integration-target', base]]);
  let pr: { number: number; url: string; state: string; headRefOid: string; headRefName: string; baseRefName: string; headRepository: { nameWithOwner: string }; headRepositoryOwner: { login: string }; isCrossRepository: boolean; mergeCommit?: { oid: string } } | undefined;
  const calls: string[][] = [];
  let loseCreateAck = false;
  const ok = (stdout = ''): CaptureResult => ({ code: 0, stdout, stderr: '' });
  const run = async (file: string, args: string[], cwd: string): Promise<CaptureResult> => {
    calls.push([file, ...args]);
    if (file === 'git' && ['remote get-url --all origin', 'remote get-url --push --all origin'].includes(args.join(' '))) return ok(`${endpoint}\n`);
    if (file === 'git' && args[0] === 'ls-remote') return ok(heads.has(args[3]) ? `${heads.get(args[3])}\t${args[3]}\n` : '');
    if (file === 'git' && args[0] === 'push') { const [commit, ref] = args[2].split(':'); heads.set(ref, commit); return ok(); }
    if (file === 'git' && args[0] === 'fetch') return ok();
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === `${'f'.repeat(40)}^{tree}`) return ok(tree);
    if (file === 'gh' && args[1] === 'list') return ok(JSON.stringify(pr ? [pr] : []));
    if (file === 'gh' && args[1] === 'create') {
      pr = { number: 17, url: 'https://github.com/example/fixture/pull/17', state: 'OPEN', headRefOid: heads.get('refs/heads/mission/mission-delivery')!, headRefName: 'mission/mission-delivery', baseRefName: 'integration-target', headRepository: { nameWithOwner: 'example/fixture' }, headRepositoryOwner: { login: 'example' }, isCrossRepository: false };
      if (loseCreateAck) { loseCreateAck = false; throw new Error('lost remote acknowledgment'); }
      return ok(pr.url);
    }
    if (file === 'gh' && args[1] === 'merge') { pr!.state = 'MERGED'; pr!.mergeCommit = { oid: 'f'.repeat(40) }; heads.set('refs/heads/integration-target', 'f'.repeat(40)); return ok(); }
    return runCapture(which(file) ?? file, args, { cwd, timeoutMs: 20_000 });
  };
  return { run, heads, calls, loseCreateAck: () => { loseCreateAck = true; } };
}

describe('recorded remote endpoints (mocked git-host process boundary, not live GitHub)', () => {
  it('derives GitHub or Enterprise authority solely from standard HTTPS, SSH and scp endpoints', () => {
    for (const endpoint of ['https://github.example.invalid/owner/fixture.git', 'https://github.example.invalid:443/owner/fixture', 'ssh://git@github.example.invalid/owner/fixture.git', 'ssh://git@github.example.invalid:22/owner/fixture.git', 'git@github.example.invalid:owner/fixture.git']) {
      expect(missionGitHubTarget(endpoint)).toEqual({ host: 'github.example.invalid', owner: 'owner', name: 'fixture', repository: 'github.example.invalid/owner/fixture' });
    }
    for (const endpoint of ['https://fixture-secret@github.com/owner/repo.git', 'https://github.com/owner/repo.git?fixture-secret', 'https://github.com/owner/../repo.git', 'https://github.com/owner/%2e%2e', 'https://github.com/owner/repo.git/extra', 'https://github.com:8443/owner/repo.git', 'file:///owner/repo.git', '../owner/repo.git']) {
      expect(() => missionGitHubTarget(endpoint)).toThrow(/endpoint/i);
      expect(() => missionGitHubTarget(endpoint)).not.toThrow(/fixture-secret/);
    }
  });

  it.each(['ssh://git@github.com/example/fixture.git', 'git@github.com:example/fixture.git'])('binds gh to the exact repository derived from %s', async (endpoint) => {
    const remote = remoteBoundary(endpoint), { service, request } = fixture({ run: remote.run });
    request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint: 'open_pr', fallback: false, allowPush: true, remote: 'origin', targetBranch: 'integration-target', targetHead: base };
    expect(await service.deliver(request)).toMatchObject({ status: 'delivered', pullRequestUrl: 'https://github.com/example/fixture/pull/17' });
    for (const args of remote.calls.filter((args) => args[0] === 'gh')) expect(args[args.indexOf('--repo') + 1]).toBe('github.com/example/fixture');
    expect(remote.calls.filter((args) => args[1] === 'push')).toEqual([['git', 'push', endpoint, expect.stringContaining(':refs/heads/mission/mission-delivery')]]);
  });

  it('does not expose malformed GitHub receipt content in diagnostics or publish after the failed read', async () => {
    const remote = remoteBoundary();
    const { service, request } = fixture({ run: async (file, args, cwd) => file === 'gh' ? { code: 0, stdout: '{fixture-secret', stderr: '' } : remote.run(file, args, cwd) });
    request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint: 'open_pr', fallback: false, allowPush: true, remote: 'origin', targetBranch: 'integration-target', targetHead: base };
    await expect(service.deliver(request)).rejects.toThrow(/^Invalid exact PR receipt$/);
    expect(remote.calls.some((args) => args[1] === 'push')).toBe(false);
  });
  it.each(['open_pr', 'merge_pr'] as const)('delivers the exact configured %s endpoint, not hard-coded develop', async (endpoint) => {
    const remote = remoteBoundary(); remote.loseCreateAck();
    const { service, request } = fixture({ run: remote.run });
    request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint, fallback: false, allowPush: true, allowMerge: true, remote: 'origin', targetBranch: 'integration-target', targetHead: base, mergeMethod: 'squash' };
    const delivered = await service.deliver(request);
    expect(delivered).toMatchObject({ status: 'delivered', pullRequestUrl: 'https://github.com/example/fixture/pull/17' });
    expect(delivered.mergedCommitSha).toBe(endpoint === 'merge_pr' ? 'f'.repeat(40) : undefined);
    expect((await service.deliver(request)).commitSha).toBe(delivered.commitSha);
    expect(remote.calls.filter((args) => args[0] === 'gh' && args[2] === 'create')).toHaveLength(1);
    expect(remote.calls.some((args) => args.includes('--force'))).toBe(false);
    for (const args of remote.calls.filter((args) => args[0] === 'gh')) expect(args[args.indexOf('--repo') + 1]).toBe('github.com/example/fixture');
    if (endpoint === 'merge_pr') expect(remote.calls).toContainEqual(['gh', 'pr', 'merge', '17', '--repo', 'github.com/example/fixture', '--squash', '--match-head-commit', delivered.commitSha]);
  });

  it('holds the PR under explicit sensitive-change policy without claiming it merged', async () => {
    const remote = remoteBoundary(); const { service, request } = fixture({ run: remote.run });
    request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint: 'merge_pr', fallback: false, allowPush: true, allowMerge: true, remote: 'origin', targetBranch: 'integration-target', targetHead: base, holdConditions: ['Permission boundary requires review'], holdIsEndpoint: true };
    expect(await service.deliver(request)).toMatchObject({ status: 'held', reason: expect.stringContaining('review hold'), pullRequestUrl: expect.any(String) });
    expect(remote.calls.some((args) => args[0] === 'gh' && args[2] === 'merge')).toBe(false);
  });

  it('does not claim completion when a raced merge contains unverified combined content', async () => {
    const remote = remoteBoundary();
    const { service, request } = fixture({ run: async (file, args, cwd) => {
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === `${'f'.repeat(40)}^{tree}`) return { code: 0, stdout: 'd'.repeat(40), stderr: '' };
      return remote.run(file, args, cwd);
    } });
    request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint: 'merge_pr', fallback: false, allowPush: true, allowMerge: true, remote: 'origin', targetBranch: 'integration-target', targetHead: base };
    await expect(service.deliver(request)).rejects.toThrow('actual combined content differs');
    await expect(service.deliver(request)).rejects.toThrow('actual combined content differs');
    expect(remote.calls.filter((args) => args[0] === 'gh' && args[2] === 'merge')).toHaveLength(1);
  });

  it('blocks an advanced target before any push or PR mutation', async () => {
    const remote = remoteBoundary(); const { service, request } = fixture({ run: remote.run });
    request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint: 'open_pr', fallback: false, allowPush: true, remote: 'origin', targetBranch: 'integration-target', targetHead: base };
    remote.heads.set('refs/heads/integration-target', 'e'.repeat(40));
    expect(await service.deliver(request)).toMatchObject({ status: 'blocked', reason: expect.stringContaining('advanced') });
    expect(remote.calls.some((args) => args[1] === 'push' || args[2] === 'create')).toBe(false);
  });
});
