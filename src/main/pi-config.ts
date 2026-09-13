/**
 * Base-pi global configuration behind Settings → Pi. No Electron imports.
 *
 * Manages base pi's own resources (extensions, skills, prompt templates, themes in the global
 * agent dir), the curated global settings.json keys, the installed packages declared in
 * settings.json.packages, and pi-subagents' global agents/subagents.json. Package install/remove/
 * update shell out to the user's own `pi` binary so pi owns cloning, npm installs and lock
 * discipline; resource filters are written exactly as pi's config-selector writes them
 * (`+<relative>` / `-<relative>`, `!pattern` excludes).
 *
 * Writes are read-merge-write through the atomic JSON writer. pi's TUI takes a proper-lockfile lock
 * when it saves settings; a save landing between our read and rename could be lost, so the window
 * is one read/write pair and nothing is written on page load.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  PiAgentInfo,
  PiCommandResult,
  PiPackageItem,
  PiPackageKind,
  PiPreferences,
  PiPreferencesPatch,
  PiPromptFile,
  PiPromptName,
  PiResourceItem,
  PiResourceType,
  PiSetup,
  PiSubagentsPatch,
  PiSubagentsSettings
} from '../shared/types';
import { piAgentDir } from './pi-agents';
import { parseFrontmatter } from './skills';
import { spawnTool, killTree } from './harness/spawn';
import { errorMessage } from './util/async';
import { isSubPath, writeJson } from './util/fs';
import type { Logger } from './log';

export const PI_RESOURCE_TYPES: PiResourceType[] = ['extensions', 'skills', 'prompts', 'themes'];
export const PI_PROMPT_NAMES: PiPromptName[] = ['AGENTS.md', 'APPEND_SYSTEM.md', 'SYSTEM.md'];

/** pi refuses to load a prompt file larger than this anyway; the cap also bounds the IPC payload. */
const PROMPT_FILE_LIMIT = 512 * 1024;
/** Package installs can take a while (git clone + npm install); the handler waits, then kills. */
const PI_COMMAND_TIMEOUT_MS = 300_000;
const PI_COMMAND_LOG_LIMIT = 64 * 1024;

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const TRANSPORTS = new Set(['auto', 'sse', 'websocket', 'websocket-cached']);
const TRUST_LEVELS = new Set(['ask', 'always', 'never']);

export interface PiPaths {
  agentDir: string;
  settingsPath: string;
}

export interface PiConfigOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  log?: Logger;
  /** Runs the user's pi binary for install/remove/update; absent in tests and when pi is missing. */
  runPi?: PiRunner;
  /** Resolves the pi binary so the UI can disable package actions when it is absent. */
  piBinary?: () => string | null;
}

/** Resolves pi's global agent dir the way pi itself does (env override, then home). */
export function piPaths(env: NodeJS.ProcessEnv = process.env, home?: string): PiPaths {
  const agentDir = path.resolve(piAgentDir(env, home));
  return { agentDir, settingsPath: path.join(agentDir, 'settings.json') };
}

function homeDirFor(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE ?? env.HOME ?? os.homedir();
}

interface SettingsRead {
  settings: Record<string, unknown>;
  error?: string;
}

/**
 * Reads settings.json without the quarantining readJson helper: a malformed pi settings file must
 * be surfaced to the user and left alone, not copied to a `.corrupt-*` artifact pi never wrote.
 */
async function readSettingsFile(settingsPath: string): Promise<SettingsRead> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {} };
    return { settings: {}, error: `Could not read ${settingsPath}: ${errorMessage(e)}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { settings: {}, error: `${settingsPath} is not a JSON object` };
    return { settings: parsed as Record<string, unknown> };
  } catch (e) {
    return { settings: {}, error: `${settingsPath} is not valid JSON: ${errorMessage(e)}` };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function object(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The curated subset of global settings, read defensively: a hand-edited value is ignored, not echoed. */
function readPreferences(settings: Record<string, unknown>): PiPreferences {
  const compaction = object(settings.compaction);
  const retry = object(settings.retry);
  const level = str(settings.defaultThinkingLevel);
  const transport = str(settings.transport);
  const trust = str(settings.defaultProjectTrust);
  return {
    ...(level && THINKING_LEVELS.has(level) ? { defaultThinkingLevel: level } : {}),
    ...(transport && TRANSPORTS.has(transport) ? { transport } : {}),
    showCacheMissNotices: bool(settings.showCacheMissNotices),
    ...(trust && TRUST_LEVELS.has(trust) ? { defaultProjectTrust: trust } : {}),
    httpProxy: str(settings.httpProxy),
    enableSkillCommands: bool(settings.enableSkillCommands),
    compactionEnabled: bool(compaction.enabled),
    compactionReserveTokens: positiveInt(compaction.reserveTokens),
    compactionKeepRecentTokens: positiveInt(compaction.keepRecentTokens),
    retryEnabled: bool(retry.enabled),
    retryMaxRetries: positiveInt(retry.maxRetries),
    retryBaseDelayMs: positiveInt(retry.baseDelayMs)
  };
}

type FlatKey = keyof PiPreferences;

/** Nested target for each flat preference; delete removes the key so pi's default returns. */
const PREFERENCE_PATHS: Record<FlatKey, string[]> = {
  defaultThinkingLevel: ['defaultThinkingLevel'],
  transport: ['transport'],
  showCacheMissNotices: ['showCacheMissNotices'],
  defaultProjectTrust: ['defaultProjectTrust'],
  httpProxy: ['httpProxy'],
  enableSkillCommands: ['enableSkillCommands'],
  compactionEnabled: ['compaction', 'enabled'],
  compactionReserveTokens: ['compaction', 'reserveTokens'],
  compactionKeepRecentTokens: ['compaction', 'keepRecentTokens'],
  retryEnabled: ['retry', 'enabled'],
  retryMaxRetries: ['retry', 'maxRetries'],
  retryBaseDelayMs: ['retry', 'baseDelayMs']
};

/** Rejects a hand-edited or stale value at the boundary rather than writing something pi ignores. */
function normalizePreference(key: FlatKey, value: unknown): string | number | boolean {
  const reject = (): never => {
    throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
  };
  switch (key) {
    case 'defaultThinkingLevel':
      return typeof value === 'string' && THINKING_LEVELS.has(value) ? value : reject();
    case 'transport':
      return typeof value === 'string' && TRANSPORTS.has(value) ? value : reject();
    case 'defaultProjectTrust':
      return typeof value === 'string' && TRUST_LEVELS.has(value) ? value : reject();
    case 'httpProxy': {
      if (typeof value !== 'string' || value.length > 500) return reject();
      return value.trim();
    }
    case 'showCacheMissNotices':
    case 'enableSkillCommands':
    case 'compactionEnabled':
    case 'retryEnabled':
      return typeof value === 'boolean' ? value : reject();
    case 'compactionReserveTokens':
    case 'compactionKeepRecentTokens':
      return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 1_000_000 ? value : reject();
    case 'retryMaxRetries':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10 ? value : reject();
    case 'retryBaseDelayMs':
      return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 60_000 ? value : reject();
  }
}

function setNested(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const child = node[key];
    const next: Record<string, unknown> = child && typeof child === 'object' && !Array.isArray(child) ? { ...(child as Record<string, unknown>) } : {};
    node[key] = next;
    node = next;
  }
  node[keys[keys.length - 1]] = value;
}

function deleteNested(target: Record<string, unknown>, keys: string[]): void {
  const parents: Record<string, unknown>[] = [];
  let node: Record<string, unknown> | undefined = target;
  for (const key of keys.slice(0, -1)) {
    parents.push(node);
    node = object(node[key]);
  }
  if (!node) return;
  delete node[keys[keys.length - 1]];
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i];
    const key = keys[i];
    if (Object.keys(object(parent[key])).length === 0) delete parent[key];
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Same normalization pi applies before comparing an exact `+`/`-` pattern. */
function normalizePattern(pattern: string): string {
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

interface FoundResource {
  type: PiResourceType;
  name: string;
  description?: string;
  path: string;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
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

async function statFile(p: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Names and descriptions the way pi's config UI shows them for one resource file. */
async function describeFile(type: PiResourceType, file: string): Promise<FoundResource> {
  const base = path.basename(file);
  if (type === 'extensions') {
    const parent = path.basename(path.dirname(file));
    return { type, name: parent === 'extensions' ? base : `${parent}/${base}`, path: file };
  }
  if (type === 'skills') {
    let description: string | undefined;
    let name = path.basename(path.dirname(file));
    try {
      const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
      if (fm.name?.trim()) name = fm.name.trim();
      if (fm.description?.trim()) description = fm.description.trim();
    } catch {
      /* unreadable SKILL.md still lists, with the folder name */
    }
    return { type, name, description, path: file };
  }
  if (type === 'prompts') {
    let description: string | undefined;
    try {
      const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
      if (fm.description?.trim()) description = fm.description.trim();
    } catch {
      /* unreadable template still lists by filename */
    }
    return { type, name: base, description, path: file };
  }
  let name = base;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    const themeName = parsed && typeof parsed === 'object' ? str((parsed as Record<string, unknown>).name) : undefined;
    if (themeName) name = themeName;
  } catch {
    /* malformed themes are pi's to report; list by filename */
  }
  return { type, name, path: file };
}

async function discoverExtensions(dir: string): Promise<FoundResource[]> {
  const out: FoundResource[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.(m?[jt]s|cjs)$/.test(entry.name)) {
      out.push(await describeFile('extensions', full));
    } else if (entry.isDirectory()) {
      for (const index of ['index.ts', 'index.js', 'index.mjs', 'index.cjs']) {
        const file = path.join(full, index);
        if (await statFile(file)) {
          out.push(await describeFile('extensions', file));
          break;
        }
      }
    }
  }
  return out;
}

async function discoverSkills(dir: string): Promise<FoundResource[]> {
  const out: FoundResource[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.')) continue;
    // Symlinked skill folders are common (dotfile managers), so isSymbolicLink counts too.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!(await statFile(file))) continue;
    out.push(await describeFile('skills', file));
  }
  return out;
}

async function discoverPrompts(dir: string): Promise<FoundResource[]> {
  const out: FoundResource[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    out.push(await describeFile('prompts', path.join(dir, entry.name)));
  }
  return out;
}

async function discoverThemes(dir: string): Promise<FoundResource[]> {
  const out: FoundResource[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    out.push(await describeFile('themes', path.join(dir, entry.name)));
  }
  return out;
}

const DISCOVERERS: Record<PiResourceType, (dir: string) => Promise<FoundResource[]>> = {
  extensions: discoverExtensions,
  skills: discoverSkills,
  prompts: discoverPrompts,
  themes: discoverThemes
};

/** Also surfaces exact files a plain settings entry adds from outside the default dirs (no globs). */
async function configuredResources(type: PiResourceType, agentDir: string, settings: Record<string, unknown>, found: FoundResource[]): Promise<FoundResource[]> {
  const seen = new Set(found.map((r) => path.resolve(r.path)));
  for (const entry of stringArray(settings[type])) {
    if (/^[!+-]/.test(entry) || /[*?]/.test(entry)) continue;
    const target = path.resolve(agentDir, entry);
    if (seen.has(target)) continue;
    const stat = await statFile(target);
    if (!stat) continue;
    if (stat.isFile()) {
      found.push({ type, name: path.basename(target), path: target });
      seen.add(target);
    } else if (stat.isDirectory()) {
      for (const r of await DISCOVERERS[type](target)) {
        const abs = path.resolve(r.path);
        if (seen.has(abs)) continue;
        found.push(r);
        seen.add(abs);
      }
    }
  }
  return found;
}

async function readPromptFiles(agentDir: string): Promise<PiPromptFile[]> {
  return Promise.all(
    PI_PROMPT_NAMES.map(async (name): Promise<PiPromptFile> => {
      const file = path.join(agentDir, name);
      try {
        const buf = await fs.readFile(file);
        const truncated = buf.length > PROMPT_FILE_LIMIT;
        return { name, path: file, exists: true, content: buf.subarray(0, PROMPT_FILE_LIMIT).toString('utf8'), ...(truncated ? { truncated: true } : {}) };
      } catch {
        return { name, path: file, exists: false, content: '' };
      }
    })
  );
}

// ---------------------------------------------------------------------------------------------
// Packages

const PACKAGE_WALK_SKIP = new Set(['node_modules', '.git']);
const PACKAGE_WALK_LIMIT = 5000;

/** Bounded recursive file listing for manifest globs; package trees with a node_modules are deep. */
async function walkPackageFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length && out.length < PACKAGE_WALK_LIMIT) {
    const { dir, depth } = queue.shift()!;
    if (depth > 8) continue;
    for (const entry of await readdirSafe(dir)) {
      if (entry.name.startsWith('.') || PACKAGE_WALK_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
      else if (entry.isFile()) out.push(full);
      if (out.length >= PACKAGE_WALK_LIMIT) break;
    }
  }
  return out;
}

/** Resolves one non-override manifest entry: a file, a directory of resources, or a glob. */
async function expandPackageEntry(entry: string, pkgRoot: string, type: PiResourceType): Promise<string[]> {
  if (/[*?]/.test(entry)) {
    const pattern = normalizePattern(entry);
    return (await walkPackageFiles(pkgRoot)).filter((f) => matchPiGlob(pattern, toPosix(path.relative(pkgRoot, f))));
  }
  const target = path.resolve(pkgRoot, entry);
  const stat = await statFile(target);
  if (!stat) return [];
  if (stat.isFile()) return [target];
  return (await DISCOVERERS[type](target)).map((r) => r.path);
}

/** The package.json `pi` manifest, or null when it is absent or malformed. */
async function readPiManifest(pkgRoot: string): Promise<Record<string, unknown> | null> {
  const pkg = await readPackageJson(pkgRoot);
  const pi = pkg?.pi;
  return pi && typeof pi === 'object' && !Array.isArray(pi) ? (pi as Record<string, unknown>) : null;
}

async function readPackageJson(pkgRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(pkgRoot, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every file of one resource type a package provides, with the manifest's own filters applied. */
async function packageFilesForType(pkgRoot: string, type: PiResourceType, manifest: Record<string, unknown> | null): Promise<FoundResource[]> {
  const entries = stringArray(manifest?.[type]);
  if (entries.length) {
    const files: string[] = [];
    for (const entry of entries) {
      if (/^[!+-]/.test(entry)) continue;
      files.push(...(await expandPackageEntry(entry, pkgRoot, type)));
    }
    const unique = [...new Set(files.map((f) => path.resolve(f)))];
    const overrides = entries.filter((e) => /^[!+-]/.test(e));
    const enabled = applyPatternsToFiles(unique, overrides, pkgRoot);
    return Promise.all(unique.filter((f) => enabled.has(f)).map((f) => describeFile(type, f)));
  }
  return DISCOVERERS[type](path.join(pkgRoot, type));
}

/** Every package declared in global settings.json.packages, with its resources and filter state. */
async function readPackages(agentDir: string, settings: Record<string, unknown>, home: string): Promise<PiPackageItem[]> {
  const raw = Array.isArray(settings.packages) ? settings.packages : [];
  const out: PiPackageItem[] = [];
  for (const entry of raw) {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const source = typeof entry === 'string' ? entry : typeof record?.source === 'string' ? record.source : '';
    if (!source.trim()) continue;
    const loc = packageLocation(source, agentDir, home);
    const autoload = record?.autoload !== false;
    const item: PiPackageItem = { source, kind: loc.kind, path: loc.path, installed: false, autoload, resources: [] };
    const stat = await statFile(loc.path);
    if (!stat?.isDirectory()) {
      item.error = 'Not installed yet — use Update to fetch it.';
      out.push(item);
      continue;
    }
    item.installed = true;
    try {
      const manifest = await readPiManifest(loc.path);
      const pkgName = str((await readPackageJson(loc.path))?.name);
      if (pkgName) item.name = pkgName;
      for (const type of PI_RESOURCE_TYPES) {
        const patterns = record && Array.isArray(record[type]) ? stringArray(record[type]) : undefined;
        for (const f of await packageFilesForType(loc.path, type, manifest)) {
          item.resources.push({
            type,
            name: f.name,
            ...(f.description ? { description: f.description } : {}),
            path: f.path,
            enabled: packageResourceEnabled(f.path, patterns, loc.path, autoload),
            forced: patterns !== undefined
          });
        }
      }
      item.resources.sort((a, b) => PI_RESOURCE_TYPES.indexOf(a.type) - PI_RESOURCE_TYPES.indexOf(b.type) || a.name.localeCompare(b.name));
    } catch (e) {
      item.error = errorMessage(e);
    }
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// pi-subagents (agents on disk + global subagents.json)

async function listPiAgents(agentDir: string): Promise<PiAgentInfo[]> {
  const out: PiAgentInfo[] = [];
  for (const entry of await readdirSafe(path.join(agentDir, 'agents'))) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(agentDir, 'agents', entry.name);
    let name = entry.name.replace(/\.md$/i, '');
    let description: string | undefined;
    let model: string | undefined;
    try {
      const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
      if (fm.name?.trim()) name = fm.name.trim();
      if (fm.description?.trim()) description = fm.description.trim();
      if (fm.model?.trim()) model = fm.model.trim();
    } catch {
      /* unreadable agent still lists by filename */
    }
    out.push({ name, ...(description ? { description } : {}), ...(model ? { model } : {}), path: file });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Bounds mirror pi-subagents' own sanitize() so a stale value cannot survive here either. */
const SUBAGENT_LIMITS: Partial<Record<keyof PiSubagentsSettings, [number, number]>> = {
  maxConcurrent: [1, 1024],
  maxConcurrentForeground: [0, 1024],
  defaultMaxTurns: [0, 10_000],
  maxSubagentDepth: [0, 16]
};
const SUBAGENT_BOOL_KEYS: (keyof PiSubagentsSettings)[] = ['reportUsage', 'showCost', 'showModel', 'backgroundByDefault', 'worktreeIsolation', 'rememberAgents', 'strictAgentFiles', 'disableDefaultAgents'];
const SUBAGENT_KEYS = new Set<string>([...SUBAGENT_BOOL_KEYS, ...Object.keys(SUBAGENT_LIMITS), 'fallbackSubagent']);

/** Rejects a patch value pi-subagents would silently drop, rather than writing it. */
function normalizeSubagentValue(key: string, value: unknown): boolean | number | string {
  if (SUBAGENT_BOOL_KEYS.includes(key as keyof PiSubagentsSettings)) {
    if (typeof value !== 'boolean') throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
    return value;
  }
  const limits = SUBAGENT_LIMITS[key as keyof PiSubagentsSettings];
  if (limits) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < limits[0] || value > limits[1]) throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
    return value;
  }
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new Error(`Invalid value for ${key}: ${JSON.stringify(value)}`);
  return value.trim();
}

/** Keeps only well-formed curated keys, the way pi-subagents' own sanitize() does. */
function sanitizeSubagents(raw: unknown): PiSubagentsSettings {
  const r = object(raw);
  const out: Record<string, unknown> = {};
  for (const key of SUBAGENT_BOOL_KEYS) if (typeof r[key] === 'boolean') out[key] = r[key];
  for (const [key, [min, max]] of Object.entries(SUBAGENT_LIMITS) as [string, [number, number]][]) {
    const v = r[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) out[key] = v;
  }
  const fallback = str(r.fallbackSubagent);
  if (fallback) out.fallbackSubagent = fallback;
  return out as PiSubagentsSettings;
}

// ---------------------------------------------------------------------------------------------
// The pi CLI runner

export type PiRunner = (args: string[]) => Promise<PiCommandResult>;

/** One package source, rejected at the boundary: it becomes an argv entry, never a shell word. */
function validPackageSource(source: unknown): string {
  if (typeof source !== 'string') throw new Error('Package source must be a string');
  const s = source.trim();
  if (!s || s.length > 500 || /[\0\r\n]/.test(s) || s.startsWith('-')) throw new Error('Invalid package source');
  return s;
}

/**
 * Runs `pi <args>` with piped stdio, capturing a capped combined log. The child is killed on the
 * timeout; callers get the log either way so a failed install can be shown verbatim.
 */
export async function runPiCommand(args: string[], opts: { piPath: string; cwd: string; log: Logger; timeoutMs?: number }): Promise<PiCommandResult> {
  const timeoutMs = opts.timeoutMs ?? PI_COMMAND_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const append = (chunk: Buffer): void => {
      if (out.length < PI_COMMAND_LOG_LIMIT) out += chunk.toString('utf8');
    };
    const finish = (result: PiCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: import('node:child_process').ChildProcess;
    try {
      child = spawnTool(opts.piPath, args, { cwd: opts.cwd, env: process.env, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: null, log: '', error: errorMessage(e) });
      return;
    }
    const timer = setTimeout(() => {
      void killTree(child);
      finish({ ok: false, code: null, log: out, error: `pi ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => finish({ ok: false, code: null, log: out, error: errorMessage(e) }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, code, log: out } : { ok: false, code, log: out, error: `pi exited with code ${code ?? 'unknown'}` }));
  });
}

export class PiConfigStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string | undefined;
  private readonly log: Logger;
  private readonly runPiRunner: PiRunner | undefined;
  private readonly piBinary: (() => string | null) | undefined;

  constructor(opts: PiConfigOptions = {}) {
    this.env = opts.env ?? process.env;
    this.home = opts.home;
    this.log = opts.log ?? (() => undefined);
    this.runPiRunner = opts.runPi;
    this.piBinary = opts.piBinary;
  }

  paths(): PiPaths {
    return piPaths(this.env, this.home);
  }

  private async readSubagents(agentDir: string): Promise<{ subagents: PiSubagentsSettings; subagentsError?: string }> {
    const { settings, error } = await readSettingsFile(path.join(agentDir, 'subagents.json'));
    if (error) return { subagents: {}, subagentsError: error };
    return { subagents: sanitizeSubagents(settings) };
  }

  /** Everything the Settings → Pi page renders; never throws for a malformed file, it reports. */
  async read(): Promise<PiSetup> {
    const { agentDir, settingsPath } = this.paths();
    const { settings, error } = await readSettingsFile(settingsPath);
    const discovered: FoundResource[] = [];
    for (const type of PI_RESOURCE_TYPES) discovered.push(...(await DISCOVERERS[type](path.join(agentDir, type))));
    for (const type of PI_RESOURCE_TYPES) await configuredResources(type, agentDir, settings, discovered);
    const resources: PiResourceItem[] = discovered
      .map((r) => {
        const { enabled, forced } = piResourceEnabled(r.type, r.path, agentDir, settings);
        return { type: r.type, name: r.name, ...(r.description ? { description: r.description } : {}), path: r.path, enabled, forced };
      })
      .sort((a, b) => PI_RESOURCE_TYPES.indexOf(a.type) - PI_RESOURCE_TYPES.indexOf(b.type) || a.name.localeCompare(b.name));
    return {
      agentDir,
      settingsPath,
      ...(error ? { settingsError: error } : {}),
      preferences: readPreferences(settings),
      resources,
      promptFiles: await readPromptFiles(agentDir),
      piAvailable: !!this.piBinary?.(),
      packages: await readPackages(agentDir, settings, this.home ?? homeDirFor(this.env)),
      agents: await listPiAgents(agentDir),
      ...(await this.readSubagents(agentDir))
    };
  }

  private async requireSettings(): Promise<{ agentDir: string; settingsPath: string; settings: Record<string, unknown> }> {
    const { agentDir, settingsPath } = this.paths();
    const { settings, error } = await readSettingsFile(settingsPath);
    if (error) throw new Error(`${error} — fix it in an editor before changing pi settings here.`);
    return { agentDir, settingsPath, settings };
  }

  /** Merges a curated preference patch into settings.json, preserving every other key. */
  async updatePreferences(patch: PiPreferencesPatch): Promise<PiSetup> {
    const { settingsPath, settings } = await this.requireSettings();
    const next: Record<string, unknown> = { ...settings };
    const changed: string[] = [];
    for (const key of Object.keys(patch) as FlatKey[]) {
      if (!Object.prototype.hasOwnProperty.call(PREFERENCE_PATHS, key)) continue;
      const value = patch[key];
      if (value === null || value === undefined || value === '') {
        deleteNested(next, PREFERENCE_PATHS[key]);
      } else {
        setNested(next, PREFERENCE_PATHS[key], normalizePreference(key, value));
      }
      changed.push(key);
    }
    if (changed.length) {
      await writeJson(settingsPath, next);
      this.log('info', `pi settings updated: ${changed.join(', ')}`);
    }
    return this.read();
  }

  /**
   * Enables/disables one discovered resource with pi's own `+`/`-` pattern. The absolute path must
   * be a resource this agent dir actually exposes, so a tampered renderer cannot write outside it.
   */
  async setResourceEnabled(type: PiResourceType, absPath: string, enabled: boolean): Promise<PiSetup> {
    if (!PI_RESOURCE_TYPES.includes(type)) throw new Error(`Unknown pi resource type: ${type}`);
    const { agentDir, settingsPath, settings } = await this.requireSettings();
    const setup = await this.read();
    const item = setup.resources.find((r) => r.type === type && path.resolve(r.path) === path.resolve(absPath));
    if (!item) throw new Error('Not a resource in the pi agent dir');
    const pattern = toPosix(path.relative(agentDir, item.path));
    const entry = `${enabled ? '+' : '-'}${pattern}`;
    const current = stringArray(settings[type]);
    const updated = current.filter((p) => normalizePattern(/^[!+-]/.test(p) ? p.slice(1) : p) !== pattern);
    updated.push(entry);
    await writeJson(settingsPath, { ...settings, [type]: updated });
    this.log('info', `pi ${type} resource ${enabled ? 'enabled' : 'disabled'}: ${pattern}`);
    return this.read();
  }

  /**
   * Writes one of the three global prompt files; empty content deletes it so the user can restore
   * pi's built-in instruction stack from the same editor.
   */
  async writePrompt(name: PiPromptName, content: string): Promise<PiSetup> {
    if (!PI_PROMPT_NAMES.includes(name)) throw new Error(`Unknown prompt file: ${name}`);
    if (content.length > PROMPT_FILE_LIMIT) throw new Error(`Prompt file is limited to ${Math.round(PROMPT_FILE_LIMIT / 1024)} KB`);
    const { agentDir } = this.paths();
    const file = path.join(agentDir, name);
    if (!content.trim()) {
      await fs.rm(file, { force: true });
      this.log('info', `pi prompt file removed: ${name}`);
    } else {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(file, content, 'utf8');
      this.log('info', `pi prompt file saved: ${name}`);
    }
    return this.read();
  }

  /**
   * Enables/disables one resource of an installed package, writing the same `+`/`-` filter pi's own
   * `pi config` writes into the package object. The path must belong to a resource this store read.
   */
  async setPackageResourceEnabled(source: string, type: PiResourceType, absPath: string, enabled: boolean): Promise<PiSetup> {
    if (!PI_RESOURCE_TYPES.includes(type)) throw new Error(`Unknown pi resource type: ${type}`);
    const { settingsPath, settings } = await this.requireSettings();
    const setup = await this.read();
    const pkg = setup.packages.find((p) => p.source === source);
    const item = pkg?.resources.find((r) => r.type === type && path.resolve(r.path) === path.resolve(absPath));
    if (!pkg || !item || !pkg.installed) throw new Error('Not a resource of an installed pi package');
    const pattern = toPosix(path.relative(pkg.path, item.path));
    const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
    const idx = packages.findIndex((p) => (typeof p === 'string' ? p : str(object(p).source) ?? '') === source);
    if (idx < 0) throw new Error('Package is no longer listed in settings.json');
    const raw = packages[idx];
    const entry: Record<string, unknown> = typeof raw === 'string' ? { source: raw } : { ...(raw as Record<string, unknown>) };
    const current = stringArray(entry[type]);
    const updated = current.filter((p) => normalizePattern(/^[!+-]/.test(p) ? p.slice(1) : p) !== pattern);
    updated.push(`${enabled ? '+' : '-'}${pattern}`);
    entry[type] = updated;
    packages[idx] = entry;
    await writeJson(settingsPath, { ...settings, packages });
    this.log('info', `pi package resource ${enabled ? 'enabled' : 'disabled'}: ${source} ${pattern}`);
    return this.read();
  }

  /** Merges a curated pi-subagents settings patch into the global subagents.json. */
  async updateSubagents(patch: PiSubagentsPatch): Promise<PiSetup> {
    const { agentDir } = this.paths();
    const file = path.join(agentDir, 'subagents.json');
    const { settings, error } = await readSettingsFile(file);
    if (error) throw new Error(`${error} — fix it in an editor before changing subagent settings here.`);
    const next: Record<string, unknown> = { ...settings };
    const changed: string[] = [];
    for (const key of Object.keys(patch)) {
      if (!SUBAGENT_KEYS.has(key)) continue;
      const value = patch[key as keyof PiSubagentsPatch];
      if (value === null || value === undefined || value === '') {
        delete next[key];
      } else {
        next[key] = normalizeSubagentValue(key, value);
      }
      changed.push(key);
    }
    if (changed.length) {
      await fs.mkdir(agentDir, { recursive: true });
      await writeJson(file, next);
      this.log('info', `pi subagent settings updated: ${changed.join(', ')}`);
    }
    return this.read();
  }

  /** Installs a package through the user's pi binary; pi owns cloning, npm and settings writes. */
  async installPackage(source: string): Promise<PiCommandResult> {
    return this.runPiCli(['install', validPackageSource(source)]);
  }

  async removePackage(source: string): Promise<PiCommandResult> {
    return this.runPiCli(['remove', validPackageSource(source)]);
  }

  /** No source updates every package; a source updates just that one. */
  async updatePackages(source?: string): Promise<PiCommandResult> {
    return source ? this.runPiCli(['update', validPackageSource(source)]) : this.runPiCli(['update', '--extensions']);
  }

  private async runPiCli(args: string[]): Promise<PiCommandResult> {
    if (!this.runPiRunner) return { ok: false, code: null, log: '', error: 'pi is not installed — install it from Settings → Harnesses first.' };
    return this.runPiRunner(args);
  }

  /** Path inside the agent dir, or null. Guards the editor/reveal channels against arbitrary paths. */
  resolveAgentPath(p: string): string | null {
    const { agentDir } = this.paths();
    const resolved = path.resolve(p);
    return resolved === path.resolve(agentDir) || isSubPath(agentDir, resolved) ? resolved : null;
  }
}
