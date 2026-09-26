/** Retained completed history for Q&A tests, not evidence of a live implementation/check run. */
import { reduceMission } from '../../src/main/mission/state';
import type { MissionRecord } from '../../src/shared/mission';
import { missionFixture } from './mission-fixture';

export function completedMissionFixture(projectRoot: string): MissionRecord {
  const r = missionFixture({ projectRoot, sourceCwd: projectRoot, entryMode: 'autonomous', phase: 'delivering' });
  r.leadPreset.harnessId = 'pi'; r.config.presets[0].harnessId = 'pi';
  const revision = { baseCommitSha: 'retained-base', contentHash: 'retained-content' };
  const criterion = { id: 'behavior', description: 'Retained behavior check', required: true, evidenceKinds: ['behavior' as const] };
  const profile = { id: 'reader', revision: 1, name: 'Reader', purpose: 'Read retained facts', instructions: 'Report facts', tierId: 5 as const, contextRefs: [], requestedTools: [], sourceAccess: 'read_only' as const, resultExpectations: 'Report' };
  r.baseline = revision; r.acceptedRevision = revision;
  r.executionAuthorization = { kind: 'autonomous_launch', sourceUserActionId: r.sourceUserActionId, specificationRevision: 1, recordedAt: 1 };
  r.plan.criteria = [criterion]; r.planRevision = 1;
  r.profiles = [profile];
  r.workspaces = [{ id: 'retained-reader', role: 'worker', path: projectRoot, branch: 'retained', base: revision, ownerSessionId: 'worker' }];
  r.tasks = [{ id: 'investigation', revision: 1, specificationRevision: 1, objective: 'Retained investigation', scope: 'Retained facts', ownedPaths: [], exclusions: [], dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: [], criteria: [criterion], verificationIds: ['behavior-check'], assignment: { kind: 'worker', profileId: profile.id, profileRevision: 1 }, required: true, status: 'accepted', currentAttemptId: 'retained-attempt' }];
  r.attempts = [{ id: 'retained-attempt', taskId: 'investigation', taskRevision: 1, specificationRevision: 1, generation: 1, sessionId: 'worker', profile, tierId: 5, preset: r.leadPreset, selectionReason: 'Historical fixture', sourceRevision: revision, workspaceId: 'retained-reader', continuationOwner: 'mission', status: 'terminal', outcome: 'submitted', terminalTurnId: 'old-turn', repairTurns: 0, requestedAt: 1, endedAt: 2,
    result: { taskId: 'investigation', taskRevision: 1, attemptId: 'retained-attempt', specificationRevision: 1, status: 'candidate', summary: 'Historical result', artifactIds: [], evidenceIds: ['retained-evidence'], decisionIds: [], unresolved: [] } }];
  r.deliveryPolicy.checks = [{ id: 'behavior-check', name: 'Retained smoke check', kind: 'behavior', command: 'node retained-check.cjs', criterionIds: ['behavior'], required: true, heavy: false, timeoutMs: 1000 }];
  r.evidence = [{ id: 'retained-evidence', criterionIds: ['behavior'], specificationRevision: 1, sourceRevision: revision, checkId: 'behavior-check', kind: 'behavior', commandOrFlow: 'node retained-check.cjs', cwd: projectRoot, environmentRef: 'retained-environment', provenance: 'host_executed', result: 'passed', exitCode: 0, artifactIds: ['retained-output'], startedAt: 1, endedAt: 2 }];
  r.operations = [{ id: 'retained-delivery', idempotencyKey: 'retained-delivery', kind: 'deliver', actor: 'host', expectedRevision: 0, state: 'succeeded', payload: {} }];
  r.delivery = { operationId: 'retained-delivery', revision, endpoint: 'local_commit', status: 'delivered', commitSha: 'retained-delivery-commit', completedAt: 3 };
  return reduceMission(r, { kind: 'host' }, { kind: 'host.complete', quiescent: true });
}
