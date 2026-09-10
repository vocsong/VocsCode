// Repro: ArrowUp in the composer should recall the previous prompt.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

// Stub the preload bridge before any renderer module runs.
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: vi.fn().mockResolvedValue({ ok: true }),
  on: vi.fn().mockReturnValue(() => undefined),
};

import { fireEvent, render } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
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
});
