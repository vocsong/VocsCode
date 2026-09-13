/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32', invoke: invokeMock, on: vi.fn().mockReturnValue(() => undefined),
};

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Header } from '../src/renderer/src/components/Header';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { GitSummary, SessionMeta } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const summary = (branch = 'main'): GitSummary => ({
  isRepo: true, branch, files: [{ path: 'a.ts', status: 'M', staged: false }, { path: 'b.ts', status: 'M', staged: false }],
});
const diff = (text: string) => ({ diff: `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+${text}\n` });
const session = (id: string): SessionMeta => ({
  id, title: id, createdAt: 1, updatedAt: 1, cwd: 'G:/proj', status: 'idle', harnessRef: {},
  config: { harness: 'native', projectRoot: 'G:/proj', permissionMode: 'auto' },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
});
const panels = (id = 'a') => <><Header session={session(id)} /><RightPanel session={session(id)} /></>;
const calls = (channel: string) => invokeMock.mock.calls.filter(([c]) => c === channel);
const tick = async () => { await act(async () => { vi.advanceTimersByTime(100); }); };

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  useStore.setState({ panelTab: 'changes', changesVersion: 0, toasts: [], modelCatalog: { native: { models: [], loading: false } } });
  invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'git:summary' ? summary() : channel === 'git:diff' ? diff('initial') : {}));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('shared renderer Git reads', () => {
  it('shares the Header/panel summary and selecting a file only fetches its diff', async () => {
    const pending = deferred<GitSummary>();
    invokeMock.mockImplementation((channel: string) => channel === 'git:summary' ? pending.promise : Promise.resolve(diff('initial')));
    render(<StrictMode>{panels()}</StrictMode>);
    await tick();
    expect(calls('git:summary')).toHaveLength(1);
    // Diff is independent of the expensive status/stat read.
    expect(calls('git:diff')).toHaveLength(1);
    await act(async () => { pending.resolve(summary()); });
    fireEvent.click(screen.getByTitle('b.ts'));
    await tick();
    expect(calls('git:summary')).toHaveLength(1);
    expect(calls('git:diff').at(-1)?.[1]).toEqual({ sessionId: 'a', path: 'b.ts' });
  });

  it.each([true, false])('revalidates a cached summary when Changes opens later (isRepo=%s)', async (isRepo) => {
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'git:summary' ? { isRepo, files: [] } : diff('external-edit')));
    const view = render(<><Header session={session('a')} /></>);
    await tick();
    expect(calls('git:summary')).toHaveLength(1);
    // An external editor (or git init) does not emit a session changesVersion event.
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'git:summary' ? summary() : diff('external-edit')));
    view.rerender(panels());
    await tick();
    expect(calls('git:summary')).toHaveLength(2);
    expect(calls('git:diff')).toHaveLength(1);
    expect(screen.getByTitle('a.ts')).toBeTruthy();
    expect(screen.getByText('external-edit')).toBeTruthy();
    expect(screen.queryByText('Working tree clean.')).toBeNull();
    expect(screen.queryByText('Not a git repository')).toBeNull();
  });

  it('ignores unrelated background completion but refreshes for background activity in the same workspace', async () => {
    const active = session('s1');
    const background = { ...session('s2'), cwd: 'G:/other-project' };
    useStore.setState({ activeId: active.id, sessions: [active, background], transcripts: {} });
    render(panels(active.id));
    await tick();
    const complete = () => {
      useStore.getState().applyEvent({ sessionId: 's2', ts: 1, event: {
        type: 'item.upsert', item: { id: 'tool', kind: 'tool', name: 'shell', status: 'done', ts: 1 },
      } });
      useStore.getState().applyEvent({ sessionId: 's2', ts: 2, event: { type: 'status', status: 'idle' } });
    };
    act(complete);
    await tick();
    expect(calls('git:summary')).toHaveLength(1);
    expect(calls('git:diff')).toHaveLength(1);
    expect(useStore.getState().transcripts.s2).toHaveLength(1);
    act(() => useStore.setState({ sessions: [active, { ...background, cwd: active.cwd }] }));
    act(complete);
    await tick();
    expect(calls('git:summary')).toHaveLength(2);
    expect(calls('git:diff')).toHaveLength(2);
    expect(calls('git:summary').at(-1)?.[1]).toEqual({ sessionId: 's1' });
    expect(screen.getByTitle('Branch main — open the Git panel')).toBeTruthy();
  });

  it('debounces invalidation bursts and keeps only one queued refresh while busy', async () => {
    const pending = deferred<GitSummary>();
    invokeMock.mockImplementation((channel: string) => channel === 'git:summary' ? pending.promise : Promise.resolve(diff('initial')));
    render(panels());
    await tick();
    for (let version = 1; version <= 20; version++) {
      act(() => useStore.setState({ changesVersion: version }));
      await act(async () => { vi.advanceTimersByTime(5); });
    }
    await tick();
    expect(calls('git:summary')).toHaveLength(1);
    await act(async () => { pending.resolve(summary()); });
    await tick();
    expect(calls('git:summary')).toHaveLength(2);
    await tick();
    expect(calls('git:summary')).toHaveLength(2);
    expect(calls('git:diff')).toHaveLength(2);
  });

  it('ignores old selections and preserves the mounted diff during background refresh', async () => {
    const view = render(panels());
    await tick();
    const body = view.container.querySelector('.diff-file');
    expect(body).not.toBeNull();
    const pending = deferred<{ diff: string }>();
    invokeMock.mockImplementation((channel: string, request: { path?: string }) => channel === 'git:summary' ? Promise.resolve(summary()) : request?.path === 'a.ts' ? pending.promise : Promise.resolve(diff('latest-selection')));
    fireEvent.click(screen.getByTitle('a.ts'));
    await tick();
    fireEvent.click(screen.getByTitle('b.ts'));
    await tick();
    expect(view.container.querySelector('.diff-file')).toBe(body);
    await act(async () => { pending.resolve(diff('stale-selection')); });
    await tick();
    expect(screen.queryByText('stale-selection')).toBeNull();
    expect(screen.getByText('latest-selection')).toBeTruthy();
    expect(calls('git:summary')).toHaveLength(1);
    act(() => useStore.setState({ changesVersion: 1 }));
    await tick();
    expect(view.container.querySelector('.diff-file')).toBe(body);
  });

  it('ignores responses from an earlier visit when switching A to B to A', async () => {
    const oldSummary = deferred<GitSummary>();
    const oldDiff = deferred<{ diff: string }>();
    invokeMock.mockImplementation((channel: string) => channel === 'git:summary' ? oldSummary.promise : oldDiff.promise);
    const view = render(panels());
    await tick();
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'git:summary' ? summary('current') : diff('current-visit')));
    view.rerender(panels('b'));
    await tick();
    view.rerender(panels('a'));
    await tick();
    await act(async () => { oldSummary.resolve(summary('stale-branch')); oldDiff.resolve(diff('stale-visit')); });
    await tick();
    expect(screen.getByTitle('Branch current — open the Git panel')).toBeTruthy();
    expect(screen.queryByText('stale-visit')).toBeNull();
    expect(screen.getByText('current-visit')).toBeTruthy();
    expect(calls('git:summary')).toHaveLength(3);
  });

  it('refreshes after revert with All changes, and after commit with the current selection', async () => {
    render(<>{panels()}<ConfirmHost /></>);
    await tick();
    fireEvent.click(screen.getByTitle('b.ts'));
    await tick();
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'git:summary' ? summary('after-mutation') : channel === 'git:diff' ? diff('mutated') : { ok: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revert' }));
    await tick();
    expect(calls('git:revert')).toEqual([['git:revert', { sessionId: 'a', path: 'a.ts' }]]);
    expect(calls('git:summary')).toHaveLength(2);
    expect(calls('git:diff')).toHaveLength(3);
    expect(calls('git:diff').at(-1)?.[1]).toEqual({ sessionId: 'a', path: undefined });
    expect(screen.getByRole('button', { name: /All changes/ }).className).toContain('active');
    fireEvent.click(screen.getByTitle('b.ts'));
    await tick();
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'Save changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit all' }));
    await tick();
    expect(calls('git:commit')).toEqual([['git:commit', { sessionId: 'a', message: 'Save changes' }]]);
    expect(calls('git:summary')).toHaveLength(3);
    expect(calls('git:diff')).toHaveLength(5);
    expect(calls('git:diff').at(-1)?.[1]).toEqual({ sessionId: 'a', path: 'b.ts' });
    expect((screen.getByPlaceholderText('Commit message') as HTMLInputElement).value).toBe('');
  });

  it('retries when a new consumer mounts after failure, without retaining inactive sessions', async () => {
    invokeMock.mockImplementation((channel: string) => channel === 'git:summary' ? Promise.reject(new Error('status failed')) : Promise.resolve(diff('initial')));
    const view = render(<Header session={session('a')} />);
    await tick();
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'git:summary' ? summary('retry') : diff('retry-diff')));
    view.rerender(panels());
    await tick();
    expect(calls('git:summary')).toHaveLength(2);
    expect(screen.getByTitle('Branch retry — open the Git panel')).toBeTruthy();
    view.unmount();
    render(panels());
    await tick();
    expect(calls('git:summary')).toHaveLength(3);
  });

  it('retries a failed shared summary on explicit refresh and updates both consumers', async () => {
    invokeMock.mockImplementation((channel: string) => channel === 'git:summary' ? Promise.reject(new Error('status failed')) : Promise.resolve(diff('initial')));
    render(panels());
    await tick();
    expect(calls('git:summary')).toHaveLength(1);
    expect(useStore.getState().toasts.filter((t) => t.text === 'status failed')).toHaveLength(1);
    invokeMock.mockImplementation((channel: string) => Promise.resolve(channel === 'git:summary' ? summary('recovered') : diff('recovered')));
    fireEvent.click(screen.getByTitle('Refresh'));
    await tick();
    expect(calls('git:summary')).toHaveLength(2);
    expect(screen.getByTitle('Branch recovered — open the Git panel')).toBeTruthy();
    expect(screen.getAllByText('recovered')).toHaveLength(2);
  });
});
