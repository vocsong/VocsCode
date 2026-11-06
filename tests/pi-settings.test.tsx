/**
 * Settings → Pi UI. The behaviour that matters: the page renders what the backend discovered, a
 * toggle sends the exact resource pi needs, preference edits carry the selected value, and prompt
 * saves stay disabled until there is something to save.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PiSection } from '../src/renderer/src/components/PiSettings';
import type { PiSetup } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ canInvoke: () => true, invoke, isMac: false, modKey: 'Ctrl' }));

function setup(over: Partial<PiSetup> = {}): PiSetup {
  return {
    agentDir: 'C:/pi/agent',
    settingsPath: 'C:/pi/agent/settings.json',
    preferences: {},
    piAvailable: true,
    resources: [
      { type: 'extensions', name: 'goal.ts', path: 'C:/pi/agent/extensions/goal.ts', enabled: true, forced: false },
      { type: 'skills', name: 'demo', description: 'Demo the thing', path: 'C:/pi/agent/skills/demo/SKILL.md', enabled: true, forced: false },
      { type: 'themes', name: 'custom', path: 'C:/pi/agent/themes/custom.json', enabled: true, forced: true }
    ],
    packages: [
      {
        source: 'git:github.com/tintinweb/pi-subagents',
        kind: 'git',
        path: 'C:/pi/agent/git/github.com/tintinweb/pi-subagents',
        installed: true,
        autoload: true,
        resources: [{ type: 'extensions', name: 'src/index.ts', path: 'C:/pi/agent/git/github.com/tintinweb/pi-subagents/src/index.ts', enabled: true, forced: false }]
      }
    ],
    agents: [{ name: 'Explore', description: 'Read-only search', model: 'deepseek/deepseek-v4-pro', path: 'C:/pi/agent/agents/Explore.md' }],
    subagents: { reportUsage: true },
    promptFiles: [
      { name: 'SYSTEM.md', path: 'C:/pi/agent/SYSTEM.md', exists: false, content: '' },
      { name: 'APPEND_SYSTEM.md', path: 'C:/pi/agent/APPEND_SYSTEM.md', exists: false, content: '' },
      { name: 'AGENTS.md', path: 'C:/pi/agent/AGENTS.md', exists: true, content: '# rules\n' }
    ],
    ...over
  };
}

/** A stateful fake: toggles and saves return the next setup, like the real store does. */
function mockBackend(): PiSetup {
  let current = setup();
  invoke.mockImplementation(async (channel: string, req: Record<string, unknown>) => {
    if (channel === 'pi:setup') return current;
    if (channel === 'pi:resource') {
      current = setup({
        resources: current.resources.map((r) => (r.path === req.path ? { ...r, enabled: req.enabled as boolean, forced: true } : r))
      });
      return current;
    }
    if (channel === 'pi:package:resource') {
      current = setup({
        packages: current.packages.map((p) => (p.source === req.source ? { ...p, resources: p.resources.map((r) => (r.path === req.path ? { ...r, enabled: req.enabled as boolean, forced: true } : r)) } : p))
      });
      return current;
    }
    if (channel === 'pi:subagents') {
      current = setup({ subagents: { ...current.subagents, ...(req as Partial<PiSetup['subagents']>) } });
      return current;
    }
    if (channel === 'pi:preferences') {
      current = setup({ preferences: { ...current.preferences, ...(req as Partial<PiSetup['preferences']>) } });
      return current;
    }
    if (channel === 'pi:prompt:write') {
      current = setup({
        promptFiles: current.promptFiles.map((f) => (f.name === req.name ? { ...f, exists: true, content: req.content as string } : f))
      });
      return current;
    }
    return { ok: true };
  });
  return current;
}

async function selectCategory(name: string): Promise<void> {
  const categories = await screen.findByRole('group', { name: 'Pi settings categories' });
  fireEvent.click(within(categories).getByRole('button', { name }));
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe('PiSection', () => {
  it('warns that the page edits the global pi configuration', async () => {
    mockBackend();
    render(<PiSection />);
    expect(await screen.findByText(/global pi settings/i)).toBeTruthy();
    expect(screen.getAllByText('C:/pi/agent').length).toBeGreaterThan(1);
  });

  it('defaults to Preferences and exposes only the selected category', async () => {
    mockBackend();
    render(<PiSection />);
    const categories = await screen.findByRole('group', { name: 'Pi settings categories' });
    const buttons = within(categories).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Preferences', 'Prompts', 'Resources', 'Packages', 'Subagents']);
    expect(within(categories).getByRole('button', { name: 'Preferences', pressed: true })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Preferences', 'Compaction and retry']);
    expect(screen.queryByRole('textbox', { name: 'Package source' })).toBeNull();

    for (const button of buttons) {
      fireEvent.click(button);
      expect(within(categories).getAllByRole('button', { pressed: true })).toEqual([button]);
      const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
      expect(panel.hidden).toBe(false);
      for (const other of buttons.filter((candidate) => candidate !== button)) {
        expect(document.getElementById(other.getAttribute('aria-controls')!)!.hidden).toBe(true);
      }
      expect(screen.getByText(/global pi settings/i).closest('[hidden]')).toBeNull();
    }
  });

  it('keeps prompt, package and uncontrolled preference drafts mounted across categories', async () => {
    mockBackend();
    render(<PiSection />);
    const reserve = (await screen.findByRole('spinbutton', { name: /Reserve tokens/ })) as HTMLInputElement;
    fireEvent.change(reserve, { target: { value: '8192' } });

    await selectCategory('Prompts');
    const editor = screen.getByPlaceholderText('SYSTEM.md is not set') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '# Unsaved instructions\n' } });

    await selectCategory('Packages');
    expect(editor.isConnected).toBe(true);
    expect(editor.closest('[hidden]')).not.toBeNull();
    const source = screen.getByRole('textbox', { name: 'Package source' }) as HTMLInputElement;
    fireEvent.change(source, { target: { value: 'npm:demo-package' } });

    await selectCategory('Resources');
    await selectCategory('Subagents');
    expect(source.isConnected).toBe(true);
    expect(source.closest('[hidden]')).not.toBeNull();

    await selectCategory('Preferences');
    expect(screen.getByRole('spinbutton', { name: /Reserve tokens/ })).toBe(reserve);
    expect(reserve.value).toBe('8192');
    await selectCategory('Prompts');
    expect(screen.getByPlaceholderText('SYSTEM.md is not set')).toBe(editor);
    expect(editor.value).toBe('# Unsaved instructions\n');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    await selectCategory('Packages');
    expect(screen.getByRole('textbox', { name: 'Package source' })).toBe(source);
    expect(source.value).toBe('npm:demo-package');
    expect(invoke.mock.calls).toEqual([['pi:setup', undefined]]);
  });

  it('renders discovered resources with their type groups', async () => {
    mockBackend();
    render(<PiSection />);
    await selectCategory('Resources');
    expect(screen.getByText('goal.ts')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.getByText('Demo the thing')).toBeTruthy();
    expect(screen.getByText('Extensions')).toBeTruthy();
    expect(screen.getByText('Themes')).toBeTruthy();
    // A forced resource advertises why it is on.
    expect(screen.getByText('pinned')).toBeTruthy();
  });

  it('sends a resource toggle with the exact path pi needs', async () => {
    mockBackend();
    render(<PiSection />);
    await selectCategory('Resources');
    const row = screen.getByText('demo').closest('.pi-resource')!;
    fireEvent.click(row.querySelector('input[type="checkbox"]')!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pi:resource', { type: 'skills', path: 'C:/pi/agent/skills/demo/SKILL.md', enabled: false }));
    await waitFor(() => expect(row.className).toContain('disabled'));
  });

  it('lists package resources and toggles them through the package filter channel', async () => {
    mockBackend();
    render(<PiSection />);
    await selectCategory('Packages');
    const row = screen.getByText('src/index.ts', { selector: 'strong' }).closest('.pi-resource')!;
    fireEvent.click(row.querySelector('input[type="checkbox"]')!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('pi:package:resource', {
        source: 'git:github.com/tintinweb/pi-subagents',
        type: 'extensions',
        path: 'C:/pi/agent/git/github.com/tintinweb/pi-subagents/src/index.ts',
        enabled: false
      })
    );
  });

  it('writes subagent settings and lists on-disk agents', async () => {
    mockBackend();
    render(<PiSection />);
    await selectCategory('Subagents');
    expect(screen.getByText('Read-only search')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show estimated cost next to subagent token counts'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pi:subagents', { showCost: true }));
  });

  it('saves a selected preference value', async () => {
    mockBackend();
    render(<PiSection />);
    const select = await screen.findByRole('combobox', { name: /Startup thinking level/ });
    fireEvent.change(select, { target: { value: 'low' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pi:preferences', { defaultThinkingLevel: 'low' }));
  });

  it('keeps Save disabled until a prompt file is edited, then writes it', async () => {
    mockBackend();
    render(<PiSection />);
    await selectCategory('Prompts');
    expect(screen.getByPlaceholderText('SYSTEM.md is not set')).toBeTruthy();
    // Prompt file buttons follow the System, Append, Agent sequence.
    const promptFiles = screen.getByRole('group', { name: 'System prompt files' });
    const tabNames = within(promptFiles).getAllByRole('button').map((el) => (el.firstChild?.textContent ?? '').trim());
    expect(tabNames).toEqual(['SYSTEM.md', 'APPEND_SYSTEM.md', 'AGENTS.md']);

    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }));
    const editor = screen.getByPlaceholderText('AGENTS.md is not set') as HTMLTextAreaElement;
    expect(editor.value).toBe('# rules\n');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(editor, { target: { value: '# rules\nBe brief.\n' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pi:prompt:write', { name: 'AGENTS.md', content: '# rules\nBe brief.\n' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
  });
});
