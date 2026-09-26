/** Mechanical path ownership, not semantic scope review (Mission spec §§9/14, R13).
 *
 * Patterns are repository-root-relative, case-sensitive and slash-separated on every OS.
 * A literal is exact; a trailing slash owns descendants. `*`/`?` match within one component;
 * a whole `**` component matches zero or more components, including dotfiles. No negation,
 * braces, character classes, extglobs, escaping, shell expansion or path normalization.
 * Unsupported patterns fail closed, even when another ownership entry would match.
 *
 * Exclusions mix paths and prose. Whole entries with path/glob notation, a filename suffix,
 * or a single token are path checks; other prose still requires lead/independent review.
 * We do not extract paths from sentences or claim to enforce semantic exclusions/contracts.
 * Only the host's complete captured delta is checked; never filter it or use result prose.
 */
import type { MissionCandidate, MissionTask } from '../../shared/mission';

function portableParts(value: string, pattern: boolean): string[] | undefined {
  if (!value || /[\\<>:"|\x00-\x1f\x7f\ufffd]/.test(value) || !pattern && /[?*]/.test(value)) return undefined;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[ .]$/.test(part)
    || /^\.git(?:[ .]|$)/i.test(part) || /^git~\d/i.test(part)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) return undefined;
  return parts;
}

function parsePattern(value: string): string[] | undefined {
  if (/[!\[\]{}()`$]/.test(value) || value.startsWith('~')) return undefined;
  const directory = value.endsWith('/');
  const parts = portableParts(directory ? value.slice(0, -1) : value, true);
  if (!parts || parts.some((part) => part !== '**' && part.includes('**'))) return undefined;
  // A directory spelling requires at least one child, unlike an exact literal file name.
  return directory ? [...parts, '*', '**'] : parts;
}

function pathShaped(value: string): boolean {
  return !/\s/.test(value) || /[/\\*?\[\]{}()]/.test(value) || /\.[^\s.]+$/.test(value);
}

/** Greedy wildcard matching with bounded stack use, not a user-generated RegExp. */
function matchTokens(pattern: readonly string[], value: readonly string[], star: string, equal: (pattern: string, value: string) => boolean): boolean {
  let p = 0, v = 0, wildcard = -1, retry = 0;
  while (v < value.length) {
    if (pattern[p] === star) { wildcard = p++; retry = v; }
    else if (p < pattern.length && equal(pattern[p], value[v])) { p++; v++; }
    else if (wildcard >= 0) { p = wildcard + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === star) p++;
  return p === pattern.length;
}
function matches(pattern: readonly string[], file: readonly string[]): boolean {
  return matchTokens(pattern, file, '**', (component, name) => matchTokens([...component], [...name], '*', (char, actual) => char === '?' || char === actual));
}

/** First actionable refusal. Empty ownership grants no writes; empty deltas still pass. */
export function candidateScopeIssue(task: Pick<MissionTask, 'ownedPaths' | 'exclusions'>, candidate: Pick<MissionCandidate, 'changedPaths'>, planExclusions: readonly string[]): string | undefined {
  const owned: string[][] = [], excluded: Array<{ pattern: string[]; source: string; value: string }> = [];
  for (const value of task.ownedPaths) {
    const pattern = parsePattern(value);
    if (!pattern) return `Scope has unsupported owned-path pattern ${JSON.stringify(value)}. Use relative literals, directory/, *, ? or whole-component **.`;
    owned.push(pattern);
  }
  for (const [source, values] of [['task', task.exclusions], ['Mission plan', planExclusions]] as const) for (const value of values) {
    if (!pathShaped(value)) continue;
    const pattern = parsePattern(value);
    if (!pattern) return `Scope has unsupported ${source} exclusion pattern ${JSON.stringify(value)}. Use a portable relative path/glob or a prose review constraint.`;
    excluded.push({ pattern, source, value });
  }
  for (const value of candidate.changedPaths) {
    const file = portableParts(value, false);
    if (!file) return `Scope cannot validate nonportable captured path ${JSON.stringify(value)}.`;
    if (!owned.some((pattern) => matches(pattern, file))) return `Scope does not own captured path ${JSON.stringify(value)}. Replan the task or submit a new scoped candidate; the captured diff was not filtered.`;
    const exclusion = excluded.find(({ pattern }) => matches(pattern, file));
    if (exclusion) return `Scope excludes captured path ${JSON.stringify(value)} via ${exclusion.source} exclusion ${JSON.stringify(exclusion.value)}.`;
  }
  return undefined;
}
