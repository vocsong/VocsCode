/**
 * Session lifecycle + persistence tests for in-place harness switching (`SessionManager.switchHarness`).
 * Uses real SessionManager + real SessionStore on disk with scripted adapters.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { SessionManager } from '../src/main/session-manager';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { RuntimeResolver } from '../src/main/runtime';
import type { HarnessId, SessionMeta, UserInput } from '../src/shared/types';

interface FakeAdapterRecord {
  id: HarnessId;
  ctx: HarnessContext;
  started: boolean;
  disposed: boolean;
  busy: boolean;
  sent: UserInput[];
}

const adapterState = vi.hoisted(() => ({
  created: [] as FakeAdapterRecord[],
  nextBusy: false
}));

vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (id: HarnessId, ctx: HarnessContext): HarnessAdapter => {
    const rec: FakeAdapterRecord = { id, ctx, started: false, disposed: false, busy: false, sent: [] };
    adapterState.created.push(rec);
    return {
      id,
      get busy() { return rec.busy; },
      start: async () => {
        rec.started = true;
        ctx.updateRef(id === 'claude' ? { claudeSessionId: 'claude_live_1' } : id === 'antigravity' ? { acpSessionId: 'acp_live_1' } : { nativeHistory: true });
      },
      send: async (input: UserInput) => {
        rec.sent.push(input);
        if (adapterState.nextBusy) {
          rec.busy = true;
          ctx.emit({ type: 'status', status: 'running' });
          return;
        }
        ctx.emit({ type: 'item.upsert', item: { id: `a_${rec.sent.length}`, kind: 'assistant', ts: Date.now(), text: `reply from ${id}` } });
        ctx.emit({ type: 'item.upsert', item: { id: `turn_${rec.sent.length}`, kind: 'turn', ts: Date.now(), status: 'completed', durationMs: 250, costUsd: 0.1 } });
        ctx.emit({ type: 'status', status: 'idle' });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode: async () => undefined,
      dispose: async () => {
        rec.disposed = true;
        rec.busy = false;
      }
    };
  }
}));

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  adapterState.created.length = 0;
  adapterState.nextBusy = false;
  for (const fn of cleanups.splice(0)) await fn().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function rig(userData?: string) {
  const dir = userData ?? await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-switch-harness-'));
  if (!userData) tempDirs.push(dir);
  const store = new SessionStore(dir);
  await store.load();
  const analytics = new AnalyticsStore(dir, { log: () => undefined });
  await analytics.load(store.list());
  const settings = defaultSettings();
  settings.defaultModelByHarness.claude = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
  settings.defaultModelByHarness.antigravity = { provider: 'antigravity', model: 'gemini-3-pro' };
  settings.defaultModelByHarness.native = { provider: 'openai', model: 'gpt-5' };
  settings.defaultModelByHarness.cursor = { provider: 'cursor', model: 'auto' };
  const events: unknown[] = [];
  const pushed: SessionMeta[][] = [];
  const manager = new SessionManager({
    store,
    settings: { get: () => settings, update: async () => settings } as unknown as SettingsStore,
    runtime: undefined as unknown as RuntimeResolver,
    analytics,
    getSecret: async () => undefined,
    pushEvent: (env) => events.push(env),
    pushSessions: (list) => pushed.push(list),
    notify: () => undefined,
    log: () => undefined,
    appInstructions: async () => 'Always keep tests green.'
  });
  cleanups.push(async () => {
    await manager.stopAll();
    await manager.flushPendingPersists();
    await analytics.flush();
  });
  return { dir, store, analytics, settings, manager, events, pushed };
}

describe('SessionManager.switchHarness', () => {
  it('switches an active session in place, preserves its worktree, fences the old adapter, and hands over context once', async () => {
    const { store, manager } = await rig();
    const s = await manager.create({
      config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask', model: { provider: 'anthropic', model: 'claude-opus-5' }, fastMode: true }
    });
    // Simulate a worktree-owned session that has run one turn and accumulated usage/context.
    s.cwd = '/repo/.vocs-code/worktrees/feat-x';
    s.worktreeBranch = 'vocscode/feat-x';
    s.usage = { inputTokens: 4_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.42, turns: 1, contextTokens: 120_000, contextWindow: 200_000 };
    await store.upsert(s);

    await manager.send(s.id, { text: 'implement the rate limiter' });
    expect(adapterState.created).toHaveLength(1);
    const oldAdapter = adapterState.created[0]!;
    expect(manager.get(s.id)!.harnessRef.claudeSessionId).toBe('claude_live_1');

    const switched = await manager.switchHarness(s.id, 'antigravity');

    expect(oldAdapter.disposed).toBe(true);
    expect(switched.id).toBe(s.id);
    expect(switched.cwd).toBe('/repo/.vocs-code/worktrees/feat-x');
    expect(switched.worktreeBranch).toBe('vocscode/feat-x');
    expect(switched.config.harness).toBe('antigravity');
    expect(switched.config.model).toEqual({ provider: 'antigravity', model: 'gemini-3-pro' });
    expect(switched.config.fastMode).toBe(false);
    expect(switched.fastModeStatus).toEqual({ state: 'off' });
    expect(switched.harnessRef).toEqual({});
    expect(switched.pendingForkContext).toBe(true);
    expect(switched.pendingAppInstructions).toBe(true);
    // Cumulative spend stays; stale context-window meter from Claude is cleared.
    expect(switched.usage.costUsd).toBe(0.42);
    expect(switched.usage.turns).toBe(1);
    expect(switched.usage.contextTokens).toBeUndefined();
    expect(switched.usage.contextWindow).toBeUndefined();

    // Late events from the fenced old adapter must be ignored.
    oldAdapter.ctx.emit({ type: 'error', message: 'late claude error', fatal: true });
    expect(manager.get(s.id)!.status).toBe('idle');

    // Transcript contains the switch info divider.
    const items = await store.readTranscript(s.id);
    expect(items.some((i) => i.kind === 'info' && i.text.includes('Switched harness from Claude Agent SDK to Google Antigravity in the same workspace.'))).toBe(true);

    // Next message starts the new adapter and delivers the switch handoff exactly once.
    await manager.send(s.id, { text: 'finish the tests' });
    expect(adapterState.created).toHaveLength(2);
    const newAdapter = adapterState.created[1]!;
    expect(newAdapter.id).toBe('antigravity');
    expect(newAdapter.sent).toHaveLength(1);
    expect(newAdapter.sent[0]!.text).toContain('Handoff from Claude Agent SDK to Google Antigravity');
    expect(newAdapter.sent[0]!.text).toContain('switched harnesses in place in the same workspace');
    expect(newAdapter.sent[0]!.text).toContain('implement the rate limiter');
    expect(newAdapter.sent[0]!.text).toContain('Always keep tests green.');
    expect(newAdapter.sent[0]!.text.endsWith('finish the tests')).toBe(true);
    expect(manager.get(s.id)!.pendingForkContext).toBeUndefined();

    await manager.send(s.id, { text: 'second follow-up' });
    expect(newAdapter.sent[1]!.text).toBe('second follow-up');
  });

  it('switches an empty session without queuing a handoff preamble', async () => {
    const { manager } = await rig();
    const s = await manager.create({ config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask' } });
    const switched = await manager.switchHarness(s.id, 'native');
    expect(switched.config.harness).toBe('native');
    expect(switched.pendingForkContext).toBeUndefined();

    await manager.send(s.id, { text: 'hello' });
    expect(adapterState.created[0]!.sent[0]!.text).toBe('hello');
  });

  it('tightens permissions to the closest stricter tier, pauses active goals for Antigravity, and clears error status', async () => {
    const { store, manager } = await rig();
    const s = await manager.create({ config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask' } });
    s.status = 'error';
    s.lastError = 'usage limit reached';
    s.goal = { objective: 'ship feature', status: 'active', createdAt: 1, updatedAt: 1, iterations: 1, maxIterations: 5, autoContinue: true };
    await store.upsert(s);

    const onAntigravity = await manager.switchHarness(s.id, 'antigravity');
    expect(onAntigravity.status).toBe('idle');
    expect(onAntigravity.lastError).toBeUndefined();
    expect(onAntigravity.goal?.status).toBe('paused');

    // Switching from ask -> cursor must clamp to plan (cursor does not offer ask).
    const onCursor = await manager.switchHarness(s.id, 'cursor');
    expect(onCursor.config.permissionMode).toBe('plan');
  });

  it('clears stale native-history.json when switching away from native', async () => {
    const { store, manager } = await rig();
    const s = await manager.create({ config: { harness: 'native', projectRoot: '/repo', permissionMode: 'ask' } });
    await store.writeNativeHistory(s.id, { messages: [{ role: 'user', content: 'old' }], boundaries: {} });
    await manager.send(s.id, { text: 'first turn' });

    await manager.switchHarness(s.id, 'claude');
    expect(await store.readNativeHistory(s.id)).toBeNull();
  });

  it('refuses switching while busy, archived, or Mission-managed', async () => {
    const { store, manager } = await rig();
    const busySession = await manager.create({ config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask' } });
    adapterState.nextBusy = true;
    await manager.send(busySession.id, { text: 'still running' });
    await expect(manager.switchHarness(busySession.id, 'antigravity')).rejects.toThrow(/Wait for the current turn/);
    expect(manager.get(busySession.id)!.config.harness).toBe('claude');
    await manager.stop(busySession.id);

    const archivedSession = await manager.create({ config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask' } });
    await manager.setArchived(archivedSession.id, true);
    await expect(manager.switchHarness(archivedSession.id, 'antigravity')).rejects.toThrow(/Restore this session/);

    const managed = await manager.create({ config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask' } });
    managed.mission = { missionId: 'm1', role: 'lead', generation: 1, sourceAccess: 'assigned_workspace', requestedTools: [], reasoningDefault: true };
    await store.upsert(managed);
    await expect(manager.switchHarness(managed.id, 'pi')).rejects.toThrow(/Mission/);
  });

  it('rolls back metadata on persistence failure and recovers on retry', async () => {
    const { store, manager } = await rig();
    const s = await manager.create({ config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask' } });
    await manager.send(s.id, { text: 'initial work' });

    const origUpsert = store.upsert.bind(store);
    const spy = vi.spyOn(store, 'upsert').mockImplementation(async (m) => {
      if (m.config.harness === 'antigravity') throw new Error('disk full');
      return origUpsert(m);
    });
    await expect(manager.switchHarness(s.id, 'antigravity')).rejects.toThrow('disk full');
    spy.mockRestore();

    // In-memory metadata was restored cleanly to Claude.
    expect(manager.get(s.id)!.config.harness).toBe('claude');
    expect(manager.get(s.id)!.pendingForkContext).toBeUndefined();

    // Retry succeeds after disk recovers.
    const recovered = await manager.switchHarness(s.id, 'antigravity');
    expect(recovered.config.harness).toBe('antigravity');
    expect(recovered.pendingForkContext).toBe(true);
  });

  it('persists the switched harness and pending handoff across a restart', async () => {
    const first = await rig();
    const s = await first.manager.create({ config: { harness: 'claude', projectRoot: '/repo', permissionMode: 'ask' } });
    await first.manager.send(s.id, { text: 'built the parser' });
    await first.manager.switchHarness(s.id, 'antigravity');
    await first.manager.flushPendingPersists();

    // Cold restart from the same userData directory.
    adapterState.created.length = 0;
    const second = await rig(first.dir);
    const reloaded = second.manager.get(s.id)!;
    expect(reloaded.config.harness).toBe('antigravity');
    expect(reloaded.pendingForkContext).toBe(true);
    expect(reloaded.harnessRef).toEqual({});

    await second.manager.send(s.id, { text: 'now add unit tests' });
    expect(adapterState.created).toHaveLength(1);
    expect(adapterState.created[0]!.id).toBe('antigravity');
    expect(adapterState.created[0]!.sent[0]!.text).toContain('built the parser');
    expect(adapterState.created[0]!.sent[0]!.text.endsWith('now add unit tests')).toBe(true);
  });
});
