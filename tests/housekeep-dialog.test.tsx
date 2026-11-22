/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HousekeepInventory, HousekeepOutcome, HousekeepPreview, HousekeepRow } from '../src/shared/housekeep';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn<(channel: string, request?: unknown) => Promise<unknown>>() }));
vi.mock('../src/renderer/src/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer/src/api')>(),
  invoke,
  on: () => () => undefined,
  platform: 'win32'
}));
vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn() }));

import { App } from '../src/renderer/src/App';
import { HousekeepDialog } from '../src/renderer/src/components/HousekeepDialog';
import { singlePaneLayout } from '../src/renderer/src/panes';
import { useStore } from '../src/renderer/src/store';

const row = (sessionId: string, title: string, patch: Partial<HousekeepRow> = {}): HousekeepRow => ({
  sessionId, title, projectRoot: '/fixture/project', activityAt: Date.UTC(2026, 6, 1),
  verdict: 'review', worktree: 'none', reason: 'Compare the latest request and response.',
  evidence: { request: `Please finish ${title}.`, response: `The latest result for ${title}.` },
  ...patch
});
const preview = (rows: HousekeepRow[], patch: Partial<HousekeepPreview> = {}): HousekeepPreview => ({
  id: 'preview-1', recentDays: 14, reviewModel: 'fixture-provider/utility-small', rows, ...patch
});

function reply({ preview: scan, inventory, assess, apply }: {
  preview: () => HousekeepPreview | Promise<HousekeepPreview>;
  inventory?: () => HousekeepInventory | Promise<HousekeepInventory>;
  assess?: () => HousekeepPreview | Promise<HousekeepPreview>;
  apply?: () => HousekeepOutcome[] | Promise<HousekeepOutcome[]>;
}) {
  invoke.mockImplementation(async (channel) => {
    if (channel === 'housekeep:preview') return scan();
    if (channel === 'housekeep:inventory' && inventory) return inventory();
    if (channel === 'housekeep:assess' && assess) return assess();
    if (channel === 'housekeep:apply' && apply) return apply();
    if (channel === 'harness:models') return { models: [] };
    if (channel === 'git:summary') return null;
    if (channel.startsWith('housekeep:')) throw new Error(`Unexpected ${channel}`);
    return undefined;
  });
}

const dialog = () => within(screen.getByRole('dialog', { name: 'Housekeep sessions' }));
const button = (name: string | RegExp) => dialog().getByRole<HTMLButtonElement>('button', { name });
const checkbox = (title: string) => dialog().getByRole<HTMLInputElement>('checkbox', { name: `Select ${title}` });
const calls = () => invoke.mock.calls.filter(([channel]) => channel.startsWith('housekeep:'));
const pickedTitles = () => within(dialog().getByRole('list', { name: 'Selected sessions to archive' })).getAllByRole('listitem');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function readAndSelect(title: string) {
  const choice = checkbox(title);
  expect(choice.disabled).toBe(true);
  fireEvent.click(dialog().getByLabelText(`Conversation excerpts for ${title}`));
  await waitFor(() => expect(choice.disabled).toBe(false));
  fireEvent.click(choice);
  expect(choice.checked).toBe(true);
}

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ activeId: null, layout: singlePaneLayout(), visibleSessionIds: [], drafts: {}, toasts: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderAppWithComposer() {
  const session: SessionMeta = {
    id: 'in-pane', title: 'Open session', cwd: '/fixture/project', createdAt: 1000, updatedAt: 1000, status: 'idle', harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    config: { harness: 'native', permissionMode: 'ask', projectRoot: '/fixture/project' }
  };
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  useStore.setState({
    booted: true, bootError: null, sessions: [session], activeId: session.id, layout: singlePaneLayout(session.id),
    view: 'chat', panelOpen: false, sidebarOpen: false, transcripts: { [session.id]: [] }, loaded: { [session.id]: true },
    settings: { theme: 'dark', sidebarWidth: 260, panelWidth: 380, providers: [], onboardingDone: true, agent: { enabled: false } } as unknown as AppSettings
  });
  render(<App />);
  return { session, composer: screen.getByPlaceholderText<HTMLTextAreaElement>(/Message the agent/) };
}

describe('/housekeep', () => {
  it('opens the dialog from the slash menu without sending a harness message or running analysis', async () => {
    reply({ preview: () => preview([]) });
    const { session, composer } = renderAppWithComposer();
    fireEvent.change(composer, { target: { value: '/housek' } });
    const item = screen.getByRole('button', { name: /^\/housekeep\b/ });
    expect(calls()).toEqual([]);
    fireEvent.mouseDown(item);
    expect(composer.value.trim()).toBe('/housekeep');
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await dialog().findByText('No sessions to review.')).toBeTruthy();
    expect(calls()).toEqual([['housekeep:preview', { protectedIds: [session.id] }]]);
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:send')).toBe(false);
    expect(composer.value).toBe('');
    fireEvent.click(button('Housekeep settings'));
    expect(screen.queryByRole('dialog', { name: 'Housekeep sessions' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Housekeep' })).toBeTruthy();
  });

  it.each([3, 0])('opens a one-time %i-day review without sending a message, applying, or saving settings', async (days) => {
    reply({ preview: () => preview([], { recentDays: days }) });
    const { composer, session } = renderAppWithComposer();
    fireEvent.change(composer, { target: { value: `/housekeep ${days}` } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(await screen.findByText('Age rule for this review only:')).toBeTruthy();
    expect(dialog().getByText(days === 0 ? /0 days: the recent activity window is off/ : /Activity within the last 3 days/)).toBeTruthy();
    expect(calls()).toEqual([['housekeep:preview', { protectedIds: [session.id], recentDaysOverride: days }]]);
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:send' || channel === 'settings:update')).toBe(false);
    expect(composer.value).toBe('');
  });

  it('leaves invalid day arguments in the composer without opening a review or sending a message', () => {
    reply({ preview: () => preview([]) });
    const { composer } = renderAppWithComposer();
    for (const arg of ['-1', '3.0', '3.5', '1e2', '0x3', '3651', '3 settings']) {
      const text = `/housekeep ${arg}`;
      fireEvent.change(composer, { target: { value: text } });
      fireEvent.keyDown(composer, { key: 'Enter' });
      expect(composer.value).toBe(text);
    }
    expect(screen.queryByRole('dialog', { name: 'Housekeep sessions' })).toBeNull();
    expect(calls()).toEqual([]);
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:send')).toBe(false);
  });

  it('scans only on demand with no sessions to review and displays read-only findings', async () => {
    const scan = deferred<HousekeepInventory>();
    reply({ preview: () => preview([]), inventory: () => scan.promise });
    render(<HousekeepDialog onClose={vi.fn()} />);
    await dialog().findByText('No sessions to review.');
    const name = 'Stranded worktrees and branches';
    const panel = within(dialog().getByRole('region', { name }));
    expect(panel.getByRole('heading', { name })).toBeTruthy();
    expect(panel.queryByRole('list')).toBeNull();
    expect(invoke.mock.calls).toEqual([['housekeep:preview', { protectedIds: [] }]]);
    const scanButton = panel.getByRole<HTMLButtonElement>('button', {
      name: 'Scan worktrees and branches',
      description: /Read-only:.*known worktree folders.*checkout contents.*or on remotes.*not necessarily abandoned/
    });
    fireEvent.click(scanButton);
    fireEvent.click(scanButton);
    expect(scanButton.disabled).toBe(true);
    expect(panel.getByRole('status').textContent).toBe('Scanning worktrees and branches…');
    const projectRoot = '/fixture/project';
    const location = `${projectRoot}/.vocs-code/worktrees/left-behind`;
    await act(async () => scan.resolve({ repositories: 1, warnings: [], limited: false, rows: [
      { projectRoot, kind: 'unregistered-folder', location, sessions: [] },
      { projectRoot, kind: 'retained-branch', location: 'vocs/archived', sessions: [{ title: 'Closed ticket', archived: true }] },
      { projectRoot, kind: 'stale-registration', location: `${location}-stale`, branch: 'vocs/stale', locked: true, sessions: [] }
    ] }));

    expect(panel.getByRole('status').textContent).toBe('1 repository scanned. 3 findings returned.');
    const findings = within(panel.getByRole('list', { name: 'Inventory findings' }));
    for (const text of ['Unregistered folder', location, 'Retained branch', 'vocs/archived', 'Stale registration', 'Locked', 'vocs/stale']) {
      expect(findings.getByText(text)).toBeTruthy();
    }
    expect(findings.getByText('Linked session: Closed ticket (archived)')).toBeTruthy();
    expect(panel.queryByRole('checkbox')).toBeNull();
    expect(panel.getAllByRole('button')).toEqual([scanButton]);
    expect(button('Review selected').disabled).toBe(true);
    expect(invoke.mock.calls).toEqual([['housekeep:preview', { protectedIds: [] }], ['housekeep:inventory', undefined]]);
  });

  it('separates scan failures, warnings, and limits from a clean empty result', async () => {
    const empty = { repositories: 1, rows: [], warnings: [], limited: false } satisfies HousekeepInventory;
    const scan = vi.fn<() => Promise<HousekeepInventory>>()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'housekeep:inventory': Error: Git unavailable."))
      .mockResolvedValueOnce({ ...empty, warnings: ['Could not check a project.'] })
      .mockResolvedValueOnce({ ...empty, limited: true })
      .mockResolvedValueOnce(empty);
    reply({ preview: () => preview([]), inventory: scan });
    render(<HousekeepDialog onClose={vi.fn()} />);
    const scanButton = await dialog().findByRole('button', { name: 'Scan worktrees and branches' });
    const panel = within(dialog().getByRole('region', { name: 'Stranded worktrees and branches' }));

    fireEvent.click(scanButton);
    expect((await panel.findByRole('alert')).textContent).toBe('Could not scan worktrees and branches. Git unavailable.');
    expect(scan).toHaveBeenCalledTimes(1);
    fireEvent.click(scanButton);
    expect(await panel.findByText('Could not check a project.')).toBeTruthy();
    expect(panel.getByRole('alert').textContent).toMatch(/with warnings.*may be incomplete/);
    expect(panel.queryByText(/No findings in the checked locations/)).toBeNull();
    fireEvent.click(scanButton);
    expect(await panel.findByText('Scan limit reached. Results are incomplete.')).toBeTruthy();
    expect(panel.queryByText(/No findings in the checked locations/)).toBeNull();
    fireEvent.click(scanButton);
    expect(await panel.findByText('1 repository scanned. No findings in the checked locations.')).toBeTruthy();
    expect(panel.queryByRole('alert')).toBeNull();
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it('offers the read-only inventory even when the session review fails', async () => {
    reply({ preview: () => { throw new Error('Session preview unavailable.'); }, inventory: () => ({ repositories: 0, rows: [], warnings: [], limited: false }) });
    render(<HousekeepDialog onClose={vi.fn()} />);
    expect(await dialog().findByText(/Session preview unavailable/)).toBeTruthy();
    fireEvent.click(button('Scan worktrees and branches'));
    expect(await dialog().findByText('No known Git repositories to scan.')).toBeTruthy();
    expect(invoke.mock.calls).toEqual([['housekeep:preview', { protectedIds: [] }], ['housekeep:inventory', undefined]]);
  });

  it('keeps a pending inventory scan outside the session archive flow', async () => {
    const scan = deferred<HousekeepInventory>();
    reply({ preview: () => preview([row('one', 'Archive candidate')]), inventory: () => scan.promise, apply: () => [] });
    render(<HousekeepDialog onClose={vi.fn()} />);
    fireEvent.click(await dialog().findByRole('button', { name: 'Scan worktrees and branches' }));
    await readAndSelect('Archive candidate');
    fireEvent.click(button('Review selected'));
    expect(pickedTitles().map((item) => item.querySelector('strong')?.textContent)).toEqual(['Archive candidate']);
    expect(dialog().queryByRole('heading', { name: 'Stranded worktrees and branches' })).toBeNull();
    await act(async () => scan.resolve({ repositories: 0, rows: [], warnings: [], limited: false }));
    fireEvent.click(button('Confirm archive (1)'));
    expect(await dialog().findByRole('heading', { name: 'Archive results' })).toBeTruthy();
    expect(invoke.mock.calls).toEqual([
      ['housekeep:preview', { protectedIds: [] }], ['housekeep:inventory', undefined],
      ['housekeep:apply', { previewId: 'preview-1', ids: ['one'], protectedIds: [] }]
    ]);
  });

  it('discloses what is sent and requires explicit selection of completed, unprotected recommendations', async () => {
    const rows = [row('done', 'Completed change', { worktree: 'remove' }), row('manual', 'Unclear result'),
      row('keep', 'Waiting for release'), row('pinned', 'Pinned session', { verdict: 'protected', reason: 'Pinned by the user.', worktree: null, evidence: undefined }),
      row('in-progress', 'Draft added later')];
    const assessment = deferred<HousekeepPreview>();
    reply({ preview: () => preview(rows), assess: () => assessment.promise });
    useStore.setState({ activeId: 'front', visibleSessionIds: ['side'], drafts: { saved: 'unsent text', side: 'also unsent', empty: '' } });
    render(<StrictMode><HousekeepDialog onClose={vi.fn()} /></StrictMode>);

    expect(dialog().getByText('Loading session preview…')).toBeTruthy();
    expect(await dialog().findByText(/within the last 14 days .*including the cutoff/)).toBeTruthy();
    expect(dialog().getByText(/latest session creation, update, view, or transcript activity/)).toBeTruthy();
    expect(dialog().getByRole('button', {
      name: 'Analyze',
      description: /fixture-provider\/utility-small.*short conversation excerpts.*eligible older sessions across all projects.*may contain sensitive text.*won’t use another model or start provider setup/
    })).toBeTruthy();
    const completed = within(checkbox('Completed change').closest('li')!);
    expect(completed.getByText(/Project: \/fixture\/project/)).toBeTruthy();
    expect(completed.getByText('Remove original worktree if still safe')).toBeTruthy();
    const pinned = within(checkbox('Pinned session').closest('li')!);
    expect(pinned.getByText('Protected')).toBeTruthy();
    expect(pinned.getByText('Pinned by the user.')).toBeTruthy();
    expect(checkbox('Pinned session').disabled).toBe(true);
    expect(checkbox('Completed change').checked).toBe(false);
    expect(dialog().queryByRole('button', { name: /Select completed/ })).toBeNull();
    expect(button('Review selected').disabled).toBe(true);
    expect(calls()).toEqual([['housekeep:preview', { protectedIds: ['side', 'front', 'saved'] }]]);

    fireEvent.click(button('Analyze'));
    expect(dialog().getByText('Analyzing excerpts…')).toBeTruthy();
    expect(button('Analyze').disabled).toBe(true);
    expect(button('Scan worktrees and branches').disabled).toBe(true);
    act(() => useStore.getState().setDraft('in-progress', 'New work'));
    await act(async () => assessment.resolve(preview([
      { ...rows[0], verdict: 'complete', reason: 'The requested change shipped.' },
      { ...rows[1], reason: 'No verified recommendation.' },
      { ...rows[2], verdict: 'keep', reason: 'The user still needs to release it.' }, rows[3],
      { ...rows[4], verdict: 'complete' }
    ])));

    expect(dialog().getByText('The requested change shipped.')).toBeTruthy();
    expect(dialog().getByText('The user still needs to release it.')).toBeTruthy();
    expect(dialog().getByText('Complete')).toBeTruthy();
    expect(dialog().getByText('Keep')).toBeTruthy();
    expect(checkbox('Completed change').checked).toBe(false);
    expect(button('Review selected').disabled).toBe(true);
    fireEvent.click(button('Select completed (1)'));
    expect(checkbox('Completed change').checked).toBe(true);
    for (const title of ['Unclear result', 'Waiting for release', 'Pinned session', 'Draft added later']) {
      expect(checkbox(title).checked).toBe(false);
      expect(checkbox(title).disabled).toBe(true);
    }
    expect(dialog().getByText('1 selected')).toBeTruthy();
    fireEvent.click(checkbox('Completed change'));
    expect(checkbox('Completed change').checked).toBe(false);
    expect(button('Review selected').disabled).toBe(true);
    expect(calls()).toEqual([
      ['housekeep:preview', { protectedIds: ['side', 'front', 'saved'] }], ['housekeep:assess', { previewId: 'preview-1' }]
    ]);
  });

  it('reviews the exact batch before one apply with fresh protections, then lists successful and skipped results', async () => {
    const rows = [row('one', 'Clean worktree', { worktree: 'remove' }), row('two', 'Missing worktree', { worktree: 'missing' }), row('three', 'Archive only')];
    const waiting = row('wait', 'Waiting on follow-up');
    const applied = deferred<HousekeepOutcome[]>();
    reply({
      preview: () => preview([...rows, waiting]),
      assess: () => preview([{ ...rows[0], verdict: 'complete' }, rows[1], rows[2], { ...waiting, verdict: 'keep' }], { id: 'assessed-preview' }),
      apply: () => applied.promise
    });
    const onClose = vi.fn();
    render(<HousekeepDialog onClose={onClose} />);
    await dialog().findByRole('button', { name: 'Analyze' });
    await readAndSelect('Missing worktree');
    await readAndSelect('Archive only');
    await readAndSelect('Waiting on follow-up');
    fireEvent.click(button('Analyze'));
    const selectCompleted = await dialog().findByRole('button', { name: 'Select completed (1)' });
    expect(checkbox('Clean worktree').checked).toBe(false);
    expect(checkbox('Missing worktree').checked).toBe(true);
    expect(checkbox('Archive only').checked).toBe(true);
    expect(checkbox('Waiting on follow-up').checked).toBe(false);
    expect(checkbox('Waiting on follow-up').disabled).toBe(true);
    expect(dialog().getByText('2 selected')).toBeTruthy();
    fireEvent.click(selectCompleted);
    expect(dialog().getByText('3 selected')).toBeTruthy();
    expect(dialog().getByText('Please finish Archive only.')).toBeTruthy();
    expect(dialog().getByText('The latest result for Archive only.')).toBeTruthy();
    expect(dialog().getByText('Original worktree already missing')).toBeTruthy();

    fireEvent.click(button('Review selected'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const finalHeading = dialog().getByRole('heading', { name: 'Final archive review' });
    expect(document.activeElement).toBe(finalHeading);
    fireEvent.keyDown(finalHeading, { key: 'Enter' });
    expect(dialog().getByText(/Archive 3 sessions · 1 original worktree/)).toBeTruthy();
    expect(dialog().getByText(/Transcripts and branches are kept.*system Trash/)).toBeTruthy();
    expect(pickedTitles().map((item) => item.querySelector('strong')?.textContent)).toEqual(rows.map((r) => r.title));
    expect(calls()).toHaveLength(2);
    fireEvent.click(button('Back to review'));
    expect(checkbox('Missing worktree').checked).toBe(true);
    expect(checkbox('Missing worktree').disabled).toBe(false);
    expect(calls()).toHaveLength(2);

    fireEvent.click(button('Review selected'));
    act(() => useStore.setState({ activeId: 'new-active', visibleSessionIds: ['new-side'], drafts: { 'new-draft': 'unsent', empty: '' } }));
    const confirm = button('Confirm archive (3)');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(dialog().getByText(/Archiving selected sessions/)).toBeTruthy();
    expect(calls()).toEqual([
      ['housekeep:preview', { protectedIds: [] }], ['housekeep:assess', { previewId: 'preview-1' }],
      ['housekeep:apply', { previewId: 'assessed-preview', ids: ['one', 'two', 'three'], protectedIds: ['new-side', 'new-active', 'new-draft'] }]
    ]);
    await act(async () => applied.resolve([
      { sessionId: 'one', title: 'Clean worktree', state: 'removed' },
      { sessionId: 'two', title: 'Missing worktree', state: 'archived' },
      { sessionId: 'three', title: 'Archive only', state: 'skipped', detail: 'The session changed after review.' }
    ]));

    const results = within(dialog().getByRole('list', { name: 'Archive results' }));
    expect(results.getAllByRole('listitem')).toHaveLength(3);
    expect(results.getByText(/original worktree removed/)).toBeTruthy();
    expect(results.getByText('Missing worktree').parentElement?.textContent).toBe('Missing worktree — Archived');
    expect(results.getByText(/Skipped/)).toBeTruthy();
    expect(results.getByText('The session changed after review.')).toBeTruthy();
    expect(dialog().queryByRole('button', { name: /Confirm archive/ })).toBeNull();
    fireEvent.click(button('Done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not silently approve a different batch when a selected session gains a draft', async () => {
    reply({ preview: () => preview([row('one', 'Work in draft')], { reviewModel: null }) });
    render(<HousekeepDialog onClose={vi.fn()} />);
    expect(await dialog().findByText(/No utility model is available/)).toBeTruthy();
    expect(dialog().queryByRole('button', { name: 'Analyze' })).toBeNull();
    await readAndSelect('Work in draft');
    fireEvent.click(button('Review selected'));
    act(() => useStore.getState().setDraft('one', 'Keep this work'));
    expect(dialog().getByRole('alert').textContent).toMatch(/now protected/);
    expect(button('Confirm archive (1)').disabled).toBe(true);
    fireEvent.click(button('Back to review'));
    expect(checkbox('Work in draft').checked).toBe(false);
    expect(checkbox('Work in draft').disabled).toBe(true);
    expect(invoke.mock.calls).toEqual([['housekeep:preview', { protectedIds: [] }]]);
  });

  it('requires a fresh preview before sending excerpts if a candidate becomes protected', async () => {
    const candidate = row('one', 'Draft started after preview');
    const scan = vi.fn<() => HousekeepPreview>()
      .mockReturnValueOnce(preview([candidate]))
      .mockReturnValueOnce(preview([{ ...candidate, verdict: 'protected', reason: 'Has an unsent draft.', evidence: undefined }]));
    reply({ preview: scan });
    render(<HousekeepDialog onClose={vi.fn()} />);
    expect((await dialog().findByRole<HTMLButtonElement>('button', { name: 'Analyze' })).disabled).toBe(false);
    act(() => useStore.getState().setDraft('one', 'Keep this private'));
    expect(button('Analyze').disabled).toBe(true);
    expect(dialog().getByText(/Refresh before running analysis/)).toBeTruthy();
    fireEvent.click(button('Load fresh preview'));
    expect(await dialog().findByText('Has an unsent draft.')).toBeTruthy();
    expect(invoke.mock.calls).toEqual([
      ['housekeep:preview', { protectedIds: [] }], ['housekeep:preview', { protectedIds: ['one'] }]
    ]);
  });

  it('recovers from preview and apply errors by requiring a fresh review without automatic retries', async () => {
    const scan = vi.fn<() => Promise<HousekeepPreview>>()
      .mockRejectedValueOnce(new Error('Could not read sessions.'))
      .mockResolvedValueOnce(preview([row('one', 'Ready to archive')], { reviewModel: null, recentDays: 0 }))
      .mockResolvedValueOnce(preview([], { reviewModel: null, recentDays: 0 }));
    reply({
      preview: scan,
      apply: () => Promise.reject(new Error("Error invoking remote method 'housekeep:apply': Error: The preview expired."))
    });
    render(<HousekeepDialog onClose={vi.fn()} />);
    expect((await dialog().findByRole('alert')).textContent).toContain('Could not read sessions.');
    expect(calls()).toHaveLength(1);
    fireEvent.click(button('Load fresh preview'));
    expect(await dialog().findByText(/0 days: the recent activity window is off/)).toBeTruthy();
    await readAndSelect('Ready to archive');
    fireEvent.click(button('Review selected'));
    fireEvent.click(button('Confirm archive (1)'));
    expect((await dialog().findByRole('alert')).textContent).toMatch(/Some sessions may have been processed.*The preview expired\./);
    expect(dialog().queryByRole('button', { name: /Confirm archive/ })).toBeNull();
    expect(calls().map(([channel]) => channel)).toEqual(['housekeep:preview', 'housekeep:preview', 'housekeep:apply']);
    fireEvent.click(button('Load fresh preview'));
    expect(await dialog().findByText('No sessions to review.')).toBeTruthy();
    expect(button('Review selected').disabled).toBe(true);
  });

  it('leaves manual review available after an analysis error', async () => {
    reply({ preview: () => preview([row('one', 'Manual candidate')]), assess: () => Promise.reject(new Error('Utility model changed.')) });
    render(<HousekeepDialog onClose={vi.fn()} />);
    fireEvent.click(await dialog().findByRole('button', { name: 'Analyze' }));
    expect((await dialog().findByRole('alert')).textContent).toMatch(/still review manually.*Utility model changed/);
    await readAndSelect('Manual candidate');
    expect(calls().map(([channel]) => channel)).toEqual(['housekeep:preview', 'housekeep:assess']);
  });

  it('does not dispatch more work or update the store when a late assessment resolves after unmount', async () => {
    const assessment = deferred<HousekeepPreview>();
    const candidate = row('closed', 'Late result');
    reply({ preview: () => preview([candidate]), assess: () => assessment.promise });
    const { unmount } = render(<HousekeepDialog onClose={vi.fn()} />);
    fireEvent.click(await dialog().findByRole('button', { name: 'Analyze' }));
    unmount();
    const storeBefore = useStore.getState();
    await act(async () => assessment.resolve(preview([{ ...candidate, verdict: 'complete' }])));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useStore.getState()).toBe(storeBefore);
    expect(calls().map(([channel]) => channel)).toEqual(['housekeep:preview', 'housekeep:assess']);
  });
});
