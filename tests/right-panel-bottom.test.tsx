/** @vitest-environment jsdom */
/**
 * The right panel unmounts whenever the user leaves the chat view (Settings, Analytics, Skills, MCP)
 * or closes the panel, and it mounts each lower-half tab lazily the first time it is opened. The set
 * of already-opened tabs therefore has to live in the store: keeping it in component state made the
 * still-selected tab render blank on the way back, because the panel re-mounted with nothing marked
 * open while `panelBottomTab` still pointed at that tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  invoke: invokeMock,
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
import type { McpProjectInfo, SessionMeta } from '../src/shared/types';

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

const MCP_INFO: McpProjectInfo = {
  projectRoot: 'G:/proj/a',
  file: 'G:/proj/a/.mcp.json',
  display: '.mcp.json',
  exists: false,
  repo: [],
  global: [],
  state: {},
  builtin: [],
  detected: [],
  effective: [],
  harness: 'native',
  support: 'inject'
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'mcp:project') return Promise.resolve(MCP_INFO);
    if (channel === 'cua:status') return Promise.resolve({ installed: false, mode: 'standard', ready: false, note: 'Cua Driver is not installed on this machine.' });
    return Promise.resolve({});
  });
  useStore.setState({ panelTab: 'goal', panelBottomTab: 'mcp', panelBottomOpened: [], toasts: [] });
});

afterEach(cleanup);

describe('right panel bottom half', () => {
  it('keeps the selected tab mounted after the panel unmounts and comes back', async () => {
    const first = render(<RightPanel session={session()} />);
    // Lazy on first view: the default MCP tab has not been opened, so nothing is fetched yet.
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'mcp:project')).toBe(false);
    expect(screen.queryByTestId('mcp-global-section')).toBeNull();

    // Opening the tab loads it.
    await act(async () => {
      fireEvent.click(screen.getByTestId('panel-bottom-mcp'));
    });
    expect(await screen.findByTestId('mcp-global-section')).toBeTruthy();

    // Navigating to Settings unmounts the panel; returning re-mounts it with the same selected tab.
    first.unmount();
    render(<RightPanel session={session()} />);
    expect(await screen.findByTestId('mcp-global-section')).toBeTruthy();
  });

  it('mounts the Desktop tab lazily and shows the Cua card when the driver is not ready', async () => {
    render(<RightPanel session={session()} />);
    // Not opened yet, so the preview has not been asked for.
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'cua:preview')).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId('panel-bottom-desktop'));
    });
    expect(await screen.findByTestId('cua-card')).toBeTruthy();
    expect(screen.queryByTestId('desktop-tab')).toBeNull();
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'cua:preview')).toBe(false);
  });
});
