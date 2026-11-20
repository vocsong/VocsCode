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
  folders: ['G:/proj/empty'],
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

describe('Recent view nav model', () => {
  const recent = { ...settings, sidebarView: 'recent' } as AppSettings;
  // Interleaved recency across two folders: the user's own last message decides, pins still lead.
  const mixed = [
    session('G:/proj/a', 'a1', { updatedAt: 100, lastUserMessageAt: 400 }),
    session('G:/proj/b', 'b1', { updatedAt: 100, lastUserMessageAt: 300 }),
    session('G:/proj/b', 'b2', { updatedAt: 9_000, lastUserMessageAt: 200 }),
    session('G:/proj/a', 'a2', { updatedAt: 100, lastUserMessageAt: 100 }),
    session('G:/proj/a', 'a-pin', { updatedAt: 50, pinned: true, pinnedAt: 10 }),
    session('G:/proj/b', 'b-archived', { updatedAt: 9_999, lastUserMessageAt: 9_999, archived: true }),
  ];
  const recentModel = () => sidebarNavModel(mixed, recent);

  it('lists every folder in one recency order, split into runs of the same folder', () => {
    expect(recentModel()).toEqual([
      { root: 'G:/proj/a', sessionIds: ['a-pin', 'a1'] },
      { root: 'G:/proj/b', sessionIds: ['b1', 'b2'] },
      { root: 'G:/proj/a', sessionIds: ['a2'] },
    ]);
  });

  it('walks rows in that order with Ctrl+Arrow, ignoring folderOrder', () => {
    expect(nextSessionTarget(recentModel(), 'a1', true)).toEqual({ sessionId: 'b1', root: 'G:/proj/b' });
    expect(nextSessionTarget(recentModel(), 'b2', true)).toEqual({ sessionId: 'a2', root: 'G:/proj/a' });
  });

  it('jumps to the next row from a different folder with Ctrl+Shift+Arrow', () => {
    expect(nextFolderTarget(recentModel(), 'a-pin', true)).toEqual({ sessionId: 'b1', root: 'G:/proj/b' });
    expect(nextFolderTarget(recentModel(), 'b2', true)).toEqual({ sessionId: 'a2', root: 'G:/proj/a' });
  });
});