/** @vitest-environment jsdom */
/** The web shell in jsdom, over the real store, capabilities and Transcript: pairing screens and
 *  their call order, the vault refusal, sign-out visibility, text-only host names, and the
 *  offline / mirror / view-only states. The protocol itself is covered by web-client.test.ts; the
 *  real browser covers the rest (tests/e2e.remote-web.test.ts).
 *
 *  Modules are re-imported per test (including testing-library, so React is not duplicated): the
 *  shared store installs its push subscriptions once per page, and a shell test must not inherit
 *  another test's transport. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// api.ts reads window.harness when it loads, so it must exist before any import below evaluates;
// the delegating stub lets each test install its own RelayTransport afterwards.
const { holder } = vi.hoisted(() => {
  const holder = { transport: null as null | { invoke: (c: never, r: never) => Promise<unknown>; on: (c: never, l: never) => () => void; can: (c: never) => boolean } };
  (globalThis as unknown as { window: { harness: unknown } }).window.harness = {
    platform: 'browser',
    invoke: (channel: never, request: never) => holder.transport!.invoke(channel, request),
    on: (channel: never, listener: never) => holder.transport!.on(channel, listener),
    can: (channel: never) => holder.transport!.can(channel)
  };
  return { holder };
});

import { RelayClient, type OwnerHost } from '../relay/src/web-client';
import type { AccountState } from '../src/web/shell/account';
import { RelayTransport } from '../src/web/transport/relay-transport';
import type { MirrorIndex } from '../src/shared/mirror';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const session: SessionMeta = {
  id: 's1', title: 'Remote work', createdAt: 1, updatedAt: 1, cwd: '/repo', status: 'idle', harnessRef: {},
  config: { harness: 'claude', permissionMode: 'ask', projectRoot: '/repo' },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
};

function file(name: string, content: string, type = 'text/plain'): File {
  const value = new File([content], name, { type });
  // jsdom File has no arrayBuffer; real browsers provide it.
  value.arrayBuffer = async () => new TextEncoder().encode(content).buffer;
  return value;
}

let rtl: typeof import('@testing-library/react');
let WebApp: typeof import('../src/web/shell/WebApp').WebApp;
let useStore: typeof import('../src/renderer/src/store').useStore;
let configureStore: typeof import('../src/renderer/src/store').configureStore;

interface Pairing {
  hostDeviceId: string;
  hostName: string;
  webDeviceId: string;
  relayBase: string;
}

/** A RelayClient-shaped double: scripted pairing and owner calls, store answers, push injection. */
function shell(initial: Partial<{ creds: Pairing | null; connected: boolean; connectFails: boolean; mirror: boolean; index: MirrorIndex | null; hosts: OwnerHost[]; sessions: SessionMeta[]; items: TranscriptItem[]; sendFails: boolean }> = {}) {
  const listeners = new Set<() => void>();
  const pushes = new Set<(channel: string, payload: unknown) => void>();
  const calls: string[] = [];
  const invokes: Array<[string, unknown]> = [];
  const state = {
    creds: initial.creds ?? null,
    connected: initial.connected ?? true,
    connectFails: initial.connectFails ?? false,
    mirror: initial.mirror ?? false,
    index: initial.index ?? null,
    hosts: initial.hosts ?? [],
    sessions: initial.sessions ?? [],
    items: initial.items ?? [],
    sendFails: initial.sendFails ?? false
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const client = {
    hasCredentials: () => !!state.creds,
    credentials: () => state.creds,
    pairings: () => (state.creds ? [state.creds] : []),
    onPairingsChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onPush: (listener: (channel: string, payload: unknown) => void) => {
      pushes.add(listener);
      return () => pushes.delete(listener);
    },
    isConnected: () => state.connected && !state.connectFails,
    hasMirror: () => state.mirror,
    async connect() {
      calls.push('connect');
      if (state.connectFails) throw new Error('relay unreachable');
      state.connected = true;
    },
    async restore() {
      calls.push('restore');
    },
    async pair({ relayBase, code }: { relayBase: string; code: string }) {
      calls.push(`pair:${code}`);
      state.creds = { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase };
      notify();
      return state.creds;
    },
    async pairWithHost({ relayBase, hostDeviceId }: { relayBase: string; hostDeviceId: string }) {
      calls.push(`pairWithHost:${hostDeviceId}`);
      state.creds = { hostDeviceId, hostName: 'Lab PC', webDeviceId: 'w2', relayBase };
      notify();
      return state.creds;
    },
    async addComputer() {
      calls.push('addComputer');
    },
    async addedComputer() {
      calls.push('addedComputer');
      return { status: 'redeemed', hostDeviceId: 'h2' };
    },
    async ownerHosts() {
      calls.push('ownerHosts');
      return state.hosts;
    },
    async select(hostDeviceId: string) {
      calls.push(`select:${hostDeviceId}`);
      state.creds = { ...state.creds!, hostDeviceId };
      notify();
    },
    async unpair() {
      calls.push('unpair');
      state.creds = null;
      notify();
    },
    async listDevices() {
      return [];
    },
    async revokeDevice() {
      calls.push('revokeDevice');
    },
    async mirrorIndex() {
      return state.index;
    },
    async mirrorSession() {
      return state.mirror ? { id: 's1', title: 'Mirrored', status: 'idle', harness: 'claude', updatedAt: 1, items: state.items } : null;
    },
    async invoke(channel: string, request: unknown) {
      invokes.push([channel, request]);
      if (channel === 'sessions:send' && state.sendFails) throw new Error('Computer refused the send');
      if (channel === 'settings:get') return { remote: { viewOnly: false }, folders: ['/repo'], recentProjects: ['/repo'] };
      if (channel === 'sessions:list') return state.sessions;
      if (channel === 'desktop:focus') return { sessionId: state.sessions[0]?.id ?? null, at: 1, windowFocused: false };
      if (channel === 'sessions:transcriptPage') return { items: state.items, start: 0, total: state.items.length, seq: 1 };
      if (channel === 'harness:availability') return {};
      return undefined;
    }
  };
  return { client, state, calls, invokes, pushes };
}

const host = (deviceId: string, name: string, online = true): OwnerHost => ({ deviceId, name, platform: 'linux', lastSeen: 0, online });

const ANONYMOUS: AccountState = { status: 'anonymous' };
const SIGNED_IN: AccountState = { status: 'signed-in', account: { login: 'vocs', accountId: 'vocs-v1' } };

function mount(parts: { client: unknown; transport: RelayTransport; account?: AccountState; initialCode?: string; connectHash?: string }) {
  holder.transport = parts.transport as never;
  return rtl.render(<WebApp client={parts.client as never} transport={parts.transport} account={parts.account ?? ANONYMOUS} initialCode={parts.initialCode} connectHash={parts.connectHash} />);
}

beforeEach(async () => {
  vi.resetModules();
  holder.transport = null;
  rtl = await import('@testing-library/react');
  WebApp = (await import('../src/web/shell/WebApp')).WebApp;
  ({ useStore, configureStore } = await import('../src/renderer/src/store'));
  configureStore({ pagedTranscripts: true, probeAvailabilityOnBoot: false, openFirstSessionOnBoot: false });
  useStore.getState().reset();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
});

afterEach(() => {
  rtl.cleanup();
  vi.unstubAllGlobals();
});

describe('pairing from a link', () => {
  it('prefills the code, fetches only /v1/me first, and enters the app after the desktop approves', async () => {
    const { client, state, calls } = shell();
    const transport = new RelayTransport(client as unknown as RelayClient);
    const view = mount({ client, transport, initialCode: 'ABCD2345' });

    await rtl.waitFor(() => expect(rtl.screen.getByTestId('pair-screen')).toBeTruthy());
    expect((rtl.screen.getByTestId('pair-code') as HTMLInputElement).value).toBe('ABCD2345');
    // The account was resolved before the shell mounted; the shell itself fetches nothing.
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls).toEqual([]);
    expect(view.container.querySelector('form.account-signout')).toBeNull();

    rtl.fireEvent.change(rtl.screen.getByTestId('pair-name'), { target: { value: 'Test Phone' } });
    rtl.fireEvent.click(rtl.screen.getByTestId('pair-submit'));
    await rtl.waitFor(() => expect(rtl.screen.getByTestId('computers')).toBeTruthy());
    expect(calls).toContain('pair:ABCD2345');
    expect(state.creds).toMatchObject({ hostDeviceId: 'h1' });
    expect(rtl.screen.getByTestId('session-list')).toBeTruthy();
  });

  it('refuses to pair when the browser cannot keep its keys', async () => {
    // The real client, with a vault that cannot load: no IndexedDB must mean no pairing form.
    const client = new RelayClient({
      vault: { load: async () => { throw new Error('IndexedDB is unavailable'); }, save: async () => undefined, clear: async () => undefined }
    });
    const transport = new RelayTransport(client);
    mount({ client, transport });
    await rtl.waitFor(() => expect(rtl.screen.getByText(/cannot store pairing keys securely/)).toBeTruthy());
    expect((rtl.screen.getByTestId('pair-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('signed-in owner', () => {
  it('shows sign-out only when the landing gate identifies a login', async () => {
    const { client } = shell({ creds: { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase: 'http://localhost' }, sessions: [] });
    const transport = new RelayTransport(client as unknown as RelayClient);
    mount({ client, transport, account: SIGNED_IN });
    await rtl.waitFor(() => expect(rtl.screen.getByTestId('computers')).toBeTruthy());
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Menu' }));
    await rtl.waitFor(() => expect(rtl.screen.getByText('@vocs')).toBeTruthy());
    expect(rtl.screen.getByText('Sign out of GitHub')).toBeTruthy();
  });

  it('pairs a listed computer with no code, and renders a hostile name as text', async () => {
    const hostile = '<img src=x onerror=alert(1)> PC';
    const { client, calls, state } = shell({ hosts: [host('h2', hostile)] });
    const transport = new RelayTransport(client as unknown as RelayClient);
    const view = mount({ client, transport, account: SIGNED_IN });
    await rtl.waitFor(() => expect(rtl.screen.getByText(hostile)).toBeTruthy());
    // A host name is rendered as text: no element is ever created from it.
    expect(view.container.querySelector('img')).toBeNull();
    rtl.fireEvent.click(rtl.screen.getByTestId('owner-pair'));
    await rtl.waitFor(() => expect(state.creds).toBeTruthy());
    // The relay base is this page's own origin; the shell adds no Authorization of its own.
    expect(calls).toContain('pairWithHost:h2');
    expect(calls).toContain('ownerHosts');
  });

  it('adds a computer, waits for it, then asks it to pair — in that order', async () => {
    const { client, calls, state } = shell({ hosts: [host('h2', 'Lab PC')] });
    const transport = new RelayTransport(client as unknown as RelayClient);
    mount({ client, transport, account: SIGNED_IN, connectHash: 'a'.repeat(64) });
    await rtl.waitFor(() => expect(rtl.screen.getByTestId('connect-screen')).toBeTruthy());
    expect(rtl.screen.getByTestId('connect-code').textContent).toBeTruthy();
    rtl.fireEvent.click(rtl.screen.getByTestId('connect-add'));
    await rtl.waitFor(() => expect(state.creds).toBeTruthy(), { timeout: 5_000 });
    const order = calls.filter((call) => ['addComputer', 'addedComputer', 'ownerHosts', 'pairWithHost:h2'].includes(call));
    expect(order).toEqual(['addComputer', 'addedComputer', 'ownerHosts', 'pairWithHost:h2']);
  });
});

describe('remote composer attachments', () => {
  const creds = { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase: 'http://localhost' };

  async function open(current: SessionMeta = session) {
    const fixture = shell({ creds, sessions: [current] });
    mount({ client: fixture.client, transport: new RelayTransport(fixture.client as unknown as RelayClient) });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('textbox', { name: 'Message' })).toBeTruthy());
    return fixture;
  }

  it('picks and pastes two non-image files, removes one, and sends the other as base64 with the draft', async () => {
    const fixture = await open();
    const input = rtl.screen.getByLabelText('Choose files') as HTMLInputElement;
    rtl.fireEvent.change(input, { target: { files: [file('notes.txt', 'hello')] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('button', { name: 'Remove notes.txt' })).toBeTruthy());
    rtl.fireEvent.paste(rtl.screen.getByRole('textbox', { name: 'Message' }), { clipboardData: { files: [file('todo.md', 'world')] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('button', { name: 'Remove todo.md' })).toBeTruthy());
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Remove notes.txt' }));
    rtl.fireEvent.change(rtl.screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'review this' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Send' }));
    await rtl.waitFor(() => expect(fixture.invokes.filter(([channel]) => channel === 'sessions:send')).toEqual([
      ['sessions:send', { id: 's1', input: { text: 'review this', files: [{ name: 'todo.md', mimeType: 'text/plain', data: 'd29ybGQ=' }] } }]
    ]));
    await rtl.waitFor(() => expect(rtl.screen.queryByRole('button', { name: 'Remove todo.md' })).toBeNull());
  });

  it('reuses a Mission file send key after a lost reply, but not after changing the payload', async () => {
    const fixture = await open({ ...session, mission: { missionId: 'mission', role: 'lead', generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: true } });
    const picker = rtl.screen.getByLabelText('Choose files');
    rtl.fireEvent.change(picker, { target: { files: [file('notes.txt', 'mission')] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('button', { name: 'Remove notes.txt' })).toBeTruthy());
    fixture.state.sendFails = true;
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Send' }));
    await rtl.waitFor(() => expect(rtl.screen.getByText('Computer refused the send')).toBeTruthy());
    fixture.state.sendFails = false;
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Send' }));
    await rtl.waitFor(() => expect(fixture.invokes.filter(([channel]) => channel === 'sessions:send')).toHaveLength(2));
    const [first, second] = fixture.invokes.filter(([channel]) => channel === 'sessions:send').map(([, value]) => value as { idempotencyKey: string; input: unknown });
    expect(first.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.input).toEqual(first.input);
    await rtl.waitFor(() => expect(rtl.screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull());
  });

  it('allows a file-only message at the exact 128 KiB boundary', async () => {
    const fixture = await open();
    const boundary = file('boundary.bin', 'x'.repeat(128 * 1024), 'application/octet-stream');
    rtl.fireEvent.change(rtl.screen.getByLabelText('Choose files'), { target: { files: [boundary] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('button', { name: 'Remove boundary.bin' })).toBeTruthy());
    expect(rtl.screen.queryByRole('alert')).toBeNull();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Send' }));
    await rtl.waitFor(() => expect(fixture.invokes.filter(([channel]) => channel === 'sessions:send')).toHaveLength(1));
    expect(fixture.invokes.filter(([channel]) => channel === 'sessions:send')[0]).toEqual([
      'sessions:send', { id: 's1', input: { text: '', files: [{ name: 'boundary.bin', mimeType: 'application/octet-stream', data: btoa('x'.repeat(128 * 1024)) }] } }
    ]);
  });

  it('rejects images, oversized files and a third file with an inline error; failed sends keep text and chips', async () => {
    const fixture = await open();
    const input = rtl.screen.getByLabelText('Choose files') as HTMLInputElement;
    rtl.fireEvent.change(input, { target: { files: [file('one.txt', 'one'), file('two.txt', 'two')] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('button', { name: 'Remove two.txt' })).toBeTruthy());
    rtl.fireEvent.change(input, { target: { files: [file('three.txt', 'three')] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('alert').textContent).toMatch(/2 files/));
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Remove two.txt' }));
    rtl.fireEvent.change(input, { target: { files: [file('photo.png', 'png', 'image/png')] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('alert').textContent).toMatch(/Images are not supported/));
    const large = file('large.txt', 'x');
    Object.defineProperty(large, 'size', { value: 128 * 1024 + 1 });
    rtl.fireEvent.change(input, { target: { files: [large] } });
    await rtl.waitFor(() => expect(rtl.screen.getByRole('alert').textContent).toMatch(/128 KiB/));
    expect(rtl.screen.queryByRole('button', { name: 'Remove large.txt' })).toBeNull();
    fixture.state.sendFails = true;
    rtl.fireEvent.change(rtl.screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'keep me' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Send' }));
    await rtl.waitFor(() => expect(rtl.screen.getByText('Computer refused the send')).toBeTruthy());
    expect((rtl.screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('keep me');
    expect(rtl.screen.getByRole('button', { name: 'Remove one.txt' })).toBeTruthy();
    expect(fixture.invokes.filter(([channel]) => channel === 'sessions:send')).toEqual([
      ['sessions:send', { id: 's1', input: { text: 'keep me', files: [{ name: 'one.txt', mimeType: 'text/plain', data: 'b25l' }] } }]
    ]);
  });
});

describe('connection states', () => {
  it('says the computer is unreachable and keeps the reader on the sessions home', async () => {
    const { client, state } = shell({ creds: { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase: 'http://localhost' }, connectFails: true, sessions: [] });
    const transport = new RelayTransport(client as unknown as RelayClient);
    mount({ client, transport });
    await rtl.waitFor(() => expect(rtl.screen.getByText('Offline: the computer is unreachable')).toBeTruthy());
    expect(rtl.screen.getByTestId('session-list')).toBeTruthy();
    expect(state.creds).toBeTruthy();
  });

  it('shows the view-only banner when the desktop pushes the policy', async () => {
    const { client, pushes } = shell({ creds: { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase: 'http://localhost' }, sessions: [] });
    const transport = new RelayTransport(client as unknown as RelayClient);
    mount({ client, transport });
    await rtl.waitFor(() => expect(rtl.screen.getByTestId('computers')).toBeTruthy());
    // Wait for the boot that installs the store's push subscriptions before pushing the policy.
    await rtl.waitFor(() => expect(useStore.getState().booted).toBe(true));
    for (const listener of pushes) listener('push:remotePolicy', { viewOnly: true });
    // The gate follows the push asynchronously through React; poll rather than sample once.
    await rtl.waitFor(() => expect(transport.can('sessions:send')).toBe(false));
    expect(rtl.screen.getByText('View-only on this computer')).toBeTruthy();
  });

  it('browses the sealed mirror while the computer is offline', async () => {
    const index: MirrorIndex = {
      hostName: 'Work PC',
      updatedAt: 9,
      focus: 's1',
      sessions: [{ id: 's1', title: 'Mirrored session', status: 'idle', harness: 'claude', projectRoot: '/repo', updatedAt: 9 }]
    };
    const items: TranscriptItem[] = [{ id: 'm1', kind: 'assistant', ts: 1, text: 'from the sealed snapshot' }];
    const { client } = shell({ creds: { hostDeviceId: 'h1', hostName: 'Work PC', webDeviceId: 'w1', relayBase: 'http://localhost' }, connectFails: true, mirror: true, index, items });
    const transport = new RelayTransport(client as unknown as RelayClient);
    mount({ client, transport });
    // The default route opens the mirror's remembered focus, so the transcript loads on its own.
    await rtl.waitFor(() => expect(rtl.screen.getAllByText('Mirrored session').length).toBeGreaterThan(0));
    expect(rtl.screen.getByText('Offline: reading the last mirrored snapshot')).toBeTruthy();
    await rtl.waitFor(() => expect(rtl.screen.getByText('from the sealed snapshot')).toBeTruthy());
  });
});
