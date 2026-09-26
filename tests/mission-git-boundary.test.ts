/** Real Git + the production runCapture boundary; no injected delivery/policy runners. */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '../src/main/runtime';
import { MissionWorkspaces, type MissionWorkspace, type TargetObservation } from '../src/main/mission/workspaces';
import { MissionDeliveryService, localMissionDeliveryPolicy, type MissionDeliveryRequest } from '../src/main/mission/delivery';
import { resolveMissionDeliveryPolicy } from '../src/main/mission/policy';
import { missionGitArgs, runMissionGit } from '../src/main/mission/git-boundary';
import { missionFixture } from './support/mission-fixture';
import { fixtureGitHubRemote, fixtureGitHubRepo, fixtureGitHubTransport, fixturePr } from './support/mission-github-fixture';

let root: string, source: string, remote: string, storage: string;
const fixtureEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GCM_|SSH_ASKPASS)/i.test(key))), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never' });
function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], { cwd, env: fixtureEnv(), windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.toString() || String(result.error));
  return result.stdout.toString().trim();
}
const ok = (stdout = ''): runtime.CaptureResult => ({ code: 0, stdout, stderr: '' });
function githubCommitRead(args: string[], pr: ReturnType<typeof fixturePr>) {
  const sha = pr.mergeCommit!.oid;
  expect(args).toEqual(['api', '--hostname', 'example.invalid', `repos/fixture/repository/git/commits/${sha}`]);
  return ok(JSON.stringify({ sha, html_url: `https://${fixtureGitHubRepo}/commit/${sha}`, tree: { sha: git(remote, ['rev-parse', `${sha}^{tree}`]) } }));
}
const commandArgs = (args: string[]): string[] => {
  let offset = 0;
  while (args[offset] === '-c') offset += 2;
  return args.slice(offset);
};
const network = (args: string[]) => ['ls-remote', 'fetch', 'push'].includes(commandArgs(args)[0]);
const capture = runtime.runCapture;
function trace() {
  const calls: Array<{ args: string[]; options: Parameters<typeof runtime.runCapture>[2] }> = [];
  const spy = vi.spyOn(runtime, 'runCapture').mockImplementation(async (file, args, options) => {
    calls.push({ args, options });
    return capture(file, args, options);
  });
  return { calls, spy };
}
function poisonEnvironment() {
  for (const [key, value] of Object.entries({ GIT_DIR: path.join(root, 'wrong.git'), GIT_WORK_TREE: root, GIT_INDEX_FILE: path.join(source, '.git', 'index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(root, 'hooks'), GIT_CONFIG_PARAMETERS: "'user.name=Wrong identity'", GIT_ASKPASS: 'fixture-askpass', GIT_SSH_COMMAND: 'fixture-ssh', GCM_INTERACTIVE: 'always', SSH_ASKPASS: 'fixture-askpass', SSH_ASKPASS_REQUIRE: 'force' })) vi.stubEnv(key, value);
}
function protectedProcesses(calls: ReturnType<typeof trace>['calls']) {
  expect(calls.length).toBeGreaterThan(0);
  for (const { args, options } of calls) {
    for (const [key, value] of Object.entries({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' })) expect(options?.env?.[key], key).toBe(value);
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS']) expect(options?.env?.[key], key).toBeUndefined();
    expect(options?.env?.GIT_INDEX_FILE).not.toBe(path.join(source, '.git', 'index'));
    expect(options?.env?.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(options?.env?.GIT_ASKPASS).not.toBe('fixture-askpass');
    expect(args).toEqual(expect.arrayContaining(['core.hooksPath=', 'core.fsmonitor=false', 'submodule.recurse=false', ...(process.platform === 'win32' ? ['core.longpaths=true'] : [])]));
  }
}
async function preserved() {
  return { head: git(source, ['rev-parse', 'HEAD']), index: await fs.readFile(path.join(source, '.git', 'index')), file: await fs.readFile(path.join(source, 'source.txt')), status: git(source, ['status', '--porcelain=v1']), fetchHead: await fs.readFile(path.join(source, '.git', 'FETCH_HEAD')).catch(() => undefined) };
}
async function owned() {
  const workspaces = new MissionWorkspaces({ root: storage, quiescence: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) } });
  const probe = await workspaces.probeBaseline(source); if (!probe.ok) throw new Error(probe.message);
  const integration = await workspaces.provision({ missionId: 'm01', role: 'integration', baseline: probe.baseline });
  const observe = (operationId: string, authorize = async () => undefined) => workspaces.observeApprovedTarget({ missionId: 'm01', operationId, remote: 'origin', targetBranch: 'target', authorize });
  return { workspaces, baseline: probe.baseline, integration, observe };
}
async function retainedText(): Promise<string> {
  const bodies: string[] = [];
  for (const folder of ['target-observations', 'target-observation-intents']) {
    for (const name of await fs.readdir(path.join(storage, folder)).catch(() => [])) bodies.push(await fs.readFile(path.join(storage, folder, name), 'utf8'));
  }
  return bodies.join('\n');
}
function delivery(workspaces: MissionWorkspaces, integration: MissionWorkspace, observation?: TargetObservation, authorize: (request: MissionDeliveryRequest, action: string) => Promise<void> = async () => undefined) {
  const revision = integration.baseRevision;
  const request: MissionDeliveryRequest = { operationId: 'deliver', mission: missionFixture({ id: 'm01', projectRoot: source, sourceCwd: source, phase: 'delivering', acceptedRevision: revision, baseline: revision,
    workspaces: [{ id: integration.id, role: 'integration', path: integration.cwd, branch: integration.branch, base: revision }],
    deliveryPolicy: observation ? { ...localMissionDeliveryPolicy(), endpoint: 'open_pr', allowPush: true, remote: observation.remote, targetBranch: 'target', targetHead: observation.commitSha } : localMissionDeliveryPolicy(),
  }) };
  const service = new MissionDeliveryService({ root: path.join(root, 'delivery'), authorize, contentIdentity: (cwd) => workspaces.contentIdentity(cwd), integratedTarget: async () => observation, implementationBlockers: () => [], isQuiescent: async () => true });
  return { request, service };
}

async function githubObservation(fixture: Awaited<ReturnType<typeof owned>>, operationId: string) {
  git(source, ['remote', 'set-url', 'origin', fixtureGitHubRemote]);
  const transport = fixtureGitHubTransport(remote);
  vi.spyOn(runtime, 'runCapture').mockImplementation(transport);
  return { observation: await fixture.observe(operationId), transport };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-git-boundary-')); source = path.join(root, 'source'); remote = path.join(root, 'remote fixture.git'); storage = path.join(root, 'storage');
  await fs.mkdir(source); git(source, ['init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'Git Boundary Fixture'], ['user.email', 'git-boundary@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(source, ['config', key, value]);
  await fs.writeFile(path.join(source, 'source.txt'), 'original\n');
  await fs.writeFile(path.join(source, 'AGENTS.md'), 'Open a PR into target.\n');
  git(source, ['add', '.']); git(source, ['commit', '-m', 'Boundary fixture']);
  git(root, ['init', '--bare', remote]); git(source, ['remote', 'add', 'origin', remote]); git(source, ['push', 'origin', 'HEAD:refs/heads/target']);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('Mission production Git routing and noninteractive processes', () => {
  it('protects workspace probes and temporary indexes from inherited Git routing and prompt overrides', async () => {
    const before = await preserved(); const { calls } = trace(); poisonEnvironment();
    const fixture = await owned();
    expect(fixture.baseline.sourceRoot).toBe(await fs.realpath(source));
    protectedProcesses(calls);
    expect(await preserved()).toEqual(before);
  });

  it('protects default policy probes rather than just an injected runGit helper', async () => {
    const before = await preserved(); const { calls } = trace(); poisonEnvironment();
    const policy = await resolveMissionDeliveryPolicy(source);
    expect(policy).toMatchObject({ targetHead: before.head, conflicts: [] });
    protectedProcesses(calls);
    expect(calls.filter(({ args }) => network(args)).map(({ args }) => commandArgs(args)[2])).toEqual([remote]);
    expect(await preserved()).toEqual(before);
  });

  it('enables long paths for every Windows Mission Git process and leaves other platforms unchanged', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      const windows = missionGitArgs(['status']);
      expect(windows[windows.indexOf('core.longpaths=true') - 1]).toBe('-c');
      expect(windows.at(-1)).toBe('status');
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      expect(missionGitArgs(['status'])).not.toContain('core.longpaths=true');
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  it.runIf(process.platform === 'win32')('materializes and captures repository paths beyond MAX_PATH inside deep owned storage', async () => {
    // userData\mission-workspaces\worktrees\<66-character id> alone uses ~140 of MAX_PATH's 260.
    const folders = ['nested-fixture', 'd'.repeat(50), 'e'.repeat(50)];
    await fs.mkdir(path.join(source, ...folders), { recursive: true });
    await fs.writeFile(path.join(source, ...folders, 'file.txt'), 'deep\n');
    git(source, ['add', '.']); git(source, ['commit', '-m', 'Deep path fixture']);
    const workspaces = new MissionWorkspaces({ root: path.join(root, 's'.repeat(40), 't'.repeat(40)), quiescence: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) } });
    const probe = await workspaces.probeBaseline(source); if (!probe.ok) throw new Error(probe.message);
    const worker = await workspaces.provision({ missionId: 'm01', baseline: probe.baseline, role: 'worker', attemptId: 'a1' });
    const deep = path.join(worker.cwd, ...folders, 'file.txt');
    expect(deep.length).toBeGreaterThan(260);
    expect(await fs.readFile(deep, 'utf8')).toBe('deep\n');
    await fs.writeFile(deep, 'changed beyond MAX_PATH\n');
    const candidate = await workspaces.captureCandidate(worker.id, 'a1', 'c_deep');
    expect(candidate.changedPaths).toEqual([[...folders, 'file.txt'].join('/')]);
    expect(git(source, ['show', `${candidate.revision.contentHash}:${[...folders, 'file.txt'].join('/')}`])).toBe('changed beyond MAX_PATH');
  }, 60_000);

  it('protects real delivery commit/ref processes without replacing configured or inherited Git identity', async () => {
    const fixture = await owned(); const before = await preserved(); const { calls } = trace(); poisonEnvironment();
    vi.stubEnv('GIT_AUTHOR_NAME', 'Inherited Fixture Author'); vi.stubEnv('GIT_AUTHOR_EMAIL', 'inherited-author@example.invalid');
    vi.stubEnv('GIT_COMMITTER_NAME', 'Inherited Fixture Committer'); vi.stubEnv('GIT_COMMITTER_EMAIL', 'inherited-committer@example.invalid');
    const { service, request } = delivery(fixture.workspaces, fixture.integration);
    const result = await service.deliver(request);
    expect(result.status).toBe('delivered'); protectedProcesses(calls);
    expect(git(source, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', result.commitSha!])).toBe('Inherited Fixture Author <inherited-author@example.invalid>|Inherited Fixture Committer <inherited-committer@example.invalid>');
    expect(git(source, ['config', 'user.name'])).toBe('Git Boundary Fixture');
    expect(await preserved()).toEqual(before);
  });
});

/** No status/add here: the control Git process would itself run the filter under test. */
async function planningBytes(cwd = source) {
  return {
    head: git(cwd, ['rev-parse', 'HEAD']),
    index: await fs.readFile(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])),
    files: await Promise.all(['source.txt', '.gitattributes', 'AGENTS.md'].map((file) => fs.readFile(path.join(cwd, file)))),
    config: await fs.readFile(path.join(source, '.git', 'config')),
  };
}
async function filterAttributes(attributes: string) {
  await fs.writeFile(path.join(source, '.gitattributes'), attributes);
  git(source, ['add', '.gitattributes']); git(source, ['commit', '-m', 'Filter attributes fixture']);
}
const filterCommand = (marker: string, processFilter = false) => `printf filter >> '${marker.replaceAll('\\', '/')}'; ${processFilter ? 'exit 1' : 'cat'}`;
const planningWorkspaces = () => new MissionWorkspaces({ root: storage, quiescence: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) } });

describe('Mission planning never executes configured Git content filters', () => {
  it.each(['clean', 'smudge', 'process'] as const)('disables required %s filters for real baseline, checkout and capture without touching source bytes/config/index', async (kind) => {
    await filterAttributes('source.txt filter=Fixture.Driver\n');
    const marker = path.join(root, 'filter-ran');
    git(source, ['config', `filter.Fixture.Driver.${kind}`, filterCommand(marker, kind === 'process')]);
    git(source, ['config', 'filter.Fixture.Driver.required', 'true']);
    if (kind !== 'process') git(source, ['config', `filter.Fixture.Driver.${kind === 'clean' ? 'smudge' : 'clean'}`, 'cat']);
    // A disabled process must not fall back to executing its clean/smudge commands either.
    if (kind === 'process') for (const fallback of ['clean', 'smudge']) git(source, ['config', `filter.Fixture.Driver.${fallback}`, filterCommand(marker)]);
    const before = await planningBytes();
    const control = spawnSync('git', kind === 'clean' ? ['hash-object', '--path=source.txt', 'source.txt'] : ['cat-file', '--filters', 'HEAD:source.txt'], { cwd: source, env: fixtureEnv(), timeout: 10_000, windowsHide: true });
    expect(control.error).toBeUndefined(); expect(control.status === 0).toBe(kind !== 'process');
    expect(await fs.readFile(marker, 'utf8')).toContain('filter');
    expect(await planningBytes()).toEqual(before); await fs.rm(marker);

    const workspaces = planningWorkspaces();
    const probe = await workspaces.probeBaseline(source);
    expect(await fs.readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(probe.ok).toBe(true); if (!probe.ok) throw new Error(probe.message);
    expect(await planningBytes()).toEqual(before);
    const lead = await workspaces.provision({ missionId: 'filters', baseline: probe.baseline, role: 'lead' });
    expect(await fs.readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(await fs.readFile(path.join(lead.cwd, 'source.txt'))).toEqual(before.files[0]);
    expect(await planningBytes()).toEqual(before);
    await fs.writeFile(path.join(lead.cwd, 'source.txt'), 'captured raw bytes\n');
    const workerBefore = await planningBytes(lead.cwd);
    const candidate = await workspaces.captureCandidate(lead.id, 'planning-capture', 'filtered-candidate');
    expect(candidate.changedPaths).toEqual(['source.txt']);
    expect(candidate.indexContentHash).toBe(probe.baseline.revision.contentHash);
    expect(git(source, ['cat-file', 'blob', `${candidate.revision.contentHash}:source.txt`])).toBe('captured raw bytes');
    expect(await fs.readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(await planningBytes(lead.cwd)).toEqual(workerBefore);
    expect(await planningBytes()).toEqual(before);
  });

  it('discovers conditional checkout filters in the owned branch and newly added worktree filters at capture time', async () => {
    await filterAttributes('source.txt filter=Conditional.Driver\n*.late filter=Worktree.Driver\n');
    const marker = path.join(root, 'filter-ran'), included = path.join(root, 'included-filter.config');
    git(source, ['config', '--file', included, 'filter.Conditional.Driver.smudge', filterCommand(marker)]);
    git(source, ['config', '--file', included, 'filter.Conditional.Driver.clean', 'cat']);
    git(source, ['config', '--file', included, 'filter.Conditional.Driver.required', 'true']);
    git(source, ['config', 'includeIf.onbranch:mission/**.path', included]);
    const before = await planningBytes(), includedBefore = await fs.readFile(included);
    const workspaces = planningWorkspaces(); const probe = await workspaces.probeBaseline(source);
    expect(probe.ok).toBe(true); if (!probe.ok) throw new Error(probe.message);
    const lead = await workspaces.provision({ missionId: 'filters', baseline: probe.baseline, role: 'lead' });
    expect(await fs.readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(git(lead.cwd, ['config', '--get', 'filter.Conditional.Driver.smudge'])).toBe(filterCommand(marker));
    expect(await planningBytes()).toEqual(before);
    git(source, ['config', 'extensions.worktreeConfig', 'true']);
    git(lead.cwd, ['config', '--worktree', 'filter.Worktree.Driver.process', filterCommand(marker, true)]);
    git(lead.cwd, ['config', '--worktree', 'filter.Worktree.Driver.required', 'true']);
    const localConfig = git(lead.cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'config.worktree']);
    const localBefore = await fs.readFile(localConfig), sourceBefore = await planningBytes();
    await fs.writeFile(path.join(lead.cwd, 'new.late'), 'new raw bytes\n');
    const workerBefore = await planningBytes(lead.cwd);
    const candidate = await workspaces.captureCandidate(lead.id, 'planning-capture', 'late-filter-candidate');
    expect(candidate.changedPaths).toEqual(['new.late']);
    expect(git(source, ['cat-file', 'blob', `${candidate.revision.contentHash}:new.late`])).toBe('new raw bytes');
    expect(await fs.readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(await planningBytes(lead.cwd)).toEqual(workerBefore); expect(await planningBytes()).toEqual(sourceBefore);
    expect(await fs.readFile(localConfig)).toEqual(localBefore); expect(await fs.readFile(included)).toEqual(includedBefore);
  });

  it.each([
    { name: 'truncated', result: { ...ok('filter.Fault.clean\0'), truncated: true } },
    { name: 'timed out', result: { ...ok(), timedOut: true } },
    { name: 'failed', result: { code: 2, stdout: '', stderr: 'untrusted filter command' } },
    { name: 'unterminated', result: ok('filter.Fault.clean') },
    { name: 'empty key', result: ok('\0') },
    { name: 'inconsistent exit code', result: { ...ok('filter.Fault.clean\0'), code: 1 } },
  ])('fails closed on a $name filter probe instead of dispatching content operations', async ({ result }) => {
    await filterAttributes('source.txt filter=Fault\n');
    const before = await planningBytes(); const { calls, spy } = trace();
    spy.mockImplementation(async (file, args, options) => {
      calls.push({ args, options });
      return commandArgs(args)[0] === 'config' && args.includes('--name-only') ? result : capture(file, args, options);
    });
    const probe = await planningWorkspaces().probeBaseline(source);
    expect(probe).toMatchObject({ ok: false, reason: 'unsafe', message: expect.stringMatching(/filter/i) });
    expect(JSON.stringify(probe)).not.toContain('untrusted filter command');
    expect(calls.some(({ args }) => ['status', 'add', 'read-tree', 'write-tree'].includes(commandArgs(args)[0]))).toBe(false);
    expect(await planningBytes()).toEqual(before);
  });

  it('refuses worktree-add checkout rather than discovering filters against the wrong branch', async () => {
    const target = path.join(root, 'unsafe-checkout');
    await expect(runMissionGit(source, ['worktree', 'add', '-b', 'unsafe-branch', target])).rejects.toThrow(/filter/i);
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(source, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/main');
  });

  it('fails closed before content access when a configured filter name cannot be overridden safely', async () => {
    await filterAttributes('source.txt filter=unsafe=driver\n');
    const marker = path.join(root, 'filter-ran');
    git(source, ['config', 'filter.unsafe=driver.clean', filterCommand(marker)]);
    const before = await planningBytes();
    expect(await planningWorkspaces().probeBaseline(source)).toMatchObject({ ok: false, reason: 'unsafe', message: expect.stringMatching(/filter/i) });
    expect(await fs.readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(await planningBytes()).toEqual(before);
    expect(await fs.readdir(storage).catch(() => [])).toEqual([]);
  });
});

const unsafeEndpoints = [
  'https://fixture-user:fixture-password@example.invalid/repository.git',
  'https://fixture-token@example.invalid/repository.git',
  'https://example.invalid/repository.git?access_token=fixture-query-token',
  'https://example.invalid/repository.git#fixture-fragment-token',
  'ssh://fixture-user:fixture-password@example.invalid/repository.git',
  'ext::sh -c fixture-remote-helper',
  'fixture-helper::repository',
  'fixture-helper://example.invalid/repository',
  '../remote.git',
  ...(process.platform === 'win32' ? ['C:relative.git', '/drive-relative.git', '\\drive-relative.git'] : []),
];

describe('Mission read-only delivery inspection', () => {
  it('inspects only exact completed local receipts without creating storage, authorizing or replaying effects', async () => {
    const fixture = await owned(); const before = await preserved(); const authorize = vi.fn(async () => undefined);
    const { service, request } = delivery(fixture.workspaces, fixture.integration, undefined, authorize);
    expect(await service.inspect(request)).toBeUndefined();
    expect(await fs.readdir(path.join(root, 'delivery')).catch(() => [])).toEqual([]);
    const delivered = await service.deliver(request); expect(authorize).toHaveBeenCalledTimes(1); authorize.mockClear();
    const receiptFile = path.join(root, 'delivery', 'm01', 'deliver.json'); const bytes = await fs.readFile(receiptFile, 'utf8'); const raw = JSON.parse(bytes);
    const { calls } = trace();
    expect(await service.inspect(request)).toMatchObject({ status: 'delivered', commitSha: delivered.commitSha });
    await expect(service.inspect({ ...request, report: 'Changed request' })).rejects.toThrow('identity');
    await expect(service.inspect({ ...request, mission: { ...request.mission, deliveryPolicy: { ...request.mission.deliveryPolicy, requireIndependentReview: false } } })).rejects.toThrow('identity');
    for (const patch of [{ missionId: 'different' }, { operationId: 'different' }, { contentHash: 'a'.repeat(40) }, { parentCommitSha: 'b'.repeat(40) }, { expectedTargetHead: 'c'.repeat(40) }]) {
      await fs.writeFile(receiptFile, JSON.stringify({ ...raw, ...patch }));
      await expect(service.inspect(request)).rejects.toThrow('identity');
    }
    for (const patch of [{ stage: 'intent' }, { stage: 'committed' }, { stage: 'uncertain', pendingAction: 'commit' }, { stage: 'delivered', pendingAction: 'update_delivery_branch' }]) {
      const partial = JSON.stringify({ ...raw, ...patch }); await fs.writeFile(receiptFile, partial);
      expect(await service.inspect(request)).toBeUndefined(); expect(await fs.readFile(receiptFile, 'utf8')).toBe(partial);
    }
    await fs.writeFile(receiptFile, bytes);
    git(source, ['update-ref', `refs/heads/${raw.branch}`, fixture.baseline.revision.baseCommitSha, delivered.commitSha!]);
    await expect(service.inspect(request)).rejects.toThrow('branch changed');
    expect(authorize).not.toHaveBeenCalled();
    expect(calls.filter(({ args }) => ['fetch', 'push', 'commit-tree', 'update-ref', 'worktree'].includes(commandArgs(args)[0])).length).toBe(0);
    expect(await fs.readFile(receiptFile, 'utf8')).toBe(bytes);
    expect(await preserved()).toEqual(before);
  });

  it.each([true, false])('only treats an explicitly authorized open-PR hold as a recoverable endpoint: %s', async (holdIsEndpoint) => {
    const fixture = await owned(); const { observation, transport } = await githubObservation(fixture, 'held-target'); const before = await preserved();
    const authorize = vi.fn(async () => undefined); const { service, request } = delivery(fixture.workspaces, fixture.integration, observation, authorize);
    request.mission.deliveryPolicy = { ...request.mission.deliveryPolicy, endpoint: 'merge_pr', allowMerge: true, holdConditions: ['Required human review'], holdIsEndpoint };
    const { calls, spy } = trace(); let pr: ReturnType<typeof fixturePr> | undefined;
    spy.mockImplementation(async (file, args, options) => {
      calls.push({ args, options });
      if (args[0] !== 'pr') return transport(file, args, options);
      if (args[1] === 'list') return ok(JSON.stringify(pr ? [pr] : []));
      if (args[1] === 'create') {
        const branch = args[args.indexOf('--head') + 1];
        pr = fixturePr(branch, git(remote, ['rev-parse', `refs/heads/${branch}`]), 'target'); return ok(pr.url);
      }
      throw new Error('A review hold must not merge');
    });
    const receiptFile = path.join(root, 'delivery', 'm01', 'deliver.json');
    if (holdIsEndpoint) {
      const rename = fs.rename.bind(fs); let fail = true;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (fail && String(to) === receiptFile && JSON.parse(await fs.readFile(from, 'utf8')).stage === 'held') { fail = false; throw new Error('Lost hold receipt write'); }
        return rename(from, to);
      });
      await expect(service.deliver(request)).rejects.toThrow('Lost hold receipt write');
      const partial = await fs.readFile(receiptFile, 'utf8'); expect(JSON.parse(partial).stage).toBe('pr_created');
      expect(await service.inspect(request)).toMatchObject({ status: 'held', pullRequestUrl: pr!.url });
      expect(await fs.readFile(receiptFile, 'utf8')).toBe(partial);
    }
    const held = await service.deliver(request); expect(held.status).toBe(holdIsEndpoint ? 'held' : 'blocked');
    expect(calls.filter(({ args }) => commandArgs(args)[0] === 'push').length).toBe(1);
    expect(calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'create').length).toBe(1);
    const bytes = await fs.readFile(receiptFile, 'utf8'); const raw = JSON.parse(bytes);
    if (!holdIsEndpoint) {
      expect(raw.stage).toBe('pr_created'); expect(await service.inspect(request)).toBeUndefined();
      expect(await fs.readFile(receiptFile, 'utf8')).toBe(bytes); expect(await preserved()).toEqual(before); return;
    }
    expect(raw.stage).toBe('held'); expect(raw.pendingAction).toBeUndefined();
    authorize.mockClear(); calls.splice(0);
    expect(await service.inspect(request)).toMatchObject({ status: 'held', commitSha: held.commitSha, pullRequestUrl: held.pullRequestUrl, reason: expect.stringContaining('review hold') });
    expect((await service.deliver(request)).status).toBe('held');
    for (const stage of ['pr_created', 'creating_pr', 'uncertain']) {
      const partial = JSON.stringify({ ...raw, stage, pendingAction: stage === 'pr_created' ? undefined : 'create_pr' });
      await fs.writeFile(receiptFile, partial);
      expect(await service.inspect(request)).toMatchObject({ status: 'held', commitSha: held.commitSha, pullRequestUrl: held.pullRequestUrl });
      expect(await fs.readFile(receiptFile, 'utf8')).toBe(partial);
    }
    await fs.writeFile(receiptFile, bytes);
    for (const state of ['CLOSED', 'MERGED']) { pr!.state = state; await expect(service.inspect(request)).rejects.toThrow(/hold|satisfied/); }
    pr!.state = 'OPEN'; git(source, ['config', 'remote.origin.url', unsafeEndpoints[0]]);
    const invalid = await service.inspect(request).then(() => 'unexpected success', (error: Error) => error.message);
    expect(invalid).toMatch(/endpoint|credential/); expect(invalid).not.toContain('fixture-password');
    expect(authorize).not.toHaveBeenCalled();
    expect(calls.filter(({ args }) => ['fetch', 'push', 'commit-tree', 'update-ref'].includes(commandArgs(args)[0]) || args[0] === 'pr' && args[1] !== 'list').length).toBe(0);
    expect(await fs.readFile(receiptFile, 'utf8')).toBe(bytes);
    expect(await preserved()).toEqual(before);
  });
});

async function githubPublishFixture() {
  const fixture = await owned();
  git(source, ['remote', 'rename', 'origin', 'publish']);
  git(source, ['remote', 'set-url', 'publish', fixtureGitHubRemote]);
  git(source, ['remote', 'add', 'origin', 'https://wrong.invalid/unapproved/default.git']);
  const transport = fixtureGitHubTransport(remote);
  vi.spyOn(runtime, 'runCapture').mockImplementation(transport);
  const observation = await fixture.workspaces.observeApprovedTarget({ missionId: 'm01', operationId: 'github-target', remote: 'publish', targetBranch: 'target', authorize: async () => undefined });
  const authorize = vi.fn(async (_request: MissionDeliveryRequest, _action: string): Promise<void> => undefined);
  const { service, request } = delivery(fixture.workspaces, fixture.integration, observation, authorize);
  request.mission.deliveryPolicy.endpoint = 'merge_pr'; request.mission.deliveryPolicy.allowMerge = true;
  request.report = 'Private verified delivery report';
  const api = { pr: undefined as ReturnType<typeof fixturePr> | undefined, existing: false,
    receipt: (pr: ReturnType<typeof fixturePr>) => pr, createUrl: (pr: ReturnType<typeof fixturePr>) => pr.url };
  const { calls, spy } = trace();
  spy.mockImplementation(async (file, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'api') return githubCommitRead(args, api.pr!);
    if (args[0] !== 'pr') return transport(file, args, options);
    const branch = args[args.indexOf('--head') + 1];
    if (api.existing && !api.pr) api.pr = fixturePr(branch, git(source, ['rev-parse', `refs/heads/${branch}`]), 'target');
    if (args[1] === 'list') return ok(JSON.stringify(api.pr ? [api.receipt(api.pr)] : []));
    if (args[1] === 'create') {
      api.pr = fixturePr(branch, git(remote, ['rev-parse', `refs/heads/${branch}`]), 'target');
      return ok(api.createUrl(api.pr));
    }
    if (args[1] === 'merge') {
      git(remote, ['update-ref', 'refs/heads/target', api.pr!.headRefOid, observation.commitSha]);
      api.pr!.state = 'MERGED'; api.pr!.mergeCommit = { oid: api.pr!.headRefOid }; return ok();
    }
    throw new Error('Unexpected fixture GitHub operation');
  });
  return { service, request, calls, api, authorize };
}

describe('Mission exact GitHub publication routing at the production process boundary', () => {
  it('pins every read/create/merge/replay/inspect to the approved nondefault remote despite inherited routing overrides', async () => {
    const fixture = await githubPublishFixture();
    vi.stubEnv('GH_REPO', 'wrong.invalid/private/wrong'); vi.stubEnv('GH_HOST', 'wrong.invalid'); vi.stubEnv('GH_HTTP_UNIX_SOCKET', '/unapproved/transport');
    vi.stubEnv('GH_CONFIG_DIR', path.join(root, 'ordinary-gh-credential-storage')); // Fixture marker only; no credentials are read.
    const result = await fixture.service.deliver(fixture.request);
    expect(result).toMatchObject({ status: 'delivered', pullRequestUrl: `https://${fixtureGitHubRepo}/pull/1`, mergedCommitSha: result.commitSha });
    expect((await fixture.service.deliver(fixture.request)).commitSha).toBe(result.commitSha);
    const before = fixture.calls.length; fixture.authorize.mockClear();
    expect(await fixture.service.inspect(fixture.request)).toMatchObject({ status: 'delivered', commitSha: result.commitSha });
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.calls.slice(before).every(({ args }) => !['push', 'fetch', 'commit-tree', 'update-ref'].includes(commandArgs(args)[0]) && (args[0] !== 'pr' || args[1] === 'list'))).toBe(true);
    const github = fixture.calls.filter(({ args }) => ['pr', 'api'].includes(args[0]));
    expect(github.filter(({ args }) => args[1] === 'create')).toHaveLength(1);
    expect(github.filter(({ args }) => args[1] === 'merge')).toHaveLength(1);
    for (const { args, options } of github) {
      if (args[0] === 'pr') expect(args[args.indexOf('--repo') + 1]).toBe(fixtureGitHubRepo);
      else expect(args).toEqual(['api', '--hostname', 'example.invalid', `repos/fixture/repository/git/commits/${result.mergedCommitSha}`]);
      for (const key of ['GH_REPO', 'GH_HOST', 'GH_HTTP_UNIX_SOCKET']) expect(options?.env?.[key], key).toBeUndefined();
      expect(options?.env?.GH_PROMPT_DISABLED).toBe('1');
      expect(options?.env?.GH_CONFIG_DIR).toBe(path.join(root, 'ordinary-gh-credential-storage'));
    }
    expect(github.find(({ args }) => args[1] === 'merge')!.args).toEqual(['pr', 'merge', '1', '--repo', fixtureGitHubRepo, '--merge', '--match-head-commit', result.commitSha]);
    expect(fixture.calls.filter(({ args }) => network(args)).every(({ args }) => args.includes(fixtureGitHubRemote))).toBe(true);
  });

  it.each([
    { name: 'foreign host', patch: { url: 'https://foreign.invalid/fixture/repository/pull/1' } },
    { name: 'foreign merged PR', patch: { url: 'https://foreign.invalid/fixture/repository/pull/1', state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } } },
    { name: 'foreign owner', patch: { url: 'https://example.invalid/other/repository/pull/1' } },
    { name: 'foreign repository', patch: { url: 'https://example.invalid/fixture/other/pull/1' } },
    { name: 'wrong PR number', patch: { number: 2 } },
    { name: 'different head branch', patch: { headRefName: 'other-branch' } },
    { name: 'different base branch', patch: { baseRefName: 'other-target' } },
    { name: 'same-named fork', patch: { headRepository: { nameWithOwner: 'other/repository' }, headRepositoryOwner: { login: 'other' } } },
    { name: 'cross-repository head', patch: { isCrossRepository: true } },
    { name: 'different head commit', patch: { headRefOid: 'd'.repeat(40) } },
    { name: 'credential-bearing URL', patch: { url: 'https://fixture-secret@example.invalid/fixture/repository/pull/1' } },
  ])('rejects a reused PR with $name before private payload publication', async ({ patch }) => {
    const fixture = await githubPublishFixture(); fixture.api.existing = true;
    fixture.api.receipt = (pr) => ({ ...pr, ...patch });
    await expect(fixture.service.deliver(fixture.request)).rejects.toThrow(/PR receipt/);
    expect(fixture.calls.filter(({ args }) => commandArgs(args)[0] === 'push' || args[0] === 'pr' && args[1] !== 'list')).toHaveLength(0);
    expect(JSON.stringify(fixture.calls.map(({ args }) => args))).not.toContain(fixture.request.report);
    expect(git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/target');
  });

  it.each(['create response', 'created PR lookup'] as const)('never merges a foreign %s', async (response) => {
    const fixture = await githubPublishFixture();
    const foreign = 'https://foreign.invalid/unapproved/repository/pull/1';
    if (response === 'create response') fixture.api.createUrl = () => foreign;
    else fixture.api.receipt = (pr) => ({ ...pr, url: foreign });
    await expect(fixture.service.deliver(fixture.request)).rejects.toThrow(/PR receipt/);
    expect(fixture.calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(0);
    expect(git(remote, ['rev-parse', 'refs/heads/target'])).toBe(fixture.request.mission.deliveryPolicy.targetHead);
  });

  it('revalidates PR head/base identity after merge authorization rather than merging a stale receipt', async () => {
    const fixture = await githubPublishFixture();
    fixture.authorize.mockImplementation(async (_request, action) => {
      if (action === 'merge_pr') fixture.api.receipt = (pr) => ({ ...pr, baseRefName: 'replacement-target' });
    });
    await expect(fixture.service.deliver(fixture.request)).rejects.toThrow(/PR receipt/);
    expect(fixture.calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(0);
    expect(git(remote, ['rev-parse', 'refs/heads/target'])).toBe(fixture.request.mission.deliveryPolicy.targetHead);
  });

  it('revalidates retained PR identity during read-only inspection without rewriting receipts or effects', async () => {
    const fixture = await githubPublishFixture(); fixture.request.mission.deliveryPolicy.endpoint = 'open_pr';
    await fixture.service.deliver(fixture.request);
    const receiptFile = path.join(root, 'delivery', 'm01', 'deliver.json'), bytes = await fs.readFile(receiptFile, 'utf8');
    fixture.calls.splice(0); fixture.authorize.mockClear();
    for (const stage of ['delivered', 'creating_pr', 'pr_created', 'uncertain']) {
      const partial = JSON.stringify({ ...JSON.parse(bytes), stage, pendingAction: ['creating_pr', 'uncertain'].includes(stage) ? 'create_pr' : undefined });
      await fs.writeFile(receiptFile, partial);
      for (const patch of [
        { url: 'https://foreign.invalid/fixture/repository/pull/1' },
        { url: 'https://example.invalid/fixture/other/pull/1' },
        { headRefName: 'foreign-head' }, { baseRefName: 'foreign-base' }, { headRefOid: 'd'.repeat(40) },
        { isCrossRepository: true }, { headRepository: { nameWithOwner: 'other/repository' } },
      ]) {
        fixture.api.receipt = (pr) => ({ ...pr, ...patch });
        await expect(fixture.service.inspect(fixture.request)).rejects.toThrow(/PR receipt/);
        expect(await fs.readFile(receiptFile, 'utf8')).toBe(partial);
      }
    }
    await fs.writeFile(receiptFile, bytes);
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.calls.every(({ args }) => !['push', 'fetch', 'commit-tree', 'update-ref'].includes(commandArgs(args)[0]) && (args[0] !== 'pr' || args[1] === 'list'))).toBe(true);
    expect(await fs.readFile(receiptFile, 'utf8')).toBe(bytes);
  });

  it('rejects local and non-GitHub-shaped delivery endpoints before commit, push, gh or private report publication', async () => {
    const fixture = await owned();
    const { calls, spy } = trace();
    spy.mockImplementation(async (file, args, options) => {
      calls.push({ args, options });
      if (network(args)) return ok();
      if (args[0] === 'pr') return ok('[]');
      return capture(file, args, options);
    });
    for (const endpoint of [remote, 'https://example.invalid/fixture.git', 'https://example.invalid/group/subgroup/repo.git', 'ssh://git@example.invalid:2222/owner/repo.git']) {
      git(source, ['remote', 'set-url', 'origin', endpoint]);
      const authorize = vi.fn(async () => undefined), { service, request } = delivery(fixture.workspaces, fixture.integration, undefined, authorize);
      request.report = 'Private report must stay local';
      request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint: 'open_pr', allowPush: true, remote: 'origin', targetBranch: 'target', targetHead: fixture.baseline.revision.baseCommitSha };
      await expect(service.deliver(request)).rejects.toThrow(/GitHub.*endpoint/);
      expect(authorize).not.toHaveBeenCalled();
    }
    expect(calls.some(({ args }) => args[0] === 'pr' || ['commit-tree', 'push'].includes(commandArgs(args)[0]) || args.includes('Private report must stay local'))).toBe(false);
    expect(await fs.readdir(path.join(root, 'delivery')).catch(() => [])).toEqual([]);
  });
});

describe('Mission approved remote endpoint boundary', () => {
  it('rejects unsafe or relative endpoints before authorization, persistence or an external Git process', async () => {
    const fixture = await owned(); const before = await preserved(); const { calls, spy } = trace();
    // A pre-fix regression must never actually execute a custom helper or contact a fixture URL.
    spy.mockImplementation(async (file, args, options) => { calls.push({ args, options }); return network(args) ? { code: 1, stdout: '', stderr: 'Fixture intercepted unsafe external dispatch' } : capture(file, args, options); });
    for (const [index, endpoint] of unsafeEndpoints.entries()) {
      git(source, ['config', 'remote.origin.url', endpoint]); const authorize = vi.fn(async () => undefined);
      const result = await fixture.observe(`unsafe-${index}`, authorize).then(() => 'unexpected success', (error: Error) => error.message);
      expect(result).toMatch(/credential|endpoint|relative|supported/i);
      expect(result).not.toContain(endpoint);
      expect(authorize).not.toHaveBeenCalled();
      expect(await retainedText()).not.toContain(endpoint);
    }
    expect(calls.filter(({ args }) => network(args)).length).toBe(0);
    expect(git(source, ['for-each-ref', '--format=%(refname)', 'refs/vocs-missions'])).not.toContain('observations/');
    expect(await preserved()).toEqual(before);
  });

  it('blocks unsafe configured endpoints in default policy resolution without leaking their values', async () => {
    const { calls, spy } = trace();
    spy.mockImplementation(async (file, args, options) => { calls.push({ args, options }); return network(args) ? { code: 1, stdout: '', stderr: 'Fixture intercepted unsafe external dispatch' } : capture(file, args, options); });
    for (const endpoint of unsafeEndpoints) {
      git(source, ['config', 'remote.origin.url', endpoint]);
      const result = await resolveMissionDeliveryPolicy(source).then((policy) => JSON.stringify(policy), (error: Error) => error.message);
      expect(result).not.toContain(endpoint);
    }
    expect(calls.filter(({ args }) => network(args)).length).toBe(0);
  });

  it('rejects unsafe standalone delivery endpoints before commit authorization or delivery receipts', async () => {
    const fixture = await owned(); const before = await preserved(); const { calls, spy } = trace();
    spy.mockImplementation(async (file, args, options) => {
      calls.push({ args, options });
      if (network(args)) return { code: 1, stdout: '', stderr: 'Fixture intercepted unsafe external dispatch' };
      return args[0] === 'pr' ? ok('[]') : capture(file, args, options);
    });
    for (const endpoint of unsafeEndpoints) {
      git(source, ['config', 'remote.origin.url', endpoint]); const authorize = vi.fn(async () => undefined);
      const { service, request } = delivery(fixture.workspaces, fixture.integration, undefined, authorize);
      request.mission.deliveryPolicy = { ...localMissionDeliveryPolicy(), endpoint: 'open_pr', allowPush: true, remote: 'origin', targetBranch: 'target', targetHead: fixture.baseline.revision.baseCommitSha };
      const result = await service.deliver(request).then(() => 'unexpected success', (error: Error) => error.message);
      expect(result).toMatch(/credential|endpoint|relative|supported/i); expect(result).not.toContain(endpoint);
      expect(authorize).not.toHaveBeenCalled();
    }
    expect(calls.filter(({ args }) => network(args)).length).toBe(0);
    expect(calls.filter(({ args }) => commandArgs(args)[0] === 'commit-tree').length).toBe(0);
    expect(await fs.readdir(path.join(root, 'delivery')).catch(() => [])).toEqual([]);
    expect(await preserved()).toEqual(before);
  });

  it('retains standard HTTPS and SSH usernames while validating at the actual fetch process boundary', async () => {
    const fixture = await owned(); const head = fixture.baseline.revision.baseCommitSha; const { calls, spy } = trace();
    spy.mockImplementation(async (file, args, options) => {
      calls.push({ args, options }); const command = commandArgs(args);
      if (command[0] === 'ls-remote') return ok(`${head}\trefs/heads/target\n`);
      if (command[0] === 'fetch') { git(source, ['update-ref', command.at(-1)!.split(':')[1], head]); return ok(); }
      return capture(file, args, options);
    });
    for (const [index, endpoint] of ['https://example.invalid/owner/repo.git', 'git@example.invalid:owner/repo.git', 'ssh://git@example.invalid/owner/repo.git'].entries()) {
      git(source, ['config', 'remote.origin.url', endpoint]);
      expect(await fixture.observe(`standard-${index}`)).toMatchObject({ remoteUrl: endpoint, commitSha: head });
    }
    expect(calls.filter(({ args }) => commandArgs(args)[0] === 'fetch')).toHaveLength(3);
  });

  it.each(['replacement', 'credentials'])('revalidates the source endpoint after fetch approval: %s', async (change) => {
    const fixture = await owned(); const before = await preserved(); const { calls, spy } = trace();
    const replacement = change === 'credentials' ? unsafeEndpoints[0] : path.join(root, 'replacement.git');
    spy.mockImplementation(async (file, args, options) => { calls.push({ args, options }); return network(args) ? { code: 1, stdout: '', stderr: 'Fixture intercepted remote dispatch' } : capture(file, args, options); });
    const result = await fixture.observe('approval-race', async () => { git(source, ['config', 'remote.origin.url', replacement]); }).then(() => 'unexpected success', (error: Error) => error.message);
    expect(result).toMatch(/endpoint|credential/i); expect(result).not.toContain(replacement);
    expect(calls.filter(({ args }) => network(args)).length).toBe(0);
    expect(await retainedText()).not.toContain(replacement);
    expect(await preserved()).toEqual(before);
  });

  it('binds observation to the original source configuration, not an owned worktree override', async () => {
    const fixture = await owned(); const before = await preserved();
    git(source, ['config', 'extensions.worktreeConfig', 'true']);
    git(fixture.integration.cwd, ['config', '--worktree', 'remote.origin.url', unsafeEndpoints[0]]);
    const observation = await fixture.observe('source-endpoint');
    expect(observation.remoteUrl).toBe(remote);
    expect(await retainedText()).not.toContain('fixture-password');
    expect(await preserved()).toEqual(before);
  });

  it('revalidates again between expected-head observation and fetch', async () => {
    const fixture = await owned(); const before = await preserved(); const { calls, spy } = trace();
    let changed = false;
    spy.mockImplementation(async (file, args, options) => {
      calls.push({ args, options }); const result = await capture(file, args, options);
      if (commandArgs(args)[0] === 'ls-remote') { changed = true; git(source, ['config', 'remote.origin.url', path.join(root, 'replacement.git')]); }
      return result;
    });
    await expect(fixture.observe('before-fetch-race')).rejects.toThrow('endpoint changed');
    expect(changed).toBe(true);
    expect(calls.filter(({ args }) => commandArgs(args)[0] === 'fetch').length).toBe(0);
    expect(await preserved()).toEqual(before);
  });

  it('does not reapply a second Git URL rewrite to an already approved endpoint', async () => {
    const fixture = await owned(); const { calls, spy } = trace();
    git(source, ['config', 'remote.origin.url', 'fixture-alias:repository']);
    git(source, ['config', `url.${remote}.insteadOf`, 'fixture-alias:repository']);
    git(source, ['config', `url.${unsafeEndpoints[0]}.insteadOf`, remote]);
    spy.mockImplementation(async (file, args, options) => { calls.push({ args, options }); return network(args) ? { code: 1, stdout: '', stderr: 'Fixture intercepted rewritten dispatch' } : capture(file, args, options); });
    const result = await fixture.observe('rewrite').then(() => 'unexpected success', (error: Error) => error.message);
    expect(result).toMatch(/endpoint|rewrite/i); expect(result).not.toContain('fixture-password');
    expect(calls.filter(({ args }) => network(args)).length).toBe(0);
    expect(await retainedText()).not.toContain('fixture-password');
  });

  it('pushes and verifies a merge through the approved URL with real Git, no hooks and no source/index changes', async () => {
    const fixture = await owned(); const { observation, transport } = await githubObservation(fixture, 'publish-target'); const before = await preserved();
    const hooks = path.join(root, 'hooks'), marker = path.join(root, 'hook-ran'); await fs.mkdir(hooks);
    const script = `#!/bin/sh\nprintf hook > '${marker.replaceAll('\\', '/')}'\n`;
    for (const name of ['reference-transaction', 'pre-push', 'fsmonitor']) { await fs.writeFile(path.join(hooks, name), script); await fs.chmod(path.join(hooks, name), 0o755); }
    git(source, ['config', 'core.hooksPath', hooks]); git(source, ['config', 'core.fsmonitor', path.join(hooks, 'fsmonitor')]);
    const { calls, spy } = trace(); poisonEnvironment();
    let pr: ReturnType<typeof fixturePr> | undefined;
    spy.mockImplementation(async (file, args, options) => {
      calls.push({ args, options });
      if (args[0] === 'api') return githubCommitRead(args, pr!);
      if (args[0] !== 'pr') return transport(file, args, options);
      if (args[1] === 'list') return ok(JSON.stringify(pr ? [pr] : []));
      if (args[1] === 'create') {
        const branch = args[args.indexOf('--head') + 1];
        pr = fixturePr(branch, git(remote, ['rev-parse', `refs/heads/${branch}`]), 'target');
        return ok(pr.url);
      }
      if (args[1] === 'merge') {
        git(remote, ['update-ref', 'refs/heads/target', pr!.headRefOid, observation.commitSha]);
        pr!.state = 'MERGED'; pr!.mergeCommit = { oid: pr!.headRefOid }; return ok();
      }
      throw new Error('Unexpected fixture GitHub command');
    });
    const { service, request } = delivery(fixture.workspaces, fixture.integration, observation);
    request.mission.deliveryPolicy.endpoint = 'merge_pr'; request.mission.deliveryPolicy.allowMerge = true;
    const result = await service.deliver(request);
    expect(result).toMatchObject({ status: 'delivered', mergedCommitSha: result.commitSha });
    expect((await service.deliver(request)).commitSha).toBe(result.commitSha);
    const receiptFile = path.join(root, 'delivery', 'm01', 'deliver.json');
    const receiptBefore = await fs.readFile(receiptFile, 'utf8');
    const inspectedCalls = calls.length;
    expect(await service.inspect(request)).toMatchObject({ status: 'delivered', commitSha: result.commitSha, mergedCommitSha: result.commitSha });
    expect(calls.slice(inspectedCalls).filter(({ args }) => ['fetch', 'push', 'commit-tree', 'update-ref'].includes(commandArgs(args)[0])).length).toBe(0);
    expect(await fs.readFile(receiptFile, 'utf8')).toBe(receiptBefore);
    protectedProcesses(calls.filter(({ args }) => !['pr', 'api'].includes(args[0])));
    for (const { options } of calls.filter(({ args }) => ['pr', 'api'].includes(args[0]))) {
      expect(options?.env?.GIT_DIR).toBeUndefined(); expect(options?.env?.GCM_INTERACTIVE).toBe('never'); expect(options?.env?.GH_PROMPT_DISABLED).toBe('1');
    }
    const external = calls.filter(({ args }) => network(args)).map(({ args }) => commandArgs(args));
    expect(external.every((args) => args.includes(fixtureGitHubRemote))).toBe(true);
    expect(external.filter((args) => args[0] === 'push').length).toBe(1);
    expect(external.filter((args) => args[0] === 'fetch').length).toBe(2);
    expect(calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'create').length).toBe(1);
    expect(calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'merge').length).toBe(1);
    expect(await fs.readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(git(source, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', result.commitSha!])).toBe('Git Boundary Fixture <git-boundary@example.invalid>|Git Boundary Fixture <git-boundary@example.invalid>');
    expect(await preserved()).toEqual(before);
  });

  it('revalidates after push approval and never passes a replacement endpoint to the production process', async () => {
    const fixture = await owned(); const { observation, transport } = await githubObservation(fixture, 'delivery-target'); const before = await preserved(); const { calls, spy } = trace();
    spy.mockImplementation(async (file, args, options) => { calls.push({ args, options }); return args[0] === 'pr' ? ok('[]') : transport(file, args, options); });
    const { service, request } = delivery(fixture.workspaces, fixture.integration, observation, async (_request, action) => { if (action === 'push') git(source, ['config', 'remote.origin.url', unsafeEndpoints[0]]); });
    const result = await service.deliver(request).then(() => 'unexpected success', (error: Error) => error.message);
    expect(result).toMatch(/endpoint|credential/i); expect(result).not.toContain('fixture-password');
    expect(calls.filter(({ args }) => commandArgs(args)[0] === 'push').length).toBe(0);
    expect(calls.filter(({ args }) => network(args)).every(({ args }) => args.includes(fixtureGitHubRemote))).toBe(true);
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain('fixture-password');
    expect(await preserved()).toEqual(before);
  });
});
