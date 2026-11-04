/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatImportCandidate } from '../src/shared/chat-import';
import type { AppSettings } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  invoke,
  invokeErrorMessage: (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*': Error: /, '') : String(error),
  isWeb: false,
  isMac: false,
  modKey: 'Ctrl',
  platform: 'linux',
  canInvoke: () => true
}));

import { ChatImport } from '../src/renderer/src/components/ChatImport';
import { OnboardingWizard } from '../src/renderer/src/components/OnboardingWizard';
import { SettingsView, openSettings } from '../src/renderer/src/components/SettingsView';
import { useStore } from '../src/renderer/src/store';

const candidate = (id: string, imported = false): ChatImportCandidate => ({
  id,
  source: 'claude',
  sourceSessionId: `source-${id}`,
  title: `Chat ${id}`,
  projectRoot: '/workspace/project',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
  messageCount: 2,
  imported
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => channel === 'providers:list' ? [] : {});
  useStore.setState({
    settings: { defaultHarness: 'claude' } as AppSettings,
    availability: {},
    availabilityError: null,
    refreshAvailability: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn()
  });
});
afterEach(cleanup);

describe('chat import UI', () => {
  it('reads history only after an explicit scan and imports only selected, unimported chats', async () => {
    let imported = false;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'sessions:importList') return { candidates: [candidate('one', imported), candidate('two'), candidate('old', true)], skipped: 1 };
      if (channel === 'sessions:import') { imported = true; return { imported: [{ id: 'local-one' }], skipped: 0 }; }
      return {};
    });
    render(<ChatImport />);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scan Claude Code' }));
    const one = await screen.findByRole('checkbox', { name: 'Import Chat one' });
    expect((screen.getByRole('checkbox', { name: 'Import Chat old' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Import selected' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(one);
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (1)' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:import', { source: 'claude', ids: ['one'] }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Import Chat one' }) as HTMLInputElement).disabled).toBe(true));
    expect(useStore.getState().toast).toHaveBeenCalledWith('1 chat imported', 'success');
    expect(screen.getByText('1 history file skipped.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Import Chat two' }) as HTMLInputElement).checked).toBe(false);
  });

  it('explains skipped histories with reason counts and reports directory failures separately', async () => {
    invoke.mockResolvedValueOnce({ candidates: [], skipped: 168, skippedReasons: { empty: 120, subagent: 30, missingProject: 10, invalidHistory: 3, unsupportedHistory: 1, tooLarge: 2, scanBudget: 1, unreadable: 1 }, scanErrors: 2 });
    render(<ChatImport />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan Claude Code' }));
    expect(await screen.findByText('168 history files skipped.')).toBeTruthy();
    const reasons = screen.getByRole('list', { name: 'Skipped chat reasons' });
    expect(reasons.querySelectorAll('li')).toHaveLength(8);
    for (const text of ['120 — Empty or no conversation text', '30 — Subagent history', '10 — Missing or invalid project directory metadata', '3 — Unrecognized or invalid history', '1 — Linked Codex history is not supported', '2 — File exceeds the size limit', '1 — File exceeds the remaining scan budget', '1 — History file could not be read']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText('2 history directories could not be scanned. Some chats may be missing.')).toBeTruthy();
    expect(screen.queryByText(/because they could not be imported/)).toBeNull();
  });

  it('refreshes the breakdown after importing and clears stale reasons when scanning another source', async () => {
    let imported = false;
    invoke.mockImplementation(async (channel: string, request?: { source: string }) => {
      if (channel === 'sessions:import') { imported = true; return { imported: [{ id: 'local-one' }], skipped: 0 }; }
      if (channel === 'sessions:importList' && request?.source === 'codex') return { candidates: [], skipped: 0, skippedReasons: {}, scanErrors: 0 };
      return imported
        ? { candidates: [candidate('one', true)], skipped: 1, skippedReasons: { unreadable: 1 }, scanErrors: 0 }
        : { candidates: [candidate('one')], skipped: 3, skippedReasons: { empty: 2, subagent: 1 }, scanErrors: 1 };
    });
    render(<ChatImport />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan Claude Code' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Import Chat one' }));
    expect(screen.getByText('2 — Empty or no conversation text')).toBeTruthy();
    expect(screen.getByText('1 history directory could not be scanned. Some chats may be missing.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (1)' }));
    expect(await screen.findByText('1 — History file could not be read')).toBeTruthy();
    expect(screen.queryByText('2 — Empty or no conversation text')).toBeNull();
    expect(screen.queryByText(/history directory could not be scanned/)).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Scan Codex' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Scan Codex' }));
    expect(screen.queryByRole('list', { name: 'Skipped chat reasons' })).toBeNull();
    await screen.findByText('No importable Codex chats found.');
    expect(screen.queryByText(/history file skipped/)).toBeNull();
  });

  it('resets selection when scanning a different source', async () => {
    invoke.mockImplementation(async (_channel: string, request: { source: string }) => ({ candidates: [{ ...candidate(request.source), source: request.source }], skipped: 0 }));
    render(<ChatImport />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan Claude Code' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Import Chat claude' }));
    fireEvent.click(screen.getByRole('button', { name: 'Scan Codex' }));
    await screen.findByRole('checkbox', { name: 'Import Chat codex' });
    expect(screen.queryByRole('checkbox', { name: 'Import Chat claude' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Import selected' }) as HTMLButtonElement).disabled).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('sessions:importList', { source: 'codex' });
  });

  it('shows scan errors and lets the user retry', async () => {
    invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'sessions:importList': Error: History unavailable"));
    render(<ChatImport />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan Codex' }));
    expect((await screen.findByRole('alert')).textContent).toBe('History unavailable');
    expect(screen.queryByText(/No importable/)).toBeNull();
    invoke.mockResolvedValueOnce({ candidates: [], skipped: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Scan Codex' }));
    expect(await screen.findByText('No importable Codex chats found.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains selection after an import failure and blocks duplicate submissions while importing', async () => {
    let rejectImport: (error: Error) => void = () => undefined;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'sessions:importList') return { candidates: [candidate('one'), candidate('old', true)], skipped: 0 };
      if (channel === 'sessions:import') return new Promise((_resolve, reject) => { rejectImport = reject; });
      return {};
    });
    render(<ChatImport />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan Claude Code' }));
    await screen.findByRole('checkbox', { name: 'Import Chat one' });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    const importButton = screen.getByRole('button', { name: 'Import selected (1)' }) as HTMLButtonElement;
    fireEvent.click(importButton);
    expect(importButton.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Scan Codex' }) as HTMLButtonElement).disabled).toBe(true);
    rejectImport(new Error('Disk full'));
    expect((await screen.findByRole('alert')).textContent).toBe('Disk full');
    expect((screen.getByRole('checkbox', { name: 'Import Chat one' }) as HTMLInputElement).checked).toBe(true);
    expect(importButton.disabled).toBe(false);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'sessions:import')).toHaveLength(1);
  });

  it('explains incomplete scans and imports at most 200 selected chats per batch', async () => {
    const candidates = Array.from({ length: 201 }, (_, index) => candidate(String(index)));
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'sessions:importList') return { candidates, skipped: 0, malformedLines: 3, truncated: true };
      if (channel === 'sessions:import') return { imported: [], skipped: 200 };
      return {};
    });
    render(<ChatImport />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan Claude Code' }));
    expect(await screen.findByText('3 malformed history entries were ignored.')).toBeTruthy();
    expect(screen.getByText(/Some chats may be missing from this list/)).toBeTruthy();
    expect(screen.getByText(/Import up to 200 chats at a time/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select first 200' }));
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeTruthy();
    const last = screen.getByRole('checkbox', { name: 'Import Chat 200' }) as HTMLInputElement;
    expect(last.disabled).toBe(true);
    expect(last.checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Chat 0' }));
    expect(last.disabled).toBe(false);
    fireEvent.click(last);
    fireEvent.click(screen.getByRole('button', { name: 'Import selected (200)' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:import', { source: 'claude', ids: Array.from({ length: 200 }, (_, index) => String(index + 1)) }));
  });

  it('offers import in Settings and directly from the first onboarding step without reading history', async () => {
    openSettings('import');
    const settings = render(<SettingsView />);
    expect(screen.getByRole('button', { name: 'Import chats' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Import chats' })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    settings.unmount();
    render(<OnboardingWizard />);
    fireEvent.click(screen.getByRole('button', { name: 'Import chats from Claude Code or Codex' }));
    expect(screen.getByText('step 4/4 — Import chats')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan Claude Code' })).toBeTruthy();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('providers:list', undefined));
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:importList')).toBe(false);
  });
});
