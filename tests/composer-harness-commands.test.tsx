/** The composer offers each harness's own slash commands beside the app's, and routes a picked one
 *  to the harness: `/name` verbatim, `//name` for a harness command an app command shadows. */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true }) as unknown);
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { useStore } from '../src/renderer/src/store';
import type { HarnessId, SessionMeta, TranscriptItem } from '../src/shared/types';
import type { HarnessCommand } from '../src/shared/harness-commands';

const CLAUDE_COMMANDS: HarnessCommand[] = [
  { name: 'review', description: 'Review a pull request', argumentHint: '[pr]', kind: 'command' },
  { name: 'security-review', description: 'Security review', kind: 'command' },
  { name: 'deploy', description: 'Ship it', argumentHint: '<env>', kind: 'skill' },
  { name: 'pr', description: 'My own PR skill', kind: 'skill' },
  { name: 'compact', description: 'Compact', kind: 'command' }
];

function session(id: string, harness: HarnessId, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id, title: 't', createdAt: 0, updatedAt: 0, cwd: '/repo', status: 'idle', harnessRef: {},
    config: { harness, projectRoot: '/repo', permissionMode: 'ask' },
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
    ...extra
  } as SessionMeta;
}

function mount(s: SessionMeta) {
  useStore.setState({ sessions: [...useStore.getState().sessions.filter((x) => x.id !== s.id), s] });
  const { container } = render(<Composer session={s} />);
  const ta = container.querySelector('textarea') as HTMLTextAreaElement;
  return {
    ta,
    type: (value: string) => fireEvent.change(ta, { target: { value } }),
    key: (key: string) => fireEvent.keyDown(ta, { key }),
    rows: () => [...container.querySelectorAll('.slash-item')].map((el) => `${el.getAttribute('data-source')}:${el.querySelector('.slash-name')?.textContent}`),
    sections: () => [...container.querySelectorAll('.slash-section')].map((el) => el.textContent),
    note: () => container.querySelector('.slash-note')?.textContent ?? null
  };
}

const sent = () => invokeMock.mock.calls.filter((c) => c[0] === 'sessions:send').map((c) => (c[1] as { input: { text: string } }).input.text);

beforeEach(() => {
  invokeMock.mockClear();
  useStore.setState({ sessions: [], transcripts: {}, toasts: [], drafts: {} });
});
afterEach(cleanup);

describe('composer harness commands', () => {
  it('lists the harness’s own commands under its name — first on a bare /, after the app’s once typing — with names that carry - and :', () => {
    const c = mount(session('s1', 'claude', { harnessCommandList: CLAUDE_COMMANDS }));
    c.type('/');
    expect(c.sections()).toEqual(['Claude Agent SDK', 'Vocs Code']);
    // compact is not listed twice: the app's /compact already asks Claude to compact.
    expect(c.rows().filter((r) => r.startsWith('harness:'))).toEqual(['harness:/review', 'harness:/security-review', 'harness:/deploy', 'harness://pr']);
    c.type('/security-r');
    expect(c.rows()).toEqual(['harness:/security-review']);
    c.type('/p');
    expect(c.sections()).toEqual(['Vocs Code', 'Claude Agent SDK']);
    expect(c.rows()[0]).toBe('app:/pr');
  });

  it('Enter on a partial name completes the highlighted command instead of sending it', () => {
    const c = mount(session('s1', 'claude', { harnessCommandList: CLAUDE_COMMANDS }));
    c.type('/rev');
    c.key('Enter');
    expect(c.ta.value).toBe('/review ');
    expect(sent()).toEqual([]);
  });

  it('sends a harness command to the harness verbatim', async () => {
    const c = mount(session('s1', 'claude', { harnessCommandList: CLAUDE_COMMANDS }));
    c.type('/review 42');
    c.key('Enter');
    await waitFor(() => expect(sent()).toEqual(['/review 42']));
  });

  it('routes //pr to the harness’s own /pr, while /pr stays the app’s', async () => {
    const c = mount(session('s1', 'claude', { harnessCommandList: CLAUDE_COMMANDS }));
    c.type('/pr');
    // Picking the shadowed row puts the doubled slash in the box, so the route is visible.
    c.key('ArrowDown');
    c.key('Tab');
    expect(c.ta.value).toBe('//pr ');
    c.type('//pr draft it');
    c.key('Enter');
    await waitFor(() => expect(sent()).toEqual(['/pr draft it']));
    expect(invokeMock.mock.calls.some((call) => call[0] === 'git:pr')).toBe(false);

    c.type('/pr develop');
    c.key('Enter');
    await waitFor(() => expect(invokeMock.mock.calls.some((call) => call[0] === 'git:pr')).toBe(true));
    expect(sent()).toEqual(['/pr draft it']);
  });

  it('opens the Usage panel without sending a prompt or checking quota', async () => {
    useStore.setState({ panelTab: 'changes', panelOpen: false });
    const c = mount(session('s1', 'antigravity'));
    c.type('/usa');
    expect(c.rows()).toEqual(['app:/usage']);
    c.key('Enter');
    expect(c.ta.value).toBe('/usage ');
    c.key('Enter');
    await waitFor(() => expect(useStore.getState()).toMatchObject({ panelTab: 'usage', panelOpen: true }));
    expect(c.ta.value).toBe('');
    expect(sent()).toEqual([]);
    expect(invokeMock.mock.calls.some(([channel]) => channel === 'harness:antigravityQuota')).toBe(false);
  });

  it.each(['/USAGE', '/Usage '])('keeps %j local instead of sending it as a prompt', (input) => {
    useStore.setState({ panelTab: 'changes', panelOpen: false });
    const c = mount(session('s1', 'antigravity'));
    c.type(input);
    c.key('Enter');
    expect(useStore.getState()).toMatchObject({ panelTab: 'usage', panelOpen: true });
    expect(c.ta.value).toBe('');
    expect(sent()).toEqual([]);
  });

  it('only delegates /goal even if a saved session has different native-goal metadata', () => {
    useStore.setState({ panelTab: 'changes', panelOpen: false });
    const c = mount(session('s1', 'claude', { nativeGoal: 'usage' }));
    c.type('/usage');
    expect(c.rows()).toEqual(['app:/usage']);
    c.key('Enter');
    expect(useStore.getState()).toMatchObject({ panelTab: 'usage', panelOpen: true });
    expect(sent()).toEqual([]);
  });

  it('keeps an advertised harness /usage reachable as //usage', async () => {
    const c = mount(session('s1', 'claude', { harnessCommandList: [{ name: 'usage', kind: 'command' }] }));
    c.type('/usage');
    expect(c.rows()).toEqual(['app:/usage', 'harness://usage']);
    c.key('ArrowDown');
    c.key('Tab');
    expect(c.ta.value).toBe('//usage ');
    c.key('Enter');
    await waitFor(() => expect(sent()).toEqual(['/usage']));
  });

  it('borrows a same-project sibling’s list until its own harness has reported one', () => {
    useStore.setState({ sessions: [session('older', 'claude', { harnessCommandList: CLAUDE_COMMANDS, updatedAt: 5 }), session('other-harness', 'pi', { harnessCommandList: [{ name: 'skill:pdf', kind: 'skill' }], updatedAt: 9 })] });
    const c = mount(session('fresh', 'claude'));
    c.type('/dep');
    expect(c.rows()).toEqual(['harness:/deploy']);
    expect(c.note()).toBeNull();
  });

  it('says honestly when a harness has not reported, or cannot list, its commands', () => {
    const claude = mount(session('fresh', 'claude'));
    claude.type('/');
    expect(claude.note()).toBe("Claude Agent SDK's own commands appear here once the session has started.");
    cleanup();
    const native = mount(session('n1', 'native'));
    native.type('/');
    expect(native.note()).toBe('Native loop has no slash commands of its own; any other /text goes to the model as written.');
    cleanup();
    const cursor = mount(session('c1', 'cursor'));
    cursor.type('/');
    expect(cursor.note()).toBe('Cursor does not publish its own commands to Vocs Code; any other /text is passed to it as written.');
  });

  it('/help lists the harness’s commands in the transcript, with the // route when one is shadowed', async () => {
    const c = mount(session('s1', 'claude', { harnessCommandList: CLAUDE_COMMANDS }));
    c.type('/help');
    c.key('Enter');
    const note = () => (useStore.getState().transcripts['s1'] ?? []).find((i): i is Extract<TranscriptItem, { kind: 'info' }> => i.kind === 'info');
    await waitFor(() => expect(note()).toBeDefined());
    expect(note()!.text).toContain('Claude Agent SDK: /review /security-review /deploy //pr');
    expect(note()!.text).toContain('A doubled slash (//name)');
    expect(sent()).toEqual([]);
  });
});
