import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AppSettings, HarnessAvailability, HarnessId } from '../shared/types';
import { spawnTool } from './harness/spawn';
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

export function which(cmd: string, extraDirs: string[] = []): string | null {
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

export function runCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawnTool(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e) });
      return;
    }
    if (!child.stdout || !child.stderr || !child.stdin) {
      resolve({ code: null, stdout: '', stderr: 'no stdio' });
      return;
    }
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs ?? 15_000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: null, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
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
  source: 'settings' | 'system' | 'app-runtime' | 'bundled';
}

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
        const v = await runCapture(bin.path, ['--version'], { timeoutMs: 20_000 });
        const authenticated = await claudeHasCredentials();
        return {
          available: v.code === 0,
          version: v.stdout.trim() || undefined,
          binaryPath: bin.path,
          detail: `${bin.source} runtime`,
          authenticated: authenticated ? true : 'unknown'
        };
      }
      case 'codex':
      case 'codex-exec': {
        const bin = this.resolve('codex');
        if (!bin) return { available: false, detail: 'Codex CLI not found.', installHint: 'npm install -g @openai/codex' };
        const v = await runCapture(bin.path, ['--version'], { timeoutMs: 20_000 });
        const login = await runCapture(bin.path, ['login', 'status'], { timeoutMs: 20_000 });
        const text = login.stdout + login.stderr;
        const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
        return {
          available: v.code === 0,
          version: v.stdout.trim() || undefined,
          binaryPath: bin.path,
          detail: text.trim().split('\n')[0] || `${bin.source} runtime`,
          authenticated: loggedIn
        };
      }
      case 'pi': {
        const bin = this.resolve('pi');
        if (!bin) return { available: false, detail: 'pi not found on PATH.', installHint: 'npm install -g @earendil-works/pi-coding-agent' };
        const v = await runCapture(bin.path, ['--version'], { timeoutMs: 20_000 });
        return { available: v.code === 0, version: v.stdout.trim() || undefined, binaryPath: bin.path, authenticated: 'unknown' };
      }
      case 'acp': {
        const dsh = this.resolve('dsh');
        const npx = this.resolve('npx');
        if (dsh) {
          const v = await runCapture(dsh.path, ['--version'], { timeoutMs: 30_000 });
          return {
            available: true,
            version: v.stdout.trim() || undefined,
            binaryPath: dsh.path,
            detail: 'DeepSeek Harness found',
            authenticated: 'unknown'
          };
        }
        if (npx)
          return {
            available: true,
            binaryPath: npx.path,
            detail: 'ACP agents can be launched through npx (dsh is not installed globally).',
            authenticated: 'unknown',
            installHint: 'npm install -g @deepseek-ai/dsh'
          };
        return { available: false, detail: 'Neither dsh nor npx found.', installHint: 'npm install -g @deepseek-ai/dsh' };
      }
      case 'native':
        return { available: true, detail: 'Built in. Add an API key under Settings → Providers.', authenticated: 'unknown' };
    }
  }

  /** Installs a harness CLI into the app runtime dir with npm. */
  async install(id: 'pi' | 'dsh' | 'codex' | 'claude'): Promise<{ ok: boolean; log: string }> {
    const pkg = {
      pi: '@earendil-works/pi-coding-agent',
      dsh: '@deepseek-ai/dsh',
      codex: '@openai/codex',
      claude: '@anthropic-ai/claude-code'
    }[id];
    await fs.mkdir(this.paths.appRuntimeDir, { recursive: true });
    const npm = which('npm');
    if (!npm) return { ok: false, log: 'npm not found on PATH.' };
    const r = await runCapture(npm, ['install', '-g', '--prefix', this.paths.appRuntimeDir, `${pkg}@latest`], {
      timeoutMs: 600_000
    });
    return { ok: r.code === 0, log: r.stdout + r.stderr };
  }
}

export async function claudeHasCredentials(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
  return exists(path.join(configDir, '.credentials.json'));
}
