/** Composer dictation: the mic records, main transcribes, and the transcript lands at the caret
 *  without being sent; the Composer options menu flips the saved engine and, when the local model is
 *  missing, takes the user to Settings → Voice. The microphone itself is stubbed (jsdom has none). */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const status = { supported: true, models: [] as string[], server: 'stopped', build: { id: 'win-x64-cpu', label: 'CPU', bytes: 1, installed: false } };
let transcribeFailure: string | null = null;
let transcribeGate: Promise<void> | null = null;
const invokeMock = vi.fn(async (channel: string, _req?: unknown): Promise<unknown> => {
  if (channel === 'dictation:transcribe') {
    if (transcribeGate) await transcribeGate;
    if (transcribeFailure) throw new Error(transcribeFailure);
    return { text: 'login bug', engine: 'cloud', ms: 12 };
  }
  if (channel === 'dictation:status') return status;
  if (channel === 'settings:update') return {};
  return { ok: true };
});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

const { recording, startRecording } = vi.hoisted(() => {
  const recording = { stop: vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([82, 73, 70, 70, 1, 2, 3])), cancel: vi.fn(), level: () => 0.5 };
  return { recording, startRecording: vi.fn(async () => recording) };
});
vi.mock('../src/renderer/src/dictation', async (original) => ({ ...(await original<typeof import('../src/renderer/src/dictation')>()), startRecording }));

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { DictationControl } from '../src/renderer/src/components/DictationControl';
import { MenuItem } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import { DEFAULT_DICTATION } from '../src/shared/dictation';
import type { AppSettings, SessionMeta } from '../src/shared/types';

const session = {
  id: 's1',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  cwd: '.',
  status: 'idle',
  harnessRef: {},
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
  config: { harness: 'claude', cwd: '.', projectRoot: '.', permissionMode: 'ask' }
} as unknown as SessionMeta;

const settings = (engine: 'cloud' | 'local') =>
  ({ providers: [{ id: 'openrouter', kind: 'openrouter', name: 'OpenRouter', hasApiKey: true, models: [], enabled: true }], dictation: { ...DEFAULT_DICTATION, engine } }) as unknown as AppSettings;

function mount(engine: 'cloud' | 'local' = 'cloud') {
  useStore.setState({ settings: settings(engine), toasts: [], view: 'chat', drafts: {} });
  const view = render(<Composer session={session} />);
  const ta = view.container.querySelector('textarea') as HTMLTextAreaElement;
  const mic = view.getByTestId('dictation-mic');
  return { ...view, ta, mic };
}

afterEach(cleanup);

beforeEach(() => {
  transcribeFailure = null;
  transcribeGate = null;
  startRecording.mockImplementation(async () => recording);
  recording.cancel.mockClear();
  invokeMock.mockClear();
  startRecording.mockClear();
  recording.stop.mockClear();
});

describe('composer dictation', () => {
  it('records, transcribes in main and puts the text at the caret without sending it', async () => {
    const { ta, mic, getByTestId } = mount();
    fireEvent.change(ta, { target: { value: 'fix the' } });
    ta.setSelectionRange(7, 7);

    fireEvent.click(mic);
    await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(getByTestId('dictation-clock').textContent).toBe('0:00');

    fireEvent.click(mic);
    await waitFor(() => expect(ta.value).toBe('fix the login bug'));
    expect(invokeMock).toHaveBeenCalledWith('dictation:transcribe', { audio: btoa('RIFF\x01\x02\x03') });
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:send', expect.anything());
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles from the keyboard with Ctrl+Shift+Space in the composer', async () => {
    const { ta, mic } = mount();
    fireEvent.keyDown(ta, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.keyDown(ta, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(ta.value).toBe('login bug'));
    expect(startRecording).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a silent clip and says why', async () => {
    recording.stop.mockResolvedValueOnce(null);
    const { mic } = mount();
    fireEvent.click(mic);
    await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(mic);
    await waitFor(() => expect(useStore.getState().toasts.map((t) => t.text)).toContain('Nothing was heard — check the microphone and speak a little longer.'));
    expect(invokeMock).not.toHaveBeenCalledWith('dictation:transcribe', expect.anything());
  });

  it('keeps the draft and shows the engine error when transcription fails', async () => {
    transcribeFailure = 'Add an API key for OpenRouter under Settings → Providers & keys to dictate with it, or switch dictation to Local.';
    const { ta, mic } = mount();
    fireEvent.change(ta, { target: { value: 'draft' } });
    fireEvent.click(mic);
    await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(mic);
    await waitFor(() => expect(useStore.getState().toasts.some((t) => t.kind === 'error' && t.text.startsWith('Add an API key for OpenRouter'))).toBe(true));
    expect(ta.value).toBe('draft');
  });

  it('closes the microphone when the composer goes away while it is still opening', async () => {
    let open: (r: typeof recording) => void = () => undefined;
    startRecording.mockImplementationOnce(() => new Promise((resolve) => (open = resolve)));
    const { mic, unmount } = mount();
    fireEvent.click(mic);
    await waitFor(() => expect(startRecording).toHaveBeenCalledTimes(1));
    unmount(); // switched sessions while the permission prompt was up
    await act(async () => open(recording));
    expect(recording.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps a transcript that arrives after switching sessions in that session's draft", async () => {
    let release: () => void = () => undefined;
    transcribeGate = new Promise((r) => (release = r));
    const { ta, mic, unmount } = mount();
    fireEvent.change(ta, { target: { value: 'fix the' } });
    fireEvent.click(mic);
    await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(mic);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('dictation:transcribe', expect.anything()));
    unmount();
    await act(async () => release());
    await waitFor(() => expect(useStore.getState().drafts['s1']).toBe('fix the login bug'));
  });

  it('flips the saved engine from the options menu, and opens Settings → Voice when the local model is missing', async () => {
    const { getByTestId, getByRole, queryByTestId } = mount('cloud');
    expect(queryByTestId('dictation-engine')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Composer options' }));
    const chip = getByTestId('dictation-engine');
    expect(chip.textContent).toBe('Voice: Cloud');
    expect(chip.getAttribute('role')).toBe('menuitem');
    expect(chip.getAttribute('data-engine')).toBe('cloud');
    expect(chip.getAttribute('title')).toContain('Dictating with OpenRouter (cloud)');

    await act(async () => {
      fireEvent.click(chip);
    });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { dictation: { ...DEFAULT_DICTATION, engine: 'local' } });
    await waitFor(() => expect(useStore.getState().view).toBe('settings'));
    expect(useStore.getState().toasts.map((t) => t.text)).toContain('Large v3 Turbo, quantized model is not downloaded yet. Opening Settings → Voice.');
  });

  it('switches back to cloud without asking anything of the local engine', async () => {
    const { getByTestId, getByRole, queryByRole } = mount('local');
    fireEvent.click(getByRole('button', { name: 'Composer options' }));
    const chip = getByTestId('dictation-engine');
    expect(chip.textContent).toBe('Voice: Local');
    expect(chip.getAttribute('data-engine')).toBe('local');
    await act(async () => {
      fireEvent.click(chip);
    });
    expect(invokeMock).toHaveBeenCalledWith('settings:update', { dictation: { ...DEFAULT_DICTATION, engine: 'cloud' } });
    expect(invokeMock).not.toHaveBeenCalledWith('dictation:status', undefined);
    expect(queryByRole('menu')).toBeNull();
  });

  it('exposes an accessible keyboard menu and restores focus on Escape', () => {
    const { getByRole } = mount();
    const options = getByRole('button', { name: 'Composer options' });
    expect(options.getAttribute('title')).toBe('Composer options');
    expect(options.getAttribute('aria-haspopup')).toBe('menu');
    expect(options.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(options);
    expect(options.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Voice: Cloud' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(options.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(options);
  });

  it('keeps the mic mounted and the menu open when its disabled engine is clicked, then discards without transcribing', async () => {
    const { mic, ta, getByRole, getByTestId, queryByRole } = mount();
    fireEvent.change(ta, { target: { value: 'keep this draft' } });
    fireEvent.click(mic);
    await waitFor(() => expect(mic.getAttribute('aria-pressed')).toBe('true'));
    expect(queryByRole('menuitem', { name: 'Discard recording' })).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Composer options' }));
    const engine = getByRole('menuitem', { name: 'Voice: Cloud' }) as HTMLButtonElement;
    expect(engine.disabled).toBe(true);
    // Browsers can bubble clicks from descendants of disabled buttons.
    fireEvent.click(engine.querySelector('span')!);
    expect(getByRole('menu')).toBeTruthy();
    expect(getByTestId('dictation-mic')).toBe(mic);
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(getByTestId('dictation-clock').textContent).toBe('0:00');
    expect(invokeMock).not.toHaveBeenCalledWith('settings:update', expect.anything());
    fireEvent.click(getByRole('menuitem', { name: 'Discard recording' }));
    expect(recording.cancel).toHaveBeenCalledTimes(1);
    expect(recording.stop).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('dictation:transcribe', expect.anything());
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    expect(ta.value).toBe('keep this draft');
    expect(queryByRole('menu')).toBeNull();
  });

  it('disables switching while opening the mic and while transcribing', async () => {
    let open: (r: typeof recording) => void = () => undefined;
    let release: () => void = () => undefined;
    startRecording.mockImplementationOnce(() => new Promise((resolve) => (open = resolve)));
    transcribeGate = new Promise((resolve) => (release = resolve));
    const { mic, getByRole } = mount();
    fireEvent.click(mic);
    fireEvent.click(getByRole('button', { name: 'Composer options' }));
    expect((getByRole('menuitem', { name: 'Voice: Cloud' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => open(recording));
    fireEvent.click(mic);
    expect((getByRole('menuitem', { name: 'Voice: Cloud' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    expect((getByRole('menuitem', { name: 'Voice: Cloud' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders injected composer actions after the voice items with keyboard navigation', () => {
    useStore.setState({ settings: settings('cloud') });
    const attach = vi.fn();
    const { getByRole, getAllByRole } = render(<DictationControl onText={() => undefined} menuItems={(close) => <MenuItem onClick={() => { close(); attach(); }}>Attach files</MenuItem>} />);
    fireEvent.click(getByRole('button', { name: 'Composer options' }));
    const items = getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Voice: Cloud', 'Attach files']);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(items[1]);
    expect(attach).toHaveBeenCalledTimes(1);
  });
});
