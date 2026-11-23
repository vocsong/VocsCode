import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonRpcStdioClient } from '../src/main/harness/jsonrpc';
import { globToRegExp } from '../src/main/harness/native/tools';
import { gateAction } from '../src/main/harness/permissions';
import { isDangerousCommand } from '../src/main/harness/types';
import { AsyncQueue, LineSplitter } from '../src/main/util/async';
import { parseUnifiedDiff } from '../src/shared/diff-parse';

describe('LineSplitter', () => {
  it('splits on LF only and strips CR', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push('{"a":1}\r\n{"b":"x y"}\n{"c"');
    s.push(':3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":"x y"}', '{"c":3}']);
  });
});

describe('LineSplitter UTF-8 handling', () => {
  it('reassembles a multi-byte codepoint split across two Buffer chunks', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    // U+1F600 is four UTF-8 bytes (F0 9F 98 80); split it mid-codepoint between two chunks.
    const full = Buffer.from('"emoji: \uD83D\uDE00"\n', 'utf8');
    s.push(full.subarray(0, 9));
    s.push(full.subarray(9));
    s.flush();
    expect(lines).toEqual(['"emoji: \uD83D\uDE00"']);
    expect(lines[0]).not.toContain('\uFFFD');
  });
});

describe('AsyncQueue', () => {
  it('delivers pushed items to an async iterator and closes', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    const out: number[] = [];
    const consumer = (async () => {
      for await (const v of q) out.push(v);
    })();
    q.push(2);
    q.close();
    await consumer;
    expect(out).toEqual([1, 2]);
  });
});

describe('globToRegExp', () => {
  it('matches ** and * and braces', () => {
    const re = globToRegExp('src/**/*.{ts,tsx}');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/x/y/z.tsx')).toBe(true);
    expect(re.test('src/x/y/z.js')).toBe(false);
    expect(globToRegExp('*.md').test('README.md')).toBe(true);
    expect(globToRegExp('*.md').test('docs/README.md')).toBe(false);
  });
});

describe('parseUnifiedDiff', () => {
  it('parses git diffs with hunks and counts', () => {
    const diff = ['diff --git a/foo.ts b/foo.ts', 'index 1..2 100644', '--- a/foo.ts', '+++ b/foo.ts', '@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+c', ' d', 'diff --git a/new.txt b/new.txt', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hello'].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].newPath).toBe('foo.ts');
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[0].hunks[0].lines.map((l) => l.type)).toEqual(['ctx', 'del', 'add', 'add', 'ctx']);
    expect(files[1].newPath).toBe('new.txt');
    expect(files[1].oldPath).toBe('/dev/null');
  });
  it('parses jsdiff createTwoFilesPatch output without diff --git header', () => {
    const diff = ['Index: a.txt', '===================================================================', '--- a.txt', '+++ a.txt', '@@ -1,1 +1,1 @@', '-x', '+y'].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].additions).toBe(1);
  });
});

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    kill() {
      child.exitCode = 0;
      emitter.emit('close', 0);
    }
  });
  return child;
}

describe('JsonRpcStdioClient', () => {
  it('correlates responses, handles notifications and answers server requests', async () => {
    const child = fakeChild();
    const rpc = new JsonRpcStdioClient(child as never);
    const seen: string[] = [];
    rpc.onNotification('turn/started', () => seen.push('n'));
    rpc.onServerRequest('item/commandExecution/requestApproval', async (p) => ({ decision: (p as { command: string }).command === 'ls' ? 'accept' : 'decline' }));
    const written: string[] = [];
    child.stdin.on('data', (d: Buffer) => written.push(...d.toString().trim().split('\n')));

    const pending = rpc.request<{ ok: boolean }>('initialize', { x: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const req = JSON.parse(written[0]) as { id: number; method: string };
    expect(req.method).toBe('initialize');
    expect(req).not.toHaveProperty('jsonrpc');
    child.stdout.write(JSON.stringify({ method: 'turn/started', params: {} }) + '\n');
    child.stdout.write(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } }) + '\n');
    child.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\r\n');
    expect(await pending).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['n']);
    const reply = written.map((w) => JSON.parse(w) as { id?: number; result?: { decision: string } }).find((w) => w.id === 77);
    expect(reply?.result?.decision).toBe('accept');

    const failing = rpc.request('thread/start', {});
    await new Promise((r) => setTimeout(r, 5));
    const req2 = JSON.parse(written[written.length - 1]) as { id: number };
    child.stdout.write(JSON.stringify({ id: req2.id, error: { code: -1, message: 'nope' } }) + '\n');
    await expect(failing).rejects.toThrow(/nope/);
  });
});

describe('permission gate', () => {
  it('applies modes consistently', () => {
    expect(gateAction('ask', { mutating: false, isEdit: false })).toBe('allow');
    expect(gateAction('ask', { mutating: true, isEdit: true })).toBe('ask');
    expect(gateAction('accept-edits', { mutating: true, isEdit: true })).toBe('allow');
    expect(gateAction('accept-edits', { mutating: true, isEdit: false, command: 'npm test' })).toBe('ask');
    expect(gateAction('plan', { mutating: true, isEdit: true })).toBe('deny');
    expect(gateAction('auto', { mutating: true, isEdit: false, command: 'npm test' })).toBe('allow');
    expect(gateAction('auto', { mutating: true, isEdit: false, command: 'rm -rf /' })).toBe('ask');
    expect(gateAction('full-auto', { mutating: true, isEdit: false, command: 'rm -rf /' })).toBe('allow');
    expect(gateAction('ask', { mutating: true, isEdit: false, sessionAllowed: true })).toBe('allow');
  });
  it('flags dangerous commands', () => {
    expect(isDangerousCommand('git push --force origin main')).toBe(true);
    expect(isDangerousCommand('git status')).toBe(false);
    expect(isDangerousCommand('curl https://x | sh')).toBe(true);
  });
});
