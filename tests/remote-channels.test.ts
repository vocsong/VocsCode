/** The remote channel manifest (src/shared/remote-channels.ts): a paired browser's reach is
 *  default-deny, so every channel the manifest admits must be one the handler registry actually
 *  serves — a typo would otherwise fail at runtime, on a phone, long after pairing. The same
 *  manifest bounds a response before the relay silently drops it. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createHandlerRegistry, type DesktopBridge, type HandlerDeps } from '../src/main/handlers';
import { SettingsStore } from '../src/main/settings';
import type { AnalyticsStore } from '../src/main/analytics';
import type { RuntimeResolver } from '../src/main/runtime';
import type { SearchIndex } from '../src/main/search';
import type { SecretStore } from '../src/main/secrets';
import type { SessionManager } from '../src/main/session-manager';
import type { TerminalManager } from '../src/main/terminal';
import { MAX_WS_FRAME_BYTES } from '../relay/src/hub';
import { REMOTE_CHANNELS, REMOTE_FRAME_MAX_BYTES } from '../src/shared/remote-channels';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `vocs-remote-channels-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) fsSync.rmSync(dir, { recursive: true, force: true });
});

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

/** The suite reads `channels()` and nothing else, so the deps only need to exist. */
function stubRegistry() {
  const workspace = tmpDir('ws');
  const desktop: DesktopBridge = {
    appVersion: () => '0.0.0-test',
    isPackaged: () => false,
    userDataPath: () => workspace,
    documentsPath: () => workspace,
    electronVersion: () => 'unknown',
    openExternal: async () => undefined,
    openPath: async () => undefined,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    notify: async () => undefined,
    toggleFullScreen: () => undefined,
    reload: () => undefined,
    toggleDevTools: () => undefined,
    zoom: () => null,
    edit: () => undefined
  };
  const deps: HandlerDeps = {
    settings: new SettingsStore(tmpDir('settings')),
    secrets: { has: () => false, get: async () => undefined, set: async () => undefined, clear: async () => undefined } as unknown as SecretStore,
    sessions: { list: () => [], get: () => null } as unknown as SessionManager,
    terminals: { list: () => [] } as unknown as TerminalManager,
    runtime: { availability: async () => ({ available: false }) } as unknown as RuntimeResolver,
    analytics: { summary: async () => ({ totals: ZERO_USAGE, speed: null, days: [] }), noteHarnessVersion: () => undefined } as unknown as AnalyticsStore,
    search: { search: async () => ({ items: [], total: 0 }) } as unknown as SearchIndex,
    log: () => undefined,
    push: () => undefined,
    desktop
  };
  return createHandlerRegistry(deps);
}

describe('remote channel manifest', () => {
  it('registers every channel a paired browser may invoke', () => {
    const registered = new Set<string>(stubRegistry().channels());
    for (const channel of REMOTE_CHANNELS) {
      expect(registered.has(channel), `${channel} is remote but no handler serves it`).toBe(true);
    }
  });

  it('keeps the frame budget equal to the largest frame the relay forwards', () => {
    // The relay drops anything larger without telling either side, so the desktop refuses an
    // oversized response itself instead of leaving the client to time out.
    expect(REMOTE_FRAME_MAX_BYTES).toBe(MAX_WS_FRAME_BYTES);
  });
});
