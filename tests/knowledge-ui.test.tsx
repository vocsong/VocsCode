/**
 * The Project knowledge panel renders auto-ingested pages with provenance and a relation graph,
 * and lets a person review, reject or delete a page or an individually queued draft.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KnowledgeTab } from '../src/renderer/src/components/KnowledgeTab';
import { useStore } from '../src/renderer/src/store';
import type { KnowledgeGraph, KnowledgePageDetail, KnowledgePageMeta, KnowledgePageSummary, KnowledgeView } from '../src/shared/knowledge';
import type { SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl', canInvoke: () => true }));

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
    labels: ['session-lifecycle'],
    updatedBy: 'agent:bootstrap',
    authority: 3,
    ...over
  };
}

function view(over: Partial<KnowledgeView> = {}): KnowledgeView {
  return {
    projectRoot: 'G:/repo',
    cwd: 'G:/repo',
    wikiDir: 'G:/repo/.vocs-code/wiki',
    status: { hasWiki: true, pages: 1, needsReview: 0, proposals: 0, stale: 0 },
    pages: [summary()],
    proposals: [],
    rejectedClaims: [],
    settings: { prime: true, autoDistill: true },
    ...over
  };
}

function pageDetail(id: string, over: Partial<KnowledgePageDetail> = {}): KnowledgePageDetail {
  const pty = id === 'gotchas/pty';
  const meta: KnowledgePageMeta = {
    id,
    title: pty ? 'Duplicate PTYs' : 'Harness lifecycle',
    kind: pty ? 'gotcha' : 'convention',
    status: 'current',
    scope: 'repo',
    claim: pty ? 'Renderer reconnects can duplicate a PTY.' : 'A harness belongs to exactly one session.',
    keywords: [],
    labels: pty ? ['pty-lifecycle'] : ['session-lifecycle'],
    updatedBy: pty ? 'agent:distill' : 'agent:bootstrap',
    sources: [],
    anchors: [],
    related: [],
    supersedes: [],
    contradicts: []
  };
  return {
    page: { meta, body: 'Body.', path: `${id}.md` },
    related: [],
    anchors: [],
    stale: false,
    staleReasons: [],
    ...over
  };
}

const proposalId = 'auto-draft/branch-0123456789abcdef0123456789abcdef/abcdef0123456789abcdef0123456789';
const finalPageId = 'gotcha/memory-note';
const draftClaim = 'Keep checked evidence separate.';
const draft = summary({
  id: proposalId, title: 'Memory note', claim: draftClaim, kind: 'gotcha', status: 'draft', scope: 'branch', branch: 'topic/memory',
  path: `_proposals/_${proposalId}.md`, labels: ['memory'], updatedBy: 'auto:evidence-draft', authority: 5
});
const draftSession = () => ({ ...session(), worktreeBranch: draft.branch });
const draftDetail = (): KnowledgePageDetail => ({
  page: {
    meta: { ...draft, sources: [], anchors: [], related: [], supersedes: [], contradicts: [] },
    path: draft.path,
    body: 'Check **the original evidence** before accepting.'
  },
  related: [], anchors: [], stale: false, staleReasons: []
});

const graph: KnowledgeGraph = {
  builtAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    { id: 'conventions/harness-lifecycle', kind: 'convention', status: 'current', labels: ['session-lifecycle'], degree: 1 },
    { id: 'gotchas/pty', kind: 'gotcha', status: 'current', labels: ['pty-lifecycle'], degree: 1 }
  ],
  edges: [{ from: 'gotchas/pty', to: 'conventions/harness-lifecycle', type: 'related', weight: 2 }]
};

beforeEach(() => {
  invoke.mockReset();
  // Generation is gated on a configured utility model; tests that exercise the gate override this.
  useStore.setState({ settings: { utilityModel: { provider: 'deepseek', model: 'deepseek-flash' } } as never });
});
afterEach(cleanup);

describe('Project knowledge panel', () => {
  it('lists an auto-ingested page with its labels and provenance, and opens it', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:read') return pageDetail('conventions/harness-lifecycle');
      if (channel === 'knowledge:graph') return graph;
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    expect(screen.getByTestId('knowledge-tab').textContent).toContain('Project knowledge');
    // Normal ingestion is automatic and an empty draft queue stays hidden.
    expect(screen.getByTestId('knowledge-auto-note')).toBeTruthy();
    expect(screen.queryByTestId('knowledge-proposals')).toBeNull();
    expect(screen.queryByTestId('knowledge-accept-all')).toBeNull();

    const row = screen.getByTestId('knowledge-page-conventions/harness-lifecycle');
    expect(row.textContent).toContain('Harness lifecycle');
    expect(row.textContent).toContain('accepted');
    expect(screen.getByTestId('knowledge-labels-conventions/harness-lifecycle').textContent).toContain('session-lifecycle');
    expect(row.textContent).toContain('agent:bootstrap');

    await act(async () => {
      fireEvent.click(row);
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:read', { sessionId: 's1', id: 'conventions/harness-lifecycle' });
    expect(screen.getByTestId('knowledge-detail').textContent).toContain('A harness belongs to exactly one session.');
  });

  it('keeps a review-only Markdown draft out of Publish and shows the accepted page under its final id', async () => {
    const legacy = summary({ id: 'legacy', title: 'Legacy proposal', status: 'draft' });
    const initial = view({ proposals: [legacy, draft], branch: draft.branch });
    const accepted = summary({ ...draft, id: finalPageId, path: `${finalPageId}.md`, status: 'current', authority: 2 });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return initial;
      if (channel === 'knowledge:read') return draftDetail();
      if (channel === 'knowledge:publish') return { ok: true, written: ['docs/wiki/conventions/harness-lifecycle.md'] };
      if (channel === 'knowledge:review') return view({ pages: [summary(), accepted], branch: draft.branch });
      return undefined;
    });
    await act(async () => { render(<KnowledgeTab session={draftSession()} />); });

    const drafts = screen.getByRole('region', { name: 'Drafts awaiting review' });
    expect(drafts).toBe(screen.getByTestId('knowledge-proposals'));
    expect(drafts.textContent).toMatch(/stay out of.*digest.*publish/i);
    expect(drafts.textContent).not.toContain(legacy.title);
    expect(screen.queryByTestId(`knowledge-page-${accepted.id}`)).toBeNull();
    expect(screen.queryByTestId('knowledge-accept-all')).toBeNull();
    expect(invoke.mock.calls).toEqual([['knowledge:view', { sessionId: 's1' }]]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish' })); });
    expect(invoke).toHaveBeenCalledWith('knowledge:publish', { sessionId: 's1', ids: [summary().id] });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /review draft: memory note.*topic\/memory/i })); });
    expect(invoke).toHaveBeenCalledWith('knowledge:read', { sessionId: 's1', id: draft.id });
    const detail = screen.getByTestId('knowledge-detail');
    expect(detail.textContent).toContain('Review-only draft');
    expect(detail.textContent).toContain('Branch: topic/memory');
    expect(detail.querySelector('strong')?.textContent).toBe('the original evidence');
    expect((screen.getByTestId('knowledge-promote') as HTMLButtonElement).disabled).toBe(true);
    const accept = screen.getByRole('button', { name: 'Accept draft' });
    expect(accept).toBe(screen.getByTestId('knowledge-mark-reviewed'));
    await act(async () => { fireEvent.click(accept); });
    expect(invoke.mock.calls.filter(([channel]) => channel.startsWith('knowledge:review'))).toEqual([
      ['knowledge:review', { sessionId: 's1', id: draft.id, action: 'accept' }]
    ]);
    expect(screen.queryByTestId('knowledge-proposals')).toBeNull();
    expect(screen.queryByTestId('knowledge-detail')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/accepted.*memory note.*topic\/memory/i);
    expect(screen.getByTestId(`knowledge-page-${accepted.id}`).textContent).toContain('human-reviewed');
  });

  it.each(['reject', 'delete'] as const)('%ss just the selected draft by proposal id without changing an existing page', async (action) => {
    const existing = summary({ id: finalPageId, title: 'Existing memory page' });
    const initial = view({ pages: [existing], proposals: [draft], branch: draft.branch });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return initial;
      if (channel === 'knowledge:read') return draftDetail();
      if (channel === (action === 'reject' ? 'knowledge:review' : 'knowledge:delete')) {
        return view({ pages: [existing], branch: draft.branch, rejectedClaims: action === 'reject' ? [draftClaim] : [] });
      }
      return undefined;
    });
    await act(async () => { render(<KnowledgeTab session={draftSession()} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /review draft: memory note/i })); });
    await act(async () => { fireEvent.click(screen.getByTestId(`knowledge-page-${action}`)); });
    if (action === 'reject') {
      expect(invoke).toHaveBeenCalledWith('knowledge:review', { sessionId: 's1', id: draft.id, action });
      expect(screen.getByTestId('knowledge-rejected').textContent).toContain(draftClaim);
    } else {
      expect(invoke).toHaveBeenCalledWith('knowledge:delete', { sessionId: 's1', id: draft.id });
      expect(screen.queryByTestId('knowledge-rejected')).toBeNull();
    }
    expect(screen.queryByTestId('knowledge-detail')).toBeNull();
    expect(screen.queryByTestId('knowledge-proposals')).toBeNull();
    expect(screen.getByTestId(`knowledge-page-${existing.id}`).textContent).toContain(existing.title);
  });

  it('shows a draft even before the wiki has any current pages and keeps it open when review fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view({ pages: [], proposals: [draft], status: { hasWiki: false, pages: 0, needsReview: 0, proposals: 1, stale: 0 } });
      if (channel === 'knowledge:read') return draftDetail();
      if (channel === 'knowledge:review') throw new Error('The existing page must be reviewed separately.');
      return undefined;
    });
    await act(async () => { render(<KnowledgeTab session={draftSession()} />); });
    expect(screen.queryByText('No project wiki yet')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /review draft: memory note/i })); });
    await act(async () => { fireEvent.click(screen.getByTestId('knowledge-mark-reviewed')); });
    expect(screen.getByTestId('knowledge-detail').textContent).toContain('Review-only draft');
    expect(screen.getByRole('alert').textContent).toBe('The existing page must be reviewed separately.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders a search excerpt as text and marks only the matched text', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:search') return [summary({ snippet: 'A <b>\u0001literal\u0002</b> &amp; text.' })];
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    const input = screen.getByRole('textbox', { name: 'Search project knowledge' });
    fireEvent.change(input, { target: { value: 'literal' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(invoke).toHaveBeenCalledWith('knowledge:search', { sessionId: 's1', q: 'literal', limit: 30 });
    const excerpt = screen.getByTestId('knowledge-page-conventions/harness-lifecycle').querySelector('.knowledge-snippet');
    expect(excerpt?.textContent).toBe('A <b>literal</b> &amp; text.');
    expect(Array.from(excerpt!.querySelectorAll('mark'), (mark) => mark.textContent)).toEqual(['literal']);
    expect(excerpt!.querySelector('b')).toBeNull();
  });

  it('renders the labels and provenance of an open page', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view({ pages: [summary(), summary({ id: 'gotchas/pty', title: 'Duplicate PTYs', kind: 'gotcha', labels: ['pty-lifecycle'], updatedBy: 'agent:distill' })] });
      if (channel === 'knowledge:read') return pageDetail('gotchas/pty');
      if (channel === 'knowledge:graph') return graph;
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-gotchas/pty'));
    });
    expect(screen.getByTestId('knowledge-labels').textContent).toContain('pty-lifecycle');
    expect(screen.getByTestId('knowledge-detail').textContent).toContain('agent:distill');
  });

  it('rejects a page from its row and removes it without opening the detail', async () => {
    let current = view();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return current;
      if (channel === 'knowledge:review') {
        current = view({ pages: [], status: { hasWiki: true, pages: 0, needsReview: 0, proposals: 0, stale: 0 } });
        return current;
      }
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-row-reject-conventions/harness-lifecycle'));
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:review', { sessionId: 's1', id: 'conventions/harness-lifecycle', action: 'reject' });
    expect(screen.queryByTestId('knowledge-page-conventions/harness-lifecycle')).toBeNull();
    // The row's reject button must not have opened the page behind it.
    expect(invoke).not.toHaveBeenCalledWith('knowledge:read', expect.anything());
  });

  it('deletes a page from its detail and removes both detail and row', async () => {
    let current = view({ pages: [summary(), summary({ id: 'gotchas/pty', title: 'Duplicate PTYs', kind: 'gotcha' })] });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return current;
      if (channel === 'knowledge:read') return pageDetail('gotchas/pty');
      if (channel === 'knowledge:graph') return graph;
      if (channel === 'knowledge:delete') {
        current = view();
        return current;
      }
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-gotchas/pty'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-delete'));
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:delete', { sessionId: 's1', id: 'gotchas/pty' });
    expect(screen.queryByTestId('knowledge-detail')).toBeNull();
    expect(screen.queryByTestId('knowledge-page-gotchas/pty')).toBeNull();
  });

  it('rejects an open page through the review channel', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:read') return pageDetail('conventions/harness-lifecycle');
      if (channel === 'knowledge:graph') return graph;
      if (channel === 'knowledge:review') return view({ pages: [] });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-conventions/harness-lifecycle'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-reject'));
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:review', { sessionId: 's1', id: 'conventions/harness-lifecycle', action: 'reject' });
    expect(screen.queryByTestId('knowledge-detail')).toBeNull();
  });

  it('renders the relation graph of the open page with direction and edge type', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view({ pages: [summary(), summary({ id: 'gotchas/pty', title: 'Duplicate PTYs', kind: 'gotcha' })] });
      if (channel === 'knowledge:read') return pageDetail('gotchas/pty');
      if (channel === 'knowledge:graph') return graph;
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-gotchas/pty'));
    });
    const relations = screen.getByTestId('knowledge-graph');
    expect(relations.textContent).toContain('→');
    expect(relations.textContent).toContain('related');
    expect(relations.textContent).toContain('Harness lifecycle');
  });

  it('keeps the page readable when the graph call fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:read') return pageDetail('conventions/harness-lifecycle');
      if (channel === 'knowledge:graph') throw new Error('No relation graph in this run');
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-conventions/harness-lifecycle'));
    });
    expect(screen.getByTestId('knowledge-detail').textContent).toContain('Body.');
    expect(screen.queryByTestId('knowledge-graph')).toBeNull();
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

  it('shows what GitNexus says about each anchor', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      if (channel === 'knowledge:read')
        return {
          page: {
            meta: {
              id: 'conventions/harness-lifecycle',
              title: 'Harness lifecycle',
              kind: 'convention',
              status: 'current',
              scope: 'repo',
              keywords: [],
              labels: [],
              sources: [],
              anchors: [
                { file: 'src/main/session-manager.ts', symbol: 'buildContext' },
                { file: 'src/main/gone.ts', symbol: 'gone' }
              ],
              related: [],
              supersedes: [],
              contradicts: []
            },
            body: 'Body.',
            path: 'conventions/harness-lifecycle.md'
          },
          related: [],
          anchors: [
            { file: 'src/main/session-manager.ts', symbol: 'buildContext', status: 'resolved', lines: { start: 520, end: 562 } },
            { file: 'src/main/gone.ts', symbol: 'gone', status: 'unresolved', note: "Symbol 'gone' not found" }
          ],
          stale: false,
          staleReasons: []
        };
      if (channel === 'knowledge:graph') return graph;
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-page-conventions/harness-lifecycle'));
    });
    const anchors = screen.getByText('GitNexus anchors').parentElement!;
    expect(anchors.textContent).toContain('resolved');
    expect(anchors.textContent).toContain('lines 520-562');
    expect(anchors.textContent).toContain('unresolved');
    expect(anchors.textContent).toContain("Symbol 'gone' not found");
  });

  it('offers generation when the project has no wiki yet', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view({ pages: [], proposals: [], status: { hasWiki: false, pages: 0, needsReview: 0, proposals: 0, stale: 0 } });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    expect(screen.getByText('No project wiki yet')).toBeTruthy();
    expect(screen.getByTestId('knowledge-generate')).toBeTruthy();
    expect(screen.getByTestId('knowledge-create')).toBeTruthy();
  });

  it('starts an empty wiki for a project whose docs are too thin to generate from', async () => {
    const empty = view({ pages: [], proposals: [], status: { hasWiki: false, pages: 0, needsReview: 0, proposals: 0, stale: 0 } });
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return empty;
      // The wiki now exists, so the panel leaves the empty state and reaches the switches.
      if (channel === 'knowledge:create') return view({ pages: [] });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('knowledge-create'));
    });
    expect(invoke).toHaveBeenCalledWith('knowledge:create', { sessionId: 's1' });
    expect(screen.queryByText('No project wiki yet')).toBeNull();
  });

  it('lists the rejected claims the tools refuse to file again', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view({ rejectedClaims: ['Harnesses share one event stream.', 'The relay never stores provider keys.'] });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    const ledger = screen.getByTestId('knowledge-rejected');
    expect(ledger.textContent).toContain('2 rejected claims');
    expect(ledger.textContent).toContain('The relay never stores provider keys.');
  });

  it('hides the rejection ledger when nothing has been rejected', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    expect(screen.queryByTestId('knowledge-rejected')).toBeNull();
  });

  it('marks a page waiting on a decision apart from an uncertain claim', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view')
        return view({
          pages: [
            summary({ id: 'conventions/pending', title: 'Pending', status: 'proposed' }),
            summary({ id: 'gotchas/doubtful', title: 'Doubtful', status: 'uncertain' })
          ]
        });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    // Amber means "not decided yet"; a page recorded as uncertain is judged, and must not read
    // like one still queued for review.
    expect(screen.getByTestId('knowledge-page-conventions/pending').querySelector('.badge-amber')).toBeTruthy();
    const uncertain = screen.getByTestId('knowledge-page-gotchas/doubtful');
    expect(uncertain.querySelector('.badge-amber')).toBeNull();
    expect(uncertain.textContent).toContain('uncertain');
  });

  it('shows the last job outcome instead of leaving a silent no-op', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view')
        return view({
          status: {
            hasWiki: true,
            pages: 1,
            needsReview: 0,
            proposals: 0,
            stale: 0,
            job: { mode: 'bootstrap', state: 'failed', at: new Date().toISOString(), model: 'deepseek/deepseek-flash', error: 'The background model (deepseek/deepseek-flash) did not answer.' }
          }
        });
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    const job = screen.getByTestId('knowledge-job');
    expect(job.textContent).toContain('did not answer');
  });

  it('explains that generation needs a utility model and disables it', async () => {
    useStore.setState({ settings: {} as never });    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'knowledge:view') return view();
      return undefined;
    });
    await act(async () => {
      render(<KnowledgeTab session={session()} />);
    });
    expect(screen.getByTestId('knowledge-needs-model')).toBeTruthy();
    expect((screen.getByTestId('knowledge-generate') as HTMLButtonElement).disabled).toBe(true);
  });
});
