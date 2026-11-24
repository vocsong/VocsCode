/**
 * Shared domain types used by the main process, preload, and renderer.
 * Keep this file free of Node/Electron/DOM imports.
 *
 * Domain re-exports are type-only; existing runtime exports stay here.
 */
import type { CuaPermissionMode } from './cua-types';

export type * from './harness-types';
export type * from './mcp-types';
export type * from './cua-types';
export type * from './skills-types';
export type * from './pi-config-types';
export type * from './usage-types';
export type * from './transcript-types';
export type * from './session-types';
export type * from './git-types';
export type * from './remote-types';
export type * from './app-types';
export type * from './analytics/summary';
export type * from './settings-types';

/** Ids of the MCP servers this app ships itself. A same-named user entry is not theirs to edit, so it is ignored everywhere. */
export const MCP_BUILTIN_IDS: readonly string[] = ['gitnexus', 'vocs-memory', 'cua-driver', 'vocs-mission', 'vocs-openrouter'];

export const CUA_PERMISSION_MODES: readonly CuaPermissionMode[] = ['standard', 'bounded', 'unrestricted'];

export function isCuaPermissionMode(v: unknown): v is CuaPermissionMode {
  return typeof v === 'string' && (CUA_PERMISSION_MODES as readonly string[]).includes(v);
}
