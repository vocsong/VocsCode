import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AsyncQueue, LineSplitter } from '../src/main/util/async';
import { globToRegExp } from '../src/main/harness/native/tools';
import { parseUnifiedDiff } from '../src/shared/diff-parse';
import { JsonRpcStdioClient } from '../src/main/harness/jsonrpc';
import { gateAction } from '../src/main/harness/permissions';
import { isDangerousCommand } from '../src/main/harness/types';
import { normalizeSettings, defaultSettings } from '../src/main/settings';
import { estimateCostUsd, findPricing } from '../src/main/models/static-models';
import { piModelToInfo } from '../src/main/harness/pi';
import { codexModelToInfo } from '../src/main/harness/codex-app-server';
import { applyModelOverrides, modelOverrideKey, parseModelOverrideKey, pruneModelOverrides } from '../src/shared/model-overrides';
import { HARNESSES } from '../src/shared/harness-meta';
import type { ModelInfo } from '../src/shared/types';

describe('LineSplitter', () => {
  it('splits on LF only and strips CR', () => {
    const lines: string[] = [];
    const s = new LineSplitter((l) => lines.push(l));
    s.push('{"a":1}\r\n{"b":"x y"}\n{"c"');
    s.push(':3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":"x y"}', '{"c":3}']);
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

describe('settings normalization', () => {
  it('keeps builtin providers and merges stored overrides', () => {
    const d = defaultSettings();
    const s = normalizeSettings({ theme: 'dark', providers: [{ ...d.providers[0], hasApiKey: true, models: [{ id: 'm', provider: 'anthropic', displayName: 'M' }] }, { id: 'custom', kind: 'openai-compatible', name: 'C', hasApiKey: false, models: [], enabled: true }] });
    expect(s.theme).toBe('dark');
    expect(s.providers.find((p) => p.id === 'anthropic')?.hasApiKey).toBe(true);
    expect(s.providers.find((p) => p.id === 'anthropic')?.models).toHaveLength(1);
    expect(s.providers.filter((p) => p.builtin).length).toBe(d.providers.length);
    expect(s.providers.find((p) => p.id === 'custom')?.builtin).toBe(false);
    expect(s.acpAgents.length).toBe(d.acpAgents.length);
  });
});

describe('pricing', () => {
  it('finds pricing and estimates cost', () => {
    const p = findPricing('anthropic', 'claude-opus-5');
    expect(p?.input).toBe(5);
    expect(estimateCostUsd(p, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(5);
    expect(findPricing('openrouter', 'openai/gpt-5.4')?.input).toBe(2.5);
  });
});

describe('model mapping', () => {
  it('maps pi models', () => {
    const m = piModelToInfo({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', reasoning: true, input: ['text'], contextWindow: 1_000_000, cost: { input: 0.435, output: 0.87 }, thinkingLevelMap: { minimal: null, high: 'high', max: 'max' } });
    expect(m.supportedEfforts).toEqual(['high', 'max']);
    expect(m.supportsImages).toBe(false);
    expect(m.pricing?.output).toBe(0.87);
  });
  it('maps codex models', () => {
    const m = codexModelToInfo({ id: 'x', model: 'gpt-5.5', displayName: 'GPT-5.5', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'], isDefault: true });
    expect(m.id).toBe('gpt-5.5');
    expect(m.supportsImages).toBe(true);
    expect(m.pricing?.input).toBe(5);
  });
});

describe('model capability overrides', () => {
  const models: ModelInfo[] = [
    { id: 'deepseek-v4.1-flash-expires-on-0910', provider: 'deepseek', displayName: 'DeepSeek V4.1 Flash', supportsImages: false },
    { id: 'claude-opus-5', provider: 'anthropic', displayName: 'Claude Opus 5', supportsImages: true }
  ];

  it('keys by provider and keeps slashes in the model id', () => {
    const key = modelOverrideKey('openrouter', 'openai/gpt-5.4');
    expect(key).toBe('openrouter/openai/gpt-5.4');
    expect(parseModelOverrideKey(key)).toEqual({ provider: 'openrouter', model: 'openai/gpt-5.4' });
  });

  it('applies only to the matching model and flags it as overridden', () => {
    const out = applyModelOverrides(models, { 'deepseek/deepseek-v4.1-flash-expires-on-0910': { supportsImages: true } });
    expect(out[0].supportsImages).toBe(true);
    expect(out[0].overridden).toBe(true);
    expect(out[1]).toBe(models[1]);
  });

  it('can also mark a model as text-only', () => {
    const out = applyModelOverrides(models, { 'anthropic/claude-opus-5': { supportsImages: false } });
    expect(out[1].supportsImages).toBe(false);
  });

  it('is a no-op without overrides, and ignores ones for other providers', () => {
    expect(applyModelOverrides(models, undefined)).toBe(models);
    expect(applyModelOverrides(models, {})).toBe(models);
    // Same model slug, different provider: must not match.
    expect(applyModelOverrides(models, { 'openrouter/claude-opus-5': { supportsImages: false } })[1].supportsImages).toBe(true);
  });

  it('prunes entries that no longer carry a value', () => {
    expect(pruneModelOverrides({ 'a/b': {}, 'c/d': { supportsImages: false } })).toEqual({ 'c/d': { supportsImages: false } });
  });

  it('survives a settings round-trip and drops empty entries', () => {
    expect(defaultSettings().modelOverrides).toEqual({});
    const s = normalizeSettings({ modelOverrides: { 'deepseek/x': { supportsImages: true }, 'deepseek/y': {} } });
    expect(s.modelOverrides).toEqual({ 'deepseek/x': { supportsImages: true } });
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).modelOverrides).toEqual({});
  });

  it('marks pi as the only harness that strips images itself', () => {
    const dropping = HARNESSES.filter((h) => h.capabilities.dropsUnsupportedImages).map((h) => h.id);
    expect(dropping).toEqual(['pi']);
    // Every harness still accepts attachments from the composer.
    expect(HARNESSES.every((h) => h.capabilities.images)).toBe(true);
  });

  it('normalizes favoriteModels to valid model refs', () => {
    expect(defaultSettings().favoriteModels).toEqual([]);
    const s = normalizeSettings({
      favoriteModels: [
        { provider: 'openrouter', model: 'openai/gpt-4o' },
        { provider: 'openrouter' },
        'openrouter::junk'
      ] as never
    });
    expect(s.favoriteModels).toEqual([{ provider: 'openrouter', model: 'openai/gpt-4o' }]);
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).favoriteModels).toEqual([]);
  });
});
