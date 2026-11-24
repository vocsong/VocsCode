import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubscriptionLimitGroup, SubscriptionLimits } from '../../shared/subscription-usage';
import type { RuntimeResolver } from '../runtime';
import { deferred, LineSplitter, type Deferred } from '../util/async';
import { shutdownChild, spawnTool } from './spawn';

const TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_GROUPS = 16;
const READ_FAILED = 'Could not read Codex account limits. Check your Codex installation and ChatGPT sign-in, then retry.';
const UNSUPPORTED = 'This Codex runtime does not support ChatGPT account limits. Update Codex or select a newer runtime.';
const SIGN_IN = 'Sign in to Codex with ChatGPT in Settings → Providers & keys → Harness logins, then retry. API keys do not provide subscription limits.';
const OTHER_ACCOUNT = 'This Codex account is not a ChatGPT login. ChatGPT sign-in is required for subscription limits.';

// Allow OS executable, profile, temporary-directory and OS keyring plumbing only. Auth tokens,
// identity files, proxy/endpoint overrides and arbitrary provider keys are not part of this probe.
const QUOTA_OS_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME',
  'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS'
]);

function quotaEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    // Preserve a selected Codex profile without forwarding any auth or config override variables.
    if (name === 'CODEX_HOME' && value?.trim()) env.CODEX_HOME = path.resolve(value);
    else if (QUOTA_OS_ENV.has(name)) env[key] = value;
  }
  env.CODEX_SQLITE_HOME = cwd;
  // v0.153.4 can restore remote-control enrollments even over stdio. Use the same disabled-start
  // marker as Codex's daemon, separate state storage, and a client ID used only by this probe.
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
  return env;
}

// Only errors constructed here may cross the IPC boundary; runtime errors can include tokens or config.
class QuotaError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function windowName(minutes: unknown, fallback: string): string {
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function parseBuckets(snapshot: unknown): SubscriptionLimitGroup['buckets'] {
  const buckets: SubscriptionLimitGroup['buckets'] = [];
  if (!isRecord(snapshot)) return buckets;
  for (const [key, fallback] of [['primary', 'Primary window'], ['secondary', 'Secondary window']] as const) {
    const window = snapshot[key];
    if (!isRecord(window)) continue;
    const { usedPercent, windowDurationMins, resetsAt } = window;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) continue;
    const duration = windowName(windowDurationMins, fallback);
    const name = buckets[0]?.name === duration ? `${duration} (secondary)` : duration;
    const bucket = { name, remainingFraction: Math.max(0, (100 - usedPercent) / 100) };
    // Unix seconds, limited to a positive timestamp with a four-digit year.
    buckets.push(typeof resetsAt === 'number' && Number.isSafeInteger(resetsAt) && resetsAt > 0 && resetsAt <= 253402300799
      ? { ...bucket, resetAt: new Date(resetsAt * 1000).toISOString() }
      : bucket);
  }
  return buckets;
}

/** Codex v2 GetAccountRateLimitsResponse (rust-v0.153.4). Only metered windows reach Usage. */
export function parseCodexQuota(result: unknown): SubscriptionLimits | undefined {
  if (!isRecord(result)) return undefined;
  const legacy = isRecord(result.rateLimits) ? result.rateLimits : undefined;
  const legacyId = typeof legacy?.limitId === 'string' && legacy.limitId ? legacy.limitId : 'codex';
  const snapshots = new Map(isRecord(result.rateLimitsByLimitId) ? Object.entries(result.rateLimitsByLimitId) : []);
  if (legacy && !snapshots.has(legacyId)) snapshots.set(legacyId, legacy);

  const groups: SubscriptionLimitGroup[] = [];
  const names = new Set<string>();
  // rateLimits mirrors the main entry (or the first additional entry when there is no main entry).
  for (const id of ['codex', ...[...snapshots.keys()].filter((id) => id !== 'codex').sort()]) {
    const snapshot = snapshots.get(id);
    let buckets = parseBuckets(snapshot);
    if (!buckets.length && id === legacyId) buckets = parseBuckets(legacy);
    if (!buckets.length) continue;
    const label = isRecord(snapshot) ? snapshot.limitName : undefined;
    // IDs are only for joining snapshots, not for display. Do not render arbitrary backend text.
    const base = id === 'codex' ? 'Codex'
      : typeof label === 'string' && label.length <= 64 && /^[\p{L}\p{N}]/u.test(label) && !/[^\p{L}\p{N}\p{M} .+()-]/u.test(label)
        ? label.normalize('NFC').trimEnd() : `Additional Codex limit ${groups.length + 1}`;
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base} (${i})`;
    names.add(name);
    groups.push({ name, buckets });
    if (groups.length === MAX_GROUPS) break;
  }
  return groups.length ? { groups } : undefined;
}

function requireChatGpt(result: unknown): void {
  if (!isRecord(result)) throw new QuotaError(READ_FAILED);
  const { account, requiresOpenaiAuth } = result;
  if (isRecord(account) && account.type === 'chatgpt') return;
  if (isRecord(account) && account.type === 'apiKey') {
    throw new QuotaError('This Codex account uses an API key. ChatGPT sign-in is required for subscription limits.');
  }
  if (account == null && requiresOpenaiAuth !== false && (account === null || requiresOpenaiAuth === true)) throw new QuotaError(SIGN_IN);
  if (requiresOpenaiAuth === false || (isRecord(account) && typeof account.type === 'string')) {
    throw new QuotaError(OTHER_ACCOUNT);
  }
  throw new QuotaError(READ_FAILED);
}

function rpcFailure(method: string, error: unknown): QuotaError {
  if (isRecord(error)) {
    // Older app-servers may report unknown methods as Serde invalid requests, not -32601.
    if (error.code === -32601 || (error.code === -32600 && typeof error.message === 'string'
      && error.message.startsWith('Invalid request: unknown variant') && error.message.includes(`\`${method}\``))) {
      return new QuotaError(UNSUPPORTED);
    }
    if (method === 'account/rateLimits/read' && error.code === -32600) {
      if (error.message === 'codex account authentication required to read rate limits') return new QuotaError(SIGN_IN);
      if (error.message === 'chatgpt authentication required to read rate limits') return new QuotaError(OTHER_ACCOUNT);
    }
  }
  return new QuotaError(READ_FAILED);
}

async function readAccountOverStdio(child: ChildProcess): Promise<SubscriptionLimits> {
  const { stdin, stdout } = child;
  if (!stdin || !stdout) throw new QuotaError(READ_FAILED);
  let nextId = 1;
  let pending: { id: number; method: string; reply: Deferred<unknown> } | undefined;
  let failure: QuotaError | undefined;
  const fail = (error = new QuotaError(READ_FAILED)) => {
    failure ??= error;
    pending?.reply.reject(failure);
    pending = undefined;
  };
  const splitter = new LineSplitter((line) => {
    if (failure) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { fail(); return; }
    if (!isRecord(message)) { fail(); return; }
    if (!pending || message.id !== pending.id || Object.hasOwn(message, 'method')) return;
    const { reply, method } = pending;
    pending = undefined;
    if (Object.hasOwn(message, 'error')) reply.reject(rpcFailure(method, message.error));
    else if (Object.hasOwn(message, 'result')) reply.resolve(message.result);
    else reply.reject(new QuotaError(READ_FAILED));
  });
  let bytes = 0;
  stdout.on('data', (chunk: Buffer) => {
    if (failure) return;
    bytes += chunk.length;
    if (bytes > MAX_STDOUT_BYTES) fail(new QuotaError('Codex returned too much account data.'));
    else splitter.push(chunk);
  });
  stdout.on('error', () => fail());
  stdin.on('error', () => fail());
  child.once('error', () => fail());
  child.once('close', () => fail());

  // Reuse the harness line framing and process shutdown, but the generic RPC client always adds
  // params: {}. The v2 typed rate-limit request has no params, and this probe only accepts replies.
  const request = (method: string, params?: object): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const reply = deferred<unknown>();
    pending = { id, method, reply };
    try { stdin.write(JSON.stringify({ id, method, params }) + '\n'); } catch { fail(); }
    return reply.promise;
  };
  const deadline = setTimeout(() => fail(new QuotaError('Reading Codex account limits timed out. Try again.')), TIMEOUT_MS);
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'vocs-code-quota', title: 'Vocs Code Usage', version: '0.1.0' } });
    if (failure) throw failure;
    if (!isRecord(initialized)) throw new QuotaError(READ_FAILED);
    stdin.write('{"method":"initialized"}\n');
    requireChatGpt(await request('account/read', { refreshToken: false }));
    const quota = parseCodexQuota(await request('account/rateLimits/read'));
    if (failure) throw failure;
    if (!quota) throw new QuotaError('Codex did not return any ChatGPT rate-limit windows for this account.');
    return quota;
  } finally {
    clearTimeout(deadline);
    fail();
  }
}

/** Both Codex harnesses share the CLI login. Per-turn API keys may override it for actual sessions. */
export async function readCodexSubscriptionQuota(runtime: RuntimeResolver): Promise<SubscriptionLimits> {
  let child: ChildProcess | undefined;
  let cwd: string | undefined;
  try {
    const bin = runtime.resolve('codex');
    if (!bin) throw new QuotaError('Codex CLI not found. Install Codex or select a runtime in Settings → Harnesses.');
    const runtimeDir = runtime.runtimePaths.appRuntimeDir;
    await fs.mkdir(runtimeDir, { recursive: true });
    cwd = await fs.mkdtemp(path.join(runtimeDir, 'codex-quota-'));
    const executable = path.basename(bin.path) === bin.path ? bin.path : path.resolve(bin.path);
    // An empty app-owned cwd plus no ancestor discovery keeps projects out. Use the account's
    // OpenAI provider view, not whichever model provider is configured for turns. The v2 rate
    // limits handler uses chatgpt_base_url with the stored credential, so pin the production URL.
    // Disable plugins when policy permits; keep Codex home and its configured auth store.
    child = spawnTool(executable, [
      '--config', 'project_root_markers=[]', '--config', 'model_provider="openai"',
      '--config', 'chatgpt_base_url="https://chatgpt.com/backend-api"',
      '--config', 'features.plugins=false', 'app-server', '--listen', 'stdio://',
    ], { cwd, env: quotaEnvironment(cwd), stdio: ['pipe', 'pipe', 'ignore'] });
    return await readAccountOverStdio(child);
  } catch (error) {
    throw error instanceof QuotaError ? error : new QuotaError(READ_FAILED);
  } finally {
    if (child) {
      await shutdownChild(child).catch(() => undefined);
      // On POSIX shutdownChild sends SIGTERM. Do not leave a wedged probe alive if it ignores it.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* process may have exited */ }
      }
      child.stdout?.destroy();
    }
    if (cwd) await fs.rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
