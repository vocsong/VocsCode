/**
 * The app's own instruction layer: the files under `<userData>/instructions/`, how they compose for
 * a harness, and how a session receives them when its engine has no system prompt to add to.
 * Additive by design — a harness file never replaces the shared one.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
