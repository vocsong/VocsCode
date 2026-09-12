/** Harness skill discovery and management. A skill is a folder with a SKILL.md (name/description frontmatter). No Electron imports. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillHarness, SkillInfo, SkillRootInfo } from '../shared/types';
import { errorMessage } from './util/async';
import { ensureDir, exists, rmrf } from './util/fs';

/** Harnesses that load a global skills directory, in harness-meta display order. */
const SKILL_HARNESSES: { harness: SkillHarness; label: string }[] = [
  { harness: 'claude', label: 'Claude Agent SDK' },
  { harness: 'codex', label: 'Codex' },
  { harness: 'pi', label: 'Pi' }
];

export interface SkillRootSpec {
  harness: SkillHarness;
  label: string;
  path: string;
}

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** A harness's global skills directory, mirroring where each harness looks at startup. */
export function skillRoot(harness: SkillHarness, home = homeDir()): string {
  if (harness === 'claude') {
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
    return path.join(expandTilde(configDir, home), 'skills');
  }
  if (harness === 'pi') {
    const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
    return path.join(envDir ? expandTilde(envDir, home) : path.join(home, '.pi', 'agent'), 'skills');
  }
  return path.join(home, '.codex', 'skills');
}

/** The roots of every harness that loads global skills. */
export function skillRoots(home = homeDir()): SkillRootSpec[] {
  return SKILL_HARNESSES.map((h) => ({ harness: h.harness, label: h.label, path: skillRoot(h.harness, home) }));
}

/**
 * Parses the simple `key: value` YAML frontmatter of a SKILL.md. Quoted values are unquoted and
 * block scalars (`|`, `>`) are joined; lists and nested blocks are ignored.
 */
export function parseFrontmatter(raw: string): Record<string, string> {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/.exec(raw.replace(/^\uFEFF/, ''));
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    if (v === '|' || v === '|-' || v === '>' || v === '>-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = v.startsWith('|') ? parts.join('\n') : parts.join(' ');
    }
    if (v) out[kv[1]] = v;
  }
  return out;
}

/** Same path with the home directory shortened to `~` and separators normalized, for display. */
function shortHome(p: string, home = homeDir()): string {
  const abs = path.resolve(p);
  const h = path.resolve(home);
  const rest = abs.startsWith(h + path.sep) ? abs.slice(h.length + 1) : abs === h ? '' : null;
  const shown = rest === null ? abs : `~/${rest}`;
  return shown.replace(/\\/g, '/');
}

/** Lists every harness's global skills directory and the skills inside it. */
export async function listSkills(home?: string): Promise<SkillRootInfo[]> {
  return Promise.all(skillRoots(home).map((root) => listRoot(root, home)));
}

async function listRoot(root: SkillRootSpec, home?: string): Promise<SkillRootInfo> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root.path, { withFileTypes: true });
  } catch {
    return { ...root, display: shortHome(root.path, home), exists: false, skills: [] };
  }
  // Symlinked skill folders are common (dotfile managers), so they count too. Dot-prefixed
  // folders are harness-internal (e.g. Codex's .system) and are not user-managed skills.
  const dirs = entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'));
  const skills = await Promise.all(dirs.map((d) => readSkill(path.join(root.path, d.name))));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { ...root, display: shortHome(root.path, home), exists: true, skills };
}

/** Reads one skill directory: SKILL.md frontmatter, or a `broken` reason when it has none. */
async function readSkill(dir: string): Promise<SkillInfo> {
  const file = path.join(dir, 'SKILL.md');
  let stat: import('node:fs').Stats | null = null;
  try {
    stat = await fs.stat(file);
  } catch {
    /* fall through to the broken path */
  }
  if (stat) {
    try {
      const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
      return {
        name: fm.name?.trim() || path.basename(dir),
        description: fm.description?.trim() ?? '',
        path: dir,
        file,
        mtimeMs: stat.mtimeMs
      };
    } catch {
      return { name: path.basename(dir), description: '', path: dir, file, mtimeMs: stat.mtimeMs, broken: 'SKILL.md unreadable' };
    }
  }
  return { name: path.basename(dir), description: '', path: dir, file: null, mtimeMs: 0, broken: 'no SKILL.md' };
}

export interface SkillLocation {
  kind: 'root' | 'skill';
  root: SkillRootSpec;
  dir: string;
}

/** Resolves a path against the known roots: itself a root, or a direct child of one (a skill folder). */
export function locateSkillPath(p: string, home?: string): SkillLocation | null {
  const abs = path.resolve(p);
  for (const root of skillRoots(home)) {
    const rp = path.resolve(root.path);
    if (abs === rp) return { kind: 'root', root, dir: abs };
    if (path.dirname(abs) === rp) return { kind: 'skill', root, dir: abs };
  }
  return null;
}

const SKILL_DOC_LIMIT = 400_000;

/** Reads a skill's SKILL.md for the preview pane; `path` must be a known skill folder. */
export async function readSkillDoc(p: string, home?: string): Promise<{ content: string; truncated: boolean }> {
  const loc = locateSkillPath(p, home);
  if (!loc || loc.kind !== 'skill') return { content: '', truncated: false };
  try {
    const buf = await fs.readFile(path.join(loc.dir, 'SKILL.md'));
    return { content: buf.subarray(0, SKILL_DOC_LIMIT).toString('utf8'), truncated: buf.length > SKILL_DOC_LIMIT };
  } catch {
    return { content: '', truncated: false };
  }
}

/** Normalizes a skill folder name: lowercase, spaces and junk to dashes, no leading/trailing separators. */
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}

/** Folder names must start with a letter or digit so traversal and hidden-folder tricks stay impossible. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** YAML plain scalar that survives colons, quotes and newlines in a description. */
function yamlScalar(s: string): string {
  return `"${s.replace(/\s+/g, ' ').trim().slice(0, 300).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Creates a scaffolded skill in a harness's global skills directory. */
export async function createSkill(req: { harness: SkillHarness; name: string; description: string }, home?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const spec = SKILL_HARNESSES.find((h) => h.harness === req.harness);
  if (!spec) return { ok: false, error: `"${req.harness}" does not load a global skills directory` };
  const raw = req.name.trim().toLowerCase();
  if (!raw || raw.includes('/') || raw.includes('\\')) return { ok: false, error: 'Name must be a single folder name without slashes.' };
  const name = normalizeName(raw);
  if (!NAME_RE.test(name)) return { ok: false, error: 'Use 2-64 characters: lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.' };
  const root = skillRoot(spec.harness, home);
  const dir = path.join(root, name);
  if (await exists(dir)) return { ok: false, error: `"${name}" already exists in ${shortHome(root, home)}` };
  try {
    const body = `---\nname: ${name}\ndescription: ${yamlScalar(req.description || `The ${name} skill.`)}\n---\n\n# ${name}\n\nDescribe what this skill does and when the agent should use it.\n`;
    await ensureDir(dir);
    await fs.writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Copies a skill folder into another harness's global skills directory; refuses an existing target. */
export async function copySkill(req: { path: string; toHarness: SkillHarness }, home?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const loc = locateSkillPath(req.path, home);
  if (!loc || loc.kind !== 'skill') return { ok: false, error: 'Not a known skill folder' };
  if (loc.root.harness === req.toHarness) return { ok: false, error: 'Skill is already installed there' };
  const destRoot = skillRoot(req.toHarness, home);
  const dest = path.join(destRoot, path.basename(loc.dir));
  if (await exists(dest)) return { ok: false, error: `"${path.basename(loc.dir)}" already exists in ${shortHome(destRoot, home)}` };
  try {
    await fs.cp(loc.dir, dest, { recursive: true, force: false, errorOnExist: true });
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Deletes a skill folder; the path must be a direct child of a known skills root. */
export async function deleteSkill(p: string, home?: string): Promise<{ ok: boolean; error?: string }> {
  const loc = locateSkillPath(p, home);
  if (!loc || loc.kind !== 'skill') return { ok: false, error: 'Not a known skill folder' };
  try {
    await rmrf(loc.dir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
