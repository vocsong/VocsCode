/**
 * Targeted main-process regression tests for Wave 0 security, lifecycle, and state-integrity fixes.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeService } from '../src/main/knowledge/service';
import { ProcessTracker } from '../src/main/process-tracker';
import type { ProcessSource } from '../src/main/process-snapshot';
import { SharedGitnexusServer } from '../src/main/mcp/shared-server';
import { createHandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import { defaultSettings } from '../src/main/settings';
import type { MissionRecord } from '../src/shared/mission';
import type { SessionMeta } from '../src/shared/types';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function baseSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  const cwd = path.join(os.tmpdir(), 'vocs-wave0-cwd');
  return {
    id: 's_1',
    title: 'Test session',
    cwd,
    config: { harness: 'native', projectRoot: cwd, permissionMode: 'ask' },
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { ...ZERO_USAGE },
    harnessRef: {},
    ...overrides
  };
}

describe('KnowledgeService snippetFor term length', () => {
  it('highlights the exact matched term rather than slicing terms[0].length', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-know-snippet-'));
    try {
      const svc = new KnowledgeService({ settings: () => defaultSettings(), log: () => undefined });
      const scope = { projectRoot: dir, cwd: dir };
      await svc.propose(scope, {
        title: 'Alpha page',
        claim: 'Short claim about zzz',
        body: 'The body mentions synchronization behavior in detail.',
        kind: 'gotcha',
        keywords: ['zzz', 'synchronization']
      }, 'test');
      const results = await svc.search(scope, 'zzz synchronization');
      expect(results).toHaveLength(1);
      expect(results[0]!.snippet).toContain('\u0001synchronization\u0002');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Handler registry Wave 0 guards', () => {
  function makeMinimalDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
    const session = baseSession();
    const settings = { get: () => defaultSettings(), update: vi.fn(async () => defaultSettings()) };
    const missions = {
      list: vi.fn<() => MissionRecord[]>(() => []),
      get: vi.fn(() => undefined),
      create: vi.fn(),
      control: vi.fn(),
      sendUser: vi.fn()
    };
    const sessions = {
      list: vi.fn(() => [session]),
      get: vi.fn((id: string) => (id === session.id ? session : undefined)),
      exportMarkdown: vi.fn(async () => '# exported'),
      create: vi.fn(),
      send: vi.fn(),
      stop: vi.fn(),
      delete: vi.fn(),
      archive: vi.fn(),
      patch: vi.fn(),
      setModel: vi.fn(),
      setEffort: vi.fn(),
      setFastMode: vi.fn(),
      setPermissionMode: vi.fn(),
      compact: vi.fn(),
      clearTranscript: vi.fn(),
      fork: vi.fn(),
      moveTo: vi.fn(),
      goal: vi.fn(),
      subagentCommand: vi.fn(),
      respondApproval: vi.fn(),
      transcript: vi.fn(async () => []),
      transcriptSnapshot: vi.fn(async () => ({ items: [], seq: 0 })),
      markViewed: vi.fn(),
      importChats: vi.fn(),
      importScan: vi.fn(),
      republishModels: vi.fn()
    };
    return {
      settings: settings as unknown as HandlerDeps['settings'],
      secrets: { get: vi.fn(), set: vi.fn(), status: vi.fn(async () => ({})) } as unknown as HandlerDeps['secrets'],
      sessions: sessions as unknown as HandlerDeps['sessions'],
      missions: missions as unknown as HandlerDeps['missions'],
      terminals: { list: vi.fn(() => []) } as unknown as HandlerDeps['terminals'],
      runtime: { resolve: vi.fn(() => null), resource: vi.fn(() => ''), availability: vi.fn(), doctor: vi.fn() } as unknown as HandlerDeps['runtime'],
      analytics: { summary: vi.fn(), executions: vi.fn() } as unknown as HandlerDeps['analytics'],
      search: { query: vi.fn() } as unknown as HandlerDeps['search'],
      knowledge: {} as unknown as HandlerDeps['knowledge'],
      appInstructions: {} as unknown as HandlerDeps['appInstructions'],
      vocsAccount: { state: vi.fn(), signIn: vi.fn(), cancel: vi.fn(), signOut: vi.fn(), setKeepSignedIn: vi.fn(), dispose: vi.fn(async () => undefined) } as unknown as HandlerDeps['vocsAccount'],
      desktop: {
        showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: path.join(os.tmpdir(), 'managed-mission-ws', 'out.md') })),
        documentsPath: () => os.tmpdir(),
        openExternal: vi.fn(),
        showItemInFolder: vi.fn(),
        showOpenDialog: vi.fn(),
        openPath: vi.fn(),
        notify: vi.fn(),
        toggleFullScreen: vi.fn(),
        reload: vi.fn(),
        toggleDevTools: vi.fn(),
        zoom: vi.fn(),
        edit: vi.fn()
      } as unknown as HandlerDeps['desktop'],
      push: vi.fn(),
      log: vi.fn(),
      ...overrides
    };
  }

  it('refuses sessions:export into a Mission-owned workspace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-export-guard-'));
    const dest = path.join(dir, 'transcript.md');
    try {
      const mission = {
        id: 'm_1',
        workspaces: [{ id: 'ws_1', role: 'lead', path: dir }]
      } as unknown as MissionRecord;
      const deps = makeMinimalDeps();
      vi.mocked(deps.missions!.list).mockReturnValue([mission]);
      vi.mocked(deps.desktop.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: dest });
      const reg = createHandlerRegistry(deps);
      await expect(reg.invoke('sessions:export', { id: 's_1' })).rejects.toThrow(/Mission/i);
      await expect(fs.access(dest)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-allowlisted image MIME types in missions:create', async () => {
    const deps = makeMinimalDeps();
    const reg = createHandlerRegistry(deps);
    await expect(reg.invoke('missions:create', {
      idempotencyKey: 'k1',
      projectRoot: os.tmpdir(),
      objective: 'test',
      mode: 'autonomous',
      permissionMode: 'auto',
      images: [{ mimeType: 'image/svg+xml', data: 'PHN2Zz48L3N2Zz4=' }]
    } as never)).rejects.toThrow();
    expect(deps.missions!.create).not.toHaveBeenCalled();
  });
});

describe('ProcessTracker close() startup timer cleanup', () => {
  it('does not invoke snapshot after close() cancels the 2s startup timer', async () => {
    vi.useFakeTimers();
    const snapshot = vi.fn(async () => []);
    const source: ProcessSource = { snapshot, commandLines: vi.fn(async () => new Map()), close: vi.fn() };
    const tracker = new ProcessTracker({ source, rootPid: 1000, observeSpawns: false, intervalMs: 60_000 });
    tracker.start();
    await tracker.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('SharedGitnexusServer stop() during startup', () => {
  it('never spawns a server if stop() is called before startup finishes', async () => {
    const server = new SharedGitnexusServer({ command: 'definitely-nonexistent-binary-vocs', baseArgs: ['serve'] });
    const ensurePromise = server.ensure();
    await server.stop();
    await expect(ensurePromise).resolves.toBeNull();
  });
});
