/**
 * Settings → Pi UI. The behaviour that matters: the page renders what the backend discovered, a
 * toggle sends the exact resource pi needs, preference edits carry the selected value, and prompt
 * saves stay disabled until there is something to save.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PiSection } from '../src/renderer/src/components/PiSettings';
import type { PiSetup } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

function setup(over: Partial<PiSetup> = {}): PiSetup {
  return {
    agentDir: 'C:/pi/agent',
    settingsPath: 'C:/pi/agent/settings.json',
    preferences: {},
    resources: [
      { type: 'extensions', name: 'goal.ts', path: 'C:/pi/agent/extensions/goal.ts', enabled: true, forced: false },
      { type: 'skills', name: 'demo', description: 'Demo the thing', path: 'C:/pi/agent/skills/demo/SKILL.md', enabled: true, forced: false },
      { type: 'themes', name: 'custom', path: 'C:/pi/agent/themes/custom.json', enabled: true, forced: true }
    ],
    promptFiles: [
      { name: 'AGENTS.md', path: 'C:/pi/agent/AGENTS.md', exists: true, content: '# rules\n' },
      { name: 'APPEND_SYSTEM.md', path: 'C:/pi/agent/APPEND_SYSTEM.md', exists: false, content: '' },
      { name: 'SYSTEM.md', path: 'C:/pi/agent/SYSTEM.md', exists: false, content: '' }
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

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe('PiSection', () => {
  it('renders discovered resources with their type groups', async () => {
    mockBackend();
    render(<PiSection />);
    expect(await screen.findByText('goal.ts')).toBeTruthy();
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
    await screen.findByText('demo');
    const row = screen.getByText('demo').closest('.pi-resource')!;
    fireEvent.click(row.querySelector('input[type="checkbox"]')!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pi:resource', { type: 'skills', path: 'C:/pi/agent/skills/demo/SKILL.md', enabled: false }));
    await waitFor(() => expect(row.className).toContain('disabled'));
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
    const editor = (await screen.findByPlaceholderText('AGENTS.md is not set')) as HTMLTextAreaElement;
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
