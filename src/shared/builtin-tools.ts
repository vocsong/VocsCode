import { BUILDER_TOOLS, LEAD_TOOLS, MISSION_SERVER_ID } from './mission-mode';

/**
 * Tools that Vocs Code's own MCP servers expose read-only. Every permission tier, Plan included,
 * runs these without asking; every other tool from these servers follows the tier like any other
 * change. The list is an allowlist: a tool missing from it (a new or renamed one) is treated as
 * making changes, which is the safe default.
 *
 * Callers must only look a tool up under a server id the app itself built. Built-in ids are
 * reserved (`MCP_BUILTIN_IDS`): a user or repository server with the same name is ignored
 * everywhere, so a tool reached as `mcp__<built-in id>__<tool>` can only come from the built-in.
 * Add a server here when Vocs Code ships a new one, and its read-only tools work on every harness.
 */
export const BUILTIN_READ_ONLY_TOOLS: Readonly<Record<string, readonly string[]>> = {
  // Mirrors READ_ONLY_TOOLS in resources/mcp/vocs-memory.mjs (pinned by tests/permission-tools.test.ts).
  'vocs-memory': [
    'knowledge_search', 'knowledge_read', 'knowledge_related', 'knowledge_status', 'session_history_search',
    'intelligence_search', 'intelligence_trace', 'context_compile', 'memory_recall'
  ],
  // `rename` edits source files and `cypher` runs arbitrary graph queries; both follow the tier.
  gitnexus: ['query', 'context', 'impact', 'detect_changes', 'api_impact', 'route_map', 'tool_map', 'shape_check', 'list_repos'],
  // Observation only: anything that clicks, types, launches, records or changes configuration follows the tier.
  'cua-driver': [
    'check_permissions', 'check_for_update', 'debug_window_info', 'get_accessibility_tree', 'get_agent_cursor_state',
    'get_browser_state', 'get_config', 'get_cursor_position', 'get_desktop_state', 'get_recording_state', 'get_screen_size',
    'get_session', 'get_session_state', 'get_window_state', 'health_report', 'list_apps', 'list_sessions', 'list_windows',
    'verify_state', 'zoom'
  ]
};

/**
 * Mission mode coordination tools (`vocs-mission`). They never touch the workspace, so they run in
 * every tier, Plan included: the Lead is in Plan by design. The role check is the gateway's: a
 * session's token only lists and accepts its own role's tools, and only mission sessions get the
 * server at all. Mirrors MISSION_TOOLS in resources/pi/vocs-code-mcp.ts.
 */
export const BUILTIN_MISSION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  [MISSION_SERVER_ID]: [...LEAD_TOOLS, ...BUILDER_TOOLS]
};

/** True when `tool` is a Mission coordination tool of the built-in server `serverId`. */
export function isBuiltinMissionTool(serverId: string, tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_MISSION_TOOLS, serverId) && BUILTIN_MISSION_TOOLS[serverId]!.includes(tool);
}

/** Tools every tier runs without asking: the read-only built-ins plus the Mission coordination tools. */
export function isBuiltinTrustedTool(serverId: string, tool: string): boolean {
  return isBuiltinReadOnlyTool(serverId, tool) || isBuiltinMissionTool(serverId, tool);
}

/** True when `tool` is a read-only tool of the built-in server `serverId`. */
export function isBuiltinReadOnlyTool(serverId: string, tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_READ_ONLY_TOOLS, serverId) && BUILTIN_READ_ONLY_TOOLS[serverId]!.includes(tool);
}

/**
 * For a harness-level tool name of the form `mcp__<server>__<tool>`: true when it names a read-only
 * built-in tool. Servers may contain `__`-free ids only (built-in ids do), so the first `__` after
 * the prefix splits server from tool.
 */
export function isBuiltinReadOnlyMcpName(name: string): boolean {
  const parts = splitMcpName(name);
  return !!parts && isBuiltinReadOnlyTool(parts.server, parts.tool);
}

/** Like `isBuiltinReadOnlyMcpName`, for a Mission coordination tool (`mcp__vocs-mission__<tool>`). */
export function isBuiltinMissionMcpName(name: string): boolean {
  const parts = splitMcpName(name);
  return !!parts && isBuiltinMissionTool(parts.server, parts.tool);
}

/** Like `isBuiltinReadOnlyMcpName`, for any tool every tier runs (`isBuiltinTrustedTool`). */
export function isBuiltinTrustedMcpName(name: string): boolean {
  const parts = splitMcpName(name);
  return !!parts && isBuiltinTrustedTool(parts.server, parts.tool);
}

function splitMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const split = rest.indexOf('__');
  if (split <= 0) return undefined;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}
