/** Deterministic data only. Runtime/service tests still use real stores, adapters and Git. */
import { createDefaultMissionConfig } from '../../src/shared/mission-config';
import type { MissionRecord } from '../../src/shared/mission';
import { localMissionDeliveryPolicy } from '../../src/main/mission/delivery';

export function missionFixture(patch: Partial<MissionRecord> = {}): MissionRecord {
  const config = createDefaultMissionConfig();
  const leadPreset = { id: 'frontier', revision: 1, name: 'Principal engineer', harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets.push(leadPreset); config.tiers[4].presetIds = [leadPreset.id]; config.defaultLeadPresetId = leadPreset.id;
  return {
    schemaVersion: 1, id: 'mission', revision: 1, lastEventSequence: 1, title: 'Deliver a fixture', objective: 'Deliver a fixture', projectRoot: '/project', sourceCwd: '/project', sourceUserActionId: 'user-launch',
    leadSessionId: 'lead', leadGeneration: 1, leadPreset, config, configHistory: [], providerRestrictions: {}, entryMode: 'interactive_plan', phase: 'planning', status: 'running', requestedPermissionMode: 'auto',
    specificationRevision: 1, planRevision: 0,
    plan: { objective: 'Deliver a fixture', scope: 'Pending investigation', exclusions: [], behavior: 'Pending investigation', integrationPoints: [], verificationApproach: 'Pending investigation', criteria: [], assumptions: [] },
    questions: [], decisions: [], profiles: [], tasks: [], attempts: [], candidates: [], evidence: [], reviews: [], operations: [], mailbox: [], workspaces: [], blockers: [], deliveryPolicy: localMissionDeliveryPolicy(),
    progress: { completedTurns: 0, checkpointsWithoutProgress: 0, lastProgressRevision: 0 }, createdAt: 1, updatedAt: 1, ...patch,
  };
}
