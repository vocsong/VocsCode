/**
 * The New Session dialog remembers what it was last used with *for that project folder*: enabling
 * worktree isolation in one repository must not switch it on for the next folder, and the other
 * dialog fields (harness, model, permission mode, effort) are the folder's too. A folder with no
 * record yet starts on the app-wide defaults, which is where worktree isolation stays off.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: vi.fn(), isMac: false, isWeb: false, platform: 'win32', modKey: 'Ctrl' }));

import { resolveNewSessionDefaults } from '../src/shared/session-defaults';
import { NewSessionDialog } from '../src/renderer/src/components/NewSessionDialog';
import { setSessionEffort } from '../src/renderer/src/sessionActions';
import { useStore } from '../src/renderer/src/store';

const ROOT = 'G:/Vocs-Code';

const base = {
  defaultHarness: 'pi',
  defaultPermissionMode: 'ask',
  defaultEffort: undefined,
  defaultModelByHarness: {},
  folderSessionDefaults: {},
  favoriteModels: [],
  acpAgents: []
} as unknown as AppSettings;

function settingsWith(patch: Partial<AppSettings>): AppSettings {
  return { ...base, ...patch } as AppSettings;
}

function session(id: string, projectRoot: string): SessionMeta {
  return {
    id,
    title: id,
    createdAt: 1_000,
    updatedAt: 1_000,
    config: { harness: 'pi', projectRoot, permissionMode: 'ask' } as SessionMeta['config'],
    cwd: projectRoot,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  };
}

const createdSession = { id: 'new-session', title: 'New session', config: { harness: 'pi', projectRoot: ROOT, permissionMode: 'ask' } } as SessionMeta;

function harnessModels(): { models: { id: string; provider: string; displayName: string }[] } {
  return { models: [{ id: 'glm-5', provider: 'z-ai', displayName: 'GLM 5' }] };
}

function seedSettings(settings: AppSettings): void {
  useStore.setState({
    settings,
    sessions: [],
    activeId: null,
    availability: {},
    newSessionRoot: ROOT,
    openNewSession: vi.fn(),
    setActive: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn()
  } as never);
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'harness:models') return harnessModels();
    if (channel === 'sessions:create') return createdSession;
    if (channel === 'git:folderIsRepo') return { isRepo: true };
    return {};
  });
  seedSettings(settingsWith({}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('per-folder new-session defaults', () => {
  it('resolves every field from the folder first and the app-wide default second', () => {
    const settings = settingsWith({
      defaultHarness: 'claude',
      defaultPermissionMode: 'ask',
      defaultEffort: 'low',
      defaultModelByHarness: { claude: { provider: 'anthropic', model: 'claude-opus-5' } },
      folderSessionDefaults: { 'G:/isolated': { permissionMode: 'full-auto', useWorktree: true } }
    });

    // Only the two fields the folder recorded are taken from it; the rest stay app-wide.
    expect(resolveNewSessionDefaults(settings, 'G:/isolated')).toEqual({
      harness: 'claude',
      model: { provider: 'anthropic', model: 'claude-opus-5' },
      effort: 'low',
      permissionMode: 'full-auto',
      useWorktree: true,
      acpAgent: undefined
    });
    // A folder with no record at all gets the app-wide defaults, and worktree isolation is off:
    // there is deliberately no app-wide answer for it to inherit.
    expect(resolveNewSessionDefaults(settings, 'G:/fresh')).toEqual({
      harness: 'claude',
      model: { provider: 'anthropic', model: 'claude-opus-5' },
      effort: 'low',
      permissionMode: 'ask',
      useWorktree: false,
      acpAgent: undefined
    });
  });

  it('opens the dialog on the folder\'s remembered choices, not on another folder\'s', async () => {
    seedSettings(
      settingsWith({
        folderSessionDefaults: {
          [ROOT]: {
            harness: 'claude',
            permissionMode: 'full-auto',
            effort: 'xhigh',
            useWorktree: true,
            modelByHarness: { claude: { provider: 'anthropic', model: 'claude-opus-5' } }
          }
        }
      })
    );
    render(<NewSessionDialog />);

    expect(document.querySelector('.harness-card.active')?.textContent).toContain('Claude Agent SDK');
    const permission = screen.getByText('Permissions').closest('.field')!.querySelector('select')!;
    expect(permission.value).toBe('full-auto');
    expect(screen.getByText('Reasoning effort').closest('.field')!.querySelector('select')!.value).toBe('xhigh');

    const toggle = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(true);
  });

  it('saves the started selection under the folder and leaves every other folder\'s record alone', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { 'G:/other': { harness: 'native', useWorktree: false } } }));
    render(<NewSessionDialog />);

    const toggle = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const [, patch] = invoke.mock.calls.find(([channel]) => channel === 'settings:update') as [string, { folderSessionDefaults: Record<string, unknown> }];
    expect(patch.folderSessionDefaults).toEqual({
      'G:/other': { harness: 'native', useWorktree: false },
      [ROOT]: { harness: 'pi', effort: undefined, permissionMode: 'ask', useWorktree: true, modelByHarness: { pi: { provider: 'z-ai', model: 'glm-5' } } }
    });
  });

  it('starts a quick session on the folder\'s remembered choices', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { harness: 'claude', permissionMode: 'plan', useWorktree: true, modelByHarness: { claude: { provider: 'anthropic', model: 'claude-opus-5' } } } } }));

    await useStore.getState().createQuickSession(ROOT, undefined);

    expect(invoke).toHaveBeenCalledWith('sessions:create', {
      config: {
        harness: 'claude',
        projectRoot: ROOT,
        model: { provider: 'anthropic', model: 'claude-opus-5' },
        effort: undefined,
        permissionMode: 'plan',
        useWorktree: true,
        acpAgent: undefined
      },
      initialPrompt: undefined,
      initialImages: undefined
    });
  });

  it('records a live effort switch against the session\'s folder', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { harness: 'pi' }, 'G:/other': { harness: 'native' } } }));
    useStore.setState({ sessions: [session('s1', ROOT)] } as never);

    await setSessionEffort('s1', 'high', vi.fn());

    expect(invoke).toHaveBeenCalledWith('settings:update', {
      defaultEffort: 'high',
      folderSessionDefaults: { [ROOT]: { harness: 'pi', effort: 'high' }, 'G:/other': { harness: 'native' } }
    });
  });
});
