/**
 * Branch prefixes for the worktrees the app creates. An isolated session starts on
 * `<prefix>/<slug>`: `vocscode/` unless the user picks another, because many repositories only
 * accept branch names in their own scheme (`feat/…`, `fix/…`, `chore/…`). Prefixes are stored
 * without the trailing slash.
 */

export const DEFAULT_BRANCH_PREFIX = 'vocscode';

/** Always offered, in this order; user-added prefixes follow them. */
export const BUILTIN_BRANCH_PREFIXES: readonly string[] = [DEFAULT_BRANCH_PREFIX, 'feat', 'fix', 'chore'];

/** How many saved custom prefixes settings keep. */
export const MAX_CUSTOM_BRANCH_PREFIXES = 20;

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * The prefix in its stored form, or undefined when it cannot start a branch name. Surrounding
 * whitespace and slashes are dropped (`feat/` → `feat`); what is left must be one or more
 * `/`-separated segments git accepts as a ref component (no `..`, no trailing `.` or `.lock`).
 */
export function normalizeBranchPrefix(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const prefix = input.trim().replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.length > 40 || prefix.includes('..')) return undefined;
  const ok = prefix.split('/').every((s) => SEGMENT.test(s) && !s.endsWith('.') && !s.endsWith('.lock'));
  return ok ? prefix : undefined;
}

export function isBuiltinBranchPrefix(prefix: string): boolean {
  return BUILTIN_BRANCH_PREFIXES.includes(prefix);
}

/** Saved custom prefixes: valid, distinct, never a built-in one, at most MAX_CUSTOM_BRANCH_PREFIXES. */
export function normalizeCustomBranchPrefixes(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const out: string[] = [];
  for (const raw of stored) {
    const prefix = normalizeBranchPrefix(raw);
    if (prefix && !isBuiltinBranchPrefix(prefix) && !out.includes(prefix)) out.push(prefix);
    if (out.length >= MAX_CUSTOM_BRANCH_PREFIXES) break;
  }
  return out;
}

/** Every prefix a picker offers: the built-in ones, then the user's saved ones. */
export function branchPrefixOptions(custom: readonly string[] | undefined): string[] {
  return [...BUILTIN_BRANCH_PREFIXES, ...normalizeCustomBranchPrefixes(custom)];
}
