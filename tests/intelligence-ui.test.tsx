/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeTab } from '../src/renderer/src/components/KnowledgeTab';
import { useStore } from '../src/renderer/src/store';
import {
  resolveIntelligenceSettings, type ContextPacket, type GraphIndexStatus, type IntelligenceSearchResponse, type IntelligenceSettings, type IntelligenceView,
  type MemoryRecord, type MemoryState, type ProjectCollection, type ProjectIdentity, type PromotionRequest
} from '../src/shared/intelligence';
import type { IpcChannel, IpcRequest, IpcResponse, PushPayloads } from '../src/shared/ipc';
import type { KnowledgePageDetail, KnowledgePageSummary, KnowledgeView } from '../src/shared/knowledge';
import type { KnowledgeUsageReport, KnowledgeUsageTotals, KnowledgeUsageVote, RecentKnowledgeLookup } from '../src/shared/knowledge-usage';
import type { SessionMeta } from '../src/shared/types';

const { invoke, canInvoke, on } = vi.hoisted(() => ({ invoke: vi.fn(), canInvoke: vi.fn(), on: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, canInvoke, on, isMac: false, modKey: 'Ctrl' }));

type MemoryListener = (event: PushPayloads['push:projectMemoryChanged']) => void;
const memoryListeners = new Set<MemoryListener>();
const pushMemoryChange = (...sessionIds: string[]) => act(async () => {
  for (const sessionId of sessionIds) for (const listener of memoryListeners) listener({ sessionId });
});

const at = '2026-01-01T00:00:00.000Z';
const revision = '1234567890ab11cd22ef33';
const bundledGraph: GraphIndexStatus = { provider: 'graphify', enabled: true, installed: true, indexed: false };
const project = (id: string, name: string): ProjectIdentity => ({ id, name, roots: [`G:/${name}`], createdAt: at, updatedAt: at });
const alpha = project('prj-alpha', 'alpha-lab');
const beta = project('prj-beta', 'beta-lab');
const collection: ProjectCollection = {
  id: 'col-1', name: 'Shared practices', description: 'Procedures for both checkouts.',
  members: [{ projectId: alpha.id, share: 'promoted' }, { projectId: beta.id, share: 'promoted' }], createdAt: at, updatedAt: at
};
const session = (id = 's1'): SessionMeta => ({ id, cwd: id === 's1' ? alpha.roots[0] : beta.roots[0], config: { projectRoot: id === 's1' ? alpha.roots[0] : beta.roots[0] } }) as SessionMeta;
const rowRecord = (id: string, state: MemoryState, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id, state, projectId: alpha.id, scope: 'project', type: 'episodic', kind: 'lesson', title: id, text: `Details for ${id}.`,
  origin: 'agent:reflect', createdAt: at, updatedAt: at, sources: [{ type: 'file', ref: 'docs/process.md', revision }], ...over
});
const ledger = (over: Partial<IntelligenceView> = {}): IntelligenceView => ({
  available: true, project: alpha, settings: resolveIntelligenceSettings(undefined), records: [], personal: [], shared: [],
  collections: [], projects: [alpha, beta], promotions: [], graph: { ...bundledGraph, installed: false },
  gateway: { enabled: true, listening: true, sessions: 2 }, audit: [], ...over
});
const pageSummary = (id: string, over: Partial<KnowledgePageSummary> = {}): KnowledgePageSummary => ({
  id, title: id, kind: 'convention', status: 'current', scope: 'repo', keywords: [], labels: [], path: `${id}.md`, authority: 3, ...over
});
const wiki = (pages = [pageSummary('wiki/start')]): KnowledgeView => ({
  projectRoot: alpha.roots[0], cwd: alpha.roots[0], wikiDir: `${alpha.roots[0]}/.vocs-code/wiki`, pages, proposals: [], rejectedClaims: [],
  settings: { prime: true, autoDistill: true }, status: { hasWiki: true, pages: pages.length, needsReview: 0, proposals: 0, stale: 0 }
});
const page = (id: string): KnowledgePageDetail => ({
  page: { meta: { ...pageSummary(id), anchors: [], sources: [], related: [], supersedes: [], contradicts: [] }, body: 'The wiki body.', path: `${id}.md` },
  related: [], anchors: [], stale: false, staleReasons: []
});

function setup(initial = ledger(), replies: Partial<Record<IpcChannel, unknown>> = {}) {
  invoke.mockImplementation(async (channel: IpcChannel, request: unknown) => {
    if (Object.hasOwn(replies, channel)) {
      const reply = replies[channel];
      return typeof reply === 'function' ? reply(request) : reply;
    }
    if (channel === 'knowledge:view') return wiki();
    if (channel === 'intelligence:view') return initial;
    return undefined;
  });
  return render(<KnowledgeTab session={session()} />);
}

async function click(element: HTMLElement) {
  await act(async () => { fireEvent.click(element); });
}
async function openView(view: 'memory' | 'collections' | 'evidence' | 'usage' | 'sources') {
  await click(screen.getByTestId(`knowledge-view-${view}`));
  return screen.findByTestId(`${view}-view`);
}
function update(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}
function record(id: string) {
  return within(screen.getAllByTestId('memory-row').find((row) => row.dataset.recordId === id)!);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const intelligenceCalls = () => invoke.mock.calls.filter(([channel]) => channel.startsWith('intelligence:'));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  invoke.mockReset();
  canInvoke.mockReset().mockReturnValue(true);
  on.mockReset().mockImplementation((channel: string, listener: MemoryListener) => {
    if (channel === 'push:projectMemoryChanged') memoryListeners.add(listener);
    return () => { memoryListeners.delete(listener); };
  });
  vi.stubGlobal('harness', { on });
  useStore.setState({ settings: {} as never });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Knowledge workspace', () => {
  it('defaults to the wiki, moves tab focus without loading, then shares one lazy load', async () => {
    setup();
    await screen.findByTestId('knowledge-page-wiki/start');
    const knowledge = screen.getByRole('tab', { name: 'Knowledge' });
    const memory = screen.getByRole('tab', { name: 'Memory' });
    const sources = screen.getByRole('tab', { name: 'Sources' });
    expect(knowledge.getAttribute('aria-selected')).toBe('true');
    expect(memory.tabIndex).toBe(-1);
    act(() => knowledge.focus());
    fireEvent.keyDown(knowledge, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(memory);
    expect(memory.tabIndex).toBe(0);
    fireEvent.keyDown(memory, { key: 'End' });
    expect(document.activeElement).toBe(sources);
    const usage = screen.getByRole('tab', { name: 'Usage' });
    fireEvent.keyDown(sources, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(usage);
    fireEvent.keyDown(usage, { key: 'Home' });
    expect(document.activeElement).toBe(knowledge);
    expect(intelligenceCalls()).toEqual([]);

    await openView('memory');
    expect(memory.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Memory' }).id).toBe(memory.getAttribute('aria-controls'));
    await openView('collections');
    expect(intelligenceCalls()).toEqual([['intelligence:view', { sessionId: 's1' }]]);
  });

  it('hides intelligence destinations from a transport that cannot invoke the local view', async () => {
    vi.stubGlobal('harness', { can: () => false });
    canInvoke.mockImplementation((channel: IpcChannel) => channel !== 'intelligence:view');
    setup(ledger(), { 'knowledge:read': page('wiki/start') });
    await click(await screen.findByTestId('knowledge-page-wiki/start'));
    expect(screen.getByTestId('knowledge-detail').textContent).toContain('The wiki body.');
    expect(screen.queryByTestId('knowledge-view-memory')).toBeNull();
    expect(screen.queryByTestId('knowledge-view-usage')).toBeNull();
    expect(screen.queryByTestId('knowledge-view-sources')).toBeNull();
    expect(screen.queryByTestId('knowledge-promote')).toBeNull();
    expect(intelligenceCalls()).toEqual([]);
  });

  it('discards a stale reply even after leaving and returning to the same session', async () => {
    const old = deferred<IntelligenceView>();
    let alphaReads = 0;
    const panel = setup(ledger(), { 'intelligence:view': ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 's2') return ledger({ project: beta, records: [rowRecord('Beta detail', 'candidate')] });
      return ++alphaReads === 1 ? old.promise : ledger({ records: [rowRecord('New alpha detail', 'candidate')] });
    } });
    await click(screen.getByTestId('knowledge-view-memory'));
    await act(async () => { panel.rerender(<KnowledgeTab session={session('s2')} />); });
    expect(await screen.findByText('Beta detail')).toBeTruthy();
    await act(async () => { panel.rerender(<KnowledgeTab session={session()} />); });
    expect(await screen.findByText('New alpha detail')).toBeTruthy();
    await act(async () => { old.resolve(ledger({ records: [rowRecord('Stale alpha detail', 'candidate')] })); });
    expect(screen.queryByText('Beta detail')).toBeNull();
    expect(screen.queryByText('Stale alpha detail')).toBeNull();
    expect(screen.getByText('New alpha detail')).toBeTruthy();
  });

  it('labels wiki pages from recorded authority and only loads promotion options on demand', async () => {
    const checked = pageSummary('wiki/checked', { verifiedBy: 'commit' });
    const unchecked = pageSummary('wiki/unchecked');
    setup(ledger(), {
      'knowledge:view': wiki([checked, unchecked]), 'knowledge:read': page(checked.id),
      'knowledge:review': wiki([{ ...checked, authority: 2 }, unchecked]), 'intelligence:promote': ledger()
    });
    expect((await screen.findByTestId('knowledge-page-wiki/checked')).textContent).toContain('verified');
    expect(screen.getByTestId('knowledge-page-wiki/unchecked').textContent).not.toMatch(/verified/i);
    await click(screen.getByTestId('knowledge-page-wiki/checked'));
    expect(screen.getByTestId('knowledge-detail').textContent).toContain('verified');
    await click(screen.getByTestId('knowledge-mark-reviewed'));
    expect(invoke).toHaveBeenCalledWith('knowledge:review', { sessionId: 's1', id: checked.id, action: 'accept' });
    expect(screen.queryByTestId('knowledge-mark-reviewed')).toBeNull();
    expect(screen.getByTestId('knowledge-detail').textContent).toContain('human-reviewed');
    expect(screen.getByTestId('knowledge-detail').textContent).not.toMatch(/verified/i);
    expect(intelligenceCalls()).toEqual([]);
    await click(screen.getByTestId('knowledge-promote'));
    update(await screen.findByTestId('knowledge-promote-target'), 'personal');
    await click(screen.getByTestId('knowledge-promote-confirm'));
    expect(intelligenceCalls()).toEqual([
      ['intelligence:view', { sessionId: 's1' }], ['intelligence:promote', { sessionId: 's1', pageId: checked.id, to: 'personal' }]
    ]);
  });
});

describe('Local Knowledge usage', () => {
  const totals = (over: Partial<KnowledgeUsageTotals> = {}): KnowledgeUsageTotals => ({
    hit: 0, empty: 0, failed: 0, helped: 0, notHelpful: 0, staleGraph: 0, truncated: 0, sources: {}, p50: null, p95: null,
    meanResponseBytes: null, ...over
  });
  const usage = (over: Partial<KnowledgeUsageReport> = {}): KnowledgeUsageReport => ({ enabled: false, days: 7, desktop: totals(), agent: totals(), ...over });
  const toggle = () => screen.getByRole<HTMLInputElement>('checkbox', { name: 'Track usage for this project' });
  const rating = { name: 'Did this agent lookup help?' };
  const refresh = () => click(screen.getByRole('button', { name: 'Refresh' }));

  it('loads only usage, opts in explicitly, and clears retained history only on confirmation', async () => {
    let current = usage();
    setup(ledger(), {
      'intelligence:usage:view': ({ days }: IpcRequest<'intelligence:usage:view'>) => (current = { ...current, days }),
      'intelligence:usage:configure': ({ enabled }: IpcRequest<'intelligence:usage:configure'>) => (current = { ...current, enabled }),
      'intelligence:usage:clear': ({ days }: IpcRequest<'intelligence:usage:clear'>) => (current = usage({ enabled: current.enabled, days }))
    });
    expect(intelligenceCalls()).toEqual([]);
    await openView('usage');
    expect(intelligenceCalls()).toEqual([['intelligence:usage:view', { sessionId: 's1', days: 7 }]]);
    expect(toggle().checked).toBe(false);
    expect(screen.getByText(/only daily aggregates are saved on this computer.*no queries, results.*never appear in the web dashboard/i)).toBeTruthy();
    await click(toggle());
    expect(toggle().checked).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('intelligence:usage:configure', { sessionId: 's1', days: 7, enabled: true });

    current = { ...current,
      desktop: totals({ hit: 3, empty: 2, failed: 1, helped: 1, notHelpful: 1, sources: { wiki: 3, memory: 1 }, p50: 5, truncated: 1 }),
      agent: totals({ hit: 20, empty: 3, failed: 2, helped: 2, notHelpful: 1, sources: { memory: 4, passive: 6 }, p50: 50, p95: 'overflow', staleGraph: 1, meanResponseBytes: 640 })
    };
    await act(async () => update(screen.getByLabelText('Report period'), '30'));
    expect(invoke).toHaveBeenLastCalledWith('intelligence:usage:view', { sessionId: 's1', days: 30 });
    const desktop = within(screen.getByRole('region', { name: 'Desktop Evidence' }));
    const agent = within(screen.getByRole('region', { name: 'Agent lookups' }));
    for (const [name, value] of Object.entries({ 'Hit (with evidence)': '3 of 6 lookups', Empty: '2', Failed: '1', Helped: '1 of 2 rated',
      'Not helpful': '1', 'Feedback coverage': '2 of 6 lookups rated', 'Local lookup p50': '≤ 5 ms', 'Local lookup p95': 'Not enough samples', Truncated: '1' })) {
      expect(desktop.getByText(name).nextElementSibling?.textContent).toBe(value);
    }
    expect(agent.getByText('20 of 25 lookups')).toBeTruthy();
    expect(agent.getByText('2 of 3 rated')).toBeTruthy();
    expect(agent.getByText('3 of 25 lookups rated')).toBeTruthy();
    expect(agent.getByText(`> ${(10000).toLocaleString()} ms`)).toBeTruthy();
    expect(agent.getByText('640 bytes')).toBeTruthy();
    expect(agent.getByText('Stale graph').nextElementSibling?.textContent).toBe('1');
    const sources = within(screen.getByRole('table', { name: 'Lookups by returned source' }));
    for (const [source, cells] of [['Memory', ['1', '4']], ['Passive learning notes', ['0', '6']]] as const) {
      const row = sources.getByRole('rowheader', { name: source }).closest('tr')!;
      expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(cells);
    }
    await refresh();
    expect(invoke).toHaveBeenLastCalledWith('intelligence:usage:view', { sessionId: 's1', days: 30 });
    await click(toggle());
    expect(toggle().checked).toBe(false);
    expect(desktop.getByText('3 of 6 lookups')).toBeTruthy();
    await click(screen.getByTestId('usage-clear'));
    expect(invoke).not.toHaveBeenCalledWith('intelligence:usage:clear', expect.anything());
    expect(screen.getByText(/clear all stored usage counts for this project, not just this period/i)).toBeTruthy();
    await click(screen.getByTestId('usage-clear-confirm'));
    expect(invoke).toHaveBeenLastCalledWith('intelligence:usage:clear', { sessionId: 's1', days: 30 });
    expect(screen.getByText('No lookups recorded in this period.')).toBeTruthy();
    expect(toggle().checked).toBe(false);
    expect(intelligenceCalls().every(([channel]) => channel.startsWith('intelligence:usage:'))).toBe(true);
  });

  it('allows a failed report read to be retried and keeps the last report on mutation failure', async () => {
    let reads = 0;
    const before = usage({ desktop: totals({ hit: 3 }) });
    setup(ledger(), {
      'intelligence:usage:view': () => { if (++reads === 1) throw new Error('Usage read failed'); return before; },
      'intelligence:usage:configure': () => { throw new Error("Error invoking remote method 'intelligence:usage:configure': Error: Could not save"); },
      'intelligence:usage:clear': () => { throw new Error('Could not clear'); }
    });
    await openView('usage');
    expect(screen.getByRole('alert').textContent).toBe('Usage read failed');
    expect(screen.queryByRole('checkbox', { name: 'Track usage for this project' })).toBeNull();
    await refresh();
    expect(screen.queryByRole('alert')).toBeNull();
    await click(toggle());
    expect(screen.getByRole('alert').textContent).toBe('Could not save');
    expect(toggle().checked).toBe(false);
    await click(screen.getByTestId('usage-clear'));
    await click(screen.getByTestId('usage-clear-confirm'));
    expect(screen.getByRole('alert').textContent).toBe('Could not clear');
    expect(screen.getByText('3 of 3 lookups')).toBeTruthy();
    expect((screen.getByTestId('usage-clear-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('rates the reported latest agent receipt, reloads votes and expires the handle in place', async () => {
    vi.useFakeTimers();
    const latest: RecentKnowledgeLookup = {
      receipt: 'agent-receipt', endedAt: Date.now() - 3_599_000, lookup: 'memory_recall', outcome: 'hit', sources: ['passive']
    };
    let recorded: KnowledgeUsageVote = 'not-helpful';
    setup(ledger(), {
      'intelligence:usage:view': () => usage({ enabled: true, recentAgent: { ...latest, vote: recorded },
        agent: totals({ hit: 1, helped: Number(recorded === 'helped'), notHelpful: Number(recorded === 'not-helpful') }) }),
      'intelligence:usage:vote': ({ vote }: IpcRequest<'intelligence:usage:vote'>) => { recorded = vote; return true; }
    });
    await click(screen.getByRole('tab', { name: 'Usage' }));
    expect(screen.getByTestId('usage-view').querySelector('time')?.dateTime).toBe(new Date(latest.endedAt).toISOString());
    const feedback = within(screen.getByRole('group', rating));
    expect(feedback.getByRole('button', { name: 'Not helpful', pressed: true })).toBeTruthy();
    await click(feedback.getByRole('button', { name: 'Helped' }));
    expect(intelligenceCalls().slice(-2)).toEqual([
      ['intelligence:usage:vote', { sessionId: 's1', receipt: latest.receipt, vote: 'helped' }],
      ['intelligence:usage:view', { sessionId: 's1', days: 7 }]
    ]);
    expect(feedback.getByRole('button', { name: 'Helped', pressed: true })).toBeTruthy();
    expect(screen.getByText('1 of 1 rated')).toBeTruthy();
    await advance(1_000);
    expect(screen.queryByRole('group', rating)).toBeNull();
    expect(screen.getByText(/no recent agent lookup for this session/i)).toBeTruthy();
    expect(intelligenceCalls()).toHaveLength(3);
  });

  it('discards stale usage reports and does not refresh an old session after its vote settles', async () => {
    const stale = deferred<KnowledgeUsageReport>();
    const pending = deferred<boolean>();
    const latest: RecentKnowledgeLookup = { receipt: 's1-latest', endedAt: Date.now(), lookup: 'context_compile', outcome: 'empty', sources: [] };
    let reads = 0;
    const instance = setup(ledger(), {
      'intelligence:usage:view': ({ sessionId }: IpcRequest<'intelligence:usage:view'>) => sessionId === 's2'
        ? usage({ enabled: true })
        : ++reads === 1 ? stale.promise : usage({ enabled: true, recentAgent: latest }),
      'intelligence:usage:vote': pending.promise
    });
    await openView('usage');
    await act(async () => { instance.rerender(<KnowledgeTab session={session('s2')} />); });
    expect(screen.queryByRole('group', rating)).toBeNull();
    await act(async () => { instance.rerender(<KnowledgeTab session={session()} />); });
    await act(async () => { stale.resolve(usage()); });
    expect(toggle().checked).toBe(true);
    await click(within(screen.getByRole('group', rating)).getByRole('button', { name: 'Not helpful' }));
    expect(invoke).toHaveBeenLastCalledWith('intelligence:usage:vote', { sessionId: 's1', receipt: latest.receipt, vote: 'not-helpful' });
    await act(async () => { instance.rerender(<KnowledgeTab session={session('s2')} />); });
    await act(async () => { pending.resolve(true); });
    expect(screen.queryByRole('group', rating)).toBeNull();
    expect(reads).toBe(2);
    expect(invoke).toHaveBeenLastCalledWith('intelligence:usage:view', { sessionId: 's2', days: 7 });
  });
});

describe('Memory ledger', () => {
  const candidate = rowRecord('Retry lesson', 'candidate');
  const verified = rowRecord('Check root', 'verified', { verification: { method: 'commit', at, revision }, updatedAt: '2026-02-01T00:00:00.000Z' });
  const revoked = rowRecord('Old note', 'revoked');

  it('shows real verification only for checked records, sorts newest first and filters by state', async () => {
    setup(ledger({ records: [{ ...candidate, verification: verified.verification }, revoked, verified] }));
    await openView('memory');
    expect(screen.getAllByTestId('memory-row').map((row) => row.dataset.recordId)).toEqual([verified.id, candidate.id, revoked.id]);
    expect(record(candidate.id).getByTestId('memory-state').textContent).toBe('candidate');
    expect(record(candidate.id).getByText(/history, not guidance/)).toBeTruthy();
    expect(record(candidate.id).getByRole('heading').closest('article')?.textContent).not.toMatch(/verified/i);
    expect(record(verified.id).getByTestId('memory-state').textContent).toBe('verified');
    expect(record(verified.id).getByText('Verified against commit 1234567890ab')).toBeTruthy();
    expect(record(verified.id).getByRole('list', { name: 'Sources' }).textContent).toContain('file: docs/process.md @1234567890ab');
    for (const [filter, id] of [['servable', verified.id], ['unverified', candidate.id], ['history', revoked.id]]) {
      await click(screen.getByTestId(`memory-filter-${filter}`));
      expect(screen.getAllByTestId('memory-row').map((row) => row.dataset.recordId)).toEqual([id]);
    }
  });

  it('gives a clear inline reason and no memory actions if the ledger is unavailable', async () => {
    setup(ledger({ available: false, reason: 'Locked by another writer' }));
    const memory = await openView('memory');
    expect(memory.textContent).toBe('Locked by another writer');
    expect(within(memory).queryAllByRole('button')).toHaveLength(0);
  });

  it('reports an IPC failure when loading and allows retry', async () => {
    let loads = 0;
    setup(ledger(), { 'intelligence:view': () => { if (++loads <= 1) throw new Error('Ledger read timed out'); return ledger(); } });
    await click(screen.getByTestId('knowledge-view-memory'));
    expect((await screen.findByRole('alert')).textContent).toBe('Ledger read timed out');
    await click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByTestId('memory-view')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('verifies a candidate from the returned view, with impossible transitions absent', async () => {
    const updated = { ...candidate, state: 'verified' as const, verification: { method: 'human-review' as const, at } };
    setup(ledger({ records: [candidate, revoked] }), { 'intelligence:memory:decide': ledger({ records: [updated, revoked] }) });
    await openView('memory');
    expect(record(revoked.id).queryByTestId('memory-verify')).toBeNull();
    await click(record(candidate.id).getByTestId('memory-verify'));
    expect(invoke).toHaveBeenCalledWith('intelligence:memory:decide', { sessionId: 's1', id: candidate.id, to: 'verified' });
    expect(record(candidate.id).getByTestId('memory-state').textContent).toBe('verified');
    expect(record(candidate.id).getByText('Verified by a person')).toBeTruthy();
    expect(record(candidate.id).queryByTestId('memory-verify')).toBeNull();
  });

  it('requires confirmation before forgetting while rejection and revocation change state', async () => {
    const rejected = { ...candidate, state: 'rejected' as const };
    const unshared = { ...verified, state: 'revoked' as const };
    setup(ledger({ records: [candidate, verified] }), {
      'intelligence:memory:decide': ({ to }: { to: MemoryState }) => ledger({ records: [rejected, to === 'revoked' ? unshared : verified] }),
      'intelligence:memory:forget': ledger({ records: [unshared] })
    });
    await openView('memory');
    await click(record(candidate.id).getByTestId('memory-reject'));
    expect(invoke).toHaveBeenCalledWith('intelligence:memory:decide', { sessionId: 's1', id: candidate.id, to: 'rejected' });
    expect(record(candidate.id).getByTestId('memory-state').textContent).toBe('rejected');
    await click(record(verified.id).getByTestId('memory-revoke'));
    expect(invoke).toHaveBeenCalledWith('intelligence:memory:decide', { sessionId: 's1', id: verified.id, to: 'revoked' });
    expect(record(verified.id).getByTestId('memory-state').textContent).toBe('revoked');
    expect(record(verified.id).queryByText(/Verified against/)).toBeNull();
    expect(record(candidate.id).queryByTestId('memory-forget-confirm')).toBeNull();
    await click(record(candidate.id).getByTestId('memory-forget'));
    expect(invoke).not.toHaveBeenCalledWith('intelligence:memory:forget', expect.anything());
    await click(record(candidate.id).getByTestId('memory-forget-confirm'));
    expect(invoke).toHaveBeenCalledWith('intelligence:memory:forget', { sessionId: 's1', id: candidate.id });
    expect(screen.queryByText(candidate.title)).toBeNull();
    expect(screen.getAllByTestId('memory-row')).toHaveLength(1);
  });

  it('promotes only checked project records and only offers destinations the project belongs to', async () => {
    const outsider = { ...collection, id: 'col-other', name: 'Not a member', members: [{ projectId: beta.id, share: 'wiki' as const }] };
    const shared = rowRecord('Shared copy', 'verified', { scope: 'collection', collectionId: collection.id, promotedFrom: { projectId: alpha.id, projectName: alpha.name }, verification: verified.verification });
    const initial = ledger({ records: [candidate, verified], collections: [collection, outsider] });
    setup(initial, { 'intelligence:promote': { ...initial, shared: [shared] } });
    await openView('memory');
    const blocked = record(candidate.id).getByTestId('memory-promote') as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe('Verify it first');
    await click(record(verified.id).getByTestId('memory-promote'));
    const target = record(verified.id).getByTestId('memory-promote-target');
    expect(within(target).queryByRole('option', { name: outsider.name })).toBeNull();
    expect(within(target).getByRole('option', { name: 'Personal memory' })).toBeTruthy();
    update(target, collection.id);
    await click(record(verified.id).getByTestId('memory-promote-confirm'));
    expect(invoke).toHaveBeenCalledWith('intelligence:promote', { sessionId: 's1', recordId: verified.id, to: 'collection', collectionId: collection.id });
    expect(record(shared.id).getByText('Shared practices · from alpha-lab')).toBeTruthy();
    expect(record(shared.id).getByTestId('memory-revoke')).toBeTruthy();
  });

  it('approves and rejects the selected promotion requests', async () => {
    const ask: PromotionRequest = { id: 'proposal-1', projectId: alpha.id, projectName: alpha.name, source: { recordId: verified.id }, title: 'Share this check', text: verified.text, to: 'collection', collectionId: collection.id, createdAt: at, requestedBy: 'agent:session' };
    let promotions = [ask, { ...ask, id: 'proposal-2', title: 'Keep it private', to: 'personal' as const, collectionId: undefined }];
    const view = () => ledger({ promotions, collections: [collection] });
    setup(view(), { 'intelligence:promotion:decide': ({ id }: { id: string }) => { promotions = promotions.filter((pr) => pr.id !== id); return view(); } });
    await openView('memory');
    const first = within(screen.getAllByTestId('promotion-row')[0]);
    expect(first.getByText('To Shared practices · requested by agent:session')).toBeTruthy();
    await click(first.getByTestId('promotion-approve'));
    expect(invoke).toHaveBeenCalledWith('intelligence:promotion:decide', { sessionId: 's1', id: ask.id, decision: 'approve' });
    const second = within(screen.getByTestId('promotion-row'));
    expect(second.getByText(/To Personal memory/)).toBeTruthy();
    await click(second.getByTestId('promotion-reject'));
    expect(invoke).toHaveBeenCalledWith('intelligence:promotion:decide', { sessionId: 's1', id: 'proposal-2', decision: 'reject' });
    expect(screen.queryByText('Promotion requests')).toBeNull();
  });

  it('adds a labelled record, preserves the draft on a failed invoke and displays the error', async () => {
    const title = 'Personal guide';
    let failed = true;
    setup(ledger(), { 'intelligence:memory:add': () => {
      if (failed) { failed = false; throw new Error("Error invoking remote method 'intelligence:memory:add': Error: Storage full"); }
      return ledger({ personal: [rowRecord(title, 'verified', { projectId: null, scope: 'personal', verification: { at, method: 'human-review' } })] });
    } });
    await openView('memory');
    await click(screen.getByTestId('memory-add'));
    const form = within(screen.getByTestId('memory-add-form'));
    update(form.getByTestId('memory-add-type'), 'preference');
    update(form.getByTestId('memory-add-scope'), 'personal');
    update(form.getByRole('textbox', { name: 'Title' }), title);
    update(form.getByRole('textbox', { name: 'Text' }), 'Keep editor logs visible.');
    const args = { sessionId: 's1', type: 'preference', scope: 'personal', title, text: 'Keep editor logs visible.' };
    await click(form.getByTestId('memory-add-save'));
    expect(invoke).toHaveBeenCalledWith('intelligence:memory:add', args);
    expect(within(screen.getByTestId('memory-view')).getByRole('alert').textContent).toBe('Storage full');
    expect((form.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(title);
    await click(form.getByTestId('memory-add-save'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('memory-add-form')).toBeNull();
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(/Personal memory is off/)).toBeTruthy();
  });

  it('validates JSON before import, reports counts, and writes a record into the wiki', async () => {
    const payload = { format: 'vocs-memory-export', version: 1, records: [candidate] };
    const imported = ledger({ records: [candidate] });
    setup(ledger(), {
      'intelligence:memory:import': { imported: 1, skipped: 2, view: imported },
      'intelligence:memory:apply': { pageId: 'gotchas/retry-lesson', view: ledger() }
    });
    await openView('memory');
    const file = (contents: string) => Object.assign(new File([contents], 'memories.json'), { text: async () => contents });
    const selectFile = (contents: string) => act(async () => {
      fireEvent.change(screen.getByTestId('memory-import-file'), { target: { files: [file(contents)] } });
    });
    await selectFile('not JSON');
    expect(screen.getByRole('alert').textContent).toBe('That file is not valid JSON');
    expect(invoke).not.toHaveBeenCalledWith('intelligence:memory:import', expect.anything());
    await selectFile(JSON.stringify(payload));
    expect(invoke).toHaveBeenCalledWith('intelligence:memory:import', { sessionId: 's1', bundle: payload });
    expect(screen.getByTestId('memory-result').textContent).toBe('Imported 1, skipped 2');
    await click(record(candidate.id).getByTestId('memory-apply'));
    expect(invoke).toHaveBeenCalledWith('intelligence:memory:apply', { sessionId: 's1', id: candidate.id });
    expect(screen.getByTestId('memory-result').textContent).toBe('Written to wiki page gotchas/retry-lesson');
    expect(screen.queryByTestId('memory-row')).toBeNull();
  });

  it('explains selective Local recall and distinguishes it from Reflect and its provider warning', async () => {
    let reflected = false;
    setup(ledger(), {
      'intelligence:view': () => ledger({ records: reflected ? [candidate] : [] }),
      'intelligence:reflect': () => { reflected = true; return { ok: true, captured: 1, candidates: 1, detail: 'Captured one episode' }; }
    });
    await openView('memory');
    const button = screen.getByTestId('memory-reflect');
    expect(screen.getByText(/after completed turns/i).textContent).toMatch(/capture makes no model calls/i);
    const recall = screen.getByText(/up to 3 short, topic-matched notes/i);
    expect(recall.textContent).toMatch(/with local selected.*in this project.*from source sessions it can access/i);
    expect(recall.textContent).toMatch(/no list or broad fallback/i);
    expect(recall.textContent).toMatch(/recalled notes are history, not guidance.*verification changes their authority in memory, not recall access/i);
    expect(screen.getByText(/not automatically added to prompts/i).textContent).toMatch(/no extra provider request.*session’s model.*tool results.*cloud-backed/i);
    expect(screen.getByRole('button', { name: 'Reflect on this session', description: /session transcript to your configured background model provider/ })).toBe(button);
    expect(intelligenceCalls()).toEqual([['intelligence:view', { sessionId: 's1' }]]);
    await click(button);
    expect(invoke).toHaveBeenCalledWith('intelligence:reflect', { sessionId: 's1' });
    expect(screen.getByTestId('memory-reflect-result').textContent).toBe('Captured one episode');
    expect(record(candidate.id).getByTestId('memory-state').textContent).toBe('candidate');
  });

  it('keeps saved Local notes visible on the desktop and explains that agents cannot recall them when Off', async () => {
    const saved = rowRecord('Saved Local outcome', 'captured', { origin: 'agent:local-learning' });
    setup(ledger({ settings: resolveIntelligenceSettings({ reflection: 'off' }), records: [saved] }));
    await openView('memory');
    const button = screen.getByTestId('memory-reflect') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(record(saved.id).getByText(saved.text)).toBeTruthy();
    expect(screen.getByText(/off keeps saved notes visible on the desktop but withholds them from agents/i)).toBeTruthy();
    expect(screen.queryByText(/after completed turns/i)).toBeNull();
    await click(button);
    expect(intelligenceCalls()).toEqual([['intelligence:view', { sessionId: 's1' }]]);
  });

  it('refreshes open Memory after a matching desktop push, not for a hidden tab or another session', async () => {
    let current = ledger();
    setup(current, { 'intelligence:view': () => current });
    await openView('memory');
    current = ledger({ records: [candidate] });
    await pushMemoryChange('s2');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await pushMemoryChange('s1');
    expect(screen.queryByTestId('memory-row')).toBeNull();
    expect(intelligenceCalls()).toHaveLength(1);

    visibility.mockReturnValue('visible');
    await pushMemoryChange('s1');
    expect(record(candidate.id).getByTestId('memory-state').textContent).toBe('candidate');
    expect((record(candidate.id).getByTestId('memory-promote') as HTMLButtonElement).disabled).toBe(true);
    await openView('collections');
    await pushMemoryChange('s1');
    expect(intelligenceCalls()).toEqual(Array.from({ length: 2 }, () => ['intelligence:view', { sessionId: 's1' }]));
    expect(memoryListeners.size).toBe(0);
  });

  it('coalesces pushes during a pending Memory action and preserves its result', async () => {
    const reflection = deferred<{ ok: boolean; captured: number; candidates: number; error: string }>();
    let current = ledger();
    setup(current, { 'intelligence:view': () => current, 'intelligence:reflect': reflection.promise });
    await openView('memory');
    await click(screen.getByTestId('memory-reflect'));
    current = ledger({ records: [candidate] });
    await pushMemoryChange('s1', 's1');
    const before = [['intelligence:view', { sessionId: 's1' }], ['intelligence:reflect', { sessionId: 's1' }]];
    expect(intelligenceCalls()).toEqual(before);

    await act(async () => { reflection.resolve({ ok: false, captured: 0, candidates: 0, error: 'Could not reflect' }); });
    expect(intelligenceCalls()).toEqual([...before, ['intelligence:view', { sessionId: 's1' }]]);
    expect(screen.getByTestId('memory-reflect-result').textContent).toBe('Could not reflect');
    expect(record(candidate.id).getByTestId('memory-state').textContent).toBe('candidate');
  });

  it('discards a pending passive read after leaving and reopening the Memory tab', async () => {
    const stale = deferred<IntelligenceView>();
    let reads = 0;
    setup(ledger(), { 'intelligence:view': () => ++reads === 1 ? ledger() : stale.promise });
    await openView('memory');
    await pushMemoryChange('s1');
    expect(reads).toBe(2);
    await openView('collections');
    await openView('memory');
    await act(async () => { stale.resolve(ledger({ records: [candidate] })); });
    expect(reads).toBe(2);
    expect(screen.queryByTestId('memory-row')).toBeNull();
  });

  it('does not send the old session a follow-up refresh after reflection settles', async () => {
    const reflection = deferred<{ ok: boolean; captured: number; candidates: number; detail: string }>();
    const instance = setup(ledger(), { 'intelligence:reflect': reflection.promise });
    await openView('memory');
    await click(screen.getByTestId('memory-reflect'));
    await act(async () => { instance.rerender(<KnowledgeTab session={session('s2')} />); });
    await screen.findByTestId('memory-view');
    await act(async () => { reflection.resolve({ ok: true, captured: 1, candidates: 0, detail: 'Old session reflected' }); });
    expect(screen.queryByTestId('memory-reflect-result')).toBeNull();
    expect(intelligenceCalls()).toEqual([
      ['intelligence:view', { sessionId: 's1' }], ['intelligence:reflect', { sessionId: 's1' }], ['intelligence:view', { sessionId: 's2' }]
    ]);
  });
});

describe('Collections, Sources and Evidence', () => {
  it('saves the complete local membership draft and confirms collection deletion', async () => {
    const created = { ...collection, members: [collection.members[0]] };
    let current = ledger();
    setup(current, {
      'intelligence:collection:save': ({ id, members }: { id?: string; members: ProjectCollection['members'] }) => {
        current = ledger({ collections: [{ ...(id ? collection : created), members }] });
        return current;
      },
      'intelligence:collection:delete': () => ledger()
    });
    await openView('collections');
    update(screen.getByTestId('collection-new-name'), collection.name);
    await click(screen.getByTestId('collection-new-create'));
    const newPayload = { sessionId: 's1', name: collection.name, members: [{ projectId: alpha.id, share: 'promoted' }] };
    expect(invoke).toHaveBeenCalledWith('intelligence:collection:save', newPayload);
    const card = within(screen.getByTestId('collection-card'));
    update(card.getByLabelText('Add project'), beta.id);
    update(card.getByLabelText(`Sharing for ${beta.name}`), 'wiki');
    expect(invoke.mock.calls.filter(([channel]) => channel === 'intelligence:collection:save')).toHaveLength(1);
    await click(card.getByTestId('collection-save'));
    expect(invoke).toHaveBeenLastCalledWith('intelligence:collection:save', {
      ...newPayload, id: collection.id, description: collection.description,
      members: [...newPayload.members, { projectId: beta.id, share: 'wiki' }]
    });
    expect((card.getByLabelText(`Sharing for ${beta.name}`) as HTMLSelectElement).value).toBe('wiki');
    await click(card.getByTestId('collection-delete'));
    expect(invoke).not.toHaveBeenCalledWith('intelligence:collection:delete', expect.anything());
    await click(card.getByTestId('collection-delete-confirm'));
    expect(invoke).toHaveBeenCalledWith('intelligence:collection:delete', { sessionId: 's1', id: collection.id });
    expect(screen.queryByTestId('collection-card')).toBeNull();
  });

  it('defaults Graphify on and excludes only the project the user switches off', async () => {
    const defaults = resolveIntelligenceSettings(undefined);
    let settings = defaults;
    setup(ledger(), {
      'intelligence:view': () => ledger({ settings, graph: { ...bundledGraph, enabled: !settings.graphify.excludedProjects.includes(alpha.id) } }),
      'settings:update': ({ intelligence }: { intelligence: IntelligenceSettings }) => { settings = intelligence; }
    });
    await openView('sources');
    expect((screen.getByTestId('setting-graphify') as HTMLInputElement).checked).toBe(true);
    const graphProject = screen.getByTestId('setting-graphify-project') as HTMLInputElement;
    const index = screen.getByTestId('graph-index') as HTMLButtonElement;
    expect(graphProject.checked).toBe(true);
    expect(index.disabled).toBe(false);
    expect(within(screen.getByTestId('graph-status')).getByText('Bundled')).toBeTruthy();
    expect(screen.getByText(/automatically indexes committed code by revision in Git workspaces you open/).textContent).toContain('no model, cloud service, or separate download');
    expect(invoke).not.toHaveBeenCalledWith('settings:update', expect.anything());
    await click(graphProject);
    expect(invoke).toHaveBeenCalledWith('settings:update', { intelligence: { ...defaults, graphify: { enabled: true, excludedProjects: [alpha.id] } } });
    expect(graphProject.checked).toBe(false);
    expect(index.disabled).toBe(true);
    await click(graphProject);
    expect(settings.graphify).toEqual({ enabled: true, excludedProjects: [] });
    expect(graphProject.checked).toBe(true);
    expect(index.disabled).toBe(false);
  });

  it('defaults to Local and persists each reflection choice without starting reflection', async () => {
    const defaults = resolveIntelligenceSettings(undefined);
    let settings = defaults;
    setup(ledger(), {
      'intelligence:view': () => ledger({ settings }),
      'settings:update': ({ intelligence }: { intelligence: IntelligenceSettings }) => { settings = intelligence; }
    });
    await openView('sources');
    const select = screen.getByTestId('setting-reflection') as HTMLSelectElement;
    expect(select.value).toBe('local');
    expect(select.selectedOptions[0].textContent).toMatch(/local.*completed turns/i);
    expect(screen.getByRole('combobox', { name: 'Session reflection', description: /capture makes no model calls.*up to 3 short, topic-matched notes.*cloud-backed.*off keeps saved notes.*when a session is archived or merged/i })).toBe(select);
    expect(invoke).not.toHaveBeenCalledWith('settings:update', expect.anything());
    for (const reflection of ['off', 'manual', 'auto', 'local'] as const) {
      await act(async () => update(select, reflection));
      expect(invoke).toHaveBeenCalledWith('settings:update', { intelligence: { ...defaults, reflection } });
      expect(select.value).toBe(reflection);
    }
    expect(invoke).not.toHaveBeenCalledWith('intelligence:reflect', expect.anything());
  });

  it('shows gateway status and honors saved Graphify global off and project exclusions independently', async () => {
    const settings = resolveIntelligenceSettings({ reflection: 'manual', graphify: { enabled: false, excludedProjects: [alpha.id, beta.id] } });
    let current = settings;
    setup(ledger(), {
      'intelligence:view': () => ledger({ settings: current, gateway: { enabled: current.gateway, listening: current.gateway, sessions: current.gateway ? 2 : 0 } }),
      'settings:update': ({ intelligence }: { intelligence: IntelligenceSettings }) => { current = intelligence; }
    });
    await openView('sources');
    expect(screen.getByTestId('gateway-status').textContent).toBe('Listening · 2 sessions connected');
    const graphify = screen.getByTestId('setting-graphify') as HTMLInputElement;
    const graphProject = screen.getByTestId('setting-graphify-project') as HTMLInputElement;
    expect(graphify.checked).toBe(false);
    expect(graphProject.disabled).toBe(true);
    await click(screen.getByTestId('setting-gateway'));
    expect(invoke).toHaveBeenCalledWith('settings:update', { intelligence: { ...settings, gateway: false } });
    expect((screen.getByTestId('setting-gateway') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('gateway-status').textContent).toBe('Not listening · 0 sessions connected');
    await click(graphify);
    expect(current.graphify).toEqual({ enabled: true, excludedProjects: [alpha.id, beta.id] });
    expect(graphProject.checked).toBe(false);
    await click(graphProject);
    expect(invoke).toHaveBeenCalledWith('settings:update', {
      intelligence: { ...settings, gateway: false, graphify: { enabled: true, excludedProjects: [beta.id] } }
    });
    expect(graphProject.checked).toBe(true);
    expect((screen.getByTestId('setting-reflection') as HTMLSelectElement).value).toBe('manual');
  });

  it('explains the unavailable bundled worker without an install instruction or losing other sources', async () => {
    setup(ledger({ graph: { ...bundledGraph, installed: false, indexed: true, revision } }));
    const sources = await openView('sources');
    expect(within(screen.getByTestId('graph-status')).getByText('Unavailable')).toBeTruthy();
    expect(screen.getByText(/bundled Graphify worker is unavailable/).textContent).toContain('wiki, memory, and other sources still work');
    expect(sources.textContent).not.toMatch(/uv tool install|not installed/i);
    expect((screen.getByTestId('graph-index') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('graph-clear') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('setting-gateway') as HTMLInputElement).disabled).toBe(false);
  });

  it('refreshes the new session on an app-wide settings push without refreshing the old one', async () => {
    const saved = deferred<void>();
    let settings = resolveIntelligenceSettings(undefined);
    const instance = setup(ledger(), {
      'intelligence:view': ({ sessionId }: { sessionId: string }) => ledger({ settings, project: sessionId === 's1' ? alpha : beta }),
      'settings:update': saved.promise
    });
    await openView('sources');
    await click(screen.getByTestId('setting-gateway'));
    await act(async () => { instance.rerender(<KnowledgeTab session={session('s2')} />); });
    expect((screen.getByTestId('setting-gateway') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      settings = { ...settings, gateway: false };
      useStore.setState({ settings: { ...useStore.getState().settings!, intelligence: settings } });
      saved.resolve();
    });
    expect((screen.getByTestId('setting-gateway') as HTMLInputElement).checked).toBe(false);
    expect(intelligenceCalls()).toEqual([
      ['intelligence:view', { sessionId: 's1' }], ['intelligence:view', { sessionId: 's2' }], ['intelligence:view', { sessionId: 's2' }]
    ]);
  });

  it('builds the index on request, shows progress and cached metadata, and clears the cache', async () => {
    const pending = deferred<IntelligenceView>();
    const empty = ledger({ graph: bundledGraph });
    setup(empty, { 'intelligence:graph:index': pending.promise, 'intelligence:graph:clear': empty });
    await openView('sources');
    const index = screen.getByTestId('graph-index') as HTMLButtonElement;
    expect(index.disabled).toBe(false);
    await click(index);
    expect(invoke).toHaveBeenCalledWith('intelligence:graph:index', { sessionId: 's1' });
    expect(index.textContent).toContain('Indexing');
    expect(index.disabled).toBe(true);
    await act(async () => { pending.resolve(ledger({ graph: { ...bundledGraph, indexed: true, stale: true, version: '0.9.115', revision, indexedAt: at, nodes: 7, edges: 9 } })); });
    expect(index.textContent).toBe('Refresh index');
    expect(screen.getByTestId('graph-status').textContent).toContain('Stale');
    expect(screen.getByText('7 nodes · 9 edges')).toBeTruthy();
    await click(screen.getByTestId('graph-clear'));
    expect(invoke).toHaveBeenCalledWith('intelligence:graph:clear', { sessionId: 's1' });
    expect(index.textContent).toBe('Build index');
  });

  it('follows automatic indexing to completion without starting a build or publishing settings from the poll', async () => {
    vi.useFakeTimers();
    const empty = ledger({ graph: bundledGraph });
    let current = empty;
    setup(empty, { 'intelligence:view': () => current });
    await click(screen.getByTestId('knowledge-view-sources'));
    const status = within(screen.getByTestId('graph-status'));
    expect(status.getByText('Not indexed')).toBeTruthy();
    current = { ...empty, graph: { ...bundledGraph, indexing: true } };
    await advance(3_000);
    expect(status.getByText('Indexing')).toBeTruthy();
    expect((screen.getByTestId('graph-clear') as HTMLButtonElement).disabled).toBe(true);
    current = { ...empty, settings: { ...empty.settings, gateway: false }, graph: { ...bundledGraph, indexed: true, revision } };
    await advance(3_000);
    expect(status.getByText('Indexed')).toBeTruthy();
    expect(status.queryByText('Indexing')).toBeNull();
    expect((screen.getByTestId('setting-gateway') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('graph-index').textContent).toBe('Refresh index');
    await advance(60_000);
    expect(intelligenceCalls()).toEqual(Array.from({ length: 3 }, () => ['intelligence:view', { sessionId: 's1' }]));
    expect(invoke).not.toHaveBeenCalledWith('settings:update', expect.anything());
  });

  it('keeps settings usable while polling a running job and ignores its older status after an opt-out', async () => {
    vi.useFakeTimers();
    const pending = deferred<IntelligenceView>();
    const running = ledger({ graph: { ...bundledGraph, indexing: true } });
    let current = running;
    let reads = 0;
    setup(running, {
      'intelligence:view': () => ++reads === 2 ? pending.promise : current,
      'settings:update': ({ intelligence }: { intelligence: IntelligenceSettings }) => { current = ledger({ settings: intelligence, graph: { ...bundledGraph, enabled: false } }); }
    });
    await click(screen.getByTestId('knowledge-view-sources'));
    await advance(6_000);
    expect(reads).toBe(2);
    const setting = screen.getByTestId('setting-graphify') as HTMLInputElement;
    expect(setting.disabled).toBe(false);
    await click(setting);
    expect(setting.checked).toBe(false);
    await act(async () => { pending.resolve(ledger({ graph: { ...bundledGraph, indexed: true, revision } })); });
    expect(setting.checked).toBe(false);
    expect(within(screen.getByTestId('graph-status')).getByText('Not indexed')).toBeTruthy();
    await advance(60_000);
    expect(reads).toBe(3);
  });

  it('looks for a background build only within a bounded, visible Sources visit', async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    setup(ledger({ graph: bundledGraph }));
    await click(screen.getByTestId('knowledge-view-sources'));
    await advance(60_000);
    expect(intelligenceCalls()).toHaveLength(1);
    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(60_000);
    const reads = intelligenceCalls().length;
    expect(reads).toBeGreaterThan(1);
    await advance(60_000);
    expect(intelligenceCalls()).toHaveLength(reads);

    await click(screen.getByTestId('knowledge-view-memory'));
    await click(screen.getByTestId('knowledge-view-sources'));
    await advance(3_000);
    expect(intelligenceCalls()).toHaveLength(reads + 1);
    await click(screen.getByTestId('knowledge-view-memory'));
    await advance(60_000);
    expect(intelligenceCalls()).toHaveLength(reads + 1);
  });

  it('does not apply a pending graph status read after switching sessions', async () => {
    vi.useFakeTimers();
    const pending = deferred<IntelligenceView>();
    let alphaReads = 0;
    const instance = setup(ledger(), {
      'intelligence:view': ({ sessionId }: { sessionId: string }) => sessionId === 's2'
        ? ledger({ project: beta })
        : ++alphaReads === 1 ? ledger({ graph: bundledGraph }) : pending.promise
    });
    await click(screen.getByTestId('knowledge-view-sources'));
    await advance(3_000);
    expect(alphaReads).toBe(2);
    await act(async () => { instance.rerender(<KnowledgeTab session={session('s2')} />); });
    await act(async () => { pending.resolve(ledger({ graph: { ...bundledGraph, indexed: true, revision } })); });
    expect(within(screen.getByTestId('graph-status')).getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText(revision.slice(0, 12))).toBeNull();
    await advance(60_000);
    expect(intelligenceCalls()).toEqual([
      ['intelligence:view', { sessionId: 's1' }], ['intelligence:view', { sessionId: 's1' }], ['intelligence:view', { sessionId: 's2' }]
    ]);
  });

  it('shows evidence provenance, conflicts and missing sources, then compiles the same question', async () => {
    const query = 'What did we try before?';
    const result: IntelligenceSearchResponse = {
      query, intent: 'history', scope: { projectId: alpha.id, projectName: alpha.name, collections: [collection.name] },
      results: [{ provider: 'memory', projectId: alpha.id, projectName: alpha.name, ref: 'mem-old', title: 'Old timer', text: '\u0001Timer\u0002 expired', authority: 'candidate', historical: true, scope: 'project', score: 0.8, why: 'matches timer', freshness: 'stale', staleReason: 'HEAD changed', revision }],
      conflicts: [{ a: 'Note A', b: 'Note B', reason: 'Different timings' }], missing: ['Graphify not indexed']
    };
    const packet: ContextPacket = { query, intent: result.intent, scope: result.scope, text: '# Context\nThe older timer expired.', sections: [], conflicts: result.conflicts, missing: result.missing, usedTokens: 12, budgetTokens: 250, truncated: true };
    setup(ledger(), { 'intelligence:search': result, 'intelligence:compile': packet });
    await openView('evidence');
    update(screen.getByTestId('evidence-query'), ` ${query} `);
    update(screen.getByTestId('evidence-scope'), 'collection');
    await click(screen.getByTestId('evidence-search'));
    const request = { sessionId: 's1', query, scope: 'collection' };
    expect(invoke).toHaveBeenCalledWith('intelligence:search', request);
    const evidence = within(screen.getByTestId('evidence-row'));
    expect(evidence.getByText('history')).toBeTruthy();
    expect(evidence.getByText('Timer expired')).toBeTruthy();
    expect(evidence.getByText('stale — HEAD changed')).toBeTruthy();
    expect(evidence.getByText('1234567890ab')).toBeTruthy();
    expect(screen.getByTestId('evidence-conflicts').textContent).toContain('Note A vs Note B: Different timings');
    expect(screen.getByTestId('evidence-missing').textContent).toContain('Graphify not indexed');
    expect(screen.getByText('Detected intent: history')).toBeTruthy();
    await click(screen.getByTestId('evidence-compile'));
    expect(invoke).toHaveBeenCalledWith('intelligence:compile', request);
    expect(screen.getByTestId('evidence-packet').textContent).toBe(packet.text);
    expect(screen.getByText('12 of 250 tokens · truncated')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Helped' })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('intelligence:usage:vote', expect.anything());
    update(screen.getByTestId('evidence-query'), 'Another question');
    await waitFor(() => expect(screen.queryByTestId('evidence-packet')).toBeNull());
  });

  it('rates search and packet receipts independently, allows replacing a vote and handles a refused receipt', async () => {
    const query = 'Cache timing';
    const result: IpcResponse<'intelligence:search'> = {
      query, intent: 'history', scope: { projectId: alpha.id, projectName: alpha.name, collections: [] },
      results: [], conflicts: [], missing: [], usageReceipt: 'search-receipt'
    };
    const packet: ContextPacket = {
      query, intent: result.intent, scope: result.scope, text: '# Context', sections: [], conflicts: [], missing: [], usedTokens: 3, budgetTokens: 250, truncated: false
    };
    let compiles = 0;
    setup(ledger(), {
      'intelligence:search': result,
      'intelligence:compile': () => ({ ...packet, usageReceipt: `packet-${++compiles}` }),
      'intelligence:usage:vote': ({ receipt }: IpcRequest<'intelligence:usage:vote'>) => receipt !== 'packet-1'
    });
    await openView('evidence');
    update(screen.getByTestId('evidence-query'), query);
    await click(screen.getByTestId('evidence-search'));
    await click(screen.getByTestId('evidence-compile'));
    const search = within(screen.getByRole('group', { name: 'Did this search help?' }));
    const packetRating = () => within(screen.getByRole('group', { name: 'Did this context packet help?' }));
    await click(search.getByRole('button', { name: 'Helped' }));
    expect(search.getByRole('button', { name: 'Helped', pressed: true })).toBeTruthy();
    await click(search.getByRole('button', { name: 'Not helpful' }));
    expect(search.getByRole('button', { name: 'Not helpful', pressed: true })).toBeTruthy();
    await click(packetRating().getByRole('button', { name: 'Helped' }));
    expect(packetRating().getByRole('alert').textContent).toContain('can no longer be rated');
    expect((packetRating().getByRole('button', { name: 'Helped', pressed: false }) as HTMLButtonElement).disabled).toBe(true);
    await click(screen.getByTestId('evidence-compile'));
    expect(packetRating().queryByRole('alert')).toBeNull();
    await click(packetRating().getByRole('button', { name: 'Helped' }));
    expect(packetRating().getByRole('button', { name: 'Helped', pressed: true })).toBeTruthy();
    expect(intelligenceCalls().filter(([channel]) => channel === 'intelligence:usage:vote').map(([, payload]) => payload)).toEqual([
      { sessionId: 's1', receipt: 'search-receipt', vote: 'helped' },
      { sessionId: 's1', receipt: 'search-receipt', vote: 'not-helpful' },
      { sessionId: 's1', receipt: 'packet-1', vote: 'helped' },
      { sessionId: 's1', receipt: 'packet-2', vote: 'helped' }
    ]);
  });
});
