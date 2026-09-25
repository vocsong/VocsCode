import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionVerification, isolatedCheckEnvironment, parseTestReport, type VerificationDeps, type VerificationRequest } from '../src/main/mission/verification';
import { MissionScheduler } from '../src/main/mission/scheduler';

let root: string;
let sequence = 0;
const revision = { baseCommitSha: 'base', contentHash: 'exact-source' };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-verify-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function fixture(extra: Partial<Omit<VerificationDeps, 'scheduler'>> = {}) {
  const scheduler = new MissionScheduler({ maxConcurrentAgentTurnsGlobal: 10, maxConcurrentWorkersPerMission: 4, maxConcurrentHeavyChecksGlobal: 1 });
  scheduler.register('mission');
  const artifacts: Buffer[] = [];
  const service = new MissionVerification({
    scheduler, authorize: async () => undefined, contentIdentity: async () => revision,
    windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'),
    saveArtifact: async (_missionId, bytes) => { artifacts.push(Buffer.from(bytes)); return `artifact_${artifacts.length}`; }, ...extra,
  });
  const request: VerificationRequest = {
    missionId: 'mission', operationId: `operation_${++sequence}`, specificationRevision: 1, revision: { ...revision }, cwd: root,
    check: { id: 'check', name: 'Check', command: 'node check.cjs', criterionIds: ['criterion'], required: true, heavy: true, kind: 'build', timeoutMs: 5_000 },
  };
  return { service, scheduler, artifacts, request };
}

const tap = (passed: number, skipped = 0) => `TAP version 13\n# tests ${passed + skipped}\n# pass ${passed}\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`;

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}

async function fileReportFixture(extra: Partial<Omit<VerificationDeps, 'scheduler'>> = {}) {
  git('init', '--initial-branch=main');
  await fs.writeFile(path.join(root, 'case.cjs'), "require('node:test').test('passes',()=>{});");
  const result = fixture(extra);
  result.request.check.command = 'node --test --test-reporter=tap --test-reporter-destination=report.tap case.cjs';
  result.request.check.kind = 'test';
  result.request.check.testReport = { format: 'node-tap', path: 'report.tap', minimumTests: 1, maximumSkipped: 0 };
  return result;
}

describe('host verification boundary', () => {
  it('deduplicates concurrent requests before asynchronous authorization and preserves the receipt', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').appendFileSync('runs.txt','ran\\n');");
    let authorize!: () => void;
    const gate = new Promise<void>((resolve) => { authorize = resolve; });
    const { service, request, scheduler } = fixture({ authorize: () => gate });
    request.check.heavy = false;
    const first = service.run(request), duplicate = service.run(structuredClone(request));
    authorize();
    const results = await Promise.all([first, duplicate]);
    expect(await fs.readFile(path.join(root, 'runs.txt'), 'utf8')).toBe('ran\n');
    expect(results[0]).toEqual(results[1]);
    expect(await service.run(request)).toEqual(results[0]);
    expect(await fs.readFile(path.join(root, 'runs.txt'), 'utf8')).toBe('ran\n');
    expect(scheduler.snapshot().active).toHaveLength(0);
  });

  it('keeps the live cancellation handle when a heavy operation is requested twice', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').writeFileSync('started.txt','ready'); setTimeout(()=>{require('node:fs').writeFileSync('late.txt','escaped');},1200);");
    const { service, request, scheduler } = fixture();
    const first = service.run(request), duplicate = service.run(structuredClone(request));
    await vi.waitFor(async () => expect(await fs.readFile(path.join(root, 'started.txt'), 'utf8')).toBe('ready'), { timeout: 15_000 });
    const active = service.active();
    service.cancel('mission');
    const results = await Promise.all([first, duplicate]);
    expect(active).toEqual([{ operationId: request.operationId, uncertain: false }]);
    expect(results.map((result) => result.result)).toEqual(['blocked', 'blocked']);
    expect(results[0].id).toBe(results[1].id);
    await expect(fs.stat(path.join(root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  }, 25_000);

  it('does not pass or release capacity while an unref child can still write after shell exit', async () => {
    await fs.writeFile(path.join(root, 'child.cjs'), "setTimeout(()=>require('node:fs').writeFileSync('late.txt','escaped'),700); setTimeout(()=>{},900);");
    await fs.writeFile(path.join(root, 'check.cjs'), `require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore',detached:${process.platform === 'win32'}}).unref(); console.log('root complete');`);
    const { service, request, scheduler } = fixture();
    const result = await service.run(request);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(result.result).toBe('blocked');
    await expect(fs.stat(path.join(root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  }, 25_000);

  it('reserves cancellation while authorization is pending and dispatches nothing after stop', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').writeFileSync('ran.txt','wrong');");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, request, scheduler } = fixture({ authorize: () => gate });
    const pending = service.run(request);
    service.cancel('mission');
    release();
    const result = await pending;
    expect(result.result).toBe('blocked');
    expect(result.exitCode).toBeUndefined();
    await expect(fs.stat(path.join(root, 'ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  });

  it('rejects a conflicting duplicate without losing the original immutable command or receipt', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').writeFileSync('original.txt','ran');");
    const { service, request, scheduler } = fixture();
    const lease = await scheduler.acquire({ missionId: 'mission', ownerId: 'other', kind: 'heavy_check' });
    const original = structuredClone(request);
    const pending = service.run(request);
    request.check.command = 'node missing.cjs'; request.revision.contentHash = 'mutated'; request.check.criterionIds.push('wrong');
    await expect(service.run(request)).rejects.toThrow('identity/payload conflict');
    lease.release(true);
    const result = await pending;
    expect(result).toMatchObject({ result: 'passed', commandOrFlow: original.check.command, sourceRevision: original.revision, criterionIds: original.check.criterionIds });
    result.criterionIds.push('caller-mutation');
    expect((await service.run(original)).criterionIds).toEqual(original.check.criterionIds);
    expect(await fs.readFile(path.join(root, 'original.txt'), 'utf8')).toBe('ran');
  });

  it('preserves ownership through artifact failure and never reexecutes a failed operation receipt', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').appendFileSync('runs.txt','once');");
    const saveArtifact = vi.fn(async () => { throw new Error('artifact disk full'); });
    const { service, request, scheduler } = fixture({ saveArtifact });
    await expect(service.run(request)).rejects.toThrow('artifact disk full');
    await expect(service.run(request)).rejects.toThrow('artifact disk full');
    expect(await fs.readFile(path.join(root, 'runs.txt'), 'utf8')).toBe('once');
    expect(saveArtifact).toHaveBeenCalledTimes(2);
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  });

  it('cancels the owned descendant tree without touching an unrelated live process', async () => {
    await fs.writeFile(path.join(root, 'spectator.cjs'), "setInterval(()=>require('node:fs').appendFileSync('spectator.txt','.'),30);setTimeout(()=>process.exit(),8000);");
    const spectator = spawn(process.execPath, ['spectator.cjs'], { cwd: root, stdio: 'ignore' });
    const stopped = new Promise((resolve) => spectator.once('close', resolve));
    try {
      await fs.writeFile(path.join(root, 'child.cjs'), "require('node:fs').writeFileSync('child.txt','ready');setTimeout(()=>require('node:fs').writeFileSync('late.txt','wrong'),3000);setTimeout(()=>{},3500);");
      await fs.writeFile(path.join(root, 'check.cjs'), `require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore',detached:${process.platform === 'win32'}}).unref();setTimeout(()=>{},4000);`);
      const { service, request, scheduler } = fixture();
      const running = service.run(request);
      await vi.waitFor(async () => expect(await fs.readFile(path.join(root, 'child.txt'), 'utf8')).toBe('ready'), { timeout: 15_000 });
      service.cancel('mission');
      expect(await running).toMatchObject({ result: 'blocked' });
      const before = (await fs.readFile(path.join(root, 'spectator.txt'))).length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await fs.readFile(path.join(root, 'spectator.txt'))).length).toBeGreaterThan(before);
      expect(spectator.exitCode).toBeNull();
      expect(service.active()).toEqual([]);
      expect(scheduler.snapshot().active).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 3100));
      await expect(fs.stat(path.join(root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { spectator.kill(); await stopped; }
  }, 25_000);

  it.runIf(process.platform === 'win32')('retains uncertain capacity and retryable cancellation without a supervisor quiescence receipt', async () => {
    // Failure injection, not a fake successful process completion: this supervisor never launches
    // the requested check and deliberately cannot prove a tree empty. It accepts repeated stops.
    const helper = path.join(root, 'fault.ps1');
    const marker = path.join(root, 'cancels.txt').replaceAll("'", "''");
    const report = path.join(root, 'report.tap');
    await fs.writeFile(helper, `[Console]::In.ReadLine() | Out-Null\n[IO.File]::WriteAllText('${report.replaceAll("'", "''")}', 'uncertain partial report')\n[Console]::Out.WriteLine('{"type":"uncertain","error64":"dW5rbm93biBvd25lcnNoaXA="}')\n[Console]::Out.Flush()\n1..2 | ForEach-Object { $line=[Console]::In.ReadLine(); [IO.File]::AppendAllText('${marker}', $line + ',') }\n`);
    const { service, request, scheduler } = await fileReportFixture({ windowsJobHelper: helper });
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
    expect(service.active()).toEqual([{ operationId: request.operationId, uncertain: true }]);
    expect(scheduler.snapshot().active).toHaveLength(1);
    service.cancel('mission'); service.cancel('mission');
    await vi.waitFor(async () => expect(await fs.readFile(path.join(root, 'cancels.txt'), 'utf8')).toBe('cancel,cancel,'));
    expect(await fs.readFile(report, 'utf8')).toBe('uncertain partial report');
    expect(service.active()).toEqual([{ operationId: request.operationId, uncertain: true }]);
    expect(scheduler.snapshot().active).toHaveLength(1);
  });

  it('runs two checks with distinct allocated ports and isolated profile state, preserving live user data', async () => {
    const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'VOCS_CODE_USER_DATA'];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    const profiles = path.join(root, 'live-profiles');
    const { service, request } = fixture({ environment: { PORT: '1', VOCS_MISSION_PORT: '1', XDG_CONFIG_HOME: 'live-profile' } });
    const runs: Array<Promise<unknown>> = [];
    try {
      for (const key of keys) {
        const dir = path.join(profiles, key);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'state.txt'), 'live user state');
        process.env[key] = dir;
      }
      const code = `const fs=require('node:fs'), path=require('node:path'), net=require('node:net');
const keys=${JSON.stringify(keys)}; const label=process.argv[2];
const profiles=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
for(const dir of new Set(Object.values(profiles))) fs.writeFileSync(path.join(dir,'state.txt'),label);
if(process.env.PORT!==process.env.VOCS_MISSION_PORT) throw new Error('port contract mismatch');
const port=Number(process.env.PORT);
const server=net.createServer(socket=>{socket.end(JSON.stringify({label,port,profiles,state:keys.map(k=>fs.readFileSync(path.join(profiles[k],'state.txt'),'utf8'))}));server.close();});
server.listen(port,'127.0.0.1',()=>fs.writeFileSync('ready.json',JSON.stringify({port,profiles})));
setTimeout(()=>process.exit(2),10000).unref();`;
      const requests: VerificationRequest[] = [];
      for (const label of ['first', 'second']) {
        const cwd = path.join(root, label); await fs.mkdir(cwd);
        await fs.writeFile(path.join(cwd, 'check.cjs'), code);
        requests.push({ ...request, operationId: `${request.operationId}_${label}`, cwd, check: { ...request.check, command: `node check.cjs ${label}`, heavy: false, timeoutMs: 10_000 } });
      }
      const executing = requests.map((input) => service.run(input)); runs.push(...executing);
      await vi.waitFor(async () => { for (const input of requests) expect(JSON.parse(await fs.readFile(path.join(input.cwd, 'ready.json'), 'utf8')).port).toBeGreaterThan(0); }, { timeout: 15_000 });
      const observations = await Promise.all(requests.map(async (input) => JSON.parse(await fs.readFile(path.join(input.cwd, 'ready.json'), 'utf8')) as { port: number; profiles: Record<string, string> }));
      expect(observations[0].port).not.toBe(observations[1].port);
      expect(service.active()).toHaveLength(2);
      for (const key of keys) {
        expect(observations[0].profiles[key]).not.toBe(observations[1].profiles[key]);
        expect(observations[0].profiles[key]).not.toBe(process.env[key]);
        expect(observations[1].profiles[key]).not.toBe(process.env[key]);
      }
      const replies = await Promise.all(observations.map(({ port }) => new Promise<{ label: string; port: number; state: string[] }>((resolve, reject) => {
        const socket = createConnection({ port, host: '127.0.0.1' }); let data = '';
        socket.on('data', (chunk) => { data += chunk.toString(); });
        socket.once('error', reject); socket.once('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
      })));
      expect(replies.map((reply) => reply.state)).toEqual([keys.map(() => 'first'), keys.map(() => 'second')]);
      expect((await Promise.all(executing)).map((result) => result.result)).toEqual(['passed', 'passed']);
      expect(service.active()).toEqual([]);
      for (const key of keys) expect(await fs.readFile(path.join(profiles, key, 'state.txt'), 'utf8')).toBe('live user state');
      for (const { profiles: dirs } of observations) await expect(fs.stat(dirs.HOME)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      service.cancel('mission'); await Promise.allSettled(runs);
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }, 25_000);

  it('captures real stdout/stderr and a no-test-count build can pass', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), 'console.log("built"); console.error("warning");');
    const { service, artifacts, request, scheduler } = fixture();
    const evidence = await service.run(request);
    expect(evidence).toMatchObject({ result: 'passed', exitCode: 0, provenance: 'host_executed', sourceRevision: revision, criterionIds: ['criterion'] });
    expect(evidence.executedTests).toBeUndefined();
    expect(artifacts.slice(0, 2).map((a) => a.toString())).toEqual(['built\n', 'warning\n']);
    expect(JSON.parse(artifacts.at(-1)!.toString())).toMatchObject({ operationId: request.operationId, check: request.check, quiescent: true, result: 'passed' });
    expect(scheduler.snapshot().active).toHaveLength(0);
    expect(service.active()).toHaveLength(0);
  });

  it('keeps an exit-zero all-skipped requested test unverified', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "const {test}=require('node:test'); test.skip('one',()=>{}); test.skip('two',()=>{}); test.skip('three',()=>{});");
    const { service, request } = fixture();
    request.check.command = 'node --test --test-reporter=tap check.cjs';
    request.check.kind = 'test';
    request.check.testReport = { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 };
    expect(await service.run(request)).toMatchObject({ result: 'skipped', exitCode: 0, executedTests: 0, skippedTests: 3 });
  });

  it('requires actual counts and never turns arbitrary success text into evidence', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), 'console.log("all 99 tests passed, trust me");');
    const { service, request, artifacts } = fixture();
    request.check.kind = 'test';
    request.check.testReport = { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 };
    expect(await service.run(request)).toMatchObject({ result: 'blocked', exitCode: 0 });
    expect(artifacts.at(-1)!.toString()).toMatch(/TAP summary/);
  });

  it('runs a real Node test suite and captures its executed count', async () => {
    await fs.writeFile(path.join(root, 'case.cjs'), "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('adds',()=>assert.equal(1+1,2));");
    const { service, request } = fixture();
    request.check.command = 'node --test --test-reporter=tap case.cjs';
    request.check.kind = 'test'; request.check.testReport = { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 };
    expect(await service.run(request)).toMatchObject({ result: 'passed', exitCode: 0, executedTests: 1, skippedTests: 0 });
  });

  it('records a fresh real Vitest report and checks its assertion counts against the contract', async () => {
    git('init', '--initial-branch=main');
    const vitestRoot = path.dirname(createRequire(import.meta.url).resolve('vitest/package.json'));
    await fs.writeFile(path.join(root, 'case.test.mjs'), `import { test, expect } from ${JSON.stringify(pathToFileURL(path.join(vitestRoot, 'dist/index.js')).href)}; test('passes',()=>expect(1+1).toBe(2));test.skip('not executed',()=>{});`);
    const { service, request, artifacts } = fixture();
    request.check.command = `"${process.execPath}" "${path.join(vitestRoot, 'vitest.mjs')}" run case.test.mjs --reporter=json --outputFile=report.json`;
    request.check.kind = 'test'; request.check.testReport = { format: 'vitest-json', path: 'report.json', minimumTests: 1, maximumSkipped: 0 };
    const result = await service.run(request);
    expect(result).toMatchObject({ result: 'skipped', exitCode: 0, executedTests: 1, skippedTests: 1 });
    const report = JSON.parse(artifacts[2].toString());
    expect(report).toMatchObject({ numPassedTests: 1, numPendingTests: 1, numTotalTests: 2 });
    expect(JSON.parse(artifacts.at(-1)!.toString())).toMatchObject({ check: request.check, executedTests: 1, skippedTests: 1, quiescent: true });
    await expect(fs.lstat(path.join(root, 'report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('retains exact file-report bytes before removing only the declared output', async () => {
    let onDisk: Buffer | undefined;
    const artifacts: Buffer[] = [];
    const { service, request, scheduler } = await fileReportFixture({ saveArtifact: async (_mission, bytes) => {
      artifacts.push(Buffer.from(bytes));
      if (artifacts.length === 3) onDisk = await fs.readFile(path.join(root, 'report.tap'));
      return `artifact_${artifacts.length}`;
    } });
    await fs.writeFile(path.join(root, 'append.cjs'), "const fs=require('node:fs');fs.appendFileSync('report.tap',Buffer.from([10,35,32,255,254,10]));fs.writeFileSync('report.tap.extra','unrelated output');");
    request.check.command += ' && node append.cjs';
    expect(await service.run(request)).toMatchObject({ result: 'passed', executedTests: 1, skippedTests: 0, artifactIds: ['artifact_1', 'artifact_2', 'artifact_3', 'artifact_4'] });
    expect(onDisk).toBeDefined();
    expect(artifacts[2]).toEqual(onDisk);
    expect(artifacts[2].includes(Buffer.from([255, 254]))).toBe(true);
    await expect(fs.lstat(path.join(root, 'report.tap'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'report.tap.extra'), 'utf8')).toBe('unrelated output');
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  });

  it('does not execute over a report that appears during final authorization', async () => {
    let authorizations = 0;
    const { service, request, artifacts, scheduler } = await fileReportFixture({ authorize: async () => {
      if (++authorizations === 2) await fs.writeFile(path.join(root, 'report.tap'), 'late preexisting report');
    } });
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').writeFileSync('ran.txt','wrong');");
    request.check.command = 'node check.cjs';
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
    expect(artifacts.some((bytes) => bytes.toString().includes('already exists'))).toBe(true);
    expect(await fs.readFile(path.join(root, 'report.tap'), 'utf8')).toBe('late preexisting report');
    await expect(fs.lstat(path.join(root, 'ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  });

  it.each(['absent before dispatch', 'staged by the check'])('never removes a tracked report (%s)', async (when) => {
    const { service, request, artifacts } = await fileReportFixture();
    if (when === 'absent before dispatch') {
      await fs.writeFile(path.join(root, 'report.tap'), 'tracked source');
      git('add', '--', 'report.tap');
      await fs.unlink(path.join(root, 'report.tap'));
    } else request.check.command += ' && git add -- report.tap';
    const index = when === 'absent before dispatch' ? await fs.readFile(path.join(root, '.git', 'index')) : undefined;
    const result = await service.run(request);
    expect(result.result).toBe('blocked');
    expect(artifacts.at(-1)!.toString()).toContain('report is tracked');
    expect(git('ls-files', '--', 'report.tap')).toBe('report.tap');
    if (index) {
      expect(result.exitCode).toBeUndefined();
      expect(await fs.readFile(path.join(root, '.git', 'index'))).toEqual(index);
      await expect(fs.lstat(path.join(root, 'report.tap'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(path.join(root, 'report.tap'))).toEqual(artifacts[2]);
    }
  });

  it.each(['storage failure', 'replacement', 'growth'])('leaves report outputs intact on %s during retention', async (failure) => {
    let captured: Buffer | undefined;
    const report = path.join(root, 'report.tap');
    const { service, request, scheduler } = await fileReportFixture({ saveArtifact: async (_mission, bytes) => {
      if (bytes.toString('utf8').startsWith('TAP version 13')) {
        captured = Buffer.from(bytes);
        if (failure === 'storage failure') throw new Error('report storage failed');
        if (failure === 'replacement') { await fs.rename(report, `${report}.original`); await fs.writeFile(report, 'replacement source'); }
        else await fs.appendFile(report, 'late write');
      }
      return `artifact_${++sequence}`;
    } });
    expect(await service.run(request)).toMatchObject({ result: 'blocked', exitCode: 0 });
    expect(captured).toBeDefined();
    const retained = await fs.readFile(report);
    expect(retained).toEqual(failure === 'replacement' ? Buffer.from('replacement source') : failure === 'growth' ? Buffer.concat([captured!, Buffer.from('late write')]) : captured);
    if (failure === 'replacement') expect(await fs.readFile(`${report}.original`)).toEqual(captured);
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  });

  it.each(['before dispatch', 'during execution'])('leaves symlink/junction report paths untouched (%s)', async (when) => {
    const { service, request, artifacts } = await fileReportFixture();
    const destination = path.join(root, 'destination');
    const linked = path.join(root, 'linked');
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'report.tap'), 'not an owned report');
    request.check.testReport!.path = 'linked/report.tap';
    if (when === 'before dispatch') await fs.symlink(destination, linked, process.platform === 'win32' ? 'junction' : 'dir');
    else {
      await fs.writeFile(path.join(root, 'check.cjs'), `require('node:fs').symlinkSync(${JSON.stringify(destination)},'linked',${JSON.stringify(process.platform === 'win32' ? 'junction' : 'dir')});`);
      request.check.command = 'node check.cjs';
    }
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
    expect(artifacts.at(-1)!.toString()).toContain('symlink/junction');
    expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(destination, 'report.tap'), 'utf8')).toBe('not an owned report');
  });

  it('retains linked and oversized generated reports instead of consuming them', async () => {
    const { service, request, artifacts } = await fileReportFixture();
    await fs.writeFile(path.join(root, 'link.cjs'), "require('node:fs').linkSync('report.tap','other.tap');");
    request.check.command += ' && node link.cjs';
    expect(await service.run(request)).toMatchObject({ result: 'blocked', exitCode: 0 });
    expect(artifacts.at(-1)!.toString()).toContain('Invalid/linked/oversized');
    expect((await fs.lstat(path.join(root, 'report.tap'))).nlink).toBe(2);
    expect(await fs.readFile(path.join(root, 'other.tap'))).toEqual(await fs.readFile(path.join(root, 'report.tap')));
    await fs.unlink(path.join(root, 'report.tap'));
    await fs.writeFile(path.join(root, 'grow.cjs'), "const fs=require('node:fs');fs.writeFileSync('report.tap','');fs.truncateSync('report.tap',32*1024*1024+1);");
    request.operationId += '-oversized'; request.check.command = 'node grow.cjs';
    expect(await service.run(request)).toMatchObject({ result: 'blocked', exitCode: 0 });
    expect(artifacts.at(-1)!.toString()).toContain('Invalid/linked/oversized');
    expect((await fs.stat(path.join(root, 'report.tap'))).size).toBe(32 * 1024 * 1024 + 1);
  });

  it('rejects printed summary-only test claims despite exit zero', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), `console.log(${JSON.stringify(tap(7))});`);
    const { service, request, artifacts } = fixture();
    request.check.kind = 'test'; request.check.testReport = { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 };
    expect(await service.run(request)).toMatchObject({ result: 'blocked', exitCode: 0 });
    expect(artifacts.at(-1)!.toString()).toContain('TAP plan');
  });

  it('captures counts from a genuinely failing Node test suite, including nested tests', async () => {
    await fs.writeFile(path.join(root, 'case.cjs'), "const{test,describe,it}=require('node:test'); describe('suite',()=>it('passes',()=>{}));test('fails',()=>{throw new Error('failure')});");
    const { service, request } = fixture();
    request.check.command = 'node --test --test-reporter=tap case.cjs';
    request.check.kind = 'test'; request.check.testReport = { format: 'node-tap', minimumTests: 1, maximumSkipped: 0 };
    expect(await service.run(request)).toMatchObject({ result: 'failed', exitCode: 1, executedTests: 2, skippedTests: 0 });
  });

  it('rejects stale content before spawn and invalidates content changed by a check', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').writeFileSync('side-effect.txt','ran');");
    const stale = fixture({ contentIdentity: async () => ({ ...revision, contentHash: 'new' }) });
    expect(await stale.service.run(stale.request)).toMatchObject({ result: 'blocked' });
    await expect(fs.stat(path.join(root, 'side-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const identity = vi.fn().mockResolvedValueOnce(revision).mockResolvedValueOnce({ ...revision, contentHash: 'changed' });
    const drift = fixture({ contentIdentity: identity });
    expect(await drift.service.run(drift.request)).toMatchObject({ result: 'failed', invalidatedBy: expect.stringContaining('changed source') });
    expect(await fs.readFile(path.join(root, 'side-effect.txt'), 'utf8')).toBe('ran');
  });

  it('revalidates authorization after waiting and never executes a denied command', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), "require('node:fs').writeFileSync('denied.txt','ran');");
    const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('paused'));
    const { service, request } = fixture({ authorize });
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
    expect(authorize).toHaveBeenCalledTimes(2);
    await expect(fs.stat(path.join(root, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('times out an owned process and retains real partial logs, not a green exit', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), 'console.log("started"); setInterval(()=>{},1000);');
    const { service, request, artifacts, scheduler } = fixture();
    request.check.timeoutMs = 500;
    const result = await service.run(request);
    expect(result.result).toBe('blocked');
    expect(artifacts.some((a) => a.toString().includes('started'))).toBe(true);
    expect(artifacts.some((a) => a.toString().includes('timed out'))).toBe(true);
    expect(scheduler.snapshot().active).toHaveLength(0);
  }, 20_000);

  it('refuses stale on-disk reports and report path escapes', async () => {
    const report = { numPassedTests: 9, numFailedTests: 0, numPendingTests: 0, numTotalTests: 9, success: true };
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report));
    await fs.writeFile(path.join(root, 'check.cjs'), 'console.log("no tests");');
    const { service, request, artifacts } = fixture();
    request.check.kind = 'test'; request.check.testReport = { format: 'vitest-json', path: 'report.json', minimumTests: 1, maximumSkipped: 0 };
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
    expect(artifacts.at(-1)!.toString()).toContain('already exists');
    expect(await fs.readFile(path.join(root, 'report.json'), 'utf8')).toBe(JSON.stringify(report));
    request.operationId += '-escape'; request.check.testReport.path = '../report.json';
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
    expect(artifacts.at(-1)!.toString()).toContain('workspace-relative');
  });

  it('does not silently truncate logs and call the command verified', async () => {
    await fs.writeFile(path.join(root, 'check.cjs'), 'console.log("x".repeat(100000)); setInterval(()=>{},1000);');
    const { service, request } = fixture({ outputLimitBytes: 64 });
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
  }, 20_000);
});

describe('check reports and isolated environment', () => {
  it('requires complete machine-reported counts', () => {
    expect(parseTestReport('vitest-json', JSON.stringify({ numPassedTests: 2, numFailedTests: 0, numPendingTests: 1, numTotalTests: 3, success: true,
      testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'passed' }, { status: 'pending' }] }],
    }))).toEqual({ executed: 2, failed: 0, skipped: 1 });
    expect(() => parseTestReport('vitest-json', JSON.stringify({ numTotalTests: 3 }))).toThrow('count');
    expect(() => parseTestReport('node-tap', tap(1) + tap(1))).toThrow('ambiguous');
    expect(() => parseTestReport('vitest-json', JSON.stringify({ numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTotalTests: 2, success: true }))).toThrow('assertion results');
    expect(() => parseTestReport('node-tap', tap(Number.MAX_SAFE_INTEGER + 1))).toThrow('Invalid TAP');
  });
  it('does not inherit provider credentials or user profiles for the test application', () => {
    const previous = process.env.MISSION_TEST_SECRET;
    process.env.MISSION_TEST_SECRET = 'never-copied';
    try {
      const env = isolatedCheckEnvironment(root, { EXPLICIT_TEST_SETTING: 'approved', VOCS_CODE_USER_DATA: 'user-profile' });
      expect(env.MISSION_TEST_SECRET).toBeUndefined();
      expect(env.EXPLICIT_TEST_SETTING).toBe('approved');
      expect(env.VOCS_CODE_USER_DATA).toBe(path.join(root, 'app'));
      expect(env.TEMP).toBe(root);
      expect(env.HOME).toBe(path.join(root, 'home'));
      expect(env.USERPROFILE).toBe(path.join(root, 'home'));
      expect(env.APPDATA).toBe(path.join(root, 'appdata'));
      expect(env.LOCALAPPDATA).toBe(path.join(root, 'localappdata'));
      expect(isolatedCheckEnvironment(root, { home: 'real-profile', temp: 'real-temp' }).home).toBeUndefined();
    } finally { if (previous === undefined) delete process.env.MISSION_TEST_SECRET; else process.env.MISSION_TEST_SECRET = previous; }
  });
});
