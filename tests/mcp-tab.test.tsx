/**
 * The right-panel MCP tab keeps the GitNexus controls and repo server trust gate clear.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { McpTab } from '../src/renderer/src/components/McpTab';
import { MEMORY_GUIDE_MARKDOWN, MEMORY_GUIDE_TITLE } from '../src/shared/memory-guide';
import { authorityLabel } from '../src/shared/knowledge';
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
    // The snippet leads the Global section, ahead of the server cards it teaches agents to use.
    const global = screen.getByTestId('mcp-global-section');
    expect(global.querySelector('.mcp-card')).toBe(screen.getByTestId('memory-guide'));
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

  it('keeps the built-in Cua Driver out of one repo with the same switch', async () => {
    const cua = { id: 'cua-driver', transport: 'stdio' as const, command: 'cua-driver', args: ['mcp'] };
    invoke.mockResolvedValue(
      info({
        builtin: [
          { def: gitnexus, enabled: true, shared: false, indexed: false, claimed: false },
          { def: cua, enabled: true, shared: false, indexed: true, claimed: false }
        ]
      })
    );
    await act(async () => { render(<McpTab session={session()} />); });
    await act(async () => { fireEvent.click(screen.getByLabelText('Enable computer use for this repo')); });
    expect(invoke).toHaveBeenCalledWith('mcp:project:state', { sessionId: 's1', patch: { disabledBuiltin: ['cua-driver'] } });
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

describe('AGENTS.md memory snippet', () => {
  it('stays collapsed until asked for, then copies the three-layer snippet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    invoke.mockResolvedValue(info());
    await act(async () => { render(<McpTab session={session()} />); });

    const toggle = screen.getByTestId('memory-guide-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('memory-guide-text')).toBeNull();
    expect(screen.queryByTestId('memory-guide-copy')).toBeNull();

    await act(async () => { fireEvent.click(toggle); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = screen.getByTestId('memory-guide-text');
    // Copy sits above the snippet: the button must not be pushed off-screen by a long body.
    const copy = screen.getByTestId('memory-guide-copy');
    expect(copy.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const shown = body.textContent ?? '';
    expect(shown).toContain(MEMORY_GUIDE_TITLE);
    for (const tool of ['query', 'context', 'impact', 'knowledge_search', 'knowledge_propose', 'session_history_search']) {
      expect(shown).toContain(tool);
    }

    await act(async () => { fireEvent.click(screen.getByTestId('memory-guide-copy')); });
    expect(writeText).toHaveBeenCalledWith(MEMORY_GUIDE_MARKDOWN);
  });

  it('names every layer the app actually serves, and no layer it does not', () => {
    expect(MEMORY_GUIDE_MARKDOWN).toContain('**L1 — the code graph.**');
    expect(MEMORY_GUIDE_MARKDOWN).toContain('**L2 — the project wiki.**');
    expect(MEMORY_GUIDE_MARKDOWN).toContain('**L3 — session history.**');
    expect(MEMORY_GUIDE_MARKDOWN).not.toContain('L4');
    // The repo is scoped per session; a pasted snippet must never teach agents to pass `repo`.
    expect(MEMORY_GUIDE_MARKDOWN).toContain('Never pass `repo`');
  });

  it('promises no accept gate for knowledge_propose, and names the rung the write actually lands on', async () => {
    // `knowledge_propose` serializes `status: current` with `updated_by: agent:mcp` and answers
    // "writes immediately: nothing is queued for human review" (resources/mcp/vocs-memory.mjs), so
    // the pasted snippet must not teach an agent to wait for a human to accept or reject the page.
    invoke.mockResolvedValue(info());
    await act(async () => { render(<McpTab session={session()} />); });
    await act(async () => { fireEvent.click(screen.getByTestId('memory-guide-toggle')); });
    const shown = screen.getByTestId('memory-guide-text').textContent ?? '';

    // The rung comes from the code, not a restatement: the snippet has to name what search returns.
    const rung = authorityLabel({ status: 'current', updatedBy: 'agent:mcp' });
    expect(rung).toBe('accepted');
    expect(shown).toContain('rung `' + rung + '`');
    expect(shown).toContain('nothing waiting on a human');
    expect(shown).not.toMatch(/accepts or rejects/i);
  });
});
