/**
 * @vitest-environment jsdom
 *
 * Offline tests for the project definition manager: the list, the template shelf, editing and saving,
 * and the track/untrack affordance. Everything goes through the stubbed bridge, so this is the view's
 * own behavior rather than a harness round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { SubagentAgents } from '../src/renderer/src/components/SubagentAgents';
import type { SessionMeta } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ canInvoke: () => true, invoke, on: vi.fn(() => () => undefined), isMac: false, modKey: 'Ctrl', platform: 'win32', isWeb: false, webShim: vi.fn() }));

const session = (): SessionMeta =>
  ({
    id: 's1',
    title: 'Session',
    cwd: 'G:/repo',
    config: { projectRoot: 'G:/repo', harness: 'pi', permissionMode: 'ask' },
    status: 'idle',
    harnessRef: {},
    usage: { costUsd: 0 },
  }) as unknown as SessionMeta;

const projectAgent = (overrides: Record<string, unknown> = {}) => ({
  name: 'reviewer',
  description: 'Reviews a diff against the repo rules',
  tools: ['read', 'grep'],
  promptMode: 'replace' as const,
  mcp: false,
  path: 'G:/repo/.pi/agents/reviewer.md',
  tracked: false,
  ignored: true,
  ...overrides,
});

const template = {
  name: 'Explore',
  description: 'Fast read-only search agent',
  tools: ['read', 'grep', 'find', 'ls', 'bash'],
  promptMode: 'replace' as const,
  mcp: false,
  prompt: 'You search the codebase.',
  source: 'G:/resources/pi/agents/Explore.md',
};

async function renderView(): Promise<void> {
  await act(async () => {
    render(<SubagentAgents session={session()} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  invoke.mockReset();
});
afterEach(cleanup);

describe('the project set', () => {
  it('lists project definitions as tiles and offers the templates', async () => {
    invoke.mockResolvedValue({ agents: [projectAgent()], templates: [template], git: true, ignored: true });
    await renderView();
    const tile = document.querySelector('[data-testid="agent-reviewer"]')!;
    expect(tile.textContent).toContain('reviewer');
    expect(tile.textContent).toContain('Reviews a diff against the repo rules');
    expect(tile.textContent).toContain('local');
    expect(document.querySelector('[data-testid="agent-templates"]')!.textContent).toContain('Explore');
    // The guidance explains where the files live and how sharing works.
    expect(document.querySelector('.agent-guidance')!.textContent).toContain('.pi/agents');
  });

  it('says so when the project has no definitions of its own', async () => {
    invoke.mockResolvedValue({ agents: [], templates: [template], git: true, ignored: false });
    await renderView();
    expect(document.body.textContent).toContain('No project definitions yet');
  });
});

describe('editing', () => {
  it('copies a template into a new project definition and saves it', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'agents:list') return Promise.resolve({ agents: [], templates: [template], git: true, ignored: false });
      if (channel === 'agents:save') return Promise.resolve({ ok: true, path: 'G:/repo/.pi/agents/Explore.md' });
      return Promise.resolve(null);
    });
    await renderView();
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="agent-templates"] button')!);
    });
    // The template's prompt is carried over, editable, and the name starts empty on purpose.
    const editor = document.querySelector('.agent-editor')!;
    expect((editor.querySelector('textarea') as HTMLTextAreaElement).value).toBe('You search the codebase.');
    const name = editor.querySelector('input') as HTMLInputElement;
    expect(name.value).toBe('');
    await act(async () => {
      fireEvent.change(name, { target: { value: 'searcher' } });
      fireEvent.change(editor.querySelectorAll('input')[1] as HTMLInputElement, { target: { value: 'Searches the repo' } });
    });
    const save = [...editor.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    await act(async () => {
      fireEvent.click(save);
    });
    expect(invoke).toHaveBeenCalledWith('agents:save', {
      id: 's1',
      fields: { name: 'searcher', description: 'Searches the repo', tools: template.tools, promptMode: 'replace', mcp: false },
      prompt: 'You search the codebase.',
    });
  });

  it('opens an existing definition with its file contents and can delete it', async () => {
    const deleted: unknown[] = [];
    invoke.mockImplementation((channel: string, request: unknown) => {
      if (channel === 'agents:list') return Promise.resolve({ agents: [projectAgent()], templates: [], git: true, ignored: true });
      if (channel === 'agents:get') return Promise.resolve({ fields: { ...projectAgent(), model: 'anthropic/claude-opus-4-5' }, prompt: 'You review diffs.' });
      if (channel === 'agents:delete') {
        deleted.push(request);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });
    await renderView();
    await act(async () => {
      fireEvent.click(document.querySelector('.agent-tile-main')!);
    });
    const editor = document.querySelector('.agent-editor')!;
    expect((editor.querySelector('textarea') as HTMLTextAreaElement).value).toBe('You review diffs.');
    const name = editor.querySelector('input') as HTMLInputElement;
    expect(name.value).toBe('reviewer');
    expect(name.disabled).toBe(true); // the file name is the key: rename by creating a new one
    const del = [...editor.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!;
    await act(async () => {
      fireEvent.click(del);
    });
    expect(deleted).toEqual([{ id: 's1', name: 'reviewer' }]);
  });
});

describe('sharing', () => {
  it('tracks and untracks one definition through IPC', async () => {
    const calls: unknown[] = [];
    invoke.mockImplementation((channel: string, request: unknown) => {
      if (channel === 'agents:list') return Promise.resolve({ agents: [projectAgent()], templates: [], git: true, ignored: true });
      if (channel === 'agents:track') {
        calls.push(request);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });
    await renderView();
    await act(async () => {
      fireEvent.click(document.querySelector('.agent-tile-track')!);
    });
    expect(calls).toEqual([{ id: 's1', name: 'reviewer', tracked: true }]);
  });

  it('hides the git affordance when the folder is not a repository', async () => {
    invoke.mockResolvedValue({ agents: [projectAgent()], templates: [], git: false, ignored: false });
    await renderView();
    expect(document.querySelector('.agent-tile-track')).toBeNull();
  });
});
