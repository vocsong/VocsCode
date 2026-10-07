/**
 * Split view through the real App: two sessions on screen at once, each in its own pane with its own
 * transcript and composer, the active pane deciding what the global panels show, and closing a pane
 * leaving its session alone.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import type { AppSettings, SessionMeta, TranscriptItem } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: vi.fn(), isMac: false, isWeb: false, platform: 'win32', modKey: 'Ctrl', canInvoke: () => true }));
vi.mock('../src/renderer/src/terminal/host', () => ({ createTerminal: vi.fn().mockResolvedValue(null) }));

import { App } from '../src/renderer/src/App';
import { useStore } from '../src/renderer/src/store';
import { singlePaneLayout } from '../src/renderer/src/panes';

const settings = {
  theme: 'dark',
  defaultHarness: 'native',
  defaultPermissionMode: 'ask',
  defaultModelByHarness: {},
  favoriteModels: [],
  acpAgents: [],
  providers: [],
  mcpServers: [],
  modelOverrides: {},
  binaries: {},
  recentProjects: [],
  folders: [],
  folderStyles: {},
  customLabels: [],
  collapsedFolders: [],
  customShortcuts: {},
  sidebarWidth: 260,
  panelWidth: 380,
  panelSplit: 0.62,
  goalDefaults: { autoContinue: true, maxIterations: 25 },
  terminal: {},
  onboardingDone: true,
  agent: { enabled: false }
} as unknown as AppSettings;

const session = (id: string, title: string, cwd: string, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title,
  createdAt: 1_000,
  updatedAt: 1_000,
  config: { harness: 'native', projectRoot: '/repo', permissionMode: 'ask' } as SessionMeta['config'],
  cwd,
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});

const A = session('s_a', 'Architecture', '/worktrees/architecture', { worktreeBranch: 'feature/architecture' });
const B = session('s_b', 'Tests', '/worktrees/tests', { worktreeBranch: 'feature/tests', config: { harness: 'codex', projectRoot: '/repo', permissionMode: 'ask' } as SessionMeta['config'] });
const user = (id: string, text: string): TranscriptItem => ({ id, kind: 'user', ts: 1, text });

const panes = () => [...document.querySelectorAll<HTMLElement>('[data-testid="session-pane"]')];
const paneText = (i: number) => panes()[i]?.querySelector('.transcript')?.textContent ?? '';
const sidebarRow = (id: string) => document.querySelector<HTMLElement>(`.session-row[data-session-id="${id}"]`)!;

/** jsdom has no DataTransfer; this is the subset a sidebar drag uses. */
function dataTransfer() {
  const data: Record<string, string> = {};
  return { types: [] as string[], dropEffect: 'none', effectAllowed: 'all', setData(k: string, v: string) { data[k] = v; this.types.push(k); }, getData: (k: string) => data[k] ?? '' };
}

/** jsdom has no DragEvent, so the pointer position is set on the event by hand. */
function drag(type: 'dragOver' | 'drop', el: HTMLElement, dt: ReturnType<typeof dataTransfer>, clientX: number, clientY: number) {
  const ev = createEvent[type](el, { dataTransfer: dt });
  Object.defineProperty(ev, 'clientX', { value: clientX });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  fireEvent(el, ev);
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'harness:models') return { models: [] };
    if (channel === 'git:summary') return null;
    return {};
  });
  useStore.setState({
    booted: true,
    bootError: null,
    settings,
    sessions: [A, B],
    transcripts: { s_a: [user('u_a', 'alpha question')], s_b: [user('u_b', 'beta question')] },
    loaded: { s_a: true, s_b: true },
    activeId: 's_a',
    layout: singlePaneLayout('s_a'),
    view: 'chat',
    sidebarOpen: true,
    panelOpen: false,
    composerInsert: null,
    history: [],
    historyIndex: -1
  } as never);
});

afterEach(async () => {
  await act(async () => { cleanup(); });
  vi.unstubAllGlobals();
});

async function splitWithB() {
  fireEvent.click(document.querySelector('[aria-label="Split right"]')!);
  await waitFor(() => expect(panes()).toHaveLength(2));
  fireEvent.click(sidebarRow('s_b'));
  await waitFor(() => expect(paneText(1)).toContain('beta question'));
}

describe('split view', () => {
  it('renders exactly one pane with no split chrome until the user splits', () => {
    render(<App />);
    expect(panes()).toHaveLength(1);
    expect(document.querySelector('.panes.split')).toBeNull();
    expect(document.querySelector('[aria-label="Close pane"]')).toBeNull();
    expect(document.querySelector('.pane-divider')).toBeNull();
    expect(paneText(0)).toContain('alpha question');
  });

  it('splits right, keeps the original session, and opens the sidebar pick in the new active pane', async () => {
    render(<App />);
    const original = panes()[0]!.querySelector('.transcript');
    fireEvent.click(document.querySelector('[aria-label="Split right"]')!);
    await waitFor(() => expect(panes()).toHaveLength(2));
    // The new pane waits for a choice; the first pane is the same mounted transcript as before.
    expect(panes()[1]!.textContent).toContain('Open a session in this pane');
    expect(panes()[0]!.querySelector('.transcript')).toBe(original);
    expect(useStore.getState().activeId).toBeNull();

    fireEvent.click(sidebarRow('s_b'));
    await waitFor(() => expect(paneText(1)).toContain('beta question'));
    expect(paneText(0)).toContain('alpha question');
    expect(paneText(0)).not.toContain('beta question');
    expect(useStore.getState().activeId).toBe('s_b');
    expect(panes()[1]!.classList.contains('active')).toBe(true);
    expect(document.querySelectorAll('.composer textarea')).toHaveLength(2);
    expect(document.querySelectorAll('.pane-divider')).toHaveLength(1);
  });

  it('makes a clicked pane active, and a sidebar click then replaces only that pane', async () => {
    render(<App />);
    await splitWithB();
    fireEvent.pointerDown(panes()[0]!.querySelector('.transcript')!);
    expect(useStore.getState().activeId).toBe('s_a');
    expect(panes()[0]!.classList.contains('active')).toBe(true);

    // Clicking a session already on screen focuses its pane instead of opening it twice.
    fireEvent.click(sidebarRow('s_b'));
    await waitFor(() => expect(useStore.getState().activeId).toBe('s_b'));
    expect(paneText(0)).toContain('alpha question');
    expect(paneText(1)).toContain('beta question');
  });

  it('streams into one pane without remounting or touching the other', async () => {
    render(<App />);
    await splitWithB();
    const left = panes()[0]!.querySelector('.transcript')!;
    act(() => {
      useStore.getState().applyEvent({ sessionId: 's_b', event: { type: 'item.upsert', item: { id: 'a_b', kind: 'assistant', ts: 2, text: 'tests are running' } } } as never);
    });
    await waitFor(() => expect(paneText(1)).toContain('tests are running'));
    expect(panes()[0]!.querySelector('.transcript')).toBe(left);
    expect(paneText(0)).not.toContain('tests are running');
  });

  it('keeps a pane scrolled back in history while new output arrives, and counts what it has not seen', async () => {
    render(<App />);
    await splitWithB();
    const [left, right] = panes().map((p) => p.querySelector<HTMLElement>('.transcript')!);
    for (const el of [left!, right!]) {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 });
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 500 });
    }
    // The reader scrolls the left pane up into history; the right pane keeps following.
    left!.scrollTop = 100;
    fireEvent.scroll(left!);
    await waitFor(() => expect(panes()[0]!.querySelector('.jump-bottom')?.textContent).toContain('Jump to latest'));
    act(() => {
      useStore.getState().applyEvent({ sessionId: 's_a', event: { type: 'item.upsert', item: { id: 'a_a1', kind: 'assistant', ts: 2, text: 'designing the state machine' } } } as never);
      useStore.getState().applyEvent({ sessionId: 's_a', event: { type: 'item.upsert', item: { id: 'a_a2', kind: 'assistant', ts: 3, text: 'second step' } } } as never);
      useStore.getState().applyEvent({ sessionId: 's_b', event: { type: 'item.upsert', item: { id: 'a_b', kind: 'assistant', ts: 2, text: 'running tests' } } } as never);
    });
    await waitFor(() => expect(panes()[0]!.querySelector('.jump-bottom')?.textContent).toContain('2 new'));
    expect(left!.scrollTop).toBe(100);
    expect(right!.scrollTop).toBe(2000);
    expect(panes()[1]!.querySelector('.jump-bottom')).toBeNull();

    fireEvent.click(panes()[0]!.querySelector('.jump-bottom')!);
    await waitFor(() => expect(panes()[0]!.querySelector('.jump-bottom')).toBeNull());
    expect(left!.scrollTop).toBe(2000);
  });

  it('sends what the user types to the pane it was typed in', async () => {
    render(<App />);
    await splitWithB();
    const [composerA] = [...document.querySelectorAll<HTMLTextAreaElement>('.composer textarea')];
    fireEvent.pointerDown(composerA!);
    fireEvent.change(composerA!, { target: { value: 'steer the architecture' } });
    fireEvent.keyDown(composerA!, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:send', expect.objectContaining({ id: 's_a' })));
    const sends = invoke.mock.calls.filter(([channel]) => channel === 'sessions:send');
    expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0]![1])).toContain('steer the architecture');
    expect(useStore.getState().drafts.s_b ?? '').toBe('');
  });

  it('hands text inserted from elsewhere to the active pane only', async () => {
    render(<App />);
    await splitWithB();
    act(() => useStore.getState().insertIntoComposer('terminal output'));
    const [composerA, composerB] = [...document.querySelectorAll<HTMLTextAreaElement>('.composer textarea')];
    await waitFor(() => expect(composerB!.value).toBe('terminal output'));
    expect(composerA!.value).toBe('');
  });

  it('opens Find only in the active pane', async () => {
    render(<App />);
    await splitWithB();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    await waitFor(() => expect(panes()[1]!.querySelector('.find-bar')).not.toBeNull());
    expect(panes()[0]!.querySelector('.find-bar')).toBeNull();
  });

  it('points the global panels at the active pane’s worktree', async () => {
    render(<App />);
    await splitWithB();
    act(() => useStore.getState().togglePanel(true));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git:diff', expect.objectContaining({ sessionId: 's_b' })));
    invoke.mockClear();
    fireEvent.pointerDown(panes()[0]!.querySelector('.transcript')!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git:diff', expect.objectContaining({ sessionId: 's_a' })));
    expect(invoke).not.toHaveBeenCalledWith('git:diff', expect.objectContaining({ sessionId: 's_b' }));
  });

  it('closes a pane without stopping, archiving or deleting its session', async () => {
    render(<App />);
    await splitWithB();
    invoke.mockClear();
    fireEvent.click(panes()[1]!.querySelector('[aria-label="Close pane"]')!);
    await waitFor(() => expect(panes()).toHaveLength(1));
    expect(useStore.getState().activeId).toBe('s_a');
    expect(paneText(0)).toContain('alpha question');
    const lifecycle = invoke.mock.calls.filter(([channel]) => /^sessions:(stop|interrupt|archive|delete)/.test(String(channel)));
    expect(lifecycle).toEqual([]);
    expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['s_a', 's_b']);
    expect(useStore.getState().transcripts.s_b).toHaveLength(1);
    expect(sidebarRow('s_b')).toBeTruthy();
    expect(document.querySelector('.panes.split')).toBeNull();
  });

  it('closes the other pane when its session is archived, leaving the active one alone', async () => {
    render(<App />);
    await splitWithB();
    fireEvent.pointerDown(panes()[0]!.querySelector('.transcript')!);
    act(() => useStore.getState().setSessions([A, { ...B, archived: true }]));
    await waitFor(() => expect(panes()).toHaveLength(1));
    expect(useStore.getState().activeId).toBe('s_a');
    expect(paneText(0)).toContain('alpha question');
  });

  it('splits when a sidebar session is dropped on a pane edge and swaps when dropped on the other pane', async () => {
    render(<App />);
    const pane = panes()[0]!;
    pane.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    const dt = dataTransfer();
    fireEvent.dragStart(sidebarRow('s_b'), { dataTransfer: dt });
    drag('dragOver', pane, dt, 980, 400);
    expect(pane.querySelector('.pane-drop-right')).not.toBeNull();
    drag('drop', pane, dt, 980, 400);
    await waitFor(() => expect(paneText(1)).toContain('beta question'));
    expect(paneText(0)).toContain('alpha question');
    expect(useStore.getState().activeId).toBe('s_b');

    // Dropping B onto A's pane moves it there; A takes B's place.
    const left = panes()[0]!;
    left.getBoundingClientRect = pane.getBoundingClientRect;
    drag('drop', left, dt, 500, 400);
    await waitFor(() => expect(paneText(0)).toContain('beta question'));
    expect(paneText(1)).toContain('alpha question');
  });
});

describe('split restore at boot', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ booted: false, settings: null, sessions: [], activeId: null, layout: singlePaneLayout(), transcripts: {}, loaded: {} } as never);
    invoke.mockImplementation(async (channel: string, payload?: { id?: string }) => {
      if (channel === 'settings:get') return settings;
      if (channel === 'sessions:list') return [A, B];
      if (channel === 'terminal:list') return [];
      if (channel === 'sessions:transcript') return payload?.id === 's_b' ? [user('u_b', 'beta question')] : [user('u_a', 'alpha question')];
      if (channel === 'missions:list') return [];
      return null;
    });
  });

  it('brings back the last split with both transcripts loaded and the saved pane active', async () => {
    localStorage.setItem('vocs-code.sessionLayout', JSON.stringify({ orientation: 'vertical', panes: [{ id: 'p1', sessionId: 's_a' }, { id: 'p2', sessionId: 's_b' }], activePaneId: 'p2', sizes: [0.7, 0.3] }));
    await useStore.getState().boot();
    const st = useStore.getState();
    expect(st.layout.orientation).toBe('vertical');
    expect(st.layout.panes.map((p) => p.sessionId)).toEqual(['s_a', 's_b']);
    expect(st.activeId).toBe('s_b');
    expect(st.loaded).toMatchObject({ s_a: true, s_b: true });
  });

  it('falls back to the first session when the saved split names sessions that are gone', async () => {
    localStorage.setItem('vocs-code.sessionLayout', JSON.stringify({ orientation: 'horizontal', panes: [{ id: 'p1', sessionId: 's_gone' }, { id: 'p2', sessionId: 's_also_gone' }], activePaneId: 'p2', sizes: [0.5, 0.5] }));
    await useStore.getState().boot();
    const st = useStore.getState();
    expect(st.layout.panes.map((p) => p.sessionId)).toEqual(['s_a']);
    expect(st.activeId).toBe('s_a');
  });
});
