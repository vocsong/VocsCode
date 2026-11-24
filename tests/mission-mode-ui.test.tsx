/** @vitest-environment jsdom */
/**
 * Mission mode in the renderer, checked through the rendered components and the IPC calls they
 * make: the composer switch and `/mission`, the New Session switch, the nested sidebar, the Lead's
 * status strip, the handoff cards and the Builder defaults in Settings. The host is a stubbed
 * `invoke`; every mission fact arrives the way the main process sends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => {
  const invoke = vi.fn();
  (window as unknown as { harness: unknown }).harness = { platform: 'win32', invoke, on: () => () => undefined };
  return { invoke };
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { MissionStrip } from '../src/renderer/src/components/MissionStrip';
import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';
import { SessionDefaultsSection } from '../src/renderer/src/components/settings/SessionDefaultsSection';
import { InstructionsSection } from '../src/renderer/src/components/InstructionsSection';
import { Sidebar, nextSessionTarget, sidebarNavModel } from '../src/renderer/src/components/Sidebar';
import { Transcript } from '../src/renderer/src/components/Transcript';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { nestMissionRows, sortSessionRows } from '../src/renderer/src/sessionOrder';
import { searchSettings } from '../src/renderer/src/settings-catalog';
import { useStore } from '../src/renderer/src/store';
import { APP_INSTRUCTION_SCOPES } from '../src/shared/app-instructions';
import type { MissionView, SessionMission } from '../src/shared/mission-mode';
import type { AppSettings, SessionMeta, TranscriptItem } from '../src/shared/types';

type Handler = (request: unknown) => unknown;
let handlers: Record<string, Handler> = {};

const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel).map(([, request]) => request);

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

const settings = {
  defaultHarness: 'claude',
  defaultPermissionMode: 'ask',
  defaultModelByHarness: {},
  folderSessionDefaults: {},
  favoriteModels: [],
  acpAgents: [],
  providers: [],
  folders: ['G:/proj'],
  folderStyles: {},
  sidebarView: 'folders',
  goalDefaults: { autoContinue: true, maxIterations: 25, preferHarness: true },
  missionDefaults: { builder: { harness: 'same', permissionMode: 'auto' } }
} as unknown as AppSettings;

function meta(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    createdAt: 1_000,
    updatedAt: 1_000,
    cwd: 'G:/proj',
    status: 'idle',
    harnessRef: {},
    usage,
    config: { harness: 'claude', projectRoot: 'G:/proj', permissionMode: 'ask' },
    ...patch
  } as SessionMeta;
}

const lead = (mission: Partial<SessionMission> = {}, patch: Partial<SessionMeta> = {}) =>
  meta('s_lead', { title: 'Rate limiter', config: { harness: 'claude', projectRoot: 'G:/proj', permissionMode: 'plan' }, mission: { missionId: 'm1', role: 'lead', state: 'running', ...mission }, ...patch });
const builder = (n: number, mission: Partial<SessionMission> = {}, patch: Partial<SessionMeta> = {}) =>
  meta(`s_b${n}`, { title: `Builder task ${n}`, mission: { missionId: 'm1', role: 'builder', leadId: 's_lead', builderIndex: n, builderState: 'working', ...mission }, ...patch });

const view = (patch: Partial<MissionView> = {}): MissionView => ({
  id: 'm1',
  leadId: 's_lead',
  state: 'running',
  git: true,
  baseBranch: 'develop',
  leadBranch: 'mission/rate-limiter',
  builders: [
    { id: 'b-1', sessionId: 's_b1', index: 1, title: 'Token bucket', state: 'working', ownWorktree: false, failedChecks: 0 },
    { id: 'b-2', sessionId: 's_b2', index: 2, title: 'API limiter', state: 'waiting_lead', ownWorktree: true, failedChecks: 0 },
    { id: 'b-3', sessionId: 's_b3', index: 3, title: 'Docs', state: 'done', ownWorktree: false, failedChecks: 0 }
  ],
  blockedOnUser: [],
  ...patch
});

beforeEach(() => {
  handlers = {};
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, request: unknown) => {
    if (handlers[channel]) return handlers[channel](request);
    switch (channel) {
      case 'harness:models': return { models: [] };
      case 'sessions:transcript': return [];
      case 'mission:get': return null;
      case 'git:folderIsRepo': return { isRepo: true };
      case 'git:folderBranches': return { current: 'main', branches: ['main'] };
      default: return {};
    }
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useStore.setState({
    settings,
    sessions: [],
    activeId: null,
    view: 'chat',
    toasts: [],
    drafts: {},
    missionArmed: {},
    missionViews: {},
    transcripts: {},
    loaded: {},
    availability: {},
    modelCatalog: {},
    searchJump: null
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const toasts = () => useStore.getState().toasts.map((t) => t.text);

describe('composer Mission switch', () => {
  it('sends an armed prompt through mission:start with its attachments, opens the Lead and disarms', async () => {
    const plain = meta('s_plain');
    handlers['mission:start'] = () => ({ leadId: 's_lead' });
    useStore.setState({ sessions: [plain], activeId: 's_plain' });
    const { container } = render(<Composer session={plain} />);
    const toggle = screen.getByRole('switch', { name: 'Mission mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: 'Permission mode: Ask' })).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Permission mode: Lead: Plan · Builders: Auto' })).toBeTruthy();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'pixel.png', { type: 'image/png' });
    const notes = new File(['limits: 10/s'], 'notes.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.paste(textarea, { clipboardData: { files: [png, notes] } }); });
    await waitFor(() => expect(container.querySelectorAll('.attachment img')).toHaveLength(1));
    fireEvent.change(textarea, { target: { value: 'Add rate limiting to the API' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(useStore.getState().activeId).toBe('s_lead'));
    expect(calls('mission:start')).toEqual([{
      sessionId: 's_plain',
      input: {
        text: 'Add rate limiting to the API',
        images: [expect.objectContaining({ name: 'pixel.png', mimeType: 'image/png' })],
        files: [expect.objectContaining({ name: 'notes.txt' })],
        mode: 'now'
      }
    }]);
    expect(calls('sessions:send')).toHaveLength(0);
    expect(useStore.getState().missionArmed).toEqual({});
    expect(textarea.value).toBe('');
  });

  it('starts a mission from /mission <task> without arming, and keeps app commands and shell lines out of an armed send', async () => {
    const plain = meta('s_plain');
    handlers['mission:start'] = () => ({ leadId: 's_new_lead' });
    useStore.setState({ sessions: [plain], activeId: 's_plain' });
    const { container } = render(<Composer session={plain} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '/mission   Split the parser into modules' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(useStore.getState().activeId).toBe('s_new_lead'));
    expect(calls('mission:start')).toEqual([{ sessionId: 's_plain', input: { text: 'Split the parser into modules', mode: 'now' } }]);

    // Armed, an app command still runs as itself rather than becoming the mission task.
    fireEvent.click(screen.getByRole('switch', { name: 'Mission mode' }));
    fireEvent.change(textarea, { target: { value: '/mode plan' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(calls('sessions:setPermissionMode')).toEqual([{ id: 's_plain', mode: 'plan' }]));
    expect(calls('mission:start')).toHaveLength(1);

    // An empty /mission asks for the task instead of starting anything.
    fireEvent.change(textarea, { target: { value: '/mission' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(toasts().some((t) => t.startsWith('Describe the task for the mission'))).toBe(true));
    expect(calls('mission:start')).toHaveLength(1);
  });

  it('keeps the draft, the attachments and the switch when mission:start is refused', async () => {
    const plain = meta('s_plain');
    handlers['mission:start'] = () => { throw new Error("Error invoking remote method 'mission:start': Error: The folder is busy"); };
    useStore.setState({ sessions: [plain], activeId: 's_plain' });
    const { container } = render(<Composer session={plain} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Mission mode' }));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Ship the limiter' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(toasts()).toContain('The folder is busy'));
    expect(textarea.value).toBe('Ship the limiter');
    expect(useStore.getState().missionArmed).toEqual({ s_plain: true });
    expect(useStore.getState().activeId).toBe('s_plain');
  });

  it('refuses /mission on a harness that cannot lead and hides the switch there', async () => {
    const cursor = meta('s_cursor', { config: { harness: 'cursor', projectRoot: 'G:/proj', permissionMode: 'plan' } });
    useStore.setState({ sessions: [cursor] });
    const { container } = render(<Composer session={cursor} />);
    expect(screen.queryByRole('switch', { name: 'Mission mode' })).toBeNull();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/mission do it' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(toasts().some((t) => t.startsWith('Cursor cannot lead a mission'))).toBe(true));
    expect(calls('mission:start')).toHaveLength(0);
    expect(calls('sessions:send')).toHaveLength(0);
  });

  it('locks the switch on for a Lead, whose /mission text is a plain follow-up, and hides it for a Builder', async () => {
    const theLead = lead();
    useStore.setState({ sessions: [theLead] });
    const { container, unmount } = render(<Composer session={theLead} />);
    const toggle = screen.getByRole('switch', { name: 'Mission mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-readonly')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(useStore.getState().missionArmed).toEqual({});
    expect(screen.getByRole('button', { name: 'Permission mode: Lead: Plan · Builders: Auto' })).toBeTruthy();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/mission also cover the docs' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(calls('sessions:send')).toEqual([{ id: 's_lead', input: { text: 'also cover the docs', images: undefined, files: undefined, mode: 'now' } }]));
    expect(calls('mission:start')).toHaveLength(0);
    unmount();

    const b1 = builder(1);
    render(<Composer session={b1} />);
    expect(screen.queryByRole('switch', { name: 'Mission mode' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Permission mode: Ask' })).toBeTruthy();
  });

  it('shows the Builder tier from settings and steps the switch aside while a turn runs unless armed', () => {
    useStore.setState({ settings: { ...settings, missionDefaults: { builder: { harness: 'pi', permissionMode: 'ask' } } } });
    const busy = meta('s_busy', { status: 'running' });
    const { rerender } = render(<Composer session={busy} />);
    expect(screen.queryByRole('switch', { name: 'Mission mode' })).toBeNull();
    act(() => useStore.getState().setMissionArmed('s_busy', true));
    rerender(<Composer session={busy} />);
    expect(screen.getByRole('switch', { name: 'Mission mode' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Permission mode: Lead: Plan · Builders: Ask' })).toBeTruthy();
  });

  it('disables an ended mission’s Lead composer and offers a fork instead', () => {
    const ended = lead({ state: 'ended' });
    const { container } = render(<Composer session={ended} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe('This mission has ended — fork to continue');
    expect(screen.getByRole('button', { name: /Fork to continue/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(calls('sessions:send')).toHaveLength(0);
  });
});

describe('New Session Mission switch', () => {
  const start = () => screen.getByRole('button', { name: /Start (session|mission)/ }) as HTMLButtonElement;

  it('forces Plan and a mission/ worktree, requires the task and sends mission: true without remembering the forced choices', async () => {
    useStore.setState({ newSessionRoot: 'G:/proj', openNewSession: vi.fn(), setActive: vi.fn().mockResolvedValue(undefined) } as never);
    handlers['sessions:create'] = () => meta('s_created');
    render(<NewSessionDialog />);
    await waitFor(() => expect(start().disabled).toBe(false));
    const permissions = screen.getByLabelText('Permissions') as HTMLSelectElement;
    expect(permissions.value).toBe('ask');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Mission mode' }));
    expect(permissions.value).toBe('plan');
    expect(permissions.disabled).toBe(true);
    const isolate = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    expect(isolate.checked).toBe(true);
    expect(isolate.disabled).toBe(true);
    expect((screen.getByLabelText('Branch prefix') as HTMLSelectElement).value).toBe('mission');
    expect(screen.queryByText(/Goal \(optional\)/)).toBeNull();
    expect(start().textContent).toContain('Start mission');
    expect(start().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Mission task (required)'), { target: { value: 'Add a token bucket limiter' } });
    await waitFor(() => expect(start().disabled).toBe(false));
    fireEvent.click(start());
    await waitFor(() => expect(calls('sessions:create')).toHaveLength(1));
    expect(calls('sessions:create')[0]).toMatchObject({
      mission: true,
      initialPrompt: 'Add a token bucket limiter',
      config: { harness: 'claude', permissionMode: 'plan', useWorktree: true, branchPrefix: 'mission' }
    });
    expect((calls('sessions:create')[0] as { goal?: string }).goal).toBeUndefined();
    const remembered = calls('settings:update') as Partial<AppSettings>[];
    expect(remembered.some((patch) => patch.defaultPermissionMode === 'plan')).toBe(false);
    expect(remembered.some((patch) => patch.customBranchPrefixes?.includes('mission'))).toBe(false);
  });

  it('hides the switch for a harness that cannot lead and starts an ordinary session there', async () => {
    useStore.setState({ newSessionRoot: 'G:/proj', openNewSession: vi.fn(), setActive: vi.fn().mockResolvedValue(undefined) } as never);
    handlers['sessions:create'] = () => meta('s_created');
    render(<NewSessionDialog />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mission mode' }));
    fireEvent.click([...document.querySelectorAll('.harness-card')].find((card) => card.textContent?.startsWith('Cursor'))!);
    expect(screen.queryByRole('checkbox', { name: 'Mission mode' })).toBeNull();
    await waitFor(() => expect(start().disabled).toBe(false));
    expect(start().textContent).toContain('Start session');
    fireEvent.click(start());
    await waitFor(() => expect(calls('sessions:create')).toHaveLength(1));
    expect((calls('sessions:create')[0] as { mission?: boolean }).mission).toBeUndefined();
  });
});

describe('sidebar nesting', () => {
  const plain = meta('s_plain', { lastUserMessageAt: 2_500 });
  const sessions = [
    builder(2, { builderState: 'done' }, { lastUserMessageAt: 3_000 }),
    plain,
    builder(1, {}, { lastUserMessageAt: 2_000 }),
    lead({}, { lastUserMessageAt: 1_000 })
  ];

  it('puts each Builder directly under its Lead in Builder order, and leaves an orphan where it was', () => {
    expect(sortSessionRows(sessions).map((s) => s.id)).toEqual(['s_b2', 's_plain', 's_b1', 's_lead']);
    expect(nestMissionRows(sortSessionRows(sessions)).map((s) => s.id)).toEqual(['s_plain', 's_lead', 's_b1', 's_b2']);
    // Without its Lead in the list (archived, another folder) a Builder keeps its own place.
    const orphaned = sessions.filter((s) => s.id !== 's_lead');
    expect(nestMissionRows(sortSessionRows(orphaned)).map((s) => s.id)).toEqual(['s_b2', 's_plain', 's_b1']);
  });

  it('renders the nested order with Builder status dots and a Lead marker, and keyboard order matches it', () => {
    useStore.setState({ sessions, activeId: 's_lead' });
    const { container } = render(<Sidebar />);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-testid="session-row"]')];
    expect(rows.map((r) => r.dataset.sessionId)).toEqual(['s_plain', 's_lead', 's_b1', 's_b2']);
    expect(rows.map((r) => r.dataset.missionRole ?? null)).toEqual([null, 'lead', 'builder', 'builder']);
    expect(rows[2].classList.contains('mission-builder')).toBe(true);
    expect(within(rows[2]).getByRole('img', { name: 'Builder 1: Working' }).getAttribute('data-state')).toBe('working');
    expect(within(rows[3]).getByRole('img', { name: 'Builder 2: Done' }).getAttribute('data-state')).toBe('done');
    expect(rows[1].querySelector('.session-mission')?.textContent).toBe('Mission');
    expect(rows[0].querySelector('.mission-dot, .session-mission')).toBeNull();

    const model = sidebarNavModel(sessions, settings);
    expect(model[0].sessionIds).toEqual(['s_plain', 's_lead', 's_b1', 's_b2']);
    expect(nextSessionTarget(model, 's_lead', true)?.sessionId).toBe('s_b1');
    const recent = sidebarNavModel(sessions, { ...settings, sidebarView: 'recent' });
    expect(recent.flatMap((f) => f.sessionIds)).toEqual(['s_plain', 's_lead', 's_b1', 's_b2']);
  });
});

describe('Lead status strip', () => {
  it('shows the state, running Builders and the PR, and resumes or stops through the host', async () => {
    const interrupted = lead({ state: 'interrupted', prUrl: 'https://github.com/acme/api/pull/7' });
    handlers['mission:get'] = () => view({ state: 'interrupted' });
    handlers['mission:resume'] = () => view({ state: 'running' });
    handlers['mission:stop'] = () => view({ state: 'stopped' });
    useStore.setState({ sessions: [interrupted, builder(1), builder(2)] });
    render(<><MissionStrip session={interrupted} /><ConfirmHost /></>);
    const strip = screen.getByRole('region', { name: 'Mission' });
    expect(within(strip).getByText('Interrupted')).toBeTruthy();
    await waitFor(() => expect(within(strip).getByTestId('mission-builders-running').textContent).toBe('2 Builders running'));
    expect(within(strip).getByText('mission/rate-limiter → develop')).toBeTruthy();

    fireEvent.click(within(strip).getByRole('button', { name: 'PR #7' }));
    expect(calls('app:openExternal')).toEqual([{ url: 'https://github.com/acme/api/pull/7' }]);

    fireEvent.click(within(strip).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls('mission:resume')).toEqual([{ leadId: 's_lead' }]));
    await waitFor(() => expect(useStore.getState().missionViews.s_lead?.state).toBe('running'));

    fireEvent.click(within(strip).getByRole('button', { name: 'Stop' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop mission' }));
    await waitFor(() => expect(calls('mission:stop')).toEqual([{ leadId: 's_lead' }]));
  });

  it('offers neither Stop nor Resume once the PR is open, and asks again only when this mission’s sessions change', async () => {
    const open = lead({ state: 'pr_open', prUrl: 'https://github.com/acme/api/pull/9' });
    handlers['mission:get'] = () => view({ state: 'pr_open' });
    const other = meta('s_other');
    useStore.setState({ sessions: [open, builder(1), other] });
    render(<MissionStrip session={open} />);
    const strip = screen.getByRole('region', { name: 'Mission' });
    expect(within(strip).getByText('PR open')).toBeTruthy();
    expect(within(strip).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(strip).queryByRole('button', { name: 'Resume' })).toBeNull();
    await waitFor(() => expect(calls('mission:get')).toEqual([{ sessionId: 's_lead' }]));

    act(() => useStore.setState({ sessions: [open, builder(1), { ...other, status: 'running' }] }));
    await act(async () => {});
    expect(calls('mission:get')).toHaveLength(1);
    act(() => useStore.setState({ sessions: [open, builder(1, { builderState: 'done' }), other] }));
    await waitFor(() => expect(calls('mission:get')).toHaveLength(2));
  });
});

describe('mission transcript cards', () => {
  const tool = (id: string, name: string, input: unknown, output?: string): TranscriptItem =>
    ({ id, kind: 'tool', ts: 5, name, hint: 'mcp', input, output, status: 'done' });
  const longReport = Array.from({ length: 12 }, (_, i) => `- check ${i + 1} passed`).join('\n');
  const items: TranscriptItem[] = [
    { id: 'k1', kind: 'user', ts: 1, text: 'Add rate limiting to the API', origin: 'mission', mission: { kind: 'kickoff' } },
    { id: 'a1', kind: 'assistant', ts: 2, text: 'Checking who is busy first.' },
    tool('t-list', 'mcp__vocs-mission__list_builders', {}),
    { id: 'a2', kind: 'assistant', ts: 3, text: 'Starting the limiter work.' },
    tool('t-start', 'mcp__vocs-mission__start_builder', { title: 'API limiter', task: 'Wire the limiter into the router' }, 'Started b-2.'),
    { id: 'r1', kind: 'user', ts: 6, text: longReport, origin: 'mission', mission: { kind: 'from_builder', builderId: 'b-2' } },
    {
      id: 'ap-user', kind: 'approval', ts: 7,
      request: {
        id: 'ap-user', sessionId: 's_b2', harness: 'claude', kind: 'command', title: 'Run a command', command: 'git push origin mission/rate-limiter-b2',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }], createdAt: 7,
        mission: { route: 'user', reason: 'Publishes the branch', status: 'with_user', recommendation: { verdict: 'deny', note: 'The app pushes once at the end.' } }
      }
    },
    {
      id: 'ap-lead', kind: 'approval', ts: 8, decidedBy: 'lead', decision: { optionId: 'allow' },
      request: {
        id: 'ap-lead', sessionId: 's_b1', harness: 'claude', kind: 'command', title: 'Delete the build folder', command: 'rm -rf build',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow' }], createdAt: 8, mission: { route: 'lead', status: 'with_lead' }
      }
    },
    tool('t-finish', 'vocs-mission.finish_mission', { task: 'Rate limiting', done: ['Token bucket in the router'], decisions: ['10 requests per second'], files: ['src/router.ts'], verification: ['npm test passed'] })
  ];

  function renderLead() {
    const theLead = lead();
    useStore.setState({ sessions: [theLead, builder(1), builder(2)], transcripts: { s_lead: items }, loaded: { s_lead: true }, missionViews: { s_lead: view() } });
    return render(<Transcript session={theLead} />);
  }

  it('labels host-written rows by kind and Builder, and folds a long one until opened', () => {
    const { container } = renderLead();
    expect(container.querySelectorAll('.msg-user')).toHaveLength(0);
    const kickoff = container.querySelector('.mission-msg[data-kind="kickoff"]') as HTMLElement;
    expect(within(kickoff).getByText('Kickoff')).toBeTruthy();
    expect(kickoff.textContent).toContain('Add rate limiting to the API');
    const report = container.querySelector('.mission-msg[data-kind="from_builder"]') as HTMLElement;
    expect(within(report).getByText('From Builder 2')).toBeTruthy();
    expect(report.classList.contains('folded')).toBe(true);
    const more = within(report).getByRole('button', { name: 'Show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(report.classList.contains('folded')).toBe(false);
    expect(within(report).getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows handoffs as cards between messages, folds read-only checks into the work, and keeps raw details one click away', () => {
    const { container } = renderLead();
    const started = container.querySelector('.mission-tool[data-tool="start_builder"]') as HTMLElement;
    expect(within(started).getByText('Started Builder 2: API limiter')).toBeTruthy();
    expect(started.closest('.work-group')).toBeNull();
    expect(screen.queryByText('Checked the Builders')).toBeNull();
    fireEvent.click(within(container.querySelector('.work-group') as HTMLElement).getByRole('button', { expanded: false }));
    expect(screen.getByText('Checked the Builders')).toBeTruthy();

    const head = within(started).getByRole('button', { name: /Started Builder 2/ });
    expect(started.querySelector('.mission-tool-body')).toBeNull();
    fireEvent.click(head);
    expect(started.querySelector('.mission-tool-name')?.textContent).toBe('mcp__vocs-mission__start_builder');
    expect(started.querySelector('.tool-input')?.textContent).toContain('Wire the limiter into the router');
    expect(started.querySelector('.tool-output')?.textContent).toBe('Started b-2.');

    const finish = container.querySelector('.mission-tool[data-tool="finish_mission"]') as HTMLElement;
    expect(within(finish).getByText('Finished the mission')).toBeTruthy();
    const report = within(finish).getByLabelText('Mission report');
    expect([...report.querySelectorAll('.mission-report-title')].map((el) => el.textContent)).toEqual(['Task', 'Done', 'Decisions', 'Files', 'Verification']);
    expect(report.textContent).toContain('npm test passed');
  });

  it('routes a Builder’s request from the Lead’s copy to the Builder, with the Lead’s advice and who answered', async () => {
    const { container } = renderLead();
    const asking = (container.querySelector('.approval-mission[data-status="with_user"]') as HTMLElement).closest('.approval') as HTMLElement;
    expect(within(asking).getByText('Builder 2')).toBeTruthy();
    expect(within(asking).getByText('Needs you: Publishes the branch')).toBeTruthy();
    expect(within(asking).getByText('The Lead recommends: Deny')).toBeTruthy();
    expect(within(asking).getByText('The app pushes once at the end.')).toBeTruthy();
    fireEvent.click(within(asking).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(calls('approvals:respond')).toEqual([{ sessionId: 's_b2', requestId: 'ap-user', decision: { optionId: 'deny', note: undefined } }]));

    const answered = (container.querySelector('.approval-mission[data-status="with_lead"]') as HTMLElement).closest('.approval') as HTMLElement;
    expect(within(answered).getByText('Answered by the Lead')).toBeTruthy();
  });

  it('says a pending request is with the Lead', () => {
    const theLead = lead();
    const pending: TranscriptItem = {
      id: 'ap-1', kind: 'approval', ts: 1,
      request: { id: 'ap-1', sessionId: 's_b1', harness: 'pi', kind: 'command', title: 'Run tests', command: 'npm test', options: [{ id: 'y', label: 'Allow', kind: 'allow' }], createdAt: 1, mission: { route: 'lead', status: 'with_lead' } }
    };
    useStore.setState({ sessions: [theLead, builder(1)], transcripts: { s_lead: [pending] }, loaded: { s_lead: true } });
    render(<Transcript session={theLead} />);
    expect(screen.getByText('With the Lead — it answers first; you can still decide here.')).toBeTruthy();
    expect(screen.getByText('Builder 1')).toBeTruthy();
  });
});

describe('Settings', () => {
  it('saves the Builder harness, effort and tier to missionDefaults, offering only harnesses that can build', async () => {
    const update = vi.fn();
    const { rerender } = render(<SessionDefaultsSection settings={settings} update={update} />);
    const group = document.getElementById('sessions-mission') as HTMLElement;
    const harness = within(group).getByLabelText(/^Builder harness/) as HTMLSelectElement;
    const options = [...harness.options].map((o) => o.value);
    expect(options[0]).toBe('same');
    expect(options).toEqual(expect.arrayContaining(['claude', 'codex', 'pi', 'native', 'acp']));
    expect(options).not.toEqual(expect.arrayContaining(['cursor']));
    expect(options.some((o) => o === 'codex-exec' || o === 'antigravity')).toBe(false);
    expect(within(group).queryByText('Builder model')).toBeNull();
    expect((within(group).getByLabelText(/^Builder permission mode/) as HTMLSelectElement).value).toBe('auto');

    fireEvent.change(harness, { target: { value: 'pi' } });
    expect(update).toHaveBeenLastCalledWith({ missionDefaults: { builder: { harness: 'pi', permissionMode: 'auto' } } });

    const pi = { ...settings, missionDefaults: { builder: { harness: 'pi' as const, permissionMode: 'auto' as const } } };
    rerender(<SessionDefaultsSection settings={pi} update={update} />);
    expect(within(group).getByText('Builder model')).toBeTruthy();
    await waitFor(() => expect(calls('harness:models')).toEqual(expect.arrayContaining([expect.objectContaining({ harness: 'pi' })])));
    fireEvent.change(within(group).getByLabelText(/^Builder reasoning effort/), { target: { value: 'high' } });
    expect(update).toHaveBeenLastCalledWith({ missionDefaults: { builder: { harness: 'pi', permissionMode: 'auto', effort: 'high' } } });
    fireEvent.change(within(group).getByLabelText(/^Builder permission mode/), { target: { value: 'ask' } });
    expect(update).toHaveBeenLastCalledWith({ missionDefaults: { builder: { harness: 'pi', permissionMode: 'ask' } } });
  });

  it('finds Mission mode by search and shows the Lead and Builder instruction tabs', async () => {
    expect(searchSettings('mission builder')).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: 'sessions', topic: expect.objectContaining({ label: 'Mission mode', anchor: 'sessions-mission' }) })
    ]));
    expect(searchSettings('mission lead').map((r) => r.section)).toContain('instructions');

    handlers['instructions:read'] = () => APP_INSTRUCTION_SCOPES.map((scope) => ({ scope, path: `C:/app/instructions/${scope}.md`, content: '', exists: false }));
    render(<InstructionsSection />);
    const tabs = screen.getByRole('group', { name: 'Instruction scope' });
    await waitFor(() => expect(within(tabs).getByRole('button', { name: /^Mission Lead/ })).toBeTruthy());
    fireEvent.click(within(tabs).getByRole('button', { name: /^Mission Builder/ }));
    expect(screen.getByText(/Added to the built-in Mission mode Builder prompt/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Instructions text' }) as HTMLTextAreaElement).placeholder).toBe('The Mission Builder add-on is not set');
  });
});
