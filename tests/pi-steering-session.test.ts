import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessAdapter } from '../src/main/harness/types';
import { createAdapter } from '../src/main/harness/registry';
import { emptyUsage } from '../src/main/models/static-models';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import type { ApprovalDecision, HarnessId, SessionEventEnvelope, SessionMeta, UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));

let root: string;
let manager: SessionManager | undefined;
let actions: Map<string, Promise<ApprovalDecision>>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pi-steering-session-'));
  actions = new Map();
});

afterEach(async () => {
  await manager?.stopAll();
  await manager?.flushPendingPersists();
  await Promise.all(actions.values());
  manager = undefined;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(harness: HarnessId = 'pi') {
  const store = new SessionStore(root);
  await store.load();
  const meta: SessionMeta = {
    id: 's', title: 'Steering approvals', createdAt: 1, updatedAt: 1,
    config: { harness, permissionMode: 'ask', projectRoot: root },
    cwd: root, status: 'idle', harnessRef: {}, usage: emptyUsage(), queued: 0,
  };
  await store.upsert(meta);
  const events: SessionEventEnvelope[] = [];
  const resolvedAtSend: string[][] = [];
  const sent = vi.fn<(input: UserInput) => Promise<void>>();
  const interrupt = vi.fn(async () => undefined);
  const setPermissionMode = vi.fn(async () => undefined);
  let busy = false;
  vi.mocked(createAdapter).mockImplementation((id, ctx) => {
    sent.mockImplementation(async (input) => {
      resolvedAtSend.push(events.flatMap(({ event }) => event.type === 'approval.resolved' ? [event.requestId] : []));
      busy = true;
      ctx.emit({ type: 'status', status: 'running' });
      if (input.text !== 'old' && input.text !== 'fresh') return;
      const label = input.text;
      // Like a tool suspended on permission: accepting input does not wait for this action.
      actions.set(label, (async () => {
        const decision = await ctx.requestApproval({
          kind: 'tool', title: label, toolName: 'write', input: { path: `${label}.txt` },
          options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }],
        });
        if (decision.optionId === 'allow') await fs.writeFile(path.join(root, `${label}.txt`), label);
        return decision;
      })());
    });
    const adapter: HarnessAdapter = {
      id, get busy() { return busy; },
      start: async () => undefined,
      send: sent,
      interrupt,
      setModel: async () => undefined,
      setEffort: async () => undefined,
      setPermissionMode,
      dispose: async () => { busy = false; },
    };
    return adapter;
  });
  manager = new SessionManager({
    store,
    settings: { get: () => defaultSettings() } as SessionManagerDeps['settings'],
    runtime: {} as SessionManagerDeps['runtime'],
    analytics: { recordUserMessage: vi.fn(), touchSession: vi.fn() } as unknown as SessionManagerDeps['analytics'],
    getSecret: async () => undefined,
    pushEvent: (env) => { events.push(structuredClone(env)); },
    pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(),
  });
  const requests = () => events.flatMap(({ event }) => event.type === 'approval.request' ? [event.request] : []);
  const resolutions = () => events.flatMap(({ event }) => event.type === 'approval.resolved' ? [event] : []);
  return { manager, store, sent, resolvedAtSend, interrupt, setPermissionMode, requests, resolutions, setBusy: (value: boolean) => { busy = value; } };
}

describe('Pi normal steering approval boundary', () => {
  it.each([undefined, 'steer', 'now'] as const)('denies pending work before forwarding busy Pi input in mode %s once, without revoking fresh approvals', async (mode) => {
    const { manager, store, sent, resolvedAtSend, interrupt, setPermissionMode, requests, resolutions } = await fixture();
    await manager.send('s', { text: 'old' });
    const [old] = requests();
    expect(requests()).toHaveLength(1);
    expect(manager.get('s')?.status).toBe('awaiting');
    expect(resolutions()).toEqual([]);

    await manager.send('s', { text: 'redirect', mode });

    expect(resolutions()).toEqual([{ type: 'approval.resolved', requestId: old.id, decision: { optionId: 'deny', note: 'Interrupted' } }]);
    expect(resolvedAtSend).toEqual([[], [old.id]]);
    await expect(actions.get('old')).resolves.toEqual({ optionId: 'deny', note: 'Interrupted' });
    await expect(fs.stat(path.join(root, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sent.mock.calls.map(([input]) => ({ text: input.text, mode: input.mode }))).toEqual([
      { text: 'old', mode: undefined }, { text: 'redirect', mode },
    ]);
    expect(interrupt).not.toHaveBeenCalled();
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(manager.get('s')?.config.permissionMode).toBe('ask');

    // A stale Allow from the canceled card cannot resurrect the protected action.
    await manager.respondApproval('s', old.id, { optionId: 'allow' });
    await manager.send('s', { text: 'fresh' });
    const [, fresh] = requests();
    expect(requests()).toHaveLength(2);
    expect(resolutions()).toHaveLength(1);
    await manager.respondApproval('s', fresh.id, { optionId: 'allow' });
    await expect(actions.get('fresh')).resolves.toEqual({ optionId: 'allow' });
    expect(await fs.readFile(path.join(root, 'fresh.txt'), 'utf8')).toBe('fresh');
    await expect(fs.stat(path.join(root, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(resolutions()).toEqual([
      { type: 'approval.resolved', requestId: old.id, decision: { optionId: 'deny', note: 'Interrupted' } },
      { type: 'approval.resolved', requestId: fresh.id, decision: { optionId: 'allow' } },
    ]);

    await manager.stop('s');
    await manager.flushPendingPersists();
    const restarted = new SessionStore(root);
    await restarted.load();
    expect((await restarted.readTranscript('s')).filter((item) => item.kind === 'approval').map((item) => item.decision)).toEqual([
      { optionId: 'deny', note: 'Interrupted' }, { optionId: 'allow' },
    ]);
    expect((await store.readTranscript('s')).filter((item) => item.kind === 'user').map((item) => item.text)).toEqual(['old', 'redirect', 'fresh']);
  });

  it.each([
    { harness: 'pi', mode: 'queue', busy: true },
    { harness: 'claude', mode: 'steer', busy: true },
    { harness: 'pi', mode: 'steer', busy: false },
  ] as const)('preserves pending approvals for $harness mode=$mode busy=$busy', async ({ harness, mode, busy }) => {
    const { manager, sent, interrupt, requests, resolutions, setBusy } = await fixture(harness);
    await manager.send('s', { text: 'old' });
    const [old] = requests();
    setBusy(busy);

    await manager.send('s', { text: 'redirect', mode });

    expect(resolutions()).toEqual([]);
    expect(sent.mock.calls.map(([input]) => input.text)).toEqual(['old', 'redirect']);
    expect(interrupt).not.toHaveBeenCalled();
    await manager.respondApproval('s', old.id, { optionId: 'allow' });
    await expect(actions.get('old')).resolves.toEqual({ optionId: 'allow' });
    expect(await fs.readFile(path.join(root, 'old.txt'), 'utf8')).toBe('old');
    expect(resolutions()).toEqual([{ type: 'approval.resolved', requestId: old.id, decision: { optionId: 'allow' } }]);
  });
});
