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
  rtl.render(<WebApp client={shells.client as never} transport={transport} account={{ status: 'anonymous' }} />);
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

  it('offers a session that needs a person as a strip that opens it, and drops the strip once opened', async () => {
    await mountHome();
    const nudge = await rtl.screen.findByTestId('approval-nudge');
    expect(nudge.textContent).toContain('Waiting one');
    expect(nudge.textContent).toContain('needs you');
    rtl.fireEvent.click(rtl.within(nudge).getByText('Review'));
    await rtl.waitFor(() => expect(window.location.hash).toContain('s2'));
    await rtl.waitFor(() => expect(rtl.screen.queryByTestId('approval-nudge')).toBeNull());
  });

  it('shows what the empty pane is for until a session is picked', async () => {
    window.history.replaceState(null, '', '/'); // no session route left over from another test
    await mountHome();
    // The shell first opens the session the desktop is on; back on the list, the pane is empty.
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Back to sessions' }));
    const placeholder = await rtl.screen.findByTestId('session-placeholder');
    expect(placeholder.textContent).toContain('Pick a session');
    expect(rtl.within(placeholder).getByRole('button', { name: 'New session' })).toBeTruthy();
  });

  it('continues the desktop session and filters the rest', async () => {
    await mountHome();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Continue' }));
    await rtl.waitFor(() => expect(rtl.screen.getAllByText('Desktop session').length).toBeGreaterThan(1));

    rtl.fireEvent.change(rtl.screen.getByLabelText('Filter sessions'), { target: { value: 'other' } });
    // The list filters; the approval nudge above it may still name the waiting session.
    const list = () => rtl.within(rtl.screen.getByTestId('session-list'));
    await rtl.waitFor(() => expect(list().queryByText('Waiting one')).toBeNull());
    expect(list().getByText('Other folder one')).toBeTruthy();
    rtl.fireEvent.change(rtl.screen.getByLabelText('Filter sessions'), { target: { value: 'nothing-matches' } });
    await rtl.waitFor(() => expect(rtl.screen.getByText('No sessions match.')).toBeTruthy());
  });
});
