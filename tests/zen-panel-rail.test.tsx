/** @vitest-environment jsdom */
/**
 * Zen's side panel and pins. In Zen the panel is one rail of icons on the window's right edge (the six
 * workspace views and the five live services, no tab strips) whose drawer shows one view at a time:
 * the half asked for last. Something other than the pointer asking for the panel — a file link, the
 * usage meter — makes it peek out, until a press lands outside it. Either side can be pinned open, and
 * the pins are kept in this window's localStorage so they survive a restart. Standard keeps its two
 * tab strips. The layout itself is CSS; e2e.ui-modes checks the geometry in the real window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  canInvoke: () => true,
  invoke: invokeMock,
  invokeErrorMessage: (e: unknown) => String(e),
  on: vi.fn().mockReturnValue(() => undefined),
  isMac: false,
  modKey: 'Ctrl',
  platform: 'win32',
  isWeb: false,
  webShim: vi.fn()
}));

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { useStore } from '../src/renderer/src/store';
import { loadPins, NO_PINS, savePins } from '../src/renderer/src/pins';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const session = (): SessionMeta =>
  ({
    id: 's1',
    title: 'test',
    createdAt: 1,
    updatedAt: 2,
    config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
    cwd: 'G:/proj/a',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  }) as SessionMeta;

const settings = (uiMode: AppSettings['uiMode']) => ({ uiMode, panelSplit: 0.62, panelWidth: 420, sidebarWidth: 280 }) as AppSettings;

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'git:summary') return Promise.resolve({ isRepo: true, branch: 'main', files: [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 0 }] });
    if (channel === 'processes:list') return Promise.resolve({ processes: [] });
    return Promise.resolve({});
  });
  useStore.setState({ settings: settings('zen'), panelOpen: true, panelTab: 'changes', panelBottomTab: 'mcp', panelBottomOpened: [], panelFocus: 'top', panelPeek: false, pins: NO_PINS, toasts: [] });
});

afterEach(cleanup);

const panel = (container: HTMLElement) => container.querySelector('aside.panel') as HTMLElement;
const title = (container: HTMLElement) => container.querySelector('.panel-head-title')?.textContent;

it.each(['standard', 'zen'] as const)('uses distinct service icons in %s mode', async (mode) => {
  useStore.setState({ settings: settings(mode) });
  await act(async () => { render(<RightPanel session={session()} />); });
  for (const [label, icon] of Object.entries({
    MCP: 'plug',
    Desktop: 'monitor',
    Subagents: 'robot',
    Knowledge: 'bookOpen',
    Processes: 'listTree'
  })) {
    const button = screen.getByRole('button', { name: label });
    expect(button.querySelector('svg')?.getAttribute('data-icon'), label).toBe(icon);
  }
});

describe('Zen side panel rail', () => {
  it('draws one rail of eleven icons in place of the two tab strips, with the changes dot', async () => {
    const { container } = render(<RightPanel session={session()} />);
    const rail = screen.getByRole('navigation', { name: 'Side panel' });
    expect(rail.querySelectorAll('.panel-tab')).toHaveLength(11);
    expect(container.querySelector('.panel-tabs')).toBeNull();
    expect(Array.from(rail.querySelectorAll('.panel-tab')).map((b) => b.getAttribute('aria-label'))).toEqual(['Changes', 'Files', 'Git', 'Goal', 'Usage', 'Terminal', 'MCP', 'Desktop', 'Subagents', 'Knowledge', 'Processes']);
    expect(await screen.findByTestId('panel-changes-dot')).toBeTruthy();
    expect(screen.getByTestId('panel-top-changes').getAttribute('title')).toBe('Changes · 1 changed file');
  });

  it('shows one view at a time: the half picked last, named in the drawer head', async () => {
    const { container } = render(<RightPanel session={session()} />);
    expect(panel(container).dataset.focus).toBe('top');
    expect(title(container)).toBe('Changes');

    await act(async () => fireEvent.click(screen.getByTestId('panel-bottom-processes')));
    expect(panel(container).dataset.focus).toBe('bottom');
    expect(title(container)).toBe('Processes');
    expect(screen.getByTestId('panel-bottom-processes').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('panel-top-changes').getAttribute('aria-current')).toBeNull();

    await act(async () => fireEvent.click(screen.getByTestId('panel-top-goal')));
    expect(panel(container).dataset.focus).toBe('top');
    expect(title(container)).toBe('Goal');
  });

  it('peeks when something asks for the panel, and folds back on a press outside it but not on its own trigger', async () => {
    const outside = document.body.appendChild(document.createElement('button'));
    const trigger = document.body.appendChild(document.createElement('button'));
    trigger.setAttribute('data-panel-trigger', '');
    const { container } = render(<RightPanel session={session()} />);
    expect(panel(container).hasAttribute('data-peek')).toBe(false);

    act(() => useStore.getState().revealSubagentRun('s1', 'run-1'));
    expect(panel(container).hasAttribute('data-peek')).toBe(true);
    expect(panel(container).dataset.focus).toBe('bottom');

    // A press inside the drawer, or on a control that toggles the panel itself, keeps the peek.
    act(() => { fireEvent.pointerDown(screen.getByTestId('panel-top-files')); });
    act(() => { fireEvent.pointerDown(trigger); });
    expect(useStore.getState().panelPeek).toBe(true);
    act(() => { fireEvent.pointerDown(outside); });
    expect(useStore.getState().panelPeek).toBe(false);
    expect(panel(container).hasAttribute('data-peek')).toBe(false);
    outside.remove();
    trigger.remove();
  });

  it('pins open from the drawer head, and the pin is saved for the next launch', async () => {
    const { container } = render(<RightPanel session={session()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pin side panel' })));
    expect(panel(container).hasAttribute('data-pinned')).toBe(true);
    expect(loadPins()).toEqual({ left: false, right: true });
    expect(screen.getByRole('button', { name: 'Unpin side panel' }).getAttribute('aria-pressed')).toBe('true');

    act(() => useStore.getState().togglePin('left'));
    expect(loadPins()).toEqual({ left: true, right: true });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Unpin side panel' })));
    expect(panel(container).hasAttribute('data-pinned')).toBe(false);
    expect(loadPins()).toEqual({ left: true, right: false });
  });

  it('keeps the Standard panel as two tab strips with no rail, peek or pin markup', () => {
    useStore.setState({ settings: settings('standard'), panelPeek: true, pins: { left: true, right: true } });
    const { container } = render(<RightPanel session={session()} />);
    expect(container.querySelectorAll('.panel-tabs')).toHaveLength(2);
    expect(screen.queryByRole('navigation', { name: 'Side panel' })).toBeNull();
    expect(container.querySelector('.panel-head')).toBeNull();
    const aside = panel(container);
    expect(aside.hasAttribute('data-focus') || aside.hasAttribute('data-peek') || aside.hasAttribute('data-pinned')).toBe(false);
  });
});

describe('panel requests', () => {
  it('route each tab to its half and make the panel peek; closing ends the peek', () => {
    const st = () => useStore.getState();
    st().setPanelTab('mcp');
    expect([st().panelFocus, st().panelBottomTab, st().panelPeek]).toEqual(['bottom', 'mcp', true]);
    st().endPanelPeek();
    st().setPanelTab('terminal');
    expect([st().panelFocus, st().panelTab, st().panelPeek]).toEqual(['top', 'terminal', true]);
    st().togglePanel(false);
    expect([st().panelOpen, st().panelPeek]).toEqual([false, false]);
    st().togglePanel();
    expect([st().panelOpen, st().panelPeek]).toEqual([true, true]);
  });
});

describe('pins storage', () => {
  it('reads only real pins back and survives unusable storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadPins(storage)).toEqual(NO_PINS);
    savePins({ left: true, right: false }, storage);
    expect(loadPins(storage)).toEqual({ left: true, right: false });
    store.set('vocs-code.pins', '{"left":"yes","right":1}');
    expect(loadPins(storage)).toEqual(NO_PINS);
    store.set('vocs-code.pins', 'not json');
    expect(loadPins(storage)).toEqual(NO_PINS);
    expect(() => savePins({ left: true, right: true }, { setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});
