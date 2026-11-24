/** Unit tests for the transport-agnostic handler registry (handlers.ts): dispatch, push
 *  wiring, desktop-bridge delegation, workspace-scoped fs handlers, slow-handler logging.
 *  Runs in plain Node — that is the point of the registry. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHandlerRegistry, type DesktopBridge, type HandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import { FILE_PREVIEW_MAX_BYTES, PUSH_CHANNELS } from '../src/shared/ipc';
import { agentChannels } from '../src/shared/agent-manifest';
import { isRemoteChannel, isRemotePushChannel } from '../src/shared/remote-channels';
import type { AnalyticsStore } from '../src/main/analytics';
import * as runtime from '../src/main/runtime';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SecretStore } from '../src/main/secrets';
import { providerSecrets } from '../src/main/secret-ids';
import type { SessionManager } from '../src/main/session-manager';
import type { RemoteConfig, HarnessId, SessionMeta, TranscriptItem, AppInstructionFile } from '../src/shared/types';
import type { RemoteHost } from '../src/main/remote/host';
import { signInProbe } from '../src/main/remote/relay-url';
import { SettingsStore } from '../src/main/settings';
import { PiConfigStore } from '../src/main/pi-config';
import { AppInstructions } from '../src/main/app-instructions';
import { openAntigravityUsage, openHarnessLogin, readHarnessSetup } from '../src/main/harness-setup';
import { readCodexSubscriptionQuota } from '../src/main/harness/codex-quota';
import type { SubscriptionLimits } from '../src/shared/subscription-usage';
import type { SearchIndex } from '../src/main/search';
import type { TerminalManager } from '../src/main/terminal';
import { discoverChatImports } from '../src/main/chat-import';
import { listHarnessModels } from '../src/main/harness/registry';
import type { ChatImportPreview } from '../src/shared/chat-import';

vi.mock('../src/main/chat-import', () => ({ discoverChatImports: vi.fn() }));
vi.mock('../src/main/harness/registry', async (original) => ({ ...await original<typeof import('../src/main/harness/registry')>(), listHarnessModels: vi.fn() }));
vi.mock('../src/main/harness-setup', async (original) => ({ ...await original<typeof import('../src/main/harness-setup')>(), openAntigravityUsage: vi.fn(), openHarnessLogin: vi.fn(), readHarnessSetup: vi.fn() }));
vi.mock('../src/main/harness/codex-quota', () => ({ readCodexSubscriptionQuota: vi.fn() }));

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
    showItemInFolder: (p) => void calls.push(`showItemInFolder:${p}`),
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
      install: async () => ({ ok: false, log: '' }),
      resolve: () => null
    } as unknown as RuntimeResolver,
    analytics: { summary: async () => ({ totals: ZERO_USAGE, speed: null, days: [] }), noteHarnessVersion: () => undefined } as unknown as AnalyticsStore,
    search: { search: () => ({ available: true, results: [] }) } as unknown as SearchIndex,
    log: (level, message) => logs.push([level, message]),
    push: (channel, payload) => pushes.push([channel, payload]),
    desktop: bridge,
    ...overrides
  };
  return { registry: createHandlerRegistry(deps), deps, calls, pushes, logs };
}

async function fileResolveRig() {
  const dir = tmpDir('resolve');
  const cwd = path.join(dir, 'current');
  const projectRoot = path.join(dir, 'project');
  const sibling = path.join(dir, 'sibling');
  await Promise.all([cwd, projectRoot, sibling].map((p) => fs.mkdir(p)));
  const { registry, deps } = stubDeps();
  const meta = deps.sessions.get('s_test')!;
  meta.cwd = cwd;
  meta.config.projectRoot = projectRoot;
  const other: SessionMeta = { ...meta, id: 's_sibling', cwd: sibling };
  deps.sessions.get = (id) => id === meta.id ? meta : id === other.id ? other : undefined;
  return { registry, cwd, projectRoot, sibling };
}

describe('handler registry', () => {
  it('restricts Housekeep and its excerpts to the desktop and refuses forged batches before session dispatch', async () => {
    const { registry, deps } = stubDeps();
    const list = vi.spyOn(deps.sessions, 'list');
    for (const channel of ['housekeep:preview', 'housekeep:assess', 'housekeep:apply', 'housekeep:inventory']) {
      expect(registry.channels()).toContain(channel);
      expect(isRemoteChannel(channel)).toBe(false);
      expect(agentChannels()).not.toContain(channel);
      await expect(registry.invoke(channel, {}, 'agent')).rejects.toThrow(/desktop owner/);
      await expect(registry.invoke(channel, {}, 'user')).rejects.toThrow(/desktop owner/);
    }
    const previewId = '56756756-e138-4775-8652-44316fa0203b';
    await expect(registry.invoke('housekeep:apply', { previewId, ids: ['s_test'], protectedIds: [], force: true }, 'desktop')).rejects.toThrow();
    await expect(registry.invoke('housekeep:apply', { previewId, ids: ['../s_test'], protectedIds: [] }, 'desktop')).rejects.toThrow();
    await expect(registry.invoke('housekeep:apply', { previewId, ids: ['s_test'], protectedIds: [] }, 'desktop')).rejects.toThrow(/preview expired/);
    expect(list).not.toHaveBeenCalled();
  });

  it('scopes inventory to the desktop profile without accepting paths or starting normal session Git polling', async () => {
    const { registry, deps } = stubDeps();
    const list = vi.spyOn(deps.sessions, 'list').mockReturnValue([]);
    await expect(registry.invoke('housekeep:inventory', { folders: [ws] }, 'desktop')).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      registry.invoke('housekeep:inventory', undefined, 'desktop'),
      registry.invoke('housekeep:inventory', undefined, 'desktop')
    ]);
    expect(first).toEqual({ repositories: 0, rows: [], warnings: [], limited: false });
    expect(second).toEqual(first);
    expect(list).toHaveBeenCalledExactlyOnceWith({ refreshGit: false });
  });

  it('validates the Housekeep override before scanning and accepts it only with a new preview', async () => {
    const { registry, deps } = stubDeps();
    const list = vi.spyOn(deps.sessions, 'list').mockReturnValue([]);
    for (const recentDaysOverride of [null, '3', -1, 1.5, 3651]) {
      await expect(registry.invoke('housekeep:preview', { protectedIds: [], recentDaysOverride }, 'desktop')).rejects.toThrow();
    }
    expect(list).not.toHaveBeenCalled();
    const preview = await registry.invoke('housekeep:preview', { protectedIds: [], recentDaysOverride: 3 }, 'desktop') as { id: string; recentDays: number };
    expect(preview.recentDays).toBe(3);
    for (const [channel, payload] of [
      ['housekeep:assess', { previewId: preview.id }],
      ['housekeep:apply', { previewId: preview.id, ids: ['s_test'], protectedIds: [] }]
    ] as const) {
      await expect(registry.invoke(channel, { ...payload, recentDaysOverride: 0 }, 'desktop')).rejects.toThrow(/Unrecognized key/);
    }
    expect(deps.settings.get().housekeepRecentDays).toBe(7);
  });

  it('keeps intelligence grants on the desktop and derives the project from the held session', async () => {
    const view = vi.fn(async () => ({ available: true }));
    const forget = vi.fn(async () => ({ forgotten: true }));
    const { registry, deps } = stubDeps({ intelligence: { view, forget } as unknown as HandlerDeps['intelligence'] });
    const settingsUpdate = vi.spyOn(deps.settings, 'update');
    for (const actor of ['user', 'agent'] as const) {
      await expect(registry.invoke('intelligence:view', { sessionId: 's_test' }, actor)).rejects.toThrow(/desktop owner/);
      await expect(registry.invoke('intelligence:memory:forget', { sessionId: 's_test', id: 'mem_abcdef' }, actor)).rejects.toThrow(/desktop owner/);
      await expect(registry.invoke('settings:update', { intelligence: { gateway: false, personalMemory: true } }, actor)).rejects.toThrow(/desktop owner/);
    }
    expect(settingsUpdate).not.toHaveBeenCalled();
    await expect(registry.invoke('intelligence:view', { sessionId: '../s_test' }, 'desktop')).rejects.toThrow(/Invalid Mission\/session identifier/);
    await expect(registry.invoke('intelligence:view', { sessionId: 's_unknown' }, 'desktop')).rejects.toThrow('Session not found');
    await expect(registry.invoke('intelligence:memory:forget', { sessionId: 's_test', id: '../../another' }, 'desktop')).rejects.toThrow('A memory record id is required');
    expect(view).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    const channels = registry.channels().filter((channel) => channel.startsWith('intelligence:'));
    expect(channels).toContain('intelligence:view');
    expect(channels.every((channel) => !isRemoteChannel(channel) && !agentChannels().includes(channel))).toBe(true);
    const session = deps.sessions.get('s_test')!;
    session.cwd = path.join(ws, 'worktree');
    session.worktreeBranch = 'vocs/test';
    await expect(registry.invoke('intelligence:view', { sessionId: 's_test', projectRoot: 'attacker', cwd: 'attacker', branch: 'other' }, 'desktop')).resolves.toEqual({ available: true });
    expect(view).toHaveBeenCalledExactlyOnceWith({ sessionId: 's_test', projectRoot: ws, cwd: session.cwd, branch: session.worktreeBranch });
  });

  it('keeps all account channels local-only and accepts no endpoint/credential configuration', async () => {
    const snapshot = { realm: 'staging', status: 'signed_out', refreshing: false, revision: 0, connections: [] } as const;
    const account = { get: vi.fn(() => snapshot), signIn: vi.fn(async () => snapshot), cancel: vi.fn(() => snapshot), signOut: vi.fn(async () => snapshot), refresh: vi.fn(async () => snapshot), dispose: vi.fn() };
    const { registry } = stubDeps({ vocsAccount: account as unknown as NonNullable<HandlerDeps['vocsAccount']> });
    for (const action of ['get', 'signIn', 'cancel', 'signOut', 'refresh'] as const) {
      const channel = `vocsAccount:${action}`;
      for (const actor of ['user', 'agent'] as const) await expect(registry.invoke(channel, undefined, actor)).rejects.toThrow(/desktop owner/);
      for (const input of [{}, { issuer: 'https://evil.invalid' }, { token: 'secret' }, null]) await expect(registry.invoke(channel, input, 'desktop')).rejects.toThrow(/do not accept configuration/);
      expect(account[action]).not.toHaveBeenCalled();
      await expect(registry.invoke(channel, undefined, 'desktop')).resolves.toEqual(snapshot);
      expect(account[action]).toHaveBeenCalledTimes(1);
      expect(isRemoteChannel(channel)).toBe(false);
      expect(agentChannels().includes(channel as never)).toBe(false);
    }
    // Sign-in takes exactly one renderer choice, whether to keep the sign-in; nothing else.
    for (const input of [{ persist: 'yes' }, { persist: true, clientId: 'vocs-code-device' }, { persist: true, deviceName: 'evil' }]) await expect(registry.invoke('vocsAccount:signIn', input, 'desktop')).rejects.toThrow(/do not accept configuration/);
    await expect(registry.invoke('vocsAccount:signIn', { persist: true }, 'desktop')).resolves.toEqual(snapshot);
    expect(account.signIn).toHaveBeenLastCalledWith({ persist: true });
    await expect(registry.invoke('vocsAccount:signIn', { persist: true }, 'agent')).rejects.toThrow(/desktop owner/);
    await registry.shutdown(); expect(account.dispose).toHaveBeenCalledTimes(1);
  });

  it('takes only a known Hub connection id from the desktop owner, never a resource, issuer, scope or token', async () => {
    const snapshot = { realm: 'staging', status: 'signed_in', refreshing: false, revision: 0, connections: [], hub: [] } as const;
    const account = { get: vi.fn(() => snapshot), hubConnect: vi.fn(async () => snapshot), hubCancel: vi.fn(() => snapshot), hubDisconnect: vi.fn(async () => snapshot), dispose: vi.fn() };
    const { registry } = stubDeps({ vocsAccount: account as unknown as NonNullable<HandlerDeps['vocsAccount']> });
    for (const action of ['hubConnect', 'hubCancel', 'hubDisconnect'] as const) {
      const channel = `vocsAccount:${action}`;
      expect(registry.channels()).toContain(channel);
      for (const actor of ['user', 'agent'] as const) await expect(registry.invoke(channel, { connectionId: 'openrouter' }, actor)).rejects.toThrow(/desktop owner/);
      for (const input of [undefined, null, {}, { connectionId: 'other' }, { connectionId: 'OpenRouter' }, { connectionId: 'openrouter', resource: 'https://evil.invalid/mcp' },
        { connectionId: 'openrouter', issuer: 'https://evil.invalid' }, { connectionId: 'openrouter', scopes: ['admin'] }, { connectionId: 'openrouter', token: 'secret' }, 'openrouter']) {
        await expect(registry.invoke(channel, input, 'desktop')).rejects.toThrow(/do not accept configuration/);
      }
      expect(account[action]).not.toHaveBeenCalled();
      await expect(registry.invoke(channel, { connectionId: 'openrouter' }, 'desktop')).resolves.toEqual(snapshot);
      expect(account[action]).toHaveBeenCalledExactlyOnceWith('openrouter');
      expect(isRemoteChannel(channel)).toBe(false);
      expect(agentChannels().includes(channel as never)).toBe(false);
    }
  });

  it('allows bounded sign-in only for the desktop owner and refuses forged launch arguments before execution', async () => {
    const { registry } = stubDeps();
    const login = vi.mocked(openHarnessLogin).mockReset().mockResolvedValue({ ok: true });
    for (const actor of ['agent', 'user'] as const) await expect(registry.invoke('harness:login', { harness: 'claude' }, actor)).rejects.toThrow(/desktop owner/);
    for (const input of [{ harness: 'cursor' }, { harness: 'claude', args: ['--dangerous'] }, { harness: 'codex', device: 'true' }, { harness: 'pi', cwd: '/project' }]) {
      await expect(registry.invoke('harness:login', input, 'desktop')).rejects.toThrow();
    }
    expect(login).not.toHaveBeenCalled();
    await expect(registry.invoke('harness:login', { harness: 'codex', device: true }, 'desktop')).resolves.toEqual({ ok: true });
    expect(login).toHaveBeenCalledOnce();
    expect(login.mock.calls[0]!.slice(1)).toEqual(['codex', true]);
    expect(isRemoteChannel('harness:login')).toBe(false);
    expect(agentChannels().includes('harness:login' as never)).toBe(false);
  });

  it('keeps subscription actions desktop-only and rejects config and non-listed providers before dispatch', async () => {
    const { registry, calls } = stubDeps();
    const read = vi.mocked(readCodexSubscriptionQuota).mockReset();
    const launch = vi.mocked(openAntigravityUsage).mockReset();
    for (const channel of ['subscriptions:read', 'subscriptions:openUsage'] as const) {
      expect(registry.channels()).toContain(channel);
      expect(isRemoteChannel(channel)).toBe(false);
      expect(agentChannels().includes(channel as never)).toBe(false);
      for (const actor of ['user', 'agent'] as const) {
        await expect(registry.invoke(channel, { provider: 'codex' }, actor)).rejects.toThrow(/desktop owner/);
      }
      for (const input of [undefined, { provider: 'pi' }, { provider: '__proto__' }, { provider: 'antigravity', args: ['-p', '/usage'] }, { provider: 'claude', url: 'https://example.test' }, { provider: 'codex', cwd: 'G:/repo' }]) {
        await expect(registry.invoke(channel, input, 'desktop')).rejects.toThrow(/Unsupported subscription/);
      }
    }
    await expect(registry.invoke('subscriptions:read', { provider: 'antigravity' }, 'desktop')).rejects.toThrow(/Unsupported/);
    expect(read).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('opens only fixed vendor sites or the interactive Antigravity CLI', async () => {
    const { registry, deps, calls } = stubDeps();
    const launch = vi.mocked(openAntigravityUsage).mockReset().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'No terminal' });
    await expect(registry.invoke('subscriptions:openUsage', { provider: 'antigravity' }, 'desktop')).resolves.toEqual({ kind: 'terminal' });
    expect(launch).toHaveBeenCalledExactlyOnceWith(deps.runtime);
    await expect(registry.invoke('subscriptions:openUsage', { provider: 'antigravity' }, 'desktop')).rejects.toThrow('No terminal');
    for (const provider of ['claude', 'codex', 'cursor']) {
      await expect(registry.invoke('subscriptions:openUsage', { provider }, 'desktop')).resolves.toEqual({ kind: 'browser' });
    }
    expect(calls).toEqual([
      'openExternal:https://claude.ai/settings/usage',
      'openExternal:https://chatgpt.com/codex/settings/usage',
      'openExternal:https://cursor.com/dashboard/usage'
    ]);
  });

  it('shares an in-flight Codex limit read but never caches the completed account snapshot', async () => {
    const { registry, deps, pushes } = stubDeps();
    const output: SubscriptionLimits = { groups: [{ name: 'Codex', buckets: [{ name: '5-hour limit', remainingFraction: 0.42 }] }] };
    let finish!: (result: SubscriptionLimits) => void;
    const read = vi.mocked(readCodexSubscriptionQuota).mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(output);
    const check = () => registry.invoke('subscriptions:read', { provider: 'codex' }, 'desktop');
    const a = check();
    const b = check();
    expect(read).toHaveBeenCalledExactlyOnceWith(deps.runtime);
    finish(output);
    await expect(Promise.all([a, b])).resolves.toEqual([output, output]);
    await expect(check()).resolves.toEqual(output);
    expect(read).toHaveBeenCalledTimes(2);
    expect(pushes).toEqual([]);
  });

  it('rejects invalid setup and install ids before their privileged dependencies', async () => {
    const { registry, deps } = stubDeps();
    const setup = vi.mocked(readHarnessSetup).mockReset();
    const install = vi.spyOn(deps.runtime, 'install');
    await expect(registry.invoke('harness:setup', { harness: 'unknown' }, 'desktop')).rejects.toThrow('Unknown harness');
    for (const id of ['__proto__', ['pi'], null, 1]) await expect(registry.invoke('harness:install', { id }, 'desktop')).rejects.toThrow('Unsupported');
    expect(setup).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });

  it('an explicit readiness refresh bypasses the cached signed-out result', async () => {
    const { registry, deps } = stubDeps();
    const probe = vi.spyOn(deps.runtime, 'availability').mockResolvedValue({ available: true, authenticated: false });
    await registry.invoke('harness:availability', undefined);
    const initialCalls = probe.mock.calls.length;
    probe.mockResolvedValue({ available: true, authenticated: true });
    const cached = await registry.invoke('harness:availability', undefined) as Record<string, { authenticated: boolean }>;
    expect(cached.claude!.authenticated).toBe(false); expect(probe).toHaveBeenCalledTimes(initialCalls);
    const fresh = await registry.invoke('harness:availability', { refresh: true }) as Record<string, { authenticated: boolean }>;
    expect(fresh.claude!.authenticated).toBe(true); expect(probe).toHaveBeenCalledTimes(initialCalls * 2);
  });

  it('validates import sources, opaque identifiers and selection before privileged operations', async () => {
    const { registry, deps } = stubDeps();
    const discover = vi.mocked(discoverChatImports);
    discover.mockReset();
    const importChats = vi.fn();
    deps.sessions.importChats = importChats;
    for (const request of [{ source: 'other' }, { source: 'claude', path: '/private/file' }]) {
      await expect(registry.invoke('sessions:importList', request)).rejects.toThrow();
    }
    for (const request of [{ source: 'claude', ids: [] }, { source: 'claude', ids: ['../../file'] }, { source: 'codex', ids: Array(201).fill('id') }, { source: 'claude', ids: ['id'], repairOnly: 'true' }, { source: 'claude', ids: ['id'], repairOnly: 1 }, { source: 'claude', ids: ['id'], repairOnly: true, projectRoot: '/private/file' }]) {
      await expect(registry.invoke('sessions:import', request)).rejects.toThrow();
    }
    expect(discover).not.toHaveBeenCalled();
    expect(importChats).not.toHaveBeenCalled();
    discover.mockResolvedValue({ sessions: [], skippedFiles: 0, skippedReasons: {}, scanErrors: 0, malformedLines: 0, truncated: false });
    await expect(registry.invoke('sessions:import', { source: 'claude', ids: ['unlisted'] })).rejects.toThrow('Scan again');
    expect(importChats).not.toHaveBeenCalled();
    for (const channel of ['sessions:importList', 'sessions:import']) {
      expect(isRemoteChannel(channel)).toBe(false);
      expect(agentChannels().includes(channel as never)).toBe(false);
    }
  });

  it('forwards only aggregate import skip diagnostics from discovery to the desktop preview', async () => {
    const { registry } = stubDeps();
    const discover = vi.mocked(discoverChatImports);
    discover.mockReset();
    discover.mockResolvedValue({ sessions: [], skippedFiles: 4, skippedReasons: { empty: 2, invalidHistory: 1, unreadable: 1 }, scanErrors: 1, malformedLines: 3, truncated: false });
    await expect(registry.invoke('sessions:importList', { source: 'claude' })).resolves.toEqual({
      candidates: [], skipped: 4, skippedReasons: { empty: 2, invalidHistory: 1, unreadable: 1 }, scanErrors: 1, malformedLines: 3, truncated: false
    });
    expect(discover).toHaveBeenCalledExactlyOnceWith('claude');
  });

  it.each(['claude', 'codex', 'codex-exec'] as const)('marks an existing %s provider conversation as already represented in the import preview', async (harness) => {
    const { registry, deps } = stubDeps();
    const source = harness === 'claude' ? 'claude' : 'codex';
    const existing = deps.sessions.get('s_test')!;
    deps.sessions.list = () => [{ ...existing, config: { ...existing.config, harness }, harnessRef: source === 'claude' ? { claudeSessionId: 'provider-owned' } : { codexThreadId: 'provider-owned' } }];
    const discover = vi.mocked(discoverChatImports);
    discover.mockReset();
    discover.mockResolvedValue({ sessions: [{ candidate: { id: `${source}_owned`, source, sourceSessionId: 'provider-owned', title: 'Existing conversation', projectRoot: ws, createdAt: 1, updatedAt: 2, messageCount: 1 }, items: [{ id: 'q', kind: 'user', text: 'Original question', ts: 1 }] }], skippedFiles: 0, skippedReasons: {}, scanErrors: 0, malformedLines: 0, truncated: false });
    const result = await registry.invoke('sessions:importList', { source }) as ChatImportPreview;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.imported).toBe(true);
  });

  it.each(['imported', 'claude', 'codex', 'codex-exec'] as const)('reports missing registration for a saved %s chat without mutating settings on scan', async (identity) => {
    const { registry, deps } = stubDeps();
    const source = identity === 'codex' || identity === 'codex-exec' ? 'codex' : 'claude';
    const storedRoot = path.join(ws, 'stored-project');
    const externalRoot = path.join(ws, 'moved-source-project');
    const existing: SessionMeta = { ...deps.sessions.get('s_test')!, config: { harness: identity === 'imported' ? 'claude' : identity, permissionMode: 'ask', projectRoot: storedRoot },
      ...(identity === 'imported' ? { importedFrom: { source, sessionId: 'provider-owned' } } : {}),
      harnessRef: identity === 'imported' ? {} : source === 'claude' ? { claudeSessionId: 'provider-owned' } : { codexThreadId: 'provider-owned' } };
    deps.sessions.list = () => [existing];
    const update = vi.spyOn(deps.settings, 'update');
    const discover = vi.mocked(discoverChatImports);
    discover.mockReset();
    discover.mockResolvedValue({ sessions: [{ candidate: { id: `${source}_owned`, source, sourceSessionId: 'provider-owned', title: 'Saved chat', projectRoot: externalRoot, createdAt: 1, updatedAt: 2, messageCount: 1 }, items: [] }], skippedFiles: 0, skippedReasons: {}, scanErrors: 0, malformedLines: 0, truncated: false });
    const preview = await registry.invoke('sessions:importList', { source }) as ChatImportPreview;
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]).toMatchObject({ imported: true, registrationPending: true, projectRoot: storedRoot });
    expect(update).not.toHaveBeenCalled();
    expect(deps.settings.get().folders).not.toContain(storedRoot);
    await deps.settings.update({ folders: [storedRoot] });
    update.mockClear();
    const repaired = await registry.invoke('sessions:importList', { source }) as ChatImportPreview;
    expect(repaired.candidates[0]!.imported).toBe(true);
    expect(repaired.candidates[0]!.registrationPending).toBeFalsy();
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it('forwards repair-only intent only after opaque selection validation', async () => {
    const { registry, deps, pushes } = stubDeps();
    const parsed = { candidate: { id: 'claude_saved', source: 'claude' as const, sourceSessionId: 'saved', title: 'Saved chat', projectRoot: ws, createdAt: 1, updatedAt: 2, messageCount: 1 }, items: [] };
    const discover = vi.mocked(discoverChatImports);
    discover.mockReset();
    discover.mockResolvedValue({ sessions: [parsed], skippedFiles: 0, skippedReasons: {}, scanErrors: 0, malformedLines: 0, truncated: false });
    const repair = vi.fn(async () => ({ imported: [], skipped: 1 }));
    deps.sessions.importChats = repair;
    await expect(registry.invoke('sessions:import', { source: 'claude', ids: ['unlisted'], repairOnly: true })).rejects.toThrow('Scan again');
    expect(repair).not.toHaveBeenCalled();
    await expect(registry.invoke('sessions:import', { source: 'claude', ids: ['claude_saved'], repairOnly: true })).resolves.toEqual({ imported: [], skipped: 1 });
    expect(repair).toHaveBeenCalledExactlyOnceWith([parsed], { repairOnly: true });
    expect(pushes).toEqual([[PUSH_CHANNELS.settingsChanged, deps.settings.get()]]);
  });

  it.each([false, true])('publishes authoritative import settings after the operation (partial failure: %s)', async (fails) => {
    const { registry, deps, pushes } = stubDeps();
    const root = path.join(ws, 'imported-project');
    const discover = vi.mocked(discoverChatImports);
    discover.mockReset();
    discover.mockResolvedValue({ sessions: [{ candidate: { id: 'claude_new', source: 'claude', sourceSessionId: 'new-provider', title: 'Imported conversation', projectRoot: root, createdAt: 1, updatedAt: 2, messageCount: 1 }, items: [{ id: 'q', kind: 'user', text: 'Imported question', ts: 1 }] }], skippedFiles: 0, skippedReasons: {}, scanErrors: 0, malformedLines: 0, truncated: false });
    deps.sessions.importChats = async () => {
      await deps.settings.update({ folders: [root], recentProjects: [root] });
      if (fails) throw new Error('later selected chat failed');
      return { imported: [], skipped: 0 };
    };
    const result = registry.invoke('sessions:import', { source: 'claude', ids: ['claude_new'] });
    if (fails) await expect(result).rejects.toThrow('later selected chat failed');
    else await expect(result).resolves.toEqual({ imported: [], skipped: 0 });
    expect(pushes).toEqual([[PUSH_CHANNELS.settingsChanged, deps.settings.get()]]);
    expect((pushes[0]![1] as { folders: string[] }).folders).toEqual([root]);
  });

  beforeAll(() => {
    ws = tmpDir('ws');
    fsSync.writeFileSync(path.join(ws, 'a.txt'), 'hello', 'utf8');
    fsSync.mkdirSync(path.join(ws, 'sub'));
    fsSync.writeFileSync(path.join(ws, 'sub', 'b.txt'), 'world', 'utf8');
  });

  it('rejects unknown channels and leaves a log line', async () => {
    const { registry, logs } = stubDeps();
    await expect(registry.invoke('nope:channel', {})).rejects.toThrow('Unknown channel');
    expect(logs).toContainEqual(['warn', 'ipc: unknown channel nope:channel']);
  });

  it('logs a failing handler by channel and error, never by request payload', async () => {
    const { registry, logs } = stubDeps();
    await expect(registry.invoke('mcp:project', { sessionId: 's_missing' })).rejects.toThrow('Session not found');
    expect(logs).toContainEqual(['warn', 'ipc mcp:project failed: Session not found']);
    expect(logs.some(([, m]) => m.includes('s_missing'))).toBe(false);
  });

  it('serves a representative set of channels', () => {
    const { registry } = stubDeps();
    const channels = registry.channels();
    for (const c of ['sessions:list', 'settings:get', 'terminal:input', 'git:summary', 'fs:read', 'fs:resolve', 'approvals:respond', 'analytics:summary', 'window:zoom']) {
      expect(channels).toContain(c);
    }
  });

  it('reads a linked PR by its GitHub URL after the session worktree was removed', async () => {
    const { registry, deps } = stubDeps();
    const removedCheckout = path.join(ws, 'removed-worktree');
    const archived = { ...deps.sessions.get('s_test')!, id: '_archived', archived: true, cwd: removedCheckout };
    const getSession = vi.spyOn(deps.sessions, 'get').mockImplementation((id) => id === archived.id ? archived : undefined);
    const channel = 'git:pullRequest';
    const url = 'https://github.com/other/project/pull/42';
    const comment = { body: 'Ready to ship' };
    const pr = { number: 42, title: 'Ship it', state: 'MERGED', url };
    const which = vi.spyOn(runtime, 'which').mockReturnValue('fake-gh');
    const capture = vi.spyOn(runtime, 'runCapture').mockImplementation(async (_cmd, _args, opts) => (
      opts?.cwd === removedCheckout
        ? { code: null, stdout: '', stderr: 'spawn gh ENOENT' }
        : { code: 0, stdout: JSON.stringify({ ...pr, comments: [comment] }), stderr: '' }
    ));
    try {
      await expect(registry.invoke(channel, { sessionId: 's_missing', url }, 'desktop')).rejects.toThrow('Session not found');
      await expect(registry.invoke(channel, { sessionId: archived.id, url, cwd: 'caller-supplied' }, 'desktop')).rejects.toThrow();
      for (const invalidUrl of ['https://github.com.invalid/other/project/pull/42', `${url}/files`, 'https://github.com/other/project/pull/0']) {
        await expect(registry.invoke(channel, { sessionId: archived.id, url: invalidUrl }, 'desktop')).resolves.toEqual({ error: 'Invalid GitHub pull request link.' });
      }
      expect(capture).not.toHaveBeenCalled();

      await expect(registry.invoke(channel, { sessionId: archived.id, url: `${url}?source=chat#issuecomment-1` }, 'desktop'))
        .resolves.toEqual({ pr: { ...pr, comments: 1 }, comments: [comment] });
      expect(capture).toHaveBeenCalledExactlyOnceWith('fake-gh', ['pr', 'view', url, '--json', expect.stringContaining('comments')], expect.objectContaining({ cwd: undefined }));
      expect(isRemoteChannel(channel)).toBe(false);
      expect(agentChannels()).not.toContain(channel);
    } finally {
      capture.mockRestore();
      which.mockRestore();
      getSession.mockRestore();
    }
  });

  it('validates Fast mode requests before dispatch and refuses unknown sessions', async () => {
    const setFastMode = vi.fn(async () => ({ id: 's_test' }));
    const { registry } = stubDeps({ sessions: { list: () => [], get: (id: string) => id === 's_test' ? { id } : undefined, setFastMode } as unknown as SessionManager });
    for (const request of [{ id: '../escape', enabled: true }, { id: 's_test', enabled: 'yes' }, { id: 's_test', enabled: true, extra: 1 }, { id: 'missing', enabled: true }]) {
      await expect(registry.invoke('sessions:setFastMode', request)).rejects.toThrow();
    }
    expect(setFastMode).not.toHaveBeenCalled();
    await expect(registry.invoke('sessions:setFastMode', { id: 's_test', enabled: true })).resolves.toEqual({ id: 's_test' });
    expect(setFastMode.mock.calls).toEqual([['s_test', true]]);
  });

  it('returns the transcript page with its event floor, and rejects an unknown session', async () => {
    const items: TranscriptItem[] = [{ id: 'a', kind: 'info', ts: 1, level: 'info', text: 'hi' }];
    const { registry } = stubDeps({
      sessions: {
        transcriptSnapshot: async (id: string) => {
          if (id !== 's_test') throw new Error('Session not found');
          return { items, seq: 7 };
        }
      } as unknown as SessionManager
    });
    // The floor travels beside the window so a remote client can follow with seq-filtered events.
    await expect(registry.invoke('sessions:transcriptPage', { id: 's_test' })).resolves.toEqual({ items, start: 0, total: 1, seq: 7 });
    await expect(registry.invoke('sessions:transcriptPage', { id: 'nope' })).rejects.toThrow('Session not found');
  });

  it('writes the app instruction layer under userData and refuses an unknown scope', async () => {
    // Its own root: the shared workspace fixture has an exact directory listing asserted elsewhere.
    const dir = tmpDir('instructions');
    const { registry } = stubDeps({ appInstructions: new AppInstructions(dir) });
    const files = (await registry.invoke('instructions:read', undefined)) as AppInstructionFile[];
    expect(files.map((f) => f.scope)).toEqual(['global', 'pi', 'claude', 'codex', 'cursor', 'acp', 'native']);
    expect(files[0]).toMatchObject({ scope: 'global', exists: false, content: '' });

    const written = (await registry.invoke('instructions:write', { scope: 'global', content: 'Be proactive.\n' })) as AppInstructionFile[];
    expect(written.find((f) => f.scope === 'global')).toMatchObject({ exists: true, content: 'Be proactive.\n' });
    expect(await fs.readFile(path.join(dir, 'instructions', 'global.md'), 'utf8')).toBe('Be proactive.\n');

    // A scope the layer does not define never reaches the filesystem.
    await expect(registry.invoke('instructions:write', { scope: '../../evil', content: 'x' })).rejects.toThrow('Unknown instruction scope');
  });

  it('serves every channel Vesta is allowed to reach', () => {
    // A capability naming a channel that does not exist would fail silently at runtime,
    // as a tool the model keeps calling and that always errors.
    const { registry } = stubDeps();
    const channels = registry.channels();
    for (const c of agentChannels()) expect(channels, `${c} is on the agent allowlist but not registered`).toContain(c);
  });

  it('serves the Processes panel to the desktop only, and hands the tracker only well-formed targets', async () => {
    const end = vi.fn(async () => ({ ended: 1, failed: [] }));
    const list = vi.fn(async () => ({ sampledAt: 1, processes: [] }));
    const { registry } = stubDeps({ processes: { list, end } });
    expect(await registry.invoke('processes:list', undefined)).toEqual({ sampledAt: 1, processes: [] });
    await registry.invoke('processes:end', { targets: [{ pid: 42, startedAt: 7 }, { pid: -1, startedAt: 7 }, { pid: 1.5, startedAt: 7 }, { pid: 43 }, null] });
    expect(end).toHaveBeenCalledWith([{ pid: 42, startedAt: 7 }]);
    // Ending processes is a local action: a paired browser can neither list nor end them.
    expect(isRemoteChannel('processes:list')).toBe(false);
    expect(isRemoteChannel('processes:end')).toBe(false);
    expect(isRemotePushChannel(PUSH_CHANNELS.processSummary)).toBe(false);
    expect(agentChannels()).not.toContain('processes:end');
    // Without a tracker (tests, a host that does not sample) the panel says so instead of failing.
    const bare = stubDeps().registry;
    expect(await bare.invoke('processes:list', undefined)).toMatchObject({ processes: [], error: 'Process tracking is not running.' });
  });

  it('rejects an empty MCP import with an actionable message and no settings write', async () => {
    const { registry, deps } = stubDeps();
    const update = vi.spyOn(deps.settings, 'update');
    await expect(registry.invoke('mcp:import', { servers: [], to: 'global' })).resolves.toEqual({ ok: false, error: 'No MCP servers to import.' });
    expect(update).not.toHaveBeenCalled();
  });

  it('removes a folder from the app: its sessions in one batch, its settings, nothing on disk', async () => {
    const rooted = (id: string, projectRoot: string): SessionMeta => ({
      id,
      title: id,
      createdAt: 1,
      updatedAt: 1,
      config: { harness: 'native', permissionMode: 'ask', projectRoot },
      cwd: projectRoot,
      status: 'idle',
      harnessRef: {},
      usage: { ...ZERO_USAGE }
    });
    const live = [rooted('s_a', 'G:/proj/a'), rooted('s_b', 'G:/proj/a'), rooted('s_c', 'G:/proj/b')];
    const batches: string[][] = [];
    const closed: string[] = [];
    const { registry, deps, pushes } = stubDeps({
      sessions: {
        list: () => live,
        get: (id: string) => live.find((s) => s.id === id) ?? null,
        deleteMany: async (ids: string[]) => {
          batches.push(ids);
          for (const id of ids) live.splice(live.findIndex((s) => s.id === id), 1);
          return ids.length;
        }
      } as unknown as SessionManager,
      terminals: { closeForSession: async (id: string) => void closed.push(id) } as unknown as TerminalManager
    });
    await deps.settings.load();
    await registry.invoke('settings:update', {
      folders: ['G:/proj/a', 'G:/proj/b'],
      folderOrder: ['G:/proj/b', 'G:/proj/a'],
      collapsedFolders: ['G:/proj/a'],
      recentProjects: ['G:/proj/a', 'G:/proj/b'],
      gitSetupSkipped: ['G:/proj/a'],
      folderStyles: { 'G:/proj/a': { color: '#5b9bf8' }, 'G:/proj/b': { icon: 'bolt' } },
      folderSessionDefaults: { 'G:/proj/a': { useWorktree: true }, 'G:/proj/b': { harness: 'pi' } }
    });
    const before = pushes.filter(([c]) => c === PUSH_CHANNELS.settingsChanged).length;

    const result = await registry.invoke('folders:remove', { root: 'G:/proj/a' });

    expect(result).toEqual({ removedSessions: 2 });
    // One batch, not two deletes: the renderer sees a single departure and picks one replacement.
    expect(batches).toEqual([['s_a', 's_b']]);
    // Shells hold the cwd open, so they come down first.
    expect(closed).toEqual(['s_a', 's_b']);
    const after = (await registry.invoke('settings:get', undefined)) as Awaited<ReturnType<SettingsStore['get']>>;
    expect(after.folders).toEqual(['G:/proj/b']);
    expect(after.folderOrder).toEqual(['G:/proj/b']);
    expect(after.collapsedFolders).toEqual([]);
    expect(after.recentProjects).toEqual(['G:/proj/b']);
    expect(after.gitSetupSkipped).toEqual([]);
    expect(after.folderStyles).toEqual({ 'G:/proj/b': { icon: 'bolt' } });
    // The removed folder's remembered new-session choices go with it; the other folder keeps its own.
    expect(after.folderSessionDefaults).toEqual({ 'G:/proj/b': { harness: 'pi' } });
    // The other folder keeps its session, and the renderer is told about the new settings.
    expect(live.map((s) => s.id)).toEqual(['s_c']);
    expect(pushes.filter(([c]) => c === PUSH_CHANNELS.settingsChanged).length).toBe(before + 1);
  });

  // The pre-session git probes take a folder, not a session id, so an unregistered path must be
  // refused outright — a paired browser reaches these channels too.
  it('probes a folder for a git repository only once the app knows the folder', async () => {
    const repo = tmpDir('repo');
    const init = spawnSync('git', ['init', '.'], { cwd: repo, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    const { registry, deps } = stubDeps();
    await deps.settings.load();

    expect(await registry.invoke('git:folderIsRepo', { projectRoot: repo })).toEqual({ isRepo: false });

    await registry.invoke('settings:update', { folders: [repo] });
    expect(await registry.invoke('git:folderIsRepo', { projectRoot: repo })).toEqual({ isRepo: true });
    // A known folder that is a plain directory is what disables worktree isolation in the dialog.
    expect(await registry.invoke('git:folderIsRepo', { projectRoot: ws })).toEqual({ isRepo: false });
  });

  it('lists a folder\'s local branches for the new worktree only once the app knows the folder', async () => {
    const repo = tmpDir('branches');
    for (const args of [['init', '-q', '--initial-branch=main', '.'], ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], ['branch', 'develop']]) {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
    const { registry, deps } = stubDeps();
    await deps.settings.load();

    expect(await registry.invoke('git:folderBranches', { projectRoot: repo })).toEqual({ branches: [] });

    await registry.invoke('settings:update', { folders: [repo, ws] });
    expect(await registry.invoke('git:folderBranches', { projectRoot: repo })).toEqual({ current: 'main', branches: ['develop', 'main'] });
    expect(await registry.invoke('git:folderBranches', { projectRoot: ws })).toEqual({ branches: [] });
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

  it('refuses unsafe provider settings through both registered save boundaries without writes or pushes', async () => {
    const { registry, deps, pushes, logs } = stubDeps();
    await deps.settings.update({ notifications: false });
    const before = deps.settings.get();
    const provider = { id: 'unsafe', kind: 'openai', name: 'Unsafe', enabled: true, hasApiKey: false, models: [], baseUrl: 'http://user:password@192.168.1.2/v1?token=hidden' };
    const write = vi.spyOn(deps.settings, 'update');
    const changed = vi.fn(); deps.settings.onChange(changed);
    await expect(registry.invoke('providers:save', provider)).rejects.toThrow(/HTTPS/);
    expect(write).not.toHaveBeenCalled();
    await expect(registry.invoke('settings:update', { providers: [provider] })).rejects.toThrow(/HTTPS/);
    expect(deps.settings.get()).toBe(before); expect(changed).not.toHaveBeenCalled(); expect(pushes).toEqual([]);
    expect(logs.map(([, message]) => message).join('\n')).not.toMatch(/password|hidden|192\.168/);
  });

  it('refuses legacy unsafe provider use before reading keys or dispatching a request', async () => {
    const { registry, deps } = stubDeps();
    const provider = { ...deps.settings.get().providers.find((p) => p.id === 'openai')!, baseUrl: 'http://192.168.1.2/v1' };
    // Simulate a legacy settings file, which remains loadable rather than preventing startup.
    deps.settings.get().providers.push({ ...provider, id: 'legacy' });
    const secret = vi.spyOn(deps.secrets, 'get');
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(registry.invoke('providers:test', { id: 'legacy' })).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('HTTPS') });
      await expect(registry.invoke('providers:refreshModels', { id: 'legacy' })).resolves.toMatchObject({ error: expect.stringContaining('HTTPS') });
      expect(secret).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { secret.mockRestore(); network.mockRestore(); }
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

  it('never lets a provider id name identity material in the shared secret store', async () => {
    const { registry, deps } = stubDeps();
    await deps.settings.load();
    const set = vi.spyOn(deps.secrets, 'set'), clear = vi.spyOn(deps.secrets, 'clear'), get = vi.spyOn(deps.secrets, 'get');
    for (const id of ['vocs-account:production', 'vocs-account:staging', 'vocs-hub:production:openrouter', 'vocs-hub:staging:openrouter', 'remote-host', 'remote-enroll']) {
      await expect(registry.invoke('secrets:set', { providerId: id, apiKey: '{"v":1}' })).rejects.toThrow(/reserved/);
      await expect(registry.invoke('secrets:clear', { providerId: id })).rejects.toThrow(/reserved/);
      await expect(registry.invoke('providers:save', { id, kind: 'openai', name: 'Evil', baseUrl: 'https://evil.example/v1', hasApiKey: false, models: [] })).rejects.toThrow(/reserved/);
      await expect(registry.invoke('secrets:has', { providerId: id })).resolves.toBe(false);
      await expect(registry.invoke('providers:delete', { id })).rejects.toThrow(/reserved/);
      await expect(providerSecrets(deps.secrets.get)(id)).resolves.toBeUndefined();
    }
    await expect(providerSecrets(async (id) => `key-for-${id}`)('openai')).resolves.toBe('key-for-openai');
    expect(set).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
    // A provider planted in settings under a reserved id never receives the vault record as its key.
    const { resolveProviderApiKey } = await import('../src/main/models/providers');
    await expect(resolveProviderApiKey({ id: 'vocs-account:production', kind: 'openai', name: 'Evil', baseUrl: 'https://evil.example/v1', hasApiKey: true, models: [] } as never, deps.secrets.get)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalledWith('vocs-account:production');
  });

  it('lists, searches and reads workspace files, refusing escapes', async () => {
    const { registry } = stubDeps();
    const list = (await registry.invoke('fs:list', { sessionId: 's_test' })) as { name: string; path: string; isDir: boolean }[];
    expect(list.map((e) => e.path)).toEqual(['sub', 'a.txt']);
    const read = (await registry.invoke('fs:read', { sessionId: 's_test', path: 'a.txt' })) as { content: string; truncated: boolean };
    expect(read).toEqual({ content: 'hello', truncated: false });
    await expect(registry.invoke('fs:read', { sessionId: 's_test', path: '../escape.txt' })).resolves.toEqual({ content: '', truncated: false, readOnly: true });
    await expect(registry.invoke('fs:read', { sessionId: 's_test', path: 'sub' })).resolves.toEqual({ content: '', truncated: false, readOnly: true });
    const outside = (await registry.invoke('fs:list', { sessionId: 's_test', relPath: '../' })) as unknown[];
    expect(outside).toEqual([]);
    const search = (await registry.invoke('fs:search', { sessionId: 's_test', query: 'txt' })) as string[];
    expect(search).toHaveLength(2);
    expect(search).toEqual(expect.arrayContaining(['a.txt', 'sub/b.txt']));
  });

  it('saves only desktop text using an exact byte precondition in the session worktree', async () => {
    const r = await fileResolveRig();
    const file = path.join(r.cwd, 'edit.txt');
    const checkoutFile = path.join(r.projectRoot, 'edit.txt');
    const before = '\uFEFFfirst\r\nsecond\r\n';
    const content = '\uFEFF雪\r\n';
    await fs.writeFile(file, before);
    await fs.writeFile(checkoutFile, before);
    const target = { sessionId: 's_test', path: 'edit.txt' };
    const preview = await r.registry.invoke('fs:read', { ...target, maxBytes: FILE_PREVIEW_MAX_BYTES });
    expect(preview).toEqual({ content: before, truncated: false });
    const req = { ...target, content, expectedContent: before };
    expect(isRemoteChannel('fs:writeText')).toBe(false);
    for (const actor of ['user', 'agent'] as const) {
      await expect(r.registry.invoke('fs:writeText', req, actor)).rejects.toThrow(/local desktop owner/);
    }
    await expect(fs.readFile(file)).resolves.toEqual(Buffer.from(before));
    await expect(r.registry.invoke('fs:writeText', req, 'desktop')).resolves.toBeUndefined();
    await expect(fs.readFile(file)).resolves.toEqual(Buffer.from(content));
    await expect(fs.readFile(checkoutFile)).resolves.toEqual(Buffer.from(before));
    await fs.writeFile(file, 'external');
    await expect(r.registry.invoke('fs:writeText', { ...req, expectedContent: content }, 'desktop')).rejects.toThrow(/changed on disk/);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('external');
  });

  it('rejects malformed and out-of-workspace save requests before opening files', async () => {
    const r = await fileResolveRig();
    const file = path.join(r.cwd, 'edit.txt');
    const outside = path.join(r.sibling, 'edit.txt');
    await fs.writeFile(file, 'before');
    await fs.writeFile(outside, 'before');
    await fs.symlink(r.sibling, path.join(r.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const req = { sessionId: 's_test', path: 'edit.txt', content: 'after', expectedContent: 'before' };
    const open = vi.spyOn(fs, 'open');
    for (const invalid of [undefined, null, {}, { ...req, expectedContent: undefined }, { ...req, content: 1 },
      { ...req, root: r.sibling }, { ...req, sessionId: '../s_test' }, { ...req, sessionId: 'missing' },
      { ...req, missionWorkspaceId: 1 }, { ...req, path: 'escape/edit.txt' }, { ...req, path: '../edit.txt' },
      { ...req, path: outside }, { ...req, path: 'edit.txt:stream' }, { ...req, path: 'missing.txt' }]) {
      await expect(r.registry.invoke('fs:writeText', invalid, 'desktop')).rejects.toThrow();
    }
    expect(open).not.toHaveBeenCalled();
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('before');
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('before');
    await expect(fs.stat(path.join(r.cwd, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves an exact file from the session cwd before suffix matches or the configured project root', async () => {
    const r = await fileResolveRig();
    await fs.mkdir(path.join(r.cwd, 'nested'));
    await fs.writeFile(path.join(r.cwd, 'notes.md'), 'current worktree');
    await fs.writeFile(path.join(r.cwd, 'nested', 'notes.md'), 'another suffix match');
    await fs.writeFile(path.join(r.projectRoot, 'notes.md'), 'project checkout');
    await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: 'notes.md' })).resolves.toEqual({ status: 'resolved', path: 'notes.md' });
    await expect(r.registry.invoke('fs:read', { sessionId: 's_test', path: 'notes.md' })).resolves.toEqual({ content: 'current worktree', truncated: false });
  });

  it('resolves unique basenames and component suffixes, never partial directory names or a different suffix', async () => {
    const r = await fileResolveRig();
    await fs.mkdir(path.join(r.cwd, 'src', 'components'), { recursive: true });
    await fs.writeFile(path.join(r.cwd, 'src', 'components', 'Widget.tsx'), 'widget');
    for (const p of ['Widget.tsx', 'components/Widget.tsx']) {
      await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: p })).resolves.toEqual({ status: 'resolved', path: 'src/components/Widget.tsx' });
    }
    for (const p of ['ponents/Widget.tsx', 'other/Widget.tsx', 'Widget.ts', 'absent.tsx']) {
      await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: p })).resolves.toEqual({ status: 'missing' });
    }
  });

  it('returns every ambiguous relative path rather than choosing the first basename match', async () => {
    const r = await fileResolveRig();
    for (const dir of ['a', 'b']) {
      await fs.mkdir(path.join(r.cwd, dir));
      await fs.writeFile(path.join(r.cwd, dir, 'shared.ts'), dir);
    }
    await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: 'shared.ts' })).resolves.toEqual({ status: 'ambiguous', paths: ['a/shared.ts', 'b/shared.ts'] });
    await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: 'b/shared.ts' })).resolves.toEqual({ status: 'resolved', path: 'b/shared.ts' });
  });

  it('never falls back to the project checkout or another session workspace', async () => {
    const r = await fileResolveRig();
    await fs.writeFile(path.join(r.projectRoot, 'project-only.ts'), 'project');
    await fs.mkdir(path.join(r.sibling, 'src'));
    await fs.writeFile(path.join(r.sibling, 'src', 'sibling-only.ts'), 'sibling');
    for (const p of ['project-only.ts', 'sibling-only.ts', 'src/sibling-only.ts']) {
      await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: p })).resolves.toEqual({ status: 'missing' });
    }
    await expect(r.registry.invoke('fs:resolve', { sessionId: 's_sibling', path: 'sibling-only.ts' })).resolves.toEqual({ status: 'resolved', path: 'src/sibling-only.ts' });
  });

  it('skips dependency and generated directories during fallback but permits an exact file there', async () => {
    const r = await fileResolveRig();
    const skipped = ['node_modules', 'dist', 'out', 'build', '.next', '.vocs-code'];
    for (const dir of skipped) {
      await fs.mkdir(path.join(r.cwd, dir));
      await fs.writeFile(path.join(r.cwd, dir, 'generated.ts'), dir);
    }
    await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: 'generated.ts' })).resolves.toEqual({ status: 'missing' });
    for (const dir of skipped) {
      await expect(r.registry.invoke('fs:resolve', { sessionId: 's_test', path: `${dir}/generated.ts` })).resolves.toEqual({ status: 'resolved', path: `${dir}/generated.ts` });
    }
  });

  it('rejects malformed file-resolution requests, unknown sessions, absolute paths and traversal', async () => {
    const { registry } = stubDeps();
    for (const req of [
      undefined, null, {}, { sessionId: 's_test' }, { path: 'a.txt' },
      { sessionId: '', path: 'a.txt' }, { sessionId: '../s_test', path: 'a.txt' }, { sessionId: 1, path: 'a.txt' },
      { sessionId: 's_missing', path: 'a.txt' }, { sessionId: 's_test', path: null }, { sessionId: 's_test', path: 1 },
      { sessionId: 's_test', path: 'a.txt', root: ws }, { sessionId: 's_test', path: 'a.txt', missionWorkspaceId: 1 }
    ]) await expect(registry.invoke('fs:resolve', req)).rejects.toThrow();
    for (const p of ['', '\0', '/etc/passwd', 'C:\\private\\file.txt', 'C:/private/file.txt', '//server/share/file.txt', '\\\\server\\share\\file.txt', '../a.txt', 'sub/../../a.txt', 'sub/../a.txt', '..\\a.txt']) {
      await expect(registry.invoke('fs:resolve', { sessionId: 's_test', path: p })).rejects.toThrow();
    }
  });

  it('delegates desktop affordances and keeps the URL guard on openExternal', async () => {
    const { registry, calls } = stubDeps();
    const info = (await registry.invoke('app:info', undefined)) as { version: string; isPackaged: boolean };
    expect(info.version).toBe('0.0.0-test');
    expect(info.isPackaged).toBe(false);
    await registry.invoke('app:notify', { title: 't', body: 'b' });
    expect(calls).toContain('notify:t');
    await registry.invoke('window:toggleFullScreen', undefined);
    expect(calls).toContain('toggleFullScreen');
    const zoom = (await registry.invoke('window:zoom', { direction: 'in' })) as { zoomFactor: number };
    expect(zoom).toEqual({ zoomFactor: 1 }); // no window -> zoom bridge returns null -> defaults to 1
    await registry.invoke('app:openExternal', { url: 'https://example.com' });
    expect(calls).toContain('openExternal:https://example.com');
    await registry.invoke('app:openExternal', { url: 'file:///etc/passwd' });
    expect(calls).not.toContain('openExternal:file:///etc/passwd');
  });

  it('shows a local file in its folder, even outside the session, and never a network or relative path', async () => {
    const { registry, calls } = stubDeps();
    const elsewhere = tmpDir('elsewhere');
    const bundle = path.join(elsewhere, 'SideGuard-Q-2026-10.zip');
    fsSync.writeFileSync(bundle, 'PK');

    // Transcript links carry forward slashes; the file manager gets the platform's own path.
    await expect(registry.invoke('app:showInFolder', { sessionId: 's_test', path: bundle.replace(/\\/g, '/') })).resolves.toEqual({ ok: true });
    const missing = path.join(elsewhere, 'gone.zip');
    await expect(registry.invoke('app:showInFolder', { sessionId: 's_test', path: missing })).resolves.toEqual({ ok: false, error: `${missing} was not found` });
    // Refused before any stat, so a UNC link cannot make Windows contact the named host.
    for (const refused of ['\\\\attacker\\share\\bundle.zip', '//attacker/share/bundle.zip', '\\\\?\\C:\\bundle.zip', 'relative/bundle.zip', '']) {
      await expect(registry.invoke('app:showInFolder', { sessionId: 's_test', path: refused })).resolves.toEqual({ ok: false, error: 'Only local absolute paths can be shown in their folder' });
    }
    await expect(registry.invoke('app:showInFolder', { sessionId: 's_missing', path: bundle })).resolves.toEqual({ ok: false, error: 'Session not found' });

    expect(calls.filter((c) => c.startsWith('showItemInFolder:'))).toEqual([`showItemInFolder:${bundle}`]);
    expect(calls.some((c) => c.startsWith('openPath:'))).toBe(false);
  });

  it('dispatches session handlers, passively indexes new sessions, and fails unknown sessions', async () => {
    const indexed: unknown[] = [];
    const { registry } = stubDeps({
      gitnexusIndexer: {
        schedule: (request: unknown) => void indexed.push(request),
        index: async () => ({ ok: true })
      }
    });
    const created = (await registry.invoke('sessions:create', {})) as SessionMeta;
    expect(created.id).toBe('s_test');
    expect(indexed).toEqual([{ cwd: ws, projectRoot: ws, reason: 'session-start' }]);
    expect(await registry.invoke('sessions:get', { id: 's_nope' })).toBeNull();
    await expect(registry.invoke('git:summary', { sessionId: 's_nope' })).rejects.toThrow('Session not found');
    // Guided-setup mutations resolve the session's cwd first, so an unknown id can never reach git
    // with a path of the caller's choosing.
    const guided: [string, Record<string, unknown>][] = [
      ['git:setupStatus', {}],
      ['git:init', {}],
      ['git:initialCommit', { message: 'Initial commit' }],
      ['git:setRemote', { url: 'https://github.com/you/project.git' }],
      ['git:push', {}],
      ['git:createGitHubRepo', { name: 'project', private: true }],
      ['git:setIdentity', { name: 'Mona', email: 'mona@example.com', global: false }],
      ['git:githubIdentity', {}]
    ];
    for (const [channel, extra] of guided) {
      await expect(registry.invoke(channel, { sessionId: 's_nope', ...extra })).rejects.toThrow('Session not found');
    }
  });

  it('closes an archived session\'s shells, and only when it is being archived', async () => {
    const order: string[] = [];
    const { registry } = stubDeps({
      terminals: {
        list: () => [],
        closeForSession: async (id: string) => void order.push(`closeForSession:${id}`)
      } as unknown as TerminalManager,
      sessions: {
        list: () => [],
        get: (id: string) => id === 's_test' ? { id, cwd: ws, config: { projectRoot: ws } } as SessionMeta : undefined,
        setArchived: async (...args: unknown[]) => {
          order.push(`setArchived:${args.map(String).join(',')}`);
          return { id: 's_test' } as unknown as SessionMeta;
        }
      } as unknown as SessionManager
    });

    await registry.invoke('sessions:archive', { id: 's_test', archived: true, removeWorktree: true });

    // The shells go down first: one holding the worktree's directory open would block its removal.
    expect(order).toEqual(['closeForSession:s_test', 'setArchived:s_test,true,true,undefined']);

    order.length = 0;
    await registry.invoke('sessions:archive', { id: 's_test', archived: false });

    // Unarchiving starts nothing, so there is nothing to close.
    expect(order).toEqual(['setArchived:s_test,false,undefined,undefined']);
  });

  it('passes the chosen search category and archive filter through to the index', async () => {
    const response = { available: true, results: [] };
    const search = vi.fn<SearchIndex['search']>(() => response);
    const { registry } = stubDeps({ search: { search } as unknown as SearchIndex });
    const request = { q: 'needle', filters: { category: 'transcript', archived: true } };
    expect(await registry.invoke('sessions:search', request)).toEqual(response);
    expect(search).toHaveBeenCalledExactlyOnceWith(request);
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

  it('checks harness updates over a bounded set of ids', async () => {
    const asked: HarnessId[][] = [];
    const { registry, logs } = stubDeps({
      runtime: {
        checkUpdates: async (ids: HarnessId[]) => {
          asked.push(ids);
          return { pi: { package: '@earendil-works/pi-coding-agent', current: '0.85.1', latest: '0.87.1', newer: true, updatable: true } };
        }
      } as unknown as RuntimeResolver
    });
    const updates = (await registry.invoke('harness:checkUpdates', undefined)) as Record<string, { latest?: string }>;
    expect(asked[0]).toEqual(['claude', 'codex', 'pi', 'acp']);
    expect(updates.pi.latest).toBe('0.87.1');
    expect(logs).toContainEqual(['debug', 'harness pi: 0.85.1 installed, 0.87.1 published (update available)']);

    // The card asks for its own three; the handler passes the request through untouched.
    await registry.invoke('harness:checkUpdates', { ids: ['claude', 'codex', 'pi'] });
    expect(asked[1]).toEqual(['claude', 'codex', 'pi']);
  });

  it('records renderer errors in the main log', async () => {
    const { registry, logs } = stubDeps();
    await registry.invoke('app:rendererError', { message: 'TypeError: boom', stack: 'Error: boom\n  at render', source: 'App.tsx:12' });
    const line = logs.find(([level]) => level === 'error');
    expect(line?.[1]).toContain('renderer error at App.tsx:12: TypeError: boom');
    expect(line?.[1]).toContain('at render');
  });
});

describe('mcp handlers', () => {
  it('refuses an unknown session rather than reading an arbitrary path', async () => {
    const { registry } = stubDeps();
    for (const channel of ['mcp:project', 'mcp:project:save', 'mcp:project:state', 'mcp:export'] as const) {
      await expect(registry.invoke(channel, { sessionId: 's_nope', servers: [], patch: {}, to: 'cursor' })).rejects.toThrow('Session not found');
    }
  });

  it('normalizes what the renderer sends before it reaches .mcp.json', async () => {
    const { registry, deps } = stubDeps();
    await deps.settings.load();
    await registry.invoke('mcp:project:save', {
      sessionId: 's_test',
      servers: [
        { id: 'good', transport: 'stdio', command: 'srv', args: ['--x'] },
        { id: 'no-command', transport: 'stdio' },
        { id: 'a/b', transport: 'stdio', command: 'srv' },
        { id: 'bad-url', transport: 'http', url: 'file:///etc/passwd' }
      ] as never
    });
    const raw = JSON.parse(fsSync.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    expect(Object.keys(raw.mcpServers)).toEqual(['good']);
    const info = (await registry.invoke('mcp:project', { sessionId: 's_test' })) as {
      repo: { id: string }[];
      effective: { def: { id: string }; enabled: boolean; reason?: string; scope: string }[];
    };
    expect(info.repo.map((s) => s.id)).toEqual(['good']);
    // Written, but inert: nothing the repo defines is active until the user enables it for this repo.
    expect(info.effective.find((e) => e.def.id === 'good')).toEqual({ def: expect.objectContaining({ id: 'good' }), scope: 'repo', enabled: false, reason: 'not-enabled' });
    // GitNexus ships built in and is offered to an inject harness by default.
    expect(info.effective[0]).toMatchObject({ scope: 'builtin', enabled: true, def: expect.objectContaining({ id: 'gitnexus' }) });
  });

  it('keeps the per-repo trust switch in settings, keyed by project root', async () => {
    const { registry, deps } = stubDeps();
    await deps.settings.load();
    await registry.invoke('mcp:project:save', { sessionId: 's_test', servers: [{ id: 'db', transport: 'stdio', command: 'srv' }] });
    const after = (await registry.invoke('mcp:project:state', { sessionId: 's_test', patch: { enabledRepo: ['db'] } })) as { effective: { enabled: boolean }[] };
    expect(after.effective.some((e) => e.enabled)).toBe(true);
    expect(deps.settings.get().mcpProjectState?.[ws]).toEqual({ enabledRepo: ['db'] });
  });

  it('delegates the explicit GitNexus index action through the serialized indexer', async () => {
    const requests: unknown[] = [];
    const { registry } = stubDeps({
      gitnexusIndexer: {
        schedule: () => undefined,
        index: async (request: unknown) => {
          requests.push(request);
          return { ok: true, output: 'fresh' };
        }
      }
    });

    await expect(registry.invoke('mcp:project:index', { sessionId: 's_test' })).resolves.toEqual({ ok: true, output: 'fresh' });
    expect(requests).toEqual([{ cwd: ws, projectRoot: ws, reason: 'manual' }]);
  });

  it('rejects an incomplete definition on inspect instead of spawning anything', async () => {
    const { registry } = stubDeps();
    const r = (await registry.invoke('mcp:inspect', { def: { id: 'x', transport: 'stdio' } as never })) as { ok: boolean; error?: string };
    expect(r).toEqual({ ok: false, error: 'Incomplete server definition', tools: [], durationMs: 0 });
  });
});

describe('pi config handlers', () => {
  /** A store scoped to a temp agent dir so no handler can reach the real ~/.pi/agent. */
  function piDeps(): { agentDir: string } & ReturnType<typeof stubDeps> {
    const agentDir = tmpDir('pi-agent');
    fsSync.mkdirSync(path.join(agentDir, 'skills', 'demo'), { recursive: true });
    fsSync.writeFileSync(path.join(agentDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n', 'utf8');
    fsSync.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
    const stub = stubDeps({ piConfig: new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir }, home: agentDir }) });
    return { agentDir, ...stub };
  }

  it('serves the setup for the configured agent dir', async () => {
    const { agentDir, registry } = piDeps();
    const setup = (await registry.invoke('pi:setup', undefined)) as { agentDir: string; resources: { name: string }[] };
    expect(setup.agentDir).toBe(path.resolve(agentDir));
    expect(setup.resources.map((r) => r.name)).toContain('demo');
  });

  it('refuses a resource path outside the agent dir without writing settings.json', async () => {
    const { agentDir, registry } = piDeps();
    await expect(registry.invoke('pi:resource', { type: 'skills', path: path.join(agentDir, '..', 'evil'), enabled: false })).rejects.toThrow('Not a resource');
    expect(JSON.parse(fsSync.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('never reveals a path outside the agent dir', async () => {
    const { agentDir, registry, calls } = piDeps();
    await registry.invoke('pi:reveal', { path: path.join(agentDir, '..', 'evil') });
    expect(calls).not.toContain(`openPath:${path.join(agentDir, '..', 'evil')}`);
    await registry.invoke('pi:reveal', {});
    expect(calls).toContain(`openPath:${path.resolve(agentDir)}`);
  });

  it('rejects an editor target outside the agent dir and unknown prompt names', async () => {
    const { agentDir, registry } = piDeps();
    const r = (await registry.invoke('pi:openInEditor', { path: path.join(agentDir, '..', 'secret.txt') })) as { ok: boolean; error?: string };
    expect(r).toEqual({ ok: false, error: 'Path is outside the pi agent dir' });
    await expect(registry.invoke('pi:prompt:write', { name: 'NOTES.md' as never, content: 'x' })).rejects.toThrow('Unknown prompt file');
  });

  it('runs package commands through the injected runner and rejects bad sources before it', async () => {
    const calls: string[][] = [];
    const agentDir = tmpDir('pi-agent');
    fsSync.writeFileSync(path.join(agentDir, 'settings.json'), '{}', 'utf8');
    const store = new PiConfigStore({
      env: { PI_CODING_AGENT_DIR: agentDir },
      home: agentDir,
      runPi: async (args) => {
        calls.push(args);
        return { ok: true, code: 0, log: 'ok' };
      }
    });
    const { registry } = stubDeps({ piConfig: store });
    await registry.invoke('pi:package:install', { source: 'git:github.com/user/repo' });
    await registry.invoke('pi:package:remove', { source: 'npm:foo' });
    await registry.invoke('pi:package:update', {});
    expect(calls).toEqual([
      ['install', 'git:github.com/user/repo'],
      ['remove', 'npm:foo'],
      ['update', '--extensions']
    ]);
    await expect(registry.invoke('pi:package:install', { source: '-l' })).rejects.toThrow('Invalid package source');
    expect(calls).toHaveLength(3);
  });

  it('rejects an invalid subagents patch without writing the file', async () => {
    const agentDir = tmpDir('pi-agent');
    fsSync.writeFileSync(path.join(agentDir, 'settings.json'), '{}', 'utf8');
    const store = new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir }, home: agentDir });
    const { registry } = stubDeps({ piConfig: store });
    await expect(registry.invoke('pi:subagents', { maxSubagentDepth: 99 })).rejects.toThrow('Invalid value');
    await expect(fs.access(path.join(agentDir, 'subagents.json'))).rejects.toThrow();
  });
});

describe('vesta handlers', () => {
  /** pi resolution is stubbed absent so a send records the user row and then the setup error. */
  const noPi = () =>
    ({
      availability: async () => ({ available: true }),
      install: async () => ({ ok: false, log: '' }),
      resolve: () => null,
      resource: () => ''
    }) as unknown as RuntimeResolver;

  const agentPushes = (pushes: [string, unknown][]) => pushes.filter(([channel]) => channel === PUSH_CHANNELS.agentState).map(([, payload]) => payload) as { items: { kind: string; text: string; images?: unknown }[] }[];

  it('drops malformed image attachments at the boundary instead of sending an empty message', async () => {
    const { registry, deps, pushes } = stubDeps({ runtime: noPi() });
    await deps.settings.load();
    await registry.invoke('agent:send', {
      text: '',
      images: [
        { mimeType: 'text/plain', data: 'bm90IGFuIGltYWdl' },
        { mimeType: 'image/png', data: '' }
      ] as never
    });
    expect(agentPushes(pushes)).toEqual([]);
  });

  it('keeps a valid pasted image on the user row so the model and the panel both get it', async () => {
    const { registry, deps, pushes } = stubDeps({ runtime: noPi() });
    await deps.settings.load();
    await registry.invoke('agent:send', { text: '', images: [{ mimeType: 'image/png', data: 'iVBORw==' }] as never });
    const states = agentPushes(pushes);
    const user = states.at(-1)?.items.find((item) => item.kind === 'user');
    expect(user).toMatchObject({ text: '', images: [{ mimeType: 'image/png', data: 'iVBORw==' }] });
    expect(states.at(-1)?.items.some((item) => item.kind === 'error')).toBe(true);
  });
});

describe('remote handlers', () => {
  afterEach(() => vi.unstubAllEnvs());

  /** The registered remote:* handlers with the privileged pieces mocked: the host records what it
   *  was asked to connect to, the secret store what it was asked to keep. */
  function remoteRig(registered = false) {
    const enabled: [string, string][] = [];
    const saved = new Map<string, string>();
    const remote = {
      state: () => ({ status: 'off' }),
      listDevices: async () => [],
      auditEntries: () => [],
      isRegistered: async () => registered,
      enable: async (url: string, token: string) => void enabled.push([url, token]),
      disable: async () => undefined
    } as unknown as RemoteHost;
    const secrets = {
      has: () => false,
      get: async (id: string) => saved.get(id),
      set: async (id: string, value: string) => void saved.set(id, value),
      clear: async () => undefined
    } as unknown as SecretStore;
    return { enabled, saved, ...stubDeps({ remote, secrets }) };
  }

  it('persists analytics sharing and tells the uploader, keeping the rest of the remote config', async () => {
    const changed: Array<boolean | undefined> = [];
    const { registry, deps, pushes } = remoteRig();
    deps.analyticsSync = { sharingChanged: async () => void changed.push(deps.settings.get().remote?.shareAnalytics) };
    await deps.settings.update({ remote: { enabled: true, viewOnly: true } });
    await registry.invoke('remote:setShareAnalytics', { share: false });
    expect(deps.settings.get().remote).toEqual({ enabled: true, viewOnly: true, shareAnalytics: false });
    await registry.invoke('remote:setShareAnalytics', { share: true });
    expect(deps.settings.get().remote?.shareAnalytics).toBe(true);
    // The uploader runs after the setting is saved, so it reads the new value.
    expect(changed).toEqual([false, true]);
    expect(pushes.filter(([channel]) => channel === 'push:settingsChanged')).toHaveLength(2);
  });

  it('refuses an insecure relay override before settings, secret writes, or host dispatch', async () => {
    vi.stubEnv('VOCS_CODE_RELAY_URL', 'http://user:password@192.168.1.2/?token=hidden');
    const { registry, deps, enabled, saved, pushes } = remoteRig();
    const update = vi.spyOn(deps.settings, 'update');
    for (const [channel, input] of [['remote:enable', { enrollToken: 'private' }], ['remote:signIn', undefined]] as const) {
      await expect(registry.invoke(channel, input)).rejects.toThrow(/HTTPS/);
    }
    expect(update).not.toHaveBeenCalled(); expect(enabled).toEqual([]); expect(saved.size).toBe(0); expect(pushes).toEqual([]);
  });

  it('connects to code.vocs.io with only the enrollment secret, dropping a relay URL an older build stored', async () => {
    vi.stubEnv('VOCS_CODE_RELAY_URL', undefined);
    const { registry, deps, enabled, saved } = remoteRig();
    await deps.settings.update({ remote: { enabled: false, viewOnly: true, relayUrl: 'https://old-relay.workers.dev' } as RemoteConfig });
    expect(((await registry.invoke('remote:get', undefined)) as { relayUrl: string }).relayUrl).toBe('https://code.vocs.io');

    await registry.invoke('remote:enable', { enrollToken: 'enroll-secret' });
    expect(enabled).toEqual([['https://code.vocs.io', 'enroll-secret']]);
    expect(saved.get('remote-enroll')).toBe('enroll-secret');
    // The view-only policy survives; the typed-in relay of an older build does not.
    expect(deps.settings.get().remote).toEqual({ enabled: true, viewOnly: true });
  });

  it('connects a registered computer without asking for the secret again', async () => {
    vi.stubEnv('VOCS_CODE_RELAY_URL', undefined);
    const { registry, enabled, saved } = remoteRig(true);
    saved.set('remote-enroll', 'first-time-secret');
    expect(((await registry.invoke('remote:get', undefined)) as { registered: boolean }).registered).toBe(true);
    // An empty field neither overwrites the stored secret nor blocks the connection.
    await registry.invoke('remote:enable', {});
    await registry.invoke('remote:enable', { enrollToken: '   ' });
    expect(enabled).toEqual([['https://code.vocs.io', 'first-time-secret'], ['https://code.vocs.io', 'first-time-secret']]);
    expect(saved.get('remote-enroll')).toBe('first-time-secret');
  });

  it('points a development build at another relay through VOCS_CODE_RELAY_URL', async () => {
    vi.stubEnv('VOCS_CODE_RELAY_URL', 'http://127.0.0.1:8787/');
    const { registry, enabled } = remoteRig();
    expect(((await registry.invoke('remote:get', undefined)) as { relayUrl: string }).relayUrl).toBe('http://127.0.0.1:8787');
    await registry.invoke('remote:enable', { enrollToken: 'enroll-secret' });
    expect(enabled).toEqual([['http://127.0.0.1:8787', 'enroll-secret']]);
  });
});

describe('external control owner boundary', () => {
  it('refuses browser/default and agent origins before any owner service call', async () => {
    const ownerState = vi.fn(async () => ({ enabled: false }));
    const setEnabled = vi.fn();
    const grant = vi.fn();
    const revoke = vi.fn();
    const { registry } = stubDeps({ control: { ownerState, setEnabled, grant, revoke } as unknown as NonNullable<Deps['control']> });
    for (const actor of [undefined, 'user', 'agent'] as const) {
      await expect(registry.invoke('control:get', undefined, actor)).rejects.toThrow('local desktop owner');
      await expect(registry.invoke('control:enable', { enabled: true }, actor)).rejects.toThrow('local desktop owner');
      await expect(registry.invoke('control:grant', {}, actor)).rejects.toThrow('local desktop owner');
    }
    expect(ownerState).not.toHaveBeenCalled();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    await expect(registry.invoke('control:get', undefined, 'desktop')).resolves.toEqual({ enabled: false });
    expect(ownerState).toHaveBeenCalledTimes(1);
    await expect(registry.invoke('control:enable', { enabled: 'yes' }, 'desktop')).rejects.toBeDefined();
    await expect(registry.invoke('control:grant', { controllerId: '../escape' }, 'desktop')).rejects.toBeDefined();
    await expect(registry.invoke('control:revoke', { grantId: '../escape' }, 'desktop')).rejects.toBeDefined();
    expect(setEnabled).not.toHaveBeenCalled(); expect(grant).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
    for (const channel of ['control:get', 'control:enable', 'control:grant', 'control:revoke']) expect(isRemoteChannel(channel)).toBe(false);
  });

  it('checks project and session ownership for control without starting Git status refreshes', async () => {
    const root = tmpDir('control-resource');
    const { registry, deps } = stubDeps();
    deps.sessions.get('s_test')!.cwd = root;
    const list = vi.spyOn(deps.sessions, 'list');
    await registry.assertControlResource!({ projectRoot: root });
    await registry.assertControlResource!({ sessionId: 's_test' });
    expect(list.mock.calls).toEqual([[{ refreshGit: false }], [{ refreshGit: false }]]);
  });

  it('does not route local grant setup through browser access or an agent', async () => {
    const state = { supported: true, projects: [], approvedProjectIds: [], target: null };
    const ownerState = vi.fn(async () => state), enable = vi.fn(async () => state), disable = vi.fn(async () => state);
    const { registry } = stubDeps({ localControl: { ownerState, enable, disable } });
    for (const channel of ['control:local:get', 'control:local:enable', 'control:local:disable']) {
      expect(isRemoteChannel(channel)).toBe(false);
      for (const actor of [undefined, 'user', 'agent'] as const) {
        await expect(registry.invoke(channel, { actor: 'desktop', projectIds: ['some-project'] }, actor)).rejects.toThrow('local desktop owner');
      }
    }
    expect(ownerState).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    await expect(registry.invoke('control:local:get', undefined, 'desktop')).resolves.toEqual(state);
    expect(ownerState).toHaveBeenCalledTimes(1);
  });
});

describe('remote sign-in handlers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('opens the relay page through the desktop bridge and marks remote access enabled', async () => {
    vi.stubEnv('VOCS_CODE_RELAY_URL', undefined);
    const signedIn: string[] = [];
    const remote = {
      state: () => ({ status: 'connecting', onlineClients: [], viewOnly: false }),
      listDevices: async () => [],
      auditEntries: () => [],
      isRegistered: async () => false,
      signIn: async (url: string, open: (link: string) => Promise<void>) => {
        signedIn.push(url);
        await open(`${url}/app?connect=${'ab'.repeat(32)}`);
      },
      disable: async () => undefined
    } as unknown as RemoteHost;
    const { registry, deps, calls, pushes } = stubDeps({ remote });
    await registry.invoke('remote:signIn', undefined);
    expect(signedIn).toEqual(['https://code.vocs.io']);
    expect(calls).toContain(`openExternal:https://code.vocs.io/app?connect=${'ab'.repeat(32)}`);
    expect(deps.settings.get().remote?.enabled).toBe(true);
    expect(pushes.some(([channel]) => channel === PUSH_CHANNELS.settingsChanged)).toBe(true);
  });

  it('offers sign-in only where the relay origin answers /v1/me like a login gate, without blocking', async () => {
    const answers: Record<string, number> = { 'http://127.0.0.1:9911': 401, 'http://127.0.0.1:9912': 404, 'http://127.0.0.1:9913': 503 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ status: answers[new URL(url).origin] ?? 500 })));
    const remote = { state: () => ({ status: 'off', onlineClients: [], viewOnly: false }), listDevices: async () => [], auditEntries: () => [], isRegistered: async () => false } as unknown as RemoteHost;
    const { registry } = stubDeps({ remote });
    for (const [relay, expected] of [['http://127.0.0.1:9911', true], ['http://127.0.0.1:9912', false], ['http://127.0.0.1:9913', false]] as const) {
      vi.stubEnv('VOCS_CODE_RELAY_URL', relay);
      // The first answer never waits for the network: until the probe lands it is false.
      expect(((await registry.invoke('remote:get', undefined)) as { signInAvailable: boolean }).signInAvailable).toBe(false);
      await signInProbe(relay);
      expect(((await registry.invoke('remote:get', undefined)) as { signInAvailable: boolean }).signInAvailable).toBe(expected);
    }
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:9911/v1/me', 'http://127.0.0.1:9912/v1/me', 'http://127.0.0.1:9913/v1/me']);
  });
});

describe('harness:models catalog cache', () => {
  const opus = { id: 'claude-opus-5-5', provider: 'anthropic', displayName: 'Opus 5.5' };
  const sonnet = { id: 'claude-sonnet-5-5', provider: 'anthropic', displayName: 'Sonnet 5.5' };
  const rig = (userData: string) => {
    const { bridge } = bridgeStub();
    return stubDeps({ desktop: { ...bridge, userDataPath: () => userData } });
  };
  const ids = (r: unknown) => (r as { models: { id: string }[] }).models.map((m) => m.id);

  it('reuses a clean catalog across dialog opens and restarts, and rediscovers only on an explicit refresh', async () => {
    const discover = vi.mocked(listHarnessModels).mockReset().mockResolvedValue({ models: [opus] });
    const userData = tmpDir('models');
    const { registry } = rig(userData);
    expect(ids(await registry.invoke('harness:models', { harness: 'claude', projectRoot: 'G:/a' }))).toEqual(['claude-opus-5-5']);
    expect(ids(await registry.invoke('harness:models', { harness: 'claude', projectRoot: 'G:/b' }))).toEqual(['claude-opus-5-5']);
    expect(discover).toHaveBeenCalledTimes(1);

    // A restarted app reads the catalog back from userData instead of spawning the CLI again.
    expect(ids(await rig(userData).registry.invoke('harness:models', { harness: 'claude' }))).toEqual(['claude-opus-5-5']);
    expect(discover).toHaveBeenCalledTimes(1);

    discover.mockResolvedValue({ models: [opus, sonnet] });
    expect(ids(await registry.invoke('harness:models', { harness: 'claude', refresh: true }))).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(ids(await registry.invoke('harness:models', { harness: 'claude' }))).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(discover).toHaveBeenCalledTimes(2);
    // Each harness has its own entry.
    await registry.invoke('harness:models', { harness: 'pi' });
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it('never caches a failed discovery, and a key, sign-in or catalog-settings change rediscovers', async () => {
    const discover = vi.mocked(listHarnessModels).mockReset().mockResolvedValue({ models: [opus], error: 'Claude model discovery failed; showing the saved catalog.' });
    const { registry, deps } = rig(tmpDir('models'));
    await registry.invoke('harness:models', { harness: 'claude' });
    await registry.invoke('harness:models', { harness: 'claude' });
    expect(discover).toHaveBeenCalledTimes(2);

    discover.mockResolvedValue({ models: [opus] });
    await registry.invoke('harness:models', { harness: 'claude' });
    await registry.invoke('harness:models', { harness: 'claude' });
    expect(discover).toHaveBeenCalledTimes(3);

    await registry.invoke('secrets:set', { providerId: 'testprov', apiKey: 'sk-new' });
    await registry.invoke('harness:models', { harness: 'claude' });
    expect(discover).toHaveBeenCalledTimes(4);

    vi.mocked(openHarnessLogin).mockReset().mockResolvedValue({ ok: true });
    await registry.invoke('harness:login', { harness: 'claude' }, 'desktop');
    await registry.invoke('harness:models', { harness: 'claude' });
    expect(discover).toHaveBeenCalledTimes(5);

    await deps.settings.update({ modelOverrides: { 'anthropic::claude-opus-5-5': { supportsImages: true } } });
    await registry.invoke('harness:models', { harness: 'claude' });
    expect(discover).toHaveBeenCalledTimes(6);

    for (const harness of ['__proto__', 'unknown', 1]) await expect(registry.invoke('harness:models', { harness })).rejects.toThrow();
    expect(discover).toHaveBeenCalledTimes(6);
  });
});
