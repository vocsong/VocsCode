import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectInfo, resolveForSession, toCodex, type McpHostDeps, type SessionScope } from '../src/main/mcp';
import { defaultSettings } from '../src/main/settings';
import { resolveIntelligenceSettings } from '../src/shared/intelligence';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vocs-mcp-memory-'));
  dirs.push(dir);
  const settings = defaultSettings();
  settings.mcpDisabledBuiltins = ['gitnexus', 'cua-driver'];
  const scope: SessionScope = { settings, cwd: dir, projectRoot: dir, harness: 'codex-exec', sessionId: 's_current' };
  const token = 'test-gateway-capability';
  const url = 'http://127.0.0.1:23456/call';
  const attach = vi.fn(() => ({ url, token }));
  const deps: McpHostDeps = { getSecret: async () => undefined, memoryServerPath: '/vocs-memory.mjs', memoryUserData: '/private-profile', memoryGateway: attach };
  return { scope, deps, token, url, attach };
}

describe('memory MCP resolver', () => {
  it('materializes scoped recall without a wiki and never puts the token in Codex exec argv', async () => {
    const { scope, deps, token, url, attach } = await fixture();
    const out = await resolveForSession(scope, deps);
    expect(attach).toHaveBeenCalledExactlyOnceWith('s_current');
    expect(out).toHaveLength(1);
    expect(out[0].def.id).toBe('vocs-memory');
    expect(out[0].def.env).toMatchObject({ VOCS_MEMORY_GATEWAY_URL: url, VOCS_MEMORY_GATEWAY_TOKEN: token });
    expect(Object.keys(out[0].def.env!).filter((key) => key.startsWith('VOCS_MEMORY_')).sort()).toEqual(['VOCS_MEMORY_GATEWAY_TOKEN', 'VOCS_MEMORY_GATEWAY_URL']);
    const codex = toCodex(out, 'env-ref');
    expect(JSON.stringify(codex.config)).not.toContain(token);
    expect(Object.values(codex.env)).toContain(token);
    const display = await projectInfo(scope);
    expect(display.builtin.find((entry) => entry.def.id === 'vocs-memory')).toMatchObject({ enabled: true });
    expect(JSON.stringify(display)).not.toContain(token);
  });

  it('fails closed, permits legacy only when opted out, and keeps Mission sessions out of both', async () => {
    const { scope, deps, attach } = await fixture();
    await mkdir(path.join(scope.projectRoot, '.vocs-code', 'wiki'), { recursive: true });
    expect(await resolveForSession(scope, { ...deps, memoryGateway: () => null })).toEqual([]);
    expect(await resolveForSession({ ...scope, sessionId: undefined }, deps)).toEqual([]);
    expect(await resolveForSession({ ...scope, managed: true }, deps)).toEqual([]);
    scope.settings.intelligence = { ...resolveIntelligenceSettings(undefined), gateway: false };
    expect(await resolveForSession({ ...scope, managed: true }, deps)).toEqual([]);
    const out = await resolveForSession(scope, deps);
    expect(out).toHaveLength(1);
    expect(out[0].def.env).toMatchObject({ VOCS_MEMORY_PROJECT_ROOT: scope.projectRoot });
    expect(out[0].def.env).not.toHaveProperty('VOCS_MEMORY_GATEWAY_TOKEN');
    expect(attach).not.toHaveBeenCalled();
  });
});
