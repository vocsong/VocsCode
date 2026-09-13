/** Unit tests for the analytics usage store: deltas, day buckets, backfill and summary rollups. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { addDay, AnalyticsStore, apportion, dayKey, emptyDay, summarize, tokensPerSecond, toolCallFromItem, turnSpeed, usageDelta } from '../src/main/analytics';
import { emptyUsage } from '../src/main/models/static-models';
import { emptyDimensions, rollupDays } from '../src/shared/usage-rollup';
import type { SessionMeta, TranscriptItem, UsageSessionRecord, UsageTotals } from '../src/shared/types';

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

function tmpDir(): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-analytics-'));
  dirs.push(d);
  return d;
}

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function usage(partial: Partial<UsageTotals>): UsageTotals {
  return { ...ZERO, ...partial };
}

function meta(id: string, harness: SessionMeta['config']['harness'], usageTotals: UsageTotals, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    config: { harness, permissionMode: 'ask', projectRoot: '/repo' },
    cwd: '/repo',
    status: 'idle',
    harnessRef: {},
    usage: usageTotals,
    ...overrides
  };
}

const log = () => undefined;

function turn(overrides: Partial<Extract<TranscriptItem, { kind: 'turn' }>> = {}): Extract<TranscriptItem, { kind: 'turn' }> {
  return { id: 'turn_1', kind: 'turn', ts: 1, status: 'completed', ...overrides };
}

describe('usageDelta', () => {
  it('computes per-field deltas', () => {
    const d = usageDelta(usage({ inputTokens: 100, costUsd: 0.5, turns: 2 }), usage({ inputTokens: 150, costUsd: 0.75, turns: 3 }));
    expect(d.inputTokens).toBe(50);
    expect(d.costUsd).toBeCloseTo(0.25);
    expect(d.turns).toBe(1);
  });

  it('clamps counter resets at zero so history is never subtracted', () => {
    const d = usageDelta(usage({ inputTokens: 500, costUsd: 2, turns: 10 }), usage({ inputTokens: 10, costUsd: 0, turns: 0 }));
    expect(d.inputTokens).toBe(0);
    expect(d.costUsd).toBe(0);
    expect(d.turns).toBe(0);
  });
});

describe('dayKey / addDay', () => {
  it('formats UTC calendar days', () => {
    expect(dayKey(Date.UTC(2025, 5, 7, 23, 30))).toBe('2025-06-07');
    expect(dayKey(Date.UTC(2025, 0, 1))).toBe('2025-01-01');
  });

  it('adds only positive numeric fields', () => {
    const day = emptyDay();
    addDay(day, { inputTokens: 10, costUsd: 0.2, turns: 1, outputTokens: -5 });
    expect(day.inputTokens).toBe(10);
    expect(day.costUsd).toBeCloseTo(0.2);
    expect(day.turns).toBe(1);
    expect(day.outputTokens).toBe(0);
  });
});

describe('summarize', () => {
  it('rolls up totals and per-dimension buckets, sorted by spend', () => {
    const rec = (id: string, harness: SessionMeta['config']['harness'], u: UsageTotals, provider: string, model: string, toolCalls = 0): UsageSessionRecord => ({
      id,
      title: id,
      harness,
      provider,
      model,
      projectRoot: '/repo',
      createdAt: 1,
      updatedAt: 1,
      usage: u,
      toolCalls
    });
    const sessions = [
      rec('a', 'claude', usage({ costUsd: 1, inputTokens: 100, turns: 2 }), 'anthropic', 'opus', 5),
      rec('b', 'codex', usage({ costUsd: 3, inputTokens: 300, turns: 4 }), 'openai', 'gpt', 7),
      rec('c', 'claude', usage({ costUsd: 0.5, inputTokens: 50, turns: 1 }), 'anthropic', 'opus', 2)
    ];
    const tools = { Read: { calls: 8, errors: 1, declined: 0, durationMs: 800 }, Bash: { calls: 6, errors: 0, declined: 1, durationMs: 900 } };
    const modelTools = { 'openai/gpt': { Bash: { calls: 4, errors: 1, declined: 0, durationMs: 0 } }, 'anthropic/opus': { Read: { calls: 6, errors: 0, declined: 1, durationMs: 0 } } };
    const files = { 'src/a.ts': { adds: 1, updates: 3, deletes: 0, renames: 0 }, 'src/b.ts': { adds: 2, updates: 0, deletes: 1, renames: 0 } };
    const s = summarize(sessions, {}, tools, modelTools, files, 0, 0);
    expect(s.totals.costUsd).toBeCloseTo(4.5);
    expect(s.totals.turns).toBe(7);
    expect(s.sessionCount).toBe(3);
    expect(s.byHarness.map((b) => [b.key, b.usage.costUsd])).toEqual([
      ['codex', 3],
      ['claude', 1.5]
    ]);
    expect(s.byModel[0].key).toBe('openai/gpt');
    expect(s.byModel[0].sessions).toBe(1);
    expect(s.byProject[0].key).toBe('/repo');
    expect(s.byProject[0].toolCalls).toBe(14);
    expect(s.sessions[0].id).toBe('b');
    expect(s.toolTotals.calls).toBe(14);
    expect(s.toolTotals.errors).toBe(1);
    expect(s.tools.map((t) => [t.name, t.calls])).toEqual([
      ['Read', 8],
      ['Bash', 6]
    ]);
    expect(s.modelTools.map((r) => [r.key, r.name, r.calls])).toEqual([
      ['anthropic/opus', 'Read', 6],
      ['openai/gpt', 'Bash', 4]
    ]);
    expect(s.modelTools[0].label).toBe('opus');
    expect(s.files[0]).toMatchObject({ path: 'src/a.ts', total: 4 });
  });

  it('combines tool names that differ only by harness casing', () => {
    const tools = {
      Bash: { calls: 3, errors: 1, declined: 0, durationMs: 30 },
      bash: { calls: 7, errors: 2, declined: 1, durationMs: 70 },
      AskUserQuestion: { calls: 2, errors: 0, declined: 0, durationMs: 0 }
    };
    const modelTools = {
      'anthropic/opus': {
        Bash: { calls: 3, errors: 1, declined: 0, durationMs: 30 },
        bash: { calls: 2, errors: 1, declined: 0, durationMs: 20 }
      },
      'openai/terra': { bash: { calls: 5, errors: 1, declined: 1, durationMs: 50 } }
    };
    const s = summarize([], {}, tools, modelTools, {}, 0, 0);
    expect(s.tools).toEqual([
      { name: 'bash', calls: 10, errors: 3, declined: 1, durationMs: 100 },
      { name: 'AskUserQuestion', calls: 2, errors: 0, declined: 0, durationMs: 0 }
    ]);
    expect(s.modelTools.map((r) => [r.key, r.name, r.calls, r.errors])).toEqual([
      ['anthropic/opus', 'bash', 5, 2],
      ['openai/terra', 'bash', 5, 1]
    ]);
  });

  it('computes effective per-model rates, undefined while a denominator was never measured', () => {
    const rec = (id: string, u: UsageTotals, provider: string, model: string): UsageSessionRecord => ({
      id,
      title: id,
      harness: 'pi',
      provider,
      model,
      projectRoot: '/repo',
      createdAt: 1,
      updatedAt: 1,
      usage: u,
      toolCalls: 0
    });
    const sessions = [
      rec('a', usage({ costUsd: 2, inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 50_000, turns: 4 }), 'anthropic', 'opus'),
      rec('b', usage({ costUsd: 0.1, inputTokens: 400_000, turns: 1 }), 'deepseek', 'chat'),
      rec('c', usage({ costUsd: 0.5, turns: 2 }), 'local', 'llama'),
      rec('d', usage({ costUsd: 0.2, inputTokens: 1000 }), 'local', 'embed')
    ];
    const s = summarize(sessions, {}, {}, {}, {}, 0, 0);
    expect(s.modelRates.map((r) => r.key)).toEqual(['anthropic/opus', 'local/llama', 'local/embed', 'deepseek/chat']);
    const opus = s.modelRates.find((r) => r.key === 'anthropic/opus')!;
    expect(opus.tokens).toBe(200_000);
    expect(opus.calls).toBe(4);
    expect(opus.usdPerMTok).toBeCloseTo(2 / 200 * 1000);
    expect(opus.usdPerCall).toBeCloseTo(0.5);
    const chat = s.modelRates.find((r) => r.key === 'deepseek/chat')!;
    expect(chat.usdPerMTok).toBeCloseTo(0.1 / 400 * 1000);
    expect(chat.usdPerCall).toBeCloseTo(0.1);
    // Tokens never measured: no $/M token rate. Turns never measured: no $/call rate.
    const llama = s.modelRates.find((r) => r.key === 'local/llama')!;
    expect(llama.usdPerMTok).toBeUndefined();
    expect(llama.usdPerCall).toBeCloseTo(0.25);
    const embed = s.modelRates.find((r) => r.key === 'local/embed')!;
    expect(embed.usdPerMTok).toBeCloseTo(200);
    expect(embed.usdPerCall).toBeUndefined();
  });

  it('filters days to the requested range and reports active days', () => {
    const now = Date.UTC(2025, 5, 10);
    const days = {
      '2025-06-09': { ...emptyDay(), costUsd: 1 },
      '2025-06-02': { ...emptyDay(), costUsd: 2 },
      '2025-05-01': { ...emptyDay(), costUsd: 4 }
    };
    const s = summarize([], days, {}, {}, {}, 7, now);
    expect(s.days.map((d) => d.date)).toEqual(['2025-06-09']);
    const all = summarize([], days, {}, {}, {}, 0, now);
    expect(all.days.map((d) => d.date)).toEqual(['2025-05-01', '2025-06-02', '2025-06-09']);
    expect(all.activeDays).toBe(3);
  });
});

describe('AnalyticsStore', () => {
  it('records usage deltas into daily buckets and persists them across reloads', async () => {
    const dir = tmpDir();
    const store = new AnalyticsStore(dir, { log });
    const t0 = Date.UTC(2025, 5, 9, 12);
    const m = meta('s1', 'claude', usage({}), { updatedAt: t0 });
    await store.load([m]);
    store.recordUsage(m, usage({ inputTokens: 100, outputTokens: 50, costUsd: 1, turns: 2 }), t0);
    store.recordUsage(m, usage({ inputTokens: 150, outputTokens: 80, costUsd: 1.5, turns: 3 }), t0);
    store.recordTurn(m, turn({ durationMs: 4_000 }), t0);
    await store.flush();

    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load([]);
    const s = fresh.summary(0, t0);
    expect(s.totals.inputTokens).toBe(150);
    expect(s.totals.outputTokens).toBe(80);
    expect(s.totals.costUsd).toBeCloseTo(1.5);
    expect(s.totals.turns).toBe(3);
    expect(s.days).toHaveLength(1);
    expect(s.days[0].usage.durationMs).toBe(4_000);
    expect(s.sessionCount).toBe(1);
  });

  it('backfills existing sessions once, attributing their totals to their last active day', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 8, 12);
    const m = meta('old', 'pi', usage({ inputTokens: 200, costUsd: 2, turns: 5 }), { updatedAt: t0 });
    const store = new AnalyticsStore(dir, { log });
    await store.load([m]);
    // A second load with the same session must not double-count.
    await store.load([m]);
    const s = store.summary(0, t0);
    expect(s.totals.costUsd).toBeCloseTo(2);
    expect(s.totals.inputTokens).toBe(200);
    expect(s.days).toHaveLength(1);
    expect(s.days[0].date).toBe('2025-06-08');

    // New usage on top of the backfilled baseline records only the delta.
    store.recordUsage(m, usage({ inputTokens: 300, costUsd: 3, turns: 6 }), Date.UTC(2025, 5, 9, 12));
    const s2 = store.summary(0);
    expect(s2.totals.inputTokens).toBe(300);
    expect(s2.days.map((d) => d.usage.inputTokens)).toEqual([200, 100]);
  });

  it('keeps the usage history of deleted sessions and ignores counter resets', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const m = meta('gone', 'native', usage({}), { updatedAt: t0 });
    const store = new AnalyticsStore(dir, { log });
    await store.load([m]);
    store.recordUsage(m, usage({ inputTokens: 100, costUsd: 1, turns: 1 }), t0);
    // Harness restarts counters: the delta clamps at zero and history stays intact.
    store.recordUsage(m, usage({}), t0 + 1000);
    await store.flush();
    const s = store.summary(0, t0);
    expect(s.totals.costUsd).toBeCloseTo(1);
    expect(s.totals.inputTokens).toBe(100);
    expect(s.sessions.map((x) => x.id)).toEqual(['gone']);
  });

  it('updates session snapshots when metadata changes', async () => {
    const dir = tmpDir();
    const store = new AnalyticsStore(dir, { log });
    const m = meta('snap', 'claude', usage({}));
    await store.load([m]);
    const renamed = { ...m, title: 'Renamed', activeModel: { provider: 'anthropic', model: 'opus' } };
    store.touchSession(renamed);
    const s = store.summary(0);
    expect(s.sessions[0].title).toBe('Renamed');
    expect(s.byModel[0]?.key).toBe('anthropic/opus');
  });
});

describe('output speed', () => {
  it('samples only completed turns that report both output tokens and wall time', () => {
    expect(turnSpeed(turn({ durationMs: 2_000, usage: { outputTokens: 100 } }))).toEqual({ tokens: 100, ms: 2_000 });
    expect(turnSpeed(turn({ durationMs: 2_000 }))).toBeNull();
    expect(turnSpeed(turn({ usage: { outputTokens: 100 } }))).toBeNull();
    expect(turnSpeed(turn({ status: 'interrupted', durationMs: 2_000, usage: { outputTokens: 100 } }))).toBeNull();
    expect(tokensPerSecond({ tokens: 100, ms: 2_000 })).toBeCloseTo(50);
    expect(tokensPerSecond({ tokens: 0, ms: 0 })).toBeNull();
    expect(tokensPerSecond(undefined)).toBeNull();
  });

  it('accumulates paired samples per day and per session and rolls them up', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const store = new AnalyticsStore(dir, { log });
    const a = meta('a', 'claude', usage({}), { updatedAt: t0, activeModel: { provider: 'anthropic', model: 'opus' } });
    const b = meta('b', 'acp', usage({}), { updatedAt: t0 });
    await store.load([a, b]);
    store.recordTurn(a, turn({ id: 't1', durationMs: 2_000, usage: { outputTokens: 100 } }), t0);
    store.recordTurn(a, turn({ id: 't2', durationMs: 8_000, usage: { outputTokens: 100 } }), t0);
    // No token report (ACP): wall time still counts toward duration, never toward speed.
    store.recordTurn(b, turn({ id: 't3', durationMs: 5_000 }), t0);
    // Interrupted turns count for nothing.
    store.recordTurn(a, turn({ id: 't4', status: 'interrupted', durationMs: 1_000, usage: { outputTokens: 500 } }), t0);
    await store.flush();

    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load([]);
    const s = fresh.summary(0, t0);
    expect(s.days[0].usage.durationMs).toBe(15_000);
    expect(s.days[0].usage.speedTokens).toBe(200);
    expect(s.days[0].usage.speedMs).toBe(10_000);
    expect(tokensPerSecond(s.speed)).toBeCloseTo(20);
    const sa = s.sessions.find((x) => x.id === 'a');
    const sb = s.sessions.find((x) => x.id === 'b');
    expect(sa?.speed).toEqual({ tokens: 200, ms: 10_000 });
    expect(sb?.speed).toEqual({ tokens: 0, ms: 0 });
    // Per-session wall time: 2k + 8k for a, 5k for b (interrupted turns count for nothing).
    expect(sa?.durationMs).toBe(10_000);
    expect(sb?.durationMs).toBe(5_000);
    // Per-model buckets carry the wall time too, so avg turn = durationMs / turns is available.
    expect(s.byModel.find((x) => x.key === 'anthropic/opus')).toMatchObject({ durationMs: 10_000 });
    expect(s.byHarness.find((x) => x.key === 'claude')?.speed).toEqual({ tokens: 200, ms: 10_000 });
    expect(s.byModel.find((x) => x.key === 'anthropic/opus')?.speed).toEqual({ tokens: 200, ms: 10_000 });
  });

  it('loads day records written before speed was tracked as zero samples', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const legacy = { ...emptyDay(), costUsd: 1, turns: 1, durationMs: 3_000 } as unknown as Record<string, number>;
    delete legacy.speedTokens;
    delete legacy.speedMs;
    await fs.writeFile(path.join(dir, 'analytics.json'), JSON.stringify({ version: 1, days: { '2025-06-09': legacy }, recorded: {}, sessions: {}, tools: {}, files: {} }));
    const store = new AnalyticsStore(dir, { log });
    const m = meta('s1', 'native', usage({}), { updatedAt: t0 });
    await store.load([m]);
    store.recordTurn(m, turn({ durationMs: 1_000, usage: { outputTokens: 40 } }), t0);
    const s = store.summary(0, t0);
    expect(s.days[0].usage.speedTokens).toBe(40);
    expect(s.days[0].usage.speedMs).toBe(1_000);
    expect(s.days[0].usage.durationMs).toBe(4_000);
    expect(tokensPerSecond(s.speed)).toBeCloseTo(40);
  });
});

describe('per-tool-call tracking', () => {
  function toolItem(id: string, overrides: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): Extract<TranscriptItem, { kind: 'tool' }> {
    return { id, kind: 'tool', ts: 1, name: 'Bash', status: 'done', durationMs: 250, ...overrides };
  }

  it('collapses a running tool item to null and counts status/duration when finished', () => {
    expect(toolCallFromItem(toolItem('t1', { status: 'running' }))).toBeNull();
    expect(toolCallFromItem(toolItem('t2'))?.usage).toEqual({ calls: 1, errors: 0, declined: 0, durationMs: 250 });
    expect(toolCallFromItem(toolItem('t3', { status: 'error' }))?.usage.errors).toBe(1);
    expect(toolCallFromItem(toolItem('t4', { status: 'declined', durationMs: undefined }))?.usage).toEqual({ calls: 1, errors: 0, declined: 1, durationMs: 0 });
  });

  it('records exact harness/tool outcomes once across calls and restart, without guessing an unknown harness', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const activeModel = { provider: 'anthropic', model: 'same-model' };
    const sessions = [meta('claude', 'claude', usage({}), { activeModel }), meta('pi', 'pi', usage({}), { activeModel })];
    const store = new AnalyticsStore(dir, { log });
    await store.load(sessions);
    const calls = [
      ['claude', toolItem('1', { name: 'Read' })],
      ['claude', toolItem('2', { name: 'read', status: 'error' })],
      ['claude', toolItem('3', { name: 'Read', status: 'declined' })],
      ['pi', toolItem('1', { name: 'read' })],
      ['pi', toolItem('2', { name: 'Read', status: 'declined' })],
      ['unknown', toolItem('1', { name: 'Read', status: 'error' })]
    ] as const;
    for (const [id, item] of calls) {
      store.recordToolCall(id, item, t0, activeModel);
      store.recordToolCall(id, item, t0, activeModel);
    }
    store.recordToolCall('pi', toolItem('running', { status: 'running' }), t0);
    await store.flush();
    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load(sessions);
    for (const [id, item] of calls) fresh.recordToolCall(id, item, t0 + 86_400_000, activeModel);
    await fresh.flush();
    const s = fresh.summary(0, t0);
    expect(s.harnessTools).toEqual([
      { key: 'claude', label: 'claude', name: 'read', calls: 3, errors: 1, declined: 1, durationMs: 750 },
      { key: 'pi', label: 'pi', name: 'read', calls: 2, errors: 0, declined: 1, durationMs: 500 }
    ]);
    expect(rollupDays(s.days).harnessTools).toEqual(s.harnessTools);
    expect(s.toolTotals).toEqual({ calls: 6, errors: 2, declined: 2, durationMs: 1500 });
    expect(s.days.map((d) => [d.date, d.usage.toolCalls])).toEqual([['2025-06-09', 6]]);
    expect(s.sessions.map((x) => x.toolCalls)).toEqual([3, 2]);
    expect(s.modelTools).toEqual([{ key: 'anthropic/same-model', label: 'same-model', name: 'read', calls: 6, errors: 2, declined: 2, durationMs: 1500 }]);
  });

  it.each([false, true])('loads legacy aggregates without inventing harness errors or replaying old calls (existing slices: %s)', async (hasSlices) => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const m = meta('old', 'pi', usage({ turns: 1 }), { updatedAt: t0 });
    const old = toolItem('old-error', { name: 'Read', status: 'error' });
    const by = emptyDimensions();
    delete by.harnessTool;
    await fs.writeFile(path.join(dir, 'analytics.json'), JSON.stringify({
      version: 1,
      days: { '2025-06-09': { ...emptyDay(), turns: 1, toolCalls: 1, by: hasSlices ? by : undefined } },
      recorded: { old: m.usage },
      sessions: { old: { id: 'old', title: 'old', harness: 'pi', projectRoot: '/repo', createdAt: t0, updatedAt: t0, usage: m.usage, toolCalls: 1 } },
      tools: { Read: { calls: 1, errors: 1, declined: 0, durationMs: 250 } },
      files: {}
    }));
    const store = new AnalyticsStore(dir, { log });
    await store.load([m], async () => [old]);
    expect(store.summary(0).harnessTools).toEqual([]);
    expect(rollupDays(store.summary(0).days).harnessTools).toEqual([]);
    if (hasSlices) expect(store.summary(0).days[0].usage.by?.harnessTool).toBeUndefined();
    store.recordToolCall('old', old, t0);
    store.recordToolCall('old', toolItem('new', { name: 'read', status: 'declined' }), t0 + 86_400_000);
    await store.flush();
    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load([m]);
    fresh.recordToolCall('old', old, t0);
    await fresh.flush();
    const s = fresh.summary(0);
    expect(s.toolTotals).toEqual({ calls: 2, errors: 1, declined: 1, durationMs: 500 });
    expect(s.harnessTools).toEqual([{ key: 'pi', label: 'pi', name: 'read', calls: 1, errors: 0, declined: 1, durationMs: 250 }]);
    expect(rollupDays(s.days.slice(0, 1)).harnessTools).toEqual([]);
    expect(s.days.map((d) => d.usage.toolCalls)).toEqual([1, 1]);
  });

  it('keeps transcript backfill out of the new harness dimension', async () => {
    const store = new AnalyticsStore(tmpDir(), { log });
    const old = toolItem('old-error', { name: 'Read', status: 'error' });
    await store.load([meta('old', 'claude', usage({}))], async () => [old]);
    expect(store.summary(0).toolTotals.calls).toBe(1);
    expect(store.summary(0).harnessTools).toEqual([]);
    expect(rollupDays(store.summary(0).days).harnessTools).toEqual([]);
    store.recordToolCall('old', old);
    await store.flush();
    expect(store.summary(0).toolTotals.calls).toBe(1);
    expect(store.summary(0).harnessTools).toEqual([]);
  });

  it('bounds the persisted replay window while retaining in-process deduplication', async () => {
    const dir = tmpDir();
    const store = new AnalyticsStore(dir, { log });
    await store.load([meta('s', 'pi', usage({}))]);
    const t0 = Date.UTC(2025, 5, 9, 12);
    for (let i = 0; i < 10_001; i++) store.recordToolCall('s', toolItem(String(i)), t0);
    // Eviction from disk's recent window must not regress the existing in-process guarantee.
    store.recordToolCall('s', toolItem('0'), t0);
    await store.flush();
    const disk = JSON.parse(await fs.readFile(path.join(dir, 'analytics.json'), 'utf8'));
    expect(disk.recordedTools).toHaveLength(10_000);
    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load([]);
    fresh.recordToolCall('s', toolItem('10000'), t0);
    await fresh.flush();
    expect(fresh.summary(0).harnessTools).toEqual([{ key: 'pi', label: 'pi', name: 'Bash', calls: 10_001, errors: 0, declined: 0, durationMs: 2_500_250 }]);
    expect(fresh.summary(0).toolTotals.calls).toBe(10_001);
  });

  it('recovers a failed atomic write with counts and replay protection persisted together', async () => {
    const dir = tmpDir();
    const warn = vi.fn();
    const store = new AnalyticsStore(dir, { log: warn });
    await store.load([meta('s', 'pi', usage({}))]);
    const item = toolItem('failure', { name: 'read', status: 'error' });
    store.recordToolCall('s', item);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('injected write failure'), { code: 'EIO' }));
    try {
      await store.flush();
      expect(rename).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('warn', expect.stringContaining('analytics write failed'));
      const disk = JSON.parse(await fs.readFile(path.join(dir, 'analytics.json'), 'utf8'));
      expect(disk.tools).toEqual({});
    } finally {
      rename.mockRestore();
    }
    store.recordToolCall('s', item);
    await store.flush();
    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load([]);
    fresh.recordToolCall('s', item);
    await fresh.flush();
    const s = fresh.summary(0);
    expect(s.toolTotals).toEqual({ calls: 1, errors: 1, declined: 0, durationMs: 250 });
    expect(s.harnessTools).toEqual([{ key: 'pi', label: 'pi', name: 'read', calls: 1, errors: 1, declined: 0, durationMs: 250 }]);
    expect(s.days.map((d) => d.usage.toolCalls)).toEqual([1]);
    expect(s.sessions[0].toolCalls).toBe(1);
  });

  it('aggregates file changes by kind', () => {
    const parsed = toolCallFromItem(
      toolItem('t5', {
        changes: [
          { path: 'a.ts', kind: 'update' },
          { path: 'a.ts', kind: 'update' },
          { path: 'b.ts', kind: 'add' },
          { path: 'c.ts', kind: 'delete' },
          { path: 'd.ts', kind: 'rename' }
        ]
      })
    );
    expect(parsed?.changes['a.ts']).toEqual({ adds: 0, updates: 2, deletes: 0, renames: 0 });
    expect(parsed?.changes['b.ts']).toEqual({ adds: 1, updates: 0, deletes: 0, renames: 0 });
    expect(parsed?.changes['c.ts']).toEqual({ adds: 0, updates: 0, deletes: 1, renames: 0 });
    expect(parsed?.changes['d.ts']).toEqual({ adds: 0, updates: 0, deletes: 0, renames: 1 });
  });

  it('records tool calls once per item id, into the tool/file/day buckets and session record', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const store = new AnalyticsStore(dir, { log });
    const m = meta('s1', 'native', usage({}), { updatedAt: t0 });
    await store.load([m]);
    const item = toolItem('x1', { name: 'Edit', changes: [{ path: 'src/x.ts', kind: 'update' }] });
    store.recordToolCall('s1', item, t0);
    store.recordToolCall('s1', item, t0); // same item id: deduped
    store.recordToolCall('s1', { ...item, id: 'x2', status: 'error' }, t0);
    store.recordToolCall('s1', toolItem('x3', { status: 'running' }), t0); // not finished: ignored
    await store.flush();

    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load([]);
    const s = fresh.summary(0, t0);
    expect(s.toolTotals.calls).toBe(2);
    expect(s.toolTotals.errors).toBe(1);
    expect(s.tools[0]).toMatchObject({ name: 'Edit', calls: 2 });
    expect(s.files.map((f) => f.path)).toEqual(['src/x.ts']);
    expect(s.days[0].usage.toolCalls).toBe(2);
    expect(s.sessions[0].toolCalls).toBe(2);
  });

  it('backfills per-tool stats from existing transcripts', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 8, 12);
    const store = new AnalyticsStore(dir, { log });
    const m = meta('old', 'pi', usage({}), { updatedAt: t0 });
    const transcript: TranscriptItem[] = [
      toolItem('a', { name: 'Read' }),
      toolItem('b', { name: 'Read', durationMs: 100 }),
      toolItem('c', { name: 'Bash', status: 'error', changes: [{ path: 'f.ts', kind: 'add' }] }),
      turn({ id: 't1', durationMs: 2_500 }),
      turn({ id: 't2', status: 'interrupted', durationMs: 9_000 })
    ];
    await store.load([m], async () => transcript);
    const s = store.summary(0, t0);
    // Completed turns only: interrupted wall time is ignored.
    expect(s.sessions[0].durationMs).toBe(2_500);
    expect(s.toolTotals.calls).toBe(3);
    expect(s.toolTotals.errors).toBe(1);
    expect(s.tools.map((t) => [t.name, t.calls])).toEqual([
      ['Read', 2],
      ['Bash', 1]
    ]);
    expect(s.files[0]).toMatchObject({ path: 'f.ts', adds: 1, total: 1 });
    expect(s.days[0].usage.toolCalls).toBe(3);
    // Snapshot preserved across a reload keeps its tool-call count.
    await store.load([m], async () => transcript);
    expect(store.summary(0, t0).toolTotals.calls).toBe(3);
  });
});
describe('per-dimension day slices', () => {
  it('attributes usage, turns and tool calls to the harness, model and project active at the time', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const store = new AnalyticsStore(dir, { log });
    const a = meta('a', 'claude', usage({}), { updatedAt: t0, activeModel: { provider: 'anthropic', model: 'opus' }, config: { harness: 'claude', permissionMode: 'ask', projectRoot: '/repo-a' } });
    const b = meta('b', 'pi', usage({}), { updatedAt: t0, activeModel: { provider: 'openrouter', model: 'glm' }, config: { harness: 'pi', permissionMode: 'ask', projectRoot: '/repo-b' } });
    await store.load([a, b]);
    store.recordUsage(a, usage({ costUsd: 1, turns: 1, inputTokens: 100 }), t0);
    store.recordUsage(b, usage({ costUsd: 2, turns: 2, inputTokens: 200 }), t0);
    // A live model switch: the next delta belongs to the new model, the harness total keeps growing.
    const a2 = { ...a, activeModel: { provider: 'anthropic', model: 'sonnet' } };
    store.recordUsage(a2, usage({ costUsd: 1.5, turns: 2, inputTokens: 150 }), t0);
    store.recordTurn(a2, turn({ durationMs: 2_000, usage: { outputTokens: 100 } }), t0);
    store.recordToolCall('b', { id: 'x1', kind: 'tool', ts: 1, name: 'bash', status: 'done', durationMs: 10, changes: [{ path: 'f.ts', kind: 'update' }] }, t0);
    // After the model switch the session's snapshot points at sonnet, so this error lands there.
    store.recordToolCall('a', { id: 'x2', kind: 'tool', ts: 1, name: 'edit', status: 'error', durationMs: 5 }, t0);
    // A model captured when the call began wins over a later session snapshot.
    store.recordToolCall('a', { id: 'x3', kind: 'tool', ts: 1, name: 'Bash', status: 'done' }, t0, { provider: 'anthropic', model: 'opus' });
    await store.flush();

    const fresh = new AnalyticsStore(dir, { log });
    await fresh.load([]);
    const s = fresh.summary(0, t0);
    const by = s.days[0].usage.by;
    expect(by?.harness.claude).toMatchObject({ costUsd: 1.5, turns: 2, inputTokens: 150, durationMs: 2_000, speedTokens: 100, speedMs: 2_000, sessions: ['a'] });
    expect(by?.harness.pi).toMatchObject({ costUsd: 2, turns: 2, toolCalls: 1, sessions: ['b'] });
    expect(by?.model['anthropic/opus']).toMatchObject({ costUsd: 1, turns: 1, toolCalls: 1, label: 'opus' });
    expect(by?.model['anthropic/sonnet']).toMatchObject({ costUsd: 0.5, turns: 1, label: 'sonnet', durationMs: 2_000 });
    expect(by?.project['/repo-b']?.toolCalls).toBe(1);
    expect(by?.tool.bash).toEqual({ calls: 1, errors: 0, declined: 0, durationMs: 10 });
    expect(by?.modelTool['openrouter/glm']?.bash).toEqual({ calls: 1, errors: 0, declined: 0, durationMs: 10 });
    expect(by?.modelTool['anthropic/sonnet']?.edit).toEqual({ calls: 1, errors: 1, declined: 0, durationMs: 5 });
    // The all-time per-model tool map survives the reload, keyed like the model slices.
    expect(s.modelTools.map((x) => [x.key, x.name, x.calls]).sort()).toEqual([
      ['anthropic/opus', 'bash', 1],
      ['anthropic/sonnet', 'edit', 1],
      ['openrouter/glm', 'bash', 1]
    ]);
    expect(s.modelTools.find((x) => x.key === 'anthropic/sonnet')).toMatchObject({ label: 'sonnet', errors: 1 });
    expect(by?.file['f.ts']).toEqual({ adds: 0, updates: 1, deletes: 0, renames: 0 });
    // The range rollup rebuilds the totals from the slices with nothing left over.
    const r = rollupDays(s.days);
    expect(r.totals.costUsd).toBeCloseTo(3.5);
    expect(r.totals.toolCalls).toBe(3);
    expect(r.unattributed.costUsd).toBe(0);
    expect(r.sessionIds.sort()).toEqual(['a', 'b']);
    expect(r.byModel.map((x) => x.key)).toEqual(['openrouter/glm', 'anthropic/opus', 'anthropic/sonnet']);
    expect(r.modelTools.map((x) => [x.key, x.name, x.calls])).toEqual([
      ['anthropic/opus', 'bash', 1],
      ['anthropic/sonnet', 'edit', 1],
      ['openrouter/glm', 'bash', 1]
    ]);
  });

  it('backfills pre-existing sessions into slices and reports the window before the range', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 20, 12);
    const old = meta('old', 'pi', usage({ costUsd: 4, turns: 8 }), { updatedAt: Date.UTC(2025, 5, 10, 12), activeModel: { provider: 'x', model: 'm' } });
    const store = new AnalyticsStore(dir, { log });
    await store.load([old]);
    const cur = meta('cur', 'pi', usage({}), { updatedAt: t0 });
    store.touchSession(cur);
    store.recordUsage(cur, usage({ costUsd: 1, turns: 1 }), t0);

    const week = store.summary(7, t0);
    expect(week.days.map((d) => d.date)).toEqual(['2025-06-20']);
    // June 10 falls in the seven days before the range: it is the comparison baseline, not part of it.
    expect(week.previous).toMatchObject({ costUsd: 4, turns: 8 });
    expect(store.summary(0, t0).previous).toBeUndefined();
    const oldDay = store.summary(0, t0).days.find((d) => d.date === '2025-06-10');
    expect(oldDay?.usage.by?.model['x/m']).toMatchObject({ costUsd: 4, turns: 8, label: 'm', sessions: ['old'] });
    expect(oldDay?.usage.by?.project['/repo']?.sessions).toEqual(['old']);
  });

  it('loads legacy days without slices and leaves their usage unattributed', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const legacy = { ...emptyDay(), costUsd: 1, turns: 1, toolCalls: 3 };
    await fs.writeFile(path.join(dir, 'analytics.json'), JSON.stringify({ version: 1, days: { '2025-06-08': legacy }, recorded: {}, sessions: {}, tools: {}, files: {} }));
    const store = new AnalyticsStore(dir, { log });
    const m = meta('s1', 'native', usage({}), { updatedAt: t0 });
    await store.load([m]);
    store.recordUsage(m, usage({ costUsd: 2, turns: 1 }), t0);
    const days = store.summary(0, t0).days;
    expect(days[0].usage.by).toBeUndefined();
    expect(days[1].usage.by?.harness.native).toMatchObject({ costUsd: 2, turns: 1, sessions: ['s1'] });
    const r = rollupDays(days);
    expect(r.totals.costUsd).toBeCloseTo(3);
    expect(r.unattributed).toMatchObject({ costUsd: 1, turns: 1, toolCalls: 3 });
    expect(r.byHarness).toHaveLength(1);
  });
});

describe('legacy day estimation', () => {
  it('splits totals proportionally, exactly for integer counters, with an even fallback for zero weights', () => {
    expect(apportion(10, [1, 1, 1], true)).toEqual([4, 3, 3]);
    expect(apportion(10, [1, 1, 1], true).reduce((a, b) => a + b, 0)).toBe(10);
    expect(apportion(3, [2, 1], false)).toEqual([2, 1]);
    expect(apportion(4, [0, 0], true)).toEqual([2, 2]);
    expect(apportion(0, [5, 5], true)).toEqual([0, 0]);
    expect(apportion(7, [], true)).toEqual([]);
  });

  it('reconstructs slices for pre-slice days from the sessions last active that day and shares tools and files by call volume', async () => {
    const dir = tmpDir();
    const t0 = Date.UTC(2025, 5, 9, 12);
    const rec = (id: string, harness: SessionMeta['config']['harness'], provider: string, model: string | undefined, projectRoot: string, u: UsageTotals, toolCalls: number, updatedAt: number, speed?: { tokens: number; ms: number }): UsageSessionRecord => ({ id, title: id, harness, provider, model, projectRoot, createdAt: updatedAt, updatedAt, usage: u, toolCalls, speed });
    const sessions = {
      a: rec('a', 'claude', 'anthropic', 'opus', '/p1', usage({ costUsd: 2, turns: 4, inputTokens: 200 }), 8, t0, { tokens: 60, ms: 2000 }),
      b: rec('b', 'pi', 'openrouter', 'glm', '/p2', usage({ costUsd: 1, turns: 2, inputTokens: 100 }), 2, t0 + 3600_000, { tokens: 30, ms: 1000 }),
      // Last active on another day: not a candidate for June 9.
      c: rec('c', 'pi', 'openrouter', 'glm', '/p2', usage({ costUsd: 9, turns: 9 }), 9, Date.UTC(2025, 5, 3, 12)),
      // Active that day but never used: carries no weight.
      d: rec('d', 'native', 'deepseek', 'chat', '/p1', usage({}), 0, t0)
    };
    const legacy = { ...emptyDay(), costUsd: 3, turns: 6, inputTokens: 300, toolCalls: 10, durationMs: 6000, speedTokens: 90, speedMs: 3000 };
    // A day that already has live slices keeps them; its tool counts are subtracted from the all-time map first.
    const live = { ...emptyDay(), costUsd: 1, turns: 1, toolCalls: 4 };
    const liveBy = { harness: { pi: { ...emptyDay(), costUsd: 1, turns: 1, toolCalls: 4, label: 'pi', sessions: ['c'] } }, model: {}, project: {}, tool: { bash: { calls: 4, errors: 0, declined: 0, durationMs: 0 } }, file: {} };
    const file = {
      version: 1,
      days: { '2025-06-09': legacy, '2025-06-01': { ...emptyDay(), costUsd: 5 }, '2025-06-10': { ...live, by: liveBy } },
      recorded: Object.fromEntries(Object.values(sessions).map((s) => [s.id, s.usage])),
      sessions,
      tools: { Bash: { calls: 14, errors: 1, declined: 0, durationMs: 0 } },
      files: { 'x.ts': { adds: 0, updates: 4, deletes: 0, renames: 0 } }
    };
    await fs.writeFile(path.join(dir, 'analytics.json'), JSON.stringify(file));
    const store = new AnalyticsStore(dir, { log });
    await store.load([]);
    const s = store.summary(0, t0);
    const day = s.days.find((d) => d.date === '2025-06-09')!.usage;
    expect(day.by?.estimated).toBe(true);
    expect(day.by?.harness.claude).toMatchObject({ costUsd: 2, turns: 4, inputTokens: 200, toolCalls: 8, durationMs: 4000, speedTokens: 60, speedMs: 2000, sessions: ['a'] });
    expect(day.by?.harness.pi).toMatchObject({ costUsd: 1, turns: 2, inputTokens: 100, toolCalls: 2, durationMs: 2000, sessions: ['b'] });
    expect(day.by?.harness.native).toBeUndefined();
    expect(day.by?.model['anthropic/opus']).toMatchObject({ costUsd: 2, label: 'opus' });
    expect(day.by?.project['/p2']).toMatchObject({ costUsd: 1, turns: 2 });
    // 14 Bash calls all time, 4 recorded live on June 10: the other 10 (and the lone error) land on the legacy day.
    expect(day.by?.tool.Bash).toEqual({ calls: 10, errors: 1, declined: 0, durationMs: 0 });
    expect(day.by?.file['x.ts']).toEqual({ adds: 0, updates: 4, deletes: 0, renames: 0 });
    // No session was last active on June 1, so it stays honestly unattributed.
    expect(s.days.find((d) => d.date === '2025-06-01')!.usage.by).toBeUndefined();
    const r = rollupDays(s.days);
    expect(r.totals.costUsd).toBeCloseTo(9);
    expect(r.unattributed.costUsd).toBeCloseTo(5);
    expect(r.estimatedDays).toBe(1);
    expect(r.byModel.map((b) => [b.key, b.usage.costUsd])).toEqual([
      ['anthropic/opus', 2],
      ['openrouter/glm', 1]
    ]);

    // The estimate is persisted and never repeated or doubled on the next load.
    const again = new AnalyticsStore(dir, { log });
    await again.load([]);
    const day2 = again.summary(0, t0).days.find((d) => d.date === '2025-06-09')!.usage;
    expect(day2.by?.estimated).toBe(true);
    expect(day2.by?.harness.claude?.costUsd).toBeCloseTo(2);
    expect(day2.by?.tool.Bash?.calls).toBe(10);
  });
});
