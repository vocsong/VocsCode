import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { parseCodexQuota, readCodexSubscriptionQuota } from '../src/main/harness/codex-quota';
import { spawnTool } from '../src/main/harness/spawn';
import type { RuntimeResolver } from '../src/main/runtime';
import { deferred } from '../src/main/util/async';

vi.mock('../src/main/harness/spawn', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/harness/spawn')>(),
  spawnTool: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(spawnTool).mockReset();
});

// v2 app-server fixture: limitId joins the backward-compatible snapshot and the metered buckets.
const chatgpt = { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' }, requiresOpenaiAuth: true };
const codex = {
  limitId: 'codex',
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 },
  secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: null },
  credits: { hasCredits: true, balance: '57.80' },
};
const modernLimits = {
  rateLimits: codex,
  rateLimitsByLimitId: {
    codex,
    'codex_bengalfox': {
      limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: null,
    },
  },
  accountId: 'fixture-account-id',
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'fixture-credit-id' }] },
};
const expected = {
  groups: [
    { name: 'Codex', buckets: [
      { name: '5-hour window', remainingFraction: 0.75, resetAt: '2024-11-07T02:40:00.000Z' },
      { name: '7-day window', remainingFraction: 0.2 },
    ] },
    { name: 'GPT-5.3-Codex-Spark', buckets: [{ name: '5-hour window', remainingFraction: 0 }] },
  ],
};

describe('Codex v2 quota projection', () => {
  it('returns the main and additional metered windows once, without balances or account identifiers', () => {
    expect(parseCodexQuota({ ...modernLimits, rateLimits: { ...codex, primary: { usedPercent: 0 } } })).toEqual(expected);
  });

  it('uses the legacy snapshot, skips malformed windows, and omits unusable reset times', () => {
    expect(parseCodexQuota({ rateLimits: {
      primary: { usedPercent: '25' },
      secondary: { usedPercent: 120, windowDurationMins: -1, resetsAt: 1730947200000 },
    }, rateLimitsByLimitId: null })).toEqual({ groups: [{ name: 'Codex', buckets: [{ name: 'Secondary window', remainingFraction: 0 }] }] });
    for (const usedPercent of [-1, NaN, Infinity, null, false]) {
      expect(parseCodexQuota({ rateLimits: { primary: { usedPercent }, credits: { balance: '42' } } })).toBeUndefined();
    }
  });

  it('does not relabel a mirrored additional snapshot as the main Codex quota', () => {
    const limitId = 'private-meter-id';
    const extra = { limitId, limitName: 'fixture@example.test\n', primary: { usedPercent: 0 } };
    expect(parseCodexQuota({ rateLimits: extra, rateLimitsByLimitId: { [limitId]: extra } })).toEqual({
      groups: [{ name: 'Additional Codex limit 1', buckets: [{ name: 'Primary window', remainingFraction: 1 }] }],
    });
  });

  it('bounds additional data and rejects control characters and overlong labels', () => {
    const entry = { primary: { usedPercent: 50 } };
    const entries = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`meter-${String(i).padStart(2, '0')}`, {
      ...entry, limitName: i === 0 ? 'Bad\r' : 'x'.repeat(65),
    }]));
    const quota = parseCodexQuota({ rateLimits: entry, rateLimitsByLimitId: entries });
    expect(quota?.groups).toHaveLength(16);
    expect(quota?.groups.slice(1).map(({ name }) => name)).toEqual(Array.from({ length: 15 }, (_, i) => `Additional Codex limit ${i + 2}`));
  });

  it('keeps equal-duration windows and repeated group labels distinguishable', () => {
    const window = { usedPercent: 50, windowDurationMins: 300 };
    const extra = { limitName: 'Codex', primary: window, secondary: window };
    const quota = parseCodexQuota({ ...modernLimits, rateLimitsByLimitId: { codex, extraA: extra, extraB: extra } });
    expect(quota?.groups.map(({ name }) => name)).toEqual(['Codex', 'Codex (2)', 'Codex (3)']);
    expect(quota?.groups[1].buckets.map(({ name }) => name)).toEqual(['5-hour window', '5-hour window (secondary)']);
  });
});

async function probeRuntime(available = true) {
  const appRuntimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-codex-quota-test-'));
  onTestFinished(() => fs.rm(appRuntimeDir, { recursive: true, force: true }));
  const resolve = vi.fn(() => available ? { path: path.join(appRuntimeDir, 'fixture-codex'), source: 'settings' as const } : null);
  return { runtime: { resolve, runtimePaths: { appRuntimeDir } } as unknown as RuntimeResolver, resolve, appRuntimeDir };
}

type Request = { id?: number; method: string; params?: unknown };
type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

function wireFixture(options: {
  account?: Reply;
  limits?: Reply;
  respondToLimits?: (stdout: PassThrough) => void;
} = {}) {
  const requests: Request[] = [];
  const reachedLimits = deferred<void>();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, exitCode: null as number | null, signalCode: null });
  const reply = (id: number | undefined, payload: Reply) => {
    const line = Buffer.from(JSON.stringify({ id, ...payload }) + '\r\n');
    const nonAscii = line.findIndex((byte) => byte >= 0x80);
    const split = nonAscii < 0 ? 11 : nonAscii + 1;
    stdout.write(line.subarray(0, split));
    stdout.write(line.subarray(split));
  };
  const closed = vi.fn(() => {
    child.exitCode = 0;
    stdout.end();
    child.emit('exit', 0);
    child.emit('close', 0);
  });
  stdin.once('finish', closed);
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString('utf8')) as Request;
    requests.push(request);
    if (request.method === 'initialize') reply(request.id, { result: { userAgent: 'fixture' } });
    if (request.method === 'account/read') reply(request.id, options.account ?? { result: chatgpt });
    if (request.method === 'account/rateLimits/read') {
      reachedLimits.resolve();
      // An unsolicited notification is not the response to a read.
      stdout.write('{"method":"account/rateLimits/updated","params":{}}\n');
      if (options.respondToLimits) options.respondToLimits(stdout);
      else reply(request.id, options.limits ?? { result: modernLimits });
    }
  });
  vi.mocked(spawnTool).mockReturnValueOnce(child as unknown as ChildProcess);
  return { requests, closed, reachedLimits: reachedLimits.promise, child };
}

describe('readCodexSubscriptionQuota', () => {
  it('uses one account-only stdio handshake, an empty app-owned cwd, and the saved login without provider keys', async () => {
    const ambient = {
      OpenAI_API_Key: 'fixture-ambient-openai',
      CODEX_API_KEY: 'fixture-ambient-codex',
      Codex_Access_Token: 'fixture-not-a-real-token',
      OPENAI_IDENTITY_TOKEN_FILE: './fixture-not-an-identity',
      CODEX_AUTHAPI_BASE_URL: 'https://fixture.invalid/auth',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://fixture.invalid/refresh',
      CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL: 'https://fixture.invalid/agent',
      CODEX_SQLITE_HOME: './fixture-shared-state'
    };
    for (const [key, value] of Object.entries(ambient)) vi.stubEnv(key, value);
    vi.stubEnv('CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED', '0');
    vi.stubEnv('CODEX_HOME', './fixture-codex-profile');
    const { runtime, resolve, appRuntimeDir } = await probeRuntime();
    const fixture = wireFixture();
    expect(await readCodexSubscriptionQuota(runtime)).toEqual(expected);
    expect(resolve).toHaveBeenCalledExactlyOnceWith('codex');
    expect(spawnTool).toHaveBeenCalledTimes(1);
    const [binary, args, options] = vi.mocked(spawnTool).mock.calls[0];
    expect(binary).toBe(path.join(appRuntimeDir, 'fixture-codex'));
    expect(args).toEqual([
      '--config', 'project_root_markers=[]', '--config', 'model_provider="openai"',
      '--config', 'chatgpt_base_url="https://chatgpt.com/backend-api"',
      '--config', 'features.plugins=false', 'app-server', '--listen', 'stdio://',
    ]);
    expect(options?.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(path.dirname(String(options?.cwd))).toBe(appRuntimeDir);
    const env = Object.fromEntries(Object.entries(options?.env ?? {}).map(([key, value]) => [key.toUpperCase(), value]));
    expect(env.CODEX_HOME).toBe(path.resolve('./fixture-codex-profile'));
    expect(env.CODEX_SQLITE_HOME).toBe(options?.cwd);
    expect(env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED).toBe('1');
    for (const [key, value] of Object.entries(ambient)) expect(env[key.toUpperCase()]).not.toBe(value);
    expect(fixture.requests).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'vocs-code-quota', title: 'Vocs Code Usage', version: '0.1.0' } } },
      { method: 'initialized' },
      { id: 2, method: 'account/read', params: { refreshToken: false } },
      { id: 3, method: 'account/rateLimits/read' },
    ]);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(appRuntimeDir)).toEqual([]);
  });

  it('decodes a model label split in the middle of a UTF-8 byte sequence', async () => {
    const { runtime } = await probeRuntime();
    wireFixture({ limits: { result: { rateLimits: { limitId: 'extra', limitName: 'Équipe Spark', primary: { usedPercent: 0 } } } } });
    expect(await readCodexSubscriptionQuota(runtime)).toEqual({
      groups: [{ name: 'Équipe Spark', buckets: [{ name: 'Primary window', remainingFraction: 1 }] }],
    });
  });

  it.each([
    [{ account: null, requiresOpenaiAuth: true }, /Sign in to Codex with ChatGPT/],
    [{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }, /uses an API key/],
    [{ account: { type: 'amazonBedrock' }, requiresOpenaiAuth: false }, /not a ChatGPT login/],
  ])('does not request quota for an ineligible account (%j)', async (account, error) => {
    const { runtime } = await probeRuntime();
    const fixture = wireFixture({ account: { result: account } });
    await expect(readCodexSubscriptionQuota(runtime)).rejects.toThrow(error);
    expect(fixture.requests.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'account/read']);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a missing runtime and does not launch another CLI', async () => {
    const { runtime } = await probeRuntime(false);
    await expect(readCodexSubscriptionQuota(runtime)).rejects.toThrow(/Codex CLI not found/);
    expect(spawnTool).not.toHaveBeenCalled();
  });

  it.each([
    { account: { error: { code: -32600, message: 'Invalid request: unknown variant `account/read`, expected one of …' } } },
    { limits: { error: { code: -32601, message: 'fixture-raw-unsupported-error' } } },
  ])('reports unsupported RPC versions and closes the probe', async (options) => {
    const { runtime } = await probeRuntime();
    const fixture = wireFixture(options);
    await expect(readCodexSubscriptionQuota(runtime)).rejects.toThrow('This Codex runtime does not support ChatGPT account limits. Update Codex or select a newer runtime.');
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it('does not expose raw RPC errors or backend details', async () => {
    const { runtime } = await probeRuntime();
    const fixture = wireFixture({ limits: { error: { code: -32603, message: 'fixture-secret-token', data: modernLimits } } });
    await expect(readCodexSubscriptionQuota(runtime)).rejects.toHaveProperty(
      'message', 'Could not read Codex account limits. Check your Codex installation and ChatGPT sign-in, then retry.',
    );
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null\n', /Could not read Codex account limits/],
    ['x'.repeat(1024 * 1024 + 1), /too much account data/],
  ])('fails closed on unusable stdout and tears down the child (%#)', async (output, error) => {
    const { runtime } = await probeRuntime();
    const fixture = wireFixture({ respondToLimits: (stdout) => { stdout.write(output); } });
    await expect(readCodexSubscriptionQuota(runtime)).rejects.toThrow(error);
    expect(fixture.closed).toHaveBeenCalledTimes(1);
  });

  it('times out the entire probe and cleans up a stalled app-server', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { runtime, appRuntimeDir } = await probeRuntime();
    const fixture = wireFixture({ respondToLimits: () => undefined });
    const result = expect(readCodexSubscriptionQuota(runtime)).rejects.toThrow(/timed out/);
    await fixture.reachedLimits;
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fixture.closed).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(appRuntimeDir)).toEqual([]);
  });
});
