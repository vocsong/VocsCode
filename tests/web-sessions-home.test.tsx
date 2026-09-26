/** @vitest-environment jsdom */
/** Sessions home (src/web/screens/SessionList.tsx): the sections, the Continue card for the
 *  desktop's session, the filter and the collapsed archive. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShellClient, installHarness, loadWebModules, session, setTransport } from './support/web-shell';
import type { RelayTransport } from '../src/web/transport/relay-transport';

let rtl: typeof import('@testing-library/react');
let WebApp: typeof import('../src/web/shell/WebApp').WebApp;
let useStore: typeof import('../src/renderer/src/store').useStore;
let RelayTransportClass: typeof import('../src/web/transport/relay-transport').RelayTransport;

beforeEach(async () => {
  installHarness();
  ({ rtl, WebApp, useStore } = await loadWebModules());
  ({ RelayTransport: RelayTransportClass } = await import('../src/web/transport/relay-transport'));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
});

afterEach(() => {
  rtl.cleanup();
  vi.unstubAllGlobals();
});

const pairing = { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase: 'http://localhost' };

async function mountHome() {
  const shells = createShellClient({
    creds: pairing,
    sessions: [
      session('s1', 'Desktop session'),
      session('s2', 'Waiting one', { status: 'awaiting', statusDetail: 'Run a command' }),
      session('s3', 'Busy one', { status: 'running' }),
      session('s4', 'Other folder one', { config: { harness: 'claude', permissionMode: 'ask', projectRoot: '/other' } }),
      session('s5', 'Archived one', { archived: true })
    ]
  });
  const transport = new RelayTransportClass(shells.client);
  setTransport(transport);
  rtl.render(<WebApp client={shells.client as never} transport={transport} />);
  await rtl.waitFor(() => expect(rtl.screen.getByTestId('on-your-computer')).toBeTruthy());
  return shells;
}

describe('sessions home', () => {
  it('shows the sections: the desktop session, what needs a person and what runs, then folders', async () => {
    await mountHome();
    expect(rtl.screen.getByTestId('on-your-computer').textContent).toContain('Desktop session');
    expect(rtl.screen.getByTestId('needs-you').textContent).toContain('Waiting one');
    expect(rtl.screen.getByTestId('needs-you').textContent).toContain('Run a command');
    expect(rtl.screen.getByTestId('running').textContent).toContain('Busy one');
    // The rest sit under their folder, and the archived row stays behind the collapsed summary.
    expect(rtl.screen.getByText('other')).toBeTruthy();
    expect(rtl.screen.getByText('Other folder one')).toBeTruthy();
    const archived = rtl.screen.getByText('Archived (1)');
    expect(archived).toBeTruthy();
  });

  it('continues the desktop session and filters the rest', async () => {
    await mountHome();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Continue' }));
    await rtl.waitFor(() => expect(rtl.screen.getAllByText('Desktop session').length).toBeGreaterThan(1));

    rtl.fireEvent.change(rtl.screen.getByLabelText('Filter sessions'), { target: { value: 'other' } });
    await rtl.waitFor(() => expect(rtl.screen.queryByText('Waiting one')).toBeNull());
    expect(rtl.screen.getByText('Other folder one')).toBeTruthy();
    rtl.fireEvent.change(rtl.screen.getByLabelText('Filter sessions'), { target: { value: 'nothing-matches' } });
    await rtl.waitFor(() => expect(rtl.screen.getByText('No sessions match.')).toBeTruthy());
  });
});
