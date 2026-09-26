/** Production verification + workspace boundaries over real Git trees and real subprocesses. */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { MissionVerification, parseTestReport, type VerificationRequest } from '../src/main/mission/verification';
import { MissionWorkspaces } from '../src/main/mission/workspaces';
import { MissionScheduler } from '../src/main/mission/scheduler';

it.each([undefined, 'report.tap'])('binds real test evidence to an isolated immutable tree and rejects a check that changes it (report: %s)', async (report) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-check-tree-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: source, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  };
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Mission Verification Test');
    git('config', 'user.email', 'mission-verification-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(source, 'source.txt'), 'immutable original\n');
    await fs.writeFile(path.join(source, 'case.cjs'), "const{test}=require('node:test');const assert=require('node:assert/strict');test('source',()=>assert.equal(require('node:fs').readFileSync('source.txt','utf8'),'immutable original\\n'));\n");
    await fs.writeFile(path.join(source, 'mutate.cjs'), "require('node:fs').writeFileSync('source.txt','changed by check');\n");
    git('add', '.'); git('-c', 'core.hooksPath=', 'commit', '-m', 'Fixture baseline');
    const head = git('rev-parse', 'HEAD');
    const index = await fs.readFile(path.join(source, '.git', 'index'));
    const held = new Set<string>();
    const workspaces = new MissionWorkspaces({
      root: path.join(root, 'owned'),
      quiescence: { acquire: async (cwd) => {
        if (held.has(cwd)) return null;
        held.add(cwd);
        return { assertQuiescent: async () => { if (!held.has(cwd)) throw new Error('Lost exclusive lease'); }, release: () => { held.delete(cwd); } };
      } },
    });
    const probe = await workspaces.probeBaseline(source);
    if (!probe.ok) throw new Error(probe.message);
    await workspaces.provision({ missionId: 'mission', baseline: probe.baseline, role: 'lead' });
    const scheduler = new MissionScheduler({ maxConcurrentAgentTurnsGlobal: 10, maxConcurrentWorkersPerMission: 4, maxConcurrentHeavyChecksGlobal: 1 });
    scheduler.register('mission');
    const artifacts: Buffer[] = [];
    const verification = new MissionVerification({
      scheduler, windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'),
      authorize: async (request) => {
        const workspace = await workspaces.workspaceAt(request.cwd);
        if (workspace.role !== 'verification' || workspace.operationId !== request.operationId || workspace.missionId !== request.missionId) throw new Error('Wrong owned verification workspace');
      },
      contentIdentity: (cwd) => workspaces.contentIdentity(cwd),
      saveArtifact: async (_mission, bytes) => { artifacts.push(Buffer.from(bytes)); return `artifact_${artifacts.length}`; },
    });
    const workspace = await workspaces.provisionVerification({ missionId: 'mission', operationId: 'test', revision: probe.baseline.revision });
    const request: VerificationRequest = {
      missionId: 'mission', operationId: 'test', specificationRevision: 1, cwd: workspace.cwd, revision: probe.baseline.revision,
      check: { id: 'tests', name: 'Tests', command: `node --test --test-reporter=tap ${report ? `--test-reporter-destination=${report} ` : ''}case.cjs`, kind: 'test', required: true, heavy: true,
        criterionIds: ['source'], timeoutMs: 5000, testReport: { format: 'node-tap', path: report, minimumTests: 1, maximumSkipped: 0 } },
    };
    const evidence = await workspaces.withQuiescence(workspace.cwd, () => verification.run(request));
    expect(evidence).toMatchObject({ result: 'passed', executedTests: 1, skippedTests: 0, sourceRevision: probe.baseline.revision, cwd: workspace.cwd, commandOrFlow: request.check.command, provenance: 'host_executed' });
    expect(await workspaces.contentIdentity(workspace.cwd)).toEqual(probe.baseline.revision);
    if (report) {
      await expect(fs.lstat(path.join(workspace.cwd, report))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(evidence.artifactIds[2]).toBe('artifact_3');
      expect(parseTestReport('node-tap', artifacts[2].toString())).toEqual({ executed: 1, failed: 0, skipped: 0 });
    }
    const mutationWorkspace = await workspaces.provisionVerification({ missionId: 'mission', operationId: 'mutation', revision: probe.baseline.revision });
    const mutation = await workspaces.withQuiescence(mutationWorkspace.cwd, () => verification.run({
      ...request, operationId: 'mutation', cwd: mutationWorkspace.cwd,
      check: report ? { ...request.check, command: `${request.check.command} && node mutate.cjs` }
        : { ...request.check, kind: 'build', command: 'node mutate.cjs', testReport: undefined },
    }));
    expect(mutation).toMatchObject({ result: 'failed', exitCode: 0, invalidatedBy: expect.stringContaining('changed source') });
    if (report) {
      expect(mutation).toMatchObject({ executedTests: 1, skippedTests: 0 });
      await expect(fs.lstat(path.join(mutationWorkspace.cwd, report))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(parseTestReport('node-tap', artifacts[6].toString())).toEqual({ executed: 1, failed: 0, skipped: 0 });
    }
    expect(await fs.readFile(path.join(mutationWorkspace.cwd, 'source.txt'), 'utf8')).toBe('changed by check');
    expect(await fs.readFile(path.join(source, 'source.txt'), 'utf8')).toBe('immutable original\n');
    expect(await fs.readFile(path.join(source, '.git', 'index'))).toEqual(index);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(await workspaces.acceptedRevision('mission')).toEqual(probe.baseline.revision);
    expect(scheduler.snapshot().active).toEqual([]);
    expect(verification.active()).toEqual([]);
    expect(held.size).toBe(0);
    expect(JSON.parse(artifacts.at(-1)!.toString())).toMatchObject({ sourceRevision: probe.baseline.revision, result: 'failed', quiescent: true });
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}); // Use the suite's integration timeout; each actual check still has its own 5-second limit.
