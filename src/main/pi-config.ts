/**
 * Base-pi global configuration behind Settings → Pi. No Electron imports.
 *
 * Only pi's own resources are managed here: extensions, skills, prompt templates and themes in the
 * global agent dir, plus the global settings.json keys that affect Vocs-spawned sessions.
 * Third-party packages and pi-subagents agent files are deliberately out of scope.
 *
 * pi's own selector enables/disables a standalone resource by writing `+<relative>` / `-<relative>`
 * into the matching settings array (see pi's config-selector and package-manager `applyPatterns`):
 * `!pattern` excludes with globs, `-path` force-excludes, `+path` force-includes. We write the same
 * patterns so both UIs agree, and compute enabled state with pi's precedence: exclusions first,
 * then force-includes, then force-excludes.
 *
 * Writes are read-merge-write through the atomic JSON writer. pi's TUI takes a proper-lockfile lock
 * when it saves settings; a save landing between our read and rename could be lost, so the window
 * is one read/write pair and nothing is written on page load.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PiPreferences, PiPreferencesPatch, PiPromptFile, PiPromptName, PiResourceItem, PiResourceType, PiSetup } from '../shared/types';
import { piAgentDir } from './pi-agents';
import { parseFrontmatter } from './skills';
import { errorMessage } from './util/async';
import { isSubPath, writeJson } from './util/fs';
import type { Logger } from './log';

export const PI_RESOURCE_TYPES: PiResourceType[] = ['extensions', 'skills', 'prompts', 'themes'];
export const PI_PROMPT_NAMES: PiPromptName[] = ['AGENTS.md', 'APPEND_SYSTEM.md', 'SYSTEM.md'];

/** pi refuses to load a prompt file larger than this anyway; the cap also bounds the IPC payload. */
const PROMPT_FILE_LIMIT = 512 * 1024;

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
}

/** Resolves pi's global agent dir the way pi itself does (env override, then home). */
export function piPaths(env: NodeJS.ProcessEnv = process.env, home?: string): PiPaths {
  const agentDir = path.resolve(piAgentDir(env, home));
  return { agentDir, settingsPath: path.join(agentDir, 'settings.json') };
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

/**
 * Whether pi would load `filePath`, mirroring package-manager's `isEnabledByOverrides`: plain
 * settings entries do not filter auto-discovered resources — only `!` excludes by glob, then `+`
 * force-includes by exact path, then `-` force-excludes. Skill patterns may name the SKILL.md or
 * its containing folder, as pi allows.
 */
export function piResourceEnabled(type: PiResourceType, filePath: string, agentDir: string, settings: Record<string, unknown>): { enabled: boolean; forced: boolean } {
  const entries = stringArray(settings[type]);
  const rel = toPosix(path.relative(agentDir, filePath));
  const abs = toPosix(path.resolve(filePath));
  const isSkill = type === 'skills';
  const targets = isSkill
    ? [rel, abs, toPosix(path.relative(agentDir, path.dirname(filePath))), toPosix(path.dirname(path.resolve(filePath)))]
    : [rel, abs];
  const excludes = entries.filter((e) => e.startsWith('!')).map((e) => normalizePattern(e.slice(1)));
  const forceIncludes = entries.filter((e) => e.startsWith('+')).map((e) => normalizePattern(e.slice(1)));
  const forceExcludes = entries.filter((e) => e.startsWith('-')).map((e) => normalizePattern(e.slice(1)));
  const excluded = excludes.some((p) => targets.some((t) => matchPiGlob(p, t)));
  const forcedIn = forceIncludes.some((p) => targets.includes(p));
  const forcedOut = forceExcludes.some((p) => targets.includes(p));
  let enabled = true;
  if (excluded) enabled = false;
  if (forcedIn) enabled = true;
  if (forcedOut) enabled = false;
  return { enabled, forced: excluded || forcedIn || forcedOut };
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

async function discoverExtensions(dir: string): Promise<FoundResource[]> {
  const out: FoundResource[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.(m?[jt]s|cjs)$/.test(entry.name)) {
      out.push({ type: 'extensions', name: entry.name, path: full });
    } else if (entry.isDirectory()) {
      for (const index of ['index.ts', 'index.js', 'index.mjs', 'index.cjs']) {
        const file = path.join(full, index);
        if (await statFile(file)) {
          out.push({ type: 'extensions', name: `${entry.name}/${index}`, path: file });
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
    const folder = path.join(dir, entry.name);
    const file = path.join(folder, 'SKILL.md');
    if (!(await statFile(file))) continue;
    let description: string | undefined;
    let name = entry.name;
    try {
      const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
      if (fm.name?.trim()) name = fm.name.trim();
      if (fm.description?.trim()) description = fm.description.trim();
    } catch {
      /* unreadable SKILL.md still lists, with the folder name */
    }
    out.push({ type: 'skills', name, description, path: file });
  }
  return out;
}

async function discoverPrompts(dir: string): Promise<FoundResource[]> {
  const out: FoundResource[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(dir, entry.name);
    let description: string | undefined;
    try {
      const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
      if (fm.description?.trim()) description = fm.description.trim();
    } catch {
      /* unreadable template still lists by filename */
    }
    out.push({ type: 'prompts', name: entry.name, description, path: file });
  }
  return out;
}

async function discoverThemes(dir: string): Promise<FoundResource[]> {
  const out: FoundResource[] = [];
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    let name = entry.name;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      const themeName = parsed && typeof parsed === 'object' ? str((parsed as Record<string, unknown>).name) : undefined;
      if (themeName) name = themeName;
    } catch {
      /* malformed themes are pi's to report; list by filename */
    }
    out.push({ type: 'themes', name, path: file });
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

export class PiConfigStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string | undefined;
  private readonly log: Logger;

  constructor(opts: PiConfigOptions = {}) {
    this.env = opts.env ?? process.env;
    this.home = opts.home;
    this.log = opts.log ?? (() => undefined);
  }

  paths(): PiPaths {
    return piPaths(this.env, this.home);
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
      promptFiles: await readPromptFiles(agentDir)
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

  /** Path inside the agent dir, or null. Guards the editor/reveal channels against arbitrary paths. */
  resolveAgentPath(p: string): string | null {
    const { agentDir } = this.paths();
    const resolved = path.resolve(p);
    return resolved === path.resolve(agentDir) || isSubPath(agentDir, resolved) ? resolved : null;
  }
}
