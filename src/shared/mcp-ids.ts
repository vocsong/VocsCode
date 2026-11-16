/**
 * MCP server names as harnesses see them. A server id becomes a tool-name segment
 * (`mcp__<id>__<tool>`), and every harness folds it first: pi and the native loop lowercase it and
 * turn `-` and `.` into `_`. Two ids that fold together therefore name the same tools, so the
 * rules here compare folded keys, never raw ids: a built-in's name is reserved in every spelling,
 * and two user servers may not share one. Shared by main (save, selection) and the renderer (form).
 */
import { MCP_BUILTIN_IDS } from './types';

/** The folded key: lowercase, every run of other characters one `_`, no leading or trailing `_`. */
export function mcpIdKey(id: string): string {
  return String(id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The built-in server a name folds onto, if any. */
export function reservedBuiltinFor(id: string): string | undefined {
  const key = mcpIdKey(id);
  return MCP_BUILTIN_IDS.find((builtin) => mcpIdKey(builtin) === key);
}

export function reservedIdReason(id: string, builtin: string): string {
  return `"${id}" is reserved for the built-in ${builtin} server. Choose another name.`;
}

export function duplicateIdReason(id: string, other: string): string {
  return `"${id}" resolves to the same tool names as "${other}". Choose another name.`;
}

export interface McpIdIssue {
  /** Position in the list that was checked. */
  index: number;
  id: string;
  kind: 'reserved' | 'duplicate';
  reason: string;
}

/**
 * Why each user-defined server in one list cannot be loaded. The first holder of a folded key keeps
 * it; a later one is the duplicate. Order is the list's own.
 */
export function mcpIdIssues(defs: readonly { id: string }[]): McpIdIssue[] {
  const issues: McpIdIssue[] = [];
  const holders = new Map<string, string>();
  for (const [index, { id }] of defs.entries()) {
    const builtin = reservedBuiltinFor(id);
    if (builtin) {
      issues.push({ index, id, kind: 'reserved', reason: reservedIdReason(id, builtin) });
      continue;
    }
    const key = mcpIdKey(id);
    const holder = holders.get(key);
    if (holder !== undefined) issues.push({ index, id, kind: 'duplicate', reason: duplicateIdReason(id, holder) });
    else holders.set(key, id);
  }
  return issues;
}

/** The problem with naming a new or edited server `id` beside `others` (the form's check). */
export function mcpIdProblem(id: string, others: readonly string[]): string | null {
  const builtin = reservedBuiltinFor(id);
  if (builtin) return reservedIdReason(id, builtin);
  const key = mcpIdKey(id);
  const other = others.find((o) => mcpIdKey(o) === key);
  return other === undefined ? null : other === id ? 'That name is already used here.' : duplicateIdReason(id, other);
}
