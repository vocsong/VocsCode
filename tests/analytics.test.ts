/** Unit tests for the analytics usage store: deltas, day buckets, backfill and summary rollups. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { addDay, AnalyticsStore, dayKey, emptyDay, summarize, toolCallFromItem, usageDelta } from '../src/main/analytics';
import { emptyUsage } from '../src/main/models/static-models';
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
    const files = { 'src/a.ts': { adds: 1, updates: 3, deletes: 0, renames: 0 }, 'src/b.ts': { adds: 2, updates: 0, deletes: 1, renames: 0 } };
    const s = summarize(sessions, {}, tools, files, 0, 0);
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
    expect(s.files[0]).toMatchObject({ path: 'src/a.ts', total: 4 });
  });

  it('filters days to the requested range and reports active days', () => {
    const now = Date.UTC(2025, 5, 10);
    const days = {
      '2025-06-09': { ...emptyDay(), costUsd: 1 },
      '2025-06-02': { ...emptyDay(), costUsd: 2 },
      '2025-05-01': { ...emptyDay(), costUsd: 4 }
    };
    const s = summarize([], days, {}, {}, 7, now);
    expect(s.days.map((d) => d.date)).toEqual(['2025-06-09']);
    const all = summarize([], days, {}, {}, 0, now);
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
    store.recordTurn(m, 4_000, t0);
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
      toolItem('c', { name: 'Bash', status: 'error', changes: [{ path: 'f.ts', kind: 'add' }] })
    ];
    await store.load([m], async () => transcript);
    const s = store.summary(0, t0);
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