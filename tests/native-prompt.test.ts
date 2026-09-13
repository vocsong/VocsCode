/** The native system prompt names the model the same qualified way the UI does. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/main/harness/native/prompt';

let cwd: string | undefined;
afterEach(async () => {
  if (cwd) await fs.rm(cwd, { recursive: true, force: true });
  cwd = undefined;
});

describe('native system prompt', () => {
  it('names the model by provider, and keeps an aggregator route whole', async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'native-prompt-'));
    const prompt = await buildSystemPrompt(cwd, { planMode: false, model: { provider: 'openrouter', model: 'deepseek/deepseek-flash' } });
    expect(prompt).toContain('Model: openrouter/deepseek/deepseek-flash.');
  });

  it('keeps plan mode and appended instructions', async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'native-prompt-'));
    const prompt = await buildSystemPrompt(cwd, { planMode: true, append: 'Extra instruction.', model: { provider: 'deepseek', model: 'deepseek-v4-flash' } });
    expect(prompt).toContain('Model: deepseek/deepseek-v4-flash.');
    expect(prompt).toContain('PLAN MODE is active');
    expect(prompt).toContain('Extra instruction.');
  });
});
