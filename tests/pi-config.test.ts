/**
 * Settings → Pi backend (main/pi-config.ts). The behaviours that matter: discovery matches what pi
 * would load, enable/disable writes pi's own `+`/`-` patterns without touching other settings keys,
 * and a malformed settings.json is reported and never rewritten.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiConfigStore, applyPatternsToFiles, matchPiGlob, packageLocation, packageResourceEnabled, piPaths, piResourceEnabled, runPiCommand, type PiRunner } from '../src/main/pi-config';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pi-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** A temp agent dir seeded with one of every resource type, plus a settings.json. */
async function fixture(settings: Record<string, unknown> = {}): Promise<{ agentDir: string; store: PiConfigStore }> {
  const root = await tmpDir();
  const agentDir = path.join(root, 'agent');
  await fs.mkdir(path.join(agentDir, 'extensions', 'folder'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'skills', 'demo'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'skills', 'other'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'prompts'), { recursive: true });
  await fs.mkdir(path.join(agentDir, 'themes'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'extensions', 'goal.ts'), 'export default () => {};', 'utf8');
  await fs.writeFile(path.join(agentDir, 'extensions', 'folder', 'index.ts'), 'export default () => {};', 'utf8');
  await fs.writeFile(path.join(agentDir, 'extensions', 'README.md'), '# not an extension', 'utf8');
  await fs.writeFile(path.join(agentDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo the thing\n---\n\nBody\n', 'utf8');
  await fs.writeFile(path.join(agentDir, 'skills', 'other', 'SKILL.md'), '---\nname: other-skill\n---\n', 'utf8');
  await fs.writeFile(path.join(agentDir, 'prompts', 'review.md'), '---\ndescription: Review code\n---\nReview $ARGUMENTS\n', 'utf8');
  await fs.writeFile(path.join(agentDir, 'themes', 'custom.json'), JSON.stringify({ name: 'custom-theme', colors: {} }), 'utf8');
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings), 'utf8');
  return { agentDir, store: new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir }, home: root }) };
}

describe('piPaths', () => {
  it('honors PI_CODING_AGENT_DIR and falls back to the home agent dir', () => {
    const agentDir = path.resolve('/custom/agent');
    expect(piPaths({ PI_CODING_AGENT_DIR: '/custom/agent' }, '/home/u')).toEqual({
      agentDir,
      settingsPath: path.join(agentDir, 'settings.json')
    });
    expect(piPaths({}, '/home/u').agentDir).toBe(path.resolve(path.join('/home/u', '.pi', 'agent')));
  });
});

describe('piResourceEnabled', () => {
  const agentDir = path.resolve('/agent');
  const file = path.join(agentDir, 'extensions', 'goal.ts');
  const skill = path.join(agentDir, 'skills', 'demo', 'SKILL.md');

  it('defaults to enabled and has no opinion without overrides', () => {
    expect(piResourceEnabled('extensions', file, agentDir, {})).toEqual({ enabled: true, forced: false });
    expect(piResourceEnabled('extensions', file, agentDir, { extensions: ['other.ts'] })).toEqual({ enabled: true, forced: false });
  });

  it('applies pi precedence: glob excludes, then +, then -', () => {
    expect(piResourceEnabled('extensions', file, agentDir, { extensions: ['!extensions/*.ts'] }).enabled).toBe(false);
    // A force-include beats an exclude, and a force-exclude beats everything.
    expect(piResourceEnabled('extensions', file, agentDir, { extensions: ['!extensions/*.ts', '+extensions/goal.ts'] }).enabled).toBe(true);
    expect(piResourceEnabled('extensions', file, agentDir, { extensions: ['!extensions/*.ts', '+extensions/goal.ts', '-extensions/goal.ts'] }).enabled).toBe(false);
  });

  it('matches a skill by its folder as pi allows', () => {
    expect(piResourceEnabled('skills', skill, agentDir, { skills: ['-skills/demo'] })).toEqual({ enabled: false, forced: true });
    expect(piResourceEnabled('skills', skill, agentDir, { skills: ['-skills/demo/SKILL.md'] }).enabled).toBe(false);
  });
});

describe('matchPiGlob', () => {
  it('treats ** as crossing separators and single * as staying in one segment', () => {
    expect(matchPiGlob('**/SKILL.md', 'skills/demo/SKILL.md')).toBe(true);
    expect(matchPiGlob('SKILL.md', 'skills/demo/SKILL.md')).toBe(false);
    expect(matchPiGlob('skills/*/SKILL.md', 'skills/demo/SKILL.md')).toBe(true);
    expect(matchPiGlob('skills/*/SKILL.md', 'skills/a/b/SKILL.md')).toBe(false);
    expect(matchPiGlob('skills/?.md', 'skills/a.md')).toBe(true);
  });
});

describe('PiConfigStore.read', () => {
  it('lists one of every type with frontmatter names and descriptions', async () => {
    const { agentDir, store } = await fixture();
    const setup = await store.read();
    expect(setup.agentDir).toBe(path.resolve(agentDir));
    expect(setup.settingsPath).toBe(path.join(path.resolve(agentDir), 'settings.json'));
    expect(setup.settingsError).toBeUndefined();
    const names = setup.resources.map((r) => `${r.type}:${r.name}`);
    expect(names).toEqual(['extensions:folder/index.ts', 'extensions:goal.ts', 'skills:demo-skill', 'skills:other-skill', 'prompts:review.md', 'themes:custom-theme']);
    expect(setup.resources.find((r) => r.name === 'demo-skill')?.description).toBe('Demo the thing');
    expect(setup.resources.find((r) => r.name === 'review.md')?.description).toBe('Review code');
    expect(setup.resources.every((r) => r.enabled && !r.forced)).toBe(true);
  });

  it('reports the prompt files, absent ones included', async () => {
    const { agentDir, store } = await fixture();
    await fs.writeFile(path.join(agentDir, 'AGENTS.md'), '# house rules\n', 'utf8');
    const setup = await store.read();
    expect(setup.promptFiles.map((f) => [f.name, f.exists])).toEqual([
      ['AGENTS.md', true],
      ['APPEND_SYSTEM.md', false],
      ['SYSTEM.md', false]
    ]);
    expect(setup.promptFiles[0]?.content).toBe('# house rules\n');
  });

  it('includes exact files a plain settings entry adds from outside the default dirs', async () => {
    const { agentDir, store } = await fixture();
    const extra = path.join(agentDir, 'elsewhere', 'extra.ts');
    await fs.mkdir(path.dirname(extra), { recursive: true });
    await fs.writeFile(extra, 'export default () => {};', 'utf8');
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ extensions: ['elsewhere/extra.ts'] }), 'utf8');
    const setup = await store.read();
    expect(setup.resources.some((r) => r.path === extra)).toBe(true);
  });

  it('reports a malformed settings.json instead of failing or rewriting it', async () => {
    const { agentDir, store } = await fixture();
    await fs.writeFile(path.join(agentDir, 'settings.json'), '{ not json', 'utf8');
    const setup = await store.read();
    expect(setup.settingsError).toContain('not valid JSON');
    expect(setup.resources.length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8')).toBe('{ not json');
  });
});

describe('PiConfigStore.updatePreferences', () => {
  it('writes nested pi keys and preserves everything else', async () => {
    const { agentDir, store } = await fixture({ theme: 'catppuccin-mocha', retry: { provider: { maxRetries: 2 } } });
    const setup = await store.updatePreferences({ defaultThinkingLevel: 'high', compactionEnabled: false, compactionReserveTokens: 8192, retryMaxRetries: 5 });
    expect(setup.preferences).toMatchObject({ defaultThinkingLevel: 'high', compactionEnabled: false, compactionReserveTokens: 8192, retryMaxRetries: 5 });
    const raw = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(raw).toEqual({
      theme: 'catppuccin-mocha',
      retry: { provider: { maxRetries: 2 }, maxRetries: 5 },
      defaultThinkingLevel: 'high',
      compaction: { enabled: false, reserveTokens: 8192 }
    });
  });

  it('null deletes the key and prunes the emptied branch', async () => {
    const { agentDir, store } = await fixture({ compaction: { enabled: true, reserveTokens: 8192 }, theme: 'dark' });
    const setup = await store.updatePreferences({ compactionReserveTokens: null, compactionEnabled: null });
    expect(setup.preferences.compactionEnabled).toBeUndefined();
    const raw = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'));
    expect(raw).toEqual({ theme: 'dark' });
  });

  it('rejects an invalid value without touching the file', async () => {
    const { agentDir, store } = await fixture({ theme: 'dark' });
    await expect(store.updatePreferences({ defaultThinkingLevel: 'maximum' as never })).rejects.toThrow('Invalid value');
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('ignores inherited keys a hostile patch might smuggle in', async () => {
    const { agentDir, store } = await fixture({ theme: 'dark' });
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as never;
    const setup = await store.updatePreferences(patch);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(setup.preferences).toEqual({});
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('refuses to write over a malformed settings.json', async () => {
    const { agentDir, store } = await fixture();
    await fs.writeFile(path.join(agentDir, 'settings.json'), '{ not json', 'utf8');
    await expect(store.updatePreferences({ transport: 'sse' })).rejects.toThrow('fix it in an editor');
    expect(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8')).toBe('{ not json');
  });
});

describe('PiConfigStore.setResourceEnabled', () => {
  it('writes pi-style patterns and flips the resource state', async () => {
    const { agentDir, store } = await fixture({ theme: 'dark' });
    const before = await store.read();
    const demo = before.resources.find((r) => r.name === 'demo-skill')!;

    const off = await store.setResourceEnabled('skills', demo.path, false);
    expect(off.resources.find((r) => r.name === 'demo-skill')).toMatchObject({ enabled: false, forced: true });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skills: ['-skills/demo/SKILL.md'] });

    const on = await store.setResourceEnabled('skills', demo.path, true);
    expect(on.resources.find((r) => r.name === 'demo-skill')).toMatchObject({ enabled: true, forced: true });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skills: ['+skills/demo/SKILL.md'] });
  });

  it('replaces an earlier pattern for the same path instead of stacking them', async () => {
    const { agentDir, store } = await fixture({ skills: ['-skills/demo/SKILL.md'] });
    const demo = (await store.read()).resources.find((r) => r.name === 'demo-skill')!;
    await store.setResourceEnabled('skills', demo.path, true);
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8')).skills).toEqual(['+skills/demo/SKILL.md']);
  });

  it('rejects a path that is not a discovered resource', async () => {
    const { agentDir, store } = await fixture();
    const outside = path.join(agentDir, '..', 'outside.ts');
    await fs.writeFile(outside, 'x', 'utf8');
    await expect(store.setResourceEnabled('extensions', outside, false)).rejects.toThrow('Not a resource');
  });

  it('rejects an unknown resource type', async () => {
    const { store } = await fixture();
    await expect(store.setResourceEnabled('packages' as never, '/x', false)).rejects.toThrow('Unknown pi resource type');
  });
});

describe('PiConfigStore.writePrompt', () => {
  it('creates, then deletes the file when the content is emptied', async () => {
    const { agentDir, store } = await fixture();
    const created = await store.writePrompt('APPEND_SYSTEM.md', 'Always be brief.\n');
    expect(created.promptFiles.find((f) => f.name === 'APPEND_SYSTEM.md')).toMatchObject({ exists: true, content: 'Always be brief.\n' });
    expect(await fs.readFile(path.join(agentDir, 'APPEND_SYSTEM.md'), 'utf8')).toBe('Always be brief.\n');

    const removed = await store.writePrompt('APPEND_SYSTEM.md', '  \n');
    expect(removed.promptFiles.find((f) => f.name === 'APPEND_SYSTEM.md')?.exists).toBe(false);
    await expect(fs.access(path.join(agentDir, 'APPEND_SYSTEM.md'))).rejects.toThrow();
  });

  it('rejects an unknown file name and an oversized write', async () => {
    const { store } = await fixture();
    await expect(store.writePrompt('NOTES.md' as never, 'x')).rejects.toThrow('Unknown prompt file');
    await expect(store.writePrompt('AGENTS.md', 'x'.repeat(600_000))).rejects.toThrow('limited to 512 KB');
  });
});

describe('PiConfigStore.resolveAgentPath', () => {
  it('accepts the agent dir and its children, rejects anything else', async () => {
    const { agentDir, store } = await fixture();
    expect(store.resolveAgentPath(path.join(agentDir, 'settings.json'))).toBe(path.resolve(agentDir, 'settings.json'));
    expect(store.resolveAgentPath(agentDir)).toBe(path.resolve(agentDir));
    expect(store.resolveAgentPath(path.join(agentDir, '..', 'evil'))).toBeNull();
    expect(store.resolveAgentPath(path.join(agentDir, 'a', '..', '..', 'evil'))).toBeNull();
  });
});

describe('packageLocation', () => {
  const agentDir = path.resolve('/agent');
  const home = path.resolve('/home/u');

  it('materializes npm sources under node_modules, version and scope included', () => {
    expect(packageLocation('npm:@scope/pkg@1.2.3', agentDir, home)).toEqual({ kind: 'npm', path: path.join(agentDir, 'npm', 'node_modules', '@scope', 'pkg') });
    expect(packageLocation('npm:plain', agentDir, home)).toEqual({ kind: 'npm', path: path.join(agentDir, 'npm', 'node_modules', 'plain') });
  });

  it('accepts every git spelling pi accepts', () => {
    const expected = { kind: 'git', path: path.join(agentDir, 'git', 'github.com', 'user', 'repo') };
    for (const source of ['git:https://github.com/user/repo', 'git:github.com/user/repo', 'https://github.com/user/repo.git', 'git:git@github.com:user/repo']) {
      expect(packageLocation(source, agentDir, home)).toEqual(expected);
    }
  });

  it('resolves local paths against the agent dir, with ~ expansion', () => {
    expect(packageLocation('./local/pkg', agentDir, home)).toEqual({ kind: 'local', path: path.join(agentDir, 'local', 'pkg') });
    expect(packageLocation('~/pkg', agentDir, home)).toEqual({ kind: 'local', path: path.join(home, 'pkg') });
  });
});

describe('packageResourceEnabled', () => {
  const root = path.resolve('/pkg');
  const file = path.join(root, 'src', 'index.ts');

  it('loads everything without a filter, and only explicit filters under autoload:false', () => {
    expect(packageResourceEnabled(file, undefined, root, true)).toBe(true);
    expect(packageResourceEnabled(file, undefined, root, false)).toBe(false);
    expect(packageResourceEnabled(file, [], root, true)).toBe(false);
    expect(packageResourceEnabled(file, ['+src/index.ts'], root, false)).toBe(true);
    expect(packageResourceEnabled(file, ['-src/index.ts'], root, false)).toBe(false);
  });

  it('applies plain includes as an allowlist and ! as a glob exclude', () => {
    expect(packageResourceEnabled(file, ['src/index.ts'], root, true)).toBe(true);
    expect(packageResourceEnabled(file, ['src/other.ts'], root, true)).toBe(false);
    expect(packageResourceEnabled(file, ['!src/*.ts'], root, true)).toBe(false);
  });
});

describe('applyPatternsToFiles', () => {
  it('runs include, exclude, force-include and force-exclude in pi order', () => {
    const root = path.resolve('/pkg');
    const a = path.join(root, 'a.ts');
    const b = path.join(root, 'b.ts');
    expect([...applyPatternsToFiles([a, b], [], root)]).toEqual([a, b]);
    expect([...applyPatternsToFiles([a, b], ['!*.ts'], root)]).toEqual([]);
    expect([...applyPatternsToFiles([a, b], ['!*.ts', '+a.ts'], root)]).toEqual([a]);
    // Force-exclude wins over force-include for the same file; other files are untouched.
    expect([...applyPatternsToFiles([a, b], ['+a.ts', '-a.ts'], root)]).toEqual([b]);
    expect([...applyPatternsToFiles([a, b], ['b.ts'], root)]).toEqual([b]);
  });
});

/** Seeds a package directory and its settings.packages entry. */
async function withPackage(settings: Record<string, unknown>, build: (root: string) => Promise<void>): Promise<{ agentDir: string; pkgRoot: string; store: PiConfigStore }> {
  const root = await tmpDir();
  const agentDir = path.join(root, 'agent');
  const pkgRoot = path.join(root, 'pkg');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(pkgRoot, { recursive: true });
  await build(pkgRoot);
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ ...settings, packages: [pkgRoot] }), 'utf8');
  return { agentDir, pkgRoot, store: new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir }, home: root }) };
}

describe('PiConfigStore packages', () => {
  it('reads a manifest package and applies its own override patterns', async () => {
    const { pkgRoot, store } = await withPackage({}, async (root) => {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export default () => {};', 'utf8');
      await fs.writeFile(path.join(root, 'src', 'extra.ts'), 'export default () => {};', 'utf8');
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', pi: { extensions: ['./src/*.ts', '-src/extra.ts'] } }), 'utf8');
    });
    const setup = await store.read();
    const pkg = setup.packages[0]!;
    expect(pkg).toMatchObject({ source: pkgRoot, name: 'demo', kind: 'local', installed: true, autoload: true });
    expect(pkg.resources.map((r) => r.name)).toEqual(['src/index.ts']);
    expect(pkg.resources[0]!.path).toBe(path.join(pkgRoot, 'src', 'index.ts'));
  });

  it('falls back to convention folders when the manifest has no pi key', async () => {
    const { store } = await withPackage({}, async (root) => {
      await fs.mkdir(path.join(root, 'extensions'), { recursive: true });
      await fs.writeFile(path.join(root, 'extensions', 'hello.ts'), 'export default () => {};', 'utf8');
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
    });
    const setup = await store.read();
    expect(setup.packages[0]!.resources.map((r) => r.name)).toEqual(['hello.ts']);
  });

  it('marks package resources disabled by an object filter and flips them', async () => {
    const { pkgRoot, agentDir, store } = await withPackage({}, async (root) => {
      await fs.mkdir(path.join(root, 'extensions'), { recursive: true });
      await fs.writeFile(path.join(root, 'extensions', 'hello.ts'), 'export default () => {};', 'utf8');
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
    });
    // Replace the string entry with a filtered object entry.
    const settingsPath = path.join(agentDir, 'settings.json');
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    settings.packages = [{ source: pkgRoot, extensions: ['-extensions/hello.ts'] }];
    await fs.writeFile(settingsPath, JSON.stringify(settings), 'utf8');

    const before = await store.read();
    const file = before.packages[0]!.resources[0]!.path;
    expect(before.packages[0]!.resources[0]).toMatchObject({ enabled: false, forced: true });

    const after = await store.setPackageResourceEnabled(pkgRoot, 'extensions', file, true);
    expect(after.packages[0]!.resources[0]).toMatchObject({ enabled: true, forced: true });
    const raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(raw.packages).toEqual([{ source: pkgRoot, extensions: ['+extensions/hello.ts'] }]);
  });

  it('rejects a package resource toggle for a path the package does not expose', async () => {
    const { pkgRoot, store } = await withPackage({}, async (root) => {
      await fs.mkdir(path.join(root, 'extensions'), { recursive: true });
      await fs.writeFile(path.join(root, 'extensions', 'hello.ts'), 'export default () => {};', 'utf8');
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
    });
    await expect(store.setPackageResourceEnabled(pkgRoot, 'extensions', path.join(pkgRoot, '..', 'evil.ts'), false)).rejects.toThrow('Not a resource');
    await expect(store.setPackageResourceEnabled('git:github.com/nope/nope', 'extensions', path.join(pkgRoot, 'extensions', 'hello.ts'), false)).rejects.toThrow('Not a resource');
  });
});

describe('PiConfigStore package commands', () => {
  it('passes the exact argv to the runner', async () => {
    const calls: string[][] = [];
    const runner: PiRunner = async (args) => {
      calls.push(args);
      return { ok: true, code: 0, log: 'done' };
    };
    const root = await tmpDir();
    const store = new PiConfigStore({ env: { PI_CODING_AGENT_DIR: path.join(root, 'agent') }, home: root, runPi: runner });
    await store.installPackage('git:github.com/user/repo');
    await store.removePackage('npm:@scope/pkg@1.0.0');
    await store.updatePackages();
    await store.updatePackages('git:github.com/user/repo');
    expect(calls).toEqual([
      ['install', 'git:github.com/user/repo'],
      ['remove', 'npm:@scope/pkg@1.0.0'],
      ['update', '--extensions'],
      ['update', 'git:github.com/user/repo']
    ]);
  });

  it('rejects sources that could become command execution', async () => {
    const store = new PiConfigStore({ runPi: async () => ({ ok: true, code: 0, log: '' }) });
    for (const bad of ['', '   ', '-l', 'a\nb', 'a\0b', 'x'.repeat(501)]) {
      await expect(store.installPackage(bad)).rejects.toThrow('Invalid package source');
    }
  });

  it('reports a missing pi binary instead of throwing', async () => {
    const store = new PiConfigStore();
    await expect(store.installPackage('npm:foo')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('pi is not installed') });
  });
});

describe('runPiCommand', () => {
  it('captures output and exit status from a real process', async () => {
    const ok = await runPiCommand(['-e', 'console.log("PI_OK")'], { piPath: process.execPath, cwd: os.tmpdir(), log: () => undefined, timeoutMs: 30_000 });
    expect(ok).toMatchObject({ ok: true, code: 0 });
    expect(ok.log).toContain('PI_OK');

    const failed = await runPiCommand(['-e', 'process.exit(3)'], { piPath: process.execPath, cwd: os.tmpdir(), log: () => undefined, timeoutMs: 30_000 });
    expect(failed).toMatchObject({ ok: false, code: 3 });
    expect(failed.error).toContain('exited with code 3');
  });

  it('kills a command that outlives the timeout', async () => {
    const r = await runPiCommand(['-e', 'setTimeout(() => {}, 30_000)'], { piPath: process.execPath, cwd: os.tmpdir(), log: () => undefined, timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out');
  });
});

describe('PiConfigStore subagents', () => {
  it('writes curated keys, preserves unknown ones, and deletes on null', async () => {
    const { agentDir, store } = await fixture();
    await fs.writeFile(path.join(agentDir, 'subagents.json'), JSON.stringify({ widgetMode: 'off', reportUsage: false }), 'utf8');
    await store.updateSubagents({ reportUsage: true, maxSubagentDepth: 3, fallbackSubagent: 'Plan' });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'subagents.json'), 'utf8'))).toEqual({
      widgetMode: 'off',
      reportUsage: true,
      fallbackSubagent: 'Plan',
      maxSubagentDepth: 3
    });

    const setup = await store.updateSubagents({ maxSubagentDepth: null, fallbackSubagent: null });
    expect(setup.subagents).toEqual({ reportUsage: true });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'subagents.json'), 'utf8'))).toEqual({ widgetMode: 'off', reportUsage: true });
  });

  it('rejects values pi-subagents would drop', async () => {
    const { store } = await fixture();
    await expect(store.updateSubagents({ maxSubagentDepth: 17 })).rejects.toThrow('Invalid value');
    await expect(store.updateSubagents({ maxConcurrent: 0 })).rejects.toThrow('Invalid value');
    await expect(store.updateSubagents({ reportUsage: 'yes' as never })).rejects.toThrow('Invalid value');
    await expect(store.updateSubagents({ maxConcurrentForeground: 1.5 })).rejects.toThrow('Invalid value');
  });

  it('reports a malformed subagents.json and refuses to write over it', async () => {
    const { agentDir, store } = await fixture();
    await fs.writeFile(path.join(agentDir, 'subagents.json'), '{ nope', 'utf8');
    expect((await store.read()).subagentsError).toContain('not valid JSON');
    await expect(store.updateSubagents({ reportUsage: true })).rejects.toThrow('fix it in an editor');
    expect(await fs.readFile(path.join(agentDir, 'subagents.json'), 'utf8')).toBe('{ nope');
  });
});

describe('PiConfigStore agents', () => {
  it('lists on-disk agents with frontmatter name, description and model', async () => {
    const { agentDir, store } = await fixture();
    await fs.mkdir(path.join(agentDir, 'agents'), { recursive: true });
    await fs.writeFile(path.join(agentDir, 'agents', 'Explore.md'), '---\nname: Explore\ndescription: Read-only search\nmodel: deepseek/deepseek-v4-pro\n---\nBody\n', 'utf8');
    await fs.writeFile(path.join(agentDir, 'agents', 'plain.md'), '---\n---\n', 'utf8');
    const agents = (await store.read()).agents;
    expect(agents).toEqual([
      { name: 'Explore', description: 'Read-only search', model: 'deepseek/deepseek-v4-pro', path: path.join(agentDir, 'agents', 'Explore.md') },
      { name: 'plain', path: path.join(agentDir, 'agents', 'plain.md') }
    ]);
  });
});
