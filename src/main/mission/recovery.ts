/** Production restart reconciliation. Journal/Job receipts, never a new manager's empty map,
 * a missing PID, elapsed time or a process-tree inventory. No external action is replayed. */
import path from 'node:path';
import type { MissionOperation, MissionRecord } from '../../shared/mission';
import type { SessionManager } from '../session-manager';
import type { TerminalManager } from '../terminal';
import { bindManagedPiLaunch, inspectManagedPiOwnership } from '../harness/pi-ownership';
import type { MissionWorkspaceAdmission } from './admission';
import { checkOwnershipDirectory, ownershipNonce, processOwnershipIntents, processOwnershipQuiescent } from './process-ownership';
import type { WorkspaceQuiescenceLease } from './workspaces';

interface RecoveryDeps {
  userData: string;
  ownershipRoot: string;
  sessions: Pick<SessionManager, 'list' | 'get'>;
  terminals: Pick<TerminalManager, 'activity' | 'reconcileOwnership'>;
  admission: Pick<MissionWorkspaceAdmission, 'acquire'>;
}
interface RuntimeLaunch { nonce: string; sessionId: string; generation: number; harnessId: string }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
function launchOf(operation: MissionOperation): RuntimeLaunch {
  const launch = operation.payload.runtimeLaunch as RuntimeLaunch | undefined;
  if (!launch || !ownershipNonce(launch.nonce) || !id(launch.sessionId) || launch.sessionId !== operation.payload.sessionId
    || !Number.isSafeInteger(launch.generation) || launch.generation < 0 || typeof launch.harnessId !== 'string') throw new Error(`Dispatch ${operation.id} has no exact durable runtime launch identity.`);
  return launch;
}
const mayHaveStarted = (operation: MissionOperation) => operation.kind === 'dispatch' && !operation.payload.infrastructure
  && (operation.payload.runtimeStartRequestedAt !== undefined || operation.payload.dispatchStartedAt !== undefined
    || !['succeeded', 'failed', 'intent_recorded'].includes(operation.state) && operation.payload.dispatchStage !== 'preparing');

export class MissionRecovery {
  constructor(private readonly deps: RecoveryDeps) {}

  /** Called after the service stops the previous runtime and commits this operation's nonce. */
  async prepareRuntimeStart(record: MissionRecord, operation: MissionOperation): Promise<void> {
    const launch = launchOf(operation), meta = this.deps.sessions.get(launch.sessionId);
    if (!meta?.mission || meta.mission.missionId !== record.id || meta.mission.generation !== launch.generation || meta.config.harness !== launch.harnessId) throw new Error('Runtime launch binding changed before startup.');
    if (launch.harnessId === 'pi') await bindManagedPiLaunch(this.sessionDir(launch.sessionId), { sessionId: launch.sessionId, missionId: record.id, generation: launch.generation }, launch.nonce);
  }

  async reconcileExternalActivity(record: MissionRecord): Promise<{ quiescent: boolean; receipt?: string; detail?: string }> {
    const leases: WorkspaceQuiescenceLease[] = [];
    const unknown = (detail: string) => ({ quiescent: false, detail });
    try {
      const unsupported = [record.leadPreset, ...record.attempts.map((attempt) => attempt.preset)].find((preset) => preset.harnessId !== 'pi');
      if (unsupported) return unknown(`Restart ownership for ${unsupported.harnessId} is not supported.`);
      const sessions = this.deps.sessions.list().filter((session) => session.mission?.missionId === record.id);
      const ids = new Set([record.leadSessionId, ...record.attempts.map((attempt) => attempt.sessionId), ...sessions.map((session) => session.id),
        ...record.workspaces.flatMap((workspace) => workspace.ownerSessionId ? [workspace.ownerSessionId] : []),
        ...record.operations.flatMap((operation) => typeof operation.payload.sessionId === 'string' ? [operation.payload.sessionId] : [])]);
      if ([...ids].some((value) => !id(value))) return unknown('Invalid retained session ownership identity.');
      // Refresh old terminal uncertainty first so a positive Job receipt can unblock acquisition.
      // This preliminary observation is not proof: re-read and recheck under all held leases.
      await this.deps.terminals.reconcileOwnership(ids);
      const locations = [...new Set([record.sourceCwd, ...record.workspaces.filter((workspace) => !workspace.cleanedAt).map((workspace) => workspace.path),
        ...sessions.map((session) => session.cwd), ...this.deps.terminals.activity().filter((activity) => ids.has(activity.sessionId)).flatMap((activity) => [activity.cwd, activity.reportedCwd])])]
        .map((location) => path.resolve(location)).sort((a, b) => a.length - b.length);
      const roots: string[] = [];
      for (const location of locations) if (!roots.some((root) => { const relative = path.relative(root, location); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); })) roots.push(location);
      for (const root of roots) {
        const lease = await this.deps.admission.acquire(root);
        if (!lease) return unknown('Workspace admission could not exclude concurrent writers during recovery.');
        leases.push(lease);
      }
      await this.deps.terminals.reconcileOwnership(ids);
      if (this.deps.terminals.activity().some((activity) => ids.has(activity.sessionId))) return unknown('A retained terminal has no exact empty-Job receipt.');
      const dispatches = record.operations.filter(mayHaveStarted);
      let piIntents = 0;
      for (const sessionId of ids) {
        const meta = this.deps.sessions.get(sessionId);
        if (meta && meta.mission?.missionId !== record.id) return unknown('A retained session belongs to another Mission.');
        if (meta && meta.config.harness !== 'pi') return unknown(`Restart ownership for ${meta.config.harness} is not supported.`);
        const inspection = await inspectManagedPiOwnership(this.sessionDir(sessionId), { sessionId, missionId: record.id });
        if (inspection.state === 'unknown') return unknown(inspection.detail ?? 'A retained Pi launch has no positive receipt.');
        piIntents += inspection.intents;
        for (const operation of dispatches.filter((entry) => entry.payload.sessionId === sessionId)) {
          const launch = launchOf(operation);
          if (launch.harnessId !== 'pi') return unknown(`Restart ownership for ${launch.harnessId} is not supported.`);
          const exact = await inspectManagedPiOwnership(this.sessionDir(sessionId), { sessionId, missionId: record.id, generation: launch.generation, nonce: launch.nonce });
          if (!exact.quiescent) return unknown(`Dispatch ${operation.id}: ${exact.detail ?? 'No exact launch receipt.'}`);
        }
      }
      if (dispatches.some((operation) => !id(operation.payload.sessionId) || !ids.has(operation.payload.sessionId))) return unknown('Dispatch session ownership is incomplete.');
      const checks = await processOwnershipIntents(checkOwnershipDirectory(this.deps.ownershipRoot, record.id));
      for (const intent of checks) {
        const owner = intent.record;
        if (owner.kind !== 'mission-check' || owner.missionId !== record.id || !record.operations.some((operation) => operation.kind === 'verify' && operation.id === owner.operationId)) return unknown('Orphaned host-check ownership intent.');
        if (!await processOwnershipQuiescent(intent)) return unknown('A retained host check has no exact empty-Job receipt.');
      }
      for (const operation of record.operations.filter((entry) => entry.kind === 'verify' && entry.state !== 'intent_recorded' && entry.payload.executionKind !== 'coordination')) {
        // A model request orchestrates a distinct host check; only the latter can spawn. The
        // host records this distinction before effects. Untagged legacy operations still need
        // an exact receipt, rather than guessing from the absence of a child operation.
        if (!checks.some((intent) => intent.record.kind === 'mission-check' && intent.record.operationId === operation.id)) return unknown(`Host check ${operation.id} has no durable launch receipt.`);
      }
      for (const lease of leases) await lease.assertQuiescent();
      return { quiescent: true, receipt: JSON.stringify({ schemaVersion: 1, kind: 'bounded-process-ownership', missionId: record.id,
        dispatches: dispatches.map((operation) => ({ operationId: operation.id, ...launchOf(operation) })), piIntents,
        checks: checks.map((intent) => intent.record.nonce), terminalOwnership: 'all-retained-intents-reconciled', admission: 'held' }) };
    } catch (error) { return unknown(error instanceof Error ? error.message : String(error)); }
    finally { for (const lease of leases.reverse()) await lease.release(); }
  }

  private sessionDir(sessionId: string): string {
    if (!id(sessionId)) throw new Error('Invalid managed session identity.');
    return path.join(this.deps.userData, 'sessions', sessionId);
  }
}
