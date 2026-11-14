/**
 * Offline tests for run records. The extension writes them and the desktop app reads them, so the
 * round-trip through the app's parser is the anti-drift check: change the format on one side and
 * these fail.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, RunStore, addUsage, emptyCall, emptyTotals } from '../resources/pi/subagent-runs';
import { costsByModel, parseRunFile, summarizeRun } from '../src/shared/subagents';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-runs-'));
  tempDirs.push(dir);
  return dir;
}

describe('run file round-trip', () => {
  it('writes a run, its items, calls and end record, and the app parses them back', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    const totals = emptyTotals();
    const call = emptyCall(0);
    addUsage(call, totals, { input: 100, output: 20, cacheRead: 900, cacheWrite: 10, reasoning: 5, cost: { total: 0.42 } }, 1234);
    call.stopReason = 'toolUse';
    call.toolsInvoked = ['grep', 'read'];
    await store.start({ runId: 'agent_1', agent: 'Explore', description: 'Find the harness registry', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: process.cwd(), startedAt: 1000 });
    await store.item('agent_1', { id: 'i1', ts: 1100, kind: 'tool', name: 'grep', summary: 'createAgentSession', status: 'done', output: 'src/main/harness/registry.ts:1' });
    await store.item('agent_1', { id: 'i2', ts: 1200, kind: 'assistant', text: 'Registry is at src/main/harness/registry.ts' });
    await store.call('agent_1', call);
    totals.turns = 1;
    totals.toolUses = 2;
    await store.end('agent_1', 'completed', totals);
    await store.flush();

    const parsed = parseRunFile(await fs.readFile(store.fileFor('agent_1'), 'utf8'));
    expect(parsed).not.toBeNull();
    expect(parsed!.meta).toMatchObject({ runId: 'agent_1', agent: 'Explore', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(parsed!.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(parsed!.items[0]).toMatchObject({ kind: 'tool', name: 'grep', status: 'done' });
    expect(parsed!.calls).toHaveLength(1);
    expect(parsed!.calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 10, reasoningTokens: 5, costUsd: 0.42, durationMs: 1234, stopReason: 'toolUse', toolsInvoked: ['grep', 'read'] });
    expect(parsed!.status).toBe('completed');
    expect(parsed!.totals).toMatchObject({ turns: 1, toolUses: 2, inputTokens: 100, costUsd: 0.42 });
    expect(parsed!.endedAt).toBeGreaterThan(0);
  });

  it.each([
    { label: 'explicit effort', requestedThinkingLevel: 'high', thinkingLevel: 'high' },
    { label: 'clamped effort', requestedThinkingLevel: 'xhigh', thinkingLevel: 'high' },
    { label: 'inherited effort', requestedThinkingLevel: undefined, thinkingLevel: 'medium' },
    { label: 'disabled effort', requestedThinkingLevel: undefined, thinkingLevel: 'off' },
    { label: 'unknown effective effort', requestedThinkingLevel: 'high', thinkingLevel: undefined }
  ])('persists and summarizes $label without conflating requested and effective levels', async ({ label, ...effort }) => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    const meta = { runId: 'agent_effort', agent: 'Explore', description: label, mode: 'foreground' as const, cwd: process.cwd(), startedAt: 1, ...effort };
    await store.start(meta);
    await store.end(meta.runId, 'completed', emptyTotals());
    await store.flush();

    const text = await fs.readFile(store.fileFor(meta.runId), 'utf8');
    const header = JSON.parse(text.split('\n')[0]!);
    const parsed = parseRunFile(text)!;
    const summary = summarizeRun(parsed);
    for (const key of ['requestedThinkingLevel', 'thinkingLevel'] as const) {
      expect(header[key]).toBe(effort[key]);
      expect(parsed.meta[key]).toBe(effort[key]);
      expect(summary[key]).toBe(effort[key]);
      if (effort[key] === undefined) {
        expect(parsed.meta).not.toHaveProperty(key);
        expect(summary).not.toHaveProperty(key);
      }
    }
    expect(parsed.status).toBe('completed');
  });

  it('retains effort from a restated header without losing the transcript, calls or terminal state', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    const meta = { runId: 'agent_restate', agent: 'Explore', description: 'Work', mode: 'foreground' as const, cwd: process.cwd(), startedAt: 1, requestedThinkingLevel: 'xhigh' };
    await store.start(meta);
    await store.item(meta.runId, { id: 'i1', ts: 2, kind: 'assistant', text: 'Recorded before the effective level was known.' });
    await store.call(meta.runId, emptyCall(0));
    await store.end(meta.runId, 'completed', { ...emptyTotals(), turns: 1 });
    await store.start({ ...meta, thinkingLevel: 'high' });
    await store.flush();

    const parsed = parseRunFile(await fs.readFile(store.fileFor(meta.runId), 'utf8'))!;
    expect(parsed.meta).toMatchObject({ requestedThinkingLevel: 'xhigh', thinkingLevel: 'high' });
    expect(summarizeRun(parsed)).toMatchObject({ requestedThinkingLevel: 'xhigh', thinkingLevel: 'high', status: 'completed', turns: 1 });
    expect(parsed.items).toEqual([{ id: 'i1', ts: 2, kind: 'assistant', text: 'Recorded before the effective level was known.' }]);
    expect(parsed.calls).toEqual([emptyCall(0)]);
    expect(parsed.endedAt).toBeGreaterThan(0);
  });

  it('ignores malformed effort metadata rather than presenting it as an effective level', () => {
    const parsed = parseRunFile(JSON.stringify({ t: 'run', runId: 'agent_invalid', requestedThinkingLevel: 1, thinkingLevel: { level: 'high' } }))!;
    expect(parsed.meta).not.toHaveProperty('requestedThinkingLevel');
    expect(parsed.meta).not.toHaveProperty('thinkingLevel');
    expect(summarizeRun(parsed)).not.toHaveProperty('requestedThinkingLevel');
    expect(summarizeRun(parsed)).not.toHaveProperty('thinkingLevel');
  });

  it('keeps a run that never ended in the running state', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    await store.start({ runId: 'agent_2', agent: 'general-purpose', description: 'Work', mode: 'background', cwd: process.cwd(), startedAt: 1 });
    await store.flush();
    const parsed = parseRunFile(await fs.readFile(store.fileFor('agent_2'), 'utf8'));
    expect(parsed!.status).toBe('running');
    expect(parsed!.items).toEqual([]);
    expect(parsed!.meta).not.toHaveProperty('requestedThinkingLevel');
    expect(parsed!.meta).not.toHaveProperty('thinkingLevel');
    expect(summarizeRun(parsed!)).not.toHaveProperty('requestedThinkingLevel');
    expect(summarizeRun(parsed!)).not.toHaveProperty('thinkingLevel');
  });

  it('rejects a file with no run header and skips malformed lines', async () => {
    expect(parseRunFile('')).toBeNull();
    expect(parseRunFile('{"t":"item","item":{"id":"x"}}\n')).toBeNull();
    const dir = await tempDir();
    const store = new RunStore(dir);
    await store.start({ runId: 'agent_3', agent: 'Plan', description: 'Plan', mode: 'foreground', cwd: process.cwd(), startedAt: 1 });
    await store.flush();
    const text = (await fs.readFile(store.fileFor('agent_3'), 'utf8')) + 'not json\n{"t":"nonsense"}\n';
    expect(parseRunFile(text)!.meta.runId).toBe('agent_3');
  });
});

describe('usage accounting', () => {
  it('folds a pi usage object into the call row and the run totals', () => {
    const totals = emptyTotals();
    const first = emptyCall(0);
    const second = emptyCall(1);
    addUsage(first, totals, { input: 10, output: 2, cacheRead: 0, cacheWrite: 4, cost: { total: 0.1 } }, 100);
    addUsage(second, totals, { input: 5, output: 1, cost: { total: 0.05 } }, 200);
    expect(first).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheWriteTokens: 4, costUsd: 0.1, durationMs: 100 });
    expect(totals).toMatchObject({ inputTokens: 15, outputTokens: 3, cacheWriteTokens: 4, durationMs: 300 });
    expect(totals.costUsd).toBeCloseTo(0.15, 10);
  });

  it('ignores missing or non-numeric usage fields', () => {
    const totals = emptyTotals();
    const call = emptyCall(0);
    addUsage(call, totals, undefined, 10);
    addUsage(call, totals, { input: Number.NaN, cost: {} } as never, 10);
    expect(call.inputTokens).toBe(0);
    expect(call.durationMs).toBe(20);
    expect(totals.costUsd).toBe(0);
  });
});

describe('run store limits and failure handling', () => {
  it('caps items per run and leaves a single truncation marker', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    await store.start({ runId: 'agent_4', agent: 'Explore', description: 'x', mode: 'foreground', cwd: process.cwd(), startedAt: 1 });
    for (let i = 0; i < LIMITS.itemsPerRun + 5; i++) {
      await store.item('agent_4', { id: `i${i}`, ts: i, kind: 'info', summary: 'x', status: 'done' });
    }
    await store.flush();
    const parsed = parseRunFile(await fs.readFile(store.fileFor('agent_4'), 'utf8'))!;
    expect(parsed.items).toHaveLength(LIMITS.itemsPerRun + 1);
    expect(parsed.items.at(-1)!.summary).toContain('truncated');
  });

  it('caps model-call rows per run', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    await store.start({ runId: 'agent_5', agent: 'Explore', description: 'x', mode: 'foreground', cwd: process.cwd(), startedAt: 1 });
    for (let i = 0; i < LIMITS.callsPerRun + 3; i++) await store.call('agent_5', emptyCall(i));
    await store.flush();
    const parsed = parseRunFile(await fs.readFile(store.fileFor('agent_5'), 'utf8'))!;
    expect(parsed.calls).toHaveLength(LIMITS.callsPerRun);
  });

  it('clips oversized text instead of writing it whole', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    await store.start({ runId: 'agent_6', agent: 'Explore', description: 'x', mode: 'foreground', cwd: process.cwd(), startedAt: 1 });
    await store.item('agent_6', { id: 'big', ts: 1, kind: 'assistant', text: 'x'.repeat(LIMITS.itemChars * 2) });
    await store.flush();
    const parsed = parseRunFile(await fs.readFile(store.fileFor('agent_6'), 'utf8'))!;
    expect(parsed.items[0]!.text!.length).toBe(LIMITS.itemChars + 1);
  });

  it('recovers effort metadata when a restated header follows a failed append', async () => {
    const dir = await tempDir();
    const onError = vi.fn();
    const store = new RunStore(dir, onError);
    const meta = { runId: 'agent_recover', agent: 'Explore', description: 'Work', mode: 'foreground' as const, cwd: process.cwd(), startedAt: 1, requestedThinkingLevel: 'high' };
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('temporary disk failure'));
    try {
      await expect(store.start(meta)).resolves.toBeUndefined();
      await store.start({ ...meta, thinkingLevel: 'medium' });
      await store.item(meta.runId, { id: 'i1', ts: 2, kind: 'assistant', text: 'Recovered.' });
      await store.end(meta.runId, 'completed', { ...emptyTotals(), turns: 1 });
      await store.flush();

      const parsed = parseRunFile(await fs.readFile(store.fileFor(meta.runId), 'utf8'))!;
      expect(onError).toHaveBeenCalledExactlyOnceWith('subagent run store write failed: temporary disk failure');
      expect(append).toHaveBeenCalledTimes(4);
      expect(parsed.meta).toMatchObject({ requestedThinkingLevel: 'high', thinkingLevel: 'medium' });
      expect(summarizeRun(parsed)).toMatchObject({ requestedThinkingLevel: 'high', thinkingLevel: 'medium', status: 'completed', turns: 1 });
      expect(parsed.items).toEqual([{ id: 'i1', ts: 2, kind: 'assistant', text: 'Recovered.' }]);
      expect(parsed.calls).toEqual([]);
    } finally {
      append.mockRestore();
    }
  });

  it('never throws when the run directory cannot be created, and reports once', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'not-a-dir');
    await fs.writeFile(file, 'occupied', 'utf8');
    const onError = vi.fn();
    const store = new RunStore(path.join(file, 'subagents'), onError);
    await store.start({ runId: 'agent_7', agent: 'Explore', description: 'x', mode: 'foreground', cwd: process.cwd(), startedAt: 1 });
    await store.item('agent_7', { id: 'i', ts: 1, kind: 'info' });
    await store.end('agent_7', 'completed', emptyTotals());
    await expect(store.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain('run store write failed');
  });
});

describe('cost attribution', () => {
  it('groups spend per model and call count', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    await store.start({ runId: 'agent_8', agent: 'Explore', description: 'x', mode: 'foreground', cwd: process.cwd(), startedAt: 1 });
    await store.call('agent_8', { ...emptyCall(0), provider: 'anthropic', model: 'claude-sonnet-4-5', costUsd: 0.3 });
    await store.call('agent_8', { ...emptyCall(1), provider: 'anthropic', model: 'claude-sonnet-4-5', costUsd: 0.2 });
    await store.call('agent_8', { ...emptyCall(2), provider: 'openai', model: 'gpt-5.1', costUsd: 0.1 });
    await store.flush();
    const run = parseRunFile(await fs.readFile(store.fileFor('agent_8'), 'utf8'))!;
    expect(costsByModel([run])).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5', costUsd: 0.5, calls: 2 },
      { provider: 'openai', model: 'gpt-5.1', costUsd: 0.1, calls: 1 },
    ]);
  });

  it('falls back to the run model when a call does not name one', async () => {
    const dir = await tempDir();
    const store = new RunStore(dir);
    await store.start({ runId: 'agent_9', agent: 'Explore', description: 'x', mode: 'foreground', provider: 'anthropic', model: 'claude-haiku-4-5', cwd: process.cwd(), startedAt: 1 });
    await store.call('agent_9', { ...emptyCall(0), costUsd: 0.05 });
    await store.flush();
    const run = parseRunFile(await fs.readFile(store.fileFor('agent_9'), 'utf8'))!;
    expect(costsByModel([run])[0]).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-4-5', costUsd: 0.05, calls: 1 });
  });
});
