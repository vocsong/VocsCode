import { mkdir, readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copySkill, createSkill, deleteSkill, listSkills, locateSkillPath, parseFrontmatter, skillRoot, skillRoots } from '../src/main/skills';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'vocs-skills-'));
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('reads name and description', () => {
    expect(parseFrontmatter('---\nname: foo\ndescription: Does things\n---\n\n# Body')).toEqual({ name: 'foo', description: 'Does things' });
  });
  it('unquotes values', () => {
    expect(parseFrontmatter(`---\nname: "quoted"\ndescription: 'single'\n---\n`)).toEqual({ name: 'quoted', description: 'single' });
  });
  it('ignores lists and nested blocks', () => {
    expect(parseFrontmatter('---\nname: a\nreferences:\n  - x\n  - y\nmetadata:\n  k: v\n---\n')).toEqual({ name: 'a' });
  });
  it('joins block scalars', () => {
    expect(parseFrontmatter('---\ndescription: |\n  line one\n  line two\n---\n')).toEqual({ description: 'line one\nline two' });
    expect(parseFrontmatter('---\ndescription: >-\n  folded one\n  folded two\n---\n')).toEqual({ description: 'folded one folded two' });
  });
  it('returns empty without frontmatter', () => {
    expect(parseFrontmatter('# just markdown\nbody')).toEqual({});
    expect(parseFrontmatter('---\nno closing')).toEqual({});
  });
});

describe('skillRoots', () => {
  it('defaults to the per-harness homes', () => {
    const j = (...p: string[]) => path.join(...p);
    expect(skillRoots(home).map((r) => [r.harness, r.path])).toEqual([
      ['claude', j(home, '.claude', 'skills')],
      ['codex', j(home, '.codex', 'skills')],
      ['pi', j(home, '.pi', 'agent', 'skills')]
    ]);
    expect(skillRoot('pi', home)).toBe(j(home, '.pi', 'agent', 'skills'));
  });
  it('honors CLAUDE_CONFIG_DIR and PI_CODING_AGENT_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-home');
    process.env.PI_CODING_AGENT_DIR = '~/agent';
    const roots = skillRoots(home);
    expect(roots.find((r) => r.harness === 'claude')!.path).toBe(path.join(home, 'claude-home', 'skills'));
    expect(roots.find((r) => r.harness === 'pi')!.path).toBe(path.join(home, 'agent', 'skills'));
  });
});

describe('listSkills', () => {
  it('lists skills and reports missing roots', async () => {
    const dir = path.join(home, '.pi', 'agent', 'skills', 'alpha');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: The first skill\n---\nBody', 'utf8');
    const roots = await listSkills(home);
    const pi = roots.find((r) => r.harness === 'pi')!;
    expect(pi.exists).toBe(true);
    expect(pi.display).toContain('~/');
    expect(pi.skills).toEqual([
      { name: 'alpha', description: 'The first skill', path: path.join(pi.path, 'alpha'), file: path.join(pi.path, 'alpha', 'SKILL.md'), mtimeMs: expect.any(Number) }
    ]);
    expect(roots.find((r) => r.harness === 'claude')!.exists).toBe(false);
    expect(roots.find((r) => r.harness === 'claude')!.skills).toEqual([]);
  });
  it('marks folders without a readable SKILL.md as broken', async () => {
    const skills = path.join(home, '.claude', 'skills');
    await mkdir(path.join(skills, 'empty'), { recursive: true });
    await mkdir(path.join(skills, 'garbage'), { recursive: true });
    await mkdir(path.join(skills, '.system'), { recursive: true });
    await writeFile(path.join(skills, 'garbage', 'SKILL.md'), '# no frontmatter', 'utf8');
    const claude = (await listSkills(home)).find((r) => r.harness === 'claude')!;
    expect(claude.skills.find((s) => s.name === 'empty')?.broken).toBe('no SKILL.md');
    const garbage = claude.skills.find((s) => s.name === 'garbage')!;
    expect(garbage.broken).toBeUndefined();
    expect(garbage.name).toBe('garbage');
    expect(garbage.description).toBe('');
    // Harness-internal dot folders are not user-managed skills.
    expect(claude.skills.find((s) => s.name === '.system')).toBeUndefined();
  });
  it('falls back to the folder name when frontmatter has no name', async () => {
    const dir = path.join(home, '.codex', 'skills', 'desc-only');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\ndescription: Only a description\n---\n', 'utf8');
    const codex = (await listSkills(home)).find((r) => r.harness === 'codex')!;
    expect(codex.skills[0].name).toBe('desc-only');
    expect(codex.skills[0].description).toBe('Only a description');
  });
});

describe('locateSkillPath', () => {
  it('classifies roots and skill folders', () => {
    const root = path.join(home, '.pi', 'agent', 'skills');
    expect(locateSkillPath(root, home)?.kind).toBe('root');
    expect(locateSkillPath(path.join(root, 'foo'), home)?.kind).toBe('skill');
    expect(locateSkillPath(path.join(root, 'foo', 'nested'), home)).toBeNull();
    expect(locateSkillPath(path.join(home, 'elsewhere', 'foo'), home)).toBeNull();
  });
});

describe('createSkill', () => {
  it('scaffolds a SKILL.md with a quoted description', async () => {
    const r = await createSkill({ harness: 'codex', name: 'My Skill', description: 'It does "x": a lot\nand more' }, home);
    expect(r.ok).toBe(true);
    const raw = await readFile(path.join(home, '.codex', 'skills', 'my-skill', 'SKILL.md'), 'utf8');
    expect(raw).toContain('name: my-skill');
    expect(raw).toContain('description: "It does \\"x\\": a lot and more"');
  });
  it('rejects invalid names and duplicates', async () => {
    expect((await createSkill({ harness: 'pi', name: '../evil', description: '' }, home)).ok).toBe(false);
    expect((await createSkill({ harness: 'pi', name: 'a/b', description: '' }, home)).ok).toBe(false);
    expect((await createSkill({ harness: 'pi', name: '..', description: '' }, home)).ok).toBe(false);
    expect((await createSkill({ harness: 'pi', name: 'a', description: '' }, home)).ok).toBe(false);
    expect((await createSkill({ harness: 'pi', name: 'ok-name', description: '' }, home)).ok).toBe(true);
    const dup = await createSkill({ harness: 'pi', name: 'ok-name', description: '' }, home);
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain('already exists');
  });
  it('rejects harnesses without a global skills directory', async () => {
    // @ts-expect-error exercising the guard for ids outside SkillHarness
    expect((await createSkill({ harness: 'native', name: 'x', description: '' }, home)).ok).toBe(false);
  });
});

describe('copySkill', () => {
  beforeEach(async () => {
    const dir = path.join(home, '.pi', 'agent', 'skills', 'sharer');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: sharer\ndescription: Copied around\n---\n', 'utf8');
  });
  it('copies a skill into another root', async () => {
    const src = path.join(home, '.pi', 'agent', 'skills', 'sharer');
    const r = await copySkill({ path: src, toHarness: 'claude' }, home);
    expect(r.ok).toBe(true);
    expect(r.path).toBe(path.join(home, '.claude', 'skills', 'sharer'));
    await expect(readFile(path.join(r.path!, 'SKILL.md'), 'utf8')).resolves.toContain('description: Copied around');
  });
  it('refuses same-root targets and existing folders', async () => {
    const src = path.join(home, '.pi', 'agent', 'skills', 'sharer');
    expect((await copySkill({ path: src, toHarness: 'pi' }, home)).error).toContain('already installed');
    await copySkill({ path: src, toHarness: 'codex' }, home);
    expect((await copySkill({ path: src, toHarness: 'codex' }, home)).error).toContain('already exists');
  });
  it('refuses unknown paths', async () => {
    expect((await copySkill({ path: path.join(home, 'x'), toHarness: 'claude' }, home)).ok).toBe(false);
  });
});

describe('deleteSkill', () => {
  it('removes a skill folder', async () => {
    const dir = path.join(home, '.claude', 'skills', 'doomed');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: doomed\n---\n', 'utf8');
    expect((await deleteSkill(dir, home)).ok).toBe(true);
    expect((await listSkills(home)).find((r) => r.harness === 'claude')!.skills).toEqual([]);
  });
  it('refuses paths outside the known roots', async () => {
    expect((await deleteSkill(path.join(home, 'elsewhere', 'x'), home)).ok).toBe(false);
  });
});
