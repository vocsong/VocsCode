/** Production composition. Only this host layer turns persisted Mission intents into processes,
 * permissions, Git effects and normalized session events. No renderer or model supplies these ports. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HARNESS_BY_ID } from '../../shared/harness-meta';
import { checkMissionPresetAdherence, createDefaultMissionConfig, type MissionPresetCapabilities } from '../../shared/mission-config';
import type { MissionRecord, MissionView } from '../../shared/mission';
import type { SettingsStore } from '../settings';
import type { SessionManager } from '../session-manager';
import type { TerminalManager } from '../terminal';
import type { Logger } from '../log';
import { commandApproval, gateAction, OPTIONS_ALLOW_DENY_NO_SESSION } from '../harness/permissions';
import { MissionWorkspaceAdmission } from './admission';
import { MissionDeliveryService, type MissionDeliveryRequest } from './delivery';
import { resolveMissionDeliveryPolicy } from './policy';
import { MissionScheduler } from './scheduler';
import { MissionRecovery } from './recovery';
import { MissionService, type MissionCapabilityPort } from './service';
import { assertMissionRecord, implementationBlockers } from './state';
import { MissionStore } from './store';
import { assertMissionUsageObservation } from './budget';
import { MissionVerification, VerificationApprovalDenied, type VerificationRequest } from './verification';
import { MissionWorkspaces, type TargetFetchAuthorization } from './workspaces';

export interface MissionRuntimeDeps {
  userData: string;
  /** Bundled trusted resource, never resolved relative to the project or working directory. */
  windowsJobHelper?: string;
  sessions: SessionManager;
  settings: Pick<SettingsStore, 'get' | 'onChange'>;
  terminals: TerminalManager;
  changed(view: MissionView): void;
  log: Logger;
}

/** Reads the exact already-started adapter, never a cached model catalog or another session. */
export function missionCapabilities(sessions: SessionManager, settings: Pick<SettingsStore, 'get'>): MissionCapabilityPort {
  return { probe: async (preset, scope): Promise<MissionPresetCapabilities> => {
    const meta = sessions.get(scope.sessionId);
    if (!meta?.mission || meta.mission.generation !== scope.generation || meta.mission.role !== scope.role || path.resolve(meta.cwd) !== path.resolve(scope.cwd)) throw new Error('Mission runtime capability target changed.');
    if (preset.runtimeVariantId) throw new Error('This Mission driver cannot attest a separately selected runtime variant. Use the verified default runtime.');
    if (preset.model.connectionId && preset.model.connectionId !== preset.model.provider) throw new Error('This driver cannot attest a separate account identity. Select an explicitly configured provider connection instead.');
    const { readiness, models } = await sessions.prepareManaged(meta.id, scope.generation);
    const live = sessions.get(meta.id);
    if (!live?.mission || live.mission.generation !== scope.generation || live.cwd !== meta.cwd) throw new Error('Mission capability observation became stale.');
    if (!readiness.ready) throw new Error(`Unverified Mission runtime: ${readiness.reason ?? 'the exact coordination/permission handshake has not completed.'}`);
    const observedModel = readiness.model && { ...readiness.model, ...(preset.model.connectionId === readiness.model.provider ? { connectionId: readiness.model.provider } : {}) };
    const adherence = checkMissionPresetAdherence(preset, {
      harnessId: live.config.harness, model: observedModel,
      reasoning: readiness.effort ? { kind: 'explicit', value: readiness.effort } : preset.reasoning.kind === 'default' && live.mission.reasoningDefault ? { kind: 'default' } : undefined,
    });
    if (adherence.status !== 'matched') throw new Error(`Mission preset ${adherence.status}: ${[...adherence.mismatches, ...adherence.unknown].join(', ')}. No prompt was sent with an inferred model or effort.`);
    const provider = settings.get().providers.find((p) => p.id === preset.model.provider);
    return {
      source: 'runtime', runtime: { available: true, authenticated: readiness.connectionAvailable ?? 'unknown' },
      connectionAvailable: provider?.enabled === false ? false : readiness.connectionAvailable,
      modelAvailable: readiness.modelAvailable,
      modelInfo: models.find((m) => m.provider === preset.model.provider && m.id === preset.model.model),
      harnessCapabilities: HARNESS_BY_ID[preset.harnessId].capabilities,
      controlProtocol: true, worktreeCwd: true, completionObservation: true, cancellationObservation: true,
      projectAllowed: true, missionTools: true, delegationControl: true, tools: [...readiness.tools],
    };
  } };
}

export class MissionRuntime {
  readonly store: MissionStore<MissionRecord>;
  readonly scheduler: MissionScheduler;
  readonly admission: MissionWorkspaceAdmission;
  readonly workspaces: MissionWorkspaces;
  readonly verification: MissionVerification;
  readonly delivery: MissionDeliveryService;
  readonly service: MissionService;
  private readonly allowed = new Set<string>();
  private readonly detachSettings: () => void;
  private closed = false;

  constructor(private readonly deps: MissionRuntimeDeps) {
    const configuration = () => deps.settings.get().mission ?? createDefaultMissionConfig();
    this.store = new MissionStore<MissionRecord>(deps.userData, { validate: assertMissionRecord, validateObservation: assertMissionUsageObservation, maxBlobBytes: 64 * 1024 * 1024, log: deps.log });
    this.scheduler = new MissionScheduler(configuration().limits);
    this.admission = new MissionWorkspaceAdmission({
      sessions: () => deps.sessions.list(), activity: (id) => deps.sessions.activity(id), terminals: () => deps.terminals.activity(),
      released: () => { for (const session of deps.sessions.list()) this.service?.workspaceAvailable(session.cwd); },
    });
    this.workspaces = new MissionWorkspaces({ root: path.join(deps.userData, 'mission-workspaces'), quiescence: this.admission });
    const ownershipRoot = path.join(deps.userData, 'mission-process-ownership');
    const recovery = new MissionRecovery({ userData: deps.userData, ownershipRoot, sessions: deps.sessions, terminals: deps.terminals, admission: this.admission });
    this.verification = new MissionVerification({
      scheduler: this.scheduler, windowsJobHelper: deps.windowsJobHelper, ownershipRoot,
      authorize: (request) => this.authorizeCheck(request),
      contentIdentity: (cwd) => this.workspaces.contentIdentity(cwd),
      saveArtifact: (id, bytes) => this.store.writeArtifact(id, bytes),
    });
    this.delivery = new MissionDeliveryService({
      root: path.join(deps.userData, 'mission-delivery'),
      authorize: (request, action) => this.authorizeDelivery(request, action),
      contentIdentity: (cwd) => this.workspaces.contentIdentity(cwd),
      integratedTarget: (record) => this.workspaces.integratedTargetObservation(record.id),
      isQuiescent: async (record) => this.service.isQuiescent(record),
      implementationBlockers: (record) => {
        const delivering = record.operations.filter((o) => o.kind === 'deliver' && o.state === 'in_flight');
        return implementationBlockers(record, { quiescent: this.service.isQuiescent(record), deliveryOperationId: delivering.length === 1 ? delivering[0].id : undefined });
      },
    });
    this.service = new MissionService({
      store: this.store, sessions: deps.sessions, workspaces: this.workspaces, scheduler: this.scheduler, verification: this.verification,
      settings: (projectRoot) => ({ config: configuration(), project: deps.settings.get().missionProjects?.[projectRoot] }),
      capabilities: missionCapabilities(deps.sessions, deps.settings),
      prepareRuntimeStart: (record, operation) => recovery.prepareRuntimeStart(record, operation),
      reconcileExternalActivity: (record) => recovery.reconcileExternalActivity(record),
      assertWorkspaceAvailable: (cwd) => this.admission.assertAvailable(cwd),
      additionalActivity: (record) => deps.terminals.activity().some((activity) => deps.sessions.get(activity.sessionId)?.mission?.missionId === record.id
        || activity.sessionId === record.leadSessionId || record.attempts.some((a) => a.sessionId === activity.sessionId)),
      stopOwnedTerminals: async (record) => {
        const sessionIds = new Set([record.leadSessionId, ...record.attempts.map((a) => a.sessionId), ...deps.sessions.list().filter((s) => s.mission?.missionId === record.id).map((s) => s.id)]);
        await Promise.all([...sessionIds].map((id) => deps.terminals.closeManagedSession(id)));
      },
      delivery: { resolve: (root, options) => resolveMissionDeliveryPolicy(root, options), deliver: (request) => this.delivery.deliver(request), inspect: (request) => this.delivery.inspect(request), authorizeTargetFetch: (request) => this.authorizeTargetFetch(request) },
      onChange: deps.changed, log: (message) => deps.log('warn', `mission: ${message}`),
    });
    let providers = structuredClone(deps.settings.get().providers);
    this.detachSettings = deps.settings.onChange((settings) => {
      const current = new Map(settings.providers.map((provider) => [provider.id, provider]));
      // Pi can also use runtime-owned credentials, so absence from the app catalog alone is
      // not revocation. An explicit disable/removal or loss of a previously stored key is.
      const revoked = new Set(settings.providers.filter((provider) => !provider.enabled).map((provider) => provider.id));
      for (const provider of providers) {
        const next = current.get(provider.id);
        if (!next || provider.hasApiKey && !next.hasApiKey) revoked.add(provider.id);
      }
      providers = structuredClone(settings.providers);
      // Fence/revoke before configure can admit a queued turn on newly freed account capacity.
      this.service.configurationChanged([...revoked]);
      this.scheduler.configure(configuration().limits);
    });
  }

  async load(): Promise<void> { await this.service.load(); }

  private current(id: string, operationId: string, kind: 'verify' | 'deliver' | 'integrate'): MissionRecord {
    const record = this.service.get(id);
    if (this.closed || !record || this.store.isBlocked(id) || record.status !== 'running' || !record.executionAuthorization || record.phase === 'planning') throw new Error('Mission execution is not currently authorized.');
    const operation = record.operations.find((o) => o.id === operationId);
    if (!operation || operation.kind !== kind || operation.state !== 'in_flight') throw new Error('No committed in-flight intent owns this operation.');
    return record;
  }

  private async permission(record: MissionRecord, operationId: string, action: string, command: string, cwd: string): Promise<void> {
    const verdict = gateAction(record.requestedPermissionMode, { mutating: true, isEdit: false, command });
    if (verdict === 'deny') throw new Error('Plan permission mode does not authorize project execution or delivery.');
    if (verdict === 'allow') return;
    const token = createHash('sha256').update(JSON.stringify([record.id, operationId, action, command, cwd, record.leadGeneration, record.requestedPermissionMode, record.executionAuthorization])).digest('hex');
    if (this.allowed.has(token)) return;
    const decision = await this.deps.sessions.requestManagedApproval(record.leadSessionId, record.leadGeneration, commandApproval(command, cwd, {
      title: action === 'verify' ? 'Run Mission verification?' : `Allow Mission ${action.replaceAll('_', ' ')}?`,
      description: 'The principal engineer requested this operation. This approval is for the exact persisted operation, not permission to change the plan or provider.',
      options: OPTIONS_ALLOW_DENY_NO_SESSION,
    }));
    if (decision.optionId !== 'allow') throw new VerificationApprovalDenied('Mission operation was not approved by the user.');
    this.allowed.add(token);
  }

  private async authorizeCheck(request: VerificationRequest): Promise<void> {
    const validate = () => {
      const record = this.current(request.missionId, request.operationId, 'verify');
      const operation = record.operations.find((o) => o.id === request.operationId)!;
      if (operation.payload.executionKind !== 'process' || record.specificationRevision !== request.specificationRevision || operation.payload.checkId !== request.check.id || !isDeepStrictEqual(operation.payload.revision, request.revision)) throw new Error('Verification intent belongs to a different source/specification.');
      if (!record.deliveryPolicy.checks.some((c) => isDeepStrictEqual(c, request.check))) throw new Error('The exact check contract is no longer approved.');
      return record;
    };
    const record = validate();
    const workspace = await this.workspaces.workspaceAt(request.cwd);
    if (workspace.missionId !== record.id || !['verification', 'integration-attempt'].includes(workspace.role)) throw new Error('Checks require an exact owned isolated verification workspace.');
    await this.permission(record, request.operationId, 'verify', request.check.command, request.cwd);
    validate();
  }

  private async authorizeTargetFetch(request: TargetFetchAuthorization): Promise<void> {
    const validate = () => {
      const record = this.current(request.missionId, request.operationId, 'integrate');
      const operation = record.operations.find((o) => o.id === request.operationId)!;
      if (operation.payload.target !== 'approved' || operation.payload.specificationRevision !== record.specificationRevision || !isDeepStrictEqual(operation.payload.expectedAccepted, record.acceptedRevision)
        || record.deliveryPolicy.remote !== request.remote || record.deliveryPolicy.targetBranch !== request.targetBranch || record.deliveryPolicy.endpoint === 'local_commit' || record.deliveryPolicy.conflicts.length) throw new Error('Target fetch no longer matches the exact approved integration intent.');
      return record;
    };
    const record = validate();
    const workspace = await this.workspaces.workspaceAt(request.cwd);
    if (workspace.missionId !== record.id || workspace.role !== 'integration') throw new Error('Target fetch requires the owned integration workspace.');
    await this.permission(record, request.operationId, 'fetch_target', `git ${request.args.map((arg) => JSON.stringify(arg)).join(' ')}`, request.cwd);
    validate();
  }

  private async authorizeDelivery(request: MissionDeliveryRequest, action: 'commit' | 'push' | 'create_pr' | 'merge_pr'): Promise<void> {
    const validate = () => {
      const record = this.current(request.mission.id, request.operationId, 'deliver');
      if (record.specificationRevision !== request.mission.specificationRevision || !isDeepStrictEqual(record.acceptedRevision, request.mission.acceptedRevision) || !isDeepStrictEqual(record.deliveryPolicy, request.mission.deliveryPolicy)) throw new Error('Delivery input changed; reconcile before publishing.');
      if (record.mailbox.some((m) => m.kind === 'user' && m.deliveredAt === undefined)) throw new Error('Delivery waits for the principal engineer to consume pending user instructions.');
      if (action !== 'commit' && !record.deliveryPolicy.allowPush || action === 'merge_pr' && !record.deliveryPolicy.allowMerge) throw new Error('Project policy did not grant this remote action.');
      return record;
    };
    const record = validate();
    const workspace = record.workspaces.find((w) => w.role === 'integration' && !w.cleanedAt);
    if (!workspace) throw new Error('The retained integration workspace is missing.');
    const command = action === 'commit' ? `git commit-tree ${record.acceptedRevision!.contentHash}`
      : action === 'push' ? `git push ${record.deliveryPolicy.remote} mission/${record.id}-delivery`
        : action === 'create_pr' ? `gh pr create --base ${record.deliveryPolicy.targetBranch} --head mission/${record.id}-delivery`
          : `gh pr merge mission/${record.id}-delivery --${record.deliveryPolicy.mergeMethod ?? 'merge'}`;
    await this.permission(record, request.operationId, action, command, workspace.path);
    validate();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachSettings();
    this.admission.close();
    await this.service.close();
    this.allowed.clear();
  }
}
