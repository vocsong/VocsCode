// Header: one row — the session's identity (title, harness, folder, branch), what it changed and the
// view actions. The 3-dot menu is gone, and fork/archive buttons behave exactly like the sidebar
// row's (same fork menu, same archive flow). Model, effort, permission and usage stay under the
// composer: SessionControls.
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Header } from '../src/renderer/src/components/Header';
import { SessionControls } from '../src/renderer/src/components/SessionControls';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { rememberEffort, setSessionEffort } from '../src/renderer/src/sessionActions';
import { useStore } from '../src/renderer/src/store';
import type { GitSummary, SessionMeta } from '../src/shared/types';

// Header owns an asynchronous shared Git subscription; release it before jsdom is torn down.
afterEach(async () => { await act(async () => { cleanup(); }); });

const session = (id = 's_h', patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: 'Header session',
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'],
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});

/** `git` is what the session's Git summary reads back. */
function reset(git: Partial<GitSummary> = {}) {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (channel: string) => (channel === 'git:summary' ? git : {}));
  useStore.setState({
    activeId: 's_h',
    view: 'chat',
    panelOpen: true,
    showThinking: true,
    toasts: [],
    models: {},
    modelCatalog: { native: { models: [], loading: false } }
  });
}

function setup(patch: Partial<SessionMeta> = {}, withConfirm = false, git?: Partial<GitSummary>) {
  reset(git);
  return render(
    <>
      <Header session={session('s_h', patch)} />
      {withConfirm && <ConfirmHost />}
    </>
  );
}

/** The run controls the composer shows under the prompt of an ordinary session. */
function setupControls(patch: Partial<SessionMeta> = {}) {
  reset();
  return render(<SessionControls session={session('s_h', patch)} />);
}

describe('header actions', () => {
  it('keeps the panel toggle in the title row and drops the 3-dot menu', () => {
    const { container } = setup();
    const title = container.querySelector('.header-title') as HTMLElement;
    expect(title.querySelector('[aria-label="Toggle panel"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="More"]')).toBeNull();
  });

  it('shows the harness label right after the session title, with the session row tone', () => {
    const { container } = setup({ config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'] });
    const title = container.querySelector('.header-title') as HTMLElement;
    const label = title.querySelector('.badge') as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toContain('Claude');
    // Same tone class the sidebar session row uses for this harness.
    expect(label.classList.contains('badge-amber')).toBe(true);
    // Next to the name it qualifies, ahead of the folder and branch crumbs.
    expect(title.querySelector('[data-testid="session-title"]')?.nextElementSibling).toBe(label);
    // The second row of pills it used to lead is gone.
    expect(container.querySelector('.header-pills')).toBeNull();
  });

  it('toggles thinking from the actions group, ahead of the panel toggle in the same row', () => {
    const { container } = setup();
    const actions = container.querySelector('.header-actions') as HTMLElement;
    // Order in the actions group: hide thinking, fork, archive.
    const labels = [...actions.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
    expect(labels[0]).toBe('Hide thinking');
    expect(labels).toContain('Fork session');
    expect(labels).toContain('Archive session');
    fireEvent.click(actions.querySelector('[aria-label="Hide thinking"]') as HTMLElement);
    expect(useStore.getState().showThinking).toBe(false);
    // One header row: the actions share the title row and come before the panel toggle.
    const title = container.querySelector('.header-title') as HTMLElement;
    expect(title.contains(actions)).toBe(true);
    const toggle = title.querySelector('[aria-label="Toggle panel"]') as HTMLElement;
    expect(actions.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('fork button opens the same harness menu as the sidebar row and forks', async () => {
    const { container } = setup();
    const fork = container.querySelector('[aria-label="Fork session"]') as HTMLElement;
    expect(fork).toBeTruthy();
    fireEvent.click(fork);
    const items = [...document.querySelectorAll('.dropdown-menu .menu-item')];
    const labels = items.map((i) => i.textContent ?? '');
    // The session's own harness is offered first, then every other harness.
    expect(labels[0]).toContain('Fork into');
    expect(labels.some((l) => l.includes('Native'))).toBe(true);
    expect(labels.some((l) => l.includes('Claude'))).toBe(true);
    const claude = items.find((i) => (i.textContent ?? '').includes('Claude')) as HTMLElement;
    invokeMock.mockResolvedValueOnce(session('s_f', { config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'] }));
    fireEvent.click(claude);
    expect(invokeMock).toHaveBeenCalledWith('sessions:fork', { id: 's_h', harness: 'claude' });
    await waitFor(() => expect(useStore.getState().activeId).toBe('s_f'));
  });

  it('archive button archives like the sidebar row', () => {
    const { container } = setup();
    const archive = container.querySelector('[aria-label="Archive session"]') as HTMLElement;
    expect(archive).toBeTruthy();
    fireEvent.click(archive);
    expect(invokeMock).toHaveBeenCalledWith('sessions:archive', { id: 's_h', archived: true });
  });

  it('worktree sessions confirm before archive removes the worktree', () => {
    const { container } = setup({ worktreeBranch: 'agent/a' }, true);
    expect((container.querySelector('[aria-label="Archive session"]') as HTMLElement).title).toBe('Archive & remove worktree');
    fireEvent.click(container.querySelector('[aria-label="Archive session"]') as HTMLElement);
    // Confirmation dialog first; nothing is archived until confirmed.
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:archive', expect.anything());
    expect(document.querySelector('.modal')).toBeTruthy();
  });

  it('sums the changed files into one button that opens Changes', async () => {
    setup({}, false, {
      isRepo: true,
      branch: 'main',
      files: [
        { path: 'src/a.ts', status: 'M', staged: false, additions: 12, deletions: 4 },
        { path: 'src/b.ts', status: 'M', staged: true, additions: 3, deletions: 2 },
        // An untracked file reports its line count and no deletions.
        { path: 'notes.md', status: '?', staged: false, additions: 5 }
      ]
    });
    act(() => useStore.setState({ panelTab: 'files', panelOpen: false }));
    const changes = await screen.findByTitle('3 changed files — open Changes');
    expect(changes.textContent).toContain('3 files');
    expect(changes.textContent).toContain('+20');
    // A typographic minus (U+2212), not a hyphen.
    expect(changes.textContent).toContain('−6');
    fireEvent.click(changes);
    expect(useStore.getState().panelTab).toBe('changes');
    expect(useStore.getState().panelOpen).toBe(true);
  });

  it('shows no changed-files button for a clean working tree', async () => {
    setup({}, false, { isRepo: true, branch: 'main', files: [] });
    // The branch crumb comes from the same summary, so it has arrived before the absence is checked.
    await screen.findByTitle('Branch main — open the Git panel');
    expect(screen.queryByTitle(/changed files? — open Changes/)).toBeNull();
  });
});

describe('composer run controls', () => {
  it('names the model by its provider and reads a pasted qualified name back', async () => {
    // A configured provider is what makes the first segment of a typed name a provider.
    useStore.setState({ settings: { providers: [{ id: 'openrouter' }] } } as never);
    const { container } = setupControls({ activeModel: { provider: 'deepseek', model: 'deepseek-v4-flash' } });
    const pill = container.querySelector('[title="Model"]') as HTMLElement;
    expect(pill.textContent).toContain('deepseek/deepseek-v4-flash');

    fireEvent.click(pill);
    fireEvent.click(screen.getByRole('menuitem', { name: /^More models/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'openrouter/deepseek/deepseek-flash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use “openrouter/deepseek/deepseek-flash”' }));

    // The aggregator route survives the round trip: the provider comes from the name, the model
    // keeps its own slash instead of it being read as a second provider boundary.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('sessions:setModel', {
        id: 's_h',
        model: { provider: 'openrouter', model: 'deepseek/deepseek-flash' }
      })
    );
  });

  it('shows effort beside the model and the permission mode as its own pill, with no More menu', () => {
    const { container } = setupControls({ activeEffort: 'high' });
    const pill = container.querySelector('[title="Model"]') as HTMLElement;
    expect(pill.querySelector('.pill-effort')?.textContent).toBe('high');
    expect(screen.queryByRole('button', { name: 'More session controls' })).toBeNull();

    const permission = screen.getByRole('button', { name: 'Permission mode: Ask' });
    fireEvent.click(permission);
    fireEvent.click(screen.getByRole('menuitem', { name: /Accept edits/ }));
    expect(invokeMock).toHaveBeenCalledWith('sessions:setPermissionMode', { id: 's_h', mode: 'accept-edits' });
  });

  it('reads default beside the model while no effort was chosen', () => {
    const { container } = setupControls();
    expect((container.querySelector('[title="Model"] .pill-effort') as HTMLElement).textContent).toBe('default');
  });

  it('explains when a model takes no effort, and drops effort from the pill', () => {
    const haiku = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };
    const { container } = setupControls({ config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask', model: haiku } as SessionMeta['config'] });
    act(() => useStore.setState({ models: { s_h: [{ id: haiku.model, provider: haiku.provider, displayName: 'Haiku 4.5', supportedEfforts: [] }] } }));
    expect(container.querySelector('[title="Model"] .pill-effort')).toBeNull();

    fireEvent.click(container.querySelector('[title="Model"]') as HTMLElement);
    expect((screen.getByRole('menuitem', { name: /^Effort/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Haiku 4.5 does not support reasoning effort')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'high' })).toBeNull();
  });

  it('offers Claude its own effort levels under Effort while the model does not say which it takes', () => {
    const { container } = setupControls({ config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as SessionMeta['config'] });
    fireEvent.click(container.querySelector('[title="Model"]') as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Effort/ }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // Back returns to the model list without closing the menu.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('menuitem', { name: /^Effort/ })).toBeTruthy();
  });

  it('lists starred catalog models plus the current one, and switches with one click', async () => {
    const catalog = [
      { id: 'opus', provider: 'anthropic', displayName: 'Opus' },
      { id: 'fable', provider: 'anthropic', displayName: 'Fable' },
      { id: 'sonnet', provider: 'anthropic', displayName: 'Sonnet' },
      { id: 'haiku', provider: 'anthropic', displayName: 'Haiku' },
      { id: 'mini', provider: 'anthropic', displayName: 'Mini' }
    ];
    // A star for a model this catalog does not list stays out of the short list.
    useStore.setState({ settings: { providers: [], favoriteModels: [{ provider: 'anthropic', model: 'mini' }, { provider: 'openai', model: 'gpt-x' }] } } as never);
    const { container } = setupControls({ activeModel: { provider: 'anthropic', model: 'sonnet' } });
    act(() => useStore.setState({ models: { s_h: catalog } }));

    fireEvent.click(container.querySelector('[title="Model"]') as HTMLElement);
    const rows = [...document.querySelectorAll('.model-menu-models .menu-item-label')].map((row) => row.textContent);
    expect(rows).toEqual(['anthropic/sonnet', 'anthropic/mini']);
    fireEvent.click(screen.getByRole('menuitem', { name: /anthropic\/mini/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:setModel', { id: 's_h', model: { provider: 'anthropic', model: 'mini' } }));
  });

  it('falls back to the first catalog models without stars, and keeps the full picker under More models', () => {
    const catalog = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, provider: 'p', displayName: id.toUpperCase() }));
    useStore.setState({ settings: { providers: [], favoriteModels: [] } } as never);
    const { container } = setupControls({ activeModel: { provider: 'p', model: 'f' } });
    act(() => useStore.setState({ models: { s_h: catalog } }));

    fireEvent.click(container.querySelector('[title="Model"]') as HTMLElement);
    expect([...document.querySelectorAll('.model-menu-models .menu-item-label')].map((row) => row.textContent)).toEqual(['p/a', 'p/b', 'p/c', 'p/d', 'p/f']);
    fireEvent.click(screen.getByRole('menuitem', { name: /^More models/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'p/e' } });
    expect(screen.getByRole('button', { name: /p\/e/ })).toBeTruthy();
  });

  it('remembers a successful reasoning effort switch for the next session', async () => {
    const { container } = setupControls({ activeEffort: 'low' });
    invokeMock.mockClear();
    let resolveSwitch!: (value: unknown) => void;
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'sessions:setEffort') return new Promise((resolve) => { resolveSwitch = resolve; });
      return Promise.resolve({});
    });

    fireEvent.click(container.querySelector('[title="Model"]') as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Effort/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'high' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:setEffort', { id: 's_h', effort: 'high' }));
    expect(invokeMock).not.toHaveBeenCalledWith('settings:update', expect.anything());
    resolveSwitch({});
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('settings:update', { defaultEffort: 'high' }));
  });

  it('does not remember a reasoning effort switch that fails', async () => {
    const { container } = setupControls({ activeEffort: 'low' });
    invokeMock.mockClear();
    invokeMock.mockImplementation((channel: string) => channel === 'sessions:setEffort' ? Promise.reject(new Error('unsupported')) : Promise.resolve({}));

    fireEvent.click(container.querySelector('[title="Model"]') as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Effort/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'high' }));

    await waitFor(() => expect(useStore.getState().toasts.some((toast) => toast.text.includes('unsupported'))).toBe(true));
    expect(invokeMock).not.toHaveBeenCalledWith('settings:update', expect.anything());
  });

  it('keeps the latest effort choice across live and new-session surfaces', async () => {
    setupControls();
    invokeMock.mockClear();
    let resolveHigh!: (value: unknown) => void;
    invokeMock.mockImplementation((channel: string, request: { effort?: string }) => {
      if (channel === 'sessions:setEffort' && request.effort === 'high') return new Promise((resolve) => { resolveHigh = resolve; });
      return Promise.resolve({});
    });

    const liveSwitch = setSessionEffort('s_h', 'high', vi.fn());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:setEffort', { id: 's_h', effort: 'high' }));
    await rememberEffort('max');
    resolveHigh({});
    await liveSwitch;

    expect(invokeMock.mock.calls.filter(([channel]) => channel === 'sessions:setEffort' || channel === 'settings:update')).toEqual([
      ['sessions:setEffort', { id: 's_h', effort: 'high' }],
      ['settings:update', { defaultEffort: 'max' }]
    ]);
  });
});
