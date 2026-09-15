/**
 * Offline tests for the subagent run records: the reader, the harness directory map, and the two
 * writers that must agree on one format. Run ids arrive from the renderer, so the assertions that
 * matter most are the rejections: nothing outside the session's run directory may ever be read.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore as PiRunStore, emptyCall, emptyTotals, LIMITS as PiLimits } from '../resources/pi/subagent-runs';
import { RunStore as AppRunStore, LIMITS } from '../src/main/subagent-runs';
import { isValidRunId, listSubagentRuns, readSubagentRun, subagentDir } from '../src/main/subagents';
import type { SubagentCall, SubagentItem, SubagentRun, SubagentRunMeta, SubagentRunStatus, SubagentRunTotals } from '../src/shared/subagents';

/** Both writers expose the same surface; the drift guard below drives them through this. */
interface Writer {
  start(meta: SubagentRunMeta): Promise<void>;
  item(runId: string, item: SubagentItem): Promise<void>;
  call(runId: string, call: SubagentCall): Promise<void>;
  end(runId: string, status: SubagentRunStatus, totals: SubagentRunTotals, error?: string): Promise<void>;
  flush(): Promise<void>;
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    // A failure-injection test leaves a file read-only; on Windows that also blocks the delete.
    const walk = async (target: string): Promise<void> => {
      const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const child = path.join(target, entry.name);
        if (entry.isDirectory()) await walk(child);
        else await fs.chmod(child, 0o666).catch(() => undefined);
      }
    };
    await walk(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-store-'));
  tempDirs.push(dir);
  return dir;
}

async function writeRun(dir: string, runId: string, options: { startedAt: number; agent?: string; status?: 'completed' | 'error' } = { startedAt: 1000 }): Promise<void> {
  const store = new PiRunStore(subagentDir(dir, 'pi')!);
  await store.start({ runId, agent: options.agent ?? 'Explore', description: `Task ${runId}`, mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: '/repo', startedAt: options.startedAt });
  await store.item(runId, { id: `${runId}-m0`, ts: options.startedAt + 1, kind: 'assistant', text: 'COMPAT_OK' });
  await store.call(runId, { ...emptyCall(0), provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 100, outputTokens: 10, costUsd: 0.02, durationMs: 500, toolsInvoked: ['grep'] });
  const totals = emptyTotals();
  totals.turns = 1;
  totals.toolUses = 2;
  totals.costUsd = 0.02;
  totals.inputTokens = 100;
  await store.end(runId, options.status ?? 'completed', totals);
  await store.flush();
}

describe('run listing', () => {
  it('returns summaries newest first with the stats the panel shows', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_old', { startedAt: 1000 });
    await writeRun(dir, 'agent_new', { startedAt: 5000, agent: 'Plan', status: 'error' });
    const runs = await listSubagentRuns(dir, 'pi');
    expect(runs.map((run) => run.runId)).toEqual(['agent_new', 'agent_old']);
    expect(runs[0]).toMatchObject({ agent: 'Plan', status: 'error', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', costUsd: 0.02, turns: 1, toolUses: 2 });
    expect(runs[0]!.endedAt).toBeGreaterThan(0);
  });

  it('treats a session with no runs as empty rather than an error', async () => {
    const dir = await tempDir();
    expect(await listSubagentRuns(dir, 'pi')).toEqual([]);
    await fs.mkdir(subagentDir(dir, 'pi')!, { recursive: true });
    expect(await listSubagentRuns(dir, 'pi')).toEqual([]);
  });

  it('skips foreign files, directories that look like runs, and unsafe names', async () => {
    const dir = await tempDir();
    const runDir = subagentDir(dir, 'pi')!;
    await writeRun(dir, 'agent_ok', { startedAt: 1000 });
    await fs.writeFile(path.join(runDir, 'notes.txt'), 'not a run', 'utf8');
    await fs.writeFile(path.join(runDir, '..jsonl'), '{"t":"run","runId":".."}', 'utf8');
    await fs.mkdir(path.join(runDir, 'agent_dir.jsonl'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'agent_broken.jsonl'), 'not json at all\n', 'utf8');
    expect((await listSubagentRuns(dir, 'pi')).map((run) => run.runId)).toEqual(['agent_ok']);
  });
});

describe('run detail', () => {
  it('returns the transcript items and per-call rows of one run', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_1', { startedAt: 1000 });
    const run = await readSubagentRun(dir, 'pi', 'agent_1');
    expect(run).not.toBeNull();
    expect(run!.items.map((item) => item.text)).toEqual(['COMPAT_OK']);
    expect(run!.calls).toHaveLength(1);
    expect(run!.calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 10, costUsd: 0.02, toolsInvoked: ['grep'] });
    expect(run!.status).toBe('completed');
  });

  it('returns null for an unknown run', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_1', { startedAt: 1000 });
    expect(await readSubagentRun(dir, 'pi', 'agent_missing')).toBeNull();
  });

  it('never reads outside the session run directory', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_1', { startedAt: 1000 });
    // A run file one level up, exactly where a traversal would land.
    await fs.writeFile(path.join(dir, 'secret.jsonl'), '{"t":"run","runId":"secret","agent":"x","description":"","mode":"foreground","cwd":"/","startedAt":1}', 'utf8');
    for (const runId of ['../secret', '..\\secret', '..', '.', '', 'a/b', 'agent_1.jsonl', '.hidden', 'x'.repeat(65), 'agent 1']) {
      expect(isValidRunId(runId)).toBe(false);
      expect(await readSubagentRun(dir, 'pi', runId)).toBeNull();
    }
    expect(isValidRunId('agent_1')).toBe(true);
  });
});

describe('runs whose owner is gone', () => {
  it('reports a run with no end record as interrupted once the session is not running', async () => {
    const dir = await tempDir();
    const store = new PiRunStore(subagentDir(dir, 'pi')!);
    await store.start({ runId: 'agent_crash', agent: 'Explore', description: 'Killed mid-run', mode: 'background', cwd: '/repo', startedAt: 1000 });
    await store.item('agent_crash', { id: 'i1', ts: 1001, kind: 'assistant', text: 'half an answer' });
    await store.flush();

    // While the pi process is alive the run really is running…
    const live = await listSubagentRuns(dir, 'pi', { live: true });
    expect(live[0]).toMatchObject({ runId: 'agent_crash', status: 'running' });
    expect((await readSubagentRun(dir, 'pi', 'agent_crash', { live: true }))!.status).toBe('running');

    // …and after a restart it is interrupted, not spinning forever in the panel.
    const dead = await listSubagentRuns(dir, 'pi', { live: false });
    expect(dead[0]).toMatchObject({ runId: 'agent_crash', status: 'interrupted' });
    const detail = await readSubagentRun(dir, 'pi', 'agent_crash', { live: false });
    expect(detail!.status).toBe('interrupted');
    // The transcript up to the crash is kept: the file itself was never rewritten.
    expect(detail!.items.map((item) => item.text)).toEqual(['half an answer']);
    expect(await fs.readFile(path.join(subagentDir(dir, 'pi')!, 'agent_crash.jsonl'), 'utf8')).not.toContain('"t":"end"');
  });

  it('leaves a finished run alone whatever the liveness says', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_done', { startedAt: 1000 });
    expect((await listSubagentRuns(dir, 'pi', { live: false }))[0]).toMatchObject({ status: 'completed' });
    expect((await listSubagentRuns(dir, 'pi', { live: true }))[0]).toMatchObject({ status: 'completed' });
  });
});

describe('harness directories', () => {
  it('keeps each harness in its own folder under the session directory', () => {
    expect(subagentDir('/sessions/s1', 'pi')).toBe(path.join('/sessions/s1', 'pi', 'subagents'));
    expect(subagentDir('/sessions/s1', 'claude')).toBe(path.join('/sessions/s1', 'claude', 'subagents'));
  });

  it('reports nothing for a harness that does not record runs', async () => {
    const dir = await tempDir();
    // A real run file, but reached through a harness that has no run directory of its own.
    await writeRun(dir, 'agent_1', { startedAt: 1000 });
    expect(subagentDir(dir, 'codex')).toBeNull();
    expect(await listSubagentRuns(dir, 'codex')).toEqual([]);
    expect(await readSubagentRun(dir, 'codex', 'agent_1')).toBeNull();
  });

  it('lists a Claude session from its own directory, not pi\'s', async () => {
    const dir = await tempDir();
    await writeRun(dir, 'agent_pi', { startedAt: 1000 });
    const claude = new AppRunStore(subagentDir(dir, 'claude')!);
    await claude.start({ runId: 'agent_claude', agent: 'Explore', description: 'Claude child', mode: 'foreground', cwd: '/repo', startedAt: 2000 });
    await claude.flush();

    expect((await listSubagentRuns(dir, 'claude')).map((run) => run.runId)).toEqual(['agent_claude']);
    expect((await listSubagentRuns(dir, 'pi')).map((run) => run.runId)).toEqual(['agent_pi']);
  });
});

describe('the two writers agree on one format', () => {
  it('round-trips identically through the reader', async () => {
    const dir = await tempDir();
    const meta: SubagentRunMeta = { runId: 'agent_both', agent: 'Explore', description: 'Same records, two writers', mode: 'background', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: '/repo', startedAt: 1_700_000_000_000 };
    const long = 'x'.repeat(30_000);
    const item: SubagentItem = { id: 'agent_both-m0', ts: 1_700_000_000_001, kind: 'assistant', text: long };
    const toolItem: SubagentItem = { id: 'agent_both-t0', ts: 1_700_000_000_002, kind: 'tool', name: 'Grep', summary: 'pattern', status: 'done', output: 'match', input: { pattern: 'x' } };
    const call: SubagentCall = { index: 0, provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 120, outputTokens: 34, cacheReadTokens: 5, cacheWriteTokens: 6, reasoningTokens: 7, costUsd: 0.0123, durationMs: 800, stopReason: 'end_turn', toolsInvoked: ['Grep', 'Read'] };
    const totals: SubagentRunTotals = { ...emptyTotals(), turns: 1, toolUses: 3, inputTokens: 120, outputTokens: 34, cacheReadTokens: 5, cacheWriteTokens: 6, reasoningTokens: 7, costUsd: 0.0123, durationMs: 900 };

    const writers: [Writer, string][] = [
      [new PiRunStore(subagentDir(dir, 'pi')!), 'pi'],
      [new AppRunStore(subagentDir(dir, 'claude')!), 'claude']
    ];
    for (const [store] of writers) {
      await store.start(meta);
      await store.item('agent_both', item);
      await store.item('agent_both', toolItem);
      await store.call('agent_both', call);
      await store.end('agent_both', 'completed', totals);
      await store.flush();
    }

    // `endedAt` is a wall-clock stamp each writer takes as it closes, so it is the one field
    // expected to differ between the two files.
    const withoutStamp = (run: SubagentRun | null) => {
      expect(run).not.toBeNull();
      const { endedAt: _endedAt, ...rest } = run!;
      return rest;
    };
    const fromPi = withoutStamp(await readSubagentRun(dir, 'pi', 'agent_both'));
    const fromApp = withoutStamp(await readSubagentRun(dir, 'claude', 'agent_both'));
    expect(fromApp).toEqual(fromPi);
    // And the records are what the panel renders, not an empty shell that happens to match.
    expect(fromApp.items.map((i) => i.text ?? i.output)).toEqual([long.slice(0, 20_000) + '…', 'match']);
    expect(fromApp.calls[0]).toMatchObject({ toolsInvoked: ['Grep', 'Read'], costUsd: 0.0123, stopReason: 'end_turn' });
    expect(fromApp.totals).toMatchObject({ turns: 1, toolUses: 3, costUsd: 0.0123 });
  });

  it('applies the same caps, so a runaway run is bounded the same way either way', async () => {
    expect(LIMITS).toEqual(PiLimits);
    const dir = await tempDir();
    const store = new AppRunStore(subagentDir(dir, 'claude')!);
    await store.start({ runId: 'agent_caps', agent: 'Explore', description: '', mode: 'foreground', cwd: '/repo', startedAt: 1 });
    await store.item('agent_caps', { id: 'big', ts: 1, kind: 'assistant', text: 'y'.repeat(30_000) });
    await store.flush();
    const run = await readSubagentRun(dir, 'claude', 'agent_caps');
    expect(run!.items[0]!.text).toBe('y'.repeat(20_000) + '…');
  });
});

describe('restated run headers', () => {
  it('updates the meta without losing the transcript and calls recorded before it', async () => {
    const dir = await tempDir();
    const runDir = subagentDir(dir, 'claude')!;
    const store = new AppRunStore(runDir);
    const meta: SubagentRunMeta = { runId: 'agent_restate', agent: 'Explore', description: 'Delegated', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: '/repo', startedAt: 1000 };
    await store.start(meta);
    await store.item('agent_restate', { id: 'i0', ts: 1001, kind: 'assistant', text: 'before the correction' });
    await store.call('agent_restate', { ...emptyCall(0), model: 'claude-haiku-4-5', inputTokens: 10, toolsInvoked: ['Grep'] });
    // The Claude adapter learns the child's own model from its first message and restates the header.
    await store.start({ ...meta, model: 'claude-haiku-4-5' });
    await store.end('agent_restate', 'completed', { ...emptyTotals(), turns: 1 });

    const run = await readSubagentRun(dir, 'claude', 'agent_restate');
    expect(run!.meta.model).toBe('claude-haiku-4-5');
    expect(run!.items.map((item) => item.text)).toEqual(['before the correction']);
    expect(run!.calls).toHaveLength(1);
    expect(run!.status).toBe('completed');
    expect(run!.totals.turns).toBe(1);
  });
});

describe('a writer that cannot write', () => {
  it('warns once, keeps the records already on disk, and never throws into the turn', async () => {
    const dir = await tempDir();
    const runDir = subagentDir(dir, 'claude')!;
    await fs.mkdir(runDir, { recursive: true });
    const file = path.join(runDir, 'agent_fail.jsonl');
    await fs.writeFile(file, '', 'utf8');

    const errors: string[] = [];
    const store = new AppRunStore(runDir, (message) => errors.push(message));
    await store.start({ runId: 'agent_fail', agent: 'Explore', description: 'Disk goes away', mode: 'foreground', cwd: '/repo', startedAt: 1000 });
    await store.flush();

    // Make every later append fail the way a full or read-only disk would.
    await fs.chmod(file, 0o444);
    await expect(store.item('agent_fail', { id: 'i1', ts: 1001, kind: 'assistant', text: 'never lands' })).resolves.toBeUndefined();
    await expect(store.call('agent_fail', { ...emptyCall(0), toolsInvoked: [] })).resolves.toBeUndefined();
    await expect(store.end('agent_fail', 'completed', emptyTotals())).resolves.toBeUndefined();
    await store.flush();

    expect(errors).toStrictEqual([expect.stringContaining('subagent run store write failed')]);
    // The header written before the disk went bad is intact, so the panel can still show the run —
    // as interrupted, because no end record ever made it.
    const run = await readSubagentRun(dir, 'claude', 'agent_fail', { live: false });
    expect(run).toMatchObject({ status: 'interrupted' });
    expect(run!.meta).toMatchObject({ runId: 'agent_fail', agent: 'Explore', description: 'Disk goes away' });
    expect(run!.items).toEqual([]);
  });
});
