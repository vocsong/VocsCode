/**
 * The New Session dialog remembers what it was last used with *for that project folder*: enabling
 * worktree isolation in one repository must not switch it on for the next folder, and the other
 * dialog fields (harness, model, permission mode, effort) are the folder's too. A folder with no
 * record yet starts on the app-wide defaults, which is where worktree isolation stays off. The
 * worktree's branch prefix is the folder's too, picked from the built-in prefixes and the user's
 * saved ones; a prefix typed as Custom… is saved for every project when its session starts.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: vi.fn(), isMac: false, isWeb: false, platform: 'win32', modKey: 'Ctrl', canInvoke: () => true }));

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
    if (channel === 'git:folderBranches') return { current: 'main', branches: ['develop', 'main'] };
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
      branchPrefix: 'vocscode',
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
      branchPrefix: 'vocscode',
      acpAgent: undefined
    });
  });

  it('resolves the folder\'s branch prefix only while it is still offered', () => {
    const settings = settingsWith({
      customBranchPrefixes: ['bug'],
      folderSessionDefaults: { 'G:/feat': { branchPrefix: 'feat' }, 'G:/bug': { branchPrefix: 'bug' }, 'G:/removed': { branchPrefix: 'gone' } }
    });
    expect(resolveNewSessionDefaults(settings, 'G:/feat').branchPrefix).toBe('feat');
    expect(resolveNewSessionDefaults(settings, 'G:/bug').branchPrefix).toBe('bug');
    // A custom prefix removed from Settings does not come back through a folder's record.
    expect(resolveNewSessionDefaults(settings, 'G:/removed').branchPrefix).toBe('vocscode');
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
      [ROOT]: { harness: 'pi', effort: undefined, permissionMode: 'ask', useWorktree: true, branchPrefix: 'vocscode', modelByHarness: { pi: { provider: 'z-ai', model: 'glm-5' } } }
    });
  });

  it('starts the worktree on the chosen built-in prefix and remembers it for the folder', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { useWorktree: true } } }));
    render(<NewSessionDialog />);

    const select = (await screen.findByLabelText('Branch prefix')) as HTMLSelectElement;
    expect(select.value).toBe('vocscode');
    expect([...select.options].map((o) => o.textContent)).toEqual(['vocscode/', 'feat/', 'fix/', 'chore/', 'Custom…']);
    fireEvent.change(select, { target: { value: 'feat' } });
    expect(document.querySelector('.ns-worktree-hint')!.textContent).toContain('Creates feat/<session-name> in .vocs-code/worktrees/<session-name>');
    await waitFor(() => expect((screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const [, req] = invoke.mock.calls.find(([channel]) => channel === 'sessions:create') as [string, { config: { useWorktree: boolean; branchPrefix?: string } }];
    expect(req.config).toMatchObject({ useWorktree: true, branchPrefix: 'feat' });
    const [, patch] = invoke.mock.calls.find(([channel]) => channel === 'settings:update') as [string, Partial<AppSettings>];
    expect(patch.folderSessionDefaults?.[ROOT]).toMatchObject({ useWorktree: true, branchPrefix: 'feat' });
    // A built-in prefix is never copied into the saved list.
    expect(patch).not.toHaveProperty('customBranchPrefixes');
  });

  it('remembers a picked prefix for the folder at once, before any session starts', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { useWorktree: true }, 'G:/other': { harness: 'native' } } }));
    render(<NewSessionDialog />);

    fireEvent.change(await screen.findByLabelText('Branch prefix'), { target: { value: 'chore' } });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:update', { folderSessionDefaults: { [ROOT]: { useWorktree: true, branchPrefix: 'chore' }, 'G:/other': { harness: 'native' } } }));
    expect(invoke).not.toHaveBeenCalledWith('sessions:create', expect.anything());
  });

  it('names the branch, picks its base and previews both before starting', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { useWorktree: true } } }));
    render(<NewSessionDialog />);

    // Unedited, the name follows the first prompt the way the main process derives it.
    fireEvent.change(screen.getByPlaceholderText('What should the agent do?'), { target: { value: 'Fix the login redirect' } });
    const name = (await screen.findByLabelText('Branch name')) as HTMLInputElement;
    expect(name.placeholder).toBe('fix-the-login-redirect');
    const from = screen.getByLabelText('Base branch') as HTMLSelectElement;
    await waitFor(() => expect(from.value).toBe('main'));
    expect([...from.options].map((o) => o.value)).toEqual(['develop', 'main']);

    fireEvent.change(name, { target: { value: 'Fix Login Redirect' } });
    fireEvent.change(from, { target: { value: 'develop' } });
    const hint = document.querySelector('.ns-worktree-hint')!.textContent;
    expect(hint).toContain('Creates vocscode/fix-login-redirect in .vocs-code/worktrees/fix-login-redirect');
    // The footer sums up what Start will create.
    await waitFor(() => expect(document.querySelector('.ns-summary')!.textContent).toBe('Pi · GLM 5 · vocscode/fix-login-redirect'));

    await waitFor(() => expect((screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.objectContaining({ worktreeName: 'Fix Login Redirect', worktreeBase: 'develop' })));
  });

  it('sends no name or base when both are left on their defaults', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { useWorktree: true } } }));
    render(<NewSessionDialog />);
    await waitFor(() => expect((screen.getByLabelText('Base branch') as HTMLSelectElement).value).toBe('main'));
    await waitFor(() => expect((screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const [, req] = invoke.mock.calls.find(([channel]) => channel === 'sessions:create') as [string, Record<string, unknown>];
    expect(req).not.toHaveProperty('worktreeName');
    expect(req).not.toHaveProperty('worktreeBase');
  });

  it('saves a typed custom prefix so every later dialog offers it', async () => {
    seedSettings(settingsWith({ customBranchPrefixes: ['ops'], folderSessionDefaults: { [ROOT]: { useWorktree: true } } }));
    const view = render(<NewSessionDialog />);

    fireEvent.change(await screen.findByLabelText('Branch prefix'), { target: { value: ':custom' } });
    fireEvent.change(screen.getByLabelText('Custom branch prefix'), { target: { value: 'bug/' } });
    await waitFor(() => expect((screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTitle('Start from the prompt area with Enter'));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:create', expect.anything()));
    const [, req] = invoke.mock.calls.find(([channel]) => channel === 'sessions:create') as [string, { config: { branchPrefix?: string } }];
    expect(req.config.branchPrefix).toBe('bug');
    const [, patch] = invoke.mock.calls.find(([channel]) => channel === 'settings:update') as [string, Partial<AppSettings>];
    expect(patch.customBranchPrefixes).toEqual(['bug', 'ops']);
    expect(patch.folderSessionDefaults?.[ROOT]).toMatchObject({ branchPrefix: 'bug' });

    // The next dialog, on the saved settings, lists the new prefix and opens on it.
    view.unmount();
    seedSettings(settingsWith({ customBranchPrefixes: patch.customBranchPrefixes, folderSessionDefaults: patch.folderSessionDefaults }));
    render(<NewSessionDialog />);
    const select = (await screen.findByLabelText('Branch prefix')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['vocscode/', 'feat/', 'fix/', 'chore/', 'bug/', 'ops/', 'Custom…']);
    expect(select.value).toBe('bug');
  });

  it('will not start on a custom prefix git cannot take', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { useWorktree: true } } }));
    render(<NewSessionDialog />);

    fireEvent.change(await screen.findByLabelText('Branch prefix'), { target: { value: ':custom' } });
    fireEvent.change(screen.getByLabelText('Custom branch prefix'), { target: { value: 'my feature' } });

    expect(screen.getByText(/Not a valid branch prefix/)).toBeTruthy();
    const start = screen.getByTitle('Start from the prompt area with Enter') as HTMLButtonElement;
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('harness:models', expect.anything()));
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(invoke).not.toHaveBeenCalledWith('sessions:create', expect.anything());
  });

  it('offers no prefix picker while the session is not isolated', async () => {
    render(<NewSessionDialog />);
    const toggle = screen.getByLabelText(/Isolate in a git worktree/) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(screen.queryByLabelText('Branch prefix')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Branch prefix')).toBeTruthy();
  });

  it('starts a quick session on the folder\'s remembered choices', async () => {
    seedSettings(settingsWith({ folderSessionDefaults: { [ROOT]: { harness: 'claude', permissionMode: 'plan', useWorktree: true, branchPrefix: 'chore', modelByHarness: { claude: { provider: 'anthropic', model: 'claude-opus-5' } } } } }));

    await useStore.getState().createQuickSession(ROOT, undefined);

    expect(invoke).toHaveBeenCalledWith('sessions:create', {
      config: {
        harness: 'claude',
        projectRoot: ROOT,
        model: { provider: 'anthropic', model: 'claude-opus-5' },
        effort: undefined,
        permissionMode: 'plan',
        useWorktree: true,
        branchPrefix: 'chore',
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
