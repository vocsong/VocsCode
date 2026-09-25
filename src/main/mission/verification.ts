/** Host-executed checks. Claims, exit-zero skipped suites, and changed source are not passes. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { MissionCheck, MissionCodeRevision, MissionEvidence } from '../../shared/mission';
import { runCapture, which } from '../runtime';
import type { CapacityLease, MissionScheduler } from './scheduler';
import { startOwnedCheck } from './check-process';
import { allocateCheckPort, type CheckPortLease } from './check-resources';
import { checkOwnershipDirectory, createProcessOwnershipIntent, recordUnlaunchedProcessIntent, type ProcessOwnershipIntent } from './process-ownership';
import { verificationOutcomeHash } from './progress';

/** Only the real permission boundary may report a user denial, never command output. */
export class VerificationApprovalDenied extends Error {}

export interface VerificationRequest {
  missionId: string;
  operationId: string;
  specificationRevision: number;
  attemptId?: string;
  taskId?: string;
  taskRevision?: number;
  revision: MissionCodeRevision;
  /** Resolved by workspace ownership, never supplied by a model. Must be an isolated check tree. */
  cwd: string;
  check: MissionCheck;
}

export interface VerificationDeps {
  scheduler: MissionScheduler;
  /** Revalidates authorization, paused state and the persisted verify intent, before spawn. */
  authorize(request: VerificationRequest): Promise<void>;
  contentIdentity(cwd: string): Promise<MissionCodeRevision>;
  saveArtifact(missionId: string, bytes: Buffer): Promise<string>;
  /** Explicit host-approved environment additions, not tool arguments. */
  environment?: Record<string, string>;
  outputLimitBytes?: number;
  /** Trusted absolute resource path, resolved by production composition (never from a model/cwd). */
  windowsJobHelper?: string;
  /** Host-owned durable launch journal, separate from check scratch and retained worktrees. */
  ownershipRoot?: string;
}

interface VerificationJob {
  missionId: string;
  controller: AbortController;
  stop?: () => void;
  uncertain: boolean;
  quiescent: boolean;
  finished: boolean;
  lease?: CapacityLease;
  port?: CheckPortLease;
  scratch?: string;
}

export class MissionVerification {
  private readonly jobs = new Map<string, VerificationJob>();
  /** Includes failed/completed receipts: retrying an operation is not permission to execute again.
   * Durable dedupe across restart belongs to the persisted verify intent in MissionService. */
  private readonly operations = new Map<string, { request: VerificationRequest; result: Promise<MissionEvidence> }>();

  constructor(private readonly deps: VerificationDeps) {}

  active(missionId?: string): Array<{ operationId: string; uncertain: boolean }> {
    return [...this.jobs].filter(([, j]) => !missionId || j.missionId === missionId).map(([operationId, j]) => ({ operationId, uncertain: j.uncertain }));
  }

  /** Retry cancellation even after an uncertain failure; AbortSignal alone fires only once. */
  cancel(missionId: string): void {
    for (const job of this.jobs.values()) if (job.missionId === missionId) { job.controller.abort(); job.stop?.(); }
  }

  async run(input: VerificationRequest): Promise<MissionEvidence> {
    const request = structuredClone(input);
    validateCheck(request.check);
    if (!request.operationId || !request.missionId || !path.isAbsolute(request.cwd)) throw new Error('Verification requires an owned operation and absolute workspace');
    const existing = this.operations.get(request.operationId);
    if (existing) {
      if (!isDeepStrictEqual(existing.request, request)) throw new Error('Verification operation identity/payload conflict');
      return structuredClone(await existing.result);
    }
    // Reserve before the FIRST await, including authorization. A duplicate must not acquire a
    // second heavy slot, replace the cancellation handle, or remove somebody else's live job.
    const job: VerificationJob = { missionId: request.missionId, controller: new AbortController(), uncertain: false, quiescent: true, finished: false };
    this.jobs.set(request.operationId, job);
    const result = Promise.resolve().then(() => this.runReserved(request, job));
    this.operations.set(request.operationId, { request, result });
    return structuredClone(await result);
  }

  private async release(request: VerificationRequest, job: VerificationJob): Promise<void> {
    if (!job.finished || !job.quiescent || this.jobs.get(request.operationId) !== job) return;
    this.jobs.delete(request.operationId);
    job.lease?.release(true);
    await job.port?.release();
    // Only our isolated scratch, never the retained verification worktree. Teardown of the
    // supervisor precedes this cleanup, so no child can recreate it after removal.
    if (job.scratch) await fs.rm(job.scratch, { recursive: true, force: true });
  }

  private async runReserved(request: VerificationRequest, job: VerificationJob): Promise<MissionEvidence> {
    const environment = { ...this.deps.environment };
    const startedAt = Date.now();
    const evidence: MissionEvidence = {
      id: `e_${randomUUID()}`, criterionIds: [...request.check.criterionIds], specificationRevision: request.specificationRevision,
      taskId: request.taskId, taskRevision: request.taskRevision, attemptId: request.attemptId, sourceRevision: request.revision,
      checkId: request.check.id, kind: request.check.kind, commandOrFlow: request.check.command, cwd: request.cwd,
      environmentRef: `${process.platform}/${process.arch}; host-node=${process.version}; isolated-profile`, provenance: 'host_executed',
      result: 'not_run', artifactIds: [], startedAt,
    };
    let intent: ProcessOwnershipIntent | undefined, launched = false;
    const outputs: string[] = [];
    try {
      if (this.deps.ownershipRoot) intent = createProcessOwnershipIntent(checkOwnershipDirectory(this.deps.ownershipRoot, request.missionId), { kind: 'mission-check', missionId: request.missionId, operationId: request.operationId });
      await this.deps.authorize(structuredClone(request));
      // The job remains owned through tools/teardown even when it does not need a heavy slot.
      if (request.check.heavy) job.lease = await this.deps.scheduler.acquire({ missionId: request.missionId, ownerId: request.operationId, kind: 'heavy_check', signal: job.controller.signal });
      if (job.controller.signal.aborted) throw new Error('Verification canceled before dispatch');
      const before = await this.deps.contentIdentity(request.cwd);
      if (before.contentHash !== request.revision.contentHash || before.baseCommitSha !== request.revision.baseCommitSha) throw new Error('Verification source revision is stale');
      job.scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-mission-check-'));
      job.port = await allocateCheckPort();
      const env = isolatedCheckEnvironment(job.scratch, environment, job.port.port);
      evidence.environmentRef += `; env-sha256=${createHash('sha256').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')}`;
      for (const dir of [env.HOME!, env.APPDATA!, env.LOCALAPPDATA!, env.VOCS_CODE_USER_DATA!, env.XDG_CONFIG_HOME!, env.XDG_DATA_HOME!, env.XDG_CACHE_HOME!]) await fs.mkdir(dir, { recursive: true });
      const report = request.check.testReport?.path;
      const reportTarget = report ? await freshReport(request.cwd, report) : undefined;
      // No await between this last authorization/cancellation check and synchronous ownership
      // transfer to the process supervisor. Setup cannot leave a stale approval waiting to spawn.
      await this.deps.authorize(structuredClone(request));
      if (job.controller.signal.aborted) throw new Error('Verification canceled before dispatch');
      const owned = startOwnedCheck({
        command: request.check.command, cwd: request.cwd, env, timeoutMs: request.check.timeoutMs, ownershipIntent: intent,
        outputLimitBytes: this.deps.outputLimitBytes ?? 32 * 1024 * 1024, windowsJobHelper: this.deps.windowsJobHelper,
        beforeResume: async () => {
          await job.port!.prepareForSpawn();
          // Authorization/setup may have yielded since the first absence check. The owned root
          // is still suspended here: never run over a report that appeared in that interval.
          if (report && await freshReport(request.cwd, report) !== reportTarget) throw new Error('Verification report path changed before dispatch');
        },
        uncertain: () => { job.uncertain = true; },
        quiescent: () => {
          job.quiescent = true;
          job.uncertain = false;
          // A late kernel receipt can reconcile a watchdog failure; it cannot rewrite its evidence.
          if (job.finished) void this.release(request, job).catch(() => undefined);
        },
      });
      launched = true;
      job.quiescent = false;
      job.stop = owned.cancel;
      const outcome = await owned.result;
      evidence.exitCode = outcome.code ?? undefined;
      outputs.push(outcome.stdout.toString('utf8'), outcome.stderr.toString('utf8'));
      evidence.artifactIds.push(await this.deps.saveArtifact(request.missionId, outcome.stdout), await this.deps.saveArtifact(request.missionId, outcome.stderr));
      if (outcome.error || outcome.canceled || outcome.timedOut || outcome.outputLimited || outcome.lingering || job.controller.signal.aborted || !job.quiescent) {
        evidence.result = 'blocked';
        evidence.artifactIds.push(await this.deps.saveArtifact(request.missionId, Buffer.from(outcome.error || (outcome.outputLimited ? 'Output exceeded the capture limit; the check was interrupted and is not verified.' : outcome.timedOut ? 'Check timed out and was interrupted.' : outcome.lingering ? 'The command left running descendants; the owned process tree was terminated and the check is not verified.' : 'Check canceled.'))));
      } else if (request.check.kind === 'test' || request.check.testReport) {
        if (!request.check.testReport) throw new Error('A test check requires a count-bearing test report');
        const contract = request.check.testReport;
        const raw = contract.path ? await retainReport(request.cwd, contract.path, reportTarget!, async (bytes) => {
          evidence.artifactIds.push(await this.deps.saveArtifact(request.missionId, bytes));
        }) : outcome.stdout.toString('utf8');
        outputs.push(raw);
        const counts = parseTestReport(contract.format, raw);
        evidence.executedTests = counts.executed;
        evidence.skippedTests = counts.skipped;
        evidence.result = outcome.code !== 0 || counts.failed > 0 ? 'failed' : counts.executed < contract.minimumTests || counts.skipped > contract.maximumSkipped ? 'skipped' : 'passed';
      } else {
        evidence.result = outcome.code === 0 ? 'passed' : 'failed';
      }
      if (job.quiescent) {
        const after = await this.deps.contentIdentity(request.cwd);
        if (after.contentHash !== request.revision.contentHash || after.baseCommitSha !== request.revision.baseCommitSha) {
          evidence.result = 'failed';
          evidence.invalidatedBy = 'The check changed source content; verify a new immutable revision.';
        }
      }
      evidence.artifactIds.push(await this.deps.saveArtifact(request.missionId, Buffer.from(JSON.stringify({
        schemaVersion: 1, operationId: request.operationId, check: request.check, sourceRevision: request.revision,
        cwd: request.cwd, environmentRef: evidence.environmentRef, environmentKeys: Object.keys(env).sort(),
        processOwnership: process.platform === 'win32' ? 'windows-job-object' : 'posix-process-group',
        resources: { port: job.port.port, host: '127.0.0.1', cooperativeOnly: true },
        quiescent: job.quiescent, result: evidence.result, exitCode: evidence.exitCode,
        executedTests: evidence.executedTests, skippedTests: evidence.skippedTests,
        // The raw report/logs remain separate immutable artifacts; prose is never test evidence.
        capturedArtifactIds: [...evidence.artifactIds],
      }))));
    } catch (error) {
      if (intent && !launched) {
        try { recordUnlaunchedProcessIntent(intent); } catch { job.quiescent = false; job.uncertain = true; }
      }
      evidence.result = 'blocked';
      const detail = error instanceof Error ? error.message : String(error);
      outputs.push(detail);
      if (error instanceof VerificationApprovalDenied) evidence.failure = { kind: 'permission', code: 'approval_denied', source: 'approval', confidence: 'observed', recovery: 'user_action', message: detail };
      evidence.artifactIds.push(await this.deps.saveArtifact(request.missionId, Buffer.from(detail)));
    } finally {
      evidence.outcomeHash = verificationOutcomeHash(outputs, [request.cwd, job.scratch ?? ''], request.check.testReport?.format);
      evidence.endedAt = Date.now();
      // Uncertain teardown retains ownership and capacity. A retry must reconcile the process,
      // not reuse its worktree merely because the timeout promise returned.
      job.finished = true;
      if (!job.quiescent) job.uncertain = true;
      await this.release(request, job);
    }
    return evidence;
  }
}

function validateCheck(check: MissionCheck): void {
  if (!check.id || typeof check.command !== 'string' || !check.command.trim() || check.command.length > 16_384 || check.command.includes('\0')) throw new Error('Invalid verification command');
  if (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 86_400_000) throw new Error('Verification timeout must be bounded');
  if (check.testReport && (!Number.isInteger(check.testReport.minimumTests) || check.testReport.minimumTests < 1 || !Number.isInteger(check.testReport.maximumSkipped) || check.testReport.maximumSkipped < 0)) throw new Error('Invalid expected test counts');
}

export function parseTestReport(format: 'vitest-json' | 'node-tap', raw: string): { executed: number; failed: number; skipped: number } {
  if (format === 'vitest-json') {
    const report = JSON.parse(raw) as Record<string, unknown>;
    const count = (name: string): number => {
      const value = report[name];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Missing/invalid test report count: ${name}`);
      return value;
    };
    const passed = count('numPassedTests');
    const failed = count('numFailedTests');
    const skipped = count('numPendingTests');
    const total = count('numTotalTests');
    const todo = report.numTodoTests === undefined ? 0 : count('numTodoTests');
    // Vitest versions either include todo in pending or report it separately. No unexplained rows.
    if (total !== passed + failed + skipped && total !== passed + failed + skipped + todo) throw new Error('Incomplete test report counts');
    if (report.success !== true && failed === 0) throw new Error('Test runner did not report success');
    if (!Array.isArray(report.testResults)) throw new Error('Missing test report assertion results');
    const statuses = report.testResults.flatMap((file: unknown) => {
      if (!file || typeof file !== 'object' || !Array.isArray((file as Record<string, unknown>).assertionResults)) throw new Error('Missing test report assertion results');
      return ((file as Record<string, unknown>).assertionResults as unknown[]).map((assertion) => {
        const status = assertion && typeof assertion === 'object' ? (assertion as Record<string, unknown>).status : undefined;
        if (typeof status !== 'string' || !['passed', 'failed', 'pending', 'skipped', 'todo'].includes(status)) throw new Error('Invalid test assertion status');
        return status;
      });
    });
    if (statuses.length !== total || statuses.filter((s) => s === 'passed').length !== passed || statuses.filter((s) => s === 'failed').length !== failed) throw new Error('Test report counts do not match assertion results');
    return { executed: passed + failed, failed, skipped: total - passed - failed };
  }
  if (format !== 'node-tap') throw new Error('Unsupported test report format');
  const value = (label: string): number => {
    const hits = [...raw.matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, 'gm'))];
    if (hits.length !== 1) throw new Error(`Missing/ambiguous TAP summary: ${label}`);
    const count = Number(hits[0][1]);
    if (!Number.isSafeInteger(count)) throw new Error(`Invalid TAP summary: ${label}`);
    return count;
  };
  const tests = value('tests'), passed = value('pass'), failed = value('fail'), skipped = value('skipped'), canceled = value('cancelled'), todo = value('todo');
  if (tests !== passed + failed + skipped + canceled + todo) throw new Error('Incomplete TAP summary');
  // Summary text alone is not evidence of test execution. Require the runner's TAP envelope,
  // plan and individual result records and reconcile those with the count-bearing summary.
  // This validates an approved command's report; it is not attestation of hostile test code.
  const plans = [...raw.matchAll(/^1\.\.(\d+)\r?$/gm)];
  if ((raw.match(/^TAP version 13\r?$/gm) ?? []).length !== 1 || plans.length !== 1) throw new Error('Missing/ambiguous TAP plan');
  const rows: Array<{ top: boolean; passed: boolean; skipped: boolean; todo: boolean; suite: boolean }> = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const row = /^( *)(not ok|ok) \d+(?: - (.*))?$/.exec(lines[i]);
    if (!row) continue;
    const indent = row[1];
    if (lines[++i] !== `${indent}  ---`) throw new Error('Missing TAP result diagnostics');
    let suite = false;
    // Linear scan, not an unbounded cross-record regex on up to 32 MB of child-controlled text.
    for (i++; i < lines.length && lines[i] !== `${indent}  ...`; i++) if (/^\s*type: ['"]suite['"]$/.test(lines[i])) suite = true;
    if (i === lines.length) throw new Error('Incomplete TAP result diagnostics');
    rows.push({ top: !indent, passed: row[2] === 'ok', skipped: /# SKIP(?:\s|$)/i.test(row[3] ?? ''), todo: /# TODO(?:\s|$)/i.test(row[3] ?? ''), suite });
  }
  const assertions = rows.filter((row) => !row.suite);
  const executed = assertions.filter((row) => !row.skipped && !row.todo);
  if (Number(plans[0][1]) !== rows.filter((row) => row.top).length || assertions.length !== tests || assertions.filter((row) => row.skipped).length !== skipped || assertions.filter((row) => row.todo).length !== todo
    || executed.filter((row) => row.passed).length !== passed || executed.filter((row) => !row.passed).length !== failed + canceled) throw new Error('TAP summary does not match test results');
  return { executed: passed + failed, failed: failed + canceled, skipped: skipped + todo };
}

export function isolatedCheckEnvironment(scratch: string, approved: Record<string, string> = {}, port?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SHELL', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  const isolated = {
    TMP: scratch, TEMP: scratch, TMPDIR: scratch, HOME: path.join(scratch, 'home'), USERPROFILE: path.join(scratch, 'home'),
    APPDATA: path.join(scratch, 'appdata'), LOCALAPPDATA: path.join(scratch, 'localappdata'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_DATA_HOME: path.join(scratch, 'data'),
    VOCS_CODE_USER_DATA: path.join(scratch, 'app'), VOCS_CODE_UPDATER_DISABLE: '1', CI: '1',
    ...(port === undefined ? {} : { PORT: String(port), VOCS_MISSION_PORT: String(port) }),
  };
  // Windows environment names are case insensitive; approved additions cannot shadow isolation.
  for (const [key, value] of Object.entries(approved)) if (![...Object.keys(isolated), 'PORT', 'VOCS_MISSION_PORT'].includes(key.toUpperCase())) env[key] = value;
  Object.assign(env, isolated);
  // No inherited provider secrets, live user profiles or NODE_OPTIONS. This is not a sandbox.
  return env;
}

async function confinedReport(cwd: string, relative: string, mustExist: boolean): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.includes('\0')) throw new Error('Report must be a workspace-relative file');
  const root = await fs.realpath(cwd);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Report escapes the verification workspace');
  // Cleanup must not address Git administration, Windows device/ADS names, or path aliases.
  if (rel.split(path.sep).some((part) => /[\\<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part)
    || /^(?:\.git(?:[ .]|$)|git~\d)/i.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Unsafe test report path');
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Report path traverses a symlink/junction'); }
    catch (error) { if (!mustExist && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  }
  return target;
}

async function untrackedReport(cwd: string, target: string): Promise<void> {
  // Absence on disk alone does not mean ownership: a tracked file may be deleted locally.
  // Use literal (conservatively case-insensitive) matching, without inherited Git redirection.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const relative = path.relative(await fs.realpath(cwd), target).split(path.sep).join('/');
  const result = await runCapture(which('git') ?? 'git', ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '-z', '--', `:(icase,literal)${relative}`], {
    cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 10_000,
  });
  if (result.code !== 0 || result.truncated || result.timedOut) throw new Error('Cannot establish test report Git ownership');
  if (result.stdout) throw new Error('Verification report is tracked; it cannot be an owned check output');
}

async function freshReport(cwd: string, relative: string): Promise<string> {
  const target = await confinedReport(cwd, relative, false);
  // Never accept or silently delete a report left by a prior run (including ignored files).
  try { await fs.lstat(target); throw new Error('Verification report already exists; use a fresh verification workspace'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await untrackedReport(cwd, target);
  return target;
}

function sameReport(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.nlink === 1n && b.nlink === 1n && a.ino !== 0n
    && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

/** Only called after the owned process tree is quiescent, while workspace admission is held.
 * Persist exact bytes first; a failure or any change in file ownership leaves the output intact.
 * No ignore mask or directory cleanup: the ordinary post-check identity still sees every other edit. */
async function retainReport(cwd: string, relative: string, expectedTarget: string, save: (bytes: Buffer) => Promise<void>): Promise<string> {
  const target = await confinedReport(cwd, relative, true);
  if (target !== expectedTarget) throw new Error('Verification report path changed');
  const initial = await fs.lstat(target, { bigint: true });
  if (!initial.isFile() || initial.nlink !== 1n || initial.size > 32n * 1024n * 1024n) throw new Error('Invalid/linked/oversized test report');
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes: Buffer;
  try {
    if (!sameReport(initial, await file.stat({ bigint: true }))) throw new Error('Test report changed before capture');
    // readFile after a stat is unbounded if the file grows. Read at most the observed size + 1.
    const buffer = Buffer.alloc(Number(initial.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== Number(initial.size) || !sameReport(initial, await file.stat({ bigint: true }))) throw new Error('Test report changed during capture');
    bytes = buffer.subarray(0, length);
  } finally { await file.close(); }
  await save(bytes);
  // A check may stage its output, or storage may yield to a replacement/late write. Neither
  // authorizes removing that file. Recheck links and identity after all asynchronous retention.
  await untrackedReport(cwd, target);
  if (await confinedReport(cwd, relative, true) !== target || !sameReport(initial, await fs.lstat(target, { bigint: true }))) throw new Error('Test report changed during retention; left in workspace');
  await fs.unlink(target);
  return bytes.toString('utf8');
}
