import { describe, expect, it } from 'vitest';
import { captureMissionSource, missionPlanMarkdown } from '../src/main/mission/context';
import type { TranscriptItem } from '../src/shared/types';
import { missionFixture } from './support/mission-fixture';

describe('Mission plan Markdown projection', () => {
  it('includes current plan contracts, profiles, dependency conditions, checks and delivery limits without runtime/source payloads', () => {
    const record = missionFixture({ revision: 9, specificationRevision: 3, planRevision: 5 });
    const criterion = { id: 'acceptance', description: 'Actual result must match', required: true, evidenceKinds: ['behavior' as const] };
    record.plan = { objective: 'Latest objective', scope: 'Current scope', behavior: 'Expected outcome', exclusions: ['No rollout'], integrationPoints: ['Public API'], verificationApproach: 'Exercise production boundary', criteria: [criterion],
      assumptions: [{ id: 'assumption', description: 'Keep compatibility', rationale: 'Existing clients', source: 'User discussion', affectedTaskIds: ['task'], criterionIds: ['acceptance'], status: 'confirmed' }] };
    record.questions = [{ id: 'question', text: 'Which format?', answer: 'Markdown only.' }];
    record.decisions = [{ id: 'decision', question: 'Where to save?', proposedResolution: 'In source', resolution: 'User chooser', rationale: 'Preserve source', evidenceIds: ['observed'], affectedTaskIds: ['task'], requestedBy: 'lead' }];
    record.profiles = [{ id: 'profile', revision: 2, name: 'Investigator', purpose: 'Inspect compatibility', instructions: 'Read before reporting', tierId: 4, contextRefs: ['context'], requestedTools: ['read'], sourceAccess: 'read_only', resultExpectations: 'Evidence with limitations' }];
    record.tasks = [{ id: 'task', revision: 2, specificationRevision: 3, objective: 'Deliver exporter', scope: 'Bounded implementation', ownedPaths: ['src/export.ts'], exclusions: ['src/source.ts'], dependsOn: [{ taskId: 'design', condition: 'accepted_artifact' }, { taskId: 'foundation', condition: 'integrated_code' }], decisionRefs: ['decision'], sharedContracts: ['Public contract'], requiredTools: ['edit'], criteria: [criterion], verificationIds: ['unit'], assignment: { kind: 'worker', profileId: 'profile', profileRevision: 2 }, status: 'planned', required: true }];
    record.deliveryPolicy = { ...record.deliveryPolicy, endpoint: 'open_pr', remote: 'origin', targetBranch: 'develop', targetHead: 'abc123', mergeMethod: 'squash', allowPush: true, allowMerge: false, fallback: false, holdIsEndpoint: true,
      checks: [{ id: 'unit', name: 'Production boundary', kind: 'test', command: 'npm test', criterionIds: ['acceptance'], required: true, heavy: true, timeoutMs: 5000, testReport: { format: 'vitest-json', path: 'test.json', minimumTests: 3, maximumSkipped: 0 } }],
      holdConditions: ['Human review'], conflicts: ['Policy needs clarification'], provenance: [{ source: 'AGENTS.md', text: 'Do not merge automatically' }] };
    record.publicationRestrictions = [{ previousEndpoint: 'merge_pr', endpoint: 'open_pr', sourceUserActionId: 'user-secret-control', receivedRevision: 8, recordedAt: 9, priorRemoteOperationIds: ['prior-operation'] }];
    record.mailbox = [{ id: 'mail', kind: 'user', sessionId: 'lead', text: 'raw-retained-source-not-for-export', artifactIds: ['attachment-bytes'], createdAt: 1 }];
    record.operations = [{ id: 'operation', idempotencyKey: 'key', expectedRevision: 1, kind: 'dispatch', actor: 'host', state: 'succeeded', payload: { token: 'broker-token-not-for-export' } }];
    record.config.presets[0].guidance = 'config-history-not-for-export';
    record.blockers = [{ id: 'open', kind: 'environment', message: 'Open blocker' }, { id: 'resolved', kind: 'unknown', message: 'Resolved blocker', resolvedAt: 0 }];
    const before = structuredClone(record);
    const markdown = missionPlanMarkdown(record);
    for (const text of ['Specification 3 · Plan 5 · Record 9', 'Latest objective', 'Current scope', 'No rollout', 'Expected outcome', 'Public API', 'Actual result must match', 'Existing clients', 'User discussion', 'Which format?', 'Markdown only\\.', 'Proposed resolution (not accepted): In source', 'Resolution: User chooser', 'Investigator (profile@2)', 'Tier: T4', 'Read before reporting', 'Context references: context', 'Requested tools: read', 'Source access: read\\_only', 'Evidence with limitations', 'task@2', 'Assignment: profile@2', 'design (accepted\\_artifact)', 'foundation (integrated\\_code)', 'src/export\\.ts', 'src/source\\.ts', 'Shared contracts: Public contract', 'Required tools: edit', 'Checks: unit', 'Exercise production boundary', 'Command: npm test', 'Timeout: 5000 ms', 'Minimum executed tests: 3', 'Maximum skipped tests: 0', 'Endpoint: open\\_pr', 'Remote: origin', 'Target branch: develop', 'Observed target: abc123', 'Independent review required: yes', 'Push allowed: yes', 'Merge allowed: no', 'Human review', 'Hold satisfies delivery: yes', 'Policy needs clarification', 'Do not merge automatically', 'merge\\_pr → open\\_pr', 'Open blocker', 'Editing this file does not change the Mission']) expect(markdown, text).toContain(text);
    for (const text of ['raw-retained-source-not-for-export', 'attachment-bytes', 'broker-token-not-for-export', 'config-history-not-for-export', 'user-secret-control', 'Resolved blocker']) expect(markdown).not.toContain(text);
    expect(record).toEqual(before);
  });

  it('escapes model/source Markdown and HTML rather than creating links, headings or executable markup', () => {
    const record = missionFixture({ title: 'Plan\n# Forged heading <script>' });
    record.plan.scope = '![remote](https://example.invalid/tracker)\n</script><img src=x> & &#35; **authority** `code`';
    record.plan.exclusions = ['[click](javascript:alert(1))'];
    const markdown = missionPlanMarkdown(record);
    expect(markdown).toContain('# Plan \\# Forged heading &lt;script&gt;');
    expect(markdown).toContain('\\!\\[remote\\]\\(https://example\\.invalid/tracker\\)');
    expect(markdown).toContain('&lt;/script&gt;&lt;img src=x&gt; &amp; &amp;\\#35; \\*\\*authority\\*\\* \\`code\\`');
    expect(markdown).not.toContain('\n# Forged'); expect(markdown).not.toContain('<script>'); expect(markdown).not.toContain('![remote]');
  });

  it('fails explicitly at the UTF-8 export limit rather than saving a truncated plan', () => {
    const record = missionFixture();
    record.plan.exclusions = Array.from({ length: 20 }, () => 'é'.repeat(50_000));
    expect(() => missionPlanMarkdown(record)).toThrow('1 MiB limit');
    expect(record.plan.exclusions).toHaveLength(20);
  });
});

describe('Mission source retention', () => {
  it('preserves full messages and attachments beyond ordinary fork-context caps', () => {
    const text = 'original requirement '.repeat(2_000) + '\nFINAL REQUIREMENT MUST SURVIVE';
    const items: TranscriptItem[] = [{ id: 'source-user', kind: 'user', ts: 1, text, images: [{ mimeType: 'image/png', data: 'attachment', name: 'design.png' }] }];
    const snapshot = captureMissionSource({ originSessionId: 'source', items, objective: 'implement', submittedCommand: '/mission implement', capturedAt: 2 });
    expect(snapshot.items).toEqual(items);
    expect(snapshot.items[0]).toMatchObject({ text, images: [{ data: 'attachment' }] });
    if (items[0].kind === 'user') items[0].text = 'changed after launch';
    items.length = 0; // Source entry removal cannot erase the detached persisted package.
    expect(snapshot.items[0]).toMatchObject({ text });
    expect(snapshot.cutoffId).toBe('source-user');
    expect(snapshot.submittedCommand).toBe('/mission implement');
  });
  it('honors the exact cutoff and refuses missing source identities rather than guessing', () => {
    const items: TranscriptItem[] = [{ id: 'one', kind: 'user', ts: 1, text: 'first' }, { id: 'two', kind: 'assistant', ts: 2, text: 'later' }];
    const input = { items, objective: 'objective', submittedCommand: '/mission plan objective', capturedAt: 3 };
    expect(captureMissionSource({ ...input, cutoffId: 'one' }).items.map((item) => item.id)).toEqual(['one']);
    expect(() => captureMissionSource({ ...input, cutoffId: 'missing' })).toThrow('cutoff');
    expect(items).toHaveLength(2);
  });
  it('retains the actual launch command without treating quoted text as authorization', () => {
    const source = captureMissionSource({ items: [], objective: 'execute literal', submittedCommand: '/mission start -- execute literal', images: [{ mimeType: 'image/png', data: 'source' }], capturedAt: 1 });
    expect(source).toMatchObject({ schemaVersion: 1, submittedCommand: '/mission start -- execute literal', objective: 'execute literal', images: [{ data: 'source' }] });
    expect(source).not.toHaveProperty('executionAuthorization');
  });
});
