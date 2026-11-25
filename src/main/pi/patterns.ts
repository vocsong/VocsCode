/** Pure Pi resource glob/override matching and package-location resolution. */
import path from 'node:path';
import type { PiPackageKind, PiResourceType } from '../../shared/types';

export function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Same normalization pi applies before comparing an exact `+`/`-` pattern. */
export function normalizePattern(pattern: string): string {
  const stripped = pattern.startsWith('./') || pattern.startsWith('.\\') ? pattern.slice(2) : pattern;
  return toPosix(stripped);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** A compact glob matcher for pi's `!` patterns: `**` crosses separators, `*`/`?` stay in one. */
export function matchPiGlob(pattern: string, candidate: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRegExp(c);
  }
  try {
    return new RegExp(`^${re}$`).test(candidate);
  } catch {
    return false;
  }
}

/** Candidate strings a pattern may name for one file: its path and, for skills, its folder. */
function patternTargets(filePath: string, baseDir: string, skill: boolean): string[] {
  const targets = [toPosix(path.relative(baseDir, filePath)), toPosix(path.resolve(filePath))];
  if (skill) {
    targets.push(toPosix(path.relative(baseDir, path.dirname(filePath))), toPosix(path.dirname(path.resolve(filePath))));
  }
  return targets;
}

function matchesExactTarget(filePath: string, pattern: string, baseDir: string, skill = false): boolean {
  return patternTargets(filePath, baseDir, skill).includes(normalizePattern(pattern));
}

function matchesGlobTarget(filePath: string, pattern: string, baseDir: string, skill = false): boolean {
  return patternTargets(filePath, baseDir, skill).some((t) => matchPiGlob(normalizePattern(pattern), t));
}

/**
 * Mirrors pi's `applyPatterns` for a list of resource files: plain entries are an include
 * allowlist, `!` excludes with globs, `+` force-includes exact paths, `-` force-excludes them.
 */
export function applyPatternsToFiles(files: string[], patterns: string[], baseDir: string): Set<string> {
  const includes = patterns.filter((p) => !/^[!+-]/.test(p));
  const excludes = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const forceIncludes = patterns.filter((p) => p.startsWith('+')).map((p) => p.slice(1));
  const forceExcludes = patterns.filter((p) => p.startsWith('-')).map((p) => p.slice(1));
  let result = includes.length ? files.filter((f) => includes.some((p) => matchesGlobTarget(f, p, baseDir))) : [...files];
  if (excludes.length) result = result.filter((f) => !excludes.some((p) => matchesGlobTarget(f, p, baseDir)));
  if (forceIncludes.length) for (const f of files) if (!result.includes(f) && forceIncludes.some((p) => matchesExactTarget(f, p, baseDir))) result.push(f);
  if (forceExcludes.length) result = result.filter((f) => !forceExcludes.some((p) => matchesExactTarget(f, p, baseDir)));
  return new Set(result);
}

/**
 * Whether pi would load `filePath`, mirroring package-manager's `isEnabledByOverrides`: plain
 * settings entries do not filter auto-discovered resources — only `!` excludes by glob, then `+`
 * force-includes by exact path, then `-` force-excludes. Skill patterns may name the SKILL.md or
 * its containing folder, as pi allows.
 */
export function piResourceEnabled(type: PiResourceType, filePath: string, agentDir: string, settings: Record<string, unknown>): { enabled: boolean; forced: boolean } {
  const entries = stringArray(settings[type]);
  const skill = type === 'skills';
  const excludes = entries.filter((e) => e.startsWith('!')).map((e) => e.slice(1));
  const forceIncludes = entries.filter((e) => e.startsWith('+')).map((e) => e.slice(1));
  const forceExcludes = entries.filter((e) => e.startsWith('-')).map((e) => e.slice(1));
  const excluded = excludes.some((p) => matchesGlobTarget(filePath, p, agentDir, skill));
  const forcedIn = forceIncludes.some((p) => matchesExactTarget(filePath, p, agentDir, skill));
  const forcedOut = forceExcludes.some((p) => matchesExactTarget(filePath, p, agentDir, skill));
  let enabled = true;
  if (excluded) enabled = false;
  if (forcedIn) enabled = true;
  if (forcedOut) enabled = false;
  return { enabled, forced: excluded || forcedIn || forcedOut };
}

/**
 * One file inside a package, mirroring package-manager's package filter rules:
 * no array at all means every resource loads (unless `autoload:false` means only explicit filters
 * do); an explicit empty array disables the type; otherwise `applyPatterns` decides, and under
 * `autoload:false` the patterns are a delta where the last match wins.
 */
export function packageResourceEnabled(filePath: string, patterns: string[] | undefined, baseDir: string, autoload: boolean): boolean {
  if (patterns === undefined) return autoload;
  if (!autoload) {
    let enabled = false;
    for (const entry of patterns) {
      const kind = entry.startsWith('+') ? '+' : entry.startsWith('-') ? '-' : entry.startsWith('!') ? '!' : '';
      const target = entry.slice(kind ? 1 : 0);
      const matched = kind === '+' || kind === '-' ? matchesExactTarget(filePath, target, baseDir) : matchesGlobTarget(filePath, target, baseDir);
      if (matched) enabled = kind !== '-' && kind !== '!';
    }
    return enabled;
  }
  if (patterns.length === 0) return false;
  return applyPatternsToFiles([filePath], patterns, baseDir).has(filePath);
}

/** `host/owner/repo` for the git URL spellings pi accepts, or null when it is not a git source. */
function gitHostPath(source: string): string | null {
  let host: string;
  let repoPath: string;
  const scp = /^git@([^:/]+):(.+)$/.exec(source);
  if (scp) {
    host = scp[1]!;
    repoPath = scp[2]!;
  } else if (/^(?:https?|ssh|git):\/\//i.test(source)) {
    try {
      const url = new URL(source);
      host = url.hostname;
      repoPath = url.pathname;
    } catch {
      return null;
    }
  } else if (/^[\w.-]+\.[a-z]{2,}\//i.test(source)) {
    const slash = source.indexOf('/');
    host = source.slice(0, slash);
    repoPath = source.slice(slash + 1);
  } else {
    return null;
  }
  repoPath = repoPath.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/@[^/]+$/, '').replace(/\/+$/, '');
  if (!host || !repoPath || /[\\\0]/.test(repoPath) || repoPath.split('/').some((s) => !s || s === '..' || s === '.')) return null;
  return `${host}/${repoPath}`;
}

/** How a package source string is materialized on disk, following pi's own conventions. */
export function packageLocation(source: string, agentDir: string, home: string): { kind: PiPackageKind; path: string } {
  const source0 = source.trim();
  if (source0.startsWith('npm:')) {
    const spec = source0.slice('npm:'.length).trim();
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    return { kind: 'npm', path: path.join(agentDir, 'npm', 'node_modules', ...name.split('/')) };
  }
  const bare = source0.startsWith('git:') ? source0.slice('git:'.length).trim() : source0;
  const gitPath = gitHostPath(bare);
  if (gitPath) return { kind: 'git', path: path.join(agentDir, 'git', ...gitPath.split('/')) };
  const expanded = bare.startsWith('~/') || bare.startsWith('~\\') ? path.join(home, bare.slice(2)) : bare;
  return { kind: 'local', path: path.resolve(agentDir, expanded) };
}
