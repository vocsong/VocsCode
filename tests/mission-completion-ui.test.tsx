/** @vitest-environment jsdom */
/** Renderer consumes the durable host report; it never parses assistant prose into facts. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ canInvoke: () => true, invoke: invokeMock, on: () => () => undefined, isMac: false, isWeb: false, platform: 'win32', modKey: 'Ctrl' }));
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MissionRecord } from '../src/shared/mission';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { createDefaultMissionConfig } from '../src/shared/mission-config';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { MissionPanel } from '../src/renderer/src/components/mission/MissionPanel';
import { useStore } from '../src/renderer/src/store';

const revision = { baseCommitSha: 'a'.repeat(40), contentHash: 'b'.repeat(40) };
const localCommit = 'c'.repeat(40), mergeCommit = 'd'.repeat(40), pr = 'https://github.com/fixture/repo/pull/12';
const narrative = 'All 999 checks passed; merged at invented-merge in https://github.com/invented/repo/pull/99.';
function completedRecord(): MissionRecord {
  const leadPreset = { id: 'frontier', revision: 1, name: 'Lead', harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  const config = createDefaultMissionConfig(); config.presets = [leadPreset]; config.tiers[4].presetIds = [leadPreset.id];
  const delivery = { operationId: 'delivered', revision, endpoint: 'local_commit' as const, status: 'delivered' as const, commitSha: localCommit, completedAt: 5 };
  const record: MissionRecord = {
    schemaVersion: 1, id: 'mission', revision: 5, lastEventSequence: 5, title: 'Completed fixture', objective: 'Deliver verified behavior', projectRoot: '/project', sourceCwd: '/project', sourceUserActionId: 'launch', leadSessionId: 'lead', leadGeneration: 1, leadPreset, config, configHistory: [], providerRestrictions: {}, entryMode: 'autonomous', phase: 'done', status: 'completed', requestedPermissionMode: 'ask', specificationRevision: 1, planRevision: 1,
    questions: [], plan: { objective: 'Deliver verified behavior', scope: 'feature', exclusions: [], behavior: 'verified feature', integrationPoints: [], verificationApproach: 'recorded test', criteria: [], assumptions: [] }, decisions: [], profiles: [], tasks: [], attempts: [], candidates: [], evidence: [], reviews: [], operations: [], mailbox: [], workspaces: [], acceptedRevision: revision,
    deliveryPolicy: { endpoint: 'local_commit', checks: [], requireIndependentReview: false, allowPush: false, allowMerge: false, holdConditions: [], holdIsEndpoint: false, fallback: true, provenance: [], conflicts: [] }, delivery, blockers: [], progress: { completedTurns: 1, checkpointsWithoutProgress: 0, lastProgressRevision: 1 }, createdAt: 1, updatedAt: 5
  };
  record.completionReport = { schemaVersion: 1, objective: record.objective, specificationRevision: 1, planRevision: 1, acceptedRevision: revision, completedAt: 5, delivery,
    deliveryPolicy: { holdConditions: [], holdIsEndpoint: false, fallback: true }, tasks: { required: 1, satisfiedRequired: 1, total: 2, satisfied: 1, canceled: 1, superseded: 0 },
    checks: [{ check: { id: 'check', name: 'Behavior tests', command: 'npm test', kind: 'test', criterionIds: [], required: true, heavy: false, timeoutMs: 1000 }, verified: true,
      evidence: { id: 'observed', specificationRevision: 1, criterionIds: [], sourceRevision: revision, checkId: 'check', kind: 'test', commandOrFlow: 'npm test', cwd: '/check', environmentRef: 'isolated', provenance: 'host_executed', result: 'passed', exitCode: 0, executedTests: 3, skippedTests: 1, artifactIds: ['log'], startedAt: 2, endedAt: 3 } }],
    review: { required: true, integratedCandidates: 1, independentlyReviewedCandidates: 1, reviews: [] }, exclusions: ['Mobile runtime'], assumptions: [], decisions: [], limitations: [{ taskId: 'optional', description: 'Optional browser check unavailable.' }] };
  return record;
}
const session: SessionMeta = { id: 'lead', title: 'Completed fixture', createdAt: 1, updatedAt: 5, cwd: '/workspace', config: { harness: 'native', projectRoot: '/project', permissionMode: 'ask' }, status: 'idle', harnessRef: {}, mission: { missionId: 'mission', role: 'lead', generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: true }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 1 } };
let record: MissionRecord;
const items: TranscriptItem[] = [{ id: 'tool', kind: 'tool', ts: 2, name: 'mission_finish_request', status: 'done', input: { commitMessage: 'feat: Deliver feature' } }, { id: 'turn', kind: 'turn', ts: 4, status: 'completed', durationMs: 1000 }];
beforeEach(() => {
  record = completedRecord();
  useStore.setState({ sessions: [session], missions: { mission: record }, missionErrors: {}, missionInspector: null, transcripts: { lead: items }, loaded: { lead: true }, transcriptErrors: {}, searchJump: null });
  invokeMock.mockReset().mockImplementation(async (channel: string) => channel === 'missions:get' ? record : []);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Mission final answer', () => {
  it('is visible in the main lead conversation without model text, outside Worked, with actual local identity after reload', () => {
    const view = render(<Transcript session={session} />);
    const report = screen.getByRole('article', { name: 'Mission completion report' });
    expect(report.closest('.work-group')).toBeNull();
    expect(report.classList.contains('assistant')).toBe(false);
    expect(screen.getByRole('button', { name: /Worked/ }).getAttribute('aria-expanded')).toBe('false');
    expect(within(report).getByText(localCommit)).toBeTruthy();
    expect(within(report).getByText(/3 tests executed · 1 skipped/)).toBeTruthy();
    expect(within(report).getByText(/1\/1 required checks verified/)).toBeTruthy();
    expect(within(report).getByText(/1\/1 changed candidates independently reviewed/)).toBeTruthy();
    expect(within(report).getByText(/Optional browser check unavailable/)).toBeTruthy();
    expect(within(report).getByText('Mobile runtime')).toBeTruthy();
    expect(screen.queryByTestId('mission-completion-narrative')).toBeNull();
    view.unmount();
    useStore.setState({ missions: { mission: JSON.parse(JSON.stringify(record)) } });
    render(<Transcript session={session} />);
    expect(screen.getAllByTestId('mission-completion-report')).toHaveLength(1);
    expect(screen.getByText(localCommit)).toBeTruthy();
    expect(useStore.getState().transcripts.lead).toEqual(items);
  });

  it('keeps the immutable completion answer before later read-only questions and answers', () => {
    useStore.setState({ transcripts: { lead: [...items,
      { id: 'question', kind: 'user', ts: 6, text: 'Which checks ran?' },
      { id: 'answer', kind: 'assistant', ts: 7, text: 'The recorded check is npm test.', phase: 'final' },
      { id: 'answer-turn', kind: 'turn', ts: 8, status: 'completed' }
    ] } });
    const before = structuredClone(record.completionReport);
    render(<Transcript session={session} />);
    const report = screen.getByTestId('mission-completion-report');
    const question = screen.getByText('Which checks ran?');
    const answer = screen.getByText('The recorded check is npm test.');
    expect(report.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(report.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(record.completionReport).toEqual(before);
    expect(screen.getAllByTestId('mission-completion-report')).toHaveLength(1);
  });

  it('keeps invented model checks and IDs in unverified prose, never the host facts or panel identifiers', () => {
    record.completionReport!.narrative = { sessionId: 'lead', text: narrative };
    render(<><Transcript session={session} /><MissionPanel session={session} /></>);
    expect(screen.getByTestId('mission-completion-checks').textContent).not.toContain('999');
    expect(screen.getByTestId('mission-completion-narrative').textContent).toContain(narrative);
    expect(screen.getAllByTestId('mission-delivery-identity')).toHaveLength(2);
    for (const identity of screen.getAllByTestId('mission-delivery-identity')) {
      expect(identity.textContent).toContain(localCommit);
      expect(identity.textContent).not.toContain('invented');
      expect(identity.textContent).toContain('no merge claimed');
    }
  });

  it('shows the genuine PR and merge identifiers and opens only the retained receipt URL', () => {
    record.delivery = { ...record.delivery!, endpoint: 'merge_pr', pullRequestUrl: pr, mergedCommitSha: mergeCommit };
    record.completionReport!.delivery = record.delivery;
    render(<><Transcript session={session} /><MissionPanel session={session} /></>);
    const identity = within(screen.getByTestId('mission-panel')).getByTestId('mission-delivery-identity');
    expect(within(identity).getByText(localCommit)).toBeTruthy(); expect(within(identity).getByText(mergeCommit)).toBeTruthy();
    fireEvent.click(within(identity).getByRole('button', { name: pr }));
    expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: pr });
  });

  it('does not present a held endpoint as a merge or waive a check on the strength of prose', () => {
    record.completionReport!.delivery = { ...record.delivery!, endpoint: 'merge_pr', status: 'held', pullRequestUrl: pr, reason: 'Human review hold' };
    record.completionReport!.deliveryPolicy = { holdConditions: ['Human review hold'], holdIsEndpoint: true, fallback: false };
    const optional = structuredClone(record.completionReport!.checks[0]); optional.check.id = 'optional'; optional.check.required = false; optional.verified = false;
    optional.evidence = { ...optional.evidence!, checkId: 'optional', result: 'waived', executedTests: undefined, skippedTests: undefined, exception: { sourceUserActionId: 'user-waiver', reason: 'Unavailable platform' } };
    record.completionReport!.checks.push(optional);
    render(<Transcript session={session} />);
    expect(screen.getByText('Policy-authorized delivery hold; not merged.')).toBeTruthy();
    expect(screen.getByText(/Unavailable platform \(user action user-waiver\)/)).toBeTruthy();
    expect(screen.getByText(/1\/1 required checks verified/)).toBeTruthy();
    expect(screen.getByText(/No merge claimed/i)).toBeTruthy();
  });

  it('does not manufacture a completion answer from assistant prose or expose it as a worker conversation', () => {
    record.status = 'running'; delete record.completionReport;
    useStore.setState({ transcripts: { lead: [{ id: 'claim', kind: 'assistant', ts: 4, text: narrative }] } });
    const view = render(<Transcript session={session} />);
    expect(screen.queryByTestId('mission-completion-report')).toBeNull();
    view.unmount(); useStore.setState({ missions: { mission: completedRecord() } });
    render(<Transcript session={{ ...session, mission: { ...session.mission!, role: 'worker' } }} />);
    expect(screen.queryByTestId('mission-completion-report')).toBeNull();
  });
});
