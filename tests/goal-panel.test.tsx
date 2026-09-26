/**
 * The Goal panel on a session whose harness owns `/goal`: it must show who has the command instead of
 * offering controls that would start a second, competing app-side goal, and — because the harness
 * keeps its goal state to itself — show the goal commands the session actually sent, read back out of
 * the transcript, rather than a message that says nothing.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  canInvoke: () => true,
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
  isMac: false,
  modKey: 'Ctrl',
  platform: 'win32',
  isWeb: false,
  webShim: vi.fn()
}));

import { cleanup, render, screen } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 's1',
    title: 'test',
    createdAt: 1,
    updatedAt: 2,
    config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
    cwd: 'G:/proj/a',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...over
  }) as SessionMeta;

const user = (id: string, text: string, ts: number): TranscriptItem => ({ id, kind: 'user', ts, text });
const assistant = (id: string, text: string, ts: number): TranscriptItem => ({ id, kind: 'assistant', ts, text });

/** The panel treats an unloaded transcript as unknown, so every populated case has to say it is loaded. */
const transcript = (items: TranscriptItem[]) => useStore.setState({ transcripts: { s1: items }, loaded: { s1: true } });
const goalText = () => document.querySelector('.goal')?.textContent ?? '';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useStore.setState({ panelTab: 'goal', panelBottomTab: 'mcp', panelBottomOpened: [], toasts: [], transcripts: {}, loaded: {} });
});

afterEach(cleanup);

describe('goal panel with a harness-owned /goal', () => {
  it('says the harness answers /goal and offers no app-side controls', () => {
    render(<RightPanel session={session({ nativeGoal: 'goal' })} />);

    expect(screen.getByText(/belongs to Claude Agent SDK in this session/)).toBeTruthy();
    expect(screen.getByText(/Settings → Goal defaults/)).toBeTruthy();
    expect(document.querySelector('.goal code')?.textContent).toBe('/goal');
    // No objective field, no Set/Restart goal, no pause/clear: the app runs no goal here.
    expect(screen.queryByText('Set goal')).toBeNull();
    expect(screen.queryByText('Restart goal')).toBeNull();
    expect(screen.queryByText('Iteration guard')).toBeNull();
    expect(document.querySelector('.goal textarea')).toBeNull();
  });

  it('shows the goal command the session sent, and the harness reply to it', () => {
    transcript([user('u1', '/goal ship the release by Friday', 1), assistant('a1', 'Goal set. Status: active.', 2)]);
    render(<RightPanel session={session({ nativeGoal: 'goal' })} />);

    expect(screen.getByText('/goal ship the release by Friday')).toBeTruthy();
    expect(goalText()).toContain('Goal set. Status: active.');
    // The app still runs no goal of its own.
    expect(document.querySelector('.goal textarea')).toBeNull();
  });

  it('keeps earlier goal commands, newest first', () => {
    transcript([user('u1', '/goal ship the release', 1), user('u2', '/goal ship it by Friday', 2)]);
    render(<RightPanel session={session({ nativeGoal: 'goal' })} />);

    expect(screen.getByText('/goal ship it by Friday')).toBeTruthy();
    expect(screen.getByText('/goal ship the release')).toBeTruthy();
    expect(goalText()).toContain('Earlier');
  });

  it('does not caption a control sub-command as an objective', () => {
    // The app cannot know the harness's control surface, so `/goal pause` is reported as sent.
    transcript([user('u1', '/goal pause', 1)]);
    render(<RightPanel session={session({ nativeGoal: 'goal' })} />);

    expect(screen.getByText('/goal pause')).toBeTruthy();
  });

  it('says no goal was sent when the loaded transcript has none, and never before it is loaded', () => {
    transcript([user('u1', 'hello there', 1)]);
    const { unmount } = render(<RightPanel session={session({ nativeGoal: 'goal' })} />);
    expect(goalText()).toContain('No /goal command sent in this session yet.');
    unmount();

    // Nothing loaded yet is not the same as knowing the session sent nothing.
    useStore.setState({ transcripts: {}, loaded: {} });
    render(<RightPanel session={session({ nativeGoal: 'goal' })} />);
    expect(document.querySelector('.goal .spinner')).toBeTruthy();
    expect(goalText()).not.toContain('No /goal command sent in this session yet.');
  });

  it('keeps the app controls when the session goal belongs to the app', () => {
    render(<RightPanel session={session()} />);

    expect(screen.getByText('Set goal')).toBeTruthy();
    expect(screen.getByText('Iteration guard')).toBeTruthy();
    expect(document.querySelector('.goal textarea')).toBeTruthy();
  });
});
