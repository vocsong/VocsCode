import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { KnowledgeUsage, type KnowledgeUsageSample } from '../src/main/intelligence/usage';
import { usageForPacket } from '../src/main/intelligence/usage-observation';
import { writeJson } from '../src/main/util/fs';
import { compileContextPacket, type IntelligenceEvidence } from '../src/shared/intelligence';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const day = 86_400_000;
const a = { projectRoot: path.resolve('private-project-root'), sessionId: 'session-private-id' };
const b = { projectRoot: path.resolve('another-project'), sessionId: 'same-session-other-project' };
const otherSession = { ...a, sessionId: 'another-session' };
const miss: KnowledgeUsageSample = { outcome: 'empty' };

async function fixture(persist?: typeof writeJson) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-knowledge-usage-'));
  dirs.push(dir);
  const file = path.join(dir, 'knowledge-usage.json');
  let now = Date.UTC(2026, 10, 18, 12);
  let clock = 0;
  const log = vi.fn();
  const open = async () => {
    const store = new KnowledgeUsage(dir, { log, now: () => now, clock: () => clock, persist });
    await store.load();
    return store;
  };
  const store = await open();
  return { file, log, store, open, advance: (ms: number) => { now += ms; clock += ms; } };
}

it('starts off without creating a file, and scopes opt-in, history, and clearing to the project', async () => {
  const { file, store, open } = await fixture();
  expect(store.begin(a, 'desktop', 'intelligence_search')).toBeUndefined();
  expect(store.report(a, 7)).toMatchObject({ enabled: false, desktop: { hit: 0, empty: 0, failed: 0 } });
  await store.flush();
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });

  await store.configure(a, true);
  expect(store.begin(b, 'agent', 'knowledge_search')).toBeUndefined();
  const finish = store.begin(a, 'desktop', 'intelligence_search')!;
  const receipt = finish({ outcome: 'hit', sources: ['wiki', 'wiki', 'graph'], staleGraph: true })!;
  expect(finish(miss)).toBeUndefined();
  expect(store.vote(otherSession, receipt, 'helped')).toBe(false);
  expect(store.vote(b, receipt, 'helped')).toBe(false);
  expect(store.vote(a, receipt, 'helped')).toBe(true);
  expect(store.vote(a, receipt, 'helped')).toBe(true);
  expect(store.report(otherSession, 7).desktop).toMatchObject({ hit: 1, empty: 0, helped: 1, staleGraph: 1, sources: { wiki: 1, graph: 1 } });
  await store.configure(b, true);
  store.begin(b, 'desktop', 'context_compile')!(miss);
  await store.configure(a, false);
  expect(store.vote(a, receipt, 'not-helpful')).toBe(false);
  expect(store.begin(a, 'agent', 'memory_recall')).toBeUndefined();
  await store.close();
  const stored = await fs.readFile(file, 'utf8');
  for (const privateValue of [a.projectRoot, b.projectRoot, a.sessionId, b.sessionId, receipt]) expect(stored).not.toContain(privateValue);

  const restored = await open();
  expect(restored.report(a, 30)).toMatchObject({ enabled: false, desktop: { hit: 1, helped: 1 } });
  expect(restored.report(b, 30)).toMatchObject({ enabled: true, desktop: { hit: 0, empty: 1 } });
  await restored.clear(a);
  await restored.close();
  const cleared = await open();
  expect(cleared.report(a, 30)).toMatchObject({ enabled: false, desktop: { hit: 0, empty: 0, helped: 0 } });
  expect(cleared.report(b, 30)).toMatchObject({ enabled: true, desktop: { empty: 1 } });
  await cleared.close();
});

it('uses bounded latency buckets and reports a replaceable vote only for the observed session', async () => {
  const { advance, store, open } = await fixture();
  await store.configure(a, true);
  for (let i = 0; i < 19; i++) {
    const finish = store.begin(a, 'agent', 'memory_recall')!;
    advance(i < 10 ? 4 : 63);
    finish({ outcome: 'hit', sources: ['passive', 'history'], responseBytes: 150 });
  }
  expect(store.report(a, 7).agent).toMatchObject({ hit: 19, p50: 5, p95: null, meanResponseBytes: 150 });
  const finish = store.begin(a, 'agent', 'context_compile')!;
  advance(11_000);
  const receipt = finish({ outcome: 'empty', truncated: true, responseBytes: 30 })!;
  expect(store.report(a, 7)).toMatchObject({ recentAgent: { receipt, lookup: 'context_compile', outcome: 'empty', sources: [] } });
  expect(store.report(otherSession, 7).recentAgent).toBeUndefined();
  expect(store.vote(a, receipt, 'not-helpful')).toBe(true);
  expect(store.vote(a, receipt, 'helped')).toBe(true);
  expect(store.report(a, 7).agent).toMatchObject({ hit: 19, empty: 1, p50: 5, p95: 100, meanResponseBytes: 144, truncated: 1, helped: 1, notHelpful: 0, sources: { passive: 19, history: 19 } });
  advance(60 * 60_000);
  expect(store.vote(a, receipt, 'not-helpful')).toBe(false);
  expect(store.report(a, 7).recentAgent).toBeUndefined();
  store.begin(a, 'agent', 'memory_recall')!(miss);
  expect(store.report(a, 7).recentAgent).toBeDefined();
  await store.close();
  const restored = await open();
  expect(restored.report(a, 7).recentAgent).toBeUndefined();
  expect(restored.report(a, 7).agent.helped).toBe(1);
  await restored.close();
});

it('keeps 30 UTC dates and prunes expired counts from disk on launch or write', async () => {
  const { file, advance, store, open } = await fixture();
  await store.configure(a, true);
  store.begin(a, 'agent', 'memory_recall')!({ outcome: 'hit' });
  advance(7 * day);
  store.begin(a, 'agent', 'memory_recall')!(miss);
  expect(store.report(a, 7).agent).toMatchObject({ hit: 0, empty: 1 });
  expect(store.report(a, 30).agent).toMatchObject({ hit: 1, empty: 1 });
  await store.close();
  advance(23 * day);
  const restored = await open();
  expect(restored.report(a, 30).agent).toMatchObject({ hit: 0, empty: 1 });
  await restored.close();
  const state = JSON.parse(await fs.readFile(file, 'utf8')) as { projects: Record<string, { days: unknown[] }> };
  expect(Object.values(state.projects)[0].days).toHaveLength(1);
});

it('fences pending results and old votes across disable/re-enable and clear, even with a queued write', async () => {
  const { store, open } = await fixture();
  await store.configure(a, true);
  const startedBeforeDisable = store.begin(a, 'agent', 'memory_recall')!;
  const receipt = store.begin(a, 'agent', 'memory_recall')!(miss)!;
  await Promise.all([store.configure(a, false), store.configure(a, true)]);
  expect(startedBeforeDisable({ outcome: 'hit' })).toBeUndefined();
  expect(store.vote(a, receipt, 'helped')).toBe(false);
  const startedBeforeClear = store.begin(a, 'desktop', 'intelligence_search')!;
  await Promise.all([store.flush(), store.clear(a)]);
  expect(startedBeforeClear({ outcome: 'hit' })).toBeUndefined();
  await store.close();
  const restored = await open();
  expect(restored.report(a, 7)).toMatchObject({ enabled: true, desktop: { hit: 0 }, agent: { hit: 0, empty: 0 } });
  await restored.close();
});

it('does not start failed opt-ins or lose live counters after a failed save', async () => {
  const persist = vi.fn(writeJson);
  const { store, open, log } = await fixture(persist);
  persist.mockRejectedValueOnce(new Error('simulated private filesystem error'));
  await expect(store.configure(a, true)).rejects.toThrow('Could not save local Knowledge usage.');
  expect(store.begin(a, 'desktop', 'intelligence_search')).toBeUndefined();
  await store.configure(a, true);
  store.begin(a, 'desktop', 'intelligence_search')!(miss);
  persist.mockRejectedValueOnce(new Error('simulated private filesystem error'));
  await expect(store.clear(a)).rejects.toThrow('Could not save local Knowledge usage.');
  expect(store.report(a, 7).desktop.empty).toBe(1);
  expect(log.mock.calls.flat().join(' ')).not.toContain('private filesystem');
  await store.flush();
  const restored = await open();
  expect(restored.report(a, 7).desktop.empty).toBe(1);
  await restored.close();
  await store.close();
});

it('counts only citations that fit into a compiled packet, not its header or dropped matches', () => {
  const item: IntelligenceEvidence = {
    provider: 'graph', projectId: 'prj', projectName: 'project', ref: 'unique-ref', title: 'graph node',
    authority: 'graph-extracted', freshness: 'stale', historical: false, scope: 'project', score: 1, why: 'fixture'
  };
  const input = { query: 'Question', intent: 'general' as const, scope: { projectId: 'prj', projectName: 'project', collections: [] } };
  const large = { ...item, title: 'x'.repeat(2_000) };
  const truncated = compileContextPacket({ ...input, evidence: [large], budgetTokens: 200 });
  expect(truncated.text.length).toBeGreaterThan(0);
  expect(usageForPacket(truncated)).toEqual({ outcome: 'empty', sources: [], staleGraph: false, truncated: true });
  const compact = compileContextPacket({ ...input, evidence: [item] });
  expect(usageForPacket(compact)).toEqual({ outcome: 'hit', sources: ['graph'], staleGraph: true, truncated: false });
});
