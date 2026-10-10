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

/**
 * The branch-name part after the prefix, and the worktree folder name: lowercase words joined by
 * `-`, at most 40 characters. Shared so the dialog previews the exact name the main process creates.
 */
export function branchSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'session';
}

/** How a branch name is kept short: at most this many words, and never cut mid-word past 40 chars. */
const NAME_WORDS = 5;
const NAME_CHARS = 40;

/** Openers that say how the user asks, not what they ask for ("Can you please …", "I want to …"). */
const FILLER = /^(?:(?:hey|hi|hello|ok|okay|so|please|pls|kindly|can you|could you|would you|will you|can we|could we|let'?s|i want(?: you)? to|i'?d like(?: you)? to|i would like(?: you)? to|i need(?: you)? to|we need to|need to|help me(?: to)?|try to|go ahead and|i think)\b[\s,.!:;-]*)+/i;

/** Words that carry no intent in a branch name. Verbs stay: `fix`, `add` and `make` are the intent. */
const STOP_WORDS = new Set(
  'a an the to of for in on at by with and or but so that this these those it its is are was were be been being am my our your their his her we i you me us them some any please just also then there here when where which who whom what how why if into from as up out about all can could should would will shall do does did currently now very really same such than'.split(' ')
);

/** Joins words with `-` up to the word and length limits, dropping a word rather than cutting it. */
function joinBranchWords(words: string[]): string {
  let out = '';
  for (const w of words.slice(0, NAME_WORDS)) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > NAME_CHARS) break;
    out = next;
  }
  return out;
}

/**
 * A branch name for the intent of a prompt or title, without a model: the first sentence with its
 * opener ("Can you please …") and filler words dropped, so `Can you please fix the login redirect
 * when users sign in` names `fix-login-redirect-users-sign` rather than `can-you-please-fix-the-logi`.
 * Falls back to the plain slug when nothing meaningful is left.
 */
export function branchNameFromText(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  const sentence = (line.split(/[.!?](?:\s|$)/)[0] ?? line).trim().replace(FILLER, '');
  const words = sentence
    .toLowerCase()
    .replace(/'/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  return joinBranchWords(words) || branchSlug(text);
}

/** Chat-template control tokens a provider failed to parse out of a reply; never part of a name. */
const CONTROL_TOKEN_RE = /<\||\uFF5C/;

/**
 * A model's branch-name reply in stored form, or null when it is not usable: the first line with
 * any quoting, "Branch name:" preamble and type prefix (`feat/`, which the user picks separately)
 * removed, slugified and kept to the same word and length limits as the offline name.
 */
export function sanitizeBranchNameReply(raw: string): string | null {
  const line = raw.trim().split('\n')[0] ?? '';
  if (CONTROL_TOKEN_RE.test(line)) return null;
  const cleaned = line
    .replace(/[`"'*]/g, '')
    .trim()
    .replace(/^(?:git\s+)?(?:branch(?:\s+name)?|name)\s*:\s*/i, '')
    .replace(/^(?:[a-z0-9._-]+\/)+/i, '');
  const words = cleaned.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return joinBranchWords(words) || null;
}

/** Every prefix a picker offers: the built-in ones, then the user's saved ones. */
export function branchPrefixOptions(custom: readonly string[] | undefined): string[] {
  return [...BUILTIN_BRANCH_PREFIXES, ...normalizeCustomBranchPrefixes(custom)];
}
