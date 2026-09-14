/**
 * The right-panel MCP tab keeps the GitNexus controls and repo server trust gate clear.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { McpTab } from '../src/renderer/src/components/McpTab';
import { useStore } from '../src/renderer/src/store';
import type { McpProjectInfo, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

const session = (): SessionMeta => ({
  id: 's1', title: 'Session', cwd: 'G:/repo',
  config: { projectRoot: 'G:/repo', harness: 'claude', permissionMode: 'ask' },
  status: 'idle', harnessRef: {}, usage: { costUsd: 0 }
} as unknown as SessionMeta);

const repoServer = { id: 'repo-db', transport: 'stdio' as const, command: 'npx', args: ['-y', 'db-mcp'] };
const gitnexus = { id: 'gitnexus', transport: 'stdio' as const, command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'] };

function info(over: Partial<McpProjectInfo> = {}): McpProjectInfo {
  return {
    projectRoot: 'G:/repo', file: 'G:/repo/.mcp.json', display: 'G:/repo/.mcp.json', exists: true,
    repo: [repoServer], global: [], state: {},
    builtin: [{ def: gitnexus, enabled: true, shared: false, indexed: false, claimed: false }],
    detected: [], effective: [{ def: repoServer, scope: 'repo', enabled: false, reason: 'not-enabled' }],
    harness: 'claude', support: 'inject', ...over
  };
}

beforeEach(() => {
  invoke.mockReset();
  useStore.setState({ settings: { mcpServers: [], mcpProjectState: {} } as never });
});
afterEach(cleanup);

describe('MCP panel tab', () => {
  it('puts the GitNexus global card before the repo configuration', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => { render(<McpTab session={session()} />); });
    const sections = screen.getAllByRole('heading', { level: 3 });
    expect(sections.map((h) => h.textContent)).toEqual(['Global', 'This repo']);
    expect(screen.getByTestId('gitnexus-card').textContent).toContain('built-in');
    expect(screen.getByTestId('mcp-add-server').textContent).toContain('Add MCP server');
    expect(screen.queryByText('In this session')).toBeNull();
    expect(screen.queryByText('Detected in this repo')).toBeNull();
  });

  it('labels and persists GitNexus enable and share switches', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => { render(<McpTab session={session()} />); });
    expect(screen.getByLabelText('Enable GitNexus for this repo')).toBeTruthy();
    expect(screen.getByLabelText("Share this repo's graph with other repos")).toBeTruthy();
    invoke.mockResolvedValue(info({ state: { disabledBuiltin: ['gitnexus'] }, builtin: [{ def: gitnexus, enabled: false, shared: false, indexed: false, claimed: false }] }));
    await act(async () => { fireEvent.click(screen.getByLabelText('Enable GitNexus for this repo')); });
    expect(invoke).toHaveBeenCalledWith('mcp:project:state', { sessionId: 's1', patch: { disabledBuiltin: ['gitnexus'] } });
  });

  it('indexes from the current repo and refreshes the project info', async () => {
    invoke.mockResolvedValueOnce(info()).mockResolvedValueOnce({ ok: true, output: 'done' }).mockResolvedValueOnce(info({ builtin: [{ def: gitnexus, enabled: true, shared: false, indexed: true, claimed: false }] }));
    await act(async () => { render(<McpTab session={session()} />); });
    await act(async () => { fireEvent.click(screen.getByTestId('gitnexus-index')); });
    expect(invoke).toHaveBeenCalledWith('mcp:project:index', { sessionId: 's1' });
    expect(await screen.findByText('Index is ready.')).toBeTruthy();
  });

  it('keeps repo servers behind an explicit trust action', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => { render(<McpTab session={session()} />); });
    expect(screen.getByText(/Review servers before enabling them/)).toBeTruthy();
    invoke.mockResolvedValue(info({ state: { enabledRepo: ['repo-db'] }, effective: [{ def: repoServer, scope: 'repo', enabled: true }] }));
    await act(async () => { fireEvent.click(screen.getByText('Enable')); });
    expect(invoke).toHaveBeenCalledWith('mcp:project:state', { sessionId: 's1', patch: { enabledRepo: ['repo-db'] } });
  });
});
