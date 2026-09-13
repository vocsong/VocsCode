import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAdapter } from '../src/main/harness/native';
import { globTool, grepTool, readFileTool, runBash, MAX_OUTPUT } from '../src/main/harness/native/tools';
import type { StepParams, StepResult, NativeMessage } from '../src/main/harness/native/drivers';
import type { HarnessContext } from '../src/main/harness/types';
import type { PermissionMode, SessionEvent, SessionMeta } from '../src/shared/types';
import { defaultSettings } from '../src/main/settings';
import { emptyUsage } from '../src/main/models/static-models';
import { which } from '../src/main/runtime';

const mocks = vi.hoisted(() => ({ fallback: false, failWorker: false, workerTerminated: vi.fn(), step: vi.fn<(p: StepParams) => Promise<StepResult>>() }));
vi.mock('node:worker_threads', async (original) => {
  const real = await original<typeof import('node:worker_threads')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...real,
    Worker: function (...args: ConstructorParameters<typeof real.Worker>) {
      if (!mocks.failWorker) return new real.Worker(...args);
      const worker = Object.assign(new EventEmitter(), { terminate: async () => { mocks.workerTerminated(); return 1; }, postMessage: vi.fn() });
      queueMicrotask(() => worker.emit('error', new Error('injected worker initialization failure')));
      return worker;
    },
  };
});
vi.mock('../src/main/harness/native/drivers', () => ({ openaiStep: mocks.step, anthropicStep: mocks.step, isAnthropicProvider: () => false }));
vi.mock('../src/main/runtime', async (original) => {
  const real = await original<typeof import('../src/main/runtime')>();
  return { ...real, which: (name: string) => name === 'rg' && mocks.fallback ? null : real.which(name) };
});
let cwd: string;
const signal = () => new AbortController().signal;
beforeEach(async () => { cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'native-tools-')); mocks.fallback = false; mocks.failWorker = false; mocks.workerTerminated.mockClear(); mocks.step.mockReset(); });
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
type Call = { id: string; name: string; args: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown>, id = name): Call => ({ name, args, id });

function harness(mode: PermissionMode = 'full-auto') {
  const settings = defaultSettings();
  settings.providers = [{ id: 'local', name: 'Local', kind: 'ollama', enabled: true, hasApiKey: false, models: [{ id: 'test', displayName: 'Test', provider: 'local' }] }];
  const meta = { cwd, usage: emptyUsage(), config: { harness: 'native', model: { provider: 'local', model: 'test' } }, harnessRef: {} } as SessionMeta;
  const events: SessionEvent[] = [];
  let saved: unknown = null;
  const approval = vi.fn<HarnessContext['requestApproval']>(async () => ({ optionId: 'allow' }));
  const ctx = {
    sessionId: 'test', session: () => meta, settings: () => settings, sessionDir: cwd,
    permissionMode: () => mode, effort: () => undefined, getApiKey: async () => undefined,
    emit: (e: SessionEvent) => events.push(e), requestApproval: approval,
    updateRef: (p: object) => Object.assign(meta.harnessRef, p), updateMeta: (p: object) => Object.assign(meta, p),
    readJson: async () => structuredClone(saved), writeJson: async (_name: string, value: unknown) => { saved = structuredClone(value); },
    log: vi.fn(), mcpServers: async () => [], runtime: {},
  } as unknown as HarnessContext;
  let adapter = new NativeAdapter(ctx);
  return {
    approval, events,
    async restart() { await adapter.dispose(); adapter = new NativeAdapter(ctx); await adapter.start(); },
    async run(calls: Call[], between?: () => Promise<void>) {
      let modelHistory: NativeMessage[] = [];
      mocks.step.mockImplementationOnce(async () => ({ text: '', reasoning: '', toolCalls: calls, usage, stopReason: 'tool_calls' }));
      mocks.step.mockImplementationOnce(async (p) => {
        modelHistory = structuredClone(p.history);
        await between?.();
        return { text: 'Done', reasoning: '', toolCalls: [], usage, stopReason: 'stop' };
      });
      const prior = events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn').length;
      await adapter.send({ text: 'Run the scripted tools', mode: 'now' });
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn')).toHaveLength(prior + 1), { timeout: 10_000 });
      expect(events.filter((e) => e.type === 'item.upsert' && e.item.kind === 'turn').at(-1)).toMatchObject({ item: { status: 'completed' } });
      expect(events.filter((e) => e.type === 'status').at(-1)).toMatchObject({ status: 'idle' });
      return modelHistory.filter((m): m is Extract<NativeMessage, { role: 'tool' }> => m.role === 'tool').slice(-calls.length);
    },
  };
}

describe('native model-visible mutation reliability', () => {
  it('keeps valid Unicode when shell truncation cuts through astral characters', async () => {
    await fs.writeFile(path.join(cwd, 'unicode.cjs'), "require('node:fs').writeSync(1, 'a'.repeat(14999) + '\\u{1F600}' + 'b'.repeat(40000) + '\\u{1F600}' + 'z'.repeat(14999));");
    const result = await runBash(cwd, 'node unicode.cjs', 10_000, signal());
    expect(result.isError).toBe(false);
    // Round-tripping UTF-8 replaces unpaired surrogates, exposing a broken cut.
    expect(Buffer.from(result.output).toString('utf8')).toBe(result.output);
    expect(result.output).toContain('[40004 UTF-16 code units omitted; showing head and tail]');
    expect(result.output.startsWith('a'.repeat(14999) + '\n[')).toBe(true);
    expect(result.output).toContain('z'.repeat(14999) + '\n[exit code: 0]');
  });

  it.each(['write_file', 'edit_file'])('blocks unread and stale %s, re-read recovers and own mutations refresh the fingerprint', async (name) => {
    const file = path.join(cwd, 'file.txt');
    await fs.writeFile(file, 'original');
    const h = harness();
    const mutation = call(name, name === 'write_file' ? { path: 'file.txt', content: 'changed' } : { path: 'file.txt', old_string: 'original', new_string: 'changed' });
    let result = await h.run([mutation]);
    expect(result[0]).toMatchObject({ isError: true, content: expect.stringContaining('Read the complete file') });
    expect(await fs.readFile(file, 'utf8')).toBe('original');
    await h.run([call('read_file', { path: 'file.txt' })]);
    await fs.writeFile(file, 'external original');
    result = await h.run([mutation]);
    expect(result[0]).toMatchObject({ isError: true, content: expect.stringContaining('changed since it was read') });
    expect(await fs.readFile(file, 'utf8')).toBe('external original');
    result = await h.run([call('read_file', { path: 'file.txt' }), mutation]);
    expect(result[1].isError).toBe(false);
    const own = await h.run([call('edit_file', { path: 'file.txt', old_string: 'changed', new_string: 'final' })]);
    expect(own[0].isError).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(name === 'write_file' ? 'final' : 'external final');
  });

  it.each(['write_file', 'edit_file'])('blocks %s when a file changes while approval is pending, without altering the external bytes', async (name) => {
    const file = path.join(cwd, 'file.txt');
    await fs.writeFile(file, 'before');
    const h = harness('ask');
    await h.run([call('read_file', { path: 'file.txt' })]);
    h.approval.mockImplementationOnce(async () => { await fs.writeFile(file, 'external'); return { optionId: 'allow' }; });
    const result = await h.run([call(name, name === 'write_file' ? { path: 'file.txt', content: 'after' } : { path: 'file.txt', old_string: 'before', new_string: 'after' })]);
    expect(h.approval).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({ isError: true, content: expect.stringContaining('changed since it was read') });
    expect(await fs.readFile(file, 'utf8')).toBe('external');
  });

  it('permits new files, forgets versions after restart, and does not authorize truncated or failed reads', async () => {
    const h = harness();
    const result = await h.run([call('write_file', { path: 'new.txt', content: 'one\ntwo' })]);
    expect(result[0].isError).toBe(false);
    await h.restart();
    for (const args of [{ path: 'new.txt', limit: 1 }, { path: 'new.txt', offset: 99 }]) {
      const res = await h.run([call('read_file', args), call('write_file', { path: 'new.txt', content: 'destroyed' })]);
      expect(res[1]).toMatchObject({ isError: true, content: expect.stringContaining('Read the complete file') });
      expect(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8')).toBe('one\ntwo');
    }
    const recovered = await h.run([call('read_file', { path: 'new.txt' }), call('write_file', { path: 'new.txt', content: 'recovered' })]);
    expect(recovered[1].isError).toBe(false);
  });

  it('accumulates UTF-8 byte pages before authorizing an exact edit of a large file', async () => {
    const content = 'a' + '€'.repeat(70000) + 'TAIL';
    await fs.writeFile(path.join(cwd, 'long'), content);
    const h = harness();
    const mutation = call('edit_file', { path: 'long', old_string: 'TAIL', new_string: 'DONE' });
    const [page, blocked] = await h.run([call('read_file', { path: 'long' }), mutation]);
    expect(blocked.isError).toBe(true);
    expect(await fs.readFile(path.join(cwd, 'long'), 'utf8')).toBe(content);
    const byteOffset = Number(/byte_offset=(\d+)/.exec(page.content)?.[1]);
    expect(byteOffset).toBe(179998);
    expect(page.content).not.toContain('\ufffd');
    expect(page).not.toHaveProperty('readCoverage');
    const [last, edited] = await h.run([call('read_file', { path: 'long', byte_offset: byteOffset }), mutation]);
    expect(last.content).toContain('TAIL');
    expect(last.content).not.toContain('\ufffd');
    expect(edited.isError).toBe(false);
    expect(await fs.readFile(path.join(cwd, 'long'), 'utf8')).toBe(content.slice(0, -4) + 'DONE');
  });

  it('combines line-limited pages, but repeated or overlapping pages cannot fill unread gaps', async () => {
    const content = Array.from({ length: 6001 }, (_, i) => `line-${i}`).join('\n');
    await fs.writeFile(path.join(cwd, 'lines'), content);
    const h = harness();
    const mutation = call('write_file', { path: 'lines', content: 'replaced' });
    const [first] = await h.run([call('read_file', { path: 'lines', limit: 9000 })]);
    expect(first.content).toContain('offset=5001');
    expect(first.content).not.toContain('line-5000');
    const repeated = await h.run([call('read_file', { path: 'lines', offset: 2500, limit: 2000 }), mutation]);
    expect(repeated[1].isError).toBe(true);
    expect(await fs.readFile(path.join(cwd, 'lines'), 'utf8')).toBe(content);
    const last = await h.run([call('read_file', { path: 'lines', offset: 5001 }), mutation]);
    expect(last[1].isError).toBe(false);
    expect(await fs.readFile(path.join(cwd, 'lines'), 'utf8')).toBe('replaced');
  });

  it('never combines pages from different fingerprints and recovers by reading missing current pages', async () => {
    const content = 'x'.repeat(200000) + 'TAIL';
    await fs.writeFile(path.join(cwd, 'long'), content);
    const h = harness();
    await h.run([call('read_file', { path: 'long' })]);
    const changed = 'y' + content.slice(1);
    await fs.writeFile(path.join(cwd, 'long'), changed);
    const mutation = call('edit_file', { path: 'long', old_string: 'TAIL', new_string: 'DONE' });
    const partial = await h.run([call('read_file', { path: 'long', byte_offset: 180000 }), mutation]);
    expect(partial[1]).toMatchObject({ isError: true, content: expect.stringContaining('Read the complete file') });
    expect(await fs.readFile(path.join(cwd, 'long'), 'utf8')).toBe(changed);
    const complete = await h.run([call('read_file', { path: 'long' }), mutation]);
    expect(complete[1].isError).toBe(false);
    expect(await fs.readFile(path.join(cwd, 'long'), 'utf8')).toBe(changed.slice(0, -4) + 'DONE');
  });

  it('keeps exact bytes and removes temporary files after a failed commit, then recovers', async () => {
    const h = harness();
    await fs.writeFile(path.join(cwd, 'file.txt'), 'original');
    await h.run([call('read_file', { path: 'file.txt' })]);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));
    try {
      const [failed] = await h.run([call('write_file', { path: 'file.txt', content: 'bad' })]);
      expect(failed).toMatchObject({ isError: true, content: expect.stringContaining('injected rename failure') });
      expect(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8')).toBe('original');
      expect(await fs.readdir(cwd)).toEqual(['file.txt']);
      const [recovered] = await h.run([call('write_file', { path: 'file.txt', content: 'recovered' })]);
      expect(recovered.isError).toBe(false);
      expect(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8')).toBe('recovered');
    } finally { rename.mockRestore(); }
  });

  it('does not authorize a byte-truncated read or overwrite binary/directory targets', async () => {
    const h = harness();
    const bytes = Buffer.from('€'.repeat(70000));
    await fs.writeFile(path.join(cwd, 'long'), bytes);
    await fs.writeFile(path.join(cwd, 'binary'), Buffer.from([0, 255, 1]));
    for (const target of ['long', 'binary', '.']) {
      const results = await h.run([call('read_file', { path: target }), call('write_file', { path: target, content: 'bad' })]);
      expect(results[1].isError).toBe(true);
    }
    expect(await fs.readFile(path.join(cwd, 'long'))).toEqual(bytes);
    expect(await fs.readFile(path.join(cwd, 'binary'))).toEqual(Buffer.from([0, 255, 1]));
    expect((await fs.stat(cwd)).isDirectory()).toBe(true);
  });

  it('denied writes and dangerous commands never execute even when content has been read', async () => {
    const h = harness('ask');
    await fs.writeFile(path.join(cwd, 'file.txt'), 'untouched');
    await h.run([call('read_file', { path: 'file.txt' })]);
    h.approval.mockResolvedValue({ optionId: 'deny' });
    const results = await h.run([call('write_file', { path: 'file.txt', content: 'bad' }), call('bash', { command: 'git push --force' })]);
    expect(results.map((r) => r.isError)).toEqual([true, true]);
    expect(results.every((r) => r.content.includes('Declined'))).toBe(true);
    expect(await fs.readFile(path.join(cwd, 'file.txt'), 'utf8')).toBe('untouched');
    expect(h.approval).toHaveBeenCalledTimes(2);
  });

  it.each(['auto', 'accept-edits'] as const)('prompts for physical junction/symlink escapes in %s, including missing descendants', async (mode) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'native-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'existing'), 'untouched');
      await fs.symlink(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const h = harness(mode);
      h.approval.mockResolvedValue({ optionId: 'deny' });
      await h.run([call('read_file', { path: 'linked/existing' })]);
      const results = await h.run([
        call('write_file', { path: 'linked/existing', content: 'bad' }, 'overwrite'),
        call('edit_file', { path: 'linked/existing', old_string: 'untouched', new_string: 'bad' }, 'edit'),
        call('write_file', { path: 'linked/new/deep/file', content: 'bad' }, 'create'),
        call('write_file', { path: path.join(outside, 'direct'), content: 'bad' }, 'direct'),
      ]);
      expect(results.every((r) => r.isError && r.content.includes('Declined'))).toBe(true);
      expect(h.approval).toHaveBeenCalledTimes(4);
      expect(await fs.readFile(path.join(outside, 'existing'), 'utf8')).toBe('untouched');
      expect(await fs.readdir(outside)).toEqual(['existing']);
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it('prompts for dangling links and inaccessible ancestors instead of authorizing new files', async () => {
    await fs.symlink(path.join(cwd, 'missing'), path.join(cwd, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    const h = harness('auto');
    h.approval.mockResolvedValue({ optionId: 'deny' });
    const [dangling] = await h.run([call('write_file', { path: 'dangling/new/deep/file', content: 'bad' })]);
    expect(dangling).toMatchObject({ isError: true, content: expect.stringContaining('Declined') });
    const realLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation((...args) => {
      if (String(args[0]) === path.join(cwd, 'blocked')) return Promise.reject(Object.assign(new Error('access denied'), { code: 'EACCES' }));
      return realLstat(...args);
    });
    try {
      const [blocked] = await h.run([call('write_file', { path: 'blocked', content: 'bad' })]);
      expect(blocked).toMatchObject({ isError: true, content: expect.stringContaining('Declined') });
      expect(h.approval).toHaveBeenCalledTimes(2);
      expect(await fs.readdir(cwd)).toEqual(['dangling']);
    } finally { lstat.mockRestore(); }
  });

  it('preserves Full access semantics for writes through an outside junction', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'native-outside-'));
    try {
      await fs.symlink(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const h = harness('full-auto');
      const [result] = await h.run([call('write_file', { path: 'linked/new/file', content: 'allowed' })]);
      expect(result.isError).toBe(false);
      expect(h.approval).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(outside, 'new/file'), 'utf8')).toBe('allowed');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });

  it.each(['auto', 'accept-edits'] as const)('still prompts for dangerous commands in %s', async (mode) => {
    const h = harness(mode);
    h.approval.mockResolvedValue({ optionId: 'deny' });
    const [result] = await h.run([call('bash', { command: 'git push --force' })]);
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('Declined') });
    expect(h.approval).toHaveBeenCalledTimes(1);
  });

  it('returns the exit code and retained tail to the model and final transcript upsert', async () => {
    const script = path.join(cwd, 'output.cjs');
    await fs.writeFile(script, "require('node:fs').writeSync(1, 'HEAD' + 'x'.repeat(40000) + 'TAIL'); process.exit(7);");
    const h = harness();
    const [result] = await h.run([call('bash', { command: `node "${script.replace(/\\/g, '/')}"` })]);
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('HEAD');
    expect(result.content).toContain('TAIL');
    expect(result.content).toContain('exit code: 7');
    expect(result.content).toContain('10008 UTF-16 code units omitted');
    expect(result.content.length).toBeLessThan(MAX_OUTPUT + 200);
    expect(h.events.filter((e) => e.type === 'item.upsert' && e.item.id === 'bash').at(-1)).toMatchObject({ item: { output: result.content, exitCode: 7, status: 'error' } });
  });
});

describe('native real file and subprocess boundaries', () => {
  it('validates ranges and reports cwd, EOF, binary and directory errors explicitly', async () => {
    await fs.writeFile(path.join(cwd, 'text'), 'one\ntwo');
    await fs.writeFile(path.join(cwd, 'binary'), Buffer.from([0, 1, 2]));
    for (const args of [{ path: 'missing' }, { path: '.', offset: 1 }, { path: 'binary' }, { path: 'text', offset: 0 }, { path: 'text', limit: 1.5 }, { path: 'text', offset: 4 }]) {
      const res = await readFileTool(cwd, args);
      expect(res.isError).toBe(true);
      expect(res.output).toContain(cwd);
      expect(res.fileVersion).toBeUndefined();
    }
    expect((await readFileTool(cwd, { path: 'text', offset: 4 })).output).toContain('beyond EOF (2 lines)');
  });

  it('provides exact UTF-8 byte continuation without granting a partial read fingerprint', async () => {
    await fs.writeFile(path.join(cwd, 'long'), '€'.repeat(70000) + 'THE_END');
    const first = await readFileTool(cwd, { path: 'long' });
    expect(first.output).toContain('byte_offset=180000');
    expect(first.output).not.toContain('\ufffd');
    expect(first.fileVersion).toBeUndefined();
    const rest = await readFileTool(cwd, { path: 'long', byte_offset: 180000 });
    expect(rest.output).toContain('THE_END');
    expect(rest.fileVersion).toBeUndefined();
    expect((await readFileTool(cwd, { path: 'long', byte_offset: 1 })).isError).toBe(true);
  });

  it('times out with explicit millisecond units and removes abort listeners', async () => {
    const script = path.join(cwd, 'wait.cjs');
    await fs.writeFile(script, 'setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await runBash(cwd, `node "${script.replace(/\\/g, '/')}"`, 1000, controller.signal);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('timed out after 1000 ms (timeout_ms=1000)');
    expect(result.output).toContain('exit code:');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  }, 15_000);

  it('cancels a running process and removes abort listeners', async () => {
    await fs.writeFile(path.join(cwd, 'cancel.cjs'), "console.log('READY'); setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await runBash(cwd, 'node cancel.cjs', 10_000, controller.signal, (text) => { if (text.includes('READY')) controller.abort(); });
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('interrupted by user') });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  }, 15_000);

  it('does not start a pre-aborted mutation and cleans listeners on spawn error', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runBash(cwd, 'node -e "require(\'fs\').writeFileSync(\'bad\',\'bad\')"', 1000, controller.signal);
    expect(result.output).toContain('not started');
    expect(await fs.readdir(cwd)).toEqual([]);
    const next = new AbortController();
    const remove = vi.spyOn(next.signal, 'removeEventListener');
    const error = await runBash(path.join(cwd, 'missing'), 'node -v', 1000, next.signal);
    expect(error).toMatchObject({ isError: true, exitCode: null, output: expect.stringContaining('Failed to start shell') });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('native search honesty', () => {
  it.each([false, true])('smart-case and exact cap/overflow work with fallback=%s', async (fallback) => {
    if (!fallback) expect(which('rg'), 'ripgrep must be installed for the real-engine regression').toBeTruthy();
    mocks.fallback = fallback;
    await fs.writeFile(path.join(cwd, 'matches.txt'), 'needle\nNEEDLE\nNeedle\n');
    for (const pattern of ['needle', '\\S+']) {
      const exact = await grepTool(cwd, { pattern, max_results: 3 }, signal());
      expect(exact.isError).toBe(false);
      expect(exact.output).toContain('NEEDLE');
      expect(exact.output).not.toContain('Results truncated');
      const overflow = await grepTool(cwd, { pattern, max_results: 2 }, signal());
      expect(overflow.output).toContain('Results truncated: more than 2');
    }
    const sensitive = await grepTool(cwd, { pattern: 'Needle', max_results: 1 }, signal());
    expect(sensitive.output).toContain('Needle');
    expect(sensitive.output).not.toContain('NEEDLE');
    expect(sensitive.output).not.toContain('Results truncated');
    await fs.writeFile(path.join(cwd, 'matches.txt'), Array.from({ length: 60 }, () => 'needle').join('\n'));
    const many = await grepTool(cwd, { pattern: 'needle', max_results: 60 }, signal());
    expect(many.output.split('\n')).toHaveLength(60);
    expect(many.output).not.toContain('truncated');
  });

  it('reports and cleans up a worker initialization failure before the first match request', async () => {
    mocks.fallback = true;
    mocks.failWorker = true;
    await fs.writeFile(path.join(cwd, 'text'), 'needle');
    const result = await grepTool(cwd, { pattern: 'needle' }, signal());
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('injected worker initialization failure') });
    expect(mocks.workerTerminated).toHaveBeenCalledTimes(1);
  });

  it('reports skipped oversized and ignored fallback inputs and bounds pathological regex execution', async () => {
    mocks.fallback = true;
    await fs.writeFile(path.join(cwd, 'huge'), 'x'.repeat(2_000_001));
    await fs.mkdir(path.join(cwd, 'node_modules'));
    const skipped = await grepTool(cwd, { pattern: 'needle' }, signal());
    expect(skipped.output).toContain('Skipped 2');
    await fs.writeFile(path.join(cwd, 'evil'), 'a'.repeat(100) + '!');
    const result = await grepTool(cwd, { pattern: '(a+)+$', path: 'evil' }, signal());
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('regex timed out') });
  }, 10_000);

  it('glob detects max+1 rather than claiming truncation at exactly 2000', async () => {
    await Promise.all(Array.from({ length: 2000 }, (_, i) => fs.writeFile(path.join(cwd, `${i}.txt`), '')));
    const exact = await globTool(cwd, { pattern: '*.txt' });
    expect(exact.output.split('\n')).toHaveLength(2000);
    expect(exact.output).not.toContain('truncated');
    await fs.writeFile(path.join(cwd, 'extra.txt'), '');
    expect((await globTool(cwd, { pattern: '*.txt' })).output).toContain('Results truncated: more than 2000');
  }, 20_000);
});
