/**
 * The Project knowledge panel: pages render with their authority, proposals need an explicit
 * decision, and the background jobs are reachable. @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KnowledgeTab } from '../src/renderer/src/components/KnowledgeTab';
import type { KnowledgePageSummary, KnowledgeView } from '../src/shared/knowledge';
import type { SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

const session = (): SessionMeta =>
  ({
    id: 's1',
    title: 'Session',
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness: 'claude', permissionMode: 'ask' },
    status: 'idle',
    harnessRef: {},
    usage: { costUsd: 0 }
  }) as unknown as SessionMeta;

function summary(over: Partial<KnowledgePageSummary> = {}): KnowledgePageSummary {
  return {
    id: 'conventions/harness-lifecycle',
    title: 'Harness lifecycle',
    kind: 'convention',
    status: 'current',
    scope: 'repo',
    path: 'conventions/harness-lifecycle.md',
    claim: 'A harness belongs to exactly one session.',
    keywords: ['harness'],
    authority: 2,
    ...over
  };
}

function view(over: Partial<KnowledgeView> = {}): KnowledgeView {
  return {
    projectRoot: 'G:/repo',
    cwd: 'G:/repo',
    wikiDir: 'G:/repo/.vocs-code/wiki',
    status: { hasWiki: true, pages: 2, needsReview: 1, proposals: 1, stale: 0, indexed: false },
    pages: [summary(), summary({ id: 'gotchas/pty', title: 'Duplicate PTYs', kind: 'gotcha', status: 'proposed', authority: 5 })],
    proposals: [summary({ id: 'pty-guard-1a2b3c4d', title: 'PTY guard', status: 'proposed', authority: 5, targetPageId: 'gotchas/pty', evidenceCount: 2 })],
    rejectedClaims: [],
    settings: { prime: true, autoDistill: true },
    ...over
  };
}

beforeEach(() => {
  invoke.mockReset();
});
afterEach(cleanup);

describe('Project knowledge panel', () => {
  it('lists pages, marks proposals as needing review, and keeps them out of the served list', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:read') return null;
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    expect(screen.getByTestId('knowledge-tab').textContent).toContain('Project knowledge');
    expect(screen.getByTestId('knowledge-proposals').textContent).toContain('PTY guard');
    expect(screen.getByTestId('knowledge-proposal-pty-guard-1a2b3c4d').textContent).toContain('2 sessions');
    // The accepted page row links to its detail.
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-conventions/harness-lifecycle'));
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:read', { sessionId: 's1', id: 'conventions/harness-lifecycle' });
  });

  it('accepts a proposal only through the explicit button', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:review') return view({ proposals: [], status: { hasWiki: true, pages: 2, needsReview: 0, proposals: 0, stale: 0, indexed: false } });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-accept-pty-guard-1a2b3c4d'));
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:review', { sessionId: 's1', id: 'pty-guard-1a2b3c4d', action: 'accept' });
  });

  it('starts the bootstrap job and flips the digest switch through settings', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:generate') return { ok: true, detail: 'wrote 3 draft page(s)' };
      if (channel === 'settings:update') return {};
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-generate'));
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:generate', { sessionId: 's1', mode: 'bootstrap' });
    const toggle = screen.getByLabelText('Prime new sessions with the knowledge digest');
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(invoke).toHaveBeenCalledWith('settings:update', { knowledge: { prime: false, autoDistill: true } });
  });

  it('offers generation when the project has no wiki yet', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view({ pages: [], proposals: [], status: { hasWiki: false, pages: 0, needsReview: 0, proposals: 0, stale: 0, indexed: false } });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    expect(screen.getByText('No project wiki yet')).toBeTruthy();
    expect(screen.getByTestId('knowledge-generate')).toBeTruthy();
  });
});
