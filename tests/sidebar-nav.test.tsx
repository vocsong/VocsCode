// Ctrl+Arrow session navigation and Ctrl+Shift+Arrow folder navigation: the pure nav model in
// Sidebar.tsx must mirror the sidebar's rendered order (saved folder order, pinned-first rows).
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { nextFolderTarget, nextSessionTarget, sidebarNavModel } from '../src/renderer/src/components/Sidebar';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const settings = {
  folders: [],
  folderOrder: ['G:/proj/b', 'G:/proj/a', 'G:/proj/empty'],
  collapsedFolders: [],
} as unknown as AppSettings;

const session = (root: string, id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  title: `Session ${id}`,
  cwd: root,
  config: { projectRoot: root, harness: 'native' },
  status: 'idle',
  archived: false,
  pinned: false,
  updatedAt: 1000,
  usage: { costUsd: 0 },
  ...over,
} as unknown as SessionMeta);

// Folder B is positioned before A via folderOrder; each has two sessions by recency.
const sessions = [
  session('G:/proj/a', 'a-old', { updatedAt: 500 }),
  session('G:/proj/b', 'b-old', { updatedAt: 500 }),
  session('G:/proj/a', 'a-new', { updatedAt: 1500 }),
  session('G:/proj/b', 'b-new', { updatedAt: 1500 }),
  session('G:/proj/a', 'a-archived', { updatedAt: 2000, archived: true }),
];

const model = () => sidebarNavModel(sessions, settings);

describe('sidebar nav model', () => {
  it('orders folders by folderOrder and sessions by recency, skipping archived', () => {
    expect(model()).toEqual([
      { root: 'G:/proj/b', sessionIds: ['b-new', 'b-old'] },
      { root: 'G:/proj/a', sessionIds: ['a-new', 'a-old'] },
      { root: 'G:/proj/empty', sessionIds: [] },
    ]);
  });

  it('keeps folders saved in settings.folders even with no sessions', () => {
    expect(model().at(-1)).toEqual({ root: 'G:/proj/empty', sessionIds: [] });
  });
});

describe('nextSessionTarget (Ctrl+Arrow)', () => {
  it('steps down through sessions across folder boundaries', () => {
    expect(nextSessionTarget(model(), 'b-old', true)).toEqual({ sessionId: 'a-new', root: 'G:/proj/a' });
  });

  it('steps up, crossing back into the previous folder', () => {
    expect(nextSessionTarget(model(), 'a-new', false)).toEqual({ sessionId: 'b-old', root: 'G:/proj/b' });
  });

  it('wraps from the last session to the first', () => {
    expect(nextSessionTarget(model(), 'a-old', true)).toEqual({ sessionId: 'b-new', root: 'G:/proj/b' });
    expect(nextSessionTarget(model(), 'b-new', false)).toEqual({ sessionId: 'a-old', root: 'G:/proj/a' });
  });

  it('falls back to the first/last session when nothing is active', () => {
    expect(nextSessionTarget(model(), null, true)).toEqual({ sessionId: 'b-new', root: 'G:/proj/b' });
    expect(nextSessionTarget(model(), null, false)).toEqual({ sessionId: 'a-old', root: 'G:/proj/a' });
  });
});

describe('nextFolderTarget (Ctrl+Shift+Arrow)', () => {
  it('jumps to the first session of the folder below', () => {
    expect(nextFolderTarget(model(), 'b-old', true)).toEqual({ sessionId: 'a-new', root: 'G:/proj/a' });
  });

  it('jumps to the first session of the folder above', () => {
    expect(nextFolderTarget(model(), 'a-new', false)).toEqual({ sessionId: 'b-new', root: 'G:/proj/b' });
  });

  it('skips empty folders', () => {
    expect(nextFolderTarget(model(), 'a-old', true)).toEqual({ sessionId: 'b-new', root: 'G:/proj/b' });
  });

  it('wraps around the folder list', () => {
    expect(nextFolderTarget(model(), 'a-old', false)).toEqual({ sessionId: 'b-new', root: 'G:/proj/b' });
  });

  it('starts at the first folder when nothing is active', () => {
    expect(nextFolderTarget(model(), null, true)).toEqual({ sessionId: 'b-new', root: 'G:/proj/b' });
  });
});