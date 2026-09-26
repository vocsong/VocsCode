import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AppSettings, HarnessAvailability, HarnessBinarySource, HarnessId, HarnessUpdate } from '../shared/types';
import { killTree, spawnTool } from './harness/spawn';
import { exists } from './util/fs';

/**
 * Discovers external harness binaries (claude, codex, pi, dsh, npx) on PATH, in the
 * app's private runtime dir, or bundled in node_modules (claude, codex).
 * Node-only so it can be unit-tested outside Electron.
 */

const isWin = process.platform === 'win32';

export interface RuntimePaths {
  /** Directory where the app installs harnesses on demand (npm --prefix). */
  appRuntimeDir: string;
  /** Project root in dev, resources path when packaged; used to locate bundled files. */
  resourcesDir: string;
  /** Root that contains node_modules with bundled SDK binaries. */
  appRoot: string;
}

export type ToolName = 'claude' | 'codex' | 'pi' | 'dsh' | 'npx' | 'gemini';

/**
 * Resolved PATH scans are memoized per command: one boot performs dozens of lookups (every git/gh
 * call plus one per harness probe) and each miss walks every PATH dir × every PATHEXT extension.
 * On Windows that is hundreds of synchronous stats per scan, which is seconds of frozen main
 * thread on a cold start. `clearWhichCache` drops the memo once a tool is installed mid-session.
 */
const whichCache = new Map<string, string | null>();

export function clearWhichCache(): void {
  whichCache.clear();
}

export function which(cmd: string, extraDirs: string[] = []): string | null {
  const key = extraDirs.length ? `${cmd}\u0000${extraDirs.join('\u0000')}` : cmd;
  if (whichCache.has(key)) return whichCache.get(key) as string | null;
  const resolved = whichScan(cmd, extraDirs);
  whichCache.set(key, resolved);
  return resolved;
}

function whichScan(cmd: string, extraDirs: string[] = []): string | null {
  if (path.isAbsolute(cmd)) {
    try {
      if (statSync(cmd).isFile()) return cmd;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env.PATH ?? '';
  const dirs = [...extraDirs, ...pathEnv.split(path.delimiter).filter(Boolean)];
  // On Windows an extension-less file (e.g. an npm sh shim) is not executable; only try PATHEXT variants
  // unless the command already carries an extension.
  const hasExt = /\.[a-z0-9]{1,4}$/i.test(cmd);
  const exts = isWin
    ? hasExt
      ? ['']
      : (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;

/**
 * Version/login probes memoized per (binary, args) for a short window: one boot refresh probes the
 * same binary for several harness ids ('codex' and 'codex-exec' share `codex --version` + `login
 * status`), and every probe is a subprocess that costs hundreds of ms under real-time antivirus.
 */
const probeCache = new Map<string, { at: number; result: CaptureResult }>();
const probePending = new Map<string, Promise<CaptureResult>>();
const PROBE_TTL_MS = 60_000;

async function probeOnce(cmd: string, args: string[], timeoutMs: number): Promise<CaptureResult> {
  const key = `${cmd}\u0000${args.join('\u0000')}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result;
  // Concurrent callers share one probe; 'codex' and 'codex-exec' refresh together at boot.
  let pending = probePending.get(key);
  if (!pending) {
    pending = runCapture(cmd, args, { timeoutMs })
      .then((result) => {
        probeCache.set(key, { at: Date.now(), result });
        probePending.delete(key);
        return result;
      });
    probePending.set(key, pending);
  }
  return pending;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout or stderr reached MAX_CAPTURE_BYTES. */
  truncated?: boolean;
  /** True when the child was killed by the capture timeout. */
  timedOut?: boolean;
}

export function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const stdout = { chunks: [] as Buffer[], bytes: 0, truncated: false };
    const stderr = { chunks: [] as Buffer[], bytes: 0, truncated: false };
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const append = (target: typeof stdout, data: unknown): void => {
      if (target.bytes >= MAX_CAPTURE_BYTES) {
        target.truncated = true;
        return;
      }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const remaining = MAX_CAPTURE_BYTES - target.bytes;
      if (chunk.byteLength > remaining) {
        target.chunks.push(chunk.subarray(0, remaining));
        target.bytes = MAX_CAPTURE_BYTES;
        target.truncated = true;
      } else {
        target.chunks.push(chunk);
        target.bytes += chunk.byteLength;
      }
    };
    const text = (target: typeof stdout): string => Buffer.concat(target.chunks, target.bytes).toString('utf8');
    const result = (code: number | null, extraStderr?: string, timedOut = false): CaptureResult => {
      if (extraStderr) append(stderr, extraStderr);
      const out: CaptureResult = { code, stdout: text(stdout), stderr: text(stderr) };
      if (stdout.truncated || stderr.truncated) out.truncated = true;
      if (timedOut) out.timedOut = true;
      return out;
    };
    const settle = (code: number | null, extraStderr?: string, timedOut = false): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result(code, extraStderr, timedOut));
    };
    let child;
    try {
      child = spawnTool(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    } catch (e) {
      settle(null, String(e));
      return;
    }
    if (!child.stdout || !child.stderr || !child.stdin) {
      settle(null, 'no stdio');
      return;
    }
    timeout = setTimeout(() => {
      try {
        killTree(child);
      } catch {
        /* ignore */
      }
      // Grandchildren can inherit the pipes and keep stdio open (cmd.exe-wrapped shims on
      // Windows); settle anyway so callers never hang on a killed child.
      // Mark partial output as untrustworthy rather than a completed run.
      settle(null, `\ntimed out after ${opts.timeoutMs ?? 15_000}ms`, true);
    }, opts.timeoutMs ?? 15_000);
    child.stdout.on('data', (d) => append(stdout, d));
    child.stderr.on('data', (d) => append(stderr, d));
    child.on('error', (e) => settle(null, String(e)));
    child.on('close', (code) => settle(code));
    // A dead pipe must not surface as an uncaught exception.
    child.stdin.on('error', () => undefined);
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function nodeModulesDirs(appRoot: string): string[] {
  // Development: <root>/node_modules. Packaged: appRoot is <resources>/app.asar and unpacked
  // native binaries live in <resources>/app.asar.unpacked/node_modules.
  const dirs = [path.join(appRoot, 'node_modules')];
  if (/app\.asar$/i.test(appRoot)) dirs.push(path.join(appRoot.replace(/app\.asar$/i, 'app.asar.unpacked'), 'node_modules'));
  dirs.push(path.join(path.dirname(appRoot), 'app.asar.unpacked', 'node_modules'));
  return dirs;
}

/** Bundled Claude Code runtime shipped by the Agent SDK platform package. */
export function bundledClaudePath(appRoot: string): string | null {
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const nm of nodeModulesDirs(appRoot)) {
    const p = path.join(nm, pkg, isWin ? 'claude.exe' : 'claude');
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* try next */
    }
  }
  try {
    const req = createRequire(path.join(appRoot, 'package.json'));
    const pkgJson = req.resolve(`${pkg}/package.json`);
    const p = path.join(path.dirname(pkgJson), isWin ? 'claude.exe' : 'claude');
    if (statSync(p).isFile()) return p;
  } catch {
    /* not installed */
  }
  return null;
}

/** Bundled Codex binary from @openai/codex-<platform>. */
export function bundledCodexPath(appRoot: string): string | null {
  const triple = codexTargetTriple();
  if (!triple) return null;
  const pkg = `@openai/codex-${process.platform}-${process.arch}`;
  for (const nm of nodeModulesDirs(appRoot)) {
    const p = path.join(nm, pkg, 'vendor', triple, 'bin', isWin ? 'codex.exe' : 'codex');
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

function codexTargetTriple(): string | null {
  const { platform, arch } = process;
  if (platform === 'linux') return arch === 'x64' ? 'x86_64-unknown-linux-musl' : arch === 'arm64' ? 'aarch64-unknown-linux-musl' : null;
  if (platform === 'darwin') return arch === 'x64' ? 'x86_64-apple-darwin' : arch === 'arm64' ? 'aarch64-apple-darwin' : null;
  if (platform === 'win32') return arch === 'x64' ? 'x86_64-pc-windows-msvc' : arch === 'arm64' ? 'aarch64-pc-windows-msvc' : null;
  return null;
}

export interface ResolvedBinary {
  path: string;
  source: HarnessBinarySource;
}

/** The npm packages the app installs and updates harness CLIs from: one table for install and check. */
export const HARNESS_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  pi: '@earendil-works/pi-coding-agent',
  dsh: '@deepseek-ai/dsh'
} as const;

export type InstallableHarness = keyof typeof HARNESS_PACKAGES;

/**
 * Harness ids the update check covers and the npm package each is compared against. Both Codex
 * harnesses run the same CLI, so they share one lookup; `acp` runs dsh.
 */
export const HARNESS_UPDATE_PACKAGES: Partial<Record<HarnessId, InstallableHarness>> = {
  claude: 'claude',
  codex: 'codex',
  'codex-exec': 'codex',
  pi: 'pi',
  acp: 'dsh'
};

export class RuntimeResolver {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly getSettings: () => AppSettings
  ) {}

  get runtimePaths(): RuntimePaths {
    return this.paths;
  }

  private appRuntimeBin(): string[] {
    const base = this.paths.appRuntimeDir;
    return isWin ? [base] : [path.join(base, 'bin')];
  }

  resolve(tool: ToolName): ResolvedBinary | null {
    const s = this.getSettings();
    const explicit = (s.binaries as Record<string, string | undefined>)[tool];
    if (explicit && explicit.trim()) return { path: explicit.trim(), source: 'settings' };

    const preferBundled =
      (tool === 'claude' && s.claude.runtime === 'bundled') || (tool === 'codex' && s.codex.runtime === 'bundled');
    const systemOnly =
      (tool === 'claude' && s.claude.runtime === 'system') || (tool === 'codex' && s.codex.runtime === 'system');

    const bundled =
      tool === 'claude' ? bundledClaudePath(this.paths.appRoot) : tool === 'codex' ? bundledCodexPath(this.paths.appRoot) : null;
    if (preferBundled && bundled) return { path: bundled, source: 'bundled' };

    const sys = which(tool, this.appRuntimeBin());
    // The Claude Agent SDK spawns the executable directly; an npm .cmd shim cannot be spawned
    // without a shell on Windows, so prefer the bundled native binary in that case. Both read
    // the same ~/.claude credentials.
    if (tool === 'claude' && sys && /\.(cmd|bat)$/i.test(sys) && bundled && !systemOnly) return { path: bundled, source: 'bundled' };
    if (sys) return { path: sys, source: sys.startsWith(this.paths.appRuntimeDir) ? 'app-runtime' : 'system' };
    if (!systemOnly && bundled) return { path: bundled, source: 'bundled' };
    return null;
  }

  /** Path to a bundled resource (e.g. the pi approvals extension). */
  resource(...segments: string[]): string {
    return path.join(this.paths.resourcesDir, ...segments);
  }

  async availability(id: HarnessId): Promise<HarnessAvailability> {
    switch (id) {
      case 'claude': {
        const bin = this.resolve('claude');
        if (!bin) return { available: false, detail: 'No Claude Code runtime found.', installHint: 'npm install -g @anthropic-ai/claude-code' };
        const v = await probeOnce(bin.path, ['--version'], 20_000);
        const authenticated = await claudeHasCredentials();
        return {
          available: v.code === 0,
          version: v.stdout.trim() || undefined,
          binaryPath: bin.path,
          source: bin.source,
          detail: `${bin.source} runtime`,
          authenticated: authenticated ? true : 'unknown'
        };
      }
      case 'codex':
      case 'codex-exec': {
        const bin = this.resolve('codex');
        if (!bin) return { available: false, detail: 'Codex CLI not found.', installHint: 'npm install -g @openai/codex' };
        const v = await probeOnce(bin.path, ['--version'], 20_000);
        const login = await probeOnce(bin.path, ['login', 'status'], 20_000);
        const text = login.stdout + login.stderr;
        const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
        return {
          available: v.code === 0,
          version: v.stdout.trim() || undefined,
          binaryPath: bin.path,
          source: bin.source,
          detail: text.trim().split('\n')[0] || `${bin.source} runtime`,
          authenticated: loggedIn
        };
      }
      case 'pi': {
        const bin = this.resolve('pi');
        if (!bin) return { available: false, detail: 'pi not found on PATH.', installHint: 'npm install -g @earendil-works/pi-coding-agent' };
        const v = await probeOnce(bin.path, ['--version'], 20_000);
        const authenticated = await piHasCredentials();
        return { available: v.code === 0, version: v.stdout.trim() || undefined, binaryPath: bin.path, source: bin.source, authenticated };
      }
      case 'acp': {
        const dsh = this.resolve('dsh');
        const npx = this.resolve('npx');
        if (dsh) {
          const v = await probeOnce(dsh.path, ['--version'], 30_000);
          return {
            available: true,
            version: v.stdout.trim() || undefined,
            binaryPath: dsh.path,
            source: dsh.source,
            detail: 'DeepSeek Harness found',
            authenticated: 'unknown'
          };
        }
        if (npx)
          return {
            available: true,
            binaryPath: npx.path,
            source: npx.source,
            detail: 'ACP agents can be launched through npx (dsh is not installed globally).',
            authenticated: 'unknown',
            installHint: 'npm install -g @deepseek-ai/dsh'
          };
        return { available: false, detail: 'Neither dsh nor npx found.', installHint: 'npm install -g @deepseek-ai/dsh' };
      }
      case 'cursor': {
        // The SDK ships with the app; only credentials are user-supplied. Cursor reads them from
        // CURSOR_API_KEY or ~/.cursor/sdk/auth.json (Cursor.auth.login()), same as our key store.
        const key = process.env.CURSOR_API_KEY;
        const authed = key ? true : await cursorHasStoredLogin();
        return {
          available: true,
          detail: 'Bundled @cursor/sdk (local runtime)',
          authenticated: authed,
          installHint: authed ? undefined : 'Add a Cursor API key under Settings → Providers, or sign in once with Cursor.auth.login().'
        };
      }
      case 'native':
        return { available: true, detail: 'Built in. Add an API key under Settings → Providers.', authenticated: 'unknown' };
    }
  }

  /** Installs a harness CLI into the app runtime dir with npm. */
  async install(id: InstallableHarness): Promise<{ ok: boolean; log: string }> {
    const pkg = HARNESS_PACKAGES[id];
    await fs.mkdir(this.paths.appRuntimeDir, { recursive: true });
    const npm = which('npm');
    if (!npm) return { ok: false, log: 'npm not found on PATH.' };
    const r = await runCapture(npm, ['install', '-g', '--prefix', this.paths.appRuntimeDir, `${pkg}@latest`], {
      timeoutMs: 600_000
    });
    // The install put a new binary in the runtime dir; drop the memoized misses so it is found,
    // and the version probes so the next read reports what was just installed rather than the TTL.
    if (r.code === 0) {
      clearWhichCache();
      probeCache.clear();
    }
    return { ok: r.code === 0, log: r.stdout + r.stderr };
  }

  /**
   * Installed-vs-published versions for the harness CLIs the app installs from npm. Probes
   * availability the way the Settings card does, then makes one registry lookup per package.
   */
  async checkUpdates(ids: HarnessId[], deps: { fetchImpl?: FetchLike } = {}): Promise<Partial<Record<HarnessId, HarnessUpdate>>> {
    const installed: Partial<Record<HarnessId, HarnessAvailability>> = {};
    // Only ids with a package behind them are probed: anything else has nothing to compare against.
    const wanted = ids.filter((id) => HARNESS_UPDATE_PACKAGES[id] !== undefined);
    await Promise.all(wanted.map(async (id) => (installed[id] = await this.availability(id))));
    return checkHarnessUpdates(installed, deps);
  }
}

/** npm registry lookups are small but can hang; this caps the wait when the network is slow. */
const REGISTRY_TIMEOUT_MS = 8_000;
/**
 * How long a published version stays fresh. A check can be run as often as the user clicks, and the
 * registry asks not to be polled: one lookup per package per window.
 */
const LATEST_TTL_MS = 10 * 60_000;

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const latestVersionCache = new Map<string, { at: number; result: { version?: string; error?: string } }>();
/** In-flight lookups, so harness ids that share a package cost one request rather than two. */
const latestVersionPending = new Map<string, Promise<{ version?: string; error?: string }>>();

/** Test seam: the registry cache lives as long as the module, so stubbed cases need a clean slate. */
export function clearLatestVersionCache(): void {
  latestVersionCache.clear();
  latestVersionPending.clear();
}

/**
 * The first semver-looking token of a CLI's version line: '2.1.280 (Claude Code)' and
 * 'codex-cli 0.154.0' both name a version, and the rest of the line is not ours to interpret.
 */
export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(text)?.[1] ?? null;
}

function splitVersion(version: string): { segments: number[]; prerelease: string } {
  const withoutBuild = version.trim().replace(/^[v=\s]+/, '').split('+')[0];
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  return { segments: core.split('.').map((s) => Number.parseInt(s, 10) || 0), prerelease: dash === -1 ? '' : withoutBuild.slice(dash + 1) };
}

/** Numeric-segment compare; a prerelease sorts below the release it precedes. Negative means a < b. */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  for (let i = 0; i < Math.max(left.segments.length, right.segments.length); i++) {
    const delta = (left.segments[i] ?? 0) - (right.segments[i] ?? 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Newest version an npm package publishes, from the registry's `/latest` manifest. Cached for
 * LATEST_TTL_MS including failures, so a second click after an offline check does not go out again.
 */
export async function fetchLatestVersion(
  pkg: string,
  deps: { fetchImpl?: FetchLike } = {}
): Promise<{ version?: string; error?: string }> {
  const cached = latestVersionCache.get(pkg);
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.result;
  // Codex and codex-exec are two ids over one CLI: whoever asks first makes the request.
  let pending = latestVersionPending.get(pkg);
  if (!pending) {
    pending = lookupLatestVersion(pkg, deps).then((result) => {
      latestVersionCache.set(pkg, { at: Date.now(), result });
      latestVersionPending.delete(pkg);
      return result;
    });
    latestVersionPending.set(pkg, pending);
  }
  return pending;
}

async function lookupLatestVersion(pkg: string, deps: { fetchImpl?: FetchLike }): Promise<{ version?: string; error?: string }> {
  // The scoped name's slash must be escaped; the registry route is otherwise a plain path.
  const url = `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`;
  const doFetch = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) return { error: `the npm registry answered ${res.status}` };
    const body = (await res.json()) as { version?: unknown };
    return typeof body?.version === 'string' && body.version.trim() ? { version: body.version.trim() } : { error: `${pkg} publishes no version` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Whether a binary in the app runtime dir is what this harness runs. An explicit `binaries.<tool>`
 * path and a runtime the app bundles both take precedence over that dir, so an install there would
 * be shadowed: the card explains why instead of offering a button that could not change anything.
 */
function appRuntimeWins(av: HarnessAvailability): boolean {
  return av.source === 'system' || av.source === 'app-runtime';
}

/**
 * Compares each installed harness CLI against the newest version its npm package publishes. Ids the
 * app has no package for (native, cursor) and harnesses that reported no version are skipped.
 */
export async function checkHarnessUpdates(
  installed: Partial<Record<HarnessId, HarnessAvailability>>,
  deps: { fetchImpl?: FetchLike } = {}
): Promise<Partial<Record<HarnessId, HarnessUpdate>>> {
  const out: Partial<Record<HarnessId, HarnessUpdate>> = {};
  await Promise.all(
    (Object.entries(installed) as [HarnessId, HarnessAvailability][]).map(async ([id, av]) => {
      const pkgKey = HARNESS_UPDATE_PACKAGES[id];
      const current = av?.version ? parseVersion(av.version) : null;
      if (!pkgKey || !av || !av.available || !current) return;
      const pkg = HARNESS_PACKAGES[pkgKey];
      const updatable = appRuntimeWins(av);
      const { version: latest, error } = await fetchLatestVersion(pkg, deps);
      if (!latest) {
        out[id] = { package: pkg, current, newer: false, updatable, error };
        return;
      }
      const newer = compareVersions(latest, current) > 0;
      out[id] = {
        package: pkg,
        current,
        latest,
        newer,
        updatable,
        reason: newer && !updatable ? (av.source === 'settings' ? 'its binary path is pinned under Settings → Harnesses' : 'it runs the runtime Vocs Code bundles, which moves with an app update') : undefined
      };
    })
  );
  return out;
}

/** Cursor SDK stores a browser login's minted API key in ~/.cursor/sdk/auth.json. */
export async function cursorHasStoredLogin(): Promise<boolean> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return exists(path.join(home, '.cursor', 'sdk', 'auth.json'));
}

export async function claudeHasCredentials(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  return exists(path.join(configDir, '.credentials.json'));
}

/** pi keeps provider logins in <agent dir>/auth.json; PI_CODING_AGENT_DIR overrides ~/.pi/agent. */
export async function piHasCredentials(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY) return true;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = envDir ? expandTilde(envDir, home) : path.join(home, '.pi', 'agent');
  try {
    const raw = await fs.readFile(path.join(agentDir, 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.values(parsed).some((v) => v != null && (typeof v !== 'object' || Object.keys(v as object).length > 0));
  } catch {
    return false;
  }
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}
