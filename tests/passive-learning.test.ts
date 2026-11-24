import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callIntelligenceTool, type GatewaySession } from '../src/main/intelligence/gateway';
import { MemoryStore } from '../src/main/intelligence/memory-store';
import { PassiveLearning, type PassiveObservation } from '../src/main/intelligence/passive-learning';
import { ProjectRegistry } from '../src/main/intelligence/registry';
import { IntelligenceService, type IntelligenceContext } from '../src/main/intelligence/service';
import { KnowledgeService } from '../src/main/knowledge/service';
import { SessionStore } from '../src/main/store';
import { resolveIntelligenceSettings } from '../src/shared/intelligence';
import type { AppSettings, SessionMeta, TranscriptItem } from '../src/shared/types';

const text = 'Retain the quasar retry fence until its persisted acknowledgment has been read.';
const noop = () => undefined;
const fixtures: Array<() => Promise<void>> = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => { for (const close of fixtures.splice(0)) await close(); });

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-passive-'));
  const projectRoot = path.join(temp, 'project');
  await fs.mkdir(projectRoot);
  const session = { id: 's_passive', title: 'Fixture', config: { projectRoot, permissionMode: 'ask' }, cwd: projectRoot, status: 'idle' } as SessionMeta;
  const settings = { intelligence: resolveIntelligenceSettings(undefined) } as AppSettings;
  const store = new SessionStore(temp);
  await store.upsert(session);
  const data = path.join(temp, 'intelligence');
  const facts = vi.fn(async () => ({}));
  const transcript = vi.fn(async () => ['unexpected full transcript']);
  const privateIds = new Set<string>();
  const complete = vi.fn(async () => null);
  const knowledge = new KnowledgeService({ log: noop, settings: () => settings, synth: { completer: { complete, label: () => 'test/model' } } });
  settings.utilityModel = { provider: 'test', model: 'model' };
  const open = () => {
    const memory = new MemoryStore(data, { log: noop });
    memory.init();
    expect(memory.available).toBe(true);
    const registry = new ProjectRegistry(data, { facts, log: noop });
    const core = new IntelligenceService({
      memory, registry, knowledge, settings: () => settings, transcript, completer: { complete, label: () => 'test/model' }, log: noop,
      sessions: () => store.list().map((s) => ({ id: s.id, title: s.title, projectRoot: s.config.projectRoot, archived: s.archived, private: privateIds.has(s.id) }))
    });
    return { memory, registry, core };
  };
  const rig = open();
  const capture = vi.fn(async (ctx: IntelligenceContext, observation: PassiveObservation, current: () => boolean) => { await rig.core.captureLocalTurn(ctx, observation, current); });
  const failed = vi.fn();
  const learn = new PassiveLearning({ enabled: () => settings.intelligence?.reflection === 'local', session: (id) => store.get(id), capture, failed });
  store.hooks = {
    prepareAppend: (id, item) => learn.prepare(id, item),
    onRewrite: (id, items) => { learn.discard(id); if (items) rig.core.onTranscriptRewritten(id, items); },
    onRemove: (id) => { learn.discard(id); rig.core.onSessionRemoved(id); }
  };
  fixtures.push(async () => { await learn.close(); rig.memory.close(); await fs.rm(temp, { recursive: true, force: true }); });
  let now = 10;
  const ctx = { sessionId: session.id, projectRoot, cwd: projectRoot };
  const user = (id = 'u_1', patch?: Partial<Extract<TranscriptItem, { kind: 'user' }>>): TranscriptItem => ({ id, ts: now++, kind: 'user', text: 'Private user request never copied', userInput: { id: `receipt_${id}`, sessionId: session.id, ts: now, tokens: 14 }, ...patch });
  const answer = (value = `Lesson learned: ${text}`, patch?: Partial<Extract<TranscriptItem, { kind: 'assistant' }>>): TranscriptItem => ({ id: 'a_1', ts: now++, kind: 'assistant', text: value, ...patch });
  const turn = (status: 'completed' | 'failed' | 'interrupted' = 'completed'): TranscriptItem => ({ id: `t_${now}`, ts: now++, kind: 'turn', status });
  const append = async (...items: TranscriptItem[]) => { for (const item of items) await store.appendTranscript(session.id, item); };
  return { ...rig, knowledge, ctx, session, settings, capture, failed, transcript, complete, facts, store, learn, open, user, answer, turn, append, privateIds };
}

function evidence(f: Awaited<ReturnType<typeof fixture>>, core = f.core) {
  return core.search(f.ctx, { query: 'quasar retry fence', providers: ['memory'] });
}

describe('default local learning from committed transcript items', () => {
  it('writes one cited project candidate, reuses it after reopening, and never recaptures a forgotten input', async () => {
    const f = await fixture();
    const prompt = f.user();
    await f.append(prompt, f.answer(`Lesson learned: ${text}`, { thinking: 'private scratchpad' }), f.turn());
    await expect.poll(() => f.memory.forSession(f.session.id).length).toBe(1);
    const [record] = f.memory.forSession(f.session.id);
    expect(record).toMatchObject({ text, kind: 'lesson', type: 'episodic', scope: 'project', state: 'candidate', sources: [{ type: 'transcript', ref: `${f.session.id}#a_1` }] });
    expect(record.text).not.toContain('Private user request');
    expect(f.transcript).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.facts).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
    expect(await fs.stat(path.join(f.ctx.projectRoot, '.vocs-code')).catch(() => null)).toBeNull();
    f.memory.close();
    const reopened = f.open();
    try {
      expect((await evidence(f, reopened.core)).results).toMatchObject([{ provider: 'memory', ref: record.id, historical: true }]);
      const otherRoot = path.join(path.dirname(f.ctx.projectRoot), 'other');
      await fs.mkdir(otherRoot);
      expect((await reopened.core.search({ sessionId: 's_other', projectRoot: otherRoot, cwd: otherRoot }, { query: 'quasar retry fence', providers: ['memory'] })).results).toEqual([]);
      expect(await reopened.core.forget(f.ctx, record.id, 'human')).toMatchObject({ forgotten: true });
      const changedAnswer = { inputId: prompt.id, answerId: 'a_replay', kind: 'lesson', text: `${text} Revised replay.` } as const;
      expect(await reopened.core.captureLocalTurn(f.ctx, changedAnswer, () => true)).toBeNull();
      expect((await evidence(f, reopened.core)).results).toEqual([]);
      expect((await f.store.readTranscript(f.session.id)).map((item) => item.id)).toContain('a_1');
    } finally { reopened.memory.close(); }
  });

  it('ignores noise, unfinished turns, commentary, forked or queued input, and secret-like text', async () => {
    const f = await fixture();
    await f.append(f.user('u_noise'), f.answer('Okay.'), f.turn());
    await f.append(f.user('u_failure'), f.answer(), f.turn('failed'));
    await f.append(f.user('u_agent', { userInput: undefined }), f.answer(), f.turn());
    await f.append(f.user('u_commentary'), f.answer(undefined, { phase: 'commentary' }), f.turn());
    await f.append(f.user('u_fork', { userInput: { sessionId: 's_original', id: 'u_prior', ts: 1, tokens: 32 } }), f.answer(), f.turn());
    await f.append(f.user('u_ongoing'), f.user('u_queued', { queuedAs: 'queue' }), f.answer(), f.turn(), f.answer(), f.turn());
    await f.append(f.user('u_sensitive'), f.answer('Lesson: Remove password=fixture-secret-value from local launch configuration before testing.'), f.turn());
    await f.append(f.user('u_fenced'), f.answer(`\`\`\`\`md\n\`\`\`\nLesson learned: ${text}\n\`\`\`\``), f.turn());
    await f.append(f.user('u_indented'), f.answer(`    Lesson: ${text}`), f.turn());
    await f.append(f.user('u_split_secret'), f.answer(`Lesson: ${text}\nAuthorization: Bearer\nthis-is-not-a-real-token`), f.turn());
    await f.append(f.user('u_partial'), f.answer(`Lesson learned: ${text}`, { streaming: true }), f.turn());
    await tick();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.memory.forSession(f.session.id)).toEqual([]);
    await f.append(f.user('u_valid'), { id: 'tool', kind: 'tool', ts: 50, name: 'write', hint: 'edit', status: 'done', output: 'private tool output' }, f.answer(text), f.turn());
    await expect.poll(() => f.memory.forSession(f.session.id).length).toBe(1);
    expect(f.memory.forSession(f.session.id)).toMatchObject([{ kind: 'episode', state: 'captured', text }]);
  });

  it('recalls a matching note without review, as cited history rather than guidance', async () => {
    const f = await fixture();
    await f.append(f.user(), f.answer(), f.turn());
    await expect.poll(() => f.memory.forSession(f.session.id).length).toBe(1);
    const [record] = f.memory.forSession(f.session.id);
    const reader = { ...f.ctx, sessionId: 's_reader', actions: ['read'] } satisfies GatewaySession;
    const call = (name: string, args: Record<string, unknown>, scope: GatewaySession = reader) => callIntelligenceTool({ intelligence: f.core, knowledge: f.knowledge }, scope, name, args);
    const recall = async (args: Record<string, unknown>) => JSON.parse((await call('memory_recall', args)).content[0].text);
    const query = 'quasar retry fence';
    const cite = `${f.session.id}#a_1`;
    expect(await recall({ query })).toMatchObject({ count: 1, records: [{ id: record.id, state: 'candidate', servable: false, historical: true, text, sources: [{ ref: cite }] }] });
    expect(await recall({})).toMatchObject({ count: 0, records: [] });
    expect(await recall({ query: 'lesson' })).toMatchObject({ count: 0 });
    expect(await recall({ query: `${query} unrelated` })).toMatchObject({ count: 0 });
    expect(await recall({ query, include_unverified: false })).toMatchObject({ count: 0 });
    const result = JSON.parse((await call('intelligence_search', { query, sources: ['memory'] })).content[0].text);
    expect(result.results).toMatchObject([{ ref: record.id, historical: true, authority: 'history', sources: [{ ref: cite }] }]);
    const packet = (await call('context_compile', { query })).content[0].text;
    expect(packet.split('## History')[1]).toContain(text);
    expect(packet).toContain(cite);
    expect(await f.knowledge.digest(f.ctx)).toBeNull();

    const other = path.join(path.dirname(f.ctx.projectRoot), 'other');
    await fs.mkdir(other);
    const collection = await f.core.saveCollection({ name: 'Fixture collection', members: [
      { projectId: (await f.core.project(f.ctx)).id, share: 'wiki' }, { projectId: (await f.core.project({ projectRoot: other })).id, share: 'wiki' }
    ] });
    expect(collection.members).toHaveLength(2);
    const otherReader = { ...reader, projectRoot: other, cwd: other, allowCollections: true };
    expect((await call('context_compile', { query, scope: 'collection' }, otherReader)).content[0].text).not.toContain(text);
    expect((await call('memory_recall', { query }, { ...reader, restricted: true })).content[0].text).not.toContain(text);
    f.privateIds.add(f.session.id);
    expect(await recall({ query })).toMatchObject({ count: 0 });
    f.privateIds.clear();
    f.session.archived = true;
    expect(await recall({ query })).toMatchObject({ count: 0 });
    expect((await call('intelligence_search', { query, sources: ['memory'], include_historical: true })).content[0].text).toContain(cite);
    f.session.archived = false;
    f.settings.intelligence!.reflection = 'off';
    expect(await recall({ query })).toMatchObject({ count: 0 });
    expect((await evidence(f)).results).toMatchObject([{ ref: record.id, historical: true }]);
    expect(f.transcript).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('returns at most three passive notes for one topic', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      await f.append(f.user(`u_${i}`), f.answer(`Lesson: quasar retry fence for fact ${i} has a different documented reason.`, { id: `a_${i}` }), f.turn());
    }
    await expect.poll(() => f.memory.forSession(f.session.id).length).toBe(5);
    const out = await callIntelligenceTool({ intelligence: f.core, knowledge: f.knowledge }, { ...f.ctx, actions: ['read'] }, 'memory_recall', { query: 'quasar retry fence', limit: 20 });
    expect(JSON.parse(out.content[0].text)).toMatchObject({ count: 3 });
  });

  it('purges only unverified notes whose cited replies disappeared, and keeps their replay receipts', async () => {
    const f = await fixture();
    const first = f.user('u_kept');
    const kept = f.answer(undefined, { id: 'a_kept' });
    await f.append(first, kept, f.turn());
    const prompt = f.user('u_erased');
    const erased = f.answer('Lesson: Store the retry cursor before releasing the semaphore.', { id: 'a_erased' });
    await f.append(prompt, erased, f.turn());
    await expect.poll(() => f.memory.forSession(f.session.id).length).toBe(2);
    await f.store.rewriteTranscript(f.session.id, [kept]);
    expect(f.memory.forSession(f.session.id)).toMatchObject([{ text }]);
    expect(await f.core.captureLocalTurn(f.ctx, { inputId: prompt.id, answerId: erased.id, kind: 'lesson', text: 'A replay with different content still cannot recreate this note.' }, () => true)).toBeNull();
    const [record] = f.memory.forSession(f.session.id);
    await f.core.decide(f.ctx, record.id, 'verified');
    await f.store.remove(f.session.id);
    expect(f.memory.forSession(f.session.id)).toMatchObject([{ id: record.id, state: 'verified' }]);
  });

  it('rolls back the receipt if persistence fails, so a later capture can succeed', async () => {
    const f = await fixture();
    const observation = { inputId: 'u_retry', answerId: 'a_retry', kind: 'lesson', text } as const;
    vi.spyOn(f.memory, 'create').mockImplementationOnce(() => { throw new Error('fixture write failure'); });
    await expect(f.core.captureLocalTurn(f.ctx, observation, () => true)).rejects.toThrow('fixture write failure');
    expect(f.memory.forSession(f.session.id)).toEqual([]);
    f.memory.close();
    const reopened = f.open();
    try {
      expect(await reopened.core.captureLocalTurn(f.ctx, observation, () => true)).toMatchObject({ text });
      expect(await reopened.core.captureLocalTurn(f.ctx, observation, () => true)).toBeNull();
    } finally { reopened.memory.close(); }
  });

  it('does not adopt already-queued transcript writes after opting back in', async () => {
    const f = await fixture();
    f.settings.intelligence!.reflection = 'off';
    const queued = Promise.all([f.user(), f.answer(), f.turn()].map((item) => f.store.appendTranscript(f.session.id, item)));
    f.settings.intelligence!.reflection = 'local';
    f.learn.reset();
    await queued;
    await f.learn.close();
    expect(f.memory.forSession(f.session.id)).toEqual([]);
    expect(f.capture).not.toHaveBeenCalled();
  });

  it.each(['rewrite', 'opt-out'] as const)('blocks pending capture on %s', async (action) => {
    const f = await fixture();
    const capture = vi.spyOn(f.core, 'captureLocalTurn');
    let entered!: () => void;
    let finish!: () => void;
    const enteredCapture = new Promise<void>((resolve) => { entered = resolve; });
    const waitForRewrite = new Promise<void>((resolve) => { finish = resolve; });
    const actual = f.core.captureLocalTurn.bind(f.core);
    // Pause an already-admitted observer at the boundary before the ledger write.
    capture.mockImplementationOnce(async (...args) => { entered(); await waitForRewrite; return actual(...args); });
    await f.append(f.user(), f.answer(), f.turn());
    await enteredCapture;
    if (action === 'rewrite') await f.store.rewriteTranscript(f.session.id, []);
    else {
      f.settings.intelligence!.reflection = 'off';
      f.learn.reset();
    }
    finish();
    await f.learn.close();
    expect(f.memory.forSession(f.session.id)).toEqual([]);
    expect(f.capture).toHaveBeenCalledTimes(1);
    expect(f.failed).not.toHaveBeenCalled();
  });
});
