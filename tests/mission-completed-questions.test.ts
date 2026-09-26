/** Production SessionManager/runtime/store/MCP; only the model/process boundary is scripted.
 * Completed execution is retained fixture history, not a claimed provider/check/delivery run. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRuntime } from '../src/main/mission/runtime';
import { reduceMission } from '../src/main/mission/state';
import { SessionManager } from '../src/main/session-manager';
import { SessionStore } from '../src/main/store';
import { defaultSettings, type SettingsStore } from '../src/main/settings';
import { createAdapter } from '../src/main/harness/registry';
import type { HarnessAdapter, HarnessContext } from '../src/main/harness/types';
import { createManagedPiOwnershipIntent, recordUnlaunchedManagedPiIntent, type ManagedPiOwnershipIntent } from '../src/main/harness/pi-ownership';
import { isMissionQuestionOperation, type MissionRecord } from '../src/shared/mission';
import type { UserInput } from '../src/shared/types';
import { completedMissionFixture } from './support/mission-completed-fixture';
import { deferred } from '../src/main/util/async';

vi.mock('../src/main/harness/registry', () => ({ createAdapter: vi.fn() }));
let root: string, project: string, data: string, sessionStore: SessionStore, sessions: SessionManager, runtime: MissionRuntime, settings: ReturnType<typeof defaultSettings>;
let changedSettings: () => void, contexts: HarnessContext[], clients: Client[], sent: ReturnType<typeof vi.fn<(input: UserInput) => void>>;
let dispose: () => Promise<void>, ready: () => Promise<void>, baseline: MissionRecord;
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 15_000, interval: 20 });
const current = () => runtime.service.get('mission')!;
const answers = () => current().operations.filter(isMissionQuestionOperation);
const facts = (r: MissionRecord) => { const { revision: _rev, lastEventSequence: _seq, updatedAt: _at, operations: _ops, mailbox: _mail, archived: _archived, ...final } = r; return final; };
const ask = (text = 'Which checks ran?', key = 'question-one') => runtime.service.sendUser('lead', { text }, key);
async function compose() {
  sessionStore = new SessionStore(data); await sessionStore.load();
  sessions = new SessionManager({ store: sessionStore, settings: { get: () => settings } as SettingsStore, runtime: {} as never,
    analytics: { touchSession: vi.fn(), recordUserMessage: vi.fn(), recordToolCall: vi.fn(), recordTurn: vi.fn(), recordUsage: vi.fn() } as never,
    getSecret: async () => undefined, pushEvent: vi.fn(), pushSessions: vi.fn(), notify: vi.fn(), log: vi.fn(), withWorkspaceDispatch: (meta, run) => runtime.admission.dispatch(meta.cwd, run) });
  runtime = new MissionRuntime({ userData: data, sessions, settings: { get: () => settings, onChange: (cb) => { changedSettings = () => cb(settings); return () => undefined; } },
    terminals: { activity: () => [], closeManagedSession: async () => undefined, reconcileOwnership: async () => undefined } as never, changed: vi.fn(), log: vi.fn() });
  await runtime.load();
}
function finish(text = 'The retained smoke check ran: node retained-check.cjs, passed (exit 0).', id = 'answer-turn') {
  const ctx = contexts.at(-1)!;
  ctx.emit({ type: 'item.upsert', item: { id: `${id}-text`, kind: 'assistant', text, ts: Date.now() } });
  ctx.emit({ type: 'usage', totals: { ...sessions.get('lead')!.usage, inputTokens: sessions.get('lead')!.usage.inputTokens + 40, outputTokens: sessions.get('lead')!.usage.outputTokens + 20, costUsd: sessions.get('lead')!.usage.costUsd + 0.01, turns: sessions.get('lead')!.usage.turns + 1 } });
  ctx.emit({ type: 'item.upsert', item: { id, kind: 'turn', status: 'completed', ts: Date.now() } });
  ctx.emit({ type: 'status', status: 'idle' });
}
async function started() { await wait(() => expect(sent).toHaveBeenCalledTimes(1)); return clients.at(-1)!; }
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-answers-')); project = path.join(root, 'project'); data = path.join(root, 'data'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'unchanged.txt'), 'final content');
  settings = defaultSettings(); settings.providers = []; settings.mcpDisabledBuiltins = ['gitnexus', 'vocs-memory', 'cua-driver'];
  baseline = completedMissionFixture(project); settings.mission = baseline.config;
  contexts = []; clients = []; sent = vi.fn(); dispose = async () => undefined; ready = async () => undefined;
  vi.mocked(createAdapter).mockImplementation((harness, ctx): HarnessAdapter => {
    contexts.push(ctx); let intent: ManagedPiOwnershipIntent | undefined;
    return { id: harness, busy: false, start: async () => {
      intent = await createManagedPiOwnershipIntent(ctx.sessionDir, { sessionId: ctx.sessionId, missionId: 'mission', generation: 1 });
      const servers = await ctx.mcpServers(); expect(servers).toHaveLength(1);
      const client = new Client({ name: 'completed-answer-test', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(servers[0].def.url!), { requestInit: { headers: servers[0].def.headers } }));
      ctx.emit({ type: 'status', status: 'idle' });
    }, missionReadiness: async () => { await ready(); return { ready: true, tools: ['mission_read', 'mission_context_read'], model: baseline.leadPreset.model, modelAvailable: true, connectionAvailable: true }; },
    listModels: async () => [{ id: 'frontier', provider: 'fixture', displayName: 'Fixture frontier' }],
    send: async (input) => { sent(input); ctx.emit({ type: 'status', status: 'running' }); }, interrupt: async () => undefined,
    dispose: async () => { await dispose(); if (intent) { await recordUnlaunchedManagedPiIntent(intent); intent = undefined; } },
    setModel: async () => undefined, setEffort: async () => undefined, setPermissionMode: async () => undefined };
  });
  await compose();
  await runtime.store.create({ ...baseline, status: 'running', phase: 'delivering', completionReport: undefined }, { idempotencyKey: 'completed-history', actor: 'fixture', expectedRevision: 0, kind: 'fixture' });
  const output = await runtime.store.writeArtifact(baseline.id, Buffer.from('Retained smoke check passed; exit code 0. This is fixture history.'));
  await runtime.store.transact(baseline.id, { idempotencyKey: 'complete-history', actor: 'fixture', expectedRevision: current().revision, kind: 'fixture', request: {} }, (r) => {
    r.evidence[0].artifactIds = [output]; return reduceMission(r, { kind: 'host' }, { kind: 'host.complete', quiescent: true });
  });
  await sessions.createManaged({ title: 'Completed Mission', config: { harness: 'pi', model: baseline.leadPreset.model, projectRoot: project, permissionMode: 'auto' } },
    { id: 'lead', cwd: project, ownership: { missionId: 'mission', role: 'lead', generation: 1, sourceAccess: 'assigned_workspace', requestedTools: [], reasoningDefault: true } });
  await sessionStore.appendTranscript('lead', { id: 'original-answer', kind: 'assistant', text: 'Original completed conversation', ts: 1 });
  baseline = current();
});
afterEach(async () => {
  ready = async () => undefined; dispose = async () => undefined;
  for (const client of clients) await client.close().catch(() => undefined);
  await runtime.close(); await sessions.stopAll(); await sessions.flushPendingPersists();
  vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('completed Mission answer-only conversation', () => {
  it('answers through the same real managed conversation with only readonly MCP getters and immutable final facts', async () => {
    const checks = vi.spyOn(runtime.verification, 'run'), delivery = vi.spyOn(runtime.delivery, 'deliver'), provision = vi.spyOn(runtime.workspaces, 'provision');
    await ask(); const client = await started();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['mission_read', 'mission_context_read']);
    expect(await client.callTool({ name: 'mission_read', arguments: { payload: {} } })).toMatchObject({ structuredContent: { result: { status: 'completed', evidence: baseline.evidence, delivery: baseline.delivery } } });
    expect(await client.callTool({ name: 'mission_context_read', arguments: { payload: { ref: baseline.evidence[0].artifactIds[0] } } })).toMatchObject({ structuredContent: { result: { text: 'Retained smoke check passed; exit code 0. This is fixture history.' } } });
    await expect(client.callTool({ name: 'mission_context_read', arguments: { payload: { ref: path.join(project, 'unchanged.txt') } } })).rejects.toThrow(/not assigned/);
    const ownership = sessions.get('lead')!.mission!;
    expect(sessions.get('lead')).toMatchObject({ id: 'lead', config: { permissionMode: 'plan', model: baseline.leadPreset.model }, mission: { sourceAccess: 'read_only', questionId: answers()[0].payload.questionId } });
    expect(sessions.get('lead')!.config.appendSystemPrompt).toContain('/mission start -- <objective>');
    const binding = { missionId: 'mission', questionId: ownership.questionId, actor: { kind: 'lead' as const, sessionId: 'lead', generation: 1 } };
    for (const name of ['mission_task_delegate', 'mission_task_claim', 'mission_plan_update', 'mission_verification_request', 'mission_finish_request', 'mission_report'] as const) {
      const request = { expectedRevision: current().revision, idempotencyKey: `denied-${name}`, payload: {} };
      await expect(client.callTool({ name, arguments: request })).rejects.toThrow(/read-only/);
      await expect(runtime.service.invoke(binding, name, request)).rejects.toThrow(/read-only/);
    }
    await expect(sessions.requestManagedApproval('lead', 1, { kind: 'command', title: 'Run', options: [] })).rejects.toThrow(/cannot request execution approvals/);
    finish(); await wait(() => expect(answers()[0].state).toBe('succeeded'));
    expect(answers()[0].payload).toMatchObject({ terminalTurnId: 'answer-turn', answerMessageIds: ['answer-turn-text'], answerUsage: { tokens: 60, costUsd: 0.01 } });
    expect(facts(current())).toEqual(facts(baseline));
    expect(current().operations.filter((op) => !isMissionQuestionOperation(op))).toEqual(baseline.operations);
    expect(sessions.list()).toHaveLength(1); expect(sessions.activity('lead').active).toBe(false);
    expect(runtime.scheduler.snapshot()).toEqual({ active: [], queued: [], missions: [] });
    expect((await sessions.transcript('lead')).filter((item) => item.kind === 'assistant').map((item) => item.text)).toEqual(['Original completed conversation', 'The retained smoke check ran: node retained-check.cjs, passed (exit 0).']);
    expect(checks).not.toHaveBeenCalled(); expect(delivery).not.toHaveBeenCalled(); expect(provision).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(project, 'unchanged.txt'), 'utf8')).toBe('final content');
    await expect(client.callTool({ name: 'mission_read', arguments: { payload: {} } })).rejects.toThrow();
  });

  it('deduplicates the user question after lost acknowledgement and never infers implementation authority', async () => {
    await ask('Now implement another feature'); await started();
    await ask('Now implement another feature');
    await expect(ask('Changed payload')).rejects.toThrow(/idempotency/);
    await expect(ask('Another question', 'second')).rejects.toThrow(/settle/);
    finish('For new implementation, explicitly start a linked Mission: /mission start -- implement another feature.');
    await wait(() => expect(answers()[0].state).toBe('succeeded'));
    await ask('Now implement another feature');
    expect(sent).toHaveBeenCalledTimes(1); expect(answers()).toHaveLength(1); expect(current().mailbox.filter((item) => item.userAction?.kind === 'question')).toHaveLength(1);
    expect(facts(current())).toEqual(facts(baseline));
    expect(runtime.service.list()).toHaveLength(1);
    await expect(sessions.sendManaged('lead', { text: 'Host-forged extra answer' }, 1)).rejects.toThrow(/authorized|admission|question/);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('retains capacity and completed outcome until cancellation positively tears down the answer', async () => {
    await ask(); await started(); const hold = deferred<void>(); dispose = () => hold.promise;
    let canceled = false;
    const stop = runtime.service.control({ missionId: 'mission', expectedRevision: current().revision, idempotencyKey: 'cancel-answer', control: { action: 'stop' } }).then(() => { canceled = true; });
    await wait(() => expect(sessions.activity('lead').tearingDown).toBe(true));
    expect(canceled).toBe(false); expect(current().status).toBe('completed'); expect(runtime.scheduler.snapshot().active).toHaveLength(1);
    await expect(ask('Do not restart', 'second')).rejects.toThrow(/settle/);
    hold.resolve(); await stop;
    expect(answers()[0].state).toBe('failed'); expect(facts(current())).toEqual(facts(baseline)); expect(runtime.scheduler.snapshot().active).toHaveLength(0);
  });

  it('a retried cancellation is bound to its original answer and cannot stop a newer question', async () => {
    await ask(); await started();
    const request = { missionId: 'mission', expectedRevision: current().revision, idempotencyKey: 'cancel-exact-answer', control: { action: 'stop' as const } };
    await runtime.service.control(request); expect(answers()[0].state).toBe('failed');
    await ask('A new explicit question', 'second'); await wait(() => expect(sent).toHaveBeenCalledTimes(2));
    await runtime.service.control(request);
    expect(answers()[1].state).toBe('in_flight'); expect(runtime.scheduler.snapshot().active).toHaveLength(1);
    finish('The new question remains active.', 'answer-two'); await wait(() => expect(answers()[1].state).toBe('succeeded'));
    expect(facts(current())).toEqual(facts(baseline));
  });

  it('archive cancels an active answer but never treats rejected teardown as success', async () => {
    await ask(); await started(); dispose = async () => { throw new Error('owned tree uncertain'); };
    await expect(runtime.service.archive('mission', true)).rejects.toThrow(/uncertain/);
    expect(current().archived).not.toBe(true); expect(answers()[0].state).toBe('reconciling'); expect(runtime.scheduler.snapshot().active).toHaveLength(1);
    dispose = async () => undefined;
    await runtime.service.archive('mission', true);
    expect(current().archived).toBe(true); expect(current().status).toBe('completed'); expect(sessions.get('lead')!.archived).toBe(true); expect(runtime.scheduler.snapshot().active).toHaveLength(0);
    expect(facts(current())).toEqual(facts(baseline));
  });

  it('rechecks live revocation while capability startup is outstanding without sending a prompt', async () => {
    const hold = deferred<void>(); ready = () => hold.promise;
    await ask(); await wait(() => expect(contexts).toHaveLength(1));
    settings.mission!.presets[0].enabled = false; delete settings.mission!.defaultLeadPresetId;
    try { changedSettings(); } finally { hold.resolve(); }
    await wait(() => expect(answers()[0].state).toBe('failed'));
    expect(sent).not.toHaveBeenCalled(); expect(facts(current())).toEqual(facts(baseline)); expect(runtime.scheduler.snapshot().active).toHaveLength(0);
  });

  it('counts answer spend toward aggregate caps without treating it as execution progress', async () => {
    const r = current(); r.config.limits.maxTokens = 100; r.config.revision++;
    await runtime.store.transact(r.id, { idempotencyKey: 'fixture-budget', actor: 'fixture', expectedRevision: r.revision, kind: 'fixture', request: {} }, () => r);
    baseline = current();
    await ask(); await started(); finish(); await wait(() => expect(answers()[0].state).toBe('succeeded'));
    await ask('Explain more', 'second'); await wait(() => expect(sent).toHaveBeenCalledTimes(2)); finish('More context', 'answer-two');
    await wait(() => expect(answers()[1].state).toBe('failed'));
    await expect(ask('Do not exceed', 'third')).rejects.toThrow(/threshold/);
    expect(facts(current())).toEqual(facts(baseline)); expect(current().progress).toEqual(baseline.progress);
  });

  it('allows retained input/cache context above 16k while bounding generated answer output separately', async () => {
    await ask(); await started();
    contexts.at(-1)!.emit({ type: 'usage', totals: { ...sessions.get('lead')!.usage, inputTokens: 30_000, cacheReadTokens: 50_000, outputTokens: 32, costUsd: 0.01 } });
    finish('context-answer', 'The captured verification checks passed.');
    await wait(() => expect(answers()[0].state).toBe('succeeded'));
    expect(answers()[0].payload.answerUsage).toMatchObject({ tokens: 80_092 });
    expect(sent).toHaveBeenCalledTimes(1); expect(facts(current())).toEqual(facts(baseline));
  });

  it.each(['tokens', 'tools'] as const)('enforces the separate answer %s bound and does not automatically continue or diagnose', async (limit) => {
    await ask(); await started(); const ctx = contexts.at(-1)!;
    if (limit === 'tokens') ctx.emit({ type: 'usage', totals: { ...sessions.get('lead')!.usage, outputTokens: 16_001 } });
    else for (let i = 0; i < 32; i++) ctx.emit({ type: 'item.upsert', item: { kind: 'tool', id: `read-${i}`, ts: Date.now(), name: 'mission_read', status: 'done', input: { payload: {} } } });
    await wait(() => expect(answers()[0].state).toBe('failed'));
    expect(answers()[0].error).toContain(limit === 'tokens' ? 'token limit' : 'tool-call limit');
    expect(sent).toHaveBeenCalledTimes(1); expect(answers()).toHaveLength(1); expect(facts(current())).toEqual(facts(baseline));
  });

  it('times out one answer through positive teardown, not a fabricated turn or automatic retry', async () => {
    // Capture only the answer watchdog; real timers/IO/SessionManager remain active.
    const realSetTimeout = global.setTimeout; let expire: (() => void) | undefined;
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 120_000) expire = () => fn(...args);
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    await ask(); await started(); expect(expire).toBeTypeOf('function'); expire!();
    await wait(() => expect(answers()[0].state).toBe('failed'));
    expect(answers()[0].error).toContain('time limit'); expect(answers()[0].payload.terminalTurnId).toBeUndefined();
    expect(runtime.scheduler.snapshot().active).toHaveLength(0); expect(facts(current())).toEqual(facts(baseline)); expect(sent).toHaveBeenCalledTimes(1);
  });

  it('cannot exempt an execution dispatch from completion gates by spoofing a question marker', async () => {
    const r = current();
    await expect(runtime.store.transact(r.id, { idempotencyKey: 'forged-answer', actor: 'host', expectedRevision: r.revision, kind: 'fixture', request: {} }, (state) => {
      state.operations.push({ id: 'forged', idempotencyKey: 'forged', expectedRevision: state.revision, actor: 'host', kind: 'dispatch', state: 'in_flight', payload: { questionId: 'unretained', lead: true, sessionId: state.leadSessionId, generation: state.leadGeneration } }); return state;
    })).rejects.toThrow(/genuine/);
    expect(current()).toEqual(r); expect(sent).not.toHaveBeenCalled();
  });

  it('honors account/global capacity while the Mission remains completed', async () => {
    runtime.scheduler.configure({ ...baseline.config.limits, accountLimits: { fixture: 1 } });
    runtime.scheduler.register('other'); const other = await runtime.scheduler.acquire({ missionId: 'other', ownerId: 'other', kind: 'lead', accountId: 'fixture' });
    await ask(); await wait(() => expect(runtime.scheduler.snapshot().queued).toHaveLength(1));
    expect(sent).not.toHaveBeenCalled(); expect(facts(current())).toEqual(facts(baseline));
    other.release(true); runtime.scheduler.unregister('other'); await started(); finish(); await wait(() => expect(answers()[0].state).toBe('succeeded'));
  });

  it('does not replay a consumed or unknown question on restart, and retained transcript remains visible', async () => {
    await ask(); await started(); finish(); await wait(() => expect(answers()[0].state).toBe('succeeded'));
    await runtime.close(); await sessions.flushPendingPersists();
    await compose(); await ask(); expect(sent).toHaveBeenCalledTimes(1);
    expect((await sessions.transcript('lead')).some((item) => item.kind === 'assistant' && item.id === 'answer-turn-text')).toBe(true);
    expect(facts(current())).toEqual(facts(baseline));
    await ask('Explicit question after restart', 'after-restart'); await wait(() => expect(sent).toHaveBeenCalledTimes(2)); finish('Retained evidence is still available.', 'answer-after-restart');
    await wait(() => expect(answers()[1].state).toBe('succeeded'));
    // Crash-window intent: retained startup identity without any matching ownership receipt.
    const old = current(), q = structuredClone(old.mailbox.at(-1)!); q.id = 'unknown-question'; q.deliveredAt = Date.now();
    await runtime.store.transact(old.id, { idempotencyKey: 'crash-fixture', actor: 'fixture', expectedRevision: old.revision, kind: 'fixture', request: {} }, (r) => {
      r.mailbox.push(q); r.operations.push({ ...structuredClone(answers()[0]), id: 'unknown-answer', idempotencyKey: 'unknown-answer', state: 'in_flight', payload: { questionId: q.id, sessionId: r.leadSessionId, generation: 1, lead: true, runtimeStartRequestedAt: 1, dispatchStartedAt: 1, runtimeLaunch: { nonce: '00000000-0000-4000-8000-000000000000', sessionId: 'lead', generation: 1, harnessId: 'pi' } } }); return r;
    });
    // Load performs read-only reconciliation in the current host, exactly as a fresh host does.
    await runtime.service.load();
    expect(answers().at(-1)!.state).toBe('reconciling'); expect(sent).toHaveBeenCalledTimes(2);
    expect(runtime.scheduler.snapshot().missions).toContain('mission');
    expect(runtime.scheduler.snapshot().active).toEqual([{ missionId: 'mission', ownerId: 'unknown-answer', kind: 'lead', accountId: 'fixture' }]);
    await expect(ask('Unsafe retry', 'third')).rejects.toThrow(/settle/);
    expect(facts(current())).toEqual(facts(baseline));
    // Leave the intentionally unknown crash artifact for close's truthful failure assertion.
    await expect(runtime.close()).rejects.toThrow(/shutdown/);
  });
});
