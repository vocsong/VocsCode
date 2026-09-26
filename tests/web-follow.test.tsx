/** @vitest-environment jsdom */
/** Follow my computer (src/web/shell/useFollow.ts): per-computer persistence, following the desktop
 *  focus push, never while a draft is typed, and the snackbar when following is off. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellClient, installHarness, loadWebModules, session, setTransport } from './support/web-shell';

let rtl: typeof import('@testing-library/react');
let WebApp: typeof import('../src/web/shell/WebApp').WebApp;
let useStore: typeof import('../src/renderer/src/store').useStore;
let followEnabled: typeof import('../src/web/shell/useFollow').followEnabled;
let RelayTransportClass: typeof import('../src/web/transport/relay-transport').RelayTransport;

beforeEach(async () => {
  installHarness();
  ({ rtl, WebApp, useStore } = await loadWebModules());
  ({ RelayTransport: RelayTransportClass } = await import('../src/web/transport/relay-transport'));
  ({ followEnabled } = await import('../src/web/shell/useFollow'));
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
});

afterEach(() => {
  rtl.cleanup();
  vi.unstubAllGlobals();
});

const pairing = { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase: 'http://localhost' };

async function mountFollowing() {
  const shells = createShellClient({ creds: pairing, sessions: [session('s1', 'First'), session('s2', 'Second')] });
  const transport = new RelayTransportClass(shells.client);
  setTransport(transport);
  rtl.render(<WebApp client={shells.client as never} transport={transport} account={{ status: 'anonymous' }} />);
  await rtl.waitFor(() => expect(rtl.screen.getByTestId('session-list')).toBeTruthy());
  // Let the boot settle so the focus snapshot is the one the default route opened.
  await rtl.waitFor(() => expect(useStore.getState().booted).toBe(true));
  return shells;
}

describe('follow my computer', () => {
  it('follows the desktop focus once enabled from the menu, and stores the choice per computer', async () => {
    const shells = await mountFollowing();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Menu' }));
    rtl.fireEvent.click(rtl.screen.getByLabelText('Follow my computer'));
    await rtl.waitFor(() => expect(followEnabled('h1')).toBe(true));
    expect(followEnabled('h2')).toBe(false);

    for (const listener of shells.pushes) listener('push:desktopFocus', { sessionId: 's2', at: 2, windowFocused: true });
    await rtl.waitFor(() => expect(rtl.screen.getAllByText('Second').length).toBeGreaterThan(0));
    expect(useStore.getState().desktopFocus?.sessionId).toBe('s2');
  });

  it('offers a snackbar instead of moving, and never follows over a typed draft', async () => {
    const shells = await mountFollowing();
    for (const listener of shells.pushes) listener('push:desktopFocus', { sessionId: 's2', at: 2, windowFocused: true });
    await rtl.screen.findByTestId('follow-snackbar');
    // Still on the first session: the snackbar is an offer, not a move.
    expect(rtl.screen.getAllByText('First').length).toBeGreaterThan(0);

    // Turn following on, but leave a half-typed message: the view must not move.
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Follow' }));
    await rtl.waitFor(() => expect(useStore.getState().activeId).toBe('s2'));
    useStore.getState().setDraft('s2', 'half-written');
    for (const listener of shells.pushes) listener('push:desktopFocus', { sessionId: 's1', at: 3, windowFocused: true });
    await rtl.waitFor(() => expect(useStore.getState().desktopFocus?.sessionId).toBe('s1'));
    expect(useStore.getState().activeId).toBe('s2');
  });
});
