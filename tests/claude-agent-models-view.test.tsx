/**
 * @vitest-environment jsdom
 *
 * Offline tests for the Claude agent-model rows: what the panel offers, what a change sends, and the
 * one thing it must not do — pin a model on a built-in, which would need a definition file and would
 * take that built-in's instructions with it. So a row without a project definition has no control,
 * and the warning about a project's own pins is shown when they exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ClaudeAgentModels } from '../src/renderer/src/components/ClaudeAgentModels';
import { SubagentsTab } from '../src/renderer/src/components/SubagentsTab';
import { useStore } from '../src/renderer/src/store';
import type { ClaudeAgentTypesInfo } from '../src/shared/ipc';
import type { ModelInfo, SessionMeta } from '../src/shared/types';

const { invoke, on } = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on, isMac: false, modKey: 'Ctrl', platform: 'win32', isWeb: false, webShim: vi.fn() }));

const session = (harness: SessionMeta['config']['harness'] = 'claude'): SessionMeta =>
  ({
    id: 's1',
    title: 'Session',
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness, permissionMode: 'ask', model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    status: 'idle',
    harnessRef: {},
    usage: { costUsd: 0 }
  }) as unknown as SessionMeta;

const models = (): ModelInfo[] => [
  { id: 'deepseek-v4.1-flash', provider: 'opencode-go', displayName: 'DeepSeek V4.1 Flash', contextWindow: 200_000, supportsImages: false, supportsReasoning: true },
  { id: 'deepseek-v4.1', provider: 'opencode-go', displayName: 'DeepSeek V4.1', contextWindow: 200_000, supportsImages: false, supportsReasoning: true },
  { id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Sonnet 5', contextWindow: 200_000, supportsImages: true, supportsReasoning: true }
];

const info = (overrides: Partial<ClaudeAgentTypesInfo> = {}): ClaudeAgentTypesInfo => ({
  types: [
    { name: 'Explore', description: 'Searches the repo', model: 'inherit' },
    { name: 'Plan', description: 'Plans a change', model: 'inherit' }
  ],
  files: [{ name: 'Explore', description: 'Searches the repo', model: 'deepseek-v4.1', path: 'G:/repo/.claude/agents/Explore.md' }],
  sessionModel: 'deepseek-v4.1-flash',
  forced: false,
  ...overrides
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  invoke.mockReset();
  on.mockClear();
  useStore.setState({ settings: null, models: { s1: models() }, modelCatalog: {}, subagentReveal: null, panelBottomTab: 'subagents' } as never);
});
afterEach(cleanup);

describe('Claude agent model rows', () => {
  it('offers a control only where the project has a definition, and shows the pin it carries', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();

    expect(invoke).toHaveBeenCalledWith('claude-agents:list', { id: 's1' });
    const explore = document.querySelector('[data-testid="claude-agent-model-Explore"]') as HTMLSelectElement;
    expect(explore.value).toBe('deepseek-v4.1');
    expect(explore.textContent).toContain('Same as session');

    // Plan is a built-in with no definition: it runs on the session model and has nothing to edit.
    const plan = document.querySelector('[data-testid="claude-agent-Plan"]')!;
    expect(plan.querySelector('select')).toBeNull();
    expect(plan.textContent).toContain('Runs on the session model');
    expect(document.querySelector('[data-testid="claude-agent-models"]')).toBeNull();
  });

  it('saves a pin and a cleared pin as the definition’s model', async () => {
    invoke.mockImplementation((channel: string) => (channel === 'claude-agents:list' ? Promise.resolve(info()) : Promise.resolve({ ok: true })));
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="claude-agent-model-Explore"]')!, { target: { value: 'deepseek-v4.1-flash' } });
    });
    expect(invoke).toHaveBeenCalledWith('claude-agents:setModel', { id: 's1', name: 'Explore', model: 'deepseek-v4.1-flash' });

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="claude-agent-model-Explore"]')!, { target: { value: '' } });
    });
    expect(invoke).toHaveBeenCalledWith('claude-agents:setModel', { id: 's1', name: 'Explore', model: null });
  });

  it('keeps a pin the catalog no longer lists, so saving cannot drop it by accident', async () => {
    invoke.mockResolvedValue(
      info({
        types: [{ name: 'Explore', description: 'Searches the repo', model: 'inherit' }],
        files: [{ name: 'Explore', description: 'Searches the repo', model: 'retired-model-9', path: 'G:/repo/.claude/agents/Explore.md' }],
        forced: true
      })
    );
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    const explore = document.querySelector('[data-testid="claude-agent-model-Explore"]') as HTMLSelectElement;
    expect(explore.value).toBe('retired-model-9');
    expect([...explore.options].map((o) => o.value)).toEqual(['', 'deepseek-v4.1-flash', 'deepseek-v4.1', 'retired-model-9']);
  });

  it('warns that a project pin releases Claude Code from the session model', async () => {
    invoke.mockResolvedValue(info({ forced: false }));
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    expect(document.querySelector('.callout')!.textContent).toContain('no longer held to the session model');

    cleanup();
    invoke.mockResolvedValue(info({ forced: true, types: [], files: [] }));
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    expect(document.querySelector('.callout')).toBeNull();
    expect(document.body.textContent).toContain('This project defines no Claude agents');
  });
});

describe('creating a definition from the panel', () => {
  it('writes a new definition and reloads the list', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'claude-agents:list' ? Promise.resolve(info({ types: [], files: [] })) : Promise.resolve({ ok: true, path: 'G:/repo/.claude/agents/reviewer.md' })
    );
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    expect(document.body.textContent).toContain('This project defines no Claude agents');

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="claude-agent-new"]')!);
    });
    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="claude-agent-new-name"]')!, { target: { value: ' reviewer ' } });
      fireEvent.change(document.querySelector('[data-testid="claude-agent-new-description"]')!, { target: { value: 'Reviews a diff' } });
      fireEvent.change(document.querySelector('[data-testid="claude-agent-new-prompt"]')!, { target: { value: 'You review diffs.' } });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="claude-agent-new-save"]')!);
    });
    await settle();

    expect(invoke).toHaveBeenCalledWith('claude-agents:create', { id: 's1', name: 'reviewer', description: 'Reviews a diff', prompt: 'You review diffs.', model: null });
    // The editor closes and the list is read back, so the file on disk is the panel's source of truth.
    expect(document.querySelector('[data-testid="claude-agent-new-name"]')).toBeNull();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'claude-agents:list').length).toBe(2);
  });

  it('will not offer to write a name a built-in or an existing definition owns', async () => {
    invoke.mockResolvedValue(
      info({
        types: [{ name: 'Explore', description: 'Searches the repo', model: 'inherit' }],
        files: [{ name: 'reviewer', description: 'Reviews a diff', path: 'G:/repo/.claude/agents/reviewer.md' }]
      })
    );
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();
    const open = async () => {
      await act(async () => {
        fireEvent.click(document.querySelector('[data-testid="claude-agent-new"]')!);
      });
    };
    const rename = async (value: string) => {
      await act(async () => {
        fireEvent.change(document.querySelector('[data-testid="claude-agent-new-name"]')!, { target: { value } });
        fireEvent.change(document.querySelector('[data-testid="claude-agent-new-description"]')!, { target: { value: 'Something new' } });
      });
    };
    const saveButton = () => document.querySelector('[data-testid="claude-agent-new-save"]') as HTMLButtonElement;

    // `Explore` is a built-in the engine lists: a definition would replace it, not extend it.
    await open();
    await rename('Explore');
    expect(document.querySelector('[data-testid="claude-agent-new-builtin"]')!.textContent).toContain('replaces it');
    expect(saveButton().disabled).toBe(true);

    // A name the project already defines is an overwrite, not a creation.
    await rename('reviewer');
    expect(document.querySelector('[data-testid="claude-agent-new-taken"]')!.textContent).toContain('already defines reviewer');
    expect(saveButton().disabled).toBe(true);

    // A genuinely new name is the one thing this form exists for, and it saves.
    await rename('doc-writer');
    expect(document.querySelector('[data-testid="claude-agent-new-builtin"]')).toBeNull();
    expect(document.querySelector('[data-testid="claude-agent-new-taken"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});

describe('overriding a built-in from its row', () => {
  it('opens the editor from a built-in row and writes the file that replaces it, pinning the chosen model', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'claude-agents:list' ? Promise.resolve(info({ files: [] })) : Promise.resolve({ ok: true, path: 'G:/repo/.claude/agents/Explore.md' })
    );
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();

    // The built-in has no definition behind it, so its row is the control that writes one.
    const tile = document.querySelector('[data-testid="claude-agent-Explore"]') as HTMLButtonElement;
    expect(tile.tagName).toBe('BUTTON');
    expect(tile.textContent).toContain('override it to pin a model');

    await act(async () => {
      fireEvent.click(tile);
    });
    // The name is the built-in's and cannot change; the engine's description seeds the form, and the
    // warning says what the write costs before the user commits to it.
    const name = document.querySelector('[data-testid="claude-agent-new-name"]') as HTMLInputElement;
    expect(name.value).toBe('Explore');
    expect(name.disabled).toBe(true);
    expect(document.querySelector('[data-testid="claude-agent-override-warning"]')!.textContent).toContain('replaces it');
    expect((document.querySelector('[data-testid="claude-agent-new-description"]') as HTMLInputElement).value).toBe('Searches the repo');

    await act(async () => {
      fireEvent.change(document.querySelector('[data-testid="claude-agent-new-prompt"]')!, { target: { value: 'You search the repo.' } });
      fireEvent.change(document.querySelector('[data-testid="claude-agent-new-model"]')!, { target: { value: 'deepseek-v4.1-flash' } });
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="claude-agent-new-save"]')!);
    });
    await settle();

    expect(invoke).toHaveBeenCalledWith('claude-agents:create', {
      id: 's1',
      name: 'Explore',
      description: 'Searches the repo',
      prompt: 'You search the repo.',
      model: 'deepseek-v4.1-flash',
      override: true
    });
    // The editor closes and the list is read back, so the file that now replaces the built-in is the
    // panel's source of truth.
    expect(document.querySelector('[data-testid="claude-agent-new-name"]')).toBeNull();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'claude-agents:list').length).toBe(2);
  });

  it('leaves a built-in the project already defines as an edit of its model, not an override', async () => {
    invoke.mockResolvedValue(info());
    await act(async () => {
      render(<ClaudeAgentModels session={session()} />);
    });
    await settle();

    // `Explore` has a file, so its row is the project's definition and carries the model select.
    const explore = document.querySelector('[data-testid="claude-agent-Explore"]')!;
    expect(explore.tagName).toBe('DIV');
    expect(explore.querySelector('[data-testid="claude-agent-model-Explore"]')).not.toBeNull();
    expect(explore.textContent).toContain('project');

    await act(async () => {
      fireEvent.click(explore);
    });
    expect(document.querySelector('[data-testid="claude-agent-new-name"]')).toBeNull();
  });
});

describe('the panel’s views', () => {
  it('offers Models to Claude and Agents to pi, and neither to a harness with no such files', async () => {
    invoke.mockImplementation((channel: string) => (channel === 'subagents:list' ? Promise.resolve([]) : Promise.resolve(null)));

    await act(async () => {
      render(<SubagentsTab session={session('claude')} />);
    });
    await settle();
    expect(document.querySelector('[data-testid="subagent-view-models"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="subagent-view-agents"]')).toBeNull();

    cleanup();
    await act(async () => {
      render(<SubagentsTab session={session('pi')} />);
    });
    await settle();
    expect(document.querySelector('[data-testid="subagent-view-agents"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="subagent-view-models"]')).toBeNull();
  });
});
