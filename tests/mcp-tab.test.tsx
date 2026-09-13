/**
 * The right-panel MCP tab. The behaviour that matters is the trust gate: a server a repo defines
 * must be visibly inert until the user enables it here.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { McpTab } from '../src/renderer/src/components/McpTab';
import { useStore } from '../src/renderer/src/store';
import type { McpProjectInfo, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

const session = (harness: SessionMeta['config']['harness'] = 'claude'): SessionMeta =>
  ({
    id: 's1',
    title: 'Session',
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness, permissionMode: 'ask' },
    status: 'idle',
    harnessRef: {},
    usage: { costUsd: 0 }
  }) as unknown as SessionMeta;

const repoServer = { id: 'repo-db', transport: 'stdio' as const, command: 'npx', args: ['-y', 'db-mcp'] };
const globalServer = { id: 'github', transport: 'stdio' as const, command: 'npx', args: ['-y', 'gh-mcp'] };

function info(over: Partial<McpProjectInfo> = {}): McpProjectInfo {
  return {
    projectRoot: 'G:/repo',
    file: 'G:/repo/.mcp.json',
    display: 'G:/repo/.mcp.json',
    exists: true,
    repo: [repoServer],
    global: [globalServer],
    state: {},
    detected: [],
    effective: [
      { def: repoServer, scope: 'repo', enabled: false, reason: 'not-enabled' },
      { def: globalServer, scope: 'global', enabled: true }
    ],
    harness: 'claude',
    support: 'inject',
    ...over
  };
}

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ settings: { mcpServers: [globalServer], mcpProjectState: {} } as never });
});
afterEach(cleanup);

describe('MCP panel tab', () => {
  it('asks the user to review a repo server before it is active', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => {
      render(<McpTab session={session()} />);
    });
    expect(screen.getByText(/defines 1 MCP server/i)).toBeTruthy();
    expect(screen.getByText(/Enable only the ones you trust/i)).toBeTruthy();
    // Only the global server is listed as active for the session.
    const active = screen.getByText('In this session').closest('.mcp-section');
    expect(active?.textContent).toContain('github');
    expect(active?.textContent).not.toContain('repo-db');
  });

  it('enables a repo server for this repo only', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => {
      render(<McpTab session={session()} />);
    });
    invoke.mockResolvedValue(info({ state: { enabledRepo: ['repo-db'] }, effective: [{ def: repoServer, scope: 'repo', enabled: true }] }));
    await act(async () => {
      fireEvent.click(screen.getByText('Enable'));
    });
    expect(invoke).toHaveBeenCalledWith('mcp:project:state', { sessionId: 's1', patch: { enabledRepo: ['repo-db'] } });
    expect(screen.queryByText(/defines 1 MCP server/i)).toBeNull();
  });

  it('switches a global server off for this repo without touching the global list', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => {
      render(<McpTab session={session()} />);
    });
    const globalSection = screen.getByText('Global').closest('.mcp-section');
    const toggle = globalSection?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(invoke).toHaveBeenCalledWith('mcp:project:state', { sessionId: 's1', patch: { disabledGlobal: ['github'] } });
  });

  it('offers an export instead of injection for a harness that reads its own store', async () => {
    invoke.mockResolvedValue(info({ harness: 'cursor', support: 'inherit', effective: [] }));
    await act(async () => {
      render(<McpTab session={session('cursor')} />);
    });
    expect(screen.getByText(/reads its own MCP configuration/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('Export to .cursor/mcp.json'));
    });
    expect(invoke).toHaveBeenCalledWith('mcp:export', { sessionId: 's1', to: 'cursor' });
  });

  it('says so when the harness has no MCP support at all', async () => {
    invoke.mockResolvedValue(info({ harness: 'pi', support: 'none', effective: [] }));
    await act(async () => {
      render(<McpTab session={session('pi')} />);
    });
    expect(screen.getByText(/no MCP support in the installed version/i)).toBeTruthy();
  });

  it('surfaces a broken .mcp.json instead of silently ignoring it', async () => {
    invoke.mockResolvedValue(info({ repo: [], error: 'Invalid JSON: Unexpected token', effective: [] }));
    await act(async () => {
      render(<McpTab session={session()} />);
    });
    expect(screen.getByText(/Invalid JSON/)).toBeTruthy();
  });
});
