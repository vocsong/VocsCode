// Sidebar folder blocks: persistent manual positioning (drag the header to reorder the whole
// block) and persistent collapse/expand, both saved through `settings:update`.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

// Stub the preload bridge before any renderer module runs; settings:update writes the patch
// back into the store so post-drop/post-collapse assertions see the new state.
const invokeMock = vi.fn().mockImplementation((_channel: string, args?: { folderOrder?: string[]; collapsedFolders?: string[] }) => {
  const patch: Record<string, unknown> = {};
  if (args?.folderOrder) patch.folderOrder = args.folderOrder;
  if (args?.collapsedFolders) patch.collapsedFolders = args.collapsedFolders;
  if (Object.keys(patch).length > 0) {
    useStore.setState({ settings: { ...useStore.getState().settings, ...patch } });
  }
  return Promise.resolve({});
});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
};

import { fireEvent, render } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const baseSettings = {
  folders: [],
  folderStyles: {},
  folderOrder: [],
  collapsedFolders: [],
  sidebarWidth: 280,
  panelWidth: 420
} as unknown as AppSettings;

const session = (root: string, id: string): SessionMeta => ({
  id,
  title: `Session ${id}`,
  cwd: root,
  config: { projectRoot: root, harness: 'native' },
  status: 'idle',
  archived: false,
  pinned: false,
  updatedAt: 1000,
  usage: { costUsd: 0 }
} as unknown as SessionMeta);

/** Titles of the folder headers in the order they are rendered. */
const headerOrder = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.project-title')].map((el) => el.textContent);

describe('sidebar folder block positioning', () => {
  it('keeps a manual folderOrder instead of sorting by latest session', () => {
    useStore.setState({
      sessions: [session('G:/proj/a', 'a1'), session('G:/proj/b', 'b1')],
      settings: { ...baseSettings, folderOrder: ['G:/proj/b', 'G:/proj/a'] } as unknown as AppSettings,
      activeId: null,
      view: 'chat'
    });
    const { container } = render(<Sidebar />);
    expect(headerOrder(container)).toEqual(['b', 'a']);
  });

  it('sorts never-positioned folders alphabetically after positioned ones', () => {
    useStore.setState({
      sessions: [session('G:/proj/c', 'c1'), session('G:/proj/a', 'a1')],
      settings: { ...baseSettings, folderOrder: ['G:/proj/c'] } as unknown as AppSettings,
      activeId: null,
      view: 'chat'
    });
    const { container } = render(<Sidebar />);
    expect(headerOrder(container)).toEqual(['c', 'a']);
  });

  it('repositions a block on drag-and-drop and persists the new order', () => {
    useStore.setState({
      sessions: [session('G:/proj/a', 'a1'), session('G:/proj/b', 'b1')],
      settings: { ...baseSettings } as unknown as AppSettings,
      activeId: null,
      view: 'chat'
    });
    const { container } = render(<Sidebar />);
    expect(headerOrder(container)).toEqual(['a', 'b']);

    const [groupA, groupB] = [...container.querySelectorAll('.project-group')];
    const list = container.querySelector('.sidebar-list') as HTMLElement;
    const dataTransfer = { setData: vi.fn(), dropEffect: '' } as unknown as DataTransfer;

    // jsdom does not apply clientY to drag events, so a drop on a group always reads as
    // "before". Drag B onto A and drop above it: B lands first.
    fireEvent.dragStart(groupB.querySelector('.project-header') as HTMLElement, { dataTransfer });
    fireEvent.dragOver(groupA, { dataTransfer });
    expect(groupA.className).toContain('drop-before');
    fireEvent.drop(groupA, { dataTransfer });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', {
      folderOrder: ['G:/proj/b', 'G:/proj/a']
    });
    expect(headerOrder(container)).toEqual(['b', 'a']);

    // The empty space below the last group means "move to the end" (drop-after): B goes last.
    fireEvent.dragStart(groupB.querySelector('.project-header') as HTMLElement, { dataTransfer });
    fireEvent.dragOver(list, { dataTransfer });
    fireEvent.drop(list, { dataTransfer });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', {
      folderOrder: ['G:/proj/a', 'G:/proj/b']
    });
    expect(headerOrder(container)).toEqual(['a', 'b']);
  });
});

describe('sidebar folder collapse', () => {
  it('hides sessions, persists the collapsed root, and expands again', () => {
    useStore.setState({
      sessions: [session('G:/proj/a', 'a1'), session('G:/proj/a', 'a2')],
      settings: { ...baseSettings } as unknown as AppSettings,
      activeId: null,
      view: 'chat'
    });
    const { container } = render(<Sidebar />);
    expect(container.querySelectorAll('.session-row')).toHaveLength(2);

    const foldBtn = container.querySelector('.project-fold-btn') as HTMLButtonElement;
    fireEvent.click(foldBtn);
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { collapsedFolders: ['G:/proj/a'] });
    // Collapsed blocks keep the header and a session count, but no rows.
    expect(container.querySelector('.session-row')).toBeNull();
    expect(container.querySelector('.project-count')?.textContent).toBe('2');

    fireEvent.click(container.querySelector('.project-fold-btn') as HTMLButtonElement);
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { collapsedFolders: [] });
    expect(container.querySelectorAll('.session-row')).toHaveLength(2);
  });
});