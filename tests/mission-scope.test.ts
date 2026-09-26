/** R13: production acceptance/promotion gates, not worker-declared file lists. */
import { describe, expect, it } from 'vitest';
import type { MissionRecord, MissionTask } from '../src/shared/mission';
import { assertMissionRecord, reduceMission, type MissionMutation } from '../src/main/mission/state';
import { missionFixture } from './support/mission-fixture';

function captured(ownedPaths = ['src/feature.ts'], changedPaths = ['src/feature.ts'], exclusions: string[] = [], planExclusions: string[] = []): MissionRecord {
  const base = { baseCommitSha: 'base', contentHash: 'original' }, revision = { ...base, contentHash: changedPaths.length ? 'changed' : 'original' };
  const r = missionFixture({ entryMode: 'autonomous', phase: 'executing', baseline: base, acceptedRevision: base,
    executionAuthorization: { kind: 'autonomous_launch', sourceUserActionId: 'user-launch', specificationRevision: 1, recordedAt: 1 } });
  r.plan.exclusions = planExclusions; r.deliveryPolicy.requireIndependentReview = false;
  const task: MissionTask = { id: 'task', revision: 1, specificationRevision: 1, objective: 'Implement the feature', scope: 'Feature behavior', ownedPaths, exclusions,
    dependsOn: [], decisionRefs: [], sharedContracts: [], requiredTools: [], criteria: [], verificationIds: [], assignment: { kind: 'lead' }, required: true, status: 'candidate_ready', currentAttemptId: 'attempt' };
  r.tasks = [task];
  r.workspaces = [{ id: 'workspace', role: 'lead', path: '/workspace', branch: 'mission/scope', base, ownerSessionId: r.leadSessionId }];
  r.attempts = [{ id: 'attempt', taskId: task.id, taskRevision: 1, specificationRevision: 1, generation: 1, sessionId: r.leadSessionId, tierId: 5, preset: r.leadPreset,
    selectionReason: 'Bounded feature', sourceRevision: base, workspaceId: 'workspace', continuationOwner: 'mission', status: 'terminal', outcome: 'submitted', terminalTurnId: 'turn',
    result: { taskId: task.id, taskRevision: 1, specificationRevision: 1, attemptId: 'attempt', status: 'candidate', summary: 'Only changed the feature', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] }, repairTurns: 0, requestedAt: 1, endedAt: 2 }];
  r.candidates = [{ id: 'candidate', attemptId: 'attempt', taskId: task.id, taskRevision: 1, specificationRevision: 1, sourceRevision: base, revision, changedPaths, capturedAt: 2 }];
  assertMissionRecord(r); return r;
}

function transition(r: MissionRecord, gate: 'accept' | 'promote') {
  if (gate === 'promote') r.tasks[0].status = 'accepted'; // Legacy accepted record must be checked again, before Git CAS.
  const mutation: MissionMutation = gate === 'accept' ? { kind: 'task.accept', taskId: 'task', attemptId: 'attempt' }
    : { kind: 'host.integration.promote', candidateId: 'candidate', expectedAcceptedRevision: r.acceptedRevision!, revision: r.candidates[0].revision };
  const actor = gate === 'accept' ? { kind: 'lead' as const, sessionId: r.leadSessionId, generation: r.leadGeneration } : { kind: 'host' as const };
  return () => reduceMission(r, actor, mutation);
}

for (const gate of ['accept', 'promote'] as const) describe(`Mission captured-path scope at ${gate}`, () => {
  it.each([
    ['src/feature.ts', 'src/feature.ts', true], ['src/feature.ts', 'src/feature.tsx', false], ['src/feature.ts', 'src/feature.ts/nested', false],
    ['src/', 'src/deep/feature.ts', true], ['src/', 'src-other/feature.ts', false], ['src', 'src/feature.ts', false],
    ['src/*', 'src/feature.ts', true], ['src/*', 'src/deep/feature.ts', false], ['src/*', 'src/.hidden', true],
    ['src/f?.ts', 'src/f1.ts', true], ['src/f?.ts', 'src/f12.ts', false], ['src/**/test?.ts', 'src/test1.ts', true], ['src/**/test?.ts', 'src/deep/more/test2.ts', true],
    ['**/*.ts', 'root.ts', true], ['**/*.ts', 'deep/file.ts', true], ['**/.env', '.env', true], ['**', 'package.json', true],
    ['src/a+b.ts', 'src/a+b.ts', true], ['src/a+b.ts', 'src/ab.ts', false], ['src/feature.ts', 'SRC/feature.ts', false],
    ['docs/release notes.md', 'docs/release notes.md', true], ['src/你好.ts', 'src/你好.ts', true],
  ])('matches %s against %s (allowed=%s)', (pattern, file, allowed) => {
    const r = captured([pattern as string], [file as string]), run = transition(r, gate), before = structuredClone(r);
    if (allowed) expect(run().tasks[0].status).toBe(gate === 'accept' ? 'accepted' : 'integrated');
    else expect(run).toThrow(/scope/i);
    expect(r).toEqual(before);
  });

  it.each(['src/[ab].ts', 'src/{a,b}.ts', 'src/!(secret).ts', '!src/**', 'src/**file.ts', 'src/***', 'src//file.ts', './src/**', '../src/**', '/src/**', 'C:/src/**', 'src\\**', '~/src/**', '$ROOT/src/**'])('fails closed on unsupported ownership %s even alongside a matching allow-all', (pattern) => {
    expect(transition(captured(['**', pattern]), gate)).toThrow(/scope.*unsupported/i);
  });

  it.each(['../escape.ts', './src/feature.ts', '/absolute.ts', 'C:/drive.ts', 'src\\feature.ts', 'src//feature.ts', 'src/../feature.ts', 'src/file.ts ', 'src/file.ts.', 'src/CON', 'src/file:stream'])('rejects nonportable captured path %s under allow-all', (file) => {
    expect(transition(captured(['**'], [file]), gate)).toThrow(/scope/i);
  });

  it('requires ownership of every actual path, with no empty-list wildcard or reported-file escape', () => {
    expect(transition(captured([], ['src/feature.ts']), gate)).toThrow(/scope/i);
    expect(transition(captured(['src/feature.ts'], ['src/feature.ts', 'shared/schema.ts']), gate)).toThrow(/scope.*shared\/schema.ts/i);
    expect(transition(captured([], []), gate)().tasks[0].status).toBe(gate === 'accept' ? 'accepted' : 'integrated');
  });

  it.each(['task', 'plan'] as const)('enforces whole path-shaped %s exclusions, never interpreting prose as semantic proof', (source) => {
    for (const exclusion of ['src/feature.ts', 'src/', '**/feature.ts', 'src/[ab].ts', '!src/**', '../outside']) {
      const exclusions = source === 'task' ? [exclusion] : [], planExclusions = source === 'plan' ? [exclusion] : [];
      expect(transition(captured(['**'], ['src/feature.ts'], exclusions, planExclusions), gate)).toThrow(/scope/i);
    }
    expect(transition(captured(['**'], ['docs/release notes.md'], ['docs/release notes.md']), gate)).toThrow(/scope/i);
    const prose = ['Do not add runtime dependencies', 'Preserve public behavior'];
    expect(transition(captured(['src/**'], ['src/feature.ts'], source === 'task' ? prose : [], source === 'plan' ? prose : []), gate)().tasks[0].status).toBe(gate === 'accept' ? 'accepted' : 'integrated');
  });
});

it('accepts read-only scout/reviewer artifacts with no write ownership, with or without an empty host capture', () => {
  for (const hasCapture of [false, true]) {
    const r = captured([], []), a = r.attempts[0];
    const profile = { id: 'reviewer', revision: 1, name: 'Reviewer', purpose: 'Read the fixed candidate', instructions: 'Inspect without writing', tierId: 5 as const, contextRefs: [], requestedTools: ['read'], sourceAccess: 'read_only' as const, resultExpectations: 'Evidence-backed result' };
    r.profiles = [profile]; a.profile = profile; a.sessionId = 'reviewer'; r.workspaces[0].ownerSessionId = a.sessionId; r.workspaces[0].role = 'worker';
    r.tasks[0].assignment = { kind: 'worker', profileId: profile.id, profileRevision: 1 };
    if (!hasCapture) r.candidates = [];
    expect(transition(r, 'accept')().tasks[0].status).toBe('accepted');
  }
});
