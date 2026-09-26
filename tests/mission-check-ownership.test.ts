/** A host check that never starts must neither brick restart recovery nor hold capacity, while a
 * supervisor that did claim ownership is never retired without its own durable receipt. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionVerification, type VerificationDeps, type VerificationRequest } from '../src/main/mission/verification';
import { MissionScheduler } from '../src/main/mission/scheduler';
import { MissionRecovery } from '../src/main/mission/recovery';
import { checkOwnershipDirectory, createProcessOwnershipIntent, processOwnershipIntents, processOwnershipQuiescent, retireUnclaimedProcessIntent } from '../src/main/mission/process-ownership';
import type { SessionManager } from '../src/main/session-manager';
import type { TerminalManager } from '../src/main/terminal';
import { missionFixture } from './support/mission-fixture';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-check-owner-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const revision = { baseCommitSha: 'base', contentHash: 'exact-source' };
const ownershipRoot = () => path.join(root, 'ownership');
const checks = () => checkOwnershipDirectory(ownershipRoot(), 'mission');
const absent = (file: string) => expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });

function fixture(extra: Partial<Omit<VerificationDeps, 'scheduler'>> = {}) {
  const scheduler = new MissionScheduler({ maxConcurrentAgentTurnsGlobal: 10, maxConcurrentWorkersPerMission: 4, maxConcurrentHeavyChecksGlobal: 1 });
  scheduler.register('mission');
  const artifacts: string[] = [];
  const service = new MissionVerification({
    scheduler, authorize: async () => undefined, contentIdentity: async () => revision, ownershipRoot: ownershipRoot(),
    windowsJobHelper: path.resolve('resources/mission/windows-check-job.ps1'),
    saveArtifact: async (_mission, bytes) => { artifacts.push(bytes.toString('utf8')); return `artifact_${artifacts.length}`; }, ...extra,
  });
  const request: VerificationRequest = { missionId: 'mission', operationId: 'check', specificationRevision: 1, revision: { ...revision }, cwd: root,
    check: { id: 'check', name: 'Check', kind: 'build', command: 'node ran.cjs', criterionIds: ['criterion'], required: true, heavy: true, timeoutMs: 10_000 } };
  return { service, scheduler, artifacts, request };
}

/** The production restart inspection, over this test's ownership journal and no live runtime. */
async function recover(operationId: string) {
  const record = missionFixture({ projectRoot: root, sourceCwd: root, operations: [{ id: operationId, idempotencyKey: operationId, kind: 'verify', actor: 'host', expectedRevision: 1, state: 'in_flight', payload: { executionKind: 'process' } }] });
  record.leadPreset.harnessId = 'pi';
  const recovery = new MissionRecovery({
    userData: path.join(root, 'data'), ownershipRoot: ownershipRoot(),
    sessions: { list: () => [], get: () => undefined } as unknown as Pick<SessionManager, 'list' | 'get'>,
    terminals: { activity: () => [], reconcileOwnership: async () => undefined } as unknown as Pick<TerminalManager, 'activity' | 'reconcileOwnership'>,
    admission: { acquire: async () => ({ assertQuiescent: async () => undefined, release: () => undefined }) },
  });
  return recovery.reconcileExternalActivity(record);
}

describe('claim-required process ownership intents', () => {
  it('retires only an unclaimed, declared intent, idempotently, and never a claimed or undeclared one', async () => {
    const owner = (operationId: string) => ({ kind: 'mission-check' as const, missionId: 'mission', operationId });
    const declared = createProcessOwnershipIntent(checks(), owner('declared'), { claimRequired: true });
    const undeclared = createProcessOwnershipIntent(checks(), owner('undeclared'));
    const claimed = createProcessOwnershipIntent(checks(), owner('claimed'), { claimRequired: true });
    await fs.writeFile(`${claimed.receiptPath}.claimed`, JSON.stringify({ schemaVersion: 1, kind: 'mission-check', nonce: claimed.record.nonce })); // a launcher's claim
    const inventory = async (intent: { path: string }) => (await processOwnershipIntents(checks())).find((entry) => entry.path === intent.path)!;
    // No declaration, no proof that its launcher claims first: it keeps blocking until receipted.
    expect(await processOwnershipQuiescent(await inventory(undeclared))).toBe(false);
    await absent(`${undeclared.receiptPath}.claimed`);
    expect(await processOwnershipQuiescent(await inventory(claimed))).toBe(false);
    await absent(claimed.receiptPath);
    expect(retireUnclaimedProcessIntent(claimed)).toBe(false);
    expect(await processOwnershipQuiescent(await inventory(declared))).toBe(true);
    expect(JSON.parse(await fs.readFile(declared.receiptPath, 'utf8'))).toMatchObject({ source: 'host_not_started', outcome: 'not_started', operationId: 'declared', intentHash: declared.hash });
    expect(await processOwnershipQuiescent(await inventory(declared))).toBe(true);
    // A crash between the host's claim and its receipt is completed on the next inspection.
    const interrupted = createProcessOwnershipIntent(checks(), owner('interrupted'), { claimRequired: true });
    expect(retireUnclaimedProcessIntent(interrupted)).toBe(true);
    await fs.rm(interrupted.receiptPath);
    expect(await processOwnershipQuiescent(await inventory(interrupted))).toBe(true);
    // A declaration without its intent is an orphan, like any other stray ownership file.
    const stray = path.join(root, 'stray');
    await fs.mkdir(stray);
    await fs.writeFile(path.join(stray, path.basename(declared.path).replace('.intent.json', '.claim-required.json')), '{}');
    await expect(processOwnershipIntents(stray)).rejects.toThrow('Orphaned');
  });
});

describe.runIf(process.platform === 'win32')('a Windows check supervisor that never starts', () => {
  beforeEach(async () => { await fs.writeFile(path.join(root, 'ran.cjs'), "require('node:fs').writeFileSync('ran.txt', 'must not run');\n"); });

  it('releases capacity and records not-started when the supervisor dies before claiming ownership', async () => {
    // Failure injection standing in for a supervisor whose Add-Type is blocked by AppLocker/WDAC
    // before it registers ownership: it exits without claiming its intent or launching anything.
    const blocked = path.join(root, 'blocked.ps1');
    await fs.writeFile(blocked, "[Console]::Error.WriteLine('Add-Type : Cannot add type. This operation is blocked by policy.')\nexit 1\n");
    const { service, scheduler, artifacts, request } = fixture({ windowsJobHelper: blocked });
    const evidence = await service.run(request);
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
    expect(evidence).toMatchObject({ result: 'blocked', failure: { kind: 'environment', code: 'check_supervisor_unavailable', confidence: 'observed', recovery: 'user_action' } });
    expect(artifacts.join('\n')).toMatch(/before claiming process ownership[\s\S]*blocked by policy/);
    await absent(path.join(root, 'ran.txt'));
    const [intent] = await processOwnershipIntents(checks());
    expect(JSON.parse(await fs.readFile(intent.receiptPath, 'utf8'))).toMatchObject({ source: 'host_not_started', outcome: 'not_started', operationId: request.operationId });
    expect(await recover(request.operationId)).toMatchObject({ quiescent: true });
  });

  it('keeps capacity and uncertainty when a supervisor that claimed ownership dies without a receipt', async () => {
    // This fault supervisor takes the exclusive claim, as the real one does before creating its
    // target, then exits without any receipt. It could have launched work, so it stays owned.
    const claimed = path.join(root, 'claimed.ps1');
    await fs.writeFile(claimed, [
      'param([string]$OwnerIntent, [string]$OwnerHash)',
      '$nonce = (Get-Content -Raw -LiteralPath $OwnerIntent | ConvertFrom-Json).nonce',
      "[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $OwnerIntent) \"$nonce.receipt.json.claimed\"), 'supervisor claim')",
      'exit 1', ''].join('\n'));
    const { service, scheduler, request } = fixture({ windowsJobHelper: claimed });
    expect(await service.run(request)).toMatchObject({ result: 'blocked' });
    expect(service.active()).toEqual([{ operationId: request.operationId, uncertain: true }]);
    expect(scheduler.snapshot().active).toHaveLength(1);
    const [intent] = await processOwnershipIntents(checks());
    expect(await processOwnershipQuiescent(intent)).toBe(false);
    expect(await recover(request.operationId)).toMatchObject({ quiescent: false, detail: expect.stringContaining('no exact empty-Job receipt') });
  });

  it('recovers a check whose host died during approval, and the retired intent can never launch later', async () => {
    let approve!: () => void;
    const approval = new Promise<void>((resolve) => { approve = resolve; });
    const { service, scheduler, request } = fixture({ authorize: () => approval });
    const stale = service.run(request);
    // The intent is durable before the approval wait. A host death here leaves it unclaimed.
    await vi.waitFor(async () => expect(await processOwnershipIntents(checks())).toHaveLength(1));
    const observation = await recover(request.operationId);
    expect(observation).toMatchObject({ quiescent: true });
    const [intent] = await processOwnershipIntents(checks());
    expect(JSON.parse(observation.receipt!)).toMatchObject({ checks: [intent.record.nonce] });
    // The retirement is a real fence: the real supervisor refuses the retired nonce, so even the
    // stale approval of the "dead" host cannot start the command afterwards.
    approve();
    expect(await stale).toMatchObject({ result: 'blocked' });
    await absent(path.join(root, 'ran.txt'));
    expect(service.active()).toEqual([]);
    expect(scheduler.snapshot().active).toEqual([]);
  });
});
