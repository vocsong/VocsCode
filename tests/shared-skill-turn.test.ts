import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessContext } from '../src/main/harness/types';
import { emptyUsage } from '../src/main/models/static-models';
import { SessionManager, type SessionManagerDeps } from '../src/main/session-manager';
import { defaultSettings } from '../src/main/settings';
import { SessionStore } from '../src/main/store';
import { deferred } from '../src/main/util/async';
import type { HarnessId, SessionMeta, UserInput } from '../src/shared/types';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));

const REQUEST = '/skill verify-change   check status\nand keep this newline';
const CANARY = 'Only the selected harness should receive these exact instructions.';
const receipt = { name: 'verify-change', revision: 'a'.repeat(64) };
const approved = { receipt, content: CANARY };
const dirs: string[] = [];
const managers: SessionManager[] = [];
let contexts: HarnessContext[];
let send: (ctx: HarnessContext, input: UserInput) => Promise<void>;
let start: (ctx: HarnessContext) => Promise<void>;
let sent: ReturnType<typeof vi.fn<(input: UserInput) => Promise<void>>>[];

function finish(ctx: HarnessContext, status: 'completed' | 'failed' = 'completed', error?: string) {
  ctx.emit({ type: 'item.upsert', item: { id: 'turn', kind: 'turn', ts: 3, status, error } });
  ctx.emit({ type: 'status', status: 'idle' });
}

beforeEach(() => {
  contexts = [];
  sent = [];
  start = async () => undefined;
  send = async (ctx) => finish(ctx);
  vi.mocked(createAdapter).mockReset().mockImplementation((id, ctx) => {
    contexts.push(ctx);
    const dispatch = vi.fn((input: UserInput) => send(ctx, input));
    sent.push(dispatch);
    return {
      id, busy: false,
      start: async () => { await start(ctx); ctx.emit({ type: 'status', status: 'idle' }); },
      send: dispatch, interrupt: async () => undefined, dispose: async () => undefined,
      setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined
    };
  });
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.stopAll();
    await manager.flushPendingPersists();
  }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(harness: HarnessId = 'codex') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-shared-turn-'));
  dirs.push(dir);
  const store = new SessionStore(dir);
  await store.load();
  const settings = { ...defaultSettings(), providers: [], autoCompactionThreshold: undefined };
  const log = vi.fn();
  const deps: SessionManagerDeps = {
    store, settings: { get: () => settings } as never, runtime: {} as never, getSecret: async () => undefined,
    pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordTurn: vi.fn() } as never,
    appInstructions: async () => '/skill native-name is plain preamble text.'
  };
  const manager = new SessionManager(deps);
  managers.push(manager);
  const meta: SessionMeta = {
    id: 'shared-test', title: 'A task', createdAt: 1, updatedAt: 1, cwd: dir,
    config: { harness, projectRoot: dir, permissionMode: 'plan' },
    status: 'idle', harnessRef: {}, usage: emptyUsage(), queued: 0,
    harnessCommandList: [{ name: 'verify-change', description: 'Native skill with colliding name', kind: 'skill' }],
    pendingAppInstructions: true
  };
  await store.upsert(meta);
  return { manager, store, meta, log, dir, deps, invoke: (resolve = vi.fn(async () => approved)) => manager.sendSharedSkill(meta.id, REQUEST, resolve) };
}

describe('Shared turn admission and dispatch', () => {
  it.each(['codex', 'codex-exec', 'claude', 'pi', 'antigravity'] as const)('passes one reviewed ordinary text turn to %s, preserving Plan and the typed row', async (harness) => {
    const f = await fixture(harness);
    await f.invoke();
    expect(createAdapter).toHaveBeenCalledExactlyOnceWith(harness, expect.any(Object));
    expect(contexts[0].permissionMode()).toBe('plan');
    expect(sent[0]).toHaveBeenCalledTimes(1);
    const input = sent[0].mock.calls[0][0];
    expect(input).toEqual({
      text: `Vocs Code Shared skill turn\n\n/skill native-name is plain preamble text.\n\nShared skill instructions (verify-change):\n\n${CANARY}\n\nUser's task:\n  check status\nand keep this newline`,
      transcriptItemId: expect.any(String), mode: 'now'
    });
    const items = await f.store.readTranscript(f.meta.id);
    expect(items.map((item) => item.kind)).toEqual(['user', 'turn']);
    expect(items[0]).toMatchObject({ id: input.transcriptItemId, sharedSkill: receipt, text: REQUEST, userInput: { tokens: Math.ceil(REQUEST.length / 4) } });
    expect(JSON.stringify(items)).not.toContain(CANARY);
    expect(f.meta.status).toBe('idle');
    await expect(f.manager.editAndResend(f.meta.id, items[0].id, { text: 'Different task' })).rejects.toThrow(/cannot be edited and resent/);
    await f.manager.send(f.meta.id, { text: '/verify-change native route' });
    expect(sent[0].mock.calls[1][0].text).toBe('/verify-change native route');
  });

  it.each(['busy', 'queued', 'archived', 'goal', 'controlled', 'unsupported'] as const)('refuses %s before catalog access or starting', async (state) => {
    const { invoke, meta, store } = await fixture(state === 'unsupported' ? 'native' : 'codex');
    if (state === 'busy') meta.status = 'running';
    if (state === 'queued') meta.queued = 1;
    if (state === 'archived') meta.archived = true;
    if (state === 'goal') meta.goal = { objective: 'Do something else', status: 'active', createdAt: 1, updatedAt: 1, iterations: 0, autoContinue: true, maxIterations: 2 };
    if (state === 'controlled') meta.controlCreation = { operationId: 'controlled', requestHash: 'a'.repeat(64) };
    const resolve = vi.fn(async () => approved);
    await expect(invoke(resolve)).rejects.toThrow(/idle|does not support/);
    expect(resolve).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
    expect(await store.readTranscript(meta.id)).toEqual([]);
  });

  it('reserves before filesystem reads and cancels the pending skill on Stop without starting', async () => {
    const { invoke, manager, meta, store } = await fixture();
    const load = deferred<typeof approved>();
    const pending = invoke(vi.fn(() => load.promise));
    const refusal = expect(pending).rejects.toThrow(/stopped before sending/);
    await expect(manager.send(meta.id, { text: 'Racing user input', mode: 'queue' })).rejects.toThrow(/Shared skill is being sent/);
    await expect(manager.setPermissionMode(meta.id, 'full-auto')).rejects.toThrow(/Shared skill is being sent/);
    await manager.stop(meta.id);
    load.resolve(approved);
    await refusal;
    expect(createAdapter).not.toHaveBeenCalled();
    expect(await store.readTranscript(meta.id)).toEqual([]);
  });

  it('refuses a staged revision that changed even if the new revision was already reviewed', async () => {
    const f = await fixture();
    await expect(f.manager.sendSharedSkill(f.meta.id, REQUEST, async () => approved, 'b'.repeat(64))).rejects.toThrow(/selected Shared skill revision changed/);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(await f.store.readTranscript(f.meta.id)).toEqual([]);
  });

  it('does not dispatch if the file changed while starting, even if the new revision was reviewed', async () => {
    const { invoke, meta, store } = await fixture();
    const boot = deferred<void>();
    start = () => boot.promise;
    const resolve = vi.fn(async () => approved).mockResolvedValueOnce(approved).mockResolvedValueOnce({ receipt: { ...receipt, revision: 'b'.repeat(64) }, content: 'Changed' });
    const pending = invoke(resolve);
    const refusal = expect(pending).rejects.toThrow(/changed before sending/);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    boot.resolve();
    await refusal;
    expect(sent[0]).not.toHaveBeenCalled();
    expect(await store.readTranscript(meta.id)).toEqual([]);
  });

  it('does not dispatch when the review was revoked or Stop happens during the final read', async () => {
    const f = await fixture();
    const pendingRead = deferred<typeof approved>();
    const resolve = vi.fn(async () => approved).mockResolvedValueOnce(approved).mockImplementationOnce(() => pendingRead.promise);
    const pending = f.invoke(resolve);
    const refusal = expect(pending).rejects.toThrow(/stopped before sending/);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    await f.manager.stop(f.meta.id);
    pendingRead.resolve(approved);
    await refusal;
    expect(sent[0]).not.toHaveBeenCalled();
    expect(await f.store.readTranscript(f.meta.id)).toEqual([]);
    await expect(f.invoke(vi.fn(async () => approved).mockResolvedValueOnce(approved).mockRejectedValueOnce(new Error('Review before use.')))).rejects.toThrow('Review before use.');
    expect(sent[1]).not.toHaveBeenCalled();
    expect(await f.store.readTranscript(f.meta.id)).toEqual([]);
  });

  it('does not confuse ack with completion and keeps reflected diagnostics out of history and logs', async () => {
    send = async (ctx) => ctx.emit({ type: 'status', status: 'running' });
    const f = await fixture();
    await f.invoke();
    expect(f.meta.status).toBe('running');
    expect(await f.store.readTranscript(f.meta.id)).toHaveLength(1);
    await expect(f.manager.send(f.meta.id, { text: 'Do not steer', mode: 'steer' })).rejects.toThrow(/Wait for the Shared skill turn/);
    const ctx = contexts[0];
    ctx.log('error', CANARY);
    ctx.emit({ type: 'error', message: CANARY });
    ctx.emit({ type: 'item.upsert', item: { id: 'warn', kind: 'info', level: 'warn', ts: 2, text: CANARY } });
    finish(ctx, 'failed', CANARY);
    expect(JSON.stringify(await f.store.readTranscript(f.meta.id))).not.toContain(CANARY);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(CANARY);
    expect(f.meta.status).toBe('idle');
    expect(f.meta.lastError).toBe('The harness reported an error during the Shared skill turn.');
  });

  it('does not retry an ambiguous transport failure or replay it from durable history after restart', async () => {
    send = async () => { throw new Error(CANARY); };
    const f = await fixture();
    await expect(f.invoke()).rejects.toThrow(/did not retry/);
    expect(sent[0]).toHaveBeenCalledTimes(1);
    await expect(f.invoke()).rejects.toThrow(/idle/);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(CANARY);
    await f.manager.stopAll();
    await f.manager.flushPendingPersists();
    const reopened = new SessionStore(f.dir);
    await reopened.load();
    const restarted = new SessionManager({ ...f.deps, store: reopened });
    managers.push(restarted);
    const items = await restarted.transcript(f.meta.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: REQUEST, sharedSkill: receipt });
    expect(sent[0]).toHaveBeenCalledTimes(1);
    expect(createAdapter).toHaveBeenCalledTimes(1);
  });
});
