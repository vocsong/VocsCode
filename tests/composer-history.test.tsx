// Repro: ArrowUp in the composer should recall the previous prompt.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

// Stub the preload bridge before any renderer module runs.
const invokeMock = vi.fn().mockResolvedValue({ ok: true });
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { fireEvent, render, waitFor } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const session: SessionMeta = {
  id: 's1',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  config: { harness: 'native', cwd: '.', permissionMode: 'default' },
  cwd: '.',
  status: 'idle',
  harnessRef: {} as SessionMeta['harnessRef'],
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
} as unknown as SessionMeta;

const type = (ta: HTMLTextAreaElement, v: string) => fireEvent.change(ta, { target: { value: v } });
const makeSession = (id: string): SessionMeta => ({ ...session, id });

/** App.tsx mounts the composer as `<Composer key={session.id} …>`, so switching sessions unmounts it. */
const switchTo = (id: string) => {
  const view = render(<Composer session={makeSession(id)} />);
  return { view, ta: view.container.querySelector('textarea') as HTMLTextAreaElement };
};

describe('composer input history', () => {
  it('recalls the last sent message with ArrowUp', () => {
    const { container } = render(<Composer session={session} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    type(ta, 'hello world');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('');

    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('hello world');

    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    expect(ta.value).toBe('');
  });

  it('still recalls history after running a slash command', () => {
    const { container } = render(<Composer session={session} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    type(ta, '/cost');
    fireEvent.keyDown(ta, { key: 'Enter' });
    type(ta, 'second message');
    fireEvent.keyDown(ta, { key: 'Enter' });

    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('second message');
  });

  it('recalls history immediately after a slash command, without typing first', () => {
    const { container } = render(<Composer session={session} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    type(ta, 'first message');
    fireEvent.keyDown(ta, { key: 'Enter' });
    type(ta, '/cost');
    fireEvent.keyDown(ta, { key: 'Enter' });
    // Press ArrowUp right away — no typing in between.
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('first message');
  });

  it('still recalls history after an @-mention draft', () => {
    const { container } = render(<Composer session={session} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;

    type(ta, 'fix @src/ma');
    fireEvent.keyDown(ta, { key: 'Escape' }); // dismiss the mention popover
    fireEvent.change(ta, { target: { value: '' } });
    type(ta, 'plain message');
    fireEvent.keyDown(ta, { key: 'Enter' });

    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('plain message');
  });

  it('recalls history after switching to another session and back', () => {
    const first = switchTo('hist-a');
    type(first.ta, 'sent in session one');
    fireEvent.keyDown(first.ta, { key: 'Enter' });
    first.view.unmount();

    const other = switchTo('hist-b');
    type(other.ta, 'sent in session two');
    fireEvent.keyDown(other.ta, { key: 'Enter' });
    other.view.unmount();

    const back = switchTo('hist-a');
    fireEvent.keyDown(back.ta, { key: 'ArrowUp' });
    expect(back.ta.value).toBe('sent in session one');
  });

  it('keeps each session’s history to itself', () => {
    const a = switchTo('hist-c');
    type(a.ta, 'from c');
    fireEvent.keyDown(a.ta, { key: 'Enter' });
    a.view.unmount();

    const b = switchTo('hist-d');
    type(b.ta, 'from d');
    fireEvent.keyDown(b.ta, { key: 'Enter' });
    b.view.unmount();

    const back = switchTo('hist-d');
    fireEvent.keyDown(back.ta, { key: 'ArrowUp' });
    expect(back.ta.value).toBe('from d');
    // Walk back one further: session c's prompt must not be reachable from session d.
    fireEvent.keyDown(back.ta, { key: 'ArrowUp' });
    expect(back.ta.value).toBe('from d');
  });

  it('remembers an effort selected through the slash command', async () => {
    const { container } = render(<Composer session={session} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    invokeMock.mockClear();

    type(ta, '/effort high');
    fireEvent.keyDown(ta, { key: 'Enter' });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('settings:update', { defaultEffort: 'high' }));
    expect(invokeMock).toHaveBeenCalledWith('sessions:setEffort', { id: 's1', effort: 'high' });
  });

  it('does not remember effort for a harness that cannot apply it', async () => {
    const cursorSession = { ...session, config: { ...session.config, harness: 'cursor' as const } };
    useStore.setState({ toasts: [] });
    const { container } = render(<Composer session={cursorSession} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    invokeMock.mockClear();

    type(ta, '/effort high');
    fireEvent.keyDown(ta, { key: 'Enter' });

    await waitFor(() => expect(useStore.getState().toasts.some((toast) => toast.text.includes('does not support reasoning effort'))).toBe(true));
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:setEffort', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('settings:update', expect.anything());
  });

  it('refuses /effort for a model that takes no effort', async () => {
    const haiku = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };
    const haikuSession = { ...session, id: 's_haiku', config: { ...session.config, harness: 'claude' as const, model: haiku } };
    useStore.setState({ toasts: [], models: { s_haiku: [{ id: haiku.model, provider: haiku.provider, displayName: 'Haiku 4.5', supportedEfforts: [] }] } });
    const { container } = render(<Composer session={haikuSession} />);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    invokeMock.mockClear();

    type(ta, '/effort high');
    fireEvent.keyDown(ta, { key: 'Enter' });

    await waitFor(() => expect(useStore.getState().toasts.map((toast) => toast.text)).toContain('Haiku 4.5 does not support reasoning effort.'));
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:setEffort', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('settings:update', expect.anything());
  });
});
