// Computer use as an opt-in built-in MCP server: discovery, the fail-closed permission-mode
// environment, the server definition's disabled states, and the settings normalization that makes
// a hand-edited settings.json safe.
import { describe, expect, it } from 'vitest';
import {
  CUA_SERVER_ID,
  cuaBaseDef,
  cuaDefState,
  cuaEnv,
  cuaInstallDirs,
  findCuaDriver
} from '../src/main/mcp/cua';
import { builtinEntries, effectiveServers } from '../src/main/mcp/effective';
import { builtinServerIds } from '../src/main/mcp';
import { defaultSettings, normalizeCuaSettings, normalizeSettings } from '../src/main/settings';
import type { AppSettings, CuaSettings } from '../src/shared/types';

const BASE = defaultSettings();
const installed = (_cmd: string): string | null => '/opt/cua/cua-driver';
const missing = (): string | null => null;

const settings = (cua: Partial<CuaSettings> = {}, over: Partial<AppSettings> = {}): AppSettings => ({
  ...BASE,
  cua: { enabled: true, mode: 'standard', ...cua },
  ...over
});

describe('Cua Driver discovery', () => {
  it('looks in Cua\'s own install directory and the usual user bin', () => {
    const dirs = cuaInstallDirs({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } as NodeJS.ProcessEnv, 'win32', 'C:\\Users\\u');
    expect(dirs).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin');
    expect(dirs).toContain('C:\\Users\\u\\.local\\bin');
    const nix = cuaInstallDirs({} as NodeJS.ProcessEnv, 'darwin', '/Users/u');
    expect(nix).toEqual(['/Users/u/.local/bin']);
  });

  it('prefers an explicit override over the PATH lookup', () => {
    const override = settings({}, { binaries: { cua: '/custom/cua-driver' } });
    expect(findCuaDriver(override, missing)).toBe('/custom/cua-driver');
  });

  it('falls back to the PATH lookup', () => {
    expect(findCuaDriver(settings(), installed)).toBe('/opt/cua/cua-driver');
    expect(findCuaDriver(settings(), missing)).toBeNull();
  });
});

describe('Cua permission mode resolves to the launch environment', () => {
  it('standard is ready with only the mode', () => {
    expect(cuaEnv('standard')).toEqual({ env: { CUA_DRIVER_PERMISSION_MODE: 'standard' }, ready: true });
  });

  it('bounded fails closed without a manifest and carries both halves with one', () => {
    expect(cuaEnv('bounded').ready).toBe(false);
    expect(cuaEnv('bounded', '   ').ready).toBe(false);
    const withManifest = cuaEnv('bounded', '/etc/cua-capabilities.yaml');
    expect(withManifest.ready).toBe(true);
    expect(withManifest.env).toEqual({
      CUA_DRIVER_PERMISSION_MODE: 'bounded',
      CUA_DRIVER_CAPABILITY_MANIFEST_FILE: '/etc/cua-capabilities.yaml',
      CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: '1'
    });
  });

  it('unrestricted needs the danger acknowledgement the CLI flag would have added', () => {
    expect(cuaEnv('unrestricted').env).toEqual({
      CUA_DRIVER_PERMISSION_MODE: 'unrestricted',
      CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1'
    });
  });
});

describe('the built-in definition is off unless the user, the binary and the mode all line up', () => {
  it('is disabled when the binary is missing, even with the switch on', () => {
    expect(cuaBaseDef(settings({ enabled: true }), missing).disabled).toBe(true);
    expect(cuaDefState(settings({ enabled: true }), missing).note).toMatch(/not installed/i);
  });

  it('is disabled when the user has not opted in', () => {
    expect(cuaBaseDef(settings({ enabled: false }), installed).disabled).toBe(true);
    expect(cuaDefState(settings({ enabled: false }), installed).note).toMatch(/^Off\./);
  });

  it('is enabled once installed and the mode can start, with no opt-in step', () => {
    const def = cuaBaseDef(settings({ mode: 'standard' }), installed);
    expect(def.disabled).toBe(false);
    expect(def.command).toBe('/opt/cua/cua-driver');
    expect(def.args).toEqual(['mcp']);
    expect(def.env).toEqual({ CUA_DRIVER_PERMISSION_MODE: 'standard' });
  });

  it('stays disabled in bounded mode until a manifest is set, and when explicitly off', () => {
    expect(cuaBaseDef(settings({ enabled: false, mode: 'standard' }), installed).disabled).toBe(true);
    expect(cuaBaseDef(settings({ enabled: true, mode: 'bounded' }), installed).disabled).toBe(true);
    expect(cuaDefState(settings({ enabled: true, mode: 'bounded' }), installed).note).toMatch(/manifest/i);
    const withManifest = cuaBaseDef(settings({ enabled: true, mode: 'bounded', manifestPath: '/m.yaml' }), installed);
    expect(withManifest.disabled).toBe(false);
    expect(withManifest.env?.CUA_DRIVER_CAPABILITY_MANIFEST_FILE).toBe('/m.yaml');
  });
});

describe('the effective set treats a disabled built-in as off', () => {
  const enabledDef = cuaBaseDef(settings({ enabled: true }), installed);
  const offDef = cuaBaseDef(settings({ enabled: false }), installed);

  it('does not inject an opted-out built-in', () => {
    const [e] = builtinEntries({ builtin: [offDef], state: {}, harness: 'claude', support: 'inject' });
    expect(e.enabled).toBe(false);
    expect(e.reason).toBe('disabled');
    expect(effectiveServers({ global: [], repo: [], state: {}, harness: 'claude', support: 'inject', builtin: [offDef] })).toEqual([]);
  });

  it('injects an opted-in built-in for a harness that can take it', () => {
    const [e] = builtinEntries({ builtin: [enabledDef], state: {}, harness: 'claude', support: 'inject' });
    expect(e).toEqual({ def: enabledDef, scope: 'builtin', enabled: true });
  });

  it('lets a repo switch it off even when the user opted in', () => {
    const [e] = builtinEntries({ builtin: [enabledDef], state: { disabledBuiltin: [CUA_SERVER_ID] }, harness: 'claude', support: 'inject' });
    expect(e.enabled).toBe(false);
    expect(e.reason).toBe('disabled');
  });

  it('claims the id whether or not it is currently enabled', () => {
    expect(builtinServerIds()).toContain(CUA_SERVER_ID);
  });
});

describe('settings normalization for computer use', () => {
  it('is off and standard by default', () => {
    expect(defaultSettings().cua).toEqual({ enabled: true, mode: 'standard' });
  });

  it('coerces an unknown mode back to standard and drops an empty manifest path', () => {
    expect(normalizeCuaSettings({ enabled: true, mode: 'yolo' as never, manifestPath: '   ' })).toEqual({ enabled: true, mode: 'standard' });
    expect(normalizeCuaSettings(undefined)).toEqual({ enabled: true, mode: 'standard' });
    expect(normalizeCuaSettings({ mode: 'bounded', manifestPath: ' /m.yaml ' })).toEqual({ enabled: true, mode: 'bounded', manifestPath: '/m.yaml' });
    // Only an explicit false turns the built-in off.
    expect(normalizeCuaSettings({ enabled: false, mode: 'standard' })).toEqual({ enabled: false, mode: 'standard' });
    expect(normalizeCuaSettings({ enabled: 'yes' as never })).toEqual({ enabled: true, mode: 'standard' });
  });

  it('makes a hand-edited settings.json safe', () => {
    const s = normalizeSettings({ cua: { enabled: true, mode: 'unrestricted' }, mcpServers: [{ id: CUA_SERVER_ID, transport: 'stdio', command: 'cua-driver', args: ['mcp'] }] } as never);
    expect(s.cua).toEqual({ enabled: true, mode: 'unrestricted' });
    // The built-in owns the id; the leftover user entry is dropped rather than shown as a dead row.
    expect(s.mcpServers).toEqual([]);
  });
});