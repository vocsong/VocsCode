import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../src/main/harness/codex-app-server';
import { claudeProviderEnv, resolveClaudeProviderEnv } from '../src/main/harness/claude';
import { spawnTool } from '../src/main/harness/spawn';
import type { HarnessContext } from '../src/main/harness/types';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import type { ProviderConfig, SessionMeta } from '../src/shared/types';

vi.mock('../src/main/harness/spawn', () => ({ spawnTool: vi.fn(), shutdownChild: vi.fn(), killTree: vi.fn(), quoteWin: (x: string) => x, usesWindowsCommandShim: () => false }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
const provider: ProviderConfig = { id: 'gateway', kind: 'anthropic', name: 'Gateway', baseUrl: 'http://192.168.1.2/v1', hasApiKey: true, enabled: true, models: [] };

describe('configured external harness transport', () => {
  it('refuses Claude routing before reading an app key or building a credential env overlay', async () => {
    const key = vi.fn(async () => 'private');
    await expect(resolveClaudeProviderEnv(defaultSettings(), provider, key)).rejects.toThrow(/HTTPS/);
    expect(key).not.toHaveBeenCalled();
    expect(() => claudeProviderEnv(defaultSettings(), provider, 'private')).toThrow(/HTTPS/);
    expect(spawnTool).not.toHaveBeenCalled();
  });
  it('refuses inherited insecure Anthropic routing before injecting an app-managed key', async () => {
    const settings = defaultSettings(); settings.claude.useProviderKey = true;
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://192.168.1.2');
    const key = vi.fn(async () => 'private');
    await expect(resolveClaudeProviderEnv(settings, settings.providers.find((p) => p.id === 'anthropic'), key)).rejects.toThrow(/HTTPS/);
    expect(key).not.toHaveBeenCalled();
  });
  it.each([false, true])('refuses Codex configured routing (explicit override: %s) before secrets, runtime resolution, logging or spawn', async (explicit) => {
    const settings = defaultSettings(); settings.providers.push({ ...provider, kind: 'openai-compatible' });
    const meta: SessionMeta = { id: 's_endpoint', title: 'Endpoint', createdAt: 1, updatedAt: 1, cwd: '.', status: 'idle', usage: emptyUsage(), harnessRef: {}, config: { harness: 'codex', projectRoot: '.', permissionMode: 'ask', model: { provider: 'gateway', model: 'model' }, ...(explicit ? { codexModelProvider: { id: 'gateway', name: 'Gateway', baseUrl: provider.baseUrl! } } : {}) } };
    const key = vi.fn(), resolve = vi.fn(), log = vi.fn();
    const ctx = { session: () => meta, settings: () => settings, getApiKey: key, runtime: { resolve }, log } as unknown as HarnessContext;
    await expect(new CodexAppServerAdapter(ctx).start()).rejects.toThrow(/HTTPS/);
    expect(key).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(spawnTool).not.toHaveBeenCalled();
  });
});
