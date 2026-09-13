import { EventEmitter, getEventListeners } from 'node:events';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), which: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/main/runtime', () => ({ which: mocks.which }));
import { grepTool } from '../src/main/harness/native/tools';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

const cwd = path.resolve('grep-workspace');
const budget = 512 * 1024;
let child: FakeChild;
let controller: AbortController;
const emit = (text: string) => child.stdout.emit('data', Buffer.from(text));
const row = (file: string, n: number, text = 'match') => `${path.join(cwd, file)}:${n}:${text}`;
const listeners = () => getEventListeners(controller.signal, 'abort').length;
const run = (max_results?: number) => grepTool(cwd, { pattern: 'match', max_results }, controller.signal);

beforeEach(() => {
  vi.clearAllMocks();
  child = new FakeChild();
  controller = new AbortController();
  mocks.which.mockReturnValue('rg');
  mocks.spawn.mockReturnValue(child);
});

describe('native grep ripgrep streaming', () => {
  it('stops at the global match limit across files and ignores queued output', async () => {
    const result = run(3);
    emit(`${row('a.ts', 1)}\n${row('b.ts', 2)}\n`);
    expect(child.kill).not.toHaveBeenCalled();
    emit(`${row('c.ts', 3)}\n${row('d.ts', 4)}\n`);
    const killedAtCap = child.kill.mock.calls.length;
    emit(`${row('late.ts', 5)}\n`.repeat(100));
    child.emit('close', null, 'SIGTERM');
    expect(await result).toEqual({ output: 'a.ts:1:match\nb.ts:2:match\nc.ts:3:match', isError: false });
    expect(killedAtCap).toBe(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(listeners()).toBe(0);
  });

  it('returns exactly the match cap even when a single burst exceeds the byte budget', async () => {
    const result = run(2);
    emit(`${row('a.ts', 1)}\n${row('b.ts', 2)}\n${'unused'.repeat(budget)}`);
    child.emit('close', null);
    expect(await result).toEqual({ output: 'a.ts:1:match\nb.ts:2:match', isError: false });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('counts complete lines across chunk bursts, including CRLF', async () => {
    const result = run(2);
    emit(`${row('a.ts', 1)}\r`);
    emit(`\n${row('b.ts', 2, 'part')}`);
    expect(child.kill).not.toHaveBeenCalled();
    emit('ial\r\nignored:3:match\n');
    const killedAtCap = child.kill.mock.calls.length;
    child.emit('close', null);
    expect(await result).toEqual({ output: 'a.ts:1:match\nb.ts:2:partial', isError: false });
    expect(killedAtCap).toBe(1);
  });

  it('bounds a giant newline-free match before process close', async () => {
    const result = run();
    emit(row('huge.ts', 1, ''));
    emit('x'.repeat(budget * 4));
    const killedAtBudget = child.kill.mock.calls.length;
    for (let i = 0; i < 8; i++) emit('y'.repeat(budget));
    child.emit('close', 2);
    const res = await result;
    expect(killedAtBudget).toBe(1);
    expect(res.isError).toBe(false);
    expect(res.output.startsWith('huge.ts:1:')).toBe(true);
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(budget + 100);
    expect(res.output).not.toContain('y');
    expect(listeners()).toBe(0);
  });

  it('shares the byte budget with stderr without counting diagnostics as matches', async () => {
    const result = run(1);
    child.stderr.emit('data', Buffer.from('warning\n'));
    expect(child.kill).not.toHaveBeenCalled();
    emit(`${row('a.ts', 1)}\n`);
    const killedAtCap = child.kill.mock.calls.length;
    child.emit('close', null);
    const res = await result;
    expect(res.isError).toBe(false);
    expect(res.output).toContain('a.ts:1:match');
    expect(killedAtCap).toBe(1);
  });

  it('enforces one combined stdout/stderr byte budget', async () => {
    const result = run();
    emit('x'.repeat(budget / 2));
    child.stderr.emit('data', Buffer.alloc(budget / 2, 'e'));
    const killedAtBudget = child.kill.mock.calls.length;
    emit('late output');
    child.emit('close', null);
    const res = await result;
    expect(killedAtBudget).toBe(1);
    expect(res.output).toBe(`${'x'.repeat(budget / 2)}\n${'e'.repeat(budget / 2)}\n[output truncated]`);
    expect(res.isError).toBe(false);
  });

  it('bounds stderr bursts too', async () => {
    const result = run();
    child.stderr.emit('data', Buffer.alloc(budget * 4, 'e'));
    const killedAtBudget = child.kill.mock.calls.length;
    child.emit('close', null);
    const res = await result;
    expect(killedAtBudget).toBe(1);
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(budget + 100);
    expect(listeners()).toBe(0);
  });

  it('decodes Unicode across every byte boundary and retains a final unterminated line', async () => {
    const result = run();
    const text = `${row('日本.ts', 1, 'café 😀')}\n${row('last.ts', 2, '終')}`;
    for (const byte of Buffer.from(text)) child.stdout.emit('data', Buffer.from([byte]));
    child.emit('close', 0);
    expect(await result).toEqual({ output: '日本.ts:1:café 😀\nlast.ts:2:終', isError: false });
    expect(listeners()).toBe(0);
  });

  it('does not introduce replacement characters when the byte budget cuts Unicode', async () => {
    const result = run();
    emit('x'.repeat(budget - 1));
    emit('😀');
    child.emit('close', null);
    const res = await result;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(res.output).not.toContain('�');
    expect(Buffer.byteLength(res.output)).toBeLessThanOrEqual(budget + 100);
  });

  it('reports no matches and removes the abort listener', async () => {
    const result = run();
    child.emit('close', 1);
    expect(await result).toEqual({ output: 'No matches.', isError: false });
    expect(listeners()).toBe(0);
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports a genuine nonzero exit with diagnostics', async () => {
    const result = run();
    child.stderr.emit('data', Buffer.from('regex parse error\n'));
    child.emit('close', 2);
    expect(await result).toEqual({ output: 'regex parse error', isError: true });
    expect(listeners()).toBe(0);
  });

  it('handles spawn errors even without close and cleans up immediately', async () => {
    const result = run();
    child.emit('error', new Error('ENOENT'));
    expect(await result).toEqual({ output: 'ripgrep failed', isError: true });
    expect(listeners()).toBe(0);
    controller.abort();
    child.emit('close', -2);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('normalizes a synchronous spawn failure', async () => {
    mocks.spawn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    expect(await run()).toEqual({ output: 'ripgrep failed', isError: true });
    expect(listeners()).toBe(0);
  });

  it('does not spawn when already aborted', async () => {
    controller.abort();
    const result = run();
    // Close the fake so the old implementation fails assertions rather than hanging.
    child.emit('close', 0);
    expect((await result).isError).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(listeners()).toBe(0);
  });

  it('reports midflight cancellation as an error even if the child exits zero', async () => {
    const result = run();
    emit(`${row('a.ts', 1)}\n`);
    controller.abort();
    emit(`${row('late.ts', 2)}\n`);
    child.emit('close', 0);
    expect(await result).toEqual({ output: 'a.ts:1:match\n[interrupted by user]', isError: true });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(listeners()).toBe(0);
  });

  it('does not mistake cancellation after a limit for successful completion', async () => {
    const result = run(1);
    emit(`${row('a.ts', 1)}\n`);
    controller.abort();
    child.emit('close', null);
    expect(await result).toEqual({ output: 'a.ts:1:match\n[interrupted by user]', isError: true });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(listeners()).toBe(0);
  });

  it.each([0, -5, 1.9, 5000, Number.NaN])('clamps max_results=%s to a positive bounded integer', async (max) => {
    const expected = Number.isNaN(max) ? 200 : Math.max(1, Math.min(Math.floor(max), 2000));
    const result = run(max);
    for (let i = 1; i <= expected + 2; i++) emit(`${row(`file${i}.ts`, i)}\n`);
    const killedAtCap = child.kill.mock.calls.length;
    child.emit('close', null);
    const res = await result;
    expect(res.isError).toBe(false);
    expect(res.output.split('\n')).toHaveLength(expected);
    expect(res.output.split('\n').at(-1)).toBe(`file${expected}.ts:${expected}:match`);
    expect(killedAtCap).toBe(1);
  });
});
