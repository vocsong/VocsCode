/** Passive GitNexus indexing: lifecycle hooks stay non-blocking, duplicate work is coalesced, and
 * the analyzer can never rewrite project instruction files. */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitnexusIndexer } from '../src/main/mcp/indexer';
import type { CaptureResult } from '../src/main/runtime';

const ok = (stdout = 'indexed'): CaptureResult => ({ code: 0, stdout, stderr: '' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('GitnexusIndexer', () => {
  it('coalesces passive hooks, runs them off the caller, and never edits instruction files', async () => {
    let finish: ((result: CaptureResult) => void) | undefined;
    const run = vi.fn((_command: string, _args: string[], _opts: { cwd: string; timeoutMs: number }) => new Promise<CaptureResult>((resolve) => { finish = resolve; }));
    const indexer = new GitnexusIndexer({ command: 'gitnexus', run });
    const cwd = path.resolve('repo');

    indexer.schedule({ cwd, projectRoot: cwd, reason: 'session-start' });
    indexer.schedule({ cwd, projectRoot: cwd, reason: 'pull-request' });

    // schedule() returned while the analyzer was still running, and both hooks share one run.
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('gitnexus', ['analyze', '--skip-agents-md'], { cwd, timeoutMs: 120_000 });
    finish?.(ok());
    await tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('serializes registry writers across repositories', async () => {
    const finishes: Array<(result: CaptureResult) => void> = [];
    const run = vi.fn((_command: string, _args: string[], _opts: { cwd: string; timeoutMs: number }) => new Promise<CaptureResult>((resolve) => finishes.push(resolve)));
    const indexer = new GitnexusIndexer({ command: 'npx', baseArgs: ['-y', 'gitnexus@latest'], run });
    const first = indexer.index({ cwd: path.resolve('one'), projectRoot: path.resolve('one'), reason: 'manual' });
    const second = indexer.index({ cwd: path.resolve('two'), projectRoot: path.resolve('two'), reason: 'manual' });

    await tick();
    expect(run).toHaveBeenCalledTimes(1);
    finishes.shift()?.(ok('one'));
    await expect(first).resolves.toMatchObject({ ok: true, output: 'one' });
    await tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toEqual(['-y', 'gitnexus@latest', 'analyze', '--skip-agents-md']);
    finishes.shift()?.(ok('two'));
    await expect(second).resolves.toMatchObject({ ok: true, output: 'two' });
  });

  it('honors the built-in switches for passive work but keeps manual retries available', async () => {
    const run = vi.fn(async () => ok());
    const indexer = new GitnexusIndexer({ command: 'gitnexus', enabled: () => false, run });
    const root = path.resolve('off');

    indexer.schedule({ cwd: root, projectRoot: root, reason: 'session-start' });
    await tick();
    expect(run).not.toHaveBeenCalled();

    await expect(indexer.index({ cwd: root, projectRoot: root, reason: 'manual' })).resolves.toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not create a first index passively', async () => {
    const run = vi.fn(async () => ok());
    const indexer = new GitnexusIndexer({ command: 'gitnexus', indexed: async () => false, run });
    const root = path.resolve('new-repo');

    indexer.schedule({ cwd: root, projectRoot: root, reason: 'session-start' });
    await tick();
    expect(run).not.toHaveBeenCalled();

    // The MCP tab's explicit Index repo action is still allowed to create it.
    await expect(indexer.index({ cwd: root, projectRoot: root, reason: 'manual' })).resolves.toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('turns analyzer failures into results instead of rejecting a lifecycle hook', async () => {
    const logs: Array<[string, string]> = [];
    const indexer = new GitnexusIndexer({
      command: 'gitnexus',
      run: async () => ({ code: 1, stdout: '', stderr: 'graph write failed' }),
      log: (level, message) => logs.push([level, message])
    });
    const root = path.resolve('broken');

    await expect(indexer.index({ cwd: root, projectRoot: root, reason: 'manual' })).resolves.toEqual({ ok: false, error: 'graph write failed' });
    expect(logs.some(([level, message]) => level === 'warn' && message.includes('graph write failed'))).toBe(true);
  });
});
