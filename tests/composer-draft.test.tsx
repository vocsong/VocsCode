// Repro: typing in a session's composer, switching to another session and back used to lose the draft.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

// Stub the preload bridge before any renderer module runs.
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: vi.fn().mockResolvedValue({ ok: true }),
  on: vi.fn().mockReturnValue(() => undefined),
};

import { cleanup, fireEvent, render } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const makeSession = (id: string): SessionMeta =>
  ({
    id,
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    config: { harness: 'native', cwd: '.', permissionMode: 'default' },
    cwd: '.',
    status: 'idle',
    harnessRef: {} as SessionMeta['harnessRef'],
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
  }) as unknown as SessionMeta;

const type = (ta: HTMLTextAreaElement, v: string) => fireEvent.change(ta, { target: { value: v } });

describe('per-session composer draft', () => {
  it('keeps the draft when switching sessions and coming back', () => {
    const a = render(<Composer session={makeSession('s1')} />);
    const taA = a.container.querySelector('textarea') as HTMLTextAreaElement;
    type(taA, 'draft for session one');
    a.unmount();

    const b = render(<Composer session={makeSession('s2')} />);
    const taB = b.container.querySelector('textarea') as HTMLTextAreaElement;
    expect(taB.value).toBe('');
    type(taB, 'draft for session two');
    b.unmount();

    const a2 = render(<Composer session={makeSession('s1')} />);
    expect((a2.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('draft for session one');

    const b2 = render(<Composer session={makeSession('s2')} />);
    expect((b2.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('draft for session two');
  });

  it('clears the stored draft after sending', () => {
    const a = render(<Composer session={makeSession('s1')} />);
    const ta = a.container.querySelector('textarea') as HTMLTextAreaElement;
    type(ta, 'to be sent');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('');
    expect(useStore.getState().drafts['s1']).toBe('');
    a.unmount();

    const a2 = render(<Composer session={makeSession('s1')} />);
    expect((a2.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });
});