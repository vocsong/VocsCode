/**
 * End-to-end flow for file mentions: a file path in a reply is a link, and clicking it opens the
 * file in the right panel's Files tab. The session and transcript are seeded on disk so no harness
 * and no provider key are involved. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

describe.runIf(enabled)('file mentions open in the Files panel', () => {
  it('clicking a file path in a reply previews that file', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-files-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    const body = Array.from({ length: 400 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
    await fs.writeFile(path.join(project, 'src', 'hello.ts'), body);
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const sid = 's_file_e2e';
    const session = {
      id: sid,
      title: 'File mentions',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      queued: 0
    } as SessionMeta;
    const items: TranscriptItem[] = [
      { id: 'u1', kind: 'user', ts: Date.now(), text: 'Where is the greeting?' },
      { id: 'a1', kind: 'assistant', ts: Date.now(), text: 'It lives in `src/hello.ts:300`, right at the top.' }
    ];
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', sid), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', sid, 'transcript.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
      // No key: the seeded transcript never runs a turn, which is exactly the point.
      if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
      env[k] = v;
    }
    env.VOCS_CODE_USER_DATA = userData;

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    const ref = win.locator('.transcript .file-ref', { hasText: 'src/hello.ts' });
    await ref.waitFor({ timeout: 30_000 });
    expect(await ref.innerText()).toBe('src/hello.ts:300');
    await ref.click();

    // The panel switched to Files and previewed the exact file, not just its folder.
    await win.waitForSelector('.panel-tab.active:has-text("Files")', { timeout: 10_000 });
    await win.waitForSelector('.file-preview-head .mono:has-text("src/hello.ts")', { timeout: 10_000 });
    await win.waitForSelector('.file-preview pre:has-text("line300 =")', { timeout: 10_000 });
    // The mention carried a line number, so the panel scrolled it into view instead of staying at the top.
    const scrollTop = await win.locator('.panel-body').evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'files-01-preview.png') });
  }, 180_000);
});
