import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import type { SessionManagerDeps } from '../src/main/session-manager';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings } from '../src/main/settings';
import type { ModelRef } from '../src/shared/types';
import { fastModeSupport } from '../src/shared/fast-mode';

const runtime = vi.hoisted(() => ({
  ctx: null as HarnessContext | null,
  busy: false,
  change: vi.fn<(enabled: boolean) => Promise<void>>(),
  switches: vi.fn(),
}));
vi.mock('../src/main/harness/registry', () => ({
  createAdapter: (_id: string, ctx: HarnessContext): HarnessAdapter => {
    runtime.ctx = ctx;
    return {
      id: 'codex', get busy() { return runtime.busy; },
      start: async () => { ctx.emit({ type: 'status', status: 'idle' }); },
      send: async () => {
        ctx.emit({ type: 'status', status: 'running' });
        ctx.emit({ type: 'item.upsert', item: { id: 'turn', kind: 'turn', ts: Date.now(), status: 'completed' } });
        ctx.emit({ type: 'status', status: 'idle' });
      },
      interrupt: async () => { ctx.emit({ type: 'status', status: 'idle' }); },
      setFastMode: runtime.change,
      setModel: async (model) => { await runtime.switches(model); },
      setEffort: async () => undefined, setPermissionMode: async () => undefined,
      dispose: async () => undefined,
    };
  },
}));
const dirs: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) { await manager.stopAll(); await manager.flushPendingPersists(); }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  runtime.busy = false;
  runtime.ctx = null;
  runtime.change.mockReset();
  runtime.switches.mockReset();
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-fast-mode-'));
  dirs.push(dir);
  const store = new SessionStore(dir);
  await store.load();
  const settings = { ...defaultSettings(), providers: [] };
  const deps: SessionManagerDeps = {
    store, settings: { get: () => settings, update: vi.fn(async () => settings) } as never, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordToolCall: vi.fn(), recordUsage: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  };
  const manager = new SessionManager(deps);
  managers.push(manager);
  const create = (fastMode?: boolean) => manager.create({ title: 'Fast mode test', config: { projectRoot: dir, harness: 'codex', permissionMode: 'ask', model: { provider: 'openai', model: 'gpt-5.6-sol' }, fastMode } });
  return { dir, store, manager, create, deps };
}

const openai = { provider: 'openai', model: 'gpt-5.6-sol' };
const opus = { provider: 'anthropic', model: 'claude-opus-5' };
describe('Fast mode capability boundaries', () => {
  it.each(['codex', 'codex-exec', 'pi', 'native'] as const)('accepts first-party OpenAI on %s', (harness) => {
    expect(fastModeSupport(harness, openai).supported).toBe(true);
  });
  it.each(['claude', 'pi', 'native'] as const)('accepts supported Opus on %s without allowing Sonnet or retired Opus', (harness) => {
    expect(fastModeSupport(harness, opus).supported).toBe(true);
    for (const model of ['claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-4-6']) {
      expect(fastModeSupport(harness, { provider: 'anthropic', model }).supported).toBe(false);
    }
  });
  it('does not mistake gateways, Spark, unsupported harnesses or unknown defaults for Fast mode', () => {
    expect(fastModeSupport('pi', { ...openai, provider: 'openrouter' }).supported).toBe(false);
    expect(fastModeSupport('pi', { ...openai, model: 'gpt-5.3-codex-spark' }).supported).toBe(false);
    expect(fastModeSupport('cursor', openai).supported).toBe(false);
    expect(fastModeSupport('acp', openai).supported).toBe(false);
    expect(fastModeSupport('pi', undefined).supported).toBe(false);
    expect(fastModeSupport('codex', undefined).supported).toBe(true);
    expect(fastModeSupport('native', openai, [{ id: 'openai', kind: 'openai', name: 'Gateway', enabled: true, hasApiKey: false, models: [], baseUrl: 'https://example.com/v1' }]).supported).toBe(false);
  });
});

describe('per-session Fast mode lifecycle', () => {
  it('defaults to standard, persists opt-in, and drops stale effective state after restart', async () => {
    const { create, dir, store, manager } = await fixture();
    const meta = await create();
    expect(meta.config.fastMode).toBe(false);
    expect(meta.fastModeStatus).toEqual({ state: 'off' });
    await manager.setFastMode(meta.id, true);
    meta.fastModeStatus = { state: 'on' };
    await store.upsert(meta);
    const restarted = new SessionStore(dir);
    await restarted.load();
    expect(restarted.get(meta.id)).toMatchObject({ config: { fastMode: true }, fastModeStatus: { state: 'requested' } });
    await manager.setFastMode(meta.id, false);
    await restarted.load();
    expect(restarted.get(meta.id)).toMatchObject({ config: { fastMode: false }, fastModeStatus: { state: 'off' } });
  });

  it('hands the accepted preference to the runtime once, without changing reasoning effort', async () => {
    const { manager, create } = await fixture();
    const meta = await create(true);
    await manager.send(meta.id, { text: 'First turn' });
    runtime.change.mockImplementation(async (enabled) => {
      expect(runtime.ctx!.session().config.fastMode).toBe(!enabled);
      runtime.ctx!.updateMeta({ fastModeStatus: { state: enabled ? 'requested' : 'off' } });
    });
    await manager.setFastMode(meta.id, false);
    await manager.setFastMode(meta.id, true);
    expect(runtime.change.mock.calls).toEqual([[false], [true]]);
    expect(meta.activeEffort).toBeUndefined();
    expect(meta.config.effort).toBeUndefined();
    expect(meta.fastModeStatus?.state).toBe('requested');
    await manager.send(meta.id, { text: 'Second turn' });
    expect((await manager.transcript(meta.id)).filter((item) => item.kind === 'user')).toHaveLength(2);
  });

  it('rejects busy changes, unsupported models, malformed values and unknown sessions without invoking the runtime', async () => {
    const { manager, create } = await fixture();
    const meta = await create();
    await manager.send(meta.id, { text: 'Initialize' });
    runtime.busy = true;
    await expect(manager.setFastMode(meta.id, true)).rejects.toThrow('idle');
    runtime.busy = false;
    await expect(manager.setFastMode(meta.id, 'yes' as never)).rejects.toThrow('boolean');
    await expect(manager.setFastMode('s_missing', true)).rejects.toThrow('not found');
    await manager.setModel(meta.id, { provider: 'openai', model: 'gpt-5.3-codex-spark' });
    await expect(manager.setFastMode(meta.id, true)).rejects.toThrow('not available');
    expect(runtime.change).not.toHaveBeenCalled();
    expect(meta.config.fastMode).toBe(false);
  });

  it('rejects runtime failures without persisting a requested preference', async () => {
    const { manager, create, dir } = await fixture();
    const meta = await create();
    await manager.send(meta.id, { text: 'Initialize' });
    runtime.change.mockRejectedValueOnce(new Error('Runtime refused Fast mode'));
    await expect(manager.setFastMode(meta.id, true)).rejects.toThrow('Runtime refused');
    expect(meta.config.fastMode).toBe(false);
    const restarted = new SessionStore(dir);
    await restarted.load();
    expect(restarted.get(meta.id)?.config.fastMode).toBe(false);
  });

  it('rolls back a failed write and allows a clean retry', async () => {
    const { manager, create, store, dir } = await fixture();
    const meta = await create();
    await manager.send(meta.id, { text: 'Initialize' });
    await manager.flushPendingPersists();
    const upsert = vi.spyOn(store, 'upsert').mockRejectedValueOnce(new Error('Disk full'));
    await expect(manager.setFastMode(meta.id, true)).rejects.toThrow('Disk full');
    expect(runtime.change.mock.calls).toEqual([[true], [false]]);
    expect(meta.config.fastMode).toBe(false);
    const restarted = new SessionStore(dir);
    await restarted.load();
    expect(restarted.get(meta.id)?.config.fastMode).toBe(false);
    await manager.setFastMode(meta.id, true);
    expect(upsert).toHaveBeenCalled();
    expect(runtime.change.mock.calls).toEqual([[true], [false], [true]]);
    await restarted.load();
    expect(restarted.get(meta.id)?.config.fastMode).toBe(true);
  });

  it('does not dispatch a turn or another billing change during an in-flight toggle', async () => {
    const { manager, create } = await fixture();
    const meta = await create();
    await manager.send(meta.id, { text: 'Initialize' });
    let release!: () => void;
    runtime.change.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const changing = manager.setFastMode(meta.id, true);
    await expect(manager.setFastMode(meta.id, false)).rejects.toThrow('update to finish');
    await expect(manager.send(meta.id, { text: 'Must not dispatch' })).rejects.toThrow('update to finish');
    release();
    await changing;
    expect((await manager.transcript(meta.id)).filter((item) => item.kind === 'user')).toHaveLength(1);
    expect(runtime.change).toHaveBeenCalledTimes(1);
  });

  it('excludes a Fast transition when a send entered first but has not reached the adapter', async () => {
    const { manager, create, deps } = await fixture();
    const meta = await create();
    await manager.send(meta.id, { text: 'Initialize' });
    meta.pendingAppInstructions = true;
    let release!: () => void;
    deps.appInstructions = () => new Promise<string>((resolve) => { release = () => resolve('Instructions'); });
    const sending = manager.send(meta.id, { text: 'Second turn' });
    await expect(manager.setFastMode(meta.id, true)).rejects.toThrow('idle');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await sending;
    expect(runtime.change).not.toHaveBeenCalled();
    expect(meta.config.fastMode).toBe(false);
  });

  it('excludes Fast enablement while a model switch entered first', async () => {
    const { manager, create } = await fixture();
    const meta = await create();
    await manager.send(meta.id, { text: 'Initialize' });
    let release!: () => void;
    runtime.switches.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const switching = manager.setModel(meta.id, { provider: 'openai', model: 'gpt-5.3-codex-spark' });
    await expect(manager.setFastMode(meta.id, true)).rejects.toThrow('update to finish');
    release();
    await switching;
    expect(meta.config.fastMode).toBe(false);
    expect(runtime.change).not.toHaveBeenCalled();
  });

  it('does not resurrect a deleted session after an in-flight toggle rejects', async () => {
    const { manager, create, dir } = await fixture();
    const meta = await create();
    await manager.send(meta.id, { text: 'Initialize' });
    let release!: () => void;
    runtime.change.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const changing = manager.setFastMode(meta.id, true);
    const rejected = expect(changing).rejects.toThrow('runtime changed');
    await manager.delete(meta.id);
    release();
    await rejected;
    expect(manager.get(meta.id)).toBeUndefined();
    const restarted = new SessionStore(dir);
    await restarted.load();
    expect(restarted.list()).toHaveLength(0);
  });

  it('does not restore an old on observation after a preference rollback', async () => {
    const { manager, create, store } = await fixture();
    const meta = await create(true);
    await manager.send(meta.id, { text: 'Initialize' });
    meta.fastModeStatus = { state: 'on' };
    await manager.flushPendingPersists();
    vi.spyOn(store, 'upsert').mockRejectedValueOnce(new Error('Disk full'));
    runtime.change.mockImplementation(async (enabled) => { runtime.ctx!.updateMeta({ fastModeStatus: { state: enabled ? 'requested' : 'off' } }); });
    await expect(manager.setFastMode(meta.id, false)).rejects.toThrow('Disk full');
    expect(meta.config.fastMode).toBe(true);
    expect(meta.fastModeStatus?.state).toBe('requested');
  });

  it('refuses incompatible model switches until Fast mode is turned off, and resets observation on forks', async () => {
    const { manager, create } = await fixture();
    const meta = await create(true);
    const incompatible: ModelRef = { provider: 'anthropic', model: 'claude-sonnet-5' };
    await expect(manager.setModel(meta.id, incompatible)).rejects.toThrow('Turn off Fast mode');
    expect(meta.config.model).toEqual(openai);
    meta.fastModeStatus = { state: 'on' };
    const same = await manager.fork(meta.id);
    expect(same).toMatchObject({ config: { fastMode: true }, fastModeStatus: { state: 'requested' } });
    const cross = await manager.fork(meta.id, 'pi');
    expect(cross).toMatchObject({ config: { fastMode: false }, fastModeStatus: { state: 'off' } });
    await manager.setFastMode(meta.id, false);
    await manager.setModel(meta.id, incompatible);
    expect(meta.config.model).toEqual(incompatible);
  });
});
