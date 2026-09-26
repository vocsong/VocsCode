/** Conventional npm gates in fresh verification worktrees, over real Git, npm and owned processes.
 * The fixture's only dependency is a local file: package, so npm ci installs it without a network. */
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MissionVerification, type VerificationRequest } from '../src/main/mission/verification';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import { MissionScheduler } from '../src/main/mission/scheduler';
import { resolveMissionDeliveryPolicy } from '../src/main/mission/policy';
import { checkOwnershipDirectory, processOwnershipIntents, processOwnershipQuiescent } from '../src/main/mission/process-ownership';
import type { MissionCheck } from '../src/shared/mission';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-check-deps-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// npm is a .cmd shim on Windows, which Node spawns only through a shell.
function npm(cwd: string, ...args: string[]): string {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

const manifest = {
  name: 'mission-dependency-fixture', version: '1.0.0', private: true,
  // A lifecycle script records the setup's own npm configuration, and how often it ran.
  scripts: { postinstall: 'node record-setup.cjs', typecheck: 'node check.cjs typecheck', test: 'node --test dependency.test.cjs', build: 'node check.cjs build' },
  dependencies: { 'local-dep': 'file:vendor/local-dep' },
};
const fixture = (): Record<string, string> => ({
  '.gitignore': 'node_modules/\n.setup-record\n',
  'package.json': JSON.stringify(manifest, null, 2),
  'vendor/local-dep/package.json': JSON.stringify({ name: 'local-dep', version: '1.0.0', main: 'index.js' }),
  'vendor/local-dep/index.js': "module.exports = 'installed dependency';\n",
  'record-setup.cjs': "require('node:fs').appendFileSync('.setup-record', JSON.stringify({ cache: process.env.npm_config_cache, userconfig: process.env.npm_config_userconfig }) + '\\n');\n",
  'check.cjs': "if (require('local-dep') !== 'installed dependency') process.exit(3);\nconsole.log(`${process.argv[2]} used the installed dependency`);\n",
  'dependency.test.cjs': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('resolves the installed dependency', () => assert.equal(require('local-dep'), 'installed dependency'));\n",
  'manifest-check.cjs': "process.exit(require('node:fs').existsSync('node_modules') ? 4 : 0);\n",
});

/** Commits the files as the Mission's source, optionally locking dependencies before `drift`. */
async function project(files: Record<string, string>, options: { lock?: boolean; drift?: Record<string, string> } = {}): Promise<string> {
  const source = path.join(root, 'source');
  const write = async (entries: Record<string, string>) => {
    for (const [name, body] of Object.entries(entries)) { const target = path.join(source, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, body); }
  };
  await write(files);
  if (options.lock) npm(source, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--offline');
  await write(options.drift ?? {});
  git(source, 'init', '--initial-branch=main'); git(source, 'config', 'user.name', 'Mission Dependency Test');
  git(source, 'config', 'user.email', 'mission-dependency-test@example.invalid'); git(source, 'config', 'commit.gpgsign', 'false'); git(source, 'config', 'core.autocrlf', 'false');
  git(source, 'add', '.'); git(source, '-c', 'core.hooksPath=', 'commit', '-m', 'Fixture baseline');
  return source;
}

async function harness(source: string) {
  const held = new Set<string>();
  const workspaces = new MissionWorkspaces({ root: path.join(root, 'owned'), quiescence: { acquire: async (cwd) => {
    if (held.has(cwd)) return null;
    held.add(cwd);
    return { assertQuiescent: async () => { if (!held.has(cwd)) throw new Error('Lost exclusive lease'); }, release: () => { held.delete(cwd); } };
  } } });
  const probe = await workspaces.probeBaseline(source);
  if (!probe.ok) throw new Error(probe.message);
  await workspaces.provision({ missionId: 'mission', baseline: probe.baseline, role: 'lead' });
  const scheduler = new MissionScheduler({ maxConcurrentAgentTurnsGlobal: 10, maxConcurrentWorkersPerMission: 4, maxConcurrentHeavyChecksGlobal: 1 });
  scheduler.register('mission');
  const artifacts: string[] = [];
  const verification = new MissionVerification({
    scheduler, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'), ownershipRoot: path.join(root, 'ownership'),
    authorize: async (request) => {
      const workspace = await workspaces.workspaceAt(request.cwd);
      if (workspace.role !== 'verification' || workspace.missionId !== request.missionId) throw new Error('Wrong owned verification workspace');
    },
    contentIdentity: (cwd) => workspaces.contentIdentity(cwd),
    saveArtifact: async (_mission, bytes) => { artifacts.push(bytes.toString('utf8')); return `artifact_${artifacts.length}`; },
  });
  const revision = probe.baseline.revision;
  const run = async (operationId: string, cwd: string, check: MissionCheck) => {
    const request: VerificationRequest = { missionId: 'mission', operationId, specificationRevision: 1, revision, cwd, check };
    return workspaces.withQuiescence(cwd, () => verification.run(request));
  };
  const worktree = async (operationId: string) => (await workspaces.provisionVerification({ missionId: 'mission', operationId, revision })).cwd;
  return { workspaces, verification, scheduler, artifacts, revision, run, worktree };
}
const absent = (file: string) => expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
const setup = (environmentRef: string) => /dependencies=([^;]+)/.exec(environmentRef)?.[1];

it('installs the locked dependencies once per fresh verification worktree, so every conventional gate passes', async () => {
  const source = await project(fixture(), { lock: true });
  const { workspaces, verification, scheduler, revision, run, worktree } = await harness(source);
  const policy = await resolveMissionDeliveryPolicy(source);
  expect(policy.conflicts).toEqual([]);
  // The approved contracts are unchanged: dependency setup is the host's, not a new command.
  expect(policy.checks.map((check) => [check.id, check.command])).toEqual([['project-typecheck', 'npm run typecheck'], ['project-test', 'npm --silent test -- --test-reporter=tap'], ['project-build', 'npm run build']]);
  const cwd = await worktree('gates');
  await absent(path.join(cwd, 'node_modules')); // A fresh worktree holds committed files only.
  const evidence = [];
  for (const check of policy.checks) evidence.push(await run(`gate-${check.id}`, cwd, check));
  expect(evidence.map((entry) => entry.result)).toEqual(['passed', 'passed', 'passed']);
  expect(evidence[1]).toMatchObject({ executedTests: 1, skippedTests: 0 });
  expect(evidence.map((entry) => setup(entry.environmentRef))).toEqual(['npm:installed', 'npm:reused', 'npm:reused']);
  // One `npm ci` with lifecycle scripts, the user's real download cache and no user npmrc.
  const records = (await fs.readFile(path.join(cwd, '.setup-record'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { cache: string; userconfig: string });
  expect(records).toHaveLength(1);
  expect(records[0].cache).toBe(npm(os.homedir(), 'config', 'get', 'cache'));
  expect(records[0].userconfig).toContain('vocs-mission-check-');
  expect(await workspaces.contentIdentity(cwd)).toEqual(revision); // Installed packages are not verified content.
  // Every fresh worktree prepares its own node_modules; nothing mutable is shared between them.
  const next = await worktree('next');
  expect(await run('next-typecheck', next, policy.checks[0])).toMatchObject({ result: 'passed', environmentRef: expect.stringContaining('dependencies=npm:installed') });
  expect(verification.active()).toEqual([]);
  expect(scheduler.snapshot().active).toEqual([]);
  if (process.platform === 'win32') {
    // Setup is its own owned launch: 2 + 1 + 1 intents in the first worktree, 2 in the next.
    const intents = await processOwnershipIntents(checkOwnershipDirectory(path.join(root, 'ownership'), 'mission'));
    expect(intents).toHaveLength(6);
    for (const intent of intents) expect(await processOwnershipQuiescent(intent)).toBe(true);
  }
});

it('reports a failed dependency install as an environment blocker, never as a failed project check', async () => {
  // package.json gains a dependency after locking: `npm ci` refuses the out-of-sync lockfile.
  const source = await project({ ...fixture(), 'vendor/other-dep/package.json': JSON.stringify({ name: 'other-dep', version: '1.0.0' }) }, {
    lock: true, drift: { 'package.json': JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'other-dep': 'file:vendor/other-dep' } }, null, 2) },
  });
  const { verification, scheduler, artifacts, run, worktree } = await harness(source);
  const policy = await resolveMissionDeliveryPolicy(source);
  const cwd = await worktree('drift');
  const evidence = await run('drift-typecheck', cwd, policy.checks[0]);
  expect(evidence).toMatchObject({ result: 'blocked', failure: { kind: 'environment', code: 'dependency_setup_failed', confidence: 'observed', recovery: 'lead_diagnosis' } });
  expect(evidence.exitCode).toBeUndefined();
  expect(evidence.failure!.message).toMatch(/npm ci.*check did not run/);
  expect(artifacts.join('\n')).toMatch(/in sync/); // npm's own diagnosis is retained as a setup log.
  expect(artifacts.join('\n')).not.toContain('used the installed dependency');
  await absent(path.join(cwd, '.setup-record'));
  expect(verification.active()).toEqual([]);
  expect(scheduler.snapshot().active).toEqual([]);
});

it('blocks an unsupported package manager with an actionable reason instead of running doomed gates', async () => {
  const source = await project({ ...fixture(), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
  const { artifacts, run, worktree } = await harness(source);
  const policy = await resolveMissionDeliveryPolicy(source);
  expect(policy.conflicts).toEqual([expect.stringContaining('pnpm (pnpm-lock.yaml)')]);
  const cwd = await worktree('pnpm');
  const evidence = await run('pnpm-typecheck', cwd, policy.checks[0]);
  expect(evidence).toMatchObject({ result: 'blocked', failure: { kind: 'environment', code: 'dependency_setup_unsupported', recovery: 'user_action' } });
  expect(evidence.failure!.message).toContain('.vocs-code/mission-delivery.json');
  expect(artifacts.join('\n')).not.toContain('used the installed dependency');
  await absent(path.join(cwd, 'node_modules'));
});

it('refuses to install into an unignored node_modules, which would change the verified content', async () => {
  const source = await project({ ...fixture(), '.gitignore': '.setup-record\n' }, { lock: true });
  const { run, worktree } = await harness(source);
  const policy = await resolveMissionDeliveryPolicy(source);
  const cwd = await worktree('unignored');
  expect(await run('unignored-typecheck', cwd, policy.checks[0])).toMatchObject({ result: 'blocked', failure: { code: 'dependency_setup_unsupported', message: expect.stringContaining('node_modules is not ignored') } });
  await absent(path.join(cwd, 'node_modules'));
});

it('leaves explicit manifest checks responsible for their own setup', async () => {
  const source = await project(fixture(), { lock: true });
  const { run, worktree } = await harness(source);
  const cwd = await worktree('manifest');
  const check: MissionCheck = { id: 'behavior', name: 'Behavior', kind: 'behavior', command: 'node manifest-check.cjs', criterionIds: ['behavior'], required: true, heavy: true, timeoutMs: 30_000 };
  const evidence = await run('manifest-behavior', cwd, check);
  expect(evidence).toMatchObject({ result: 'passed', exitCode: 0 });
  expect(setup(evidence.environmentRef)).toBeUndefined();
  await absent(path.join(cwd, 'node_modules'));
});

