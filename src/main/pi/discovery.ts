/** Filesystem discovery of Pi resources, packages, global prompt files, agents, and settings JSON. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { PiAgentInfo, PiPackageItem, PiPromptFile, PiPromptName, PiResourceType } from '../../shared/types';
import { parseFrontmatter } from '../skills';
import { errorMessage } from '../util/async';
import { applyPatternsToFiles, matchPiGlob, normalizePattern, packageLocation, packageResourceEnabled, stringArray, toPosix } from './patterns';
import { str } from './preferences';

export const PI_RESOURCE_TYPES: PiResourceType[] = ['extensions', 'skills', 'prompts', 'themes'];
export const PI_PROMPT_NAMES: PiPromptName[] = ['SYSTEM.md', 'APPEND_SYSTEM.md', 'AGENTS.md'];

/** UTF-8 byte budget for global prompt files; also bounds the IPC payload. */
export const PROMPT_FILE_LIMIT = 512 * 1024;

const PACKAGE_WALK_SKIP = new Set(['node_modules', '.git']);
const PACKAGE_WALK_LIMIT = 5000;

export interface FoundResource {
  type: PiResourceType;
  name: string;
  description?: string;
  path: string;
}

export interface SettingsRead {
  settings: Record<string, unknown>;
  error?: string;
}

/**
 * Reads settings.json without the quarantining readJson helper: a malformed pi settings file must
 * be surfaced to the user and left alone, not copied to a `.corrupt-*` artifact pi never wrote.
 */
export async function readSettingsFile(settingsPath: string): Promise<SettingsRead> {
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

export const DISCOVERERS: Record<PiResourceType, (dir: string) => Promise<FoundResource[]>> = {
  extensions: discoverExtensions,
  skills: discoverSkills,
  prompts: discoverPrompts,
  themes: discoverThemes
};

/** Also surfaces exact files a plain settings entry adds from outside the default dirs (no globs). */
export async function configuredResources(type: PiResourceType, agentDir: string, settings: Record<string, unknown>, found: FoundResource[]): Promise<FoundResource[]> {
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

export async function readPromptFiles(agentDir: string): Promise<PiPromptFile[]> {
  return Promise.all(
    PI_PROMPT_NAMES.map(async (name): Promise<PiPromptFile> => {
      const file = path.join(agentDir, name);
      try {
        const buf = await fs.readFile(file);
        const truncated = buf.length > PROMPT_FILE_LIMIT;
        // Do not flush a partial UTF-8 sequence at the byte boundary as a replacement character.
        const content = truncated ? new StringDecoder('utf8').write(buf.subarray(0, PROMPT_FILE_LIMIT)) : buf.toString('utf8');
        return { name, path: file, exists: true, content, ...(truncated ? { truncated: true } : {}) };
      } catch {
        return { name, path: file, exists: false, content: '' };
      }
    })
  );
}

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

async function readPackageJson(pkgRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(pkgRoot, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The package.json `pi` manifest, or null when it is absent or malformed. */
async function readPiManifest(pkgRoot: string): Promise<Record<string, unknown> | null> {
  const pkg = await readPackageJson(pkgRoot);
  const pi = pkg?.pi;
  return pi && typeof pi === 'object' && !Array.isArray(pi) ? (pi as Record<string, unknown>) : null;
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
export async function readPackages(agentDir: string, settings: Record<string, unknown>, home: string): Promise<PiPackageItem[]> {
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

export async function listPiAgents(agentDir: string): Promise<PiAgentInfo[]> {
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
