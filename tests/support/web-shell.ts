/** Shared harness for the web-shell jsdom suites: a RelayClient-shaped double and a fresh module
 *  registry per test (the store installs push subscriptions once per page, so a test must not
 *  inherit another test's transport). `window.harness` is installed by the first import that calls
 *  `installHarness`; test files must import this module before anything that reaches `@renderer/api`. */
import { vi } from 'vitest';
import type { OwnerHost, RelayClient } from '../../relay/src/web-client';
import type { MirroredSession } from './web-shell-types';
import type { MirrorIndex } from '../../src/shared/mirror';
import type { SessionMeta, TranscriptItem } from '../../src/shared/types';

interface Holder {
  transport: { invoke: (c: never, r: never) => Promise<unknown>; on: (c: never, l: never) => () => void; can: (c: never) => boolean } | null;
}

const holder: Holder = { transport: null };

/** Points window.harness at whatever transport `setTransport` is given. */
export function installHarness(): void {
  (globalThis as unknown as { window: { harness: unknown } }).window.harness = {
    platform: 'browser',
    invoke: (channel: never, request: never) => holder.transport!.invoke(channel, request),
    on: (channel: never, listener: never) => holder.transport!.on(channel, listener),
    can: (channel: never) => holder.transport!.can(channel)
  };
}

export function setTransport(transport: unknown): void {
  holder.transport = transport as Holder['transport'];
}

export interface Pairing {
  hostDeviceId: string;
  hostName: string;
  webDeviceId: string;
  relayBase: string;
}

export interface ShellState {
  creds: Pairing | null;
  connected: boolean;
  connectFails: boolean;
  mirror: boolean;
  index: MirrorIndex | null;
  hosts: OwnerHost[];
  sessions: SessionMeta[];
  items: TranscriptItem[];
  snapshots: Map<string, MirroredSession>;
}

export interface ShellClient {
  client: RelayClient;
  state: ShellState;
  calls: string[];
  invokes: Array<[string, unknown]>;
  pushes: Set<(channel: string, payload: unknown) => void>;
  notify(): void;
}

/** A RelayClient-shaped double: scripted pairing and owner calls, store answers, push injection. */
export function createShellClient(initial: Partial<Omit<ShellState, 'snapshots'>> & { snapshots?: Map<string, MirroredSession> } = {}): ShellClient {
  const listeners = new Set<() => void>();
  const pushes = new Set<(channel: string, payload: unknown) => void>();
  const calls: string[] = [];
  const invokes: Array<[string, unknown]> = [];
  const state: ShellState = {
    creds: initial.creds ?? null,
    connected: initial.connected ?? true,
    connectFails: initial.connectFails ?? false,
    mirror: initial.mirror ?? false,
    index: initial.index ?? null,
    hosts: initial.hosts ?? [],
    sessions: initial.sessions ?? [],
    items: initial.items ?? [],
    snapshots: initial.snapshots ?? new Map()
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
    async mirrorSession(id: string) {
      if (!state.mirror) return null;
      return state.snapshots.get(id) ?? { id, title: 'Mirrored', status: 'idle', harness: 'claude', updatedAt: 1, items: state.items };
    },
    async invoke(channel: string, request: unknown) {
      invokes.push([channel, request]);
      if (channel === 'settings:get') return { remote: { viewOnly: false }, folders: ['/repo'], recentProjects: ['/repo'] };
      if (channel === 'sessions:list') return state.sessions;
      if (channel === 'desktop:focus') return { sessionId: state.sessions[0]?.id ?? null, at: 1, windowFocused: true };
      if (channel === 'sessions:transcriptPage') return { items: state.items, start: 0, total: state.items.length, seq: 1 };
      if (channel === 'harness:availability') return {};
      if (channel === 'sessions:setModel' || channel === 'sessions:setEffort' || channel === 'sessions:setPermissionMode' || channel === 'sessions:send' || channel === 'sessions:interrupt' || channel === 'sessions:stop') return undefined;
      return undefined;
    }
  } as unknown as RelayClient;
  return { client, state, calls, invokes, pushes, notify };
}

export const host = (deviceId: string, name: string, online = true): OwnerHost => ({ deviceId, name, platform: 'linux', lastSeen: 0, online });

/** Fresh modules per test: testing-library included, so React is never duplicated. */
export async function loadWebModules() {
  vi.resetModules();
  const rtl = await import('@testing-library/react');
  const { WebApp } = await import('../../src/web/shell/WebApp');
  const store = await import('../../src/renderer/src/store');
  store.configureStore({ pagedTranscripts: true, probeAvailabilityOnBoot: false, openFirstSessionOnBoot: false });
  store.useStore.getState().reset();
  return { rtl, WebApp, useStore: store.useStore, configureStore: store.configureStore };
}

/** The session metadata the shell tests use for focused/running/awaiting rows. */
export function session(id: string, title: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    config: { harness: 'claude', permissionMode: 'ask', projectRoot: '/repo' },
    cwd: '/repo',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  };
}
