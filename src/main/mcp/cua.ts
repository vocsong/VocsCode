/**
 * Cua Driver as an opt-in built-in MCP server — computer use for every harness.
 *
 * Vocs Code does not ship the binary. It discovers one the user installed from
 * github.com/trycua/cua, asks for an authorization profile, and injects `cua-driver mcp` through
 * the normal MCP resolver, so every harness with `inject`/`client` support gets the driver's
 * tools with no adapter code. Off unless the user turns it on, and never enabled without a binary.
 *
 * The mode is read once, when the process that owns the driver runtime starts, and no tool call can
 * widen it — which is why it belongs in the server definition's environment and nowhere else.
 *
 * No Electron imports.
 */
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, CuaPermissionMode, CuaStatus, McpServerDef } from '../../shared/types';
import { runCapture, which } from '../runtime';

export const CUA_SERVER_ID = 'cua-driver';

/** Where Cua's one-line installer places the binary, beyond whatever is already on PATH. */
export function cuaInstallDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string[] {
  const dirs: string[] = [];
  const localAppData = env.LOCALAPPDATA?.trim();
  // Explicit path flavors, so the result depends on the target platform and not the host's.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32' && localAppData) dirs.push(join(localAppData, 'Programs', 'Cua', 'cua-driver', 'bin'));
  dirs.push(join(home, '.local', 'bin'));
  return dirs;
}

/**
 * The installed binary: an explicit override wins, then PATH, then Cua's own install directories.
 * A missing binary is a normal state, not an error — the UI shows the install hint.
 */
export function findCuaDriver(settings: AppSettings, lookup: typeof which = which): string | null {
  const override = settings.binaries?.cua?.trim();
  if (override) return override;
  return lookup('cua-driver', cuaInstallDirs());
}

export interface CuaEnvPlan {
  env: Record<string, string>;
  /** False when the selected mode is missing something it needs to start. */
  ready: boolean;
  reason?: string;
}

/**
 * The launch environment the driver runtime reads. `bounded` fails closed without a manifest, and
 * the environment form of `unrestricted` needs both the mode and the danger acknowledgement —
 * the CLI flag normalizes them in one step, the variables do not.
 */
export function cuaEnv(mode: CuaPermissionMode, manifestPath?: string): CuaEnvPlan {
  const env: Record<string, string> = { CUA_DRIVER_PERMISSION_MODE: mode };
  if (mode === 'bounded') {
    const manifest = manifestPath?.trim();
    if (!manifest) return { env, ready: false, reason: 'Bounded mode needs a capability manifest.' };
    env.CUA_DRIVER_CAPABILITY_MANIFEST_FILE = manifest;
    env.CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED = '1';
    return { env, ready: true };
  }
  if (mode === 'unrestricted') env.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS = '1';
  return { env, ready: true };
}

/** The seats computed once per settings read, shared by the server definition and the UI rows. */
export interface CuaDefState {
  installed: boolean;
  /** The user's opt-in switch. */
  enabled: boolean;
  /** Installed, opted in and the mode has everything it needs. */
  ready: boolean;
  mode: CuaPermissionMode;
  command: string | null;
  note: string;
}

export function cuaDefState(settings: AppSettings, lookup: typeof which = which): CuaDefState {
  const mode = settings.cua?.mode ?? 'standard';
  const command = findCuaDriver(settings, lookup);
  const plan = cuaEnv(mode, settings.cua?.manifestPath);
  const enabled = settings.cua?.enabled === true;
  const note = !command
    ? 'Cua Driver is not installed on this machine. Install it, then turn it on here.'
    : !enabled
      ? 'Off. Turn it on to let agents drive apps and browsers on this machine.'
      : !plan.ready
        ? plan.reason ?? 'Not ready.'
        : 'On. Agents can drive this machine; Vocs Code still prompts for each call below Full access.';
  return { installed: command !== null, enabled, ready: command !== null && plan.ready, mode, command, note };
}

/**
 * The built-in definition. A disabled one is still listed (the resolver's builtin pass honors
 * `disabled`) so the MCP page can offer the switch; it is never injected.
 */
export function cuaBaseDef(settings: AppSettings, lookup: typeof which = which): McpServerDef {
  const state = cuaDefState(settings, lookup);
  return {
    id: CUA_SERVER_ID,
    transport: 'stdio',
    command: state.command ?? 'cua-driver',
    args: ['mcp'],
    env: cuaEnv(state.mode, settings.cua?.manifestPath).env,
    description: 'Cua Driver — drive native desktop apps and browsers on this machine',
    disabled: !state.ready || !state.enabled
  };
}

/** Caches one `--version` probe for the doctor row. */
const versionCache = new Map<string, { at: number; version?: string }>();
const VERSION_TTL_MS = 60_000;

async function cuaVersion(command: string): Promise<string | undefined> {
  const cached = versionCache.get(command);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.version;
  const result = await runCapture(command, ['--version'], { timeoutMs: 5_000 });
  const line = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0]?.trim();
  const version = result.code === 0 && line ? line : undefined;
  versionCache.set(command, { at: Date.now(), version });
  return version;
}

export function clearCuaVersionCache(): void {
  versionCache.clear();
}

/** One status read for the MCP page and the Desktop tab. */
export async function cuaStatus(settings: AppSettings, lookup: typeof which = which): Promise<CuaStatus> {
  const state = cuaDefState(settings, lookup);
  if (!state.command) return { installed: false, mode: state.mode, ready: false, note: state.note };
  const version = await cuaVersion(state.command);
  if (!version) {
    return { installed: false, path: state.command, mode: state.mode, ready: false, note: `${state.command} did not answer --version; reinstall Cua Driver or point the binary override at it.` };
  }
  return { installed: true, path: state.command, version, mode: state.mode, ready: state.ready, note: state.note };
}