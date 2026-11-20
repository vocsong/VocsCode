/**
 * End-to-end flow for file mentions: a file path in a reply is a link, and clicking it previews the
 * file in the split view, in a pane beside the session. The Files tab browses and opens files into
 * the same pane. The session and transcript are seeded on disk so no harness and no provider key are
 * involved. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
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

describe.runIf(enabled)('file mentions preview in the split view', () => {
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

  it('resolves exact and shortened reply paths within the session checkout and previews the chosen file', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-files-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const checkout = path.join(tmp, 'checkout');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(checkout, 'src', 'app', 'api', 'mcp'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    const body = Array.from({ length: 400 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
    await fs.writeFile(path.join(checkout, 'src', 'hello.ts'), body);
    const toolsBody = 'export const sessionCheckoutTools = true;\n';
    await fs.writeFile(path.join(checkout, 'src', 'app', 'api', 'mcp', 'tools.ts'), toolsBody);
    await fs.writeFile(path.join(project, 'tools.ts'), 'PROJECT_ROOT_TOOLS_MUST_NOT_OPEN');
    await fs.writeFile(path.join(project, 'SideGuard-Q-2026-10.zip'), 'PROJECT_ROOT_ONLY_MUST_NOT_OPEN');
    const exactBody = 'export const exactRootFile = true;\n';
    await fs.writeFile(path.join(checkout, 'exact.ts'), exactBody);
    await fs.writeFile(path.join(checkout, 'src', 'exact.ts'), 'NESTED_EXACT_MUST_NOT_OPEN');
    // Create the later-sorting candidate first: the chooser must still show sorted relative paths.
    const candidates = ['src/alpha/duplicate.ts', 'src/zeta/duplicate.ts'];
    const duplicateBody = 'export const chosenZetaFile = true;\n';
    for (const candidate of [...candidates].reverse()) {
      await fs.mkdir(path.dirname(path.join(checkout, candidate)), { recursive: true });
      await fs.writeFile(path.join(checkout, candidate), candidate === candidates[1] ? duplicateBody : 'ALPHA_MUST_NOT_OPEN_AUTOMATICALLY');
    }
    // A 1x1 PNG beside it: the panel must draw it, not dump its bytes as text.
    await fs.writeFile(path.join(checkout, 'src', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    // A zip's local file header: binary, so the panel must say so rather than decode it.
    await fs.writeFile(path.join(checkout, 'src', 'bundle.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]));
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const sid = 's_file_e2e';
    const session = {
      id: sid,
      title: 'File mentions',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: checkout,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
      queued: 0
    } as SessionMeta;
    const checkoutUrlPath = checkout.replace(/\\/g, '/');
    const absoluteLink = `${/^[A-Za-z]:/.test(checkoutUrlPath) ? '/' : ''}${checkoutUrlPath}/src/hello.ts:12`;
    const history: TranscriptItem[] = Array.from({ length: 400 }, (_, i) => ({
      id: `history${i}`, kind: 'assistant', ts: Date.now() - 1000 + i,
      text: i === 200 ? 'PerformanceNeedle: inspect `src/hello.ts:300`.' : `Historical reply ${i}`
    }));
    const items: TranscriptItem[] = [
      ...history,
      { id: 'u1', kind: 'user', ts: Date.now(), text: 'Where is the greeting?' },
      { id: 'a1', kind: 'assistant', ts: Date.now(), text: 'It lives in `src/hello.ts:300`, right at the top.' },
      // The missing name exists only in config.projectRoot, never in the session checkout.
      { id: 'a2', kind: 'assistant', ts: Date.now(), text: 'Import `SideGuard-Q-2026-10.zip`; the local copy is `src/bundle.zip`.' },
      { id: 'a3', kind: 'assistant', ts: Date.now(), text: 'Inspect `tools.ts`, `api/mcp/tools.ts`, `exact.ts`, and `duplicate.ts`.' },
      // Codex writes absolute links as URL paths (`/G:/…:12` on Windows); a mailto: link cannot open here.
      { id: 'a4', kind: 'assistant', ts: Date.now(), text: `See [the greeting](<${absoluteLink}>), or [write to support](mailto:help@example.com).` }
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
    // Sidebar, conversation, preview and right panel side by side: a CI runner's small display would
    // otherwise fold the split down to one pane.
    await win.setViewportSize({ width: 1600, height: 1000 });
    await win.waitForSelector('.brand', { timeout: 60_000 });
    const activeTab = await win.locator('.panel-tab.active').first().innerText();

    const ref = win.locator('.transcript .file-ref', { hasText: 'src/hello.ts' });
    await ref.waitFor({ timeout: 30_000 });
    expect(await ref.innerText()).toBe('src/hello.ts:300');
    await ref.click();

    // The file previews in a pane beside the conversation, which stays the active pane; the right
    // panel is left where it was.
    const filePane = win.getByTestId('file-pane');
    await filePane.waitFor({ state: 'visible', timeout: 10_000 });
    await win.waitForSelector('.file-preview-head .mono:has-text("src/hello.ts")', { timeout: 10_000 });
    await win.waitForSelector('.file-preview pre:has-text("line300 =")', { timeout: 10_000 });
    expect(await win.locator('[data-testid="session-panes"] > .pane').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))).toEqual(['session-pane', 'file-pane']);
    expect(await win.locator('[data-testid="session-pane"].active').count()).toBe(1);
    expect(await win.getByTestId('session-pane').isVisible()).toBe(true);
    expect(await win.locator('.panel-tab.active').first().innerText()).toBe(activeTab);
    const pillColors = (label: Locator) => label.locator('.harness-pill[data-harness="native"]').evaluate((el) => {
      const { color, backgroundColor } = getComputedStyle(el);
      return { color, backgroundColor };
    });
    const sessionLabel = ['Native', 'project', '|', session.title];
    const previewLabel = filePane.locator('.file-preview-head .session-label');
    await previewLabel.waitFor();
    expect(await previewLabel.locator(':scope > span').allTextContents()).toEqual(sessionLabel);
    const conversationColors = await pillColors(win.locator('.pane.active .header .session-label'));
    expect(await pillColors(previewLabel)).toEqual(conversationColors);
    // The mention carried a line number, so the preview scrolled it into view instead of staying at the top.
    const scrollTop = await filePane.locator('.file-preview pre').evaluate((el) => el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'files-01-preview.png') });

    // The missing name: a toast that names the file and the folder searched, without Electron's
    // IPC wrapper or Node's realpath error around it.
    await win.locator('.transcript .file-ref', { hasText: 'SideGuard-Q-2026-10.zip' }).click();
    const notFound = win.locator('.toast-error', { hasText: 'SideGuard-Q-2026-10.zip was not found in' });
    await notFound.waitFor({ timeout: 10_000 });
    expect(await notFound.innerText()).not.toMatch(/ENOENT|realpath/);
    expect(await notFound.innerText()).toContain(checkout);
    expect(await notFound.innerText()).not.toContain(project);
    expect(await win.locator('.toast', { hasText: 'Error invoking remote method' }).count()).toBe(0);

    // The zip that is there opens as a binary file with no text dump.
    await win.locator('.transcript .file-ref', { hasText: 'src/bundle.zip' }).click();
    await win.waitForSelector('.file-preview-head .mono:has-text("src/bundle.zip")', { timeout: 10_000 });
    await win.getByText('Binary file, no text preview.', { exact: true }).waitFor({ timeout: 10_000 });
    expect(await win.locator('.file-preview pre').count()).toBe(0);
    await win.screenshot({ path: path.join(shots, 'files-04-missing-and-binary.png') });

    // Short mentions resolve against the session checkout, not the configured project root.
    // Keep these clicks before history search, which virtualizes away the recent replies.
    const shortRefs = win.locator('[data-item-id="a3"]');
    const expectFile = async (relativePath: string, content: string) => {
      await expect.poll(() => win.locator('.file-preview-head .mono').innerText(), { timeout: 10_000 }).toBe(relativePath);
      expect(await win.locator('.file-preview pre').innerText()).toBe(content);
      expect(await win.getByRole('region', { name: 'Choose a file', exact: true }).count()).toBe(0);
    };
    await shortRefs.getByRole('link', { name: 'tools.ts', exact: true }).click();
    await expectFile('src/app/api/mcp/tools.ts', toolsBody);
    await win.locator('.file-preview-head button[title="Close preview"]').click();
    await shortRefs.getByRole('link', { name: 'api/mcp/tools.ts', exact: true }).click();
    await expectFile('src/app/api/mcp/tools.ts', toolsBody);

    // An existing literal path wins even when a nested file has the same basename.
    await shortRefs.getByRole('link', { name: 'exact.ts', exact: true }).click();
    await expectFile('exact.ts', exactBody);

    // A Codex-style absolute link inside the checkout opens as a workspace path; the link nothing here
    // can open is plain text, not a coloured link that does nothing.
    const links = win.locator('[data-item-id="a4"]');
    await links.getByRole('link', { name: 'the greeting', exact: true }).click();
    await expectFile('src/hello.ts', body);
    expect(await links.getByRole('link').count()).toBe(1);
    expect(await links.locator('.md-link-text').innerText()).toBe('write to support');
    expect(await links.locator('a:not([href]):not([data-file])').count()).toBe(0);
    await win.locator('.file-preview-head button[title="Close preview"]').click();
    await filePane.waitFor({ state: 'detached', timeout: 10_000 });

    // An ambiguous basename must not silently preview either file before a choice.
    const chooser = win.getByRole('region', { name: 'Choose a file', exact: true });
    const expectChoices = async () => {
      await chooser.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await win.locator('.file-match-list .file-row').allTextContents()).toEqual(candidates);
      expect(await chooser.getByRole('button').count()).toBe(3);
      for (const candidate of candidates) {
        expect(await chooser.getByRole('button', { name: candidate, exact: true }).count()).toBe(1);
      }
      expect(await win.locator('.file-preview').count()).toBe(0);
    };
    await shortRefs.getByRole('link', { name: 'duplicate.ts', exact: true }).click();
    await expectChoices();
    await win.screenshot({ path: path.join(shots, 'files-05-path-chooser.png') });
    await chooser.getByRole('button', { name: 'Cancel', exact: true }).click();
    await chooser.waitFor({ state: 'hidden', timeout: 10_000 });
    expect(await win.locator('.file-preview').count()).toBe(0);
    expect(await win.locator('.file-match-list .file-row').count()).toBe(0);
    // Cancelling with nothing previewed closes the pane: the conversation has the room back.
    await filePane.waitFor({ state: 'detached', timeout: 10_000 });

    await shortRefs.getByRole('link', { name: 'duplicate.ts', exact: true }).click();
    await expectChoices();
    await chooser.getByRole('button', { name: candidates[1], exact: true }).click();
    await expectFile(candidates[1], duplicateBody);

    // Deep search temporarily reveals history, then returns to a bounded list at the match.
    await win.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await win.getByPlaceholder('Search titles, goals and full transcripts…').fill('PerformanceNeedle');
    const result = win.getByRole('button', { name: /PerformanceNeedle/ });
    const resultLabel = result.locator('.session-label');
    await resultLabel.waitFor();
    expect(await resultLabel.locator(':scope > span').allTextContents()).toEqual(sessionLabel);
    expect(await pillColors(resultLabel)).toEqual(conversationColors);
    await result.click();
    const match = win.locator('[data-item-id="history200"]');
    await match.waitFor({ state: 'visible', timeout: 10_000 });
    await expect.poll(() => win.locator('.transcript.virtual').count(), { timeout: 10_000 }).toBe(1);
    expect(await win.locator('.transcript-row').count()).toBeLessThan(80);
    await match.getByRole('link', { name: 'src/hello.ts:300' }).click();
    await expect.poll(() => win.locator('.file-preview pre').innerText(), { timeout: 10_000 }).toBe(body);

    // The Files tab browses; opening the PNG from it previews in the same pane, as a decoded picture.
    await win.locator('.file-preview-head button[title="Close preview"]').click();
    await filePane.waitFor({ state: 'detached', timeout: 10_000 });
    await win.locator('.panel .panel-tab', { hasText: 'Files' }).click();
    await win.locator('.files .file-list .file-row', { hasText: /^\s*src\s*$/ }).click();
    const pixelRow = win.locator('.files .file-list .file-row', { hasText: 'pixel.png' });
    await pixelRow.click();
    await filePane.waitFor({ state: 'visible', timeout: 10_000 });
    await win.waitForSelector('.file-preview-head .mono:has-text("src/pixel.png")', { timeout: 10_000 });
    const img = filePane.locator('.file-preview .file-image img');
    await img.waitFor({ timeout: 10_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(1);
    expect(await win.locator('.file-preview pre').count()).toBe(0);
    // The panel stays a browser: the preview is not in it, and its row shows what is open.
    expect(await win.locator('.panel .file-preview').count()).toBe(0);
    await expect.poll(() => pixelRow.getAttribute('class')).toContain('active');
    await win.screenshot({ path: path.join(shots, 'files-02-image.png') });
  }, 180_000);
});
