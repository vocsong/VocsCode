/**
 * The global MCP page's built-in GitNexus section: one shared server, one toggle, no edit row.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { McpView } from '../src/renderer/src/components/McpView';
import { useStore } from '../src/renderer/src/store';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ canInvoke: () => true, invoke, isMac: false, modKey: 'Ctrl' }));

const gitnexusEntry = { id: 'gitnexus', transport: 'stdio' as const, command: 'cmd', args: ['/c', 'npx', '-y', 'gitnexus@latest', 'mcp'] };
const otherEntry = { id: 'github', transport: 'stdio' as const, command: 'npx', args: ['-y', 'gh-mcp'] };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  useStore.setState({ settings: { mcpServers: [], mcpProjectState: {} } as never });
});
afterEach(cleanup);

const builtinToggle = () => {
  const card = screen.getByText('GitNexus').closest('.mcp-card');
  const buttons = Array.from(card?.querySelectorAll('button') ?? []).filter((b) => b.title === 'Edit' || b.title === 'Remove');
  expect(buttons).toEqual([]);
  return card?.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

describe('MCP page GitNexus section', () => {
  it('describes the one shared server and leaves the per-repo switch to the panel tab', async () => {
    await act(async () => {
      render(<McpView />);
    });
    expect(screen.getByText('GitNexus')).toBeTruthy();
    expect(screen.getByText(/one shared process serves every indexed repo/)).toBeTruthy();
    // The serving mode is no longer a choice, so the page writes no such setting.
    expect(screen.queryByText('Per-repo servers')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('settings:update', expect.objectContaining({ gitnexus: expect.anything() }));
  });

  it('switches the built-in off everywhere from its own toggle', async () => {
    await act(async () => {
      render(<McpView />);
    });
    expect(builtinToggle().checked).toBe(true);
    await act(async () => {
      fireEvent.click(builtinToggle());
    });
    expect(invoke).toHaveBeenCalledWith('settings:update', { mcpDisabledBuiltins: ['gitnexus'] });
  });

  it('flips the app-wide switch back on', async () => {
    useStore.setState({ settings: { mcpServers: [], mcpDisabledBuiltins: ['gitnexus'], mcpProjectState: {} } as never });
    await act(async () => {
      render(<McpView />);
    });
    expect(builtinToggle().checked).toBe(false);
    await act(async () => {
      fireEvent.click(builtinToggle());
    });
    expect(invoke).toHaveBeenCalledWith('settings:update', { mcpDisabledBuiltins: [] });
  });

  it('does not list a leftover same-id global entry beside the built-in', async () => {
    useStore.setState({ settings: { mcpServers: [gitnexusEntry, otherEntry], mcpProjectState: {} } as never });
    await act(async () => {
      render(<McpView />);
    });
    // The dead duplicate is a row named exactly `gitnexus`; only `github` and the built-in remain.
    expect(screen.queryByText('gitnexus')).toBeNull();
    expect(screen.queryByText('cmd /c npx -y gitnexus@latest mcp')).toBeNull();
    expect(screen.getByText('github')).toBeTruthy();
    // The count reflects user servers only.
    expect(screen.getByText('1 global')).toBeTruthy();
  });
});
