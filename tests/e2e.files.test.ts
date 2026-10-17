/**
 * End-to-end flow for file mentions: a file path in a reply is a link, and clicking it opens the
 * file in the right panel's Files tab. The session and transcript are seeded on disk so no harness
 * and no provider key are involved. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
});

describe.runIf(enabled)('file mentions open in the Files panel', () => {
  it('decodes and previews inline Markdown screenshots from the session checkout without activating enclosing links', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-inline-images-'));
    const userData = path.join(tmp, 'profile');
    const project = path.join(tmp, 'project');
    const checkout = path.join(tmp, 'checkout');
    const imageDir = path.join(checkout, 'tests', 'artifacts');
    await fs.mkdir(imageDir, { recursive: true });
    await fs.mkdir(project);
    await fs.mkdir(userData);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const absolutePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const imagePath = path.join(imageDir, 'shot with spaces.png');
    const absoluteImagePath = path.join(imageDir, 'absolute shot.png');
    await fs.writeFile(imagePath, Buffer.from(png, 'base64'));
    await fs.writeFile(absoluteImagePath, Buffer.from(absolutePng, 'base64'));
    await fs.writeFile(path.join(tmp, 'outside.png'), Buffer.from(png, 'base64'));
    await fs.writeFile(path.join(checkout, '.env'), 'DO_NOT_RENDER_THIS_SECRET');
    await fs.writeFile(path.join(checkout, 'README.md'), 'An image preview must not open this file.');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const sid = 's_inline_images';
    const meta: SessionMeta = {
      id: sid, title: 'Inline screenshots', createdAt: 1, updatedAt: 1,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: checkout, status: 'idle', harnessRef: {}, queued: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    };
    const text = [
      '**Relative screenshot**', '![Relative screenshot](tests/artifacts/shot%20with%20spaces.png)',
      '**Absolute screenshot**', `![Absolute screenshot](<${absoluteImagePath.replace(/\\/g, '/')}>)`,
      '<a class="file-ref" data-file="README.md" role="link" tabindex="0">![Linked screenshot](tests/artifacts/shot%20with%20spaces.png)</a>',
      '![Missing screenshot](tests/artifacts/missing.png)',
      '![Outside screenshot](../outside.png)',
      '![Not an image](.env)',
    ].join('\n\n');
    const item: TranscriptItem = { id: 'answer', kind: 'assistant', ts: 1, text };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([meta]));
    await fs.mkdir(path.join(userData, 'sessions', sid), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', sid, 'transcript.jsonl'), JSON.stringify(item) + '\n');
    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: [...(packaged ? [] : [path.join(root, 'out', 'main', 'index.js')]), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData), timeout: 60_000,
    });
    const win = await app.firstWindow();
    for (const [name, data] of [['Relative screenshot', png], ['Absolute screenshot', absolutePng], ['Linked screenshot', png]]) {
      const image = win.getByRole('img', { name, exact: true });
      await image.waitFor({ timeout: 15_000 });
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15_000 }).toBe(1);
      expect(await image.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
    }
    const message = win.locator('[data-item-id="answer"]');
    expect(await message.getByRole('img').count()).toBe(3);
    expect(await message.innerText()).not.toContain('DO_NOT_RENDER_THIS_SECRET');
    await expect.poll(() => message.innerText(), { timeout: 15_000 }).toMatch(/unavailable/i);

    const preview = win.getByRole('dialog', { name: 'Image preview', exact: true });
    const expectPreview = async (name: string, data: string) => {
      await preview.waitFor({ state: 'visible', timeout: 10_000 });
      const image = preview.getByRole('img', { name, exact: true });
      await image.waitFor({ state: 'visible', timeout: 10_000 });
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(1);
      expect(await image.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
      expect(await preview.getByRole('img').count()).toBe(1);
    };

    await message.getByRole('button', { name: 'Preview Relative screenshot', exact: true }).click();
    await expectPreview('Relative screenshot', png);
    await preview.getByRole('button', { name: 'Next image', exact: true }).click();
    await expectPreview('Absolute screenshot', absolutePng);
    await preview.getByRole('button', { name: 'Previous image', exact: true }).click();
    await expectPreview('Relative screenshot', png);
    await win.keyboard.press('Escape');
    await preview.waitFor({ state: 'hidden', timeout: 10_000 });

    await message.getByRole('button', { name: 'Preview Absolute screenshot', exact: true }).click();
    await expectPreview('Absolute screenshot', absolutePng);
    await preview.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await preview.waitFor({ state: 'hidden', timeout: 10_000 });

    // Clicking the image inside a file link must only preview the image, not reveal README.md.
    const activeTabs = await win.locator('.panel-tab.active').allTextContents();
    expect(await message.locator('a.file-ref[data-file="README.md"]').count()).toBe(1);
    expect(await win.locator('.file-preview').count()).toBe(0);
    await message.getByRole('button', { name: 'Preview Linked screenshot', exact: true }).click();
    await expectPreview('Linked screenshot', png);
    expect(await win.locator('.panel-tab.active').allTextContents()).toEqual(activeTabs);
    expect(await win.locator('.file-preview').count()).toBe(0);
    await preview.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await preview.waitFor({ state: 'hidden', timeout: 10_000 });
    expect(await win.locator('.file-preview').count()).toBe(0);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'files-03-inline-images.png') });
  }, 120_000);

  it('clicking a file path in a reply previews that file', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-files-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    const body = Array.from({ length: 400 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
    await fs.writeFile(path.join(project, 'src', 'hello.ts'), body);
    // A 1x1 PNG beside it: the panel must draw it, not dump its bytes as text.
    await fs.writeFile(path.join(project, 'src', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
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
    const history: TranscriptItem[] = Array.from({ length: 400 }, (_, i) => ({
      id: `history${i}`, kind: 'assistant', ts: Date.now() - 1000 + i,
      text: i === 200 ? 'PerformanceNeedle: inspect `src/hello.ts:300`.' : `Historical reply ${i}`
    }));
    const items: TranscriptItem[] = [
      ...history,
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
      if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|OPENCODE|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
      env[k] = v;
    }
    env.VOCS_CODE_USER_DATA = userData;

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({ executablePath: packaged || (require('electron') as string), args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
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
    // The panel is split in two, so name the half the Files tab lives in rather than any panel body.
    const scrollTop = await win.locator('.panel-section.panel-top .panel-body').evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'files-01-preview.png') });

    // Deep search temporarily reveals history, then returns to a bounded list at the match.
    await win.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await win.getByPlaceholder('Search titles, goals and full transcripts…').fill('PerformanceNeedle');
    await win.getByRole('button', { name: /PerformanceNeedle/ }).click();
    const match = win.locator('[data-item-id="history200"]');
    await match.waitFor({ state: 'visible', timeout: 10_000 });
    await expect.poll(() => win.locator('.transcript.virtual').count(), { timeout: 10_000 }).toBe(1);
    expect(await win.locator('.transcript-row').count()).toBeLessThan(80);
    await match.getByRole('link', { name: 'src/hello.ts:300' }).click();
    expect(await win.locator('.file-preview pre').innerText()).toBe(body);

    // Back to the folder listing, then open the PNG: it renders as a decoded picture.
    await win.locator('.file-preview-head button[title="Close preview"]').click();
    await win.locator('.file-list .file-row', { hasText: 'pixel.png' }).click();
    await win.waitForSelector('.file-preview-head .mono:has-text("src/pixel.png")', { timeout: 10_000 });
    const img = win.locator('.file-preview .file-image img');
    await img.waitFor({ timeout: 10_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(1);
    expect(await win.locator('.file-preview pre').count()).toBe(0);
    await win.screenshot({ path: path.join(shots, 'files-02-image.png') });
  }, 180_000);
});
