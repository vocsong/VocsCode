/**
 * The execution log store: append and reload, dedupe, reclassification on a classifier bump,
 * retention, transcript backfill with turns, model attribution and write-failure recovery.
 */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AnalyticsStore } from '../src/main/analytics';
import { ExecutionLog, type ExecutionContext, type TurnItem } from '../src/main/analytics-executions';
import type { ExecutionRecord } from '../src/shared/analytics/records';
import { OUTCOME_CLASSIFIER_VERSION } from '../src/shared/analytics/taxonomy';
import type { FileChange, SessionMeta, TranscriptItem, UsageTotals } from '../src/shared/types';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});
function tmpDir(): string {
  const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vocs-exec-log-'));
  dirs.push(d);
  return d;
}

const log = () => undefined;
const T0 = Date.parse('2026-09-10T10:00:00Z');
const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 };

function ctx(over: Partial<ExecutionContext> = {}): ExecutionContext {
  return { harness: 'pi', projectRoot: '/repo', activeModel: { provider: 'p', model: 'm' }, ingest: 'live', now: T0 + 100, ...over };
}

function tool(id: string, command: string, output: string | undefined, status: 'done' | 'error' | 'declined' | 'running' = output === undefined ? 'done' : 'error', extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): Extract<TranscriptItem, { kind: 'tool' }> {
  return { id, kind: 'tool', ts: T0, name: 'bash', hint: 'execute', input: { command }, output, status, ...extra };
}

function meta(id: string, harness: SessionMeta['config']['harness'], model?: { provider: string; model: string }): SessionMeta {
  return { id, title: id, createdAt: T0, updatedAt: T0, config: { harness, permissionMode: 'ask', projectRoot: '/repo' }, cwd: '/repo', status: 'idle', harnessRef: {}, usage: { ...ZERO }, activeModel: model };
}

describe('ExecutionLog', () => {
  it('records each finished call once, persists it and reloads it with the same classification', async () => {
    const dir = tmpDir();
    const a = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0', arch: 'x64' });
    await a.load();
    expect(a.recordTool('s1', tool('t1', 'rg foo src', undefined, 'running'), ctx())).toBeNull();
    const r = a.recordTool('s1', tool('t1', 'rg foo src', 'Command exited with code 1'), ctx())!;
    expect(r).toMatchObject({ id: 's1:t1', harness: 'pi', model: 'p/m', role: 'parent', os: 'win32-10.0', arch: 'x64', turn: 0, ingest: 'live', endTs: T0 + 100 });
    expect(r.derived).toMatchObject({ outcome: 'informational', category: 'search_no_match' });
    expect(a.recordTool('s1', tool('t1', 'rg foo src', 'Command exited with code 1'), ctx())).toBeNull();
    expect(a.version).toBe(1);
    await a.flush();

    const b = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await b.load();
    expect(b.all()).toHaveLength(1);
    expect(b.all()[0]).toEqual(r);
    // The reloaded log still refuses the same id.
    expect(b.recordTool('s1', tool('t1', 'rg foo src', 'Command exited with code 1'), ctx())).toBeNull();
  });

  it('measures added lines from the call diff, never crediting a rename and never guessing a missing one', async () => {
    const dir = tmpDir();
    const a = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await a.load();
    const change = (file: string, diff: string | undefined, kind: FileChange['kind'] = 'update'): FileChange => ({ path: file, kind, ...(diff === undefined ? {} : { diff }) });
    const record = (id: string, changes: FileChange[]) => a.recordTool('s1', { ...tool(id, 'edit', undefined), name: 'Edit', changes }, ctx())!;

    // A modification is a removed line plus its replacement, so the diff counts both as added output.
    expect(record('t1', [change('a.ts', '--- a.ts\n+++ a.ts\n@@ -1,2 +1,3 @@\n-gone\n+new\n+extra\n')]).addedLines).toBe(2);
    // The +++ header is a header, not code.
    expect(record('t2', [change('b.ts', '--- b.ts\n+++ b.ts\n@@ -0,0 +1,1 @@\n+one\n')]).addedLines).toBe(1);
    // Removing code adds nothing, however many lines it removes.
    expect(record('t3', [change('c.ts', '--- c.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n', 'delete')]).addedLines).toBe(0);
    // A move is a delete plus an add of identical content; crediting it would count the code twice.
    expect(record('t4', [change('d.ts', '--- d.ts\n+++ e.ts\n@@ -1,2 +1,2 @@\n-x\n-y\n+x\n+y\n', 'rename')]).addedLines).toBe(0);
    // A change the harness could not diff is unmeasured, not zero.
    expect(record('t5', [change('e.ts', undefined)]).addedLines).toBeUndefined();
    // One undiffable change leaves the whole call unmeasured rather than silently undercounting it.
    expect(record('t6', [change('f.ts', '--- f.ts\n+++ f.ts\n@@ -0,0 +1,1 @@\n+one\n'), change('g.ts', undefined)]).addedLines).toBeUndefined();
    // A call that touched no file wrote nothing.
    expect(a.recordTool('s1', tool('t7', 'ls', undefined), ctx())!.addedLines).toBe(0);

    await a.flush();
    const b = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await b.load();
    expect(b.all().find((r) => r.id === 's1:t1')?.addedLines).toBe(2);
    expect(b.all().find((r) => r.id === 's1:t5')?.addedLines).toBeUndefined();
  });

  it('stores the turn token facts the harness reported and leaves an unreported turn unmeasured', async () => {
    const dir = tmpDir();
    const a = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await a.load();
    const turn = (n: number, item: Partial<TurnItem>) => {
      a.recordUser('s1', { id: `u${n}`, kind: 'user', ts: T0 + n * 1000, text: 'go' }, ctx({ now: T0 + n * 1000 }));
      return a.recordTurn('s1', { id: `turn${n}`, kind: 'turn', ts: T0 + n * 1000 + 500, status: 'completed', ...item }, ctx({ now: T0 + n * 1000 + 500 }));
    };

    expect(turn(1, { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }, costUsd: 0.5 }).usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.5 });
    // A harness that reports no counters (ACP) leaves the turn unmeasured rather than free.
    expect(turn(2, {}).usage).toBeUndefined();
    // Reported zeros are not a measurement either: there would be no tokens to divide by.
    expect(turn(3, { usage: ZERO }).usage).toBeUndefined();
    // Cost without any tokens still counts as something the turn cost.
    expect(turn(4, { costUsd: 0.25 }).usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 });

    await a.flush();
    const b = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await b.load();
    expect(b.allTurns().find((t) => t.turn === 1)?.usage?.outputTokens).toBe(20);
    expect(b.allTurns().find((t) => t.turn === 2)?.usage).toBeUndefined();
  });

  it('re-derives outcomes from stored facts when the classifier version moves, and rewrites the file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'analytics-executions.jsonl');
    const a = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await a.load();
    a.recordTool('s1', tool('t1', 'rg foo src', 'Command exited with code 1'), ctx());
    await a.flush();
    // Simulate a record written by an older classifier that called this an unexpected failure.
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    const stale = JSON.parse(lines[0]) as { derived: ExecutionRecord['derived'] };
    stale.derived = { outcome: 'failure', category: 'unknown_failure', source: 'unknown', signature: 'old', method: 'unknown', confidence: 'low', classifier: 0 };
    await fs.writeFile(file, `${JSON.stringify(stale)}\n${lines[0]}\n`, 'utf8');
    await fs.writeFile(path.join(dir, 'analytics-executions.meta.json'), JSON.stringify({ version: 2, classifierVersion: 0, backfilled: {} }), 'utf8');

    const b = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await b.load();
    expect(b.all()).toHaveLength(1);
    expect(b.all()[0].derived).toMatchObject({ outcome: 'informational', category: 'search_no_match', classifier: OUTCOME_CLASSIFIER_VERSION });
    await b.flush();
    const rewritten = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(rewritten).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'analytics-executions.meta.json'), 'utf8')).classifierVersion).toBe(OUTCOME_CLASSIFIER_VERSION);
  });

  it('applies retention by age and by count on load', async () => {
    const dir = tmpDir();
    const a = new ExecutionLog(dir, { log, platform: 'linux', release: '6', retention: { maxRecords: 3, maxDays: 30 } });
    await a.load();
    const now = T0 + 40 * 86_400_000;
    a.recordTool('s1', { ...tool('old', 'ls', undefined), ts: T0 }, ctx({ now: T0 }));
    for (let i = 0; i < 5; i++) a.recordTool('s1', { ...tool(`n${i}`, 'ls', undefined), ts: now - i * 1000 }, ctx({ now }));
    await a.flush();
    const b = new ExecutionLog(dir, { log, platform: 'linux', release: '6', retention: { maxRecords: 3, maxDays: 30 } });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await b.load();
    } finally {
      vi.useRealTimers();
    }
    expect(b.all().map((r) => r.id)).toEqual(['s1:n2', 's1:n1', 's1:n0']);
    expect(b.retainedFirstTs()).toBe(now - 2000);
  });

  it('replays a transcript in order so calls land in their turns and legacy items are marked', async () => {
    const dir = tmpDir();
    const a = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await a.load();
    const items: TranscriptItem[] = [
      { id: 'u1', kind: 'user', ts: T0, text: 'do it' },
      { ...tool('a', 'rg x src', 'Command exited with code 1'), ts: T0 + 1000 },
      { ...tool('b', 'legacy', undefined, 'error'), ts: T0 + 2000 },
      { id: 'turn1', kind: 'turn', ts: T0 + 3000, status: 'completed', durationMs: 3000 },
      { id: 'u2', kind: 'user', ts: T0 + 4000, text: 'again' },
      { ...tool('c', 'ls', undefined), ts: T0 + 5000 },
      { id: 'turn2', kind: 'turn', ts: T0 + 6000, status: 'failed' }
    ];
    // Out of order on disk: the replay sorts by timestamp.
    const count = a.backfillTranscript('s1', [items[5], items[0], items[3], items[1], items[6], items[2], items[4]], { harness: 'pi', projectRoot: '/repo', activeModel: { provider: 'p', model: 'm' } });
    expect(count).toBe(3);
    const byId = new Map(a.all().map((r) => [r.id, r]));
    expect(byId.get('s1:a')).toMatchObject({ turn: 1, ingest: 'backfill', endTs: T0 + 1000, derived: { category: 'search_no_match' } });
    expect(byId.get('s1:b')).toMatchObject({ turn: 1, derived: { category: 'legacy_unclassified', outcome: 'unknown' } });
    expect(byId.get('s1:c')).toMatchObject({ turn: 2 });
    expect(a.allTurns().map((t) => [t.id, t.status, t.startTs, t.endTs])).toEqual([
      ['s1:turn:1', 'completed', T0, T0 + 3000],
      ['s1:turn:2', 'failed', T0 + 4000, T0 + 6000]
    ]);
    await a.markBackfilled('s1', count);
    expect(a.isBackfilled('s1')).toBe(true);
    const b = new ExecutionLog(dir, { log, platform: 'win32', release: '10.0' });
    await b.load();
    expect(b.isBackfilled('s1')).toBe(true);
    expect(b.allTurns()).toHaveLength(2);
    // A live call after reload continues in the next turn once a new user message arrives.
    b.recordUser('s1', { id: 'u3', kind: 'user', ts: T0 + 7000, text: 'more' }, ctx({ now: T0 + 7000 }));
    expect(b.recordTool('s1', { ...tool('d', 'ls', undefined), ts: T0 + 8000 }, ctx({ now: T0 + 8000 }))!.turn).toBe(3);
    // A queued steer does not open a turn while one is running.
    expect(b.recordUser('s1', { id: 'u4', kind: 'user', ts: T0 + 9000, text: 'steer', queuedAs: 'steer' }, ctx())).toBeNull();
  });

  it('22 · charges a Claude subagent call to the generating model and keeps the parent model', async () => {
    const a = new ExecutionLog(tmpDir(), { log, platform: 'win32', release: '10.0' });
    await a.load();
    const c = ctx({ harness: 'claude', activeModel: { provider: 'anthropic', model: 'claude-opus-5' }, model: { provider: 'anthropic', model: 'claude-opus-5' } });
    const parent = a.recordTool('s1', { ...tool('p', 'ls', undefined), name: 'Bash', model: 'claude-opus-5' }, c)!;
    const sub = a.recordTool('s1', { ...tool('s', 'ls', undefined), name: 'Bash', model: 'claude-haiku-4-5', parentId: 'p' }, c)!;
    expect(parent).toMatchObject({ model: 'anthropic/claude-opus-5', role: 'parent' });
    expect(parent.parentModel).toBeUndefined();
    expect(sub).toMatchObject({ model: 'anthropic/claude-haiku-4-5', parentModel: 'anthropic/claude-opus-5', role: 'subagent' });
    // pi's delegated runs become weighted summaries, never N errors.
    const run = a.recordSubagent('s1', { agentId: 'ag1', status: 'error', toolUses: 12, model: { provider: 'p', model: 'sub' }, error: 'boom' }, ctx())!;
    expect(run).toMatchObject({ weight: 12, role: 'subagent', model: 'p/sub', parentModel: 'p/m', derived: { category: 'subagent_failed' } });
    expect(a.recordSubagent('s1', { agentId: 'ag1', status: 'error', toolUses: 12 }, ctx())).toBeNull();
    expect(a.recordSubagent('s1', { agentId: 'ag2', status: 'aborted', toolUses: 2 }, ctx())!.derived).toMatchObject({ outcome: 'control', category: 'cancelled' });
  });

  it('keeps unwritten lines after a failed append and writes them on the next flush', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'analytics-executions.jsonl');
    const warnings: string[] = [];
    const a = new ExecutionLog(dir, { log: (level, m) => level === 'warn' && warnings.push(m), platform: 'linux', release: '6' });
    await a.load();
    // A directory in the file's place makes the append fail.
    await fs.mkdir(file);
    a.recordTool('s1', tool('t1', 'ls', undefined), ctx());
    await a.flush();
    expect(warnings.some((w) => w.includes('append failed'))).toBe(true);
    await fs.rmdir(file);
    a.recordTool('s1', tool('t2', 'ls', undefined), ctx());
    await a.flush();
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['s1:t1', 's1:t2']);
  });

  it('queries by id, signature and session, most recent first, bounded', async () => {
    const a = new ExecutionLog(tmpDir(), { log, platform: 'win32', release: '10.0' });
    await a.load();
    a.recordTool('s1', { ...tool('a', 'foo', '/usr/bin/bash: line 1: foo: command not found\n\nCommand exited with code 127'), ts: T0 }, ctx());
    a.recordTool('s2', { ...tool('b', 'foo', '/usr/bin/bash: line 1: foo: command not found\n\nCommand exited with code 127'), ts: T0 + 1000 }, ctx());
    a.recordTool('s2', { ...tool('c', 'ls', undefined), ts: T0 + 2000 }, ctx());
    expect(a.query({ signature: 'bash | command_not_found | foo' }).map((r) => r.id)).toEqual(['s2:b', 's1:a']);
    expect(a.query({ signature: 'bash | command_not_found | foo', limit: 1 }).map((r) => r.id)).toEqual(['s2:b']);
    expect(a.query({ sessionId: 's2' }).map((r) => r.id)).toEqual(['s2:c', 's2:b']);
    expect(a.query({ ids: ['s1:a', 'nope'] }).map((r) => r.id)).toEqual(['s1:a']);
    expect(a.query({ sessionId: 's2', days: 1 }, T0 + 3 * 86_400_000)).toEqual([]);
  });
});

describe('AnalyticsStore with the execution log', () => {
  it('files live tool calls, user turns and subagent runs into the log and exposes the reliability report', async () => {
    const dir = tmpDir();
    const store = new AnalyticsStore(dir, { log, executionLog: { platform: 'win32', release: '10.0' } });
    const m = meta('s1', 'pi', { provider: 'p', model: 'm' });
    await store.load([m]);
    store.noteHarnessVersion('pi', '0.85.1');
    store.recordUserMessage(m, { id: 'u1', kind: 'user', ts: T0, text: 'go' }, T0);
    store.recordToolCall('s1', { ...tool('a', 'rg x src', 'Command exited with code 1'), ts: T0 + 1000 }, T0 + 1100, { provider: 'p', model: 'm' });
    store.recordToolCall('s1', { ...tool('b', 'foo', '/usr/bin/bash: line 1: foo: command not found\n\nCommand exited with code 127'), ts: T0 + 2000 }, T0 + 2100);
    store.recordToolCall('s1', { ...tool('c', 'foo --ok', undefined), ts: T0 + 3000 }, T0 + 3100);
    store.recordTurn(m, { id: 'turn1', kind: 'turn', ts: T0 + 4000, status: 'completed', durationMs: 4000 }, T0 + 4000);
    // An unknown session is never filed under a guessed harness.
    store.recordToolCall('ghost', tool('z', 'ls', undefined), T0 + 5000);
    await store.flush();

    const records = store.executions.all();
    expect(records.map((r) => [r.id, r.turn, r.harnessVersion, r.derived.outcome])).toEqual([
      ['s1:a', 1, '0.85.1', 'informational'],
      ['s1:b', 1, '0.85.1', 'failure'],
      ['s1:c', 1, '0.85.1', 'success']
    ]);
    const summary = store.summary(30, T0 + 5000);
    expect(summary.reliability.overall.counts).toMatchObject({ executed: 3, informational: 1, failure: 1, success: 1 });
    expect(summary.reliability.overall.incidents).toMatchObject({ incidents: 1, recovered: 1 });
    expect(summary.reliability.turns).toMatchObject({ closed: 1, completed: 1, completedWithFailure: 1 });
    expect(summary.reliability.byHarnessVersion.map((r) => r.key)).toEqual(['pi@0.85.1']);
    // The legacy per-tool counters still count the raw error statuses (and, as before, the unknown session's call).
    expect(summary.toolTotals).toMatchObject({ calls: 4, errors: 2 });
    expect(store.queryExecutions({ signature: 'bash | command_not_found | foo' }).map((r) => r.id)).toEqual(['s1:b']);

    // A restart with the same directory keeps everything and does not replay the transcript twice.
    const again = new AnalyticsStore(dir, { log, executionLog: { platform: 'win32', release: '10.0' } });
    await again.load([m], async () => [tool('a', 'rg x src', 'Command exited with code 1')]);
    await again.whenBackfilled();
    expect(again.executions.all()).toHaveLength(3);
    expect(again.summary(30, T0 + 5000).reliability.byHarnessVersion[0].counts.executed).toBe(3);
  });

  it('backfills transcripts of sessions that predate the log once, marking them as backfill', async () => {
    const dir = tmpDir();
    const transcript: TranscriptItem[] = [
      { id: 'u1', kind: 'user', ts: T0, text: 'go' },
      { ...tool('a', 'rg x src', 'Command exited with code 1'), ts: T0 + 1000 },
      { ...tool('b', 'ls', undefined), ts: T0 + 2000 },
      { id: 'turn1', kind: 'turn', ts: T0 + 3000, status: 'completed' }
    ];
    const reads: string[] = [];
    const store = new AnalyticsStore(dir, { log, executionLog: { platform: 'win32', release: '10.0' } });
    await store.load([meta('s1', 'claude', { provider: 'anthropic', model: 'opus' })], async (id) => {
      reads.push(id);
      return transcript;
    });
    await store.whenBackfilled();
    expect(store.executions.all().map((r) => [r.id, r.ingest, r.turn, r.model])).toEqual([
      ['s1:a', 'backfill', 1, 'anthropic/opus'],
      ['s1:b', 'backfill', 1, 'anthropic/opus']
    ]);
    expect(store.summary(0, T0 + 4000).reliability.coverage).toMatchObject({ backfilled: 2, executions: 2 });
    await store.flush();
    const second = new AnalyticsStore(dir, { log, executionLog: { platform: 'win32', release: '10.0' } });
    await second.load([meta('s1', 'claude', { provider: 'anthropic', model: 'opus' })], async (id) => {
      reads.push(id);
      return transcript;
    });
    await second.whenBackfilled();
    expect(second.executions.all()).toHaveLength(2);
    // The first load read the transcript (usage backfill + execution replay); the second only for the usage seed.
    expect(reads.filter((id) => id === 's1').length).toBeGreaterThanOrEqual(1);
    expect(second.executions.isBackfilled('s1')).toBe(true);
  });
});
