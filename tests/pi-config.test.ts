/**
 * Settings → Pi backend (main/pi-config.ts). The behaviours that matter: discovery matches what pi
 * would load, enable/disable writes pi's own `+`/`-` patterns without touching other settings keys,
 * and a malformed settings.json is reported and never rewritten.
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as processTools from '../src/main/harness/spawn';
import { PiConfigStore, applyPatternsToFiles, matchPiGlob, packageLocation, packageResourceEnabled, piPaths, piResourceEnabled, runPiCommand, type PiRunner } from '../src/main/pi-config';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pi-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Capture each JSON read at invocation, so overlapping mutations deterministically see stale data.
 * The store and atomic writer still use real files; no timer or filesystem scheduling race is needed. */
function snapshotJsonReads(file: string): void {
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === file && args[1] === 'utf8') return Promise.resolve(readFileSync(file, 'utf8'));
    return readFile(...args);
  }) as typeof fs.readFile);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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
      ['SYSTEM.md', false],
      ['APPEND_SYSTEM.md', false],
      ['AGENTS.md', true]
    ]);
    expect(setup.promptFiles.find((f) => f.name === 'AGENTS.md')?.content).toBe('# house rules\n');
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

describe('PiConfigStore complete mutations', () => {
  it('preserves concurrent preference patches across stores sharing a file, including each returned snapshot', async () => {
    const { agentDir, store } = await fixture({ theme: 'dark', retry: { provider: { maxRetries: 2 } } });
    const file = path.join(agentDir, 'settings.json');
    const other = new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } });
    snapshotJsonReads(file);

    const [first, second] = await Promise.all([
      store.updatePreferences({ retryEnabled: false }),
      other.updatePreferences({ retryBaseDelayMs: 500 })
    ]);
    expect(first.preferences.retryEnabled).toBe(false);
    expect(first.preferences.retryBaseDelayMs).toBeUndefined();
    expect(second.preferences).toMatchObject({ retryEnabled: false, retryBaseDelayMs: 500 });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      theme: 'dark', retry: { provider: { maxRetries: 2 }, enabled: false, baseDelayMs: 500 }
    });
    const reloaded = await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read();
    expect(reloaded.preferences).toEqual(second.preferences);
  });

  it('merges concurrent preferences, local resource toggles and package filters without losing unknown keys', async () => {
    const { agentDir, pkgRoot, store } = await withPackage({ theme: 'dark' }, async (root) => {
      await fs.mkdir(path.join(root, 'extensions'), { recursive: true });
      await fs.writeFile(path.join(root, 'extensions', 'hello.ts'), 'export default () => {};', 'utf8');
    });
    await fs.mkdir(path.join(agentDir, 'extensions'), { recursive: true });
    const local = path.join(agentDir, 'extensions', 'local.ts');
    await fs.writeFile(local, 'export default () => {};', 'utf8');
    const file = path.join(agentDir, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ theme: 'dark', packages: [{ source: pkgRoot, custom: 'keep' }] }), 'utf8');
    snapshotJsonReads(file);

    const [preferences, resource, pkg] = await Promise.all([
      store.updatePreferences({ transport: 'sse' }),
      store.setResourceEnabled('extensions', local, false),
      store.setPackageResourceEnabled(pkgRoot, 'extensions', path.join(pkgRoot, 'extensions', 'hello.ts'), false)
    ]);
    expect(preferences.preferences.transport).toBe('sse');
    expect(preferences.resources[0]?.enabled).toBe(true);
    expect(resource.preferences.transport).toBe('sse');
    expect(resource.resources[0]?.enabled).toBe(false);
    expect(resource.packages[0]?.resources[0]?.enabled).toBe(true);
    expect(pkg.packages[0]?.resources[0]?.enabled).toBe(false);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      theme: 'dark', transport: 'sse', extensions: ['-extensions/local.ts'],
      packages: [{ source: pkgRoot, custom: 'keep', extensions: ['-extensions/hello.ts'] }]
    });
    const reloaded = await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read();
    expect(reloaded.preferences.transport).toBe('sse');
    expect(reloaded.resources[0]?.enabled).toBe(false);
    expect(reloaded.packages[0]?.resources[0]?.enabled).toBe(false);
  });

  it('merges concurrent subagent patches and snapshots while preserving uncurated keys', async () => {
    const { agentDir, store } = await fixture();
    const file = path.join(agentDir, 'subagents.json');
    await fs.writeFile(file, JSON.stringify({ widgetMode: 'off', showModel: true }), 'utf8');
    snapshotJsonReads(file);

    const [first, second] = await Promise.all([
      store.updateSubagents({ showModel: null, reportUsage: true }),
      store.updateSubagents({ maxConcurrent: 7 })
    ]);
    expect(first.subagents).toEqual({ reportUsage: true });
    expect(second.subagents).toEqual({ reportUsage: true, maxConcurrent: 7 });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ widgetMode: 'off', reportUsage: true, maxConcurrent: 7 });
    expect((await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read()).subagents).toEqual(second.subagents);
  });

  it.each(['settings.json', 'subagents.json'] as const)('recovers %s after a failed atomic write and a rejected patch', async (name) => {
    const { agentDir, store } = await fixture();
    const file = path.join(agentDir, name);
    const original = JSON.stringify({ unrelated: { keep: true } });
    await fs.writeFile(file, original, 'utf8');
    const update = (value: number) => name === 'settings.json'
      ? store.updatePreferences({ retryBaseDelayMs: value })
      : store.updateSubagents({ maxConcurrent: value });
    const failure = Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure);

    await expect(update(500)).rejects.toThrow('injected disk full');
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.readdir(agentDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    const [rejected, recovered] = await Promise.allSettled([update(-1), update(200)]);
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Invalid value') }) });
    expect(recovered.status).toBe('fulfilled');
    const reloaded = await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read();
    if (name === 'settings.json') {
      expect(reloaded.preferences.retryBaseDelayMs).toBe(200);
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ unrelated: { keep: true }, retry: { baseDelayMs: 200 } });
    } else {
      expect(reloaded.subagents).toEqual({ maxConcurrent: 200 });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ unrelated: { keep: true }, maxConcurrent: 200 });
    }
  });

  it('orders a public read after a pending save and before a later save, across store instances', async () => {
    const { agentDir, store } = await fixture({ transport: 'auto' });
    snapshotJsonReads(path.join(agentDir, 'settings.json'));
    const entered = deferred();
    const release = deferred();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await rename(...args);
    });
    const saved = store.updatePreferences({ transport: 'sse' });
    await entered.promise;
    const read = new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read();
    const later = store.updatePreferences({ transport: 'websocket' });
    release.resolve();
    const snapshots = await Promise.all([saved, read, later]);
    expect(snapshots.map((setup) => setup.preferences.transport)).toEqual(['sse', 'sse', 'websocket']);
  });

  it('a public reload retains the earlier successful save when a later queued mutation fails', async () => {
    const { agentDir, store } = await fixture({ transport: 'auto' });
    snapshotJsonReads(path.join(agentDir, 'settings.json'));
    const outcomes = await Promise.allSettled([
      store.updatePreferences({ transport: 'sse' }),
      store.updatePreferences({ retryMaxRetries: -1 }),
      store.read()
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(outcomes[2]).toMatchObject({ status: 'fulfilled', value: { preferences: { transport: 'sse' } } });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ transport: 'sse' });
  });

  it('round-trips zero retries through save and a new store', async () => {
    const { agentDir, store } = await fixture({ retry: { maxRetries: 3 } });
    const saved = await store.updatePreferences({ retryMaxRetries: 0 });
    expect(saved.preferences.retryMaxRetries).toBe(0);
    expect((await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read()).preferences.retryMaxRetries).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ retry: { maxRetries: 0 } });
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

describe('PiConfigStore prompt byte limits', () => {
  const limit = 512 * 1024;

  it.each(['é', '界', '😀'])('round-trips %s at the exact UTF-8 byte boundary and rejects overflow without replacing it', async (character) => {
    const { agentDir, store } = await fixture();
    const bytes = Buffer.byteLength(character, 'utf8');
    const content = character.repeat(Math.floor(limit / bytes)) + 'x'.repeat(limit % bytes);
    expect(Buffer.byteLength(content, 'utf8')).toBe(limit);
    const saved = await store.writePrompt('AGENTS.md', content);
    const prompt = saved.promptFiles.find((f) => f.name === 'AGENTS.md');
    expect(prompt?.truncated).toBeUndefined();
    expect(prompt?.content === content).toBe(true);
    expect(await fs.readFile(path.join(agentDir, 'AGENTS.md'), 'utf8') === content).toBe(true);

    await expect(store.writePrompt('AGENTS.md', content + character)).rejects.toThrow('limited to 512 KB');
    expect(await fs.readFile(path.join(agentDir, 'AGENTS.md'), 'utf8') === content).toBe(true);
    const reloaded = await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read();
    expect(reloaded.promptFiles.find((f) => f.name === 'AGENTS.md')?.content === content).toBe(true);
  });

  it.each([['é', 1], ['界', 1], ['界', 2], ['😀', 1], ['😀', 2], ['😀', 3]] as const)('does not split %s after byte %i in a truncated preview', async (character, partialBytes) => {
    const { agentDir, store } = await fixture();
    const prefix = 'x'.repeat(limit - partialBytes);
    const file = path.join(agentDir, 'SYSTEM.md');
    const content = prefix + character + 'tail';
    await fs.writeFile(file, content, 'utf8');
    const prompt = (await store.read()).promptFiles.find((f) => f.name === 'SYSTEM.md');
    expect(prompt?.truncated).toBe(true);
    expect(prompt?.content).toHaveLength(prefix.length);
    expect(prompt?.content === prefix).toBe(true);
    expect(await fs.readFile(file, 'utf8') === content).toBe(true);
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

describe('PiConfigStore package mutation ordering', () => {
  it.each(['install', 'remove', 'update'] as const)('keeps %s runner writes authoritative before a concurrent preference patch', async (command) => {
    const { agentDir } = await fixture({ theme: 'dark' });
    const file = path.join(agentDir, 'settings.json');
    snapshotJsonReads(file);
    const entered = deferred();
    const release = deferred();
    const runner = vi.fn<PiRunner>(async () => {
      const before = JSON.parse(await fs.readFile(file, 'utf8'));
      entered.resolve();
      await release.promise;
      await fs.writeFile(file, JSON.stringify({ ...before, packages: ['npm:runner-result'] }), 'utf8');
      return { ok: true, code: 0, log: 'done' };
    });
    const store = new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir }, runPi: runner });
    const commandResult = command === 'install' ? store.installPackage('npm:demo')
      : command === 'remove' ? store.removePackage('npm:demo') : store.updatePackages('npm:demo');
    await entered.promise;
    const preferenceResult = store.updatePreferences({ transport: 'sse' });
    release.resolve();
    const [result, setup] = await Promise.all([commandResult, preferenceResult]);

    expect(result).toEqual({ ok: true, code: 0, log: 'done' });
    expect(runner.mock.calls).toEqual([[[command, 'npm:demo']]]);
    expect(setup.packages.map((pkg) => pkg.source)).toEqual(['npm:runner-result']);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ theme: 'dark', packages: ['npm:runner-result'], transport: 'sse' });
    const reloaded = await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read();
    expect(reloaded.preferences.transport).toBe('sse');
    expect(reloaded.packages.map((pkg) => pkg.source)).toEqual(['npm:runner-result']);
  });

  it('recovers after a rejected runner without blocking other agent directories while it is running', async () => {
    const { agentDir } = await fixture({ theme: 'dark' });
    const other = await fixture();
    const entered = deferred();
    const release = deferred();
    const runner = vi.fn<PiRunner>(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('runner failed');
    });
    const store = new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir }, runPi: runner });
    const result = Promise.allSettled([store.installPackage('npm:demo'), store.updatePreferences({ transport: 'sse' }), store.updateSubagents({ reportUsage: true })]);
    await entered.promise;
    try {
      expect((await other.store.updatePreferences({ transport: 'websocket' })).preferences.transport).toBe('websocket');
    } finally {
      release.resolve();
    }
    const outcomes = await result;
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'runner failed' }) });
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: { preferences: { transport: 'sse' } } });
    expect(outcomes[2]).toMatchObject({ status: 'fulfilled', value: { subagents: { reportUsage: true } } });
    const reloaded = await new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } }).read();
    expect(reloaded.preferences.transport).toBe('sse');
    expect(reloaded.subagents).toEqual({ reportUsage: true });
  });
});

describe('runPiCommand', () => {
  it('holds queued reads and writes through timeout teardown, even if close arrives first', async () => {
    const { agentDir } = await fixture({ theme: 'dark' });
    const stopping = deferred();
    const stopped = deferred();
    const child = new EventEmitter() as ChildProcess;
    vi.spyOn(processTools, 'spawnTool').mockReturnValueOnce(child);
    vi.spyOn(processTools, 'killTree').mockImplementationOnce(async () => {
      stopping.resolve();
      await stopped.promise;
    });
    const store = new PiConfigStore({
      env: { PI_CODING_AGENT_DIR: agentDir },
      runPi: (args) => runPiCommand(args, { piPath: 'fixture-pi', cwd: agentDir, log: () => undefined, timeoutMs: 1 })
    });
    const other = new PiConfigStore({ env: { PI_CODING_AGENT_DIR: agentDir } });
    const packageDone = vi.fn();
    const readDone = vi.fn();
    const writeDone = vi.fn();
    const command = store.installPackage('npm:fixture').then((result) => { packageDone(); return result; });
    await stopping.promise;
    const read = other.read().then((result) => { readDone(); return result; });
    const write = other.updatePreferences({ transport: 'sse' }).then((result) => { writeDone(); return result; });
    try {
      child.emit('close', 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(packageDone).not.toHaveBeenCalled();
      expect(readDone).not.toHaveBeenCalled();
      expect(writeDone).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
      // A final CLI write during teardown must be visible to the queued merge, not overwritten.
      await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'light' }), 'utf8');
    } finally {
      stopped.resolve();
      await Promise.all([command, read, write]);
    }
    expect(await command).toMatchObject({ ok: false, code: null, error: expect.stringContaining('timed out') });
    expect(packageDone).toHaveBeenCalledTimes(1);
    expect(readDone).toHaveBeenCalledTimes(1);
    expect(writeDone).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'light', transport: 'sse' });
  });

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
