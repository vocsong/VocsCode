/** @vitest-environment jsdom */
/** UI contracts only; the real coordinator/driver suites own execution and authorization claims. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { invokeMock, subscriptions, apiMode } = vi.hoisted(() => ({ invokeMock: vi.fn(), subscriptions: new Map<string, (value: unknown) => void>(), apiMode: { web: false, platform: 'win32' } }));
vi.mock('../src/renderer/src/api', () => ({ canInvoke: () => true, invoke: invokeMock, on: (channel: string, fn: (value: unknown) => void) => { subscriptions.set(channel, fn); return () => subscriptions.delete(channel); }, isMac: false, get isWeb() { return apiMode.web; }, get platform() { return apiMode.platform; }, modKey: 'Ctrl' }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSettings, SessionMeta, TranscriptItem } from '../src/shared/types';
import type { MissionAttempt, MissionRecord } from '../src/shared/mission';
import { createDefaultMissionConfig } from '../src/shared/mission-config';
import { missionRevisionConflictMessage } from '../src/shared/mission-errors';
import { Composer } from '../src/renderer/src/components/Composer';
import { Header } from '../src/renderer/src/components/Header';
import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';
import { SettingsView } from '../src/renderer/src/components/SettingsView';
import { MissionPanel, MissionHeaderControls, MissionUsage } from '../src/renderer/src/components/mission/MissionPanel';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { Sidebar, sidebarNavModel } from '../src/renderer/src/components/Sidebar';
import { CommandPalette } from '../src/renderer/src/components/CommandPalette';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { useStore } from '../src/renderer/src/store';
import { archiveSession } from '../src/renderer/src/sessionActions';
import { runShortcutCommand } from '../src/renderer/src/shortcuts';
import { commandMission } from '../src/renderer/src/missions';
// Renderer fixtures stay browser-only; never import a main-process delivery/runtime dependency.
function missionFixture(patch: Partial<MissionRecord> = {}): MissionRecord {
  const config = createDefaultMissionConfig();
  const leadPreset = { id: 'frontier', revision: 1, name: 'Principal engineer', harnessId: 'native' as const, model: { provider: 'fixture', model: 'frontier' }, reasoning: { kind: 'default' as const }, enabled: true };
  config.presets = [leadPreset]; config.tiers[4].presetIds = [leadPreset.id]; config.defaultLeadPresetId = leadPreset.id;
  return {
    schemaVersion: 1, id: 'mission', revision: 1, lastEventSequence: 1, title: 'Deliver a fixture', objective: 'Deliver a fixture', projectRoot: '/project', sourceCwd: '/project', sourceUserActionId: 'user-launch',
    leadSessionId: 'lead', leadGeneration: 1, leadPreset, config, configHistory: [], providerRestrictions: {}, entryMode: 'interactive_plan', phase: 'planning', status: 'running', requestedPermissionMode: 'ask',
    specificationRevision: 1, planRevision: 0, plan: { objective: 'Deliver a fixture', scope: 'Pending investigation', exclusions: [], behavior: 'Pending investigation', integrationPoints: [], verificationApproach: 'Pending investigation', criteria: [], assumptions: [] },
    questions: [], decisions: [], profiles: [], tasks: [], attempts: [], candidates: [], evidence: [], reviews: [], operations: [], mailbox: [], workspaces: [], blockers: [],
    deliveryPolicy: { endpoint: 'local_commit', checks: [], requireIndependentReview: true, allowPush: false, allowMerge: false, holdConditions: [], holdIsEndpoint: false, provenance: [], fallback: true, conflicts: [] },
    progress: { completedTurns: 0, checkpointsWithoutProgress: 0, lastProgressRevision: 0 }, createdAt: 1, updatedAt: 1, ...patch
  };
}

const ordinary = (id = 'source'): SessionMeta => ({ id, title: `Discussion ${id}`, createdAt: 1, updatedAt: 1, cwd: '/project', status: 'idle', config: { harness: 'native', projectRoot: '/project', permissionMode: 'ask' }, harnessRef: {}, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 } });
const owned = (role: 'lead' | 'worker', id = role): SessionMeta => ({ ...ordinary(id), title: role === 'lead' ? 'Mission lead' : 'Hidden specialist', cwd: `/workspaces/${role}`, mission: { missionId: 'mission', role, generation: 1, requestedTools: [], sourceAccess: 'assigned_workspace', reasoningDefault: true } });
const attempt = (record: MissionRecord): MissionAttempt => ({ id: 'attempt-one', taskId: 'task-one', taskRevision: 1, specificationRevision: 1, generation: 1, sessionId: 'worker', tierId: 3, preset: { ...record.leadPreset, name: 'Standard specialist' }, selectionReason: 'Bounded implementation', sourceRevision: { baseCommitSha: 'a'.repeat(40), contentHash: 'b'.repeat(64) }, workspaceId: 'worker-workspace', continuationOwner: 'mission', status: 'terminal', outcome: 'submitted', terminalTurnId: 'turn-worker', repairTurns: 0, requestedAt: 1, result: { taskId: 'task-one', taskRevision: 1, attemptId: 'attempt-one', specificationRevision: 1, status: 'candidate', summary: 'Candidate implementation ready; not integrated.', artifactIds: [], evidenceIds: [], decisionIds: [], unresolved: [] } });
let record: MissionRecord;
let settings: AppSettings;

beforeEach(() => {
  apiMode.web = false;
  apiMode.platform = 'win32';
  record = missionFixture({ originSessionId: 'source', planRevision: 2, specificationRevision: 3, status: 'awaiting_execution_approval', pendingProposal: { id: 'proposal-three', specificationRevision: 3, planRevision: 2, assistantMessageId: 'proposal-message', requestedAt: 1 } });
  settings = { folders: ['/project'], recentProjects: ['/project'], folderStyles: {}, collapsedFolders: [], defaultHarness: 'native', defaultPermissionMode: 'ask', defaultModelByHarness: {}, acpAgents: [], providers: [], mission: record.config, goalDefaults: {}, sidebarWidth: 250, panelWidth: 450 } as unknown as AppSettings;
  useStore.setState({ settings, sessions: [ordinary(), owned('lead'), owned('worker')], missions: { mission: record }, missionErrors: {}, missionInspector: null, activeId: 'source', transcripts: {}, loaded: {}, transcriptErrors: {}, drafts: {}, composerHistory: {}, composerInsert: null, modelCatalog: { native: { models: [], loading: false } }, models: {}, panelTab: 'goal', panelBottomTab: 'mcp', panelBottomOpened: [], newSessionKind: 'normal', newSessionRoot: '/project', newMissionSourceId: null, toasts: [], archiving: {}, history: [], historyIndex: -1 });
  invokeMock.mockReset().mockImplementation(async (channel: string, input?: { id?: string; control?: { action: string } }) => {
    if (channel === 'missions:get') return record;
    if (channel === 'missions:list') return [record];
    if (channel === 'missions:control') return { ...record, revision: record.revision + 1, status: input?.control?.action === 'execute' ? 'running' : 'paused' };
    if (channel === 'missions:create') return record;
    if (channel === 'sessions:get') return useStore.getState().sessions.find((session) => session.id === input?.id) ?? null;
    if (channel === 'sessions:transcript') return [];
    if (channel === 'harness:models') return { models: [] };
    if (channel === 'git:folderIsRepo') return { isRepo: true };
    if (channel === 'git:summary') return { isRepo: true, files: [] };
    if (channel === 'git:folderBranch') return {};
    if (channel === 'git:diff') return { diff: '' };
    if (channel === 'fs:list' || channel === 'fs:search') return [];
    return {};
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  if (!globalThis.CSS) vi.stubGlobal('CSS', { escape: (text: string) => text });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function submit(text: string) {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('Mission composer boundary', () => {
  it('offers genuine read-only completed questions, separate honest usage, and only explicit linked implementation', async () => {
    record = { ...record, status: 'completed', pendingProposal: undefined, operations: [{ id: 'answer', idempotencyKey: 'answer', actor: 'host', expectedRevision: 0, kind: 'dispatch', state: 'succeeded', payload: { questionId: 'question', dispatchStartedAt: 1, answerUsage: { tokens: 75, costUsd: 0 } } }] };
    useStore.setState({ missions: { mission: record } });
    render(<Composer session={owned('lead')} />);
    expect(screen.getByPlaceholderText(/Ask about the completed Mission/)).toBeTruthy();
    expect(screen.getByTestId('mission-question-scope').textContent).toContain('Aggregate Mission limits still apply');
    expect(screen.getByTestId('mission-question-usage').textContent).toContain('75 observed tokens');
    expect(screen.getByTestId('mission-question-usage').textContent).toContain('partial/unknown telemetry');
    submit('Which checks ran and what did they show?');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:send', expect.objectContaining({ id: 'lead', idempotencyKey: expect.any(String), input: { text: 'Which checks ran and what did they show?', mode: 'now' } })));
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'missions:create' || channel === 'missions:command' || channel === 'missions:control')).toBe(false);
    invokeMock.mockClear();
    submit('Implement another feature');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:send', expect.objectContaining({ input: { text: 'Implement another feature', mode: 'now' } })));
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'missions:create' || channel === 'missions:command')).toBe(false);
    invokeMock.mockClear();
    submit('!npm test'); expect(invokeMock).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    expect(useStore.getState().toasts.at(-1)?.text).toContain('cannot run shell commands');
    expect(useStore.getState().missions.mission).toEqual(record);
  });

  it('keeps cancellation available for a completed answer even while queued or in uncertain teardown', async () => {
    record = { ...record, status: 'completed', pendingProposal: undefined, operations: [{ id: 'answer', idempotencyKey: 'answer', actor: 'host', expectedRevision: 0, kind: 'dispatch', state: 'reconciling', payload: { questionId: 'question' } }] };
    useStore.setState({ missions: { mission: record } });
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((channel, input) => channel === 'missions:control' ? Promise.resolve(record) : original(channel, input));
    render(<Composer session={owned('lead')} />);
    submit('Do not send another');
    expect(invokeMock).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Ask lead' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel answer' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('missions:control', expect.objectContaining({ missionId: 'mission', control: { action: 'pause' } })));
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'sessions:interrupt' || channel === 'sessions:stop' || channel === 'sessions:send')).toBe(false);
    expect(useStore.getState().missions.mission.status).toBe('completed');
  });

  it('retains command image drafts after rejection, then retries the exact input/key and clears only after acceptance', async () => {
    const source = ordinary('image-command-retry');
    const original = invokeMock.getMockImplementation()!;
    let fail = true;
    invokeMock.mockImplementation((channel, input) => channel === 'missions:command'
      ? fail ? Promise.reject(new Error('Lost command reply')) : Promise.resolve({ kind: 'created', mission: record })
      : original(channel, input));
    render(<Composer session={source} />);
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['exact pixels'], 'command.png', { type: 'image/png' })] } });
    await screen.findByAltText('command.png');
    submit('  /mission plan Match this image  ');
    await waitFor(() => expect(useStore.getState().toasts.at(-1)?.text).toContain('Lost command reply'));
    const first = invokeMock.mock.calls.find(([channel]) => channel === 'missions:command')![1];
    expect(first).toMatchObject({ sessionId: source.id, text: '  /mission plan Match this image  ', images: [{ name: 'command.png', mimeType: 'image/png', data: btoa('exact pixels') }], idempotencyKey: expect.any(String) });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(first.text);
    expect(screen.getByAltText('command.png')).toBeTruthy();
    fail = false;
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''));
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'missions:command').map(([, input]) => input)).toEqual([first, first]);
    expect(screen.queryByAltText('command.png')).toBeNull();
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'sessions:send')).toBe(false);
  });

  it('does not discard text or images added while a command acknowledgment is pending', async () => {
    let accept!: (reply: { kind: string }) => void;
    invokeMock.mockImplementation(() => new Promise((resolve) => { accept = resolve; }));
    render(<Composer session={ordinary('pending-image-command')} />);
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['first'], 'first.png', { type: 'image/png' })] } });
    await screen.findByAltText('first.png');
    submit('/mission Inspect the first image');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this next draft' } });
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['next'], 'next.png', { type: 'image/png' })] } });
    await screen.findByAltText('next.png');
    await act(async () => accept({ kind: 'updated' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep this next draft');
    expect(screen.getByAltText('next.png')).toBeTruthy(); expect(screen.queryByAltText('first.png')).toBeNull();
    expect(useStore.getState().drafts['pending-image-command']).toBe('Keep this next draft');
  });

  it('binds command retry identity to a captured ordered image payload, not mutable caller data or just the text', async () => {
    const source = ordinary('image-command-hook');
    const images = [{ mimeType: 'image/png', data: 'b25l', name: 'one.png' }];
    invokeMock.mockRejectedValueOnce(new Error('Uncertain command reply'));
    const failed = commandMission(source, '/mission Inspect visual evidence', images);
    images[0].data = 'dHdv';
    await expect(failed).rejects.toThrow('Uncertain command reply');
    const first = invokeMock.mock.calls.find(([channel]) => channel === 'missions:command')![1];
    expect(first.images).toEqual([{ mimeType: 'image/png', data: 'b25l', name: 'one.png' }]);
    invokeMock.mockResolvedValue({ kind: 'status' });
    await commandMission(source, first.text, [{ ...first.images[0] }]);
    const retried = invokeMock.mock.calls.filter(([channel]) => channel === 'missions:command')[1][1];
    expect(retried).toEqual(first);
    await commandMission(source, first.text, images);
    const changed = invokeMock.mock.calls.filter(([channel]) => channel === 'missions:command')[2][1];
    expect(changed.images).toEqual(images); expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('keeps a bare Mission command and images visible when its dialog boundary refuses attachments', async () => {
    invokeMock.mockRejectedValue(new Error('Mission controls cannot take images. Add an objective to /mission.'));
    render(<Composer session={ordinary('bare-image-command')} />);
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [new File(['pixels'], 'draft.png', { type: 'image/png' })] } });
    await screen.findByAltText('draft.png');
    submit('/mission');
    await waitFor(() => expect(useStore.getState().toasts.at(-1)?.text).toContain('cannot take images'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('/mission');
    expect(screen.getByAltText('draft.png')).toBeTruthy();
    expect(useStore.getState().newSessionKind).toBe('normal');
    expect(invokeMock).toHaveBeenCalledWith('missions:command', expect.objectContaining({ images: [{ mimeType: 'image/png', data: btoa('pixels'), name: 'draft.png' }] }));
  });

  it('retries a genuine Mission message with the original request key after a lost reply, including a remount', async () => {
    const lead = { ...owned('lead'), id: 'message-retry-lead' };
    const original = invokeMock.getMockImplementation()!;
    let fail = true;
    invokeMock.mockImplementation((channel, input) => channel === 'sessions:send'
      ? fail ? Promise.reject(new Error('Lost reply after mailbox commit')) : Promise.resolve(undefined)
      : original(channel, input));
    const ui = render(<Composer session={lead} />);
    submit('Keep the corrected visual requirement');
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep the corrected visual requirement'));
    const first = invokeMock.mock.calls.find(([channel]) => channel === 'sessions:send')![1];
    expect(first).toMatchObject({ id: lead.id, idempotencyKey: expect.any(String) });
    ui.unmount(); fail = false;
    render(<Composer session={lead} />);
    submit('Keep the corrected visual requirement');
    await waitFor(() => expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:send')).toHaveLength(2));
    const second = invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:send')[1][1];
    expect(second).toEqual(first);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''));
    submit('Keep the corrected visual requirement');
    await waitFor(() => expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:send')).toHaveLength(3));
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:send')[2][1].idempotencyKey).not.toBe(first.idempotencyKey);
  });
  it('parses exactly before native forwarding; duplicate submissions and a network retry share the launch key', async () => {
    let reject!: (error: Error) => void;
    invokeMock.mockImplementation((channel: string) => channel === 'missions:command' ? new Promise((_resolve, no) => { reject = no; }) : Promise.resolve([]));
    render(<Composer session={{ ...ordinary(), nativeGoal: 'mission' }} />);
    submit('/mission build a bounded feature');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const first = invokeMock.mock.calls[0][1];
    expect(first).toMatchObject({ sessionId: 'source', text: '/mission build a bounded feature', idempotencyKey: expect.any(String) });
    await act(async () => reject(new Error('Network disconnected before reply')));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('/mission build a bounded feature');
    invokeMock.mockResolvedValue({ kind: 'created', mission: record, sessionId: 'lead' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(useStore.getState().activeId).toBe('lead'));
    const requests = invokeMock.mock.calls.filter(([channel]) => channel === 'missions:command');
    expect(requests).toHaveLength(2);
    expect(requests[1][1]).toEqual(first);
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'sessions:send' || channel === 'settings:update')).toBe(false);
    expect(useStore.getState().sessions.find((session) => session.id === 'source')).toEqual(ordinary());
  });

  it('leaves unrelated slash tokens as ordinary messages and rejects ambiguous Mission controls', async () => {
    render(<Composer session={ordinary()} />);
    submit('/missionary explain this');
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:send', expect.objectContaining({ input: expect.objectContaining({ text: '/missionary explain this' }) })));
    invokeMock.mockClear();
    submit('/mission pause now');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.text).toContain('does not take arguments');
  });

  it('prevents a second goal loop and pinned model edits inside Mission; workers never get a composer', () => {
    const ui = render(<Composer session={{ ...owned('lead'), nativeGoal: 'goal' }} />);
    submit('/goal implement it');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.text).toContain('Mission already owns execution');
    submit('/model openai/other');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.text).toContain('pinned T5');
    ui.unmount();
    render(<Composer session={owned('worker')} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });

  it('says no Mission is linked when /mission status runs in a session without one', async () => {
    invokeMock.mockResolvedValue({ kind: 'status' });
    render(<Composer session={ordinary()} />);
    submit('/mission status');
    await waitFor(() => expect(useStore.getState().toasts.at(-1)?.text).toBe('No Mission is linked to this session.'));
    expect(useStore.getState().newSessionKind).toBe('normal');
    expect(useStore.getState().activeId).toBe('source');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('opens bare Mission creation without changing the discussion configuration', async () => {
    invokeMock.mockResolvedValue({ kind: 'show' });
    render(<Composer session={ordinary()} />);
    submit('/mission');
    await waitFor(() => expect(useStore.getState().newSessionKind).toBe('mission'));
    expect(useStore.getState().newMissionSourceId).toBe('source');
    expect(useStore.getState().settings).toBe(settings);
  });
});

describe('Mission launch and controls', () => {
  it.each(['local_commit', 'open_pr'] as const)('uses explicit genuine-user control to narrow merge delivery to %s and retains its visible ceiling', async (endpoint) => {
    record = { ...record, status: 'running', pendingProposal: undefined, deliveryPolicy: { ...record.deliveryPolicy, endpoint: 'merge_pr', allowPush: true, allowMerge: true, fallback: false, holdConditions: ['Human review remains required'] } };
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel !== 'missions:control') return original(channel, input);
      record = { ...record, revision: record.revision + 1, status: 'paused', deliveryPolicy: { ...record.deliveryPolicy, endpoint, allowMerge: false, allowPush: endpoint !== 'local_commit' },
        publicationRestrictions: [{ endpoint, previousEndpoint: 'merge_pr', sourceUserActionId: 'user-limit', receivedRevision: input.expectedRevision, recordedAt: 2, priorRemoteOperationIds: ['old-delivery'] }] };
      return record;
    });
    useStore.setState({ missions: { mission: record } });
    render(<MissionPanel session={owned('lead')} />);
    await screen.findByRole('button', { name: 'Keep Mission local' });
    const revision = record.revision;
    fireEvent.click(screen.getByRole('button', { name: endpoint === 'local_commit' ? 'Keep Mission local' : 'Open PR only' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('missions:control', { missionId: 'mission', expectedRevision: revision, idempotencyKey: expect.any(String), control: { action: 'narrow_delivery', endpoint } }));
    await screen.findByText(/User publication limit:/);
    expect(screen.getByText('Human review remains required')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('may already have published');
    expect(screen.queryByRole('button', { name: 'Open PR only' })).toBeNull();
    expect(!!screen.queryByRole('button', { name: 'Keep Mission local' })).toBe(endpoint === 'open_pr');
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'sessions:send' || channel === 'settings:update')).toBe(false);
  });

  it('offers normal/Mission, Plan together/Autonomous and only enabled T5 presets without changing source settings', async () => {
    const lower = { ...record.leadPreset, id: 'routine', name: 'Lower-tier discussion' };
    settings.mission = { ...record.config, presets: [...record.config.presets, lower], tiers: record.config.tiers.map((tier) => tier.id === 1 ? { ...tier, presetIds: ['routine'] } : tier) };
    useStore.setState({ settings });
    render(<NewSessionDialog />);
    expect(screen.getByRole('button', { name: 'Normal session' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mission' }));
    expect(screen.getByRole('option', { name: 'Autonomous' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Lower-tier/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Mission mode'), { target: { value: 'interactive_plan' } });
    fireEvent.change(screen.getByLabelText('Mission objective'), { target: { value: 'Plan a migration' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start Mission' }));
    await waitFor(() => expect(useStore.getState().activeId).toBe('lead'));
    expect(invokeMock).toHaveBeenCalledWith('missions:create', expect.objectContaining({ mode: 'interactive_plan', objective: 'Plan a migration', leadPresetId: undefined, permissionMode: 'ask' }));
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'settings:update' || channel === 'sessions:create')).toBe(false);
  });

  it('keeps a blocked launch visible when no lead exists, and retries the same host creation', async () => {
    record = { ...record, status: 'blocked', blockers: [{ id: 'launch-blocker', kind: 'environment', message: 'The managed workspace could not be provisioned.' }] };
    useStore.setState({ sessions: [ordinary()], missions: {}, newSessionOpen: true, newSessionKind: 'mission', newMissionSourceId: 'source' });
    render(<NewSessionDialog />);
    fireEvent.change(screen.getByLabelText('Mission objective'), { target: { value: 'Recover the blocked launch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start Mission' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The managed workspace could not be provisioned.');
    expect(useStore.getState().activeId).toBe('source');
    expect(useStore.getState().newSessionOpen).toBe(true);
    expect(useStore.getState().sessions).toEqual([ordinary()]);
    expect(useStore.getState().missions.mission.status).toBe('blocked');
    expect(invokeMock.mock.calls.some(([channel, input]) => channel === 'sessions:transcript' && input.id === 'lead')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Start Mission' }));
    await screen.findByRole('alert');
    const previous = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel, input) => channel === 'sessions:get' ? owned('lead') : previous(channel, input));
    fireEvent.click(screen.getByRole('button', { name: 'Start Mission' }));
    await waitFor(() => expect(useStore.getState().activeId).toBe('lead'));
    const launches = invokeMock.mock.calls.filter(([channel]) => channel === 'missions:create');
    expect(launches).toHaveLength(3);
    expect(launches[1][1]).toEqual(launches[0][1]);
    expect(launches[2][1]).toEqual(launches[0][1]);
    expect(useStore.getState().sessions).toEqual([ordinary(), owned('lead')]);
    expect(useStore.getState().newSessionOpen).toBe(false);
  });

  it('never invents a lead for an unconfigured launch and links to the Mission settings tab', () => {
    useStore.setState({ settings: { ...settings, mission: createDefaultMissionConfig() }, newSessionKind: 'mission' });
    const ui = render(<NewSessionDialog />);
    expect(screen.getByRole('alert').textContent).toContain('No lower-tier fallback');
    expect((screen.getByRole('button', { name: 'Start Mission' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Configure Mission' }));
    expect(useStore.getState().view).toBe('settings');
    ui.unmount();
    render(<SettingsView />);
    expect(screen.getByRole('heading', { name: 'Mission', level: 2 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New preset' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mission' }).className).toContain('active');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('states the Mission support boundary and flags a principal engineer that cannot run one', () => {
    useStore.setState({ newSessionKind: 'mission' });
    const ui = render(<NewSessionDialog />);
    expect(screen.getByTestId('mission-support').textContent).toBe('Missions are experimental. Supported today: Pi presets on Windows.');
    expect(screen.getByRole('option', { name: 'Project default · Principal engineer · not supported for Missions yet' })).toBeTruthy();
    expect(screen.getByText(/Native loop presets are not supported for Missions yet\. A Mission that uses one stops at a blocker before any work; choose a Pi preset\./)).toBeTruthy();
    ui.unmount();
    const pi = { ...record.leadPreset, harnessId: 'pi' as const };
    settings.mission = { ...record.config, presets: [pi] };
    useStore.setState({ settings: { ...settings } });
    apiMode.platform = 'darwin';
    render(<NewSessionDialog />);
    expect(screen.getByTestId('mission-support').textContent).toBe('Missions are experimental. Supported today: Pi presets on Windows. Missions cannot run on this platform yet.');
    expect(screen.getByRole('option', { name: 'Project default · Principal engineer' })).toBeTruthy();
    expect(screen.queryByText(/not supported for Missions yet/)).toBeNull();
  });

  it('binds Proceed to the pending proposal/revision and renders plan questions, not a competing Goal', async () => {
    record = { ...record, questions: [{ id: 'q1', text: 'Keep the existing API?', answer: 'Yes, preserve it.' }] };
    useStore.setState({ missions: { mission: record } });
    render(<MissionPanel session={owned('lead')} />);
    expect(screen.getByText('Yes, preserve it.')).toBeTruthy();
    expect(screen.queryByText('Set goal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Proceed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Proceed' }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([channel]) => channel === 'missions:control')).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith('missions:control', { missionId: 'mission', idempotencyKey: expect.any(String), expectedRevision: 1, control: { action: 'execute', proposalId: 'proposal-three', specificationRevision: 3 } });
  });

  it('disables stale proposals and offers T5 handover instead of model/effort controls', async () => {
    record = { ...record, specificationRevision: 4 };
    useStore.setState({ missions: { mission: record } });
    render(<><Header session={owned('lead')} /><MissionPanel session={owned('lead')} /></>);
    expect((screen.getByRole('button', { name: 'Proceed' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTitle('Model')).toBeNull();
    expect(screen.queryByTitle('Reasoning effort')).toBeNull();
    expect(screen.getByTestId('mission-header').textContent).toContain('T5 principal engineer: Principal engineer');
    expect((screen.getByRole('button', { name: 'Replace lead' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Clean up retained worktrees' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('missions:get', { missionId: 'mission' }));
  });

  it.each(['definitive CAS rejection', 'uncertain lost reply'])('retries a user control correctly after %s and a newer record', async (failure) => {
    record = { ...record, status: 'running', id: `retry-${failure === 'uncertain lost reply' ? 'uncertain' : 'definite'}` };
    invokeMock.mockRejectedValueOnce(new Error(failure === 'definitive CAS rejection'
      ? `Error invoking remote method 'missions:control': Error: [MISSION_REVISION_CONFLICT] Expected revision ${record.revision}; current revision is ${record.revision + 1}`
      : 'Network disconnected before reply'));
    const ui = render(<MissionHeaderControls record={record} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause Mission' }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([channel]) => channel === 'missions:control')).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Pause Mission' }) as HTMLButtonElement).disabled).toBe(false));
    const first = invokeMock.mock.calls.find(([channel]) => channel === 'missions:control')![1];
    record = { ...record, revision: record.revision + 1 };
    ui.rerender(<MissionHeaderControls record={record} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause Mission' }));
    await waitFor(() => expect(invokeMock.mock.calls.filter(([channel]) => channel === 'missions:control')).toHaveLength(2));
    const second = invokeMock.mock.calls.filter(([channel]) => channel === 'missions:control')[1][1];
    if (failure === 'definitive CAS rejection') {
      expect(second.expectedRevision).toBe(record.revision); expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    } else expect(second).toEqual(first);
    await waitFor(() => expect(useStore.getState().missions[record.id]?.status).toBe('paused'));
  });

  it('binds the next Pause to the current record after the host refuses a stale revision, without a reload', async () => {
    const host = { ...record, status: 'running' as const, pendingProposal: undefined, revision: 2 };
    record = { ...host, revision: 1 }; // another client advanced the Mission; this window missed the push
    useStore.setState({ missions: { mission: record } });
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel: string, input: { expectedRevision?: number }) => {
      if (channel === 'missions:get') return host;
      if (channel !== 'missions:control') return original(channel, input);
      if (input.expectedRevision !== host.revision) throw new Error(`Error invoking remote method 'missions:control': Error: ${missionRevisionConflictMessage(input.expectedRevision!, host.revision)}`);
      return { ...host, revision: host.revision + 1, status: 'paused' };
    });
    function LiveHeader() {
      const current = useStore((s) => s.missions.mission);
      return <MissionHeaderControls record={current} />;
    }
    render(<LiveHeader />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause Mission' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The Mission changed before this action was applied, so nothing was done.');
    expect(useStore.getState().missions.mission.revision).toBe(2);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Pause Mission' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Pause Mission' }));
    await waitFor(() => expect(useStore.getState().missions.mission.status).toBe('paused'));
    const controls = invokeMock.mock.calls.filter(([channel]) => channel === 'missions:control').map(([, input]) => input);
    expect(controls.map((input) => input.expectedRevision)).toEqual([1, 2]);
    expect(controls[1].idempotencyKey).not.toBe(controls[0].idempotencyKey);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failure classification as its category and message, not an object dump', () => {
    // The host's missionFailureNotice format: typed JSON for the lead, then the recovery guidance.
    const failure = { kind: 'protocol', code: 'runtime_protocol', source: 'dispatch', confidence: 'heuristic', recovery: 'lead_diagnosis', message: 'Heuristic diagnosis, not a proven root cause. This adapter has not certified the Mission control protocol.' };
    record = { ...record, status: 'blocked', pendingProposal: undefined, blockers: [
      { id: 'lead_dispatch_1', kind: 'protocol', message: `The principal engineer failed. Failure classification: ${JSON.stringify(failure)}\nThe lead must diagnose retained facts and choose a concrete bounded approach before requesting another attempt. No preset, account, permission or retry policy was changed. Pause/reconcile and explicitly resume.` },
      { id: 'workspace', kind: 'environment', message: 'The managed workspace could not be provisioned.' }
    ] };
    useStore.setState({ missions: { mission: record } });
    render(<MissionPanel session={owned('lead')} />);
    const blockers = screen.getAllByText(/./, { selector: '.callout.warn' }).map((node) => node.textContent);
    expect(blockers).toEqual([
      'The principal engineer failed. Runtime protocol failure: Heuristic diagnosis, not a proven root cause. This adapter has not certified the Mission control protocol.\nThe lead must diagnose retained facts and choose a concrete bounded approach before requesting another attempt. No preset, account, permission or retry policy was changed. Pause/reconcile and explicitly resume.',
      'Environment: The managed workspace could not be provisioned.'
    ]);
    expect(screen.getByTestId('mission-panel').textContent).not.toMatch(/Failure classification|\{"kind"/);
  });

  it('keeps Resume disabled until paused and waits for the planning turn to settle before Proceed', () => {
    useStore.setState({ sessions: [ordinary(), { ...owned('lead'), status: 'running' }] });
    render(<><MissionHeaderControls record={{ ...record, status: 'blocked' }} /><MissionPanel session={owned('lead')} /></>);
    expect((screen.getByRole('button', { name: 'Resume Mission' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Proceed' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useStore.getState().setSessions([ordinary(), owned('lead')]));
    expect((screen.getByRole('button', { name: 'Proceed' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('exposes cleanup only while quiescent and archives without remove/force flags', async () => {
    render(<MissionHeaderControls record={{ ...record, status: 'paused' }} />);
    expect((screen.getByRole('button', { name: 'Clean up retained worktrees' }) as HTMLButtonElement).disabled).toBe(false);
    await archiveSession({ ...owned('lead'), worktreeBranch: 'mission/lead' }, useStore.getState().toast);
    expect(invokeMock).toHaveBeenCalledWith('sessions:archive', { id: 'lead', archived: true });
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:archive')).toHaveLength(1);
  });
});

describe('Mission plan export', () => {
  it('offers a discoverable export for archived plans, fetching host state at click time rather than the displayed revision', async () => {
    record = { ...record, archived: true, status: 'paused' };
    useStore.setState({ missions: { mission: record } });
    const original = invokeMock.getMockImplementation()!;
    let release!: (value: { markdown: string; suggestedName: string }) => void;
    const markdown = '# Latest authoritative revision, newer than this panel';
    invokeMock.mockImplementation((channel, input) => {
      if (channel === 'missions:exportPlan') return new Promise((resolve) => { release = resolve; });
      if (channel === 'app:fileSaveAs') return Promise.resolve({ path: '/chosen/plan.md' });
      return original(channel, input);
    });
    render(<MissionPanel session={owned('lead')} />);
    const button = screen.getByRole('button', { name: 'Export plan.md' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'missions:exportPlan' || channel === 'app:fileSaveAs')).toBe(false);
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([channel]) => channel === 'missions:exportPlan')).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith('missions:exportPlan', { missionId: 'mission' });
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'app:fileSaveAs')).toBe(false);
    await act(async () => release({ markdown, suggestedName: 'plan.md' }));
    await screen.findByText('Plan exported. Editing it does not change the Mission.');
    expect(invokeMock).toHaveBeenCalledWith('app:fileSaveAs', { content: markdown, suggestedName: 'plan.md' });
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'app:fileSaveAs')).toHaveLength(1);
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'missions:control' || channel === 'sessions:send')).toBe(false);
  });

  it('reports cancellation and a save failure without inventing success, and fetches fresh text on each retry', async () => {
    const original = invokeMock.getMockImplementation()!;
    let saves = 0;
    invokeMock.mockImplementation((channel, input) => {
      if (channel === 'missions:exportPlan') return Promise.resolve({ markdown: `# Revision ${saves}`, suggestedName: 'plan.md' });
      if (channel === 'app:fileSaveAs') return ++saves === 1 ? Promise.resolve({ path: null }) : Promise.reject(new Error('Mission owns this workspace. Choose another destination.'));
      return original(channel, input);
    });
    render(<MissionPanel session={owned('lead')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export plan.md' }));
    await screen.findByText('Plan export canceled.');
    expect(screen.queryByText('Plan exported. Editing it does not change the Mission.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export plan.md' }));
    await screen.findByText('Mission owns this workspace. Choose another destination.');
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'missions:exportPlan')).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'app:fileSaveAs').map(([, request]) => request.content)).toEqual(['# Revision 0', '# Revision 1']);
    expect(screen.queryByText('Plan exported. Editing it does not change the Mission.')).toBeNull();
  });

  it('surfaces read failures without opening a chooser and clearly refuses desktop Save As in a browser', async () => {
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((channel, input) => channel === 'missions:exportPlan' ? Promise.reject(new Error('Mission not found.')) : original(channel, input));
    const ui = render(<MissionPanel session={owned('lead')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export plan.md' }));
    await screen.findByText('Mission not found.');
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'app:fileSaveAs')).toBe(false);
    ui.unmount(); apiMode.web = true; invokeMock.mockClear();
    render(<MissionPanel session={owned('lead')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export plan.md' }));
    await screen.findByText('Plan export requires the desktop Save As dialog. Open this Mission in the desktop app.');
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'missions:exportPlan' || channel === 'app:fileSaveAs')).toBe(false);
  });
});

describe('Mission navigation, inspection and workspace safety', () => {
  it('hides workers from sidebar, archived rows, keyboard model, command palette and archive replacement', async () => {
    const ui = render(<Sidebar />);
    expect(screen.queryByText('Hidden specialist')).toBeNull();
    expect(screen.getByText('Mission')).toBeTruthy();
    expect(sidebarNavModel(useStore.getState().sessions, settings).flatMap((folder) => folder.sessionIds)).not.toContain('worker');
    ui.unmount();
    render(<CommandPalette />);
    expect(screen.queryByText('Hidden specialist')).toBeNull();
    useStore.setState({ activeId: 'lead' });
    await act(async () => useStore.getState().setSessions([owned('worker'), { ...owned('lead'), archived: true }, ordinary()]));
    expect(useStore.getState().activeId).toBe('source');
  });

  it('routes worker search/direct navigation to the lead read-only inspector and Ask lead fills only that composer', async () => {
    record.attempts = [attempt(record)];
    useStore.setState({ missions: { mission: record }, transcripts: { worker: [{ id: 'worker-answer', kind: 'assistant', ts: 1, text: 'Specialist finding' }] }, loaded: { worker: true, lead: true } });
    await act(async () => useStore.getState().jumpToSearchMatch('worker', 'worker-answer'));
    expect(useStore.getState().activeId).toBe('lead');
    render(<><Composer session={owned('lead')} /><MissionPanel session={owned('lead')} /></>);
    const inspector = screen.getByTestId('mission-inspector');
    expect(within(inspector).getByText('Specialist finding')).toBeTruthy();
    expect(within(inspector).queryByRole('textbox')).toBeNull();
    expect(within(inspector).queryByText('Retry')).toBeNull();
    fireEvent.click(within(inspector).getByRole('button', { name: 'Ask lead about this' }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('task task-one, attempt attempt-one'));
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'sessions:send')).toBe(false);
    fireEvent.click(within(inspector).getByRole('button', { name: 'Result' }));
    expect(within(inspector).getByText('Candidate implementation ready; not integrated.')).toBeTruthy();
  });

  it('labels accepted Mission result separately, reads explicit lead workspaces and offers no Commit/Revert/native subagents', async () => {
    const base = { baseCommitSha: 'a'.repeat(40), contentHash: 'b'.repeat(64) };
    record.workspaces = [{ id: 'integration-workspace', role: 'integration', path: '/integration', branch: 'result', base }, { id: 'lead-workspace', role: 'lead', path: '/workspaces/lead', branch: 'lead', ownerSessionId: 'lead', base }];
    useStore.setState({ missions: { mission: record }, panelTab: 'changes' });
    render(<RightPanel session={owned('lead')} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('git:diff', { sessionId: 'lead', missionWorkspaceId: undefined }));
    expect(screen.getByTestId('mission-changes').textContent).toContain('Mission result');
    expect(screen.queryByTestId('panel-bottom-subagents')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Commit all' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Mission workspace'), { target: { value: 'lead-workspace' } });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('git:diff', { sessionId: 'lead', missionWorkspaceId: 'lead-workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('fs:list', { sessionId: 'lead', relPath: undefined, missionWorkspaceId: 'lead-workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mission result' }));
    await waitFor(() => expect((screen.getByLabelText('Mission workspace') as HTMLSelectElement).value).toBe(''));
    expect(screen.getByTestId('mission-changes').textContent).toContain('Mission result');
  });

  it('disables generic fork and rewind while leaving ordinary session messages editable', () => {
    useStore.setState({ activeId: 'lead', loaded: { lead: true }, transcripts: { lead: [{ id: 'message', kind: 'user', ts: 1, text: 'Mission input' }] } });
    render(<Transcript session={owned('lead')} />);
    expect((screen.getByRole('button', { name: 'Rewind unavailable for Mission' }) as HTMLButtonElement).disabled).toBe(true);
    runShortcutCommand('session.fork');
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'sessions:fork')).toBe(false);
    expect(useStore.getState().toasts.at(-1)?.text).toContain('Mission owns execution');
  });

  it('shows worker permission cards in the lead panel without exposing worker questions or chat', async () => {
    const live = { ...attempt(record), status: 'running' as const, outcome: undefined, result: undefined };
    record = { ...record, attempts: [live] };
    const approval = (kind: 'permission' | 'command' | 'file_change' | 'question'): Extract<TranscriptItem, { kind: 'approval' }> => ({ id: `approval-${kind}`, kind: 'approval', ts: 1,
      request: { id: `approval-${kind}`, sessionId: 'worker', harness: 'native', kind, title: `Worker ${kind} request`, createdAt: 1, options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }] } });
    useStore.setState({ missions: { mission: record }, transcripts: { worker: ['permission', 'command', 'file_change', 'question'].map((kind) => approval(kind as Parameters<typeof approval>[0])) }, loaded: { worker: true } });
    render(<MissionPanel session={owned('lead')} />);
    const cards = screen.getByTestId('mission-worker-approvals');
    expect(within(cards).queryByText('Worker question request')).toBeNull();
    expect(within(cards).getAllByRole('button', { name: 'Allow once' })).toHaveLength(3);
    fireEvent.click(within(cards).getAllByRole('button', { name: 'Allow once' })[0]);
    expect(invokeMock).toHaveBeenCalledWith('approvals:respond', { sessionId: 'worker', requestId: 'approval-permission', decision: { optionId: 'allow-once', note: undefined } });
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'sessions:send')).toBe(false);
    act(() => useStore.getState().applyEvent({ sessionId: 'worker', ts: 1, event: { type: 'approval.resolved', requestId: 'approval-permission', decision: { optionId: 'allow-once' } } }));
    expect(within(cards).getAllByRole('button', { name: 'Allow once' })).toHaveLength(2);
  });

  it('shows bidirectional source links and honest partial Mission usage without changing the lead ledger', async () => {
    const worker = owned('worker');
    useStore.setState({ sessions: [ordinary(), owned('lead'), { ...worker, usage: { ...worker.usage, costUsd: 1.25, turns: 2 } }], loaded: { source: true, lead: true }, drafts: { source: 'Keep my discussion draft' } });
    const ui = render(<Header session={ordinary()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mission: Deliver a fixture' }));
    await waitFor(() => expect(useStore.getState().activeId).toBe('lead'));
    ui.unmount();
    render(<><Header session={owned('lead')} /><MissionPanel session={owned('lead')} /></>);
    await screen.findByText(/Billing coverage: partial/);
    expect(screen.getByTestId('mission-usage').textContent).toContain('$1.25');
    expect(screen.getByTestId('mission-usage').textContent).toContain('not a complete billing total');
    expect(useStore.getState().sessions.find((s) => s.id === 'lead')?.usage.costUsd).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Source discussion: Discussion source' }));
    await waitFor(() => expect(useStore.getState().activeId).toBe('source'));
    expect(useStore.getState().drafts.source).toBe('Keep my discussion draft');
  });

  it('shows unknown usage when Mission-owned ledgers are not available instead of inventing zero cost', () => {
    useStore.setState({ sessions: [ordinary()] });
    render(<MissionUsage record={record} />);
    expect(screen.getByTestId('mission-usage').textContent).toContain('Billing coverage: unknown');
    expect(screen.getByTestId('mission-usage').textContent).toContain('Reported cost unknown');
    expect(screen.getByTestId('mission-usage').textContent).not.toContain('$0');
  });

  it('keeps archived Mission views read-only and coalesces repeated archive clicks', async () => {
    record = { ...record, archived: true, status: 'paused' };
    useStore.setState({ missions: { mission: record } });
    const ui = render(<><MissionHeaderControls record={record} /><MissionPanel session={owned('lead')} /><Composer session={{ ...owned('lead'), archived: true }} /></>);
    expect(screen.queryByRole('textbox')).toBeNull();
    for (const name of ['Pause Mission', 'Resume Mission', 'Stop Mission', 'Apply updated configuration', 'Clean up retained worktrees']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    ui.unmount();
    record = { ...record, archived: false };
    let finish!: () => void;
    invokeMock.mockImplementation((channel) => channel === 'sessions:archive' ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve(record));
    const first = archiveSession(owned('lead'), useStore.getState().toast);
    const duplicate = archiveSession(owned('lead'), useStore.getState().toast);
    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:archive')).toHaveLength(1);
    finish();
    await Promise.all([first, duplicate]);
    expect(useStore.getState().archiving.lead).toBeUndefined();
  });

  it('ordinary sessions retain app Goal, native subagents, model controls, editable prompts and normal creation', async () => {
    useStore.setState({ panelTab: 'goal', activeId: 'source', loaded: { source: true }, transcripts: { source: [{ id: 'normal-message', kind: 'user', ts: 1, text: 'Normal prompt' }] } });
    const ui = render(<><Header session={ordinary()} /><RightPanel session={ordinary()} /><Transcript session={ordinary()} /></>);
    expect(screen.getByRole('button', { name: 'Set goal' })).toBeTruthy();
    expect(screen.getByTestId('panel-bottom-subagents')).toBeTruthy();
    expect(screen.getByTitle('Model')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Edit and rerun message' }) as HTMLButtonElement).disabled).toBe(false);
    ui.unmount();
    const previous = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel, input) => channel === 'sessions:create' ? ordinary('normal-new') : previous(channel, input));
    render(<NewSessionDialog />);
    await waitFor(() => expect((screen.getByRole('button', { name: /Start session/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Start session/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:create', expect.objectContaining({ config: expect.objectContaining({ harness: 'native', projectRoot: '/project' }) })));
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'missions:create')).toBe(false);
  });

  it('boot never selects a worker and pushed Mission revisions cannot regress', async () => {
    useStore.setState({ booted: false, bootError: null, activeId: null, sessions: [], loaded: {} });
    const previous = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (channel: string, input: unknown) => {
      if (channel === 'settings:get') return settings;
      if (channel === 'sessions:list') return [owned('worker'), owned('lead'), ordinary()];
      if (channel === 'terminal:list') return [];
      return previous(channel, input);
    });
    await act(async () => useStore.getState().boot());
    expect(useStore.getState().activeId).toBe('lead');
    await act(async () => {
      subscriptions.get('push:missionsChanged')?.({ ...record, revision: 5, status: 'paused' });
      subscriptions.get('push:missionsChanged')?.({ ...record, revision: 2, status: 'running' });
    });
    expect(useStore.getState().missions.mission.revision).toBe(5);
    expect(useStore.getState().missions.mission.status).toBe('paused');
    await act(async () => {
      subscriptions.get('push:missionsChanged')?.({ ...record, revision: 5, lastEventSequence: 10, status: 'paused', updatedAt: 20 });
      subscriptions.get('push:missionsChanged')?.({ ...record, revision: 5, lastEventSequence: 9, status: 'paused', updatedAt: 10 });
    });
    expect(useStore.getState().missions.mission).toMatchObject({ revision: 5, lastEventSequence: 10, updatedAt: 20 });
  });
});
