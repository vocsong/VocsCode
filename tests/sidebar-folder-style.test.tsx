// Repro: clicking a folder's sidebar icon must open the style picker (stopPropagation on the
// trigger button used to swallow the click before the Dropdown wrapper could toggle it).
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

// Stub the preload bridge before any renderer module runs; settings:update writes back to the
// store so post-pick assertions see the new folderStyles.
const invokeMock = vi.fn().mockImplementation((_channel: string, args?: { folderStyles?: Record<string, { color?: string; icon?: string }>; collapsedFolders?: string[] }) => {
  if (args?.folderStyles) {
    useStore.setState({ settings: { ...settings, folderStyles: args.folderStyles } });
  }
  if (args?.collapsedFolders) {
    useStore.setState({ settings: { ...settings, collapsedFolders: args.collapsedFolders } });
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
import type { AppSettings } from '../src/shared/types';

const settings = {
  folders: ['G:/proj/a'],
  folderStyles: {},
  sidebarWidth: 280,
  panelWidth: 420
} as unknown as AppSettings;

describe('sidebar folder style picker', () => {
  it('opens on click and saves icon/color picks', () => {
    useStore.setState({ sessions: [], settings, activeId: null, view: 'chat' });
    const { container } = render(<Sidebar />);

    const iconBtn = container.querySelector('.project-icon-btn') as HTMLButtonElement;
    expect(iconBtn).toBeTruthy();
    // Regression: the click must reach the Dropdown wrapper and open the picker.
    fireEvent.click(iconBtn);
    expect(document.querySelector('.folder-style-picker')).toBeTruthy();

    const swatch = document.querySelector('.picker-swatch') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);
    expect(invokeMock).toHaveBeenCalledWith('settings:update', expect.objectContaining({
      folderStyles: { 'G:/proj/a': expect.objectContaining({ color: expect.any(String) }) }
    }));

    // The picker must expose the full 50-icon / 24-color palette.
    expect(document.querySelectorAll('.picker-opt')).toHaveLength(50);
    expect(document.querySelectorAll('.picker-swatch')).toHaveLength(24);

    // A colored folder name gets the visibility shadow class.
    fireEvent.click(document.querySelectorAll('.picker-swatch')[3]);
    expect(document.querySelector('.project-title.colored')).toBeTruthy();
  });
});

describe('sidebar folder collapse', () => {
  it('toggles collapse from the folder name, not just the chevron', () => {
    useStore.setState({ sessions: [], settings, activeId: null, view: 'chat' });
    const { container } = render(<Sidebar />);

    // Clicking the name persists the collapsed list and hides the (empty) group body.
    const title = container.querySelector('.project-title') as HTMLButtonElement;
    fireEvent.click(title);
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { collapsedFolders: ['G:/proj/a'] });

    // The mock writes the setting back, so the store now reports the folder collapsed.
    const store = useStore.getState();
    expect(store.settings?.collapsedFolders).toEqual(['G:/proj/a']);
  });
});