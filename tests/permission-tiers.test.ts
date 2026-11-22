/**
 * Vocs Code permission tiers: a harness only ever runs a tier it offers. Explicit choices it does
 * not offer are refused, and inherited ones (saved defaults, forks, sessions saved before the rule)
 * run the closest stricter tier — never a looser one. Cursor and Codex exec cannot ask, so an Ask
 * session there used to run Cursor with its sandbox off.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { HarnessId, PermissionMode, SessionMeta, UserInput } from '../src/shared/types';
import { HARNESSES, PERMISSION_MODE_LABELS, PERMISSION_TIER_ORDER, assertPermissionModeOffered, closestPermissionMode, permissionModeHint } from '../src/shared/harness-meta';
import { BUILTIN_READ_ONLY_TOOLS, isBuiltinReadOnlyMcpName, isBuiltinReadOnlyTool } from '../src/shared/builtin-tools';
import { MCP_BUILTIN_IDS } from '../src/shared/types';
import { permissionOptions } from '../src/renderer/src/session-controls';
import { resolveNewSessionDefaults } from '../src/shared/session-defaults';
import { emptyUsage } from '../src/main/models/static-models';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';

const mocks = vi.hoisted(() => ({
  contexts: new Map<string, HarnessContext>(),
  modeCalls: [] as { id: string; mode: string }[],
  sent: [] as { harness: string; input: unknown }[]
}));

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: HarnessId, ctx: HarnessContext) => {
    mocks.contexts.set(ctx.sessionId, ctx);
    return {
      id,
      get busy() {
        return false;
      },
      start: async () => undefined,
      send: async (input: UserInput) => {
        mocks.sent.push({ harness: id, input });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async (mode: string) => {
        mocks.modeCalls.push({ id: ctx.sessionId, mode });
      },
      dispose: async () => undefined
    } as unknown as HarnessAdapter;
  }
}));

let tmpRoot = '';
let counter = 0;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-permission-tiers-'));
});
afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});
beforeEach(() => {
  mocks.contexts.clear();
  mocks.modeCalls.length = 0;
  mocks.sent.length = 0;
});

async function makeManager(seed: SessionMeta[] = []): Promise<{ manager: SessionManager; store: SessionStore }> {
  const store = new SessionStore(path.join(tmpRoot, `store${++counter}`));
  await store.load();
  for (const meta of seed) await store.upsert(meta);
  const settings = { ...defaultSettings(), providers: [] };
  const deps: SessionManagerDeps = {
    store,
    settings: { get: () => settings, update: vi.fn(async () => settings) } as never,
    runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => undefined,
    pushEvent: vi.fn(),
    pushSessions: vi.fn(),
    notify: vi.fn(),
    log: vi.fn()
  };
  return { manager: new SessionManager(deps), store };
}

function persisted(id: string, harness: HarnessId, permissionMode: PermissionMode): SessionMeta {
  return {
    id,
    title: 'Persisted session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    config: { harness, projectRoot: tmpRoot, permissionMode },
    cwd: tmpRoot,
    status: 'idle',
    harnessRef: {},
    usage: emptyUsage()
  };
}

describe('closest permission tier', () => {
  it('keeps an offered tier and otherwise falls to the nearest stricter one on every harness', () => {
    for (const h of HARNESSES) {
      for (const mode of PERMISSION_TIER_ORDER) {
        const run = closestPermissionMode(h.id, mode);
        expect(h.capabilities.permissionModes).toContain(run);
        if (h.capabilities.permissionModes.includes(mode)) expect(run).toBe(mode);
        else expect(PERMISSION_TIER_ORDER.indexOf(run)).toBeLessThan(PERMISSION_TIER_ORDER.indexOf(mode));
      }
    }
    expect(['ask', 'accept-edits', 'auto', 'full-auto'].map((m) => closestPermissionMode('cursor', m as PermissionMode))).toEqual(['plan', 'plan', 'auto', 'full-auto']);
    expect(closestPermissionMode('codex-exec', 'accept-edits')).toBe('plan');
  });

  it('refuses tiers a harness does not offer and values that are not tiers', () => {
    expect(() => assertPermissionModeOffered('cursor', 'ask')).toThrow('Cursor does not offer that permission mode. Choose one of: Plan mode, Auto, Full access.');
    expect(() => assertPermissionModeOffered('claude', 'yolo')).toThrow('does not offer that permission mode');
    expect(() => assertPermissionModeOffered('codex-exec', 'auto')).not.toThrow();
  });

  it('resolves saved defaults to a tier the default harness offers', () => {
    const settings = { ...defaultSettings(), defaultHarness: 'cursor' as const, defaultPermissionMode: 'ask' as const };
    expect(resolveNewSessionDefaults(settings, null).permissionMode).toBe('plan');
    const antigravity = { ...defaultSettings(), defaultHarness: 'antigravity' as const, defaultPermissionMode: 'auto' as const };
    expect(resolveNewSessionDefaults(antigravity, null).permissionMode).toBe('auto');
  });
});

describe('session manager permission tiers', () => {
  it('refuses to create a Cursor or Codex exec session in a tier it cannot ask in', async () => {
    const { manager } = await makeManager();
    for (const harness of ['cursor', 'codex-exec'] as const) {
      for (const permissionMode of ['ask', 'accept-edits'] as const) {
        await expect(manager.create({ config: { harness, projectRoot: tmpRoot, permissionMode } } as never)).rejects.toThrow('does not offer that permission mode');
      }
    }
    expect(manager.list()).toEqual([]);
    expect(mocks.contexts.size).toBe(0);
    const ok = await manager.create({ config: { harness: 'cursor', projectRoot: tmpRoot, permissionMode: 'auto' } } as never);
    expect(ok.config.permissionMode).toBe('auto');
  });

  it('refuses to switch a session to a tier its harness does not offer', async () => {
    const { manager } = await makeManager([persisted('s_cursor', 'cursor', 'auto')]);
    await expect(manager.setPermissionMode('s_cursor', 'ask')).rejects.toThrow('does not offer that permission mode');
    expect(manager.get('s_cursor')?.config.permissionMode).toBe('auto');
    expect(mocks.modeCalls).toEqual([]);
    expect((await manager.setPermissionMode('s_cursor', 'plan')).config.permissionMode).toBe('plan');
  });

  it('runs a session saved with an unoffered tier in the closest stricter one', async () => {
    const { manager } = await makeManager([persisted('s_cursor', 'cursor', 'ask'), persisted('s_exec', 'codex-exec', 'accept-edits')]);
    await manager.send('s_cursor', { text: 'continue' });
    await manager.send('s_exec', { text: 'continue' });
    expect(mocks.sent.map((s) => s.harness)).toEqual(['cursor', 'codex-exec']);
    expect(mocks.contexts.get('s_cursor')?.permissionMode()).toBe('plan');
    expect(mocks.contexts.get('s_exec')?.permissionMode()).toBe('plan');
  });

  it('gives a cross-harness fork the closest tier its new harness offers', async () => {
    const { manager } = await makeManager([persisted('s_claude', 'claude', 'accept-edits')]);
    const fork = await manager.fork('s_claude', 'cursor');
    expect(fork?.config).toMatchObject({ harness: 'cursor', permissionMode: 'plan' });
    const same = await manager.fork('s_claude', 'antigravity');
    expect(same?.config).toMatchObject({ harness: 'antigravity', permissionMode: 'accept-edits' });
  });
});

describe('Vocs Code built-in read-only tools', () => {
  it('pins the memory server list to the read-only set the server itself declares', async () => {
    const source = await fs.readFile(path.join(__dirname, '..', 'resources', 'mcp', 'vocs-memory.mjs'), 'utf8');
    const declared = /const READ_ONLY_TOOLS = new Set\((\[[^\]]*\])\)/.exec(source)?.[1];
    expect(declared).toBeDefined();
    expect([...BUILTIN_READ_ONLY_TOOLS['vocs-memory']!].sort()).toEqual((JSON.parse(declared!.replace(/'/g, '"')) as string[]).sort());
  });

  it('only lists servers Vocs Code ships, and keeps mutating tools off the list', () => {
    for (const id of Object.keys(BUILTIN_READ_ONLY_TOOLS)) expect(MCP_BUILTIN_IDS).toContain(id);
    expect(isBuiltinReadOnlyTool('gitnexus', 'query')).toBe(true);
    expect(isBuiltinReadOnlyTool('gitnexus', 'rename')).toBe(false);
    expect(isBuiltinReadOnlyTool('cua-driver', 'get_window_state')).toBe(true);
    expect(isBuiltinReadOnlyTool('cua-driver', 'click')).toBe(false);
    expect(isBuiltinReadOnlyTool('vocs-memory', 'knowledge_propose')).toBe(false);
    expect(isBuiltinReadOnlyTool('my-server', 'query')).toBe(false);
    expect(isBuiltinReadOnlyTool('constructor', 'query')).toBe(false);
  });

  it('recognises harness-level MCP tool names', () => {
    expect(isBuiltinReadOnlyMcpName('mcp__vocs-memory__knowledge_search')).toBe(true);
    expect(isBuiltinReadOnlyMcpName('mcp__gitnexus__impact')).toBe(true);
    expect(isBuiltinReadOnlyMcpName('mcp__gitnexus__rename')).toBe(false);
    expect(isBuiltinReadOnlyMcpName('mcp__other__knowledge_search')).toBe(false);
    expect(isBuiltinReadOnlyMcpName('Bash')).toBe(false);
    expect(isBuiltinReadOnlyMcpName('mcp____query')).toBe(false);
  });
});

describe('tier hints', () => {
  it('shows the closest-match note where a harness only approximates a tier', () => {
    const session = (harness: HarnessId) => ({ ...persisted('s', harness, 'auto') });
    const hint = (harness: HarnessId, mode: PermissionMode) => permissionOptions(session(harness)).find((o) => o.value === mode)?.hint;
    expect(hint('cursor', 'auto')).toMatch(/^Closest match: sandboxed by Cursor\./);
    expect(hint('codex-exec', 'auto')).toMatch(/^Closest match: sandboxed by Codex\./);
    expect(hint('acp', 'ask')).toMatch(/only sees the tool calls the agent asks about/);
    for (const harness of ['claude', 'codex', 'pi', 'native', 'antigravity'] as const) {
      for (const mode of HARNESSES.find((h) => h.id === harness)!.capabilities.permissionModes) {
        expect(permissionModeHint(harness, mode)).toBe(PERMISSION_MODE_LABELS[mode].description);
      }
    }
  });
});
