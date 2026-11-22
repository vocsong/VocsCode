/**
 * Shared Cua Driver computer-use settings and status types.
 * Keep this file free of Node/Electron/DOM imports.
 */

/**
 * Authorization profile Cua Driver runs under. The mode is read once, when the process that owns
 * the driver runtime starts, and a tool call can never widen it. `standard` is promptless for
 * routine actions; `bounded` requires a capability manifest and denies undeclared scope;
 * `unrestricted` requires an explicit dangerous acknowledgement. See docs/CUA-COMPUTER-USE.md.
 */
export type CuaPermissionMode = 'standard' | 'bounded' | 'unrestricted';

export const CUA_PERMISSION_MODES: readonly CuaPermissionMode[] = ['standard', 'bounded', 'unrestricted'];

export function isCuaPermissionMode(v: unknown): v is CuaPermissionMode {
  return typeof v === 'string' && (CUA_PERMISSION_MODES as readonly string[]).includes(v);
}

/** Vocs Code's computer-use settings; the binary itself is not shipped, only discovered. */
export interface CuaSettings {
  /**
   * On by default. Installing Cua Driver is already the user's explicit act, so the built-in turns
   * itself on when a binary is found — the same shape as GitNexus being on once a repo is indexed.
   * The app-wide switch (`mcpDisabledBuiltins`) and this repo's switch (`disabledBuiltin`) turn it
   * off, and the authorization mode/approvals are the real boundary.
   */
  enabled: boolean;
  mode: CuaPermissionMode;
  /** Required for `bounded`: a reviewed capability manifest scoping apps, origins and files. */
  manifestPath?: string;
}

/** What the MCP page and the Desktop tab need to know about the installed driver. */
export interface CuaStatus {
  installed: boolean;
  /** The resolved binary path, when one was found. */
  path?: string;
  version?: string;
  mode: CuaPermissionMode;
  /** Whether the selected mode has what it needs to start (bounded needs a manifest). */
  ready: boolean;
  /** One line for the UI. */
  note: string;
  /**
   * Which process owns the authorization mode: Vocs Code's launch environment, or the host's own
   * Cua Driver daemon (macOS proxies to `CuaDriver.app`, so the daemon's launch flags decide).
   */
  modeSource: 'vocs-code' | 'host';
  /** The platform's official one-line installer, shown before it is ever run. */
  installCommand?: string;
}

/** One live screen capture for the Desktop preview tab. */
export interface CuaPreviewResult {
  ok: boolean;
  /** A `data:` URL, ready to hand to an `<img>`. */
  imageDataUrl?: string;
  error?: string;
}

/** Result of running Cua Driver's official installer on the user's behalf. */
export interface CuaInstallResult {
  ok: boolean;
  /** The command that was run, so the UI can be exact about what happened. */
  command: string;
  /** Tail of the installer's output. */
  output?: string;
  error?: string;
}
