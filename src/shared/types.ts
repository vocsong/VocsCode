/**
 * Shared domain types used by the main process, preload, and renderer.
 * Keep this file free of Node/Electron/DOM imports.
 *
 * Domain definitions live in dedicated leaf modules so shared helpers can import
 * narrow types without forming circular dependency graphs; this barrel re-exports
 * every symbol for backwards compatibility.
 */
export * from './harness-types';
export * from './mcp-types';
export * from './cua-types';
export * from './skills-types';
export * from './pi-config-types';
export * from './usage-types';
export * from './transcript-types';
export * from './session-types';
export * from './git-types';
export * from './remote-types';
export * from './app-types';
export * from './analytics/summary';
export * from './settings-types';
