/** `/doctor` answers in the transcript instead of reaching the harness, for every harness — Claude
 *  Code's own slash commands are reported through `harnessCommands`, but the app doctor is app-wide. */
/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const info = { version: '9.9.9', platform: 'win32 x64', userData: 'C:\\userData', isPackaged: false };
const report = {
  node: '22.20.0',
  electron: '44.0.0',
  platform: 'win32 x64',
  userData: 'C:\\userData',
  harnesses: {
    claude: { available: true, version: '2.1.274', binaryPath: 'C:\\bin\\claude.exe', authenticated: true },
    codex: { available: false, detail: 'Codex CLI not found.', installHint: 'npm install -g @openai/codex' }
  },
  providers: [{ id: 'anthropic', name: 'Anthropic', hasKey: true, envKeyPresent: false }]
};

// Stub the preload bridge before any renderer module runs.
const invokeMock = vi.fn(async (channel: string) => {
  if (channel === 'app:info') return info;
  if (channel === 'app:doctor') return report;
  return { ok: true };
});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { fireEvent, render, waitFor } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const base = {
  id: 's1',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  cwd: '.',
  status: 'idle',
  harnessRef: {} as SessionMeta['harnessRef'],
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }
} as unknown as SessionMeta;

const session = (): SessionMeta => ({ ...base, config: { harness: 'claude', cwd: '.', projectRoot: '.', permissionMode: 'ask' } }) as unknown as SessionMeta;

/** The info notes the transcript is rendering for the session. */
const infos = (): Extract<TranscriptItem, { kind: 'info' }>[] =>
  (useStore.getState().transcripts['s1'] ?? []).filter((i): i is Extract<TranscriptItem, { kind: 'info' }> => i.kind === 'info');

/** Types one line into a fresh composer and presses Enter. */
function composer() {
  const { container } = render(<Composer session={session()} />);
  const ta = container.querySelector('textarea') as HTMLTextAreaElement;
  return (line: string) => {
    fireEvent.change(ta, { target: { value: line } });
    fireEvent.keyDown(ta, { key: 'Enter' });
  };
}

beforeEach(() => {
  invokeMock.mockClear();
  useStore.setState({ transcripts: {}, toasts: [] });
});

describe('composer /doctor', () => {
  it('prints the runtime report as one transcript note and never sends it to the harness', async () => {
    const type = composer();
    type('/doctor');

    await waitFor(() => expect(infos()[0]?.text).toContain('Claude Agent SDK'));
    expect(invokeMock).toHaveBeenCalledWith('app:doctor', undefined);
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:send', expect.anything());

    // The note replaced its own "checking…" placeholder rather than stacking a second line.
    expect(infos()).toHaveLength(1);
    const [note] = infos();
    expect(note.pending).toBeUndefined();
    expect(note.level).toBe('warn');
    expect(note.text).toContain('Claude Agent SDK · ok · 2.1.274 · C:\\bin\\claude.exe');
    expect(note.text).toContain('Codex (app-server) · missing · Codex CLI not found. · fix: npm install -g @openai/codex');
    expect(note.text).toContain('Anthropic · key stored');
  });

  it('replaces the previous report when run again in the same session', async () => {
    const type = composer();
    type('/doctor');
    await waitFor(() => expect(infos()[0]?.text).toContain('Claude Agent SDK'));

    type('/doctor');
    await waitFor(() => expect(invokeMock.mock.calls.filter((c) => c[0] === 'app:doctor')).toHaveLength(2));
    expect(infos()).toHaveLength(1);
  });
});
