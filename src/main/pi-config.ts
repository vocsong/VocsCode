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
 * Reads and complete mutations are serialized per agent dir within this process, including package
 * commands launched here. JSON writes use the atomic writer. This does not coordinate with external
 * pi processes' proper-lockfile locks: an external save between our read and rename can still be
 * lost. Nothing is written on page load.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  PiCommandResult,
  PiPreferencesPatch,
  PiPromptName,
  PiResourceItem,
  PiResourceType,
  PiSetup,
  PiSubagentsPatch,
  PiSubagentsSettings
} from '../shared/types';
import { piAgentDir } from './pi-agents';
import { spawnTool, killTree } from './harness/spawn';
import { errorMessage } from './util/async';
import { isSubPath, writeJson } from './util/fs';
import type { Logger } from './log';
import {
  configuredResources,
  DISCOVERERS,
  listPiAgents,
  PI_PROMPT_NAMES,
  PI_RESOURCE_TYPES,
  PROMPT_FILE_LIMIT,
  readPackages,
  readPromptFiles,
  readSettingsFile,
  type FoundResource
} from './pi/discovery';
import {
  applyPatternsToFiles,
  matchPiGlob,
  normalizePattern,
  packageLocation,
  packageResourceEnabled,
  piResourceEnabled,
  stringArray,
  toPosix
} from './pi/patterns';
import {
  deleteNested,
  normalizePreference,
  normalizeSubagentValue,
  object,
  PREFERENCE_PATHS,
  readPreferences,
  sanitizeSubagents,
  setNested,
  str,
  SUBAGENT_KEYS,
  type FlatKey
} from './pi/preferences';

export {
  applyPatternsToFiles,
  matchPiGlob,
  packageLocation,
  packageResourceEnabled,
  PI_PROMPT_NAMES,
  PI_RESOURCE_TYPES,
  piResourceEnabled
};

/** Package installs can take a while (git clone + npm install); the handler waits, then kills. */
const PI_COMMAND_TIMEOUT_MS = 300_000;
const PI_COMMAND_LOG_LIMIT = 64 * 1024;

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

export type PiRunner = (args: string[]) => Promise<PiCommandResult>;

/** One package source, rejected at the boundary: it becomes an argv entry, never a shell word. */
function validPackageSource(source: unknown): string {
  if (typeof source !== 'string') throw new Error('Package source must be a string');
  const s = source.trim();
  if (!s || s.length > 500 || /[\0\r\n]/.test(s) || s.startsWith('-')) throw new Error('Invalid package source');
  return s;
}

/**
 * Runs `pi <args>` with piped stdio, capturing a capped combined log. On timeout it awaits the
 * shared best-effort tree teardown before releasing its caller; failed installs keep their log.
 */
export async function runPiCommand(args: string[], opts: { piPath: string; cwd: string; log: Logger; timeoutMs?: number }): Promise<PiCommandResult> {
  const timeoutMs = opts.timeoutMs ?? PI_COMMAND_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let stopping = false;
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
      stopping = true;
      const error = `pi ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`;
      // A close/error can arrive while Windows taskkill is still stopping descendants. It must
      // not release the directory queue early or turn a timed-out command into a success.
      void killTree(child).then(
        () => finish({ ok: false, code: null, log: out, error }),
        (e) => finish({ ok: false, code: null, log: out, error: `${error}; cleanup failed: ${errorMessage(e)}` })
      );
    }, timeoutMs);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => { if (!stopping) finish({ ok: false, code: null, log: out, error: errorMessage(e) }); });
    child.on('close', (code) => { if (!stopping) finish(code === 0 ? { ok: true, code, log: out } : { ok: false, code, log: out, error: `pi exited with code ${code ?? 'unknown'}` }); });
  });
}

/** A PiSetup spans settings, subagents and prompt files, so its reads share the mutation queue.
 * Shared across store instances, but never across processes or distinct agent directories. */
const configOperations = new Map<string, Promise<unknown>>();

async function withPiConfig<T>(agentDir: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(agentDir);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const run = (configOperations.get(key) ?? Promise.resolve()).then(operation, operation);
  configOperations.set(key, run);
  try {
    return await run;
  } finally {
    if (configOperations.get(key) === run) configOperations.delete(key);
  }
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

  /** Everything the Settings → Pi page renders, ordered after earlier mutations; malformed files report. */
  async read(): Promise<PiSetup> {
    return withPiConfig(this.paths().agentDir, () => this.readSnapshot());
  }

  /** Only inside withPiConfig: internal reads must not re-enter the queue they already hold. */
  private async readSnapshot(): Promise<PiSetup> {
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
    return withPiConfig(this.paths().agentDir, async () => {
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
      return this.readSnapshot();
    });
  }

  /**
   * Enables/disables one discovered resource with pi's own `+`/`-` pattern. The absolute path must
   * be a resource this agent dir actually exposes, so a tampered renderer cannot write outside it.
   */
  async setResourceEnabled(type: PiResourceType, absPath: string, enabled: boolean): Promise<PiSetup> {
    return withPiConfig(this.paths().agentDir, async () => {
      if (!PI_RESOURCE_TYPES.includes(type)) throw new Error(`Unknown pi resource type: ${type}`);
      const { agentDir, settingsPath, settings } = await this.requireSettings();
      const setup = await this.readSnapshot();
      const item = setup.resources.find((r) => r.type === type && path.resolve(r.path) === path.resolve(absPath));
      if (!item) throw new Error('Not a resource in the pi agent dir');
      const pattern = toPosix(path.relative(agentDir, item.path));
      const entry = `${enabled ? '+' : '-'}${pattern}`;
      const current = stringArray(settings[type]);
      const updated = current.filter((p) => normalizePattern(/^[!+-]/.test(p) ? p.slice(1) : p) !== pattern);
      updated.push(entry);
      await writeJson(settingsPath, { ...settings, [type]: updated });
      this.log('info', `pi ${type} resource ${enabled ? 'enabled' : 'disabled'}: ${pattern}`);
      return this.readSnapshot();
    });
  }

  /**
   * Writes one of the three global prompt files; empty content deletes it so the user can restore
   * pi's built-in instruction stack from the same editor.
   */
  async writePrompt(name: PiPromptName, content: string): Promise<PiSetup> {
    const { agentDir } = this.paths();
    return withPiConfig(agentDir, async () => {
      if (!PI_PROMPT_NAMES.includes(name)) throw new Error(`Unknown prompt file: ${name}`);
      if (Buffer.byteLength(content, 'utf8') > PROMPT_FILE_LIMIT) throw new Error(`Prompt file is limited to ${Math.round(PROMPT_FILE_LIMIT / 1024)} KB`);
      const file = path.join(agentDir, name);
      if (!content.trim()) {
        await fs.rm(file, { force: true });
        this.log('info', `pi prompt file removed: ${name}`);
      } else {
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(file, content, 'utf8');
        this.log('info', `pi prompt file saved: ${name}`);
      }
      return this.readSnapshot();
    });
  }

  /**
   * Enables/disables one resource of an installed package, writing the same `+`/`-` filter pi's own
   * `pi config` writes into the package object. The path must belong to a resource this store read.
   */
  async setPackageResourceEnabled(source: string, type: PiResourceType, absPath: string, enabled: boolean): Promise<PiSetup> {
    return withPiConfig(this.paths().agentDir, async () => {
      if (!PI_RESOURCE_TYPES.includes(type)) throw new Error(`Unknown pi resource type: ${type}`);
      const { settingsPath, settings } = await this.requireSettings();
      const setup = await this.readSnapshot();
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
      return this.readSnapshot();
    });
  }

  /** Merges a curated pi-subagents settings patch into the global subagents.json. */
  async updateSubagents(patch: PiSubagentsPatch): Promise<PiSetup> {
    const { agentDir } = this.paths();
    return withPiConfig(agentDir, async () => {
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
      return this.readSnapshot();
    });
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
    return withPiConfig(this.paths().agentDir, async () => {
      if (!this.runPiRunner) return { ok: false, code: null, log: '', error: 'pi is not installed — install it from Settings → Harnesses first.' };
      return this.runPiRunner(args);
    });
  }

  /** Path inside the agent dir, or null. Guards the editor/reveal channels against arbitrary paths. */
  resolveAgentPath(p: string): string | null {
    const { agentDir } = this.paths();
    const resolved = path.resolve(p);
    return resolved === path.resolve(agentDir) || isSubPath(agentDir, resolved) ? resolved : null;
  }
}
