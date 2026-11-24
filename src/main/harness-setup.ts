/** Explicit, desktop-owned setup checks and interactive vendor launchers. No inference requests. */
import { spawn, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppSettings, HarnessAvailability, HarnessId } from '../shared/types';
import { HARNESSES } from '../shared/harness-meta';
import { ANTIGRAVITY_INSTALL_URL, ANTIGRAVITY_MIN_VERSION, INSTALL_HARNESS, LOGIN_HARNESS, type HarnessSetupStatus, type LoginHarnessId } from '../shared/harness-setup';
import { clearRuntimeProbeCache, parseVersion, compareVersions, runCapture, which, type RuntimeResolver } from './runtime';
import { antigravityAccountEnv, ANTIGRAVITY_AUTH_ENV_OVERRIDES } from './harness/antigravity';
import { withProcessOwner } from './process-context';

const SDKS: Partial<Record<HarnessId, string>> = {
  claude: '@anthropic-ai/claude-agent-sdk', 'codex-exec': '@openai/codex-sdk', cursor: '@cursor/sdk'
};

export function assertHarnessId(id: unknown): asserts id is HarnessId {
  if (!HARNESSES.some((h) => h.id === id)) throw new Error('Unknown harness');
}

/** A CLI probe cannot see API keys held in the app's vault; report configuration, not validity. */
export function withAppCredentials(harness: HarnessId, status: HarnessAvailability, settings: AppSettings): HarnessAvailability {
  const hasKey = (id: string) => settings.providers.some((p) => p.id === id && (p.hasApiKey || !!(p.envKey && process.env[p.envKey]?.trim())));
  if (harness === 'cursor' && hasKey('cursor')) return { ...status, authenticated: true, authMethod: 'api-key' };
  if ((harness === 'codex' || harness === 'codex-exec') && status.authenticated !== true && (hasKey('openai') || process.env.CODEX_API_KEY?.trim())) return { ...status, authenticated: true, authMethod: 'api-key', detail: 'OpenAI API credentials are configured for Codex. Key validity and model access have not been verified.' };
  if (harness === 'claude' && settings.claude.useProviderKey && hasKey('anthropic')) return { ...status, authenticated: true, authMethod: 'api-key', detail: 'The Anthropic API-key setting is enabled. API usage is billed separately from a Claude subscription.' };
  if (harness === 'pi' && status.authenticated !== true && ['anthropic', 'openai', 'deepseek', 'openrouter', 'opencode-go', 'gemini', 'groq', 'xai', 'mistral'].some(hasKey)) return { ...status, authenticated: true, authMethod: 'api-key', detail: 'An app API key is configured. Check the model catalog before starting.' };
  return { ...status };
}

/** These checks describe the selected runtime, not whichever CLI happens to be on a shell's PATH. */
export async function readHarnessSetup(runtime: RuntimeResolver, settings: AppSettings, harness: HarnessId): Promise<HarnessSetupStatus> {
  assertHarnessId(harness);
  clearRuntimeProbeCache();
  const availability = withAppCredentials(harness, await runtime.availability(harness), settings);
  const providers = settings.providers.map((p) => ({
    id: p.id,
    source: p.hasApiKey ? 'stored' as const : p.envKey && process.env[p.envKey]?.trim() ? 'environment' as const : ['ollama', 'lmstudio'].includes(p.kind) ? 'local' as const : 'none' as const
  }));
  if (harness === 'antigravity') {
    return {
      harness, availability, providers, canInstall: false, loginId: 'antigravity',
      requirements: [{
        id: 'runtime', name: 'Antigravity CLI', available: availability.available,
        detail: `Google’s Antigravity CLI ${ANTIGRAVITY_MIN_VERSION} or newer. Install it, then recheck setup.`, url: ANTIGRAVITY_INSTALL_URL
      }]
    };
  }
  const sdk = SDKS[harness];
  let sdkAvailable = true;
  if (sdk) {
    try { createRequire(path.join(runtime.runtimePaths.appRoot, 'package.json')).resolve(sdk); }
    catch { sdkAvailable = false; }
  }
  const node = which('node');
  const npm = which('npm');
  const git = which('git');
  const nodeProbe = node ? await runCapture(node, ['--version'], { timeoutMs: 5_000 }) : undefined;
  const version = nodeProbe?.code === 0 ? parseVersion(nodeProbe.stdout) : null;
  // Current Pi requires 22.19+, rather than simply any executable named node.
  const nodeReady = !!version && (harness !== 'pi' || compareVersions(version, '22.19.0') >= 0);
  if (!sdkAvailable) {
    availability.available = false;
    availability.detail = `The ${sdk} SDK shipped with Vocs Code is missing. Repair or reinstall Vocs Code; installing another CLI will not repair this SDK.`;
  }
  const installId = INSTALL_HARNESS[harness];
  const pinned = availability.source === 'settings' || !!settings.binaries[installId === 'dsh' ? 'dsh' : installId ?? 'pi']?.trim();
  const bundleSelected = (harness === 'claude' && settings.claude.runtime === 'bundled') || (['codex', 'codex-exec'].includes(harness) && settings.codex.runtime === 'bundled');
  const installReason = !sdkAvailable ? 'Repair Vocs Code to restore its SDK.' : !installId ? 'This agent is built into Vocs Code.' : bundleSelected && !availability.available ? 'The selected bundled runtime is missing or cannot start. Repair or reinstall Vocs Code, or choose another runtime explicitly in Settings → Harnesses.' : pinned || bundleSelected ? 'A runtime path is pinned in Settings → Harnesses. Change it before installing a replacement here.' : !nodeReady || !npm ? `Install ${harness === 'pi' ? 'Node.js 22.19 or newer' : 'Node.js (LTS)'} with npm, restart Vocs Code, then recheck. No Node.js install is needed to use an already-working bundled runtime.` : undefined;
  return {
    harness, availability, providers, installId,
    canInstall: !!installId && !installReason,
    installReason,
    loginId: LOGIN_HARNESS[harness],
    apiCredentialsMayOverrideLogin: ['codex', 'codex-exec'].includes(harness) && (providers.some((p) => p.id === 'openai' && (p.source === 'stored' || p.source === 'environment')) || !!process.env.CODEX_API_KEY?.trim()),
    requirements: [
      ...(sdk ? [{ id: 'sdk' as const, name: 'App SDK', available: sdkAvailable, detail: sdkAvailable ? `${sdk} is included with Vocs Code. You do not need to install the SDK yourself.` : `Missing ${sdk}; repair or reinstall Vocs Code.` }] : []),
      { id: 'node', name: 'Node.js', available: nodeReady, detail: version ? `${version}${!nodeReady ? ' — the latest Pi installer needs 22.19 or newer' : ''}. Needed for npm-installed agents, not working bundled binaries.` : 'Not found or could not start. Only needed for npm-installed agents; a working bundled runtime does not need Node.js. Install Node.js with npm before using the installer.', url: 'https://nodejs.org/en/download' },
      { id: 'npm', name: 'npm installer', available: !!npm, detail: npm ? 'Available for explicit installs into Vocs Code’s private runtime folder.' : 'Needed only for npm installations. Install Node.js with npm, then restart Vocs Code.', url: 'https://nodejs.org/en/download' },
      { id: 'git', name: 'Git', available: !!git, detail: git ? 'Available for repositories and isolated worktrees.' : 'Optional for a plain folder; needed for Git features and worktrees. Claude on Windows also requires Git for Windows.', url: 'https://git-scm.com/downloads' }
    ]
  };
}

function quoteSh(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function quotePs(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

/** Exposed as a bounded plan for tests; no caller-supplied shell text, cwd, URL, or arguments. */
export function loginArgs(harness: LoginHarnessId, device = false): string[] {
  if (harness === 'claude') return ['auth', 'login', '--claudeai'];
  if (harness === 'codex') return device ? ['login', '--device-auth'] : ['login'];
  if (harness === 'pi') return ['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'];
  if (harness === 'antigravity') return ['acp', '--login'];
  throw new Error('Unsupported sign-in');
}

type TerminalLaunchDeps = { platform?: NodeJS.Platform; spawn?: typeof spawn; which?: typeof which };
type TerminalLaunchResult = { ok: boolean; error?: string };
const USAGE_LAUNCH_GRACE_MS = 500;

/** Opens the vendor's own interactive flow. Success means launcher started, never authenticated. */
export async function openHarnessLogin(
  runtime: RuntimeResolver,
  harness: LoginHarnessId,
  device = false,
  deps: TerminalLaunchDeps = {}
): Promise<TerminalLaunchResult> {
  const args = loginArgs(harness, device); // validates before resolving or creating anything
  const binary = runtime.resolve(harness === 'antigravity' ? 'agy' : harness);
  if (!binary) return { ok: false, error: 'Install or repair this runtime first, then recheck setup.' };
  const cwd = path.join(runtime.runtimePaths.appRuntimeDir, 'sign-in');
  return openInteractiveTerminal({ harness, action: 'sign-in', binary: binary.path, args, cwd }, deps);
}

/** Requests an interactive agy launch without probing it. Success does not verify the terminal or sign-in. */
export async function openAntigravityUsage(runtime: RuntimeResolver, deps: TerminalLaunchDeps = {}): Promise<TerminalLaunchResult> {
  try {
    const resolved = runtime.resolve('agy');
    if (!resolved) return { ok: false, error: 'Install or repair the Antigravity CLI first, then recheck setup.' };
    let binary = resolved.path;
    if (resolved.source === 'settings') {
      // Resolve relative pins (including Windows drive-rooted paths) before switching to the private cwd.
      if (!path.isAbsolute(binary) || (process.platform === 'win32' && path.parse(binary).root.length === 1)) binary = path.resolve(binary);
      const file = await fs.stat(binary).catch(() => undefined);
      if (!file?.isFile()) return { ok: false, error: 'Check the pinned Antigravity CLI path in Settings → Harnesses, then retry.' };
    }
    const cwd = path.join(runtime.runtimePaths.appRuntimeDir, 'antigravity-usage');
    return await openInteractiveTerminal({ harness: 'antigravity', action: 'usage', binary, args: [], cwd }, deps);
  } catch {
    return { ok: false, error: 'Could not prepare the Antigravity usage terminal. Check setup and retry.' };
  }
}

async function openInteractiveTerminal(
  { harness, action, binary, args, cwd }: { harness: LoginHarnessId; action: 'sign-in' | 'usage'; binary: string; args: string[]; cwd: string },
  deps: TerminalLaunchDeps
): Promise<TerminalLaunchResult> {
  const usage = action === 'usage';
  const platform = deps.platform ?? process.platform;
  const locate = deps.which ?? which;
  const launch = deps.spawn ?? spawn;
  await fs.mkdir(cwd, usage ? { recursive: true, mode: 0o700 } : { recursive: true });
  // Terminal apps may reuse a running process instead of inheriting the launcher's env and cwd.
  // Apply the account environment filter and working directory again at the actual CLI launch.
  const unsetOverrides = `unset ${ANTIGRAVITY_AUTH_ENV_OVERRIDES.join(' ')}`;
  let command: string;
  let commandArgs: string[];
  let hideLauncher = false;
  if (platform === 'win32') {
    const powershell = locate('powershell') ?? locate('pwsh');
    if (!powershell) return { ok: false, error: 'PowerShell was not found. Install or enable PowerShell, restart Vocs Code, then retry.' };
    // EncodedCommand carries a literal-quoted executable and fixed arguments, never a user script.
    const script = [
      `Set-Location -LiteralPath ${quotePs(cwd)}${usage ? ' -ErrorAction Stop' : ''}`,
      ...(usage ? ANTIGRAVITY_AUTH_ENV_OVERRIDES.map((key) => `Remove-Item -LiteralPath 'Env:${key}' -ErrorAction SilentlyContinue`) : []),
      `& ${[binary, ...args].map(quotePs).join(' ')}`,
      ...(usage ? [] : ["Write-Host '\nReturn to Vocs Code and select Recheck setup when sign-in is complete.'"])
    ].join('\n');
    const psArgs = ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    const wt = locate('wt');
    command = wt ?? powershell;
    if (wt) commandArgs = ['new-tab', '--title', `Vocs Code — ${harness} ${action}`, powershell, ...psArgs];
    else {
      // The detached launcher's stdio is ignored. Start-Process gives the interactive child its
      // own console instead of inheriting those unusable standard handles on machines without wt.
      const broker = `$ErrorActionPreference = 'Stop'\nStart-Process -FilePath ${quotePs(powershell)} -ArgumentList ${quotePs(psArgs.join(' '))} -WorkingDirectory ${quotePs(cwd)}`;
      commandArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(broker, 'utf16le').toString('base64')];
      hideLauncher = true;
    }
  } else if (platform === 'darwin') {
    const dir = await fs.mkdtemp(path.join(cwd, usage ? 'usage-' : 'login-'));
    const file = path.join(dir, usage ? 'Antigravity Usage.command' : 'Sign in.command');
    const invocation = [binary, ...args].map(quoteSh).join(' ');
    const script = `#!/bin/sh\nrm -f -- "$0"\nrmdir -- ${quoteSh(dir)} 2>/dev/null\ncd ${quoteSh(cwd)} || exit 1\n` +
      (usage ? `${unsetOverrides}\nexec ${invocation}\n` : `${invocation}\nprintf '\\nReturn to Vocs Code and select Recheck setup.\\n'\n`);
    await fs.writeFile(file, script, { mode: 0o700 });
    command = 'open';
    commandArgs = ['-a', 'Terminal', file];
  } else {
    const terminal = locate('gnome-terminal') ?? locate('konsole') ?? locate('xterm') ?? locate('x-terminal-emulator');
    if (!terminal) return { ok: false, error: `No terminal application was found. Install a terminal, then retry${usage ? '.' : ' sign-in.'}` };
    command = terminal;
    // Pass paths as positional arguments, never as interpolated shell text.
    const invocation = usage
      ? ['/bin/sh', '-c', `cd "$1" || exit 1\n${unsetOverrides}\nshift\nexec "$@"`, 'agy-usage', cwd, binary, ...args]
      : [binary, ...args];
    commandArgs = [/gnome-terminal/.test(terminal) ? '--' : '-e', ...invocation];
  }
  const launchError = `Could not open the ${usage ? 'Antigravity usage' : 'sign-in'} terminal. Check your terminal installation and retry.`;
  return withProcessOwner({ label: `Harness ${action}: ${harness}` }, () => new Promise((resolve) => {
    // Only the launcher is detached from Vocs Code's stdio; agy runs on the user's terminal.
    const opts: SpawnOptions = { cwd, detached: true, stdio: 'ignore', windowsHide: hideLauncher, ...(usage ? { env: antigravityAccountEnv() } : {}) };
    try {
      const child = launch(command, commandArgs, opts);
      let grace: NodeJS.Timeout | undefined;
      const onExit = (code: number | null) => finish(code === 0);
      const finish = (ok: boolean) => {
        clearTimeout(grace);
        if (usage) child.off('exit', onExit);
        resolve(ok ? { ok: true } : { ok: false, error: launchError });
      };
      child.once('error', () => finish(false));
      if (usage) child.once('exit', onExit);
      child.once('spawn', () => {
        child.unref();
        if (!usage) finish(true);
        else if (child.exitCode != null || child.signalCode != null) onExit(child.exitCode);
        // Helpers may exit after delegating, or stay alive as the visible terminal. Never wait for it to close.
        else grace = setTimeout(() => finish(true), USAGE_LAUNCH_GRACE_MS);
      });
    } catch {
      resolve({ ok: false, error: launchError });
    }
  }));
}
