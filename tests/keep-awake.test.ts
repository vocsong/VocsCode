import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KEEP_AWAKE_CHANNEL } from '../src/shared/keep-awake';
import { agentChannels } from '../src/shared/agent-manifest';
import { isRemoteChannel } from '../src/shared/remote-channels';
import type { SessionMeta } from '../src/shared/types';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessContext } from '../src/main/harness/types';
import { registerIpc, type IpcDeps } from '../src/main/ipc';
import { KeepAwake, type PowerBlocker } from '../src/main/keep-awake';
import { emptyUsage } from '../src/main/models/static-models';
import { SessionManager } from '../src/main/session-manager';
import { SettingsStore } from '../src/main/settings';
import { SessionStore } from '../src/main/store';

const ipc = vi.hoisted(() => new Map<string, (event: { sender: unknown; senderFrame: unknown }, input: unknown) => unknown>());
vi.mock('electron', () => ({ app: {}, dialog: {}, BrowserWindow: {}, shell: {}, ipcMain: { handle: (channel: string, handler: never) => ipc.set(channel, handler) } }));
vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn(), listHarnessModels: vi.fn() }));

function stubPower() {
  const live = new Set<number>();
  let next = 0;
  const start = vi.fn<PowerBlocker['start']>(() => { live.add(next); return next++; });
  const stop = vi.fn<PowerBlocker['stop']>((id) => { live.delete(id); });
  const log = vi.fn();
  return { live, start, stop, log, awake: new KeepAwake({ start, stop }, log) };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  ipc.clear();
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-keep-awake-test-'));
  const store = new SessionStore(dir);
  await store.load();
  const settings = new SettingsStore(dir);
  const power = stubPower();
  const contexts = new Map<string, HarnessContext>();
  const dispose = vi.fn(async () => undefined);
  vi.mocked(createAdapter).mockImplementation((_harness, ctx) => {
    contexts.set(ctx.session().id, ctx);
    return {
      id: 'native', busy: false, start: async () => undefined, workspaceWriterState: () => 'quiescent',
      send: async () => { ctx.emit({ type: 'status', status: 'running' }); },
      dispose, interrupt: async () => undefined, setModel: async () => undefined,
      setEffort: async () => undefined, setPermissionMode: async () => undefined, compact: async () => undefined
    };
  });
  const manager = new SessionManager({
    store, settings, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordTurn: vi.fn(), recordUserMessage: vi.fn(), recordUserInputs: vi.fn(), flush: vi.fn(async () => undefined) } as never,
    getSecret: async () => undefined, notify: vi.fn(), pushEvent: vi.fn(),
    pushSessions: (sessions) => power.awake.sync(sessions), log: vi.fn()
  });
  cleanup.push(async () => {
    power.awake.quit();
    await manager.stopAll();
    await manager.flushPendingPersists();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const seed = async (id: string, extras: Partial<SessionMeta> = {}) => {
    const meta: SessionMeta = {
      id, title: id, createdAt: 1, updatedAt: 1, cwd: dir, status: 'idle', harnessRef: {}, usage: emptyUsage(),
      config: { harness: 'native', permissionMode: 'ask', projectRoot: dir }, ...extras
    };
    await store.upsert(meta);
    return meta;
  };
  const contents = { mainFrame: {} };
  const owner = { sender: contents, senderFrame: contents.mainFrame };
  const registry = registerIpc({
    settings, sessions: manager, keepAwake: power.awake, log: vi.fn(), getWindow: () => ({ webContents: contents })
  } as unknown as IpcDeps);
  const handler = ipc.get(KEEP_AWAKE_CHANNEL)!;
  const choice = (id: string, enabled?: boolean) => handler(owner, { id, enabled });
  const end = (id: string) => {
    const ctx = contexts.get(id)!;
    ctx.emit({ type: 'item.upsert', item: { id: 'answer', kind: 'assistant', ts: 2, text: 'Done' } });
    ctx.emit({ type: 'item.upsert', item: { id: 'turn', kind: 'turn', ts: 3, status: 'completed' } });
    ctx.emit({ type: 'status', status: 'idle' });
  };
  return { ...power, dir, store, manager, contexts, dispose, seed, owner, handler, registry, choice, end };
}

it('authorizes only the owner main frame and validates before touching session or power state', async () => {
  const { manager, seed, handler, owner, registry, choice, start, stop } = await fixture();
  await seed('s_live', { status: 'running' });
  await seed('s_mission', {
    status: 'running',
    mission: { missionId: 'm_test', role: 'lead', generation: 1, sourceAccess: 'read_only', requestedTools: [], reasoningDefault: true }
  });
  await seed('s_archived', { status: 'running', archived: true });
  const lookup = vi.spyOn(manager, 'get');
  for (const event of [{ ...owner, sender: {} }, { ...owner, senderFrame: {} }]) {
    expect(() => handler(event, { id: 's_live', enabled: true })).toThrow(/local desktop owner/);
    expect(() => handler(event, { id: 's_live' })).toThrow(/local desktop owner/);
  }
  for (const input of [{ id: '../s_live', enabled: true }, { id: 's_live', enabled: 'yes' }, { id: 's_live', enabled: true, actor: 'desktop' }]) {
    expect(() => handler(owner, input)).toThrow();
  }
  expect(lookup).not.toHaveBeenCalled();
  for (const id of ['s_missing', 's_archived', 's_mission']) expect(() => choice(id, true)).toThrow(/ordinary, unarchived/);
  expect(registry.channels()).not.toContain(KEEP_AWAKE_CHANNEL);
  expect(isRemoteChannel(KEEP_AWAKE_CHANNEL)).toBe(false);
  expect(agentChannels()).not.toContain(KEEP_AWAKE_CHANNEL);
  for (const actor of ['user', 'agent', 'desktop'] as const) {
    await expect(registry.invoke(KEEP_AWAKE_CHANNEL, { id: 's_live', enabled: true }, actor)).rejects.toThrow(/Unknown channel/);
  }
  expect(choice('s_live')).toBe(false);
  expect(start).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});

it('keeps a single blocker across overlapping ordinary turns and releases on completion, Stop and error', async () => {
  const { seed, choice, manager, contexts, live, start, stop, end, dispose, dir } = await fixture();
  await seed('s_a');
  await seed('s_b');
  const index = path.join(dir, 'sessions.json');
  const before = await fs.readFile(index, 'utf8');
  expect(choice('s_a', true)).toBe(true);
  expect(choice('s_b', true)).toBe(true);
  expect(await fs.readFile(index, 'utf8')).toBe(before);
  expect(start).not.toHaveBeenCalled();

  await manager.send('s_a', { text: 'Start A' });
  const held = [...live];
  expect(held).toHaveLength(1);
  const acquisitions = start.mock.calls.length;
  await manager.send('s_b', { text: 'Start B' });
  contexts.get('s_b')!.emit({ type: 'status', status: 'awaiting' });
  expect([...live]).toEqual(held);
  expect(start).toHaveBeenCalledTimes(acquisitions);
  end('s_a');
  expect((await manager.transcript('s_a')).filter(item => item.kind === 'turn')).toEqual([expect.objectContaining({ status: 'completed' })]);
  expect([...live]).toEqual(held);
  await manager.stop('s_b');
  expect(manager.get('s_b')?.status).toBe('idle');
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenLastCalledWith(held[0]);
  expect(live.size).toBe(0);

  // Stop ends the work, not the owner's choice for the next turn.
  await manager.send('s_b', { text: 'Restart B' });
  expect(live.size).toBe(1);
  contexts.get('s_b')!.emit({ type: 'error', fatal: true, message: 'Scripted error' });
  expect(manager.get('s_b')?.status).toBe('error');
  expect(live.size).toBe(0);
  await manager.flushPendingPersists();
  const restartStore = new SessionStore(dir);
  await restartStore.load();
  expect(restartStore.get('s_a')).not.toHaveProperty('keepAwake');
  expect(restartStore.get('s_b')).not.toHaveProperty('keepAwake');
});

it('keeps power ownership with the desktop user even during an admitted controller turn', async () => {
  const { seed, choice, manager, contexts, live, start, end } = await fixture();
  await seed('s_owned');
  const run = (operationId: string) => manager.runControlled('s_owned', { text: 'Controller work' }, {
    operationId, inputId: `input_${operationId}`, beforeStart: async () => undefined, startAllowed: () => undefined, beforeDispatch: async () => undefined
  });
  const turn = run('first');
  await vi.waitFor(() => expect(manager.get('s_owned')?.status).toBe('running'));
  expect(start).not.toHaveBeenCalled();
  expect(choice('s_owned', true)).toBe(true);
  expect(live.size).toBe(1);
  expect(choice('s_owned', false)).toBe(false);
  expect(live.size).toBe(0);
  expect(manager.get('s_owned')?.status).toBe('running');
  expect(contexts.get('s_owned')!.session().config.permissionMode).toBe('ask');
  end('s_owned');
  await expect(turn).resolves.toMatchObject({ outcome: 'succeeded', turnId: 'turn' });
});

it('catches power API failures without changing the session or acquiring a duplicate, including on quit', async () => {
  const { awake, seed, choice, manager, live, start, stop, log } = await fixture();
  await seed('s_work');
  await manager.send('s_work', { text: 'Keep going' });
  start.mockImplementationOnce(() => { throw new Error('start unavailable'); });
  expect(choice('s_work', true)).toBe(true);
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('start unavailable'));
  expect(live.size).toBe(0);
  expect(manager.get('s_work')?.status).toBe('running');
  awake.sync(manager.list());
  expect([...live]).toEqual([0]);
  stop.mockImplementationOnce(() => { throw new Error('stop unavailable'); });
  expect(choice('s_work', false)).toBe(false);
  expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('stop unavailable'));
  expect(choice('s_work', true)).toBe(true);
  expect(start).toHaveBeenCalledTimes(2);
  expect([...live]).toEqual([0]);
  awake.quit();
  expect(stop.mock.calls).toEqual([[0], [0]]);
  expect(live.size).toBe(0);
  awake.sync(manager.list());
  expect(choice('s_work', true)).toBe(false);
  expect(start.mock.calls).toEqual([['prevent-app-suspension'], ['prevent-app-suspension']]);
  expect(manager.get('s_work')?.status).toBe('running');
});
