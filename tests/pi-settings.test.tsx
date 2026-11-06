/**
 * Settings → Pi UI. The behaviour that matters: the page renders what the backend discovered, a
 * toggle sends the exact resource pi needs, preference edits carry the selected value, and prompt
 * saves stay disabled until there is something to save.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PiSection } from '../src/renderer/src/components/PiSettings';
import type { PiSetup } from '../src/shared/types';

const { invoke, toast, setView } = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), setView: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ canInvoke: () => true, invoke, isMac: false, modKey: 'Ctrl' }));
vi.mock('../src/renderer/src/store', () => ({ useStore: (select: (state: { toast: typeof toast; setView: typeof setView }) => unknown) => select({ toast, setView }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const numericFields = [
  { category: 'Preferences', channel: 'pi:preferences', section: 'preferences', key: 'compactionReserveTokens', label: /Reserve tokens/, initial: 8192 },
  { category: 'Preferences', channel: 'pi:preferences', section: 'preferences', key: 'compactionKeepRecentTokens', label: /Keep recent tokens/, initial: 12000 },
  { category: 'Preferences', channel: 'pi:preferences', section: 'preferences', key: 'retryMaxRetries', label: /Max retries/, initial: 5 },
  { category: 'Preferences', channel: 'pi:preferences', section: 'preferences', key: 'retryBaseDelayMs', label: /Base delay/, initial: 3000 },
  { category: 'Subagents', channel: 'pi:subagents', section: 'subagents', key: 'maxSubagentDepth', label: /Max subagent depth/, initial: 3 },
  { category: 'Subagents', channel: 'pi:subagents', section: 'subagents', key: 'maxConcurrent', label: /Max concurrent agents/, initial: 8 },
  { category: 'Subagents', channel: 'pi:subagents', section: 'subagents', key: 'maxConcurrentForeground', label: /Max foreground agents/, initial: 2 },
  { category: 'Subagents', channel: 'pi:subagents', section: 'subagents', key: 'defaultMaxTurns', label: /Default max turns/, initial: 10 }
] as const;

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
  toast.mockReset();
  setView.mockReset();
});

describe('PiSection', () => {
  it('warns that the page edits the global pi configuration', async () => {
    mockBackend();
    render(<PiSection />);
    expect(await screen.findByText(/global pi settings/i)).toBeTruthy();
    expect(screen.getAllByText('C:/pi/agent').length).toBeGreaterThan(1);
    expect(screen.getByText(/Most changes apply when pi starts/)).toBeTruthy();
    await selectCategory('Subagents');
    expect(screen.getByText('Vocs Code reloads concurrency limits before each subagent spawn, including in running sessions.')).toBeTruthy();
    expect(screen.getByText('Background and per-session cap. Unset: 4 background, 8 per session.')).toBeTruthy();
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

  it('keeps prompt, package and numeric preference drafts mounted across categories', async () => {
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable demo (C:/pi/agent/skills/demo/SKILL.md)' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('pi:resource', { type: 'skills', path: 'C:/pi/agent/skills/demo/SKILL.md', enabled: false }));
    await waitFor(() => expect(row.className).toContain('disabled'));
  });

  it('lists package resources and toggles them through the package filter channel', async () => {
    mockBackend();
    render(<PiSection />);
    await selectCategory('Packages');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable src/index.ts (C:/pi/agent/git/github.com/tintinweb/pi-subagents/src/index.ts)' }));
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

  it.each(numericFields)('clears $key with null and keeps the default after remount', async ({ category, channel, section, key, label, initial }) => {
    let current = setup({ [section]: { [key]: initial } });
    const pending = deferred<PiSetup>();
    invoke.mockImplementation((name: string) => name === channel ? pending.promise : Promise.resolve(current));
    const view = render(<PiSection />);
    await selectCategory(category);
    const input = screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
    expect(input.value).toBe(String(initial));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(invoke.mock.calls.filter(([name]) => name === channel)).toEqual([[channel, { [key]: null }]]);
    await act(async () => {
      current = setup({ [section]: {} });
      pending.resolve(current);
    });
    expect(input.value).toBe('');
    view.unmount();
    render(<PiSection />);
    await selectCategory(category);
    expect((screen.getByRole('spinbutton', { name: label }) as HTMLInputElement).value).toBe('');
  });

  it.each(numericFields)('restores the persisted $key when deletion fails', async ({ category, channel, section, key, label, initial }) => {
    const current = setup({ [section]: { [key]: initial } });
    const pending = deferred<PiSetup>();
    invoke.mockImplementation((name: string) => name === channel ? pending.promise : Promise.resolve(current));
    render(<PiSection />);
    await selectCategory(category);
    const input = screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(invoke.mock.calls.filter(([name]) => name === channel)).toEqual([[channel, { [key]: null }]]);
    await act(async () => pending.reject(new Error('Write denied')));
    expect(toast).toHaveBeenCalledWith('Write denied', 'error');
    expect(input.value).toBe(String(initial));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(invoke.mock.calls.filter(([name]) => name === channel)).toHaveLength(2);
  });

  it.each(numericFields.filter(({ key }) => ['retryMaxRetries', 'maxSubagentDepth', 'maxConcurrentForeground', 'defaultMaxTurns'].includes(key)))('preserves zero for $key', async ({ category, channel, section, key, label, initial }) => {
    let current = setup({ [section]: { [key]: initial } });
    invoke.mockImplementation(async (name: string) => {
      if (name === channel) current = setup({ [section]: { [key]: 0 } });
      return current;
    });
    const view = render(<PiSection />);
    await selectCategory(category);
    const input = screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(invoke).toHaveBeenCalledWith(channel, { [key]: 0 });
    await waitFor(() => expect(input.value).toBe('0'));
    view.unmount();
    render(<PiSection />);
    await selectCategory(category);
    expect((screen.getByRole('spinbutton', { name: label }) as HTMLInputElement).value).toBe('0');
  });

  it.each(numericFields.filter(({ key }) => ['compactionReserveTokens', 'maxConcurrent'].includes(key)))('does not delete $key when invalid number text reports an empty value', async ({ category, channel, section, key, label, initial }) => {
    invoke.mockResolvedValue(setup({ [section]: { [key]: initial } }));
    render(<PiSection />);
    await selectCategory(category);
    const input = screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
    // Browsers expose incomplete numbers such as “1e” or “-” as empty plus badInput.
    fireEvent.change(input, { target: { value: '' } });
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.blur(input);
    expect(invoke.mock.calls).toEqual([['pi:setup', undefined]]);
    expect(input.value).toBe(String(initial));
    Reflect.deleteProperty(input, 'validity');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(channel, { [key]: null }));
  });

  it('refreshes numeric values without discarding a newer unsubmitted edit', async () => {
    let current = setup({ preferences: { compactionReserveTokens: 8192, retryMaxRetries: 3 } });
    const pending = deferred<PiSetup>();
    invoke.mockImplementation((name: string) => name === 'pi:preferences' ? pending.promise : Promise.resolve(current));
    render(<PiSection />);
    const reserve = await screen.findByRole('spinbutton', { name: /Reserve tokens/ }) as HTMLInputElement;
    fireEvent.change(reserve, { target: { value: '9000' } });
    fireEvent.blur(reserve);
    expect(invoke).toHaveBeenCalledWith('pi:preferences', { compactionReserveTokens: 9000 });
    fireEvent.change(reserve, { target: { value: '10000' } });
    await act(async () => {
      current = setup({ preferences: { compactionReserveTokens: 9000, retryMaxRetries: 0 } });
      pending.resolve(current);
    });
    expect(reserve.value).toBe('10000');
    expect((screen.getByRole('spinbutton', { name: /Max retries/ }) as HTMLInputElement).value).toBe('0');
  });

  it.each(['success', 'failure'] as const)('retains newer prompt drafts and other tabs on save %s', async (outcome) => {
    const initial = setup();
    const pending = deferred<PiSetup>();
    invoke.mockImplementation((name: string) => name === 'pi:prompt:write' ? pending.promise : Promise.resolve(initial));
    render(<PiSection />);
    await selectCategory('Prompts');
    const editor = screen.getByRole('textbox', { name: 'SYSTEM.md' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Submitted text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(invoke.mock.calls.filter(([name]) => name === 'pi:prompt:write')).toEqual([['pi:prompt:write', { name: 'SYSTEM.md', content: 'Submitted text' }]]);
    fireEvent.change(editor, { target: { value: 'Newer text' } });
    fireEvent.click(screen.getByRole('button', { name: 'AGENTS.md' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'AGENTS.md' }), { target: { value: 'Other draft' } });
    await selectCategory('Resources');
    await act(async () => {
      if (outcome === 'success') pending.resolve(setup({ promptFiles: initial.promptFiles.map((file) => file.name === 'SYSTEM.md' ? { ...file, content: 'Submitted text', exists: true } : file) }));
      else pending.reject(new Error('Prompt write denied'));
    });
    await selectCategory('Prompts');
    expect((screen.getByRole('textbox', { name: 'AGENTS.md' }) as HTMLTextAreaElement).value).toBe('Other draft');
    fireEvent.click(screen.getByRole('button', { name: /^SYSTEM\.md/ }));
    expect((screen.getByRole('textbox', { name: 'SYSTEM.md' }) as HTMLTextAreaElement).value).toBe('Newer text');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    if (outcome === 'failure') expect(toast).toHaveBeenCalledWith('Prompt write denied', 'error');
  });

  it('does not overwrite a saved prompt with an older refresh response', async () => {
    const initial = setup();
    const stale = deferred<PiSetup>();
    const saved = deferred<PiSetup>();
    let reads = 0;
    // Only the already-started refresh is stale; a reconciliation reads the committed save.
    invoke.mockImplementation((name: string) => name === 'pi:setup' ? (++reads === 1 ? Promise.resolve(initial) : reads === 2 ? stale.promise : saved.promise) : saved.promise);
    render(<PiSection />);
    await selectCategory('Prompts');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'SYSTEM.md' }), { target: { value: 'Saved prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => saved.resolve(setup({ promptFiles: initial.promptFiles.map((file) => file.name === 'SYSTEM.md' ? { ...file, content: 'Saved prompt', exists: true } : file) })));
    await selectCategory('Preferences');
    await act(async () => stale.resolve(initial));
    await selectCategory('Prompts');
    expect((screen.getByRole('textbox', { name: 'SYSTEM.md' }) as HTMLTextAreaElement).value).toBe('Saved prompt');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not overwrite later preferences with an older prompt-save response', async () => {
    const initial = setup();
    const savedPrompt = setup({ promptFiles: initial.promptFiles.map((file) => file.name === 'SYSTEM.md' ? { ...file, content: 'Saved prompt', exists: true } : file) });
    const older = deferred<PiSetup>();
    const newer = deferred<PiSetup>();
    invoke.mockImplementation((name: string) => name === 'pi:setup' ? Promise.resolve(initial) : name === 'pi:prompt:write' ? older.promise : newer.promise);
    render(<PiSection />);
    await selectCategory('Prompts');
    fireEvent.change(screen.getByRole('textbox', { name: 'SYSTEM.md' }), { target: { value: 'Saved prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await selectCategory('Preferences');
    const thinking = screen.getByRole('combobox', { name: /Startup thinking level/ }) as HTMLSelectElement;
    fireEvent.change(thinking, { target: { value: 'low' } });
    await act(async () => newer.resolve({ ...savedPrompt, preferences: { defaultThinkingLevel: 'low' } }));
    await act(async () => older.resolve(savedPrompt));
    expect(thinking.value).toBe('low');
    await selectCategory('Prompts');
    expect((screen.getByRole('textbox', { name: 'SYSTEM.md' }) as HTMLTextAreaElement).value).toBe('Saved prompt');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not roll back later subagent state when an older preference mutation resolves', async () => {
    const older = deferred<PiSetup>();
    const newer = deferred<PiSetup>();
    invoke.mockImplementation((name: string) => name === 'pi:setup' ? Promise.resolve(setup()) : name === 'pi:preferences' ? older.promise : newer.promise);
    render(<PiSection />);
    const thinking = await screen.findByRole('combobox', { name: /Startup thinking level/ }) as HTMLSelectElement;
    fireEvent.change(thinking, { target: { value: 'low' } });
    await selectCategory('Subagents');
    const showCost = screen.getByRole('checkbox', { name: 'Show estimated cost next to subagent token counts' }) as HTMLInputElement;
    fireEvent.click(showCost);
    await act(async () => newer.resolve(setup({ preferences: { defaultThinkingLevel: 'low' }, subagents: { showCost: true } })));
    expect(showCost.checked).toBe(true);
    await act(async () => older.resolve(setup({ preferences: { defaultThinkingLevel: 'low' } })));
    expect(showCost.checked).toBe(true);
    await selectCategory('Preferences');
    expect(thinking.value).toBe('low');
  });

  it('does not let an older read or its failure replace a later refresh', async () => {
    const oldest = deferred<PiSetup>();
    const older = deferred<PiSetup>();
    const newest = deferred<PiSetup>();
    invoke.mockResolvedValueOnce(setup()).mockReturnValueOnce(oldest.promise).mockReturnValueOnce(older.promise).mockReturnValueOnce(newest.promise);
    render(<PiSection />);
    const thinking = await screen.findByRole('combobox', { name: /Startup thinking level/ }) as HTMLSelectElement;
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => newest.resolve(setup({ preferences: { defaultThinkingLevel: 'high' } })));
    await act(async () => older.resolve(setup({ preferences: { defaultThinkingLevel: 'low' } })));
    await act(async () => oldest.reject(new Error('Stale read failed')));
    expect(thinking.value).toBe('high');
    expect(screen.queryByText('Stale read failed')).toBeNull();
  });

  it.each(['before', 'after'] as const)('ignores a concurrent refresh resolving %s its pending prompt mutation', async (order) => {
    const initial = setup();
    const mutation = deferred<PiSetup>();
    const refresh = deferred<PiSetup>();
    const saved = setup({ promptFiles: initial.promptFiles.map((file) => file.name === 'SYSTEM.md' ? { ...file, content: 'Persisted prompt', exists: true } : file) });
    invoke.mockResolvedValueOnce(initial).mockReturnValueOnce(mutation.promise).mockReturnValueOnce(refresh.promise).mockResolvedValue(saved);
    render(<PiSection />);
    await selectCategory('Prompts');
    const editor = screen.getByRole('textbox', { name: 'SYSTEM.md' }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'Persisted prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(invoke.mock.calls).toEqual([['pi:setup', undefined], ['pi:prompt:write', { name: 'SYSTEM.md', content: 'Persisted prompt' }], ['pi:setup', undefined]]);
    fireEvent.change(editor, { target: { value: 'Newer draft' } });
    if (order === 'before') await act(async () => refresh.resolve(initial));
    await act(async () => mutation.resolve(saved));
    if (order === 'after') await act(async () => refresh.resolve(initial));
    expect(editor.value).toBe('Newer draft');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(editor.value).toBe('Persisted prompt');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['before', 'after'] as const)('keeps a successful mutation resolving %s a later request fails', async (order) => {
    const older = deferred<PiSetup>();
    const newer = deferred<PiSetup>();
    invoke.mockResolvedValueOnce(setup()).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<PiSection />);
    const thinking = await screen.findByRole('combobox', { name: /Startup thinking level/ }) as HTMLSelectElement;
    fireEvent.change(thinking, { target: { value: 'low' } });
    fireEvent.change(screen.getByRole('combobox', { name: /Transport/ }), { target: { value: 'sse' } });
    if (order === 'before') await act(async () => older.resolve(setup({ preferences: { defaultThinkingLevel: 'low' } })));
    await act(async () => newer.reject(new Error('Transport failed')));
    if (order === 'after') await act(async () => older.resolve(setup({ preferences: { defaultThinkingLevel: 'low' } })));
    expect(thinking.value).toBe('low');
    expect(toast).toHaveBeenCalledWith('Transport failed', 'error');
  });

  it('rechecks a package refresh that overlaps a pending preference response without repeating the command', async () => {
    const initial = setup();
    const older = deferred<PiSetup>();
    const command = deferred<{ ok: boolean; code: number; log: string }>();
    const current = setup({ preferences: { defaultThinkingLevel: 'low' }, packages: [] });
    invoke.mockResolvedValueOnce(initial).mockReturnValueOnce(older.promise).mockReturnValueOnce(command.promise).mockResolvedValue(current);
    render(<PiSection />);
    const thinking = await screen.findByRole('combobox', { name: /Startup thinking level/ }) as HTMLSelectElement;
    fireEvent.change(thinking, { target: { value: 'low' } });
    await selectCategory('Packages');
    fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
    await act(async () => command.resolve({ ok: true, code: 0, log: '' }));
    await act(async () => older.resolve(setup({ preferences: { defaultThinkingLevel: 'low' } })));
    expect(await screen.findByText('No packages installed.')).toBeTruthy();
    expect(invoke.mock.calls.filter(([name]) => name.startsWith('pi:package:'))).toEqual([['pi:package:update', {}]]);
    expect(thinking.value).toBe('low');
  });

  it.each(['before', 'after'] as const)('reconciles a package refresh started before a failing mutation when it resolves %s rejection', async (order) => {
    const refresh = deferred<PiSetup>();
    const mutation = deferred<PiSetup>();
    const current = setup({ packages: [] });
    let reads = 0;
    invoke.mockImplementation((name: string) => {
      if (name === 'pi:setup') return ++reads === 1 ? Promise.resolve(setup()) : reads === 2 ? refresh.promise : Promise.resolve(current);
      if (name === 'pi:preferences') return mutation.promise;
      return Promise.resolve({ ok: true, code: 0, log: '' });
    });
    render(<PiSection />);
    await selectCategory('Packages');
    fireEvent.click(screen.getByRole('button', { name: 'Update all' }));
    await waitFor(() => expect(reads).toBe(2));
    await selectCategory('Preferences');
    fireEvent.change(screen.getByRole('combobox', { name: /Startup thinking level/ }), { target: { value: 'low' } });
    if (order === 'before') await act(async () => refresh.resolve(current));
    await act(async () => mutation.reject(new Error('Preference write failed')));
    if (order === 'after') await act(async () => refresh.resolve(current));
    await selectCategory('Packages');
    expect(await screen.findByText('No packages installed.')).toBeTruthy();
    expect(reads).toBe(3);
    expect(invoke.mock.calls.filter(([name]) => name.startsWith('pi:package:'))).toEqual([['pi:package:update', {}]]);
    expect(toast).toHaveBeenCalledWith('Preference write failed', 'error');
  });

  it('does not offer an editor action for external local package resources', async () => {
    const current = setup({ packages: [{ source: '../local-package', kind: 'local', path: 'C:/pi/local-package', installed: true, autoload: true, resources: [{ type: 'extensions', name: 'external.ts', path: 'C:/pi/local-package/external.ts', enabled: true, forced: false }] }] });
    invoke.mockResolvedValue(current);
    render(<PiSection />);
    await selectCategory('Packages');
    const row = screen.getByText('external.ts', { selector: 'strong' }).closest('.pi-resource')!;
    const open = within(row as HTMLElement).getByRole('button', { name: 'Open in editor' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(within(row as HTMLElement).getByText(/outside the pi agent directory/i)).toBeTruthy();
    fireEvent.click(open);
    expect(invoke.mock.calls).toEqual([['pi:setup', undefined]]);
  });

  it.each([
    { agentDir: 'C:/pi/agent', path: 'C:/pi/agent-other/extension.ts', inside: false },
    { agentDir: 'C:\\PI\\Agent\\', path: 'c:/pi/agent/extensions/demo.ts', inside: true },
    { agentDir: 'C:/pi/agent', path: 'C:\\pi\\agent\\extensions\\demo.ts', inside: true },
    { agentDir: '\\\\host\\share\\Agent', path: '//HOST/share/agent/extensions/demo.ts', inside: true },
    { agentDir: '/home/me/agent', path: '/home/me/agent-other/demo.ts', inside: false },
    { agentDir: '/home/me/agent', path: '/home/me/Agent/demo.ts', inside: false },
    { agentDir: 'C:/pi/agent', path: 'C:/pi/agent/../external/demo.ts', inside: false }
  ])('uses lexical directory boundaries for editor UX: $path', async ({ agentDir, path, inside }) => {
    const current = setup({ agentDir, resources: [{ type: 'extensions', name: 'demo.ts', path, enabled: true, forced: false }] });
    invoke.mockImplementation(async (name: string) => name === 'pi:setup' ? current : { ok: false, error: 'Main process path check refused' });
    render(<PiSection />);
    await selectCategory('Resources');
    const row = screen.getByText('demo.ts', { selector: 'strong' }).closest('.pi-resource')!;
    const open = within(row as HTMLElement).getByRole('button', { name: 'Open in editor' }) as HTMLButtonElement;
    expect(open.disabled).toBe(!inside);
    fireEvent.click(open);
    if (inside) {
      expect(invoke).toHaveBeenCalledWith('pi:openInEditor', { path });
      await waitFor(() => expect(toast).toHaveBeenCalledWith('Main process path check refused', 'error'));
    } else {
      expect(within(row as HTMLElement).getByText(/outside the pi agent directory/i)).toBeTruthy();
      expect(invoke.mock.calls).toEqual([['pi:setup', undefined]]);
    }
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
