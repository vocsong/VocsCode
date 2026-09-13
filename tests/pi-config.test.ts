/**
 * Settings → Pi backend (main/pi-config.ts). The behaviours that matter: discovery matches what pi
 * would load, enable/disable writes pi's own `+`/`-` patterns without touching other settings keys,
 * and a malformed settings.json is reported and never rewritten.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiConfigStore, matchPiGlob, piPaths, piResourceEnabled } from '../src/main/pi-config';

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
