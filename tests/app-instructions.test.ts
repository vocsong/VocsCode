/**
 * The app's own instruction layer: the files under `<userData>/instructions/`, how they compose for
 * a harness, and how a session receives them when its engine has no system prompt to add to.
 * Additive by design — a harness file never replaces the shared one.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppInstructions } from '../src/main/app-instructions';
import { sessionAppendPrompt } from '../src/main/harness/system-prompt';
import { buildSystemPrompt } from '../src/main/harness/native/prompt';
import { APP_INSTRUCTION_MAX_CHARS } from '../src/shared/app-instructions';
import type { SessionMeta } from '../src/shared/types';

const roots: string[] = [];
async function store(): Promise<{ store: AppInstructions; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-instructions-'));
  roots.push(dir);
  return { store: new AppInstructions(dir), dir };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('the app instruction layer', () => {
  it('composes the shared file with the harness family file, and nothing else', async () => {
    const { store: layer } = await store();
    await layer.write('global', 'Always be proactive.\n');
    await layer.write('pi', 'Pi: keep it terse.\n');
    await layer.write('codex', 'Codex: state the plan first.\n');

    expect(await layer.effective('pi')).toBe('Always be proactive.\n\nPi: keep it terse.');
    // Both Codex harnesses share one family file.
    expect(await layer.effective('codex')).toBe('Always be proactive.\n\nCodex: state the plan first.');
    expect(await layer.effective('codex-exec')).toBe('Always be proactive.\n\nCodex: state the plan first.');
    // No family file of its own: the shared one alone, never another harness's text.
    expect(await layer.effective('claude')).toBe('Always be proactive.');
  });

  it('is absent until a file has content, and saving a blank one removes it', async () => {
    const { store: layer, dir } = await store();
    expect(await layer.effective('pi')).toBeUndefined();

    const written = await layer.write('pi', 'Pi only.\n');
    expect(written.find((f) => f.scope === 'pi')).toMatchObject({ exists: true, content: 'Pi only.\n' });
    expect(await fs.readFile(path.join(dir, 'instructions', 'pi.md'), 'utf8')).toBe('Pi only.\n');

    const cleared = await layer.write('pi', '   \n');
    expect(cleared.find((f) => f.scope === 'pi')?.exists).toBe(false);
    await expect(fs.access(path.join(dir, 'instructions', 'pi.md'))).rejects.toThrow();
    expect(await layer.effective('pi')).toBeUndefined();
  });

  it('rejects an unknown scope and an oversized file before touching the disk', async () => {
    const { store: layer, dir } = await store();
    await expect(layer.write('bogus' as never, 'text')).rejects.toThrow('Unknown instruction scope: bogus');
    await expect(layer.write('global', 'x'.repeat(APP_INSTRUCTION_MAX_CHARS + 1))).rejects.toThrow('Instructions are limited to');
    await expect(fs.access(path.join(dir, 'instructions'))).rejects.toThrow();
  });

  it.each(['é', '界', '😀'])('round-trips %s at the character cap through read, effective and a new store', async (character) => {
    const { store: layer, dir } = await store();
    const content = character.repeat(APP_INSTRUCTION_MAX_CHARS / character.length);
    expect(content).toHaveLength(APP_INSTRUCTION_MAX_CHARS);
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(APP_INSTRUCTION_MAX_CHARS);
    const written = await layer.write('global', content);
    expect(written.find((f) => f.scope === 'global')?.truncated).toBeUndefined();
    expect(written.find((f) => f.scope === 'global')?.content === content).toBe(true);
    expect(await fs.readFile(path.join(dir, 'instructions', 'global.md'), 'utf8') === content).toBe(true);
    await layer.write('pi', '追加 🧭');
    const reloaded = new AppInstructions(dir);
    expect((await reloaded.read()).find((f) => f.scope === 'global')?.content === content).toBe(true);
    expect(await reloaded.effective('pi') === `${content}\n\n追加 🧭`).toBe(true);
    expect(await reloaded.effective('claude') === content).toBe(true);
  });

  it('rejects character overflow with character wording and leaves the previous file intact', async () => {
    const { store: layer, dir } = await store();
    await layer.write('global', 'Keep these rules.');
    await expect(layer.write('global', '😀'.repeat(APP_INSTRUCTION_MAX_CHARS / 2) + 'x')).rejects.toThrow(`Instructions are limited to ${APP_INSTRUCTION_MAX_CHARS} characters per file`);
    expect(await fs.readFile(path.join(dir, 'instructions', 'global.md'), 'utf8')).toBe('Keep these rules.');
    expect(await new AppInstructions(dir).effective('pi')).toBe('Keep these rules.');
  });

  it('does not split a surrogate pair at the character cap in a truncated file', async () => {
    const { store: layer, dir } = await store();
    const prefix = '界'.repeat(APP_INSTRUCTION_MAX_CHARS - 1);
    const content = `${prefix}😀tail`;
    await fs.mkdir(path.join(dir, 'instructions'), { recursive: true });
    const file = path.join(dir, 'instructions', 'global.md');
    await fs.writeFile(file, content, 'utf8');
    const read = (await layer.read()).find((f) => f.scope === 'global');
    expect(read?.truncated).toBe(true);
    expect(read?.content).toHaveLength(APP_INSTRUCTION_MAX_CHARS - 1);
    expect(read?.content === prefix).toBe(true);
    expect(await layer.effective('pi') === prefix).toBe(true);
    expect(await fs.readFile(file, 'utf8') === content).toBe(true);
  });

  it('reports a write failure and recovers on the next save and reload', async () => {
    const { store: layer, dir } = await store();
    await layer.write('pi', 'Original rules.');
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }));
    await expect(layer.write('pi', 'Failed rules.')).rejects.toThrow('injected disk full');
    expect(await fs.readFile(path.join(dir, 'instructions', 'pi.md'), 'utf8')).toBe('Original rules.');
    expect(await new AppInstructions(dir).effective('pi')).toBe('Original rules.');
    const recovered = await layer.write('pi', 'Recovered 界😀.');
    expect(recovered.find((f) => f.scope === 'pi')?.content).toBe('Recovered 界😀.');
    expect(await new AppInstructions(dir).effective('pi')).toBe('Recovered 界😀.');
  });

  it('flags a file larger than the cap instead of silently shortening the prompt', async () => {
    const { store: layer, dir } = await store();
    await fs.mkdir(path.join(dir, 'instructions'), { recursive: true });
    await fs.writeFile(path.join(dir, 'instructions', 'global.md'), 'x'.repeat(APP_INSTRUCTION_MAX_CHARS + 10), 'utf8');

    const read = (await layer.read()).find((f) => f.scope === 'global');
    expect(read?.truncated).toBe(true);
    expect(read?.content).toHaveLength(APP_INSTRUCTION_MAX_CHARS);
  });
});

describe('composing a session prompt', () => {
  const meta = (config: Partial<SessionMeta['config']>, knowledgeDigest?: string): Pick<SessionMeta, 'config' | 'knowledgeDigest'> => ({
    config: { harness: 'pi', projectRoot: 'G:/proj', permissionMode: 'ask', ...config },
    ...(knowledgeDigest ? { knowledgeDigest } : {})
  });

  it('puts the app layer first, then the session prompt, then the digest', () => {
    expect(sessionAppendPrompt(meta({ appendSystemPrompt: 'Session specific.' }, 'Digest.'), 'App layer.')).toBe('App layer.\n\nSession specific.\n\nDigest.');
  });

  it('leaves the prompt untouched when the layer is empty', () => {
    expect(sessionAppendPrompt(meta({ appendSystemPrompt: 'Session specific.' }), undefined)).toBe('Session specific.');
    expect(sessionAppendPrompt(meta({}), '   ')).toBeUndefined();
  });

  it('reaches the native loop, which rebuilds its prompt every step', async () => {
    const system = await buildSystemPrompt(os.tmpdir(), { planMode: false, append: sessionAppendPrompt(meta({}), 'App layer.'), model: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });
    expect(system).toContain('App layer.');
  });
});
