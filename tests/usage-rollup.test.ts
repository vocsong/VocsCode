/** Unit tests for the shared usage rollups: range buckets from day slices, the unattributed remainder and chart series. */
import { describe, expect, it } from 'vitest';
import type { AnalyticsDayPoint, UsageDay } from '../src/shared/types';
import { addCounters, addSlice, dimensionSeries, emptyCounters, emptyDimensions, fillDays, rollupDays, speedTps } from '../src/shared/usage-rollup';

interface Row {
  id: string;
  harness: string;
  model?: string;
  project: string;
  costUsd: number;
  turns?: number;
  toolCalls?: number;
  speed?: [tokens: number, ms: number];
}

function day(partial: Partial<UsageDay> = {}): UsageDay {
  return { ...emptyCounters(), ...partial };
}

/** A day whose totals are fully explained by its slices, the way the store writes them. */
function sliced(date: string, rows: Row[]): AnalyticsDayPoint {
  const usage = day();
  const by = emptyDimensions();
  for (const r of rows) {
    const delta = { costUsd: r.costUsd, turns: r.turns ?? 0, toolCalls: r.toolCalls ?? 0, inputTokens: 1000, speedTokens: r.speed?.[0] ?? 0, speedMs: r.speed?.[1] ?? 0 };
    addCounters(usage, delta);
    addSlice(by.harness, r.harness, r.harness, delta, r.id);
    if (r.model) addSlice(by.model, `p/${r.model}`, r.model, delta, r.id);
    addSlice(by.project, r.project, r.project, delta, r.id);
  }
  usage.by = by;
  return { date, usage };
}

describe('addSlice', () => {
  it('creates the slice on first sight, dedupes session ids and refreshes the label', () => {
    const map = {};
    addSlice(map, 'k', 'old', { costUsd: 1 }, 's1');
    addSlice(map, 'k', 'new', { costUsd: 2, turns: 1 }, 's1');
    addSlice(map, 'k', 'new', { costUsd: -5 }, 's2');
    expect(map).toEqual({ k: { ...emptyCounters(), costUsd: 3, turns: 1, label: 'new', sessions: ['s1', 's2'] } });
  });
});

describe('rollupDays', () => {
  const days = [
    sliced('2025-06-01', [
      { id: 'a', harness: 'claude', model: 'opus', project: '/p1', costUsd: 2, turns: 4, toolCalls: 6, speed: [100, 2000] },
      { id: 'b', harness: 'pi', model: 'glm', project: '/p2', costUsd: 1, turns: 2 }
    ]),
    sliced('2025-06-02', [{ id: 'a', harness: 'claude', model: 'opus', project: '/p1', costUsd: 3, turns: 2, speed: [100, 8000] }])
  ];
  days[1].usage.by!.tool = { Bash: { calls: 3, errors: 1, declined: 0, durationMs: 300 } };
  days[0].usage.by!.tool = { Bash: { calls: 2, errors: 0, declined: 1, durationMs: 0 }, Read: { calls: 4, errors: 0, declined: 0, durationMs: 0 } };
  days[0].usage.by!.file = { 'a.ts': { adds: 1, updates: 2, deletes: 0, renames: 0 } };
  days[1].usage.by!.file = { 'a.ts': { adds: 0, updates: 1, deletes: 0, renames: 0 }, 'b.ts': { adds: 0, updates: 0, deletes: 0, renames: 0 } };

  it('sums the totals and builds spend-sorted buckets with distinct session counts', () => {
    const r = rollupDays(days);
    expect(r.totals.costUsd).toBeCloseTo(6);
    expect(r.totals.turns).toBe(8);
    expect(r.sessionIds.sort()).toEqual(['a', 'b']);
    expect(r.byModel.map((b) => [b.key, b.label, b.usage.costUsd, b.sessions])).toEqual([
      ['p/opus', 'opus', 5, 1],
      ['p/glm', 'glm', 1, 1]
    ]);
    expect(r.byHarness[0]).toMatchObject({ key: 'claude', toolCalls: 6, speed: { tokens: 200, ms: 10_000 } });
    expect(r.byProject.map((b) => b.key)).toEqual(['/p1', '/p2']);
    expect(Object.values(r.unattributed).every((v) => v === 0)).toBe(true);
  });

  it('merges per-tool and per-file slices across days, dropping files with no changes', () => {
    const r = rollupDays(days);
    expect(r.tools.map((t) => [t.name, t.calls, t.errors, t.declined])).toEqual([
      ['Bash', 5, 1, 1],
      ['Read', 4, 0, 0]
    ]);
    expect(r.toolTotals).toEqual({ calls: 9, errors: 1, declined: 1, durationMs: 300 });
    expect(r.files).toEqual([{ path: 'a.ts', adds: 1, updates: 3, deletes: 0, renames: 0, total: 4 }]);
  });

  it('keeps days recorded before slices existed in the totals and reports them as unattributed', () => {
    const legacy: AnalyticsDayPoint = { date: '2025-05-30', usage: day({ costUsd: 4, turns: 10, toolCalls: 7 }) };
    const r = rollupDays([legacy, ...days]);
    expect(r.totals.costUsd).toBeCloseTo(10);
    expect(r.unattributed).toMatchObject({ costUsd: 4, turns: 10, toolCalls: 7 });
    expect(r.byModel.reduce((a, b) => a + b.usage.costUsd, 0)).toBeCloseTo(6);
    // The day counters (6 + 7) exceed the per-tool rows (9), so the total follows the day counters.
    expect(r.toolTotals.calls).toBe(13);
    expect(r.estimatedDays).toBe(0);
    days[0].usage.by!.estimated = true;
    expect(rollupDays(days).estimatedDays).toBe(1);
    delete days[0].usage.by!.estimated;
  });
});

describe('dimensionSeries', () => {
  const days = [
    sliced('2025-06-01', [
      { id: 'a', harness: 'claude', model: 'm1', project: '/p', costUsd: 5 },
      { id: 'b', harness: 'pi', model: 'm2', project: '/p', costUsd: 3 },
      { id: 'c', harness: 'pi', model: 'm3', project: '/p', costUsd: 1 }
    ]),
    sliced('2025-06-02', [
      { id: 'a', harness: 'claude', model: 'm1', project: '/p', costUsd: 1 },
      { id: 'd', harness: 'native', model: 'm4', project: '/p', costUsd: 2 }
    ])
  ];

  it('ranks entities over the whole range and folds the tail into Other', () => {
    const s = dimensionSeries(days, 'model', (c) => c.costUsd, 2);
    expect(s.series.map((x) => [x.key, x.label, x.values])).toEqual([
      ['p/m1', 'm1', [5, 1]],
      ['p/m2', 'm2', [3, 0]]
    ]);
    expect(s.other).toEqual([1, 2]);
    expect(s.unattributed).toBeUndefined();
  });

  it('honours a fixed order for harnesses and omits Other when nothing was folded', () => {
    const s = dimensionSeries(days, 'harness', (c) => c.costUsd, 6, ['claude', 'codex', 'codex-exec', 'cursor', 'pi', 'acp', 'native']);
    expect(s.series.map((x) => x.key)).toEqual(['claude', 'pi', 'native']);
    expect(s.other).toBeUndefined();
  });

  it('reports the per-day remainder that no slice explains', () => {
    const legacy: AnalyticsDayPoint = { date: '2025-05-31', usage: day({ costUsd: 4 }) };
    const s = dimensionSeries([legacy, ...days], 'model', (c) => c.costUsd, 5);
    expect(s.unattributed).toEqual([4, 0, 0]);
    expect(s.series[0].values).toEqual([0, 5, 1]);
  });

  it('drops entities whose metric is zero across the range', () => {
    const s = dimensionSeries(days, 'model', (c) => c.toolCalls, 5);
    expect(s.series).toEqual([]);
    expect(s.other).toBeUndefined();
  });
});

describe('speedTps', () => {
  it('reads both sample shapes and returns null without a sample', () => {
    expect(speedTps({ tokens: 100, ms: 2000 })).toBeCloseTo(50);
    expect(speedTps({ speedTokens: 300, speedMs: 1000 })).toBeCloseTo(300);
    expect(speedTps({ tokens: 0, ms: 0 })).toBeNull();
    expect(speedTps(undefined)).toBeNull();
  });
});

describe('fillDays', () => {
  it('produces a continuous UTC calendar with empty counters for quiet days', () => {
    const start = Date.UTC(2025, 5, 1, 5);
    const end = Date.UTC(2025, 5, 4, 23);
    const out = fillDays([{ date: '2025-06-02', usage: day({ costUsd: 1 }) }, { date: '2025-05-20', usage: day({ costUsd: 9 }) }], start, end);
    expect(out.map((d) => d.date)).toEqual(['2025-06-01', '2025-06-02', '2025-06-03', '2025-06-04']);
    expect(out.map((d) => d.usage.costUsd)).toEqual([0, 1, 0, 0]);
    // A single-day window is one day.
    expect(fillDays([], start, start)).toHaveLength(1);
  });
});

describe('dimensionSeries with a dashboard-wide order', () => {
  const days = [
    sliced('2025-06-01', [
      { id: 'a', harness: 'claude', model: 'cheap-but-busy', project: '/p', costUsd: 1, turns: 50 },
      { id: 'b', harness: 'pi', model: 'pricey', project: '/p', costUsd: 9, turns: 2 },
      { id: 'c', harness: 'pi', model: 'stranger', project: '/p', costUsd: 2, turns: 30 }
    ])
  ];
  it('ranks by the given order rather than the metric and folds unknown entities into Other', () => {
    const s = dimensionSeries(days, 'model', (c) => c.turns, 5, ['p/pricey', 'p/cheap-but-busy'], true);
    expect(s.series.map((x) => x.key)).toEqual(['p/pricey', 'p/cheap-but-busy']);
    expect(s.other).toEqual([30]);
  });
});
