/** V12 uses an approved GitHub identity with an offline transport to real bare-Git effects.
 * The gh PR API is a fixture, NOT live GitHub smoke or a production local→GitHub mapping. */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionWorkspaces, type MissionBaseline, type MissionWorkspace, type TargetObservation } from '../src/main/mission/workspaces';
import { MissionDeliveryService, localMissionDeliveryPolicy, missionDeliveryBranch, type MissionDeliveryRequest } from '../src/main/mission/delivery';
import * as runtime from '../src/main/runtime';
import { fixtureGitHubRemote, fixtureGitHubRepo, fixtureGitHubTransport, fixturePr } from './support/mission-github-fixture';
import { missionFixture } from './support/mission-fixture';

let root: string, source: string, remote: string, upstream: string;
let workspaces: MissionWorkspaces, baseline: MissionBaseline, integration: MissionWorkspace;
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' });
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: environment(), windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.toString() || String(result.error));
  return result.stdout.toString().trim();
}
const write = (cwd: string, file: string, value: string) => fs.writeFile(path.join(cwd, file), value);
async function advance(value: string): Promise<string> {
  await write(upstream, 'remote.txt', value); git(upstream, ['add', '.']); git(upstream, ['commit', '-m', 'Advance fixture target']);
  git(upstream, ['push', 'origin', 'HEAD:refs/heads/target']); return git(upstream, ['rev-parse', 'HEAD']);
}
const observe = (operationId: string) => workspaces.observeApprovedTarget({ missionId: 'm01', operationId, remote: 'origin', targetBranch: 'target', authorize: async () => undefined });
async function integrate(observation: TargetObservation) {
  const result = await workspaces.integrateObservedTarget({ missionId: 'm01', observationId: observation.id, expectedAccepted: await workspaces.acceptedRevision('m01'), check: async ({ workspace, revision }) => {
    expect(await workspaces.contentIdentity(workspace.cwd)).toEqual(revision);
    expect(await fs.readFile(path.join(workspace.cwd, 'mission.txt'), 'utf8')).toBe('Mission result\n');
    return true;
  } });
  expect(result.status).toBe('accepted');
  integration = await workspaces.materializeAccepted(integration.id, integration.fingerprint);
  return result.revision;
}
async function preserved() {
  return { head: git(source, ['rev-parse', 'HEAD']), index: await fs.readFile(git(source, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])), status: git(source, ['status', '--porcelain=v1']), file: await fs.readFile(path.join(source, 'source.txt')) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-target-delivery-'));
  source = path.join(root, 'source'); remote = path.join(root, 'remote.git'); upstream = path.join(root, 'upstream');
  await fs.mkdir(source); git(source, ['init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'Target Delivery Fixture'], ['user.email', 'target-delivery@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(source, ['config', key, value]);
  await write(source, 'source.txt', 'original\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'Common ancestor']);
  git(root, ['init', '--bare', remote]); git(source, ['remote', 'add', 'origin', remote]); git(source, ['push', 'origin', 'HEAD:refs/heads/target']);
  git(root, ['clone', '-c', 'core.autocrlf=false', '-b', 'target', remote, upstream]);
  for (const [key, value] of [['user.name', 'Target Delivery Fixture'], ['user.email', 'target-delivery@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(upstream, ['config', key, value]);
  await write(source, 'local.txt', 'local baseline\n'); git(source, ['add', '.']); git(source, ['commit', '-m', 'Clean source baseline']);
  git(source, ['remote', 'set-url', 'origin', fixtureGitHubRemote]);
  vi.spyOn(runtime, 'runCapture').mockImplementation(fixtureGitHubTransport(remote));
  workspaces = new MissionWorkspaces({ root: path.join(root, 'workspaces'), quiescence: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) } });
  const probe = await workspaces.probeBaseline(source); if (!probe.ok) throw new Error(probe.message); baseline = probe.baseline;
  integration = await workspaces.provision({ missionId: 'm01', baseline, role: 'integration' });
  const worker = await workspaces.provision({ missionId: 'm01', baseline, role: 'worker', attemptId: 'a1' });
  await write(worker.cwd, 'mission.txt', 'Mission result\n'); const candidate = await workspaces.captureCandidate(worker.id, 'a1');
  expect((await workspaces.integrate({ missionId: 'm01', candidateId: candidate.id, expectedAccepted: baseline.revision, check: async () => true })).status).toBe('accepted');
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function delivery(observation: TargetObservation, endpoint: 'open_pr' | 'merge_pr', hook?: (action: string) => Promise<void>) {
  const revision = await workspaces.acceptedRevision('m01');
  const request: MissionDeliveryRequest = { operationId: 'deliver-one', mission: missionFixture({ id: 'm01', phase: 'delivering', baseline: baseline.revision, acceptedRevision: revision,
    workspaces: [{ id: integration.id, role: 'integration', path: integration.cwd, branch: integration.branch, base: integration.baseRevision }],
    deliveryPolicy: { ...localMissionDeliveryPolicy(), endpoint, fallback: false, allowPush: true, allowMerge: true, remote: 'origin', targetBranch: 'target', targetHead: observation.commitSha },
  }) };
  const calls: string[][] = [];
  const prs = new Map<string, ReturnType<typeof fixturePr>>();
  const transport = fixtureGitHubTransport(remote);
  vi.spyOn(runtime, 'runCapture').mockImplementation(async (file, args, options) => {
    let offset = 0;
    while (args[offset] === '-c') offset += 2;
    calls.push([args[0] === 'pr' ? 'gh' : 'git', ...args.slice(offset)]);
    if (args[0] !== 'pr') return transport(file, args, options);
    const ok = (stdout: string): runtime.CaptureResult => ({ code: 0, stdout, stderr: '' });
    const head = args[args.indexOf('--head') + 1];
    if (args[1] === 'list') return ok(JSON.stringify(prs.has(head) ? [prs.get(head)] : []));
    if (args[1] === 'create') {
      const branch = args[args.indexOf('--head') + 1], target = args[args.indexOf('--base') + 1];
      if (prs.has(branch)) throw new Error('Duplicate PR create');
      const pr = fixturePr(branch, git(remote, ['rev-parse', `refs/heads/${branch}`]), target, prs.size + 1);
      prs.set(branch, pr); return ok(pr.url);
    }
    if (args[1] === 'merge') {
      const pr = [...prs.values()].find((row) => String(row.number) === args[2])!;
      expect(args[args.indexOf('--match-head-commit') + 1]).toBe(pr.headRefOid);
      // Emulates the gh response, but target mutation/expected-head CAS is real Git, not a map.
      git(remote, ['update-ref', `refs/heads/${pr.baseRefName}`, pr.headRefOid, request.mission.deliveryPolicy.targetHead!]);
      pr.state = 'MERGED'; pr.mergeCommit = { oid: pr.headRefOid }; return ok('');
    }
    throw new Error(`Unexpected gh command: ${args.join(' ')}`);
  });
  const service = new MissionDeliveryService({ root: path.join(root, 'delivery'), authorize: async (_request, action) => { await hook?.(action); },
    contentIdentity: (cwd) => workspaces.contentIdentity(cwd), integratedTarget: (mission) => workspaces.integratedTargetObservation(mission.id),
    implementationBlockers: () => [], isQuiescent: async () => true });
  return { service, request, calls, prs };
}

describe('real remote target refresh through the delivery process boundary', () => {
  it.each(['open_pr', 'merge_pr'] as const)('delivers %s after initial divergence and later target advancement without changing the source', async (endpoint) => {
    await advance('initial remote\n'); const initial = await observe('initial'); await integrate(initial);
    await write(source, 'source.txt', 'user resumed\n'); const before = await preserved();
    const fixture = await delivery(initial, endpoint);
    // Commit authorization can finish just after another actor advances the target.
    const newHead = await advance('advanced remote\n');
    expect(await fixture.service.deliver(fixture.request)).toMatchObject({ status: 'blocked', reason: expect.stringContaining('advanced') });
    const oldBranch = missionDeliveryBranch(fixture.request.mission, initial);
    const oldCommit = git(source, ['rev-parse', `refs/heads/${oldBranch}`]);
    expect(fixture.calls.some((args) => args[1] === 'push' || args[2] === 'create')).toBe(false);
    const updated = await observe('refresh'); expect(updated.commitSha).toBe(newHead);
    fixture.request.mission.acceptedRevision = await integrate(updated);
    fixture.request.mission.deliveryPolicy.targetHead = updated.commitSha;
    fixture.request.operationId = 'deliver-refreshed';
    const result = await fixture.service.deliver(fixture.request);
    expect(result).toMatchObject({ status: 'delivered', expectedTargetHead: newHead });
    expect(git(source, ['show', '-s', '--format=%P', result.commitSha!])).toBe(newHead);
    expect(git(source, ['rev-parse', `${result.commitSha}^{tree}`])).toBe(fixture.request.mission.acceptedRevision!.contentHash);
    for (const [file, expected] of [['source.txt', 'original'], ['local.txt', 'local baseline'], ['mission.txt', 'Mission result'], ['remote.txt', 'advanced remote']]) expect(git(remote, ['show', `${result.commitSha}:${file}`])).toBe(expected);
    expect(git(source, ['rev-parse', `refs/heads/${oldBranch}`])).toBe(oldCommit);
    expect((await fixture.service.deliver(fixture.request)).commitSha).toBe(result.commitSha);
    expect(fixture.prs.size).toBe(1);
    for (const args of fixture.calls.filter((args) => args[0] === 'gh')) expect(args[args.indexOf('--repo') + 1]).toBe(fixtureGitHubRepo);
    for (const args of fixture.calls.filter((args) => ['ls-remote', 'fetch', 'push'].includes(args[1]))) expect(args).toContain(fixtureGitHubRemote);
    expect(fixture.calls.filter((args) => args[1] === 'push')).toHaveLength(1);
    expect(fixture.calls.filter((args) => args[2] === 'create')).toHaveLength(1);
    expect(fixture.calls.filter((args) => args[2] === 'merge')).toHaveLength(endpoint === 'merge_pr' ? 1 : 0);
    expect(fixture.calls.some((args) => args.some((arg) => /^(?:--force|-f|--force-with-lease)$/.test(arg)))).toBe(false);
    expect(await workspaces.baseline('m01')).toEqual(baseline);
    expect(await preserved()).toEqual(before);
  }, 60_000);

  it.each(['push', 'create_pr', 'merge_pr'] as const)('rechecks the expected target after %s authorization and does not execute the raced endpoint', async (action) => {
    await advance('initial\n'); const observation = await observe('race'); await integrate(observation);
    const before = await preserved(); let raced = false;
    const fixture = await delivery(observation, action === 'merge_pr' ? 'merge_pr' : 'open_pr', async (next) => {
      if (next === action && !raced) { raced = true; await advance('raced target\n'); }
    });
    expect(await fixture.service.deliver(fixture.request)).toMatchObject({ status: 'blocked', reason: expect.stringContaining('advanced') });
    const command = action === 'create_pr' ? 'create' : action === 'merge_pr' ? 'merge' : 'push';
    expect(fixture.calls.some((args) => args[0] === 'git' ? args[1] === command : args[2] === command)).toBe(false);
    expect(raced).toBe(true); expect(await preserved()).toEqual(before);
  }, 30_000);

  it('does not parent an unintegrated result to an initially divergent target, even when its objects were fetched', async () => {
    await advance('initial\n'); const observation = await observe('unintegrated');
    integration = await workspaces.materializeAccepted(integration.id, integration.fingerprint);
    const fixture = await delivery(observation, 'open_pr'); const before = await preserved();
    await expect(fixture.service.deliver(fixture.request)).rejects.toThrow('not included in the source baseline');
    expect(fixture.calls.some((args) => ['commit-tree', 'push'].includes(args[1]) || args[0] === 'gh')).toBe(false);
    expect(await preserved()).toEqual(before);
  }, 30_000);
});
