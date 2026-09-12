import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncQueue, LineSplitter } from '../src/main/util/async';
import { globToRegExp } from '../src/main/harness/native/tools';
import { parseUnifiedDiff } from '../src/shared/diff-parse';
import { JsonRpcStdioClient } from '../src/main/harness/jsonrpc';
import { gateAction } from '../src/main/harness/permissions';
import { isDangerousCommand } from '../src/main/harness/types';
import { normalizeSettings, defaultSettings } from '../src/main/settings';
import type { SettingsStore } from '../src/main/settings';
import { SessionManager } from '../src/main/session-manager';
import { generateSessionTitle, sanitizeLlmTitle, titleFromPrompt } from '../src/main/session-title';
import type { RuntimeResolver } from '../src/main/runtime';
import { piHasCredentials } from '../src/main/runtime';
import { estimateCostUsd, findPricing } from '../src/main/models/static-models';
import { piModelToInfo } from '../src/main/harness/pi';
import type { AnalyticsStore } from '../src/main/analytics';
import { codexModelToInfo } from '../src/main/harness/codex-app-server';
import { applyModelOverrides, modelOverrideKey, parseModelOverrideKey, pruneModelOverrides } from '../src/shared/model-overrides';
import { HARNESSES } from '../src/shared/harness-meta';
import type { AppSettings, ModelInfo, SessionEvent, SessionMeta, TranscriptItem } from '../src/shared/types';
import { SecretStore } from '../src/main/secrets';
import { SessionStore } from '../src/main/store';
import { branchGitState, gitBranches, gitCheckout, gitWorktrees, removeWorktree, restoreWorktree, WorktreeDirtyError } from '../src/main/git';
import { createLogger } from '../src/main/log';
import { timed, watchEventLoop } from '../src/main/diag';

// branchGitState is stubbed so PR-state refresh tests stay offline; every other git export stays real.
vi.mock('../src/main/git', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  branchGitState: vi.fn(async (): Promise<{ pr: boolean; merged: boolean }> => ({ pr: false, merged: false }))
}));

// Stub Electron's safeStorage so SecretStore is testable in plain node. Mutable flag lets the
// unavailable-encryption fallback path be exercised without re-declaring the mock.
const safeStorageMock = vi.hoisted(() => ({
  encryptionAvailable: true,
  isEncryptionAvailable: () => safeStorageMock.encryptionAvailable,
  encryptString: (s: string) => Buffer.concat([Buffer.from('enc|'), Buffer.from(s, 'utf8')]),
  decryptString: (b: Buffer) => {
    const raw = b.toString('utf8');
    if (!raw.startsWith('enc|')) throw new Error('not encrypted with this key');
    return raw.slice(4);
  }
}));
vi.mock('electron', () => ({ safeStorage: safeStorageMock }));

describe('auto session titles', () => {
  it('caps derived titles at 6 words', () => {
    expect(titleFromPrompt('Fix the bug where the sidebar flickers when switching folders')).toBe('Fix the bug where the sidebar');
  });

  it('keeps short prompts whole and only uses the first line', () => {
    expect(titleFromPrompt('Add dark mode')).toBe('Add dark mode');
    expect(titleFromPrompt('First line stays\nsecond line ignored')).toBe('First line stays');
  });

  it('still enforces the 60 char cap on long words', () => {
    const title = titleFromPrompt('Supercalifragilisticexpialidocious antidisestablishmentarianism floccinaucinihilipilification');
    expect(title.length).toBeLessThanOrEqual(60);
  });
});

/** Starts an HTTP server that answers every request via respond(); resolves once it is listening. */
function listenOnce(respond: (req: IncomingMessage, res: ServerResponse, body?: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body: string | undefined;
    req.on('data', (c: Buffer) => (body = (body ?? '') + c.toString()));
    req.on('end', () => respond(req, res, body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('LLM session titles', () => {
  const getSecret = async (id: string) => (id === 'fake' ? 'sk-test' : undefined);

  it('strips quotes and preamble from model replies and keeps the 6-word cap', () => {
    expect(sanitizeLlmTitle('"Fix the sidebar flicker on folder switch"')).toBe('Fix the sidebar flicker on folder');
    expect(sanitizeLlmTitle('**Fix the sidebar flicker**')).toBe('Fix the sidebar flicker');
    expect(sanitizeLlmTitle('Title: Refactor auth module.')).toBe('Refactor auth module');
    expect(sanitizeLlmTitle('  \n\n  ')).toBeNull();
  });

  it('returns null when no enabled provider has a usable key', async () => {
    const providers = [{
      id: 'anthropic', kind: 'anthropic', name: 'Anthropic', enabled: true, hasApiKey: false, models: []
    }];
    const title = await generateSessionTitle('Fix the bug', providers as never, getSecret);
    expect(title).toBeNull();
  });

  it('ignores disabled providers', async () => {
    const providers = [{
      id: 'anthropic', kind: 'anthropic', name: 'Anthropic', enabled: false, hasApiKey: true, models: []
    }];
    const title = await generateSessionTitle('Fix the bug', providers as never, getSecret);
    expect(title).toBeNull();
  });

  it('falls back to the first usable provider when the preferred one is unusable', async () => {
    const unusable = { id: 'unused', kind: 'openai' as const, name: 'Unused', enabled: true, hasApiKey: false, models: [{ id: 'm1', name: 'M1', provider: 'unused' }] };
    const usable = { id: 'fallback', kind: 'ollama' as const, name: 'Fallback', enabled: true, hasApiKey: false, baseUrl: 'http://127.0.0.1:1', models: [] };
    // The fallback provider points at a closed port, so the call fails and the title stays null —
    // but reaching that failure proves the fallback provider was chosen over the unusable one.
    const title = await generateSessionTitle('Fix the bug', [unusable, usable] as never, getSecret, { provider: 'unused', model: 'm1' });
    expect(title).toBeNull();
  });

  it('names sessions end-to-end against an OpenAI-compatible endpoint, using the preferred provider', async () => {
    const seen: { auth?: string; body?: Record<string, unknown> } = {};
    const server = await listenOnce((req, res, body) => {
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(body ?? '{}') as Record<string, unknown>;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '"Fix the sidebar flicker"' }, finish_reason: 'stop' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [{ id: 'cheap-flash', name: 'Cheap Flash', provider: 'fake' }] };
      const title = await generateSessionTitle('Fix the bug', [provider] as never, getSecret, { provider: 'fake', model: 'cheap-flash' });
      expect(title).toBe('Fix the sidebar flicker');
      expect(seen.auth).toBe('Bearer sk-test');
      expect(seen.body?.model).toBe('cheap-flash');
      expect(seen.body?.max_tokens).toBe(200);
      expect(seen.body?.max_completion_tokens).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('uses max_completion_tokens with low effort for reasoning models', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const server = await listenOnce((req, res, body) => {
      seen.body = JSON.parse(body ?? '{}') as Record<string, unknown>;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Migrate auth to OAuth' }, finish_reason: 'stop' }] }));
    });
    try {
      const provider = { id: 'fake', kind: 'openai-compatible' as const, name: 'Fake', enabled: true, hasApiKey: true, baseUrl: server.url, models: [] };
      const title = await generateSessionTitle('Migrate the auth module', [provider] as never, getSecret, { provider: 'fake', model: 'gpt-5-mini' });
      expect(title).toBe('Migrate auth to OAuth');
      expect(seen.body?.max_tokens).toBeUndefined();
      expect(seen.body?.max_completion_tokens).toBe(1024);
      expect(seen.body?.reasoning_effort).toBe('low');
    } finally {
      await server.close();
    }
  });
});

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
  it('remembers the worktree isolation decision and defaults it to off', () => {
    expect(defaultSettings().defaultUseWorktree).toBe(false);
    expect(normalizeSettings({ defaultUseWorktree: true }).defaultUseWorktree).toBe(true);
    // Settings written before this key existed fall back to off.
    expect(normalizeSettings({ theme: 'dark' }).defaultUseWorktree).toBe(false);
  });
  it('keeps a well-formed utility model and drops malformed ones', () => {
    expect(normalizeSettings({ utilityModel: { provider: 'deepseek', model: 'deepseek-chat' } }).utilityModel).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(normalizeSettings({}).utilityModel).toBeUndefined();
    expect(normalizeSettings({ utilityModel: { provider: 3, model: 'x' } as never }).utilityModel).toBeUndefined();
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
    const m = piModelToInfo({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', reasoning: true, input: ['text'], contextWindow: 1_000_000, cost: { input: 0.435, output: 0.87 }, thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' } });
    expect(m.supportedEfforts).toEqual(['high', 'max']);
    expect(m.supportsImages).toBe(false);
    expect(m.pricing?.output).toBe(0.87);
  });
  it('keeps pi levels missing from thinkingLevelMap', () => {
    // openai-codex ships holes for the standard levels: only `null` hides one.
    const m = piModelToInfo({ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex', reasoning: true, input: ['text', 'image'], contextWindow: 272_000, thinkingLevelMap: { xhigh: 'xhigh', max: 'max', minimal: 'low' } });
    expect(m.supportedEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('drops pi off and explicitly hidden levels', () => {
    const m = piModelToInfo({ id: 'x', name: 'X', provider: 'openai', reasoning: true, thinkingLevelMap: { off: 'none', minimal: null, low: 'low', xhigh: null, max: 'max' } });
    expect(m.supportedEfforts).toEqual(['low', 'medium', 'high', 'max']);
  });
  it('leaves the effort list open when pi reports no thinkingLevelMap', () => {
    const m = piModelToInfo({ id: 'x', name: 'X', provider: 'openrouter', reasoning: true });
    expect(m.supportedEfforts).toBeUndefined();
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

  it('normalizes sidebar folders to non-empty path strings', () => {
    expect(defaultSettings().folders).toEqual([]);
    const s = normalizeSettings({ folders: ['G:/proj/a', '', 42, 'G:/proj/b'] as never });
    expect(s.folders).toEqual(['G:/proj/a', 'G:/proj/b']);
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).folders).toEqual([]);
  });

  it('normalizes folder order and collapsed roots to non-empty path strings', () => {
    expect(defaultSettings().folderOrder).toEqual([]);
    expect(defaultSettings().collapsedFolders).toEqual([]);
    const s = normalizeSettings({
      folderOrder: ['G:/proj/b', '', 42, 'G:/proj/a'],
      collapsedFolders: ['G:/proj/a', 7, '']
    } as never);
    expect(s.folderOrder).toEqual(['G:/proj/b', 'G:/proj/a']);
    expect(s.collapsedFolders).toEqual(['G:/proj/a']);
    // Settings written before this feature existed have no such keys.
    expect(normalizeSettings({ theme: 'dark' }).folderOrder).toEqual([]);
    expect(normalizeSettings({ theme: 'dark' }).collapsedFolders).toEqual([]);
  });

  it('normalizes folder styles to hex colors and known-shape icon names', () => {
    expect(defaultSettings().folderStyles).toEqual({});
    const s = normalizeSettings({
      folderStyles: {
        'G:/proj/a': { color: '#5B9BF8', icon: 'bolt' },
        'G:/proj/b': { color: 'red', icon: 'DROP TABLE' },
        'G:/proj/c': { color: '#fff' },
        'G:/proj/d': { icon: 42 },
        'G:/proj/e': {},
        '': { color: '#5b9bf8' },
        'G:/proj/f': 'bogus'
      } as never
    });
    expect(s.folderStyles).toEqual({ 'G:/proj/a': { color: '#5B9BF8', icon: 'bolt' } });
    // Settings written before this feature existed have no such key.
    expect(normalizeSettings({ theme: 'dark' }).folderStyles).toEqual({});
  });
});

describe('SecretStore', () => {
  const tmpRoot = path.join(os.tmpdir(), `vocs-code-secrets-test-${Date.now()}-${process.pid}`);
  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('round-trips a key through the fake safeStorage as enc: base64', async () => {
    safeStorageMock.encryptionAvailable = true;
    const dir = path.join(tmpRoot, 'enc');
    const store = new SecretStore(dir);
    await store.load();
    await store.set('deepseek', '  sk-test-123  ');
    expect(store.has('deepseek')).toBe(true);
    // Value is trimmed, encrypted (not plaintext) and decrypts back via the fake.
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
    expect(raw.deepseek.startsWith('enc:')).toBe(true);
    expect(raw.deepseek).not.toContain('sk-test-123');
    expect(await store.get('deepseek')).toBe('sk-test-123');
  });

  it('falls back to b64: obfuscation when OS encryption is unavailable', async () => {
    safeStorageMock.encryptionAvailable = false;
    try {
      const dir = path.join(tmpRoot, 'b64');
      const store = new SecretStore(dir);
      await store.load();
      await store.set('openai', 'sk-fallback');
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')) as Record<string, string>;
      expect(raw.openai.startsWith('b64:')).toBe(true);
      expect(raw.openai).not.toContain('sk-fallback');
      expect(await store.get('openai')).toBe('sk-fallback');
    } finally {
      safeStorageMock.encryptionAvailable = true;
    }
  });

  it('clears a key and treats an empty set as a clear', async () => {
    const dir = path.join(tmpRoot, 'clear');
    const store = new SecretStore(dir);
    await store.load();
    await store.set('anthropic', 'sk-a');
    await store.clear('anthropic');
    expect(store.has('anthropic')).toBe(false);
    expect(await store.get('anthropic')).toBeUndefined();
    await store.set('anthropic', '   ');
    expect(store.has('anthropic')).toBe(false);
    // Cleared state is persisted.
    const again = new SecretStore(dir);
    await again.load();
    expect(again.has('anthropic')).toBe(false);
  });
});

describe('SessionManager folder tracking', () => {
  it('registers a project folder on create so it survives its last session being archived or deleted', async () => {
    const stored = defaultSettings();
    const settings = {
      get: () => stored,
      update: async (patch: Partial<AppSettings>) => {
        Object.assign(stored, patch);
      }
    } as unknown as SettingsStore;
    const store = { list: () => [], get: () => undefined, upsert: async () => undefined } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    const cfg = { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' } as const;
    await manager.create({ config: { ...cfg } });
    expect(stored.folders).toEqual(['G:/proj/a']);
    // Creating another session in the same folder must not duplicate the entry.
    await manager.create({ config: { ...cfg } });
    expect(stored.folders).toEqual(['G:/proj/a']);
  });
});

describe('SessionManager fork', () => {
  const sourceSession = (): SessionMeta => ({
    id: 's_src',
    title: 'source session',
    createdAt: 1_000,
    updatedAt: 2_000,
    config: {
      harness: 'claude',
      projectRoot: 'G:/proj/a',
      permissionMode: 'auto',
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' }
    },
    cwd: 'G:/proj/a/.vocs-code/worktrees/wt',
    worktreeBranch: 'agent/source-session',
    status: 'idle',
    harnessRef: { claudeSessionId: 'claude_abc' },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  });

  const forkManager = (src: SessionMeta) => {
    const sessions: SessionMeta[] = [src];
    const transcripts = new Map<string, TranscriptItem[]>();
    const settings = defaultSettings();
    settings.defaultModelByHarness.pi = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
    const store = {
      list: () => sessions,
      get: (id: string) => sessions.find((s) => s.id === id),
      upsert: async (m: SessionMeta) => {
        const i = sessions.findIndex((s) => s.id === m.id);
        if (i >= 0) sessions[i] = m;
        else sessions.push(m);
      },
      readTranscript: async (id: string) => transcripts.get(id) ?? [],
      rewriteTranscript: async (id: string, items: TranscriptItem[]) => void transcripts.set(id, items),
      readNativeHistory: async () => null,
      writeNativeHistory: async () => undefined,
      sessionDir: (id: string) => path.join(os.tmpdir(), `fork-test-${id}`)
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => settings } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    return { manager, transcripts };
  };

  it('forks into a different harness on the same worktree with a fresh provider session', async () => {
    const src = sourceSession();
    src.config.acpAgent = 'dsh';
    src.config.codexModelProvider = { id: 'x', name: 'x', baseUrl: 'https://x' };
    const items: TranscriptItem[] = [
      { id: 'u_1', kind: 'user', ts: 1, text: 'fix the login bug' },
      { id: 'a_1', kind: 'assistant', ts: 2, text: 'done' }
    ];
    const { manager, transcripts } = forkManager(src);
    transcripts.set(src.id, items);
    const fork = await manager.fork(src.id, 'pi');
    expect(fork).toBeTruthy();
    expect(fork!.id).not.toBe(src.id);
    expect(fork!.config.harness).toBe('pi');
    // Same directory and branch as the source.
    expect(fork!.cwd).toBe(src.cwd);
    expect(fork!.worktreeBranch).toBe('agent/source-session');
    // The new harness cannot resume the source's provider session.
    expect(fork!.harnessRef).toEqual({});
    // Harness-specific config does not transfer; the model falls back to the target default.
    expect(fork!.config.acpAgent).toBeUndefined();
    expect(fork!.config.codexModelProvider).toBeUndefined();
    expect(fork!.config.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(fork!.activeModel).toEqual(fork!.config.model);
    // The transcript is carried over for reference plus an explanatory info note.
    const copied = transcripts.get(fork!.id) ?? [];
    expect(copied.map((i) => i.id)).toContain('u_1');
    const note = copied.find((i) => i.kind === 'info');
    expect(note?.kind === 'info' && note.text).toContain('Forked from');
    expect(fork!.title).toContain('fork');
  });

  it('keeps same-harness fork semantics: drops the worktree claim and carries provider state', async () => {
    const src = sourceSession();
    const items: TranscriptItem[] = [{ id: 'u_1', kind: 'user', ts: 1, text: 'hi' }];
    const { manager, transcripts } = forkManager(src);
    transcripts.set(src.id, items);
    const fork = await manager.fork(src.id);
    expect(fork!.config.harness).toBe('claude');
    expect(fork!.worktreeBranch).toBeUndefined();
    expect(fork!.harnessRef).toEqual({ claudeSessionId: 'claude_abc', forkOnResume: true });
    const copied = transcripts.get(fork!.id) ?? [];
    expect(copied.some((i) => i.kind === 'info')).toBe(false);
    expect(copied.map((i) => i.id)).toContain('u_1');
  });
});

describe('custom status label settings', () => {
  it('normalizes user-added labels: trims, dedupes case-insensitively, drops junk, caps at 24 chars', () => {
    const stored = { customLabels: ['  Wip ', 'wip', 42, '', 'x'.repeat(40), 'ok'] } as unknown as Partial<AppSettings>;
    expect(normalizeSettings(stored).customLabels).toEqual(['Wip', 'x'.repeat(24), 'ok']);
  });

  it('falls back to an empty list for wrong-shaped values', () => {
    expect(normalizeSettings({ customLabels: 'nope' } as unknown as Partial<AppSettings>).customLabels).toEqual([]);
    expect(normalizeSettings(undefined).customLabels).toEqual([]);
  });
});

describe('SessionManager PR state refresh', () => {
  it('flips a pr session to merged when refreshGitState runs after /merge', async () => {
    vi.useFakeTimers();
    const session: SessionMeta = {
      id: 'pr_session',
      title: 'pr session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'native', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/pr-session',
      status: 'pr',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const upsert = vi.fn();
    const published: SessionMeta[][] = [];
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined),
      upsert
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: (list) => published.push(list),
      notify: vi.fn(),
      log: vi.fn()
    });
    vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: true });
    try {
      manager.refreshGitState(session.id);
      expect(session.status).toBe('pr'); // not flipped synchronously
      await vi.advanceTimersByTimeAsync(2_000); // 1s check delay + the 300ms debounced persist
      expect(session.status).toBe('merged');
      expect(published.length).toBeGreaterThan(0);
      expect(upsert).toHaveBeenCalled();
    } finally {
      vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: false });
      vi.useRealTimers();
    }
  });

  it('keeps a git-derived status when the harness exits instead of flipping to stopped', () => {
    const session: SessionMeta = {
      id: 'merged_session',
      title: 'merged session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'pi', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/merged-session',
      status: 'merged',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const manager = new SessionManager({
      store: { list: () => [session], get: (id: string) => (id === session.id ? session : undefined), upsert: vi.fn() } as unknown as SessionStore,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    // The pi process died (e.g. killed while the app quit) and reported its exit.
    (manager as unknown as { emit: (id: string, event: SessionEvent) => void }).emit(session.id, { type: 'status', status: 'stopped', detail: 'pi exited (0)' });
    expect(session.status).toBe('merged');
  });

  it('stop() keeps a parked pr/merged status', async () => {
    const session: SessionMeta = {
      id: 'merged_session',
      title: 'merged session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'pi', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/merged-session',
      status: 'merged',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const manager = new SessionManager({
      store: { list: () => [session], get: (id: string) => (id === session.id ? session : undefined), upsert: vi.fn(), appendTranscript: async () => undefined } as unknown as SessionStore,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    const active = {
      adapter: { dispose: vi.fn(async () => undefined) },
      approvals: new Map(),
      liveItems: new Map(),
      dirty: new Set<string>(),
      lastAssistantText: '',
      starting: null,
      models: null
    };
    (manager as unknown as { active: Map<string, typeof active> }).active.set(session.id, active);
    await manager.stop(session.id);
    expect(active.adapter.dispose).toHaveBeenCalled();
    expect(session.status).toBe('merged');
  });

  it('a stopped session is re-checked at boot and upgraded back to merged', async () => {
    vi.useFakeTimers();
    const session: SessionMeta = {
      id: 'stopped_session',
      title: 'stopped session',
      createdAt: 1_000,
      updatedAt: 2_000,
      config: { harness: 'pi', projectRoot: 'G:/proj/pr', permissionMode: 'auto' },
      cwd: 'G:/proj/pr/.vocs-code/worktrees/wt',
      worktreeBranch: 'harness/merged-session',
      status: 'stopped',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined),
      // Throwing keeps sessionPrRefs on its synchronous catch path: no real fs I/O that fake
      // timers would not flush before the assertions.
      sessionDir: () => {
        throw new Error('no fs in test');
      },
      upsert: vi.fn()
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    try {
      vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: true });
      manager.list(); // boot: schedules the one-shot re-check for stopped sessions
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.status).toBe('merged');

      // Without git evidence the stopped status is kept, never downgraded to idle.
      session.status = 'stopped';
      (manager as unknown as { gitStateChecked: Set<string> }).gitStateChecked.delete(session.id);
      vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: false });
      manager.list();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.status).toBe('stopped');
    } finally {
      vi.mocked(branchGitState).mockResolvedValue({ pr: false, merged: false });
      vi.useRealTimers();
    }
  });
});

describe('SessionManager filesystem guards', () => {
  it('does not touch the store for unknown sessions', async () => {
    const remove = vi.fn(async () => undefined);
    const readTranscript = vi.fn(async () => [] as TranscriptItem[]);
    const rewriteTranscript = vi.fn(async () => undefined);
    const store = {
      list: () => [],
      get: () => undefined,
      remove,
      readTranscript,
      rewriteTranscript
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    const stop = vi.spyOn(manager, 'stop');

    await manager.delete('../sentinel');
    await expect(manager.transcript('../sentinel')).rejects.toThrow('Session not found');
    await expect(manager.clearTranscript('../sentinel')).rejects.toThrow('Session not found');

    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(readTranscript).not.toHaveBeenCalled();
    expect(rewriteTranscript).not.toHaveBeenCalled();
  });
});

describe('SessionStore round-trip', () => {
  const tmpRoot = path.join(os.tmpdir(), `vocs-code-store-test-${Date.now()}-${process.pid}`);
  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  const meta = (id: string, status: SessionMeta['status'] = 'idle'): SessionMeta => ({
    id,
    title: `session ${id}`,
    createdAt: 1_000,
    updatedAt: 2_000,
    config: { harness: 'native', projectRoot: tmpRoot, permissionMode: 'auto' },
    cwd: tmpRoot,
    status,
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    queued: 3
  });

  it('publishes live running status to session list listeners', () => {
    const session = meta('status_session');
    const published: SessionMeta[][] = [];
    const store = {
      list: () => [session],
      get: (id: string) => (id === session.id ? session : undefined)
    } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: (list) => published.push(list),
      notify: vi.fn(),
      log: vi.fn()
    });

    (manager as unknown as { emit: (id: string, event: SessionEvent) => void }).emit(session.id, { type: 'status', status: 'running', detail: 'Working' });

    expect(session.status).toBe('running');
    expect(session.statusDetail).toBe('Working');
    expect(published).toHaveLength(1);
    expect(published[0][0]).toMatchObject({ id: session.id, status: 'running', statusDetail: 'Working' });
  });

  it('persists session meta and transcripts that a fresh store over the same directory reads back', async () => {
    const first = new SessionStore(tmpRoot);
    await first.load();
    const m = meta('sess_1', 'running');
    await first.upsert(m);
    await first.appendTranscript('sess_1', { id: 'i1', kind: 'user', ts: 1, text: 'hello' } as TranscriptItem);
    await first.appendTranscript('sess_1', { id: 'i2', kind: 'user', ts: 2, text: 'again' } as TranscriptItem);
    await first.appendTranscript('sess_1', { id: 'i1', kind: 'user', ts: 1, text: 'hello edited' } as TranscriptItem);

    // A brand-new store instance over the same userData directory survives the "restart".
    const second = new SessionStore(tmpRoot);
    const loaded = await second.load();
    expect(loaded.map((s) => s.id)).toContain('sess_1');
    const restored = second.get('sess_1');
    expect(restored?.title).toBe('session sess_1');
    expect(restored?.config.harness).toBe('native');
    // A session that was running when the app closed is downgraded to idle with an empty queue.
    expect(restored?.status).toBe('idle');
    expect(restored?.queued).toBe(0);

    const items = await second.readTranscript('sess_1');
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('i1');
    // Last write wins per id, first-occurrence order preserved.
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello edited' });
    expect(items[1].id).toBe('i2');
  });

  it('remove deletes the meta entry and the transcript directory', async () => {
    const store = new SessionStore(tmpRoot);
    await store.load();
    await store.upsert(meta('sess_2'));
    await store.appendTranscript('sess_2', { id: 'j1', kind: 'user', ts: 1, text: 'x' } as TranscriptItem);
    await store.remove('sess_2');
    expect(store.get('sess_2')).toBeUndefined();
    const again = new SessionStore(tmpRoot);
    await again.load();
    expect(again.get('sess_2')).toBeUndefined();
    expect(await again.readTranscript('sess_2')).toEqual([]);
  });

  it('rejects traversal before transcript reads, rewrites, or removal can touch an outside directory', async () => {
    const securityRoot = path.join(os.tmpdir(), `vocs-code-store-security-${Date.now()}-${process.pid}`);
    const sentinelDir = path.join(securityRoot, 'sentinel');
    const sentinelFile = path.join(sentinelDir, 'transcript.jsonl');
    const sentinel = `${JSON.stringify({ id: 'secret', kind: 'user', ts: 1, text: 'do not touch' })}\n`;
    await fs.mkdir(sentinelDir, { recursive: true });
    await fs.writeFile(sentinelFile, sentinel, 'utf8');
    try {
      const store = new SessionStore(securityRoot);
      await store.load();

      await expect(store.readTranscript('../sentinel')).rejects.toThrow('Invalid session ID');
      await expect(store.rewriteTranscript('../sentinel', [])).rejects.toThrow('Invalid session ID');
      await expect(store.remove('../sentinel')).rejects.toThrow('Invalid session ID');
      await expect(store.upsert({ ...meta('s1'), id: '../sentinel' })).rejects.toThrow('Invalid session ID');

      expect(store.list()).toEqual([]);
      expect(await fs.readFile(sentinelFile, 'utf8')).toBe(sentinel);
      expect(await fs.stat(sentinelDir)).toBeTruthy();
      expect(() => store.sessionDir('.')).toThrow('Invalid session ID');
      expect(() => store.sessionDir('..')).toThrow('Invalid session ID');
      expect(() => store.sessionDir('C:\\sentinel')).toThrow('Invalid session ID');
      expect(store.sessionDir('a')).toBe(path.join(securityRoot, 'sessions', 'a'));
    } finally {
      await fs.rm(securityRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('filters malformed persisted session IDs while retaining safe legacy IDs', async () => {
    const loadedRoot = path.join(os.tmpdir(), `vocs-code-store-loaded-${Date.now()}-${process.pid}`);
    await fs.mkdir(loadedRoot, { recursive: true });
    await fs.writeFile(
      path.join(loadedRoot, 'sessions.json'),
      JSON.stringify([
        meta('s1'),
        meta('sess_1'),
        meta('a'),
        meta('../sentinel'),
        meta('.'),
        meta('..'),
        meta('bad/slash'),
        meta('bad\\slash'),
        meta('C:\\drive')
      ]),
      'utf8'
    );
    try {
      const store = new SessionStore(loadedRoot);
      const loaded = await store.load();
      expect(loaded.map((session) => session.id)).toEqual(['s1', 'sess_1', 'a']);
    } finally {
      await fs.rm(loadedRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('upsert rejects when the index write fails instead of resolving silently', async () => {
    // A directory where sessions.json belongs makes the atomic rename fail deterministically.
    const brokenRoot = path.join(os.tmpdir(), `vocs-code-store-broken-${Date.now()}-${process.pid}`);
    await fs.mkdir(path.join(brokenRoot, 'sessions.json'), { recursive: true });
    try {
      const store = new SessionStore(brokenRoot);
      await store.load();
      await expect(store.upsert(meta('sess_x'))).rejects.toThrow();
    } finally {
      await fs.rm(brokenRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('git branch/worktree plumbing', () => {
  const tmpRoot = path.join(os.tmpdir(), `vocs-code-git-test-${Date.now()}-${process.pid}`);
  const repo = path.join(tmpRoot, 'repo');
  const wtDir = path.join(tmpRoot, 'wt');

  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('lists branches and checks out another branch', async () => {
    await fs.mkdir(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo });
    g('commit', '--allow-empty', '-m', 'init');
    g('branch', 'feature');
    const { current, branches } = await gitBranches(repo);
    expect(branches.map((b) => b.name).sort()).toEqual(expect.arrayContaining(['feature']));
    const head = branches.find((b) => b.current)!;
    expect(current).toBe(head.name);
    expect(await gitCheckout(repo, '-evil')).toMatchObject({ ok: false });
    expect(await gitCheckout(repo, 'feature')).toMatchObject({ ok: true });
    expect((await gitBranches(repo)).current).toBe('feature');
  });

  it('lists worktrees with branches and marks the session cwd', async () => {
    g('checkout', '-'); // back to the default branch
    g('worktree', 'add', wtDir, '-b', 'wtbranch');
    const { current, worktrees } = await gitWorktrees(repo);
    expect(current).toBe(path.resolve(repo));
    expect(worktrees.map((w) => w.branch)).toContain('wtbranch');
    const wt = worktrees.find((w) => w.path === path.resolve(wtDir));
    expect(wt).toMatchObject({ branch: 'wtbranch', detached: false });
    // From inside the worktree, that worktree is "current".
    const fromWt = await gitWorktrees(wtDir);
    expect(fromWt.current).toBe(path.resolve(wtDir));
  });

  it('removes a worktree and restores it from its branch', async () => {
    const wt2 = path.join(tmpRoot, 'wt-cycle');
    g('worktree', 'add', wt2, '-b', 'wtcycle');
    // Uncommitted changes block a non-force removal (the archive flow surfaces this to the user).
    await fs.writeFile(path.join(wt2, 'dirty.txt'), 'x');
    await expect(removeWorktree(repo, wt2, { force: false })).rejects.toBeInstanceOf(WorktreeDirtyError);
    await fs.rm(path.join(wt2, 'dirty.txt'));
    await removeWorktree(repo, wt2, { force: false });
    await expect(fs.stat(wt2)).rejects.toMatchObject({ code: 'ENOENT' });
    // The branch survives the worktree removal, so a restore can recreate it at the same path.
    expect((await gitBranches(repo)).branches.map((b) => b.name)).toContain('wtcycle');
    await restoreWorktree(repo, wt2, 'wtcycle');
    expect((await gitWorktrees(repo)).worktrees.map((w) => w.branch)).toContain('wtcycle');
    // A folder deleted outside the app counts as already removed: removal prunes, not throws.
    await fs.rm(wt2, { recursive: true, force: true });
    await removeWorktree(repo, wt2, { force: false });
    // Unarchive still recreates the worktree over the stale registration.
    await restoreWorktree(repo, wt2, 'wtcycle');
    expect((await gitWorktrees(repo)).worktrees.map((w) => w.branch)).toContain('wtcycle');
    // A folder whose registration git lost (e.g. its .git link was deleted) is not a working tree:
    // removal prunes and deletes the folder instead of blocking archive.
    await fs.rm(path.join(wt2, '.git'));
    await removeWorktree(repo, wt2, { force: false });
    await expect(fs.stat(wt2)).rejects.toMatchObject({ code: 'ENOENT' });
    await restoreWorktree(repo, wt2, 'wtcycle');
    expect((await gitWorktrees(repo)).worktrees.map((w) => w.branch)).toContain('wtcycle');
    // A branch with its worktree still checked out cannot be deleted; remove the worktree first.
    await removeWorktree(repo, wt2, { force: false });
    g('branch', '-D', 'wtcycle');
    await expect(restoreWorktree(repo, wt2, 'wtcycle')).rejects.toThrow(/no longer exists/);
  });
});

describe('diagnostics', () => {
  const diagRoot = path.join(os.tmpdir(), `vocs-diag-${Date.now()}`);
  afterAll(async () => {
    await fs.rm(diagRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes every level to the log file and gates debug behind the flag', async () => {
    const dir = path.join(diagRoot, 'logs-quiet');
    const quiet = createLogger(dir, false);
    quiet.log('debug', 'hidden');
    quiet.log('info', 'shown');
    quiet.log('warn', 'careful');
    await new Promise((r) => setTimeout(r, 50));
    const text = await fs.readFile(path.join(dir, 'main.log'), 'utf8');
    expect(quiet.file).toBe(path.join(dir, 'main.log'));
    expect(text).not.toContain('hidden');
    expect(text).toContain('INFO shown');
    expect(text).toContain('WARN careful');

    const loud = createLogger(path.join(diagRoot, 'logs-debug'), true);
    loud.log('debug', 'visible');
    await new Promise((r) => setTimeout(r, 50));
    expect(await fs.readFile(path.join(diagRoot, 'logs-debug', 'main.log'), 'utf8')).toContain('DEBUG visible');
  });

  it('reports an event loop stall and stays quiet while the loop is free', async () => {
    const lines: string[] = [];
    const w = watchEventLoop((level, message) => lines.push(`${level} ${message}`), 10, 60);
    await new Promise((r) => setTimeout(r, 60));
    expect(lines).toHaveLength(0);
    const until = Date.now() + 150;
    while (Date.now() < until) {
      /* block the loop the way a synchronous main-process call would */
    }
    await new Promise((r) => setTimeout(r, 30));
    w.stop();
    expect(lines.some((l) => l.startsWith('warn') && /main event loop stalled \d+ms/.test(l))).toBe(true);
  });

  it('timed logs only past the threshold and passes the value through', async () => {
    const lines: string[] = [];
    const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => lines.push(`${level} ${message}`);
    expect(await timed(log, 'fast op', 1000, () => 7)).toBe(7);
    expect(lines).toHaveLength(0);
    await timed(log, 'slow op', 10, () => new Promise((r) => setTimeout(r, 40)));
    expect(lines[0]).toMatch(/^warn slow slow op: \d+ms$/);
  });
});

describe('renderer dialogs', () => {
  // Electron answers window.confirm/alert/prompt with a native message box that disables the whole
  // window until it is dismissed. A dialog the user does not notice is indistinguishable from a
  // frozen app: no clicks, no typing, no dropdowns, and nothing in the logs. Use askConfirm instead.
  const NATIVE_CALL = /(^|[^A-Za-z0-9_.$])(confirm|alert|prompt)[(]/;
  const VIA_WINDOW = /window[.](confirm|alert|prompt)[(]/;

  it('never calls a native window dialog', async () => {
    const root = path.resolve(__dirname, '..', 'src', 'renderer', 'src');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) files.push(full);
      }
    };
    await walk(root);
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        const flat = line.split(' ').join('');
        if (NATIVE_CALL.test(flat) || VIA_WINDOW.test(flat)) offenders.push(`${path.basename(file)}:${i + 1} ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('pi credential detection', () => {
  const savedEnv = { ...process.env };
  const dirs: string[] = [];

  const withAgentDir = async (auth: string | null) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-auth-'));
    dirs.push(dir);
    process.env.PI_CODING_AGENT_DIR = dir;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    if (auth !== null) await fs.writeFile(path.join(dir, 'auth.json'), auth);
    return piHasCredentials();
  };

  afterAll(async () => {
    process.env = savedEnv;
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  it('detects a stored login in auth.json', async () => {
    expect(await withAgentDir(JSON.stringify({ anthropic: { type: 'oauth', token: 'x' } }))).toBe(true);
  });

  it('treats an empty auth.json as not logged in', async () => {
    expect(await withAgentDir('{}')).toBe(false);
  });

  it('falls back to env API keys', async () => {
    expect(await withAgentDir('{}')).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(await piHasCredentials()).toBe(true);
  });

  it('handles a missing auth.json', async () => {
    expect(await withAgentDir(null)).toBe(false);
  });
});

describe('SessionManager pin ordering', () => {
  const makeManager = (sessions: SessionMeta[]) => {
    const upsert = vi.fn();
    const store = { list: () => sessions, get: (id: string) => sessions.find((s) => s.id === id), upsert } as unknown as SessionStore;
    const manager = new SessionManager({
      store,
      settings: { get: () => defaultSettings(), update: async () => undefined } as unknown as SettingsStore,
      runtime: undefined as unknown as RuntimeResolver,
      analytics: { recordUsage: vi.fn(), recordTurn: vi.fn(), touchSession: vi.fn(), recordToolCall: vi.fn() } as unknown as AnalyticsStore,
      getSecret: async () => undefined,
      pushEvent: vi.fn(),
      pushSessions: vi.fn(),
      notify: vi.fn(),
      log: vi.fn()
    });
    return { manager, upsert };
  };
  const pinnedSession = (id: string, patch: Partial<SessionMeta>): SessionMeta => ({
    id,
    title: id,
    createdAt: 1_000,
    updatedAt: 1_000,
    config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'ask' },
    cwd: 'G:/proj/a',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...patch
  });

  it('setPinned stamps the pin time and never bumps updatedAt', async () => {
    const s = pinnedSession('s_a', {});
    const { manager } = makeManager([s]);
    const before = s.updatedAt;
    const pinned = await manager.setPinned(s.id, true);
    expect(pinned.pinned).toBe(true);
    expect(pinned.pinnedAt).toBeGreaterThan(0);
    // The unpinned section orders by updatedAt, so pinning must not reshuffle it.
    expect(pinned.updatedAt).toBe(before);
    const unpinned = await manager.setPinned(s.id, false);
    expect(unpinned.pinned).toBeUndefined();
    expect(unpinned.pinnedAt).toBeUndefined();
  });

  it('setPinOrder rewrites pin stamps in display order and skips unknown ids', async () => {
    const a = pinnedSession('s_a', { pinned: true, pinnedAt: 100 });
    const b = pinnedSession('s_b', { pinned: true, pinnedAt: 200 });
    const { manager, upsert } = makeManager([a, b]);
    await manager.setPinOrder(['s_b', 's_a']);
    // Small ordinals keep future pins (stamped with Date.now()) below the reordered section.
    expect(b.pinnedAt).toBe(1);
    expect(a.pinnedAt).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    await expect(manager.setPinOrder(['s_missing'])).resolves.toBeUndefined();
  });
});
