/** Unit tests for the transport-agnostic handler registry (handlers.ts): dispatch, push
 *  wiring, desktop-bridge delegation, workspace-scoped fs handlers, slow-handler logging.
 *  Runs in plain Node — that is the point of the registry. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandlerRegistry, type DesktopBridge, type HandlerRegistry } from '../src/main/handlers';
import { PUSH_CHANNELS } from '../src/shared/ipc';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SecretStore } from '../src/main/secrets';
import type { SessionManager } from '../src/main/session-manager';
import type { SessionMeta } from '../src/shared/types';
import { SettingsStore } from '../src/main/settings';
import type { TerminalManager } from '../src/main/terminal';

const dirs: string[] = [];
let ws: string;

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), `vocs-handlers-${prefix}-`));
  dirs.push(d);
  return d;
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function bridgeStub() {
  const calls: string[] = [];
  const bridge: DesktopBridge = {
    appVersion: () => '0.0.0-test',
    isPackaged: () => false,
    userDataPath: () => ws,
    documentsPath: () => ws,
    electronVersion: () => 'unknown',
    openExternal: async (url) => void calls.push(`openExternal:${url}`),
    openPath: async (p) => void calls.push(`openPath:${p}`),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    notify: async (title) => void calls.push(`notify:${title}`),
    toggleFullScreen: () => void calls.push('toggleFullScreen'),
    reload: () => void calls.push('reload'),
    toggleDevTools: () => void calls.push('toggleDevTools'),
    zoom: () => null,
    edit: (command) => void calls.push(`edit:${command}`)
  };
  return { bridge, calls };
}

type Deps = Parameters<typeof createHandlerRegistry>[0];

function stubDeps(overrides: Partial<Deps> = {}): { registry: HandlerRegistry; deps: Deps; calls: string[]; pushes: [string, unknown][]; logs: [string, string][] } {
  const meta: SessionMeta = {
    id: 's_test',
    title: 'Test session',
    createdAt: 1,
    updatedAt: 1,
    config: { harness: 'native', permissionMode: 'ask', projectRoot: ws },
    cwd: ws,
    status: 'idle',
    harnessRef: {},
    usage: { ...ZERO_USAGE }
  };
  const { bridge, calls } = bridgeStub();
  const pushes: [string, unknown][] = [];
  const logs: [string, string][] = [];
  const settings = new SettingsStore(tmpDir('settings'));
  const deps: Deps = {
    settings,
    secrets: {
      has: (id: string) => id === 'testprov',
      get: async (id: string) => (id === 'testprov' ? 'sk-test' : undefined),
      set: async () => undefined,
      clear: async () => undefined
    } as unknown as SecretStore,
    sessions: {
      list: () => [meta],
      get: (id: string) => (id === meta.id ? meta : null),
      create: async () => meta,
      delete: async () => undefined,
      send: async () => new Promise((r) => setTimeout(r, 1100))
    } as unknown as SessionManager,
    terminals: { list: () => [] } as unknown as TerminalManager,
    runtime: {
      availability: async () => ({ available: true }),
      install: async () => ({ ok: false, log: '' })
    } as unknown as RuntimeResolver,
    analytics: { summary: async () => ({ totals: ZERO_USAGE, speed: null, days: [] }) } as unknown as AnalyticsStore,
    log: (level, message) => logs.push([level, message]),
    push: (channel, payload) => pushes.push([channel, payload]),
    desktop: bridge,
    ...overrides
  };
  return { registry: createHandlerRegistry(deps), deps, calls, pushes, logs };
}

describe('handler registry', () => {
  beforeAll(() => {
    ws = tmpDir('ws');
    fsSync.writeFileSync(path.join(ws, 'a.txt'), 'hello', 'utf8');
    fsSync.mkdirSync(path.join(ws, 'sub'));
    fsSync.writeFileSync(path.join(ws, 'sub', 'b.txt'), 'world', 'utf8');
  });

  it('rejects unknown channels', async () => {
    const { registry } = stubDeps();
    await expect(registry.invoke('nope:channel', {})).rejects.toThrow('Unknown channel');
  });

  it('serves a representative set of channels', () => {
    const { registry } = stubDeps();
    const channels = registry.channels();
    for (const c of ['sessions:list', 'settings:get', 'terminal:input', 'git:summary', 'fs:read', 'approvals:respond', 'analytics:summary', 'window:zoom']) {
      expect(channels).toContain(c);
    }
  });

  it('round-trips settings and pushes settingsChanged', async () => {
    const { registry, deps, pushes } = stubDeps();
    await deps.settings.load();
    const before = (await registry.invoke('settings:get', undefined)) as Awaited<ReturnType<SettingsStore['get']>>;
    expect(typeof before.notifications).toBe('boolean');
    const next = (await registry.invoke('settings:update', { notifications: false })) as typeof before;
    expect(next.notifications).toBe(false);
    expect(((await registry.invoke('settings:get', undefined)) as typeof before).notifications).toBe(false);
    expect(pushes.some(([c, p]) => c === PUSH_CHANNELS.settingsChanged && (p as typeof before).notifications === false)).toBe(true);
  });

  it('flips hasApiKey through secrets:set and pushes the new settings', async () => {
    const { registry, deps, pushes } = stubDeps();
    await deps.settings.load();
    await registry.invoke('settings:update', { providers: [{ id: 'testprov', kind: 'openai', name: 'Test', hasApiKey: false, models: [] }] });
    await registry.invoke('secrets:set', { providerId: 'testprov', apiKey: 'sk-test' });
    const list = (await registry.invoke('providers:list', undefined)) as { id: string; hasApiKey: boolean }[];
    expect(list.find((p) => p.id === 'testprov')?.hasApiKey).toBe(true);
    expect(pushes.filter(([c]) => c === PUSH_CHANNELS.settingsChanged).length).toBeGreaterThan(0);
  });

  it('lists, searches and reads workspace files, refusing escapes', async () => {
    const { registry } = stubDeps();
    const list = (await registry.invoke('fs:list', { sessionId: 's_test' })) as { name: string; path: string; isDir: boolean }[];
    expect(list.map((e) => e.path)).toEqual(['sub', 'a.txt']);
    const read = (await registry.invoke('fs:read', { sessionId: 's_test', path: 'a.txt' })) as { content: string; truncated: boolean };
    expect(read).toEqual({ content: 'hello', truncated: false });
    const escaped = (await registry.invoke('fs:read', { sessionId: 's_test', path: '../escape.txt' })) as { content: string };
    expect(escaped.content).toBe('');
    const outside = (await registry.invoke('fs:list', { sessionId: 's_test', relPath: '../' })) as unknown[];
    expect(outside).toEqual([]);
    const search = (await registry.invoke('fs:search', { sessionId: 's_test', query: 'txt' })) as string[];
    expect(search).toHaveLength(2);
    expect(search).toEqual(expect.arrayContaining(['a.txt', 'sub/b.txt']));
  });

  it('delegates desktop affordances and keeps the URL guard on openExternal', async () => {
    const { registry, calls } = stubDeps();
    const info = (await registry.invoke('app:info', undefined)) as { version: string; isPackaged: boolean };
    expect(info.version).toBe('0.0.0-test');
    expect(info.isPackaged).toBe(false);
    await registry.invoke('app:notify', { title: 't', body: 'b' });
    expect(calls).toContain('notify:t');
    registry.invoke('window:toggleFullScreen', undefined);
    expect(calls).toContain('toggleFullScreen');
    const zoom = (await registry.invoke('window:zoom', { direction: 'in' })) as { zoomFactor: number };
    expect(zoom).toEqual({ zoomFactor: 1 }); // no window -> zoom bridge returns null -> defaults to 1
    await registry.invoke('app:openExternal', { url: 'https://example.com' });
    expect(calls).toContain('openExternal:https://example.com');
    await registry.invoke('app:openExternal', { url: 'file:///etc/passwd' });
    expect(calls).not.toContain('openExternal:file:///etc/passwd');
  });

  it('dispatches session handlers and fails unknown sessions', async () => {
    const { registry } = stubDeps();
    const created = (await registry.invoke('sessions:create', {})) as SessionMeta;
    expect(created.id).toBe('s_test');
    expect(await registry.invoke('sessions:get', { id: 's_nope' })).toBeNull();
    await expect(registry.invoke('git:summary', { sessionId: 's_nope' })).rejects.toThrow('Session not found');
  });

  it('caches harness availability across full-list calls', async () => {
    const availability = Object.assign(async (_id: string) => ({ available: true }), { count: 0 });
    const counting = async (id: string) => {
      availability.count++;
      return availability(id);
    };
    const { registry } = stubDeps({ runtime: { availability: counting, install: async () => ({ ok: false, log: '' }) } as unknown as RuntimeResolver });
    const first = (await registry.invoke('harness:availability', undefined)) as Record<string, { available: boolean }>;
    const countAfterFirst = availability.count;
    const second = (await registry.invoke('harness:availability', undefined)) as Record<string, { available: boolean }>;
    expect(Object.keys(first).length).toBeGreaterThan(0);
    expect(first[Object.keys(first)[0]].available).toBe(true);
    expect(second).toEqual(first);
    expect(availability.count).toBe(countAfterFirst); // second call hit the cache
  });

  it('warns on slow handlers', async () => {
    const { registry, logs } = stubDeps();
    await registry.invoke('sessions:send', { id: 's_test', input: { text: 'hi' } });
    expect(logs.some(([level, msg]) => level === 'warn' && msg.includes('slow ipc sessions:send'))).toBe(true);
  });
});