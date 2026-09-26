/** @vitest-environment jsdom */
/** The session control sheets (src/web/sheets/SessionControlSheets.tsx): model, effort and
 *  permission changes write through the same channels as the desktop header, escalation is
 *  confirmed, and usage shows the session's own numbers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHarness, loadWebModules, session, setTransport } from './support/web-shell';
import type { ModelInfo } from '../src/shared/types';

let rtl: typeof import('@testing-library/react');
let useStore: typeof import('../src/renderer/src/store').useStore;
let SessionControls: typeof import('../src/web/sheets/SessionControlSheets').SessionControls;
let ConfirmHost: typeof import('../src/renderer/src/components/ui').ConfirmHost;
let invoke: ReturnType<typeof vi.fn>;

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', provider: 'anthropic', displayName: 'Claude Sonnet 5', contextWindow: 200_000 },
  { id: 'claude-opus-5', provider: 'anthropic', displayName: 'Claude Opus 5', contextWindow: 200_000 }
];

beforeEach(async () => {
  installHarness();
  ({ rtl, useStore } = await loadWebModules());
  ({ SessionControls } = await import('../src/web/sheets/SessionControlSheets'));
  ({ ConfirmHost } = await import('../src/renderer/src/components/ui'));
  invoke = vi.fn(async () => undefined);
  // The chips read channel capability through the bound transport; a permissive gate plus the
  // recording invoke is all this suite needs.
  setTransport({ invoke, on: () => () => undefined, can: () => true });
  useStore.setState({ modelCatalog: { claude: { models: MODELS, loading: false } } });
});

afterEach(() => {
  rtl.cleanup();
});

function renderControls(patch: Parameters<typeof session>[2] = {}) {
  const target = session('s1', 'Test session', patch);
  return rtl.render(
    <>
      <SessionControls session={target} />
      <ConfirmHost />
    </>
  );
}

describe('session control sheets', () => {
  it('switches the model through sessions:setModel', async () => {
    renderControls();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /default model/ }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /claude-opus-5/ }));
    await rtl.waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:setModel', { id: 's1', model: { provider: 'anthropic', model: 'claude-opus-5' } }));
  });

  it('changes effort and remembers the choice', async () => {
    renderControls();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'effort' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'high' }));
    await rtl.waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:setEffort', { id: 's1', effort: 'high' }));
    expect(invoke).toHaveBeenCalledWith('settings:update', expect.objectContaining({ defaultEffort: 'high' }));
  });

  it('confirms an escalation, but not a safer mode', async () => {
    renderControls();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Ask' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /Plan/ }));
    await rtl.waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:setPermissionMode', { id: 's1', mode: 'plan' }));
    expect(rtl.screen.queryByRole('dialog')).toBeNull();

    invoke.mockClear();
    // The session object is not re-fetched in this harness, so the chip still shows the old mode.
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Ask' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /Full access/ }));
    // The escalation dialog appears; nothing is written until it is confirmed.
    const confirm = await rtl.screen.findByRole('button', { name: 'Switch' });
    expect(invoke).not.toHaveBeenCalledWith('sessions:setPermissionMode', expect.anything());
    rtl.fireEvent.click(confirm);
    await rtl.waitFor(() => expect(invoke).toHaveBeenCalledWith('sessions:setPermissionMode', { id: 's1', mode: 'full-auto' }));
  });

  it('shows the session usage', async () => {
    renderControls({ usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.42, turns: 3 } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: '$0.42' }));
    await rtl.screen.findByText('Input');
    expect(rtl.screen.getByText('Turns')).toBeTruthy();
    expect(rtl.screen.getByText('3')).toBeTruthy();
    expect(rtl.screen.getByText('Cost')).toBeTruthy();
  });
});
