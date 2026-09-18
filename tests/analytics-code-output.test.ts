/**
 * Code output: the lines an agent wrote per million tokens spent, as the dashboard reads it. Runs
 * through the real ingest path — user message, tool call, turn verdict — so it covers what a turn
 * actually stores, which turns reach the rate, and what the report says it had to leave out.
 */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { codeOutputReport } from '../src/shared/analytics/code-output';
import type { ExecutionRecord, TurnRecord } from '../src/shared/analytics/records';
import type { FileChange, SessionMeta, TranscriptItem, UsageTotals } from '../src/shared/types';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});
function tmpDir(): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-code-out-'));
  dirs.push(d);
  return d;
}

const log = () => undefined;
const T0 = Date.parse('2026-09-10T10:00:00Z');
const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function meta(id: string, harness: SessionMeta['config']['harness'], model: { provider: string; model: string }): SessionMeta {
  return { id, title: id, createdAt: T0, updatedAt: T0, config: { harness, permissionMode: 'ask', projectRoot: '/repo' }, cwd: '/repo', status: 'idle', harnessRef: {}, usage: { ...ZERO }, activeModel: model };
}

/** A diff adding `n` lines to `file`, shaped the way the harnesses emit them. */
function diff(file: string, n: number): string {
  return `--- ${file}\n+++ ${file}\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')}\n`;
}

function edit(id: string, ts: number, adds: { path: string; lines: number }[], extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): Extract<TranscriptItem, { kind: 'tool' }> {
  const changes: FileChange[] = adds.map((a) => ({ path: a.path, kind: 'update', diff: diff(a.path, a.lines) }));
  return { id, kind: 'tool', ts, name: 'Edit', hint: 'edit', input: {}, status: 'done', changes, ...extra };
}

function readTool(id: string, ts: number): Extract<TranscriptItem, { kind: 'tool' }> {
  return { id, kind: 'tool', ts, name: 'Read', hint: 'read', input: { path: 'a.ts' }, output: 'contents', status: 'done' };
}

function usage(inputTokens: number, outputTokens: number, cacheReadTokens: number): Partial<UsageTotals> {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 };
}

/** One session whose turns are driven through the same calls the session manager makes. */
async function seed(dir: string): Promise<AnalyticsStore> {
  const store = new AnalyticsStore(dir, { log, executionLog: { platform: 'win32', release: '10.0' } });
  const m = meta('s1', 'claude', { provider: 'anthropic', model: 'opus' });
  await store.load([m]);
  const at = (n: number) => T0 + n * 1000;
  const user = (n: number) => store.recordUserMessage(m, { id: `u${n}`, kind: 'user', ts: at(n * 10), text: 'go' }, at(n * 10));

  // Turn 1: writes code — three lines in one call, two more from a subagent — and reports its cost.
  user(1);
  store.recordToolCall('s1', edit('t1a', at(11), [{ path: 'a.ts', lines: 3 }]), at(11));
  store.recordToolCall('s1', edit('t1b', at(12), [{ path: 'b.ts', lines: 2 }], { parentId: 'task-1' }), at(12));
  store.recordTurn(m, { id: 'turn1', kind: 'turn', ts: at(13), status: 'completed', durationMs: 3000, costUsd: 0.5, usage: usage(100, 100, 100) }, at(13));

  // Turn 2: answers a question and edits nothing; its tokens must not dilute the rate.
  user(2);
  store.recordToolCall('s1', readTool('t2a', at(21)), at(21));
  store.recordTurn(m, { id: 'turn2', kind: 'turn', ts: at(22), status: 'completed', durationMs: 1000, usage: usage(400, 400, 400) }, at(22));

  // Turn 3: writes code but the harness reported no token counters, so there is nothing to divide by.
  user(3);
  store.recordToolCall('s1', edit('t3a', at(31), [{ path: 'c.ts', lines: 5 }]), at(31));
  store.recordTurn(m, { id: 'turn3', kind: 'turn', ts: at(32), status: 'completed', durationMs: 1000 }, at(32));

  await store.flush();
  return store;
}

describe('code output', () => {
  it('rates the lines written by turns that reported their spend, and counts the turns it left out', async () => {
    const dir = tmpDir();
    const store = await seed(dir);
    const now = T0 + 60_000;
    const report = store.summary(30, now).codeOutput;

    // Only turn 1 both wrote code and reported tokens: 5 lines over 300 tokens.
    expect(report.overall.lines).toBe(5);
    expect(report.overall.tokens).toBe(300);
    expect(report.overall.turns).toBe(1);
    expect(report.overall.linesPerMTokens).toBeCloseTo((5 / 300) * 1_000_000, 6);
    expect(report.overall.costUsd).toBe(0.5);
    expect(report.overall.costPerKLine).toBeCloseTo(100, 6);
    expect(report.overall.costMeasured).toBe(true);
    expect(report.overall.sessions).toBe(1);

    // The subagent's two lines are reported as a share of the total, not subtracted from it.
    expect(report.overall.delegatedLines).toBe(2);
    expect(report.overall.inputTokens).toBe(100);
    expect(report.overall.outputTokens).toBe(100);
    expect(report.overall.cacheReadTokens).toBe(100);

    // Every turn lands in exactly one bucket, and the excluded ones say why.
    expect(report.coverage.turns).toBe(3);
    expect(report.coverage.countedTurns).toBe(1);
    expect(report.coverage.noCodeTurns).toBe(1);
    expect(report.coverage.noCodeTokens).toBe(1200);
    expect(report.coverage.unmeasuredTurns).toBe(1);
    expect(report.coverage.unmeasuredLines).toBe(5);
    expect(report.coverage.unknownLineTurns).toBe(0);

    // Slices carry the same rate, filed under the session's active model.
    expect(report.byHarness.map((r) => [r.key, r.lines, r.linesPerMTokens])).toEqual([['claude', 5, (5 / 300) * 1_000_000]]);
    expect(report.byModel.map((r) => [r.key, r.lines])).toEqual([['anthropic/opus', 5]]);
    expect(report.byHarnessModel.map((r) => [r.key, r.turns])).toEqual([['claude|anthropic/opus', 1]]);

    // The day series carries the rate on the day the turn started, and nothing on the others.
    const day = new Date(T0).toISOString().slice(0, 10);
    expect(report.trend.find((p) => p.date === day)?.linesPerMTokens).toBeCloseTo((5 / 300) * 1_000_000, 6);
    expect(report.trend.filter((p) => p.date !== day).every((p) => p.linesPerMTokens === null)).toBe(true);
  });

  it('reports the same rate after a reload, and leaves a harness without diffs out rather than counting it as zero', async () => {
    const dir = tmpDir();
    await seed(dir);
    const now = T0 + 60_000;

    const cursor = meta('s2', 'cursor', { provider: 'cursor', model: 'composer' });
    const store = new AnalyticsStore(dir, { log, executionLog: { platform: 'win32', release: '10.0' } });
    await store.load([meta('s1', 'claude', { provider: 'anthropic', model: 'opus' }), cursor]);
    // Cursor reports no inline diff: the change is known, what it added is not.
    store.recordUserMessage(cursor, { id: 'u1', kind: 'user', ts: T0 + 40_000, text: 'go' }, T0 + 40_000);
    store.recordToolCall('s2', { id: 'c1', kind: 'tool', ts: T0 + 41_000, name: 'edit_file', hint: 'edit', input: {}, status: 'done', changes: [{ path: 'x.ts', kind: 'update' }] }, T0 + 41_000);
    store.recordTurn(cursor, { id: 'turn1', kind: 'turn', ts: T0 + 42_000, status: 'completed', durationMs: 1000, usage: usage(1000, 1000, 0) }, T0 + 42_000);

    const before = store.summary(30, now).codeOutput;
    expect(before.coverage.unknownLineTurns).toBe(1);
    // Its 2000 tokens are in no rate, and it is not filed under any slice.
    expect(before.overall.tokens).toBe(300);
    expect(before.byHarness.map((r) => r.key)).toEqual(['claude']);

    await store.flush();
    const again = new AnalyticsStore(dir, { log, executionLog: { platform: 'win32', release: '10.0' } });
    await again.load([meta('s1', 'claude', { provider: 'anthropic', model: 'opus' }), cursor]);
    expect(again.summary(30, now).codeOutput).toEqual(before);
  });

  it('leaves a rate undefined rather than infinite when a turn cost money but reported no counters', () => {
    const turn = (id: string, n: number, costUsd: number, tokens?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): TurnRecord => ({
      v: 3,
      id: `${id}:turn:${n}`,
      sessionId: id,
      turn: n,
      harness: 'claude',
      model: 'anthropic/opus',
      projectRoot: '/repo',
      startTs: T0,
      status: 'completed',
      ingest: 'live',
      usage: tokens ? { ...tokens, costUsd } : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd }
    });
    const record = (sessionId: string, turnNumber: number, addedLines: number, role: 'parent' | 'subagent' = 'parent'): ExecutionRecord =>
      ({ v: 3, id: `${sessionId}:t${turnNumber}`, sessionId, ts: T0, endTs: T0, harness: 'claude', role, projectRoot: '/repo', os: 'win32', turn: turnNumber, ingest: 'live', facts: {} as ExecutionRecord['facts'], derived: {} as ExecutionRecord['derived'], addedLines });

    const report = codeOutputReport(
      [record('a', 1, 4), record('a', 2, 10), record('b', 1, 0)],
      [turn('a', 1, 0.2, { inputTokens: 500, outputTokens: 500, cacheReadTokens: 1000, cacheWriteTokens: 0 }), turn('a', 2, 1), turn('b', 1, 0.1, { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })],
      { now: T0 + 1000, rangeDays: 30, retention: { maxRecords: 100, maxDays: 90 } }
    );

    // The cost-only turn has no tokens to divide by, so it is unmeasured, never a free turn.
    expect(report.overall.turns).toBe(1);
    expect(report.overall.linesPerMTokens).toBeCloseTo((4 / 2000) * 1_000_000, 6);
    expect(report.coverage.unmeasuredTurns).toBe(1);
    expect(report.coverage.unmeasuredLines).toBe(10);
    expect(report.coverage.noCodeTurns).toBe(1);
    // Cost per 1000 lines is computed from the turns that reported a cost, and says so.
    expect(report.overall.costPerKLine).toBeCloseTo(50, 6);
    expect(report.overall.costMeasured).toBe(true);

    const noCost = codeOutputReport([record('a', 1, 4)], [turn('a', 1, 0, { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })], { now: T0 + 1000, rangeDays: 30, retention: { maxRecords: 100, maxDays: 90 } });
    expect(noCost.overall.costMeasured).toBe(false);
    expect(noCost.overall.costPerKLine).toBeNull();
  });
});
