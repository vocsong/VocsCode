/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InstructionsSection } from '../src/renderer/src/components/InstructionsSection';
import { APP_INSTRUCTION_MAX_CHARS, APP_INSTRUCTION_SCOPES } from '../src/shared/app-instructions';
import type { AppInstructionFile } from '../src/shared/types';

const { invoke, toast } = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke }));
vi.mock('../src/renderer/src/store', () => ({ useStore: (select: (state: { toast: typeof toast }) => unknown) => select({ toast }) }));

function files(): AppInstructionFile[] {
  return APP_INSTRUCTION_SCOPES.map((scope) => ({ scope, path: `C:/app/instructions/${scope}.md`, content: '', exists: false }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function selectScope(name: RegExp): void {
  fireEvent.click(within(screen.getByRole('group', { name: 'Instruction scope' })).getByRole('button', { name }));
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  toast.mockReset();
});

describe('InstructionsSection saves', () => {
  it('distinguishes native per-step reloads from other harness startup timing', async () => {
    invoke.mockResolvedValue(files());
    render(<InstructionsSection />);
    expect(screen.getByText('Most harnesses load instructions when starting. The native loop reloads them before each model step.')).toBeTruthy();
    fireEvent.click(screen.getByText('How instructions are applied'));
    expect(screen.getByText(/Pi and Claude Agent SDK take this in their system prompt at session start/)).toBeTruthy();
    expect(screen.getByText(/Codex, Cursor and ACP agents get it on the first message/)).toBeTruthy();
    expect(screen.getByText(/The native loop reloads this text before every model step, including in a running session/)).toBeTruthy();
    expect(screen.queryByText('Changes apply to your next session, not one already running.')).toBeNull();
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Instructions text' }) as HTMLTextAreaElement).disabled).toBe(false));
  });

  it('clears only the submitted draft on success and displays the saved response', async () => {
    const initial = files();
    const pending = deferred<AppInstructionFile[]>();
    invoke.mockImplementation((name: string) => name === 'instructions:write' ? pending.promise : Promise.resolve(initial));
    render(<InstructionsSection />);
    const editor = await screen.findByRole('textbox', { name: 'Instructions text' }) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.disabled).toBe(false));
    fireEvent.change(editor, { target: { value: 'Submitted guidance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(invoke.mock.calls).toEqual([['instructions:read', undefined], ['instructions:write', { scope: 'global', content: 'Submitted guidance' }]]);
    await act(async () => pending.resolve(initial.map((file) => file.scope === 'global' ? { ...file, exists: true, content: 'Submitted guidance' } : file)));
    expect(editor.value).toBe('Submitted guidance');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it.each(['success', 'failure'] as const)('keeps newer edits and other scopes after pending save %s', async (outcome) => {
    const initial = files();
    const pending = deferred<AppInstructionFile[]>();
    invoke.mockImplementation((name: string) => name === 'instructions:write' ? pending.promise : Promise.resolve(initial));
    render(<InstructionsSection />);
    const editor = await screen.findByRole('textbox', { name: 'Instructions text' }) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.disabled).toBe(false));
    fireEvent.change(editor, { target: { value: 'Submitted guidance' } });
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.click(save);
    expect(save.disabled).toBe(true);
    expect(invoke.mock.calls.filter(([name]) => name === 'instructions:write')).toEqual([['instructions:write', { scope: 'global', content: 'Submitted guidance' }]]);
    fireEvent.change(editor, { target: { value: 'Newer guidance' } });
    selectScope(/^Pi/);
    fireEvent.change(editor, { target: { value: 'Pi draft' } });
    await act(async () => {
      if (outcome === 'success') pending.resolve(initial.map((file) => file.scope === 'global' ? { ...file, exists: true, content: 'Submitted guidance' } : file));
      else pending.reject(new Error('Instructions write denied'));
    });
    expect(editor.value).toBe('Pi draft');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    selectScope(/^All harnesses/);
    expect(editor.value).toBe('Newer guidance');
    expect(screen.getByRole('status').textContent).toBe('Unsaved changes');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    if (outcome === 'failure') expect(toast).toHaveBeenCalledWith('Instructions write denied', 'error');
    else expect(toast).toHaveBeenCalledWith('Instructions saved', 'success');
  });

  it('uses the character budget, not byte-sized KB wording, for multibyte drafts', async () => {
    invoke.mockResolvedValue(files());
    render(<InstructionsSection />);
    const editor = await screen.findByRole('textbox', { name: 'Instructions text' }) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.disabled).toBe(false));
    fireEvent.change(editor, { target: { value: '界'.repeat(APP_INSTRUCTION_MAX_CHARS) } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(editor, { target: { value: '界'.repeat(APP_INSTRUCTION_MAX_CHARS + 1) } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(`Instructions are limited to ${APP_INSTRUCTION_MAX_CHARS.toLocaleString()} characters per file.`)).toBeTruthy();
    expect(screen.queryByText(/KB per file/)).toBeNull();
  });

  it('describes a truncated instruction file in characters', async () => {
    invoke.mockResolvedValue(files().map((file) => file.scope === 'global' ? { ...file, exists: true, truncated: true } : file));
    render(<InstructionsSection />);
    expect(await screen.findByText(`This file is larger than ${APP_INSTRUCTION_MAX_CHARS.toLocaleString()} characters; edit it in an external editor.`)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Instructions text' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
