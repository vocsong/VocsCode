/**
 * End-to-end flow for the file preview overlay: transcript links and Files rows open the same
 * preview, and edits save to the local checkout. Sessions and transcripts are seeded on disk so no
 * harness or provider key is involved. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
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

// All lines of these short fixtures fit in CodeMirror's rendered viewport.
async function expectEditorText(editor: Locator, text: string) {
  await expect.poll(() => editor.locator('.cm-line').allTextContents(), { timeout: 10_000 }).toEqual(text.split('\n'));
}

async function captureImageCopies(win: Page) {
  // Keep writes in this test's renderer; ClipboardItem and all canvas operations stay native.
  const writes = await win.evaluateHandle(() => {
    const records: { types: string[]; mime: string; size: number[]; corners: number[][] }[] = [];
    navigator.clipboard.write = async (items) => {
      const [item] = items;
      if (items.length !== 1 || !(item instanceof ClipboardItem)) throw new Error('Expected one ClipboardItem');
      const blob = await item.getType('image/png');
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      records.push({
        types: [...item.types], mime: blob.type, size: [canvas.width, canvas.height],
        corners: [pixel(0, 0), pixel(canvas.width - 1, canvas.height - 1)],
      });
    };
    return records;
  });
  return () => writes.evaluate((records) => records);
}

async function copyPreviewImage(win: Page, image: Locator) {
  const menu = win.getByTestId('context-menu');
  await image.click({ button: 'right', timeout: 10_000 });
  await menu.getByRole('menuitem', { name: 'Copy image', exact: true }).click({ timeout: 10_000 });
  await menu.waitFor({ state: 'hidden', timeout: 10_000 });
  await win.locator('.toast').getByText('Image copied', { exact: true }).waitFor({ timeout: 10_000 });
}

// Two vertical bands make the panned image recognizable without an external fixture.
function widePreviewPng(width: number, height: number): Buffer {
  const chunk = (name: string, data: Buffer = Buffer.alloc(0)) => {
    const bytes = Buffer.concat([Buffer.from(name, 'ascii'), data]);
    const length = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(bytes));
    return Buffer.concat([length, bytes, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit grayscale.
  const row = Buffer.alloc(width + 1, 64);
  row[0] = 0; // No row filter.
  row.fill(192, 1 + Math.floor(width / 2));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(row.length * height, row))), chunk('IEND'),
  ]);
}

describe.runIf(enabled)('workspace file previews and editing', () => {
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
    // Red on the left, green on the right, and wider than the lightbox can render.
    const absolutePng = 'iVBORw0KGgoAAAANSUhEUgAABkAAAAAIAQMAAACbGaHfAAAABlBMVEX/AAAA/wDSh+9xAAAAH0lEQVR42mNgoAP4TwfAMOqRUY+MemTUI6MeGQiPAACbjR0OCIf8eAAAAABJRU5ErkJggg==';
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
      [
        '[External site](https://example.invalid/docs)',
        '[Demo pull request](https://github.com/demo/repo/pull/1)',
        '[Workspace readme](README.md)',
        '[Artifact folder](tests/artifacts/)',
        '[Screenshot file](tests/artifacts/shot%20with%20spaces.png)',
        `[Outside file](<${path.join(tmp, 'outside.png').replace(/\\/g, '/')}>)`,
        '[Send mail](mailto:help@example.com)',
        '[Section anchor](#section)',
      ].join(' · '),
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
    await win.setViewportSize({ width: 1440, height: 900 });
    for (const [name, data, width] of [
      ['Relative screenshot', png, 1], ['Absolute screenshot', absolutePng, 1600], ['Linked screenshot', png, 1],
    ] as const) {
      const image = win.getByRole('img', { name, exact: true });
      await image.waitFor({ timeout: 15_000 });
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 15_000 }).toBe(width);
      expect(await image.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
    }
    const message = win.locator('.transcript [data-item-id="answer"]');
    expect(await message.getByRole('img').count()).toBe(3);
    expect(await message.innerText()).not.toContain('DO_NOT_RENDER_THIS_SECRET');
    await expect.poll(() => message.innerText(), { timeout: 15_000 }).toMatch(/unavailable/i);

    // Read the actual painted colors without following links or opening the network or file manager.
    const markdown = message.locator('.md');
    const actions = [
      ['external', 'External site'], ['pr', 'Demo pull request'], ['file', 'Workspace readme'],
      ['folder', 'Artifact folder'], ['image-file', 'Screenshot file'], ['explorer', 'Outside file'],
      ['image-preview', 'Preview Relative screenshot'],
    ] as const;
    const colors = await Promise.all(actions.map(async ([kind, name]) => {
      const action = markdown.getByRole(kind === 'image-preview' ? 'button' : 'link', { name, exact: true });
      await action.waitFor({ timeout: 10_000 });
      expect(await action.getAttribute('data-link-kind'), name).toBe(kind);
      return action.evaluate((el) => getComputedStyle(el).color);
    }));
    expect(new Set(colors).size).toBe(actions.length);
    for (const name of ['Send mail', 'Section anchor']) {
      const plain = markdown.getByText(name, { exact: true });
      expect(await markdown.getByRole('link', { name, exact: true }).count()).toBe(0);
      expect(await plain.evaluate((el) => {
        const { color, cursor } = getComputedStyle(el);
        return { kind: el.getAttribute('data-link-kind'), inheritsColor: color === getComputedStyle(el.parentElement!).color, cursor };
      })).toEqual({ kind: null, inheritsColor: true, cursor: 'text' });
    }

    const preview = win.getByRole('dialog', { name: 'Image preview', exact: true });
    const expectPreview = async (name: string, data: string, width = 1) => {
      await preview.waitFor({ state: 'visible', timeout: 10_000 });
      const image = preview.getByRole('img', { name, exact: true });
      await image.waitFor({ state: 'visible', timeout: 10_000 });
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(width);
      expect(await image.getAttribute('src')).toBe(`data:image/png;base64,${data}`);
      expect(await preview.getByRole('img').count()).toBe(1);
      return image;
    };

    await message.getByRole('button', { name: 'Preview Relative screenshot', exact: true }).click();
    await expectPreview('Relative screenshot', png);
    await preview.getByRole('button', { name: 'Next image', exact: true }).click();
    const nextImage = await expectPreview('Absolute screenshot', absolutePng, 1600);
    expect(await nextImage.evaluate((el: HTMLImageElement) => el.width < el.naturalWidth)).toBe(true);
    const readCopies = await captureImageCopies(win);
    const menu = win.getByTestId('context-menu');
    await nextImage.click({ button: 'right', timeout: 10_000 });
    await menu.getByRole('menuitem', { name: 'Copy image', exact: true }).waitFor({ timeout: 10_000 });
    await win.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden', timeout: 10_000 });
    await expectPreview('Absolute screenshot', absolutePng, 1600);
    expect(await readCopies()).toEqual([]);

    await copyPreviewImage(win, nextImage);
    expect(await readCopies()).toEqual([{
      types: ['image/png'], mime: 'image/png', size: [1600, 8], corners: [[255, 0, 0, 255], [0, 255, 0, 255]],
    }]);
    await expectPreview('Absolute screenshot', absolutePng, 1600);
    await preview.getByRole('button', { name: 'Previous image', exact: true }).click();
    await expectPreview('Relative screenshot', png);
    await win.keyboard.press('Escape');
    await preview.waitFor({ state: 'hidden', timeout: 10_000 });

    await message.getByRole('button', { name: 'Preview Absolute screenshot', exact: true }).click();
    await expectPreview('Absolute screenshot', absolutePng, 1600);
    await preview.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await preview.waitFor({ state: 'hidden', timeout: 10_000 });

    // Clicking the image inside a file link must only preview the image, not reveal README.md.
    const activeTabs = await win.locator('.panel-tab.active').allTextContents();
    const linkedImage = message.locator('a.file-ref[data-file="README.md"]').getByRole('button', { name: 'Preview Linked screenshot', exact: true });
    expect(await linkedImage.count()).toBe(1);
    expect(await win.locator('.file-preview').count()).toBe(0);
    await linkedImage.click();
    await expectPreview('Linked screenshot', png);
    expect(await win.locator('.panel-tab.active').allTextContents()).toEqual(activeTabs);
    expect(await win.locator('.file-preview').count()).toBe(0);
    await preview.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await preview.waitFor({ state: 'hidden', timeout: 10_000 });
    expect(await win.locator('.file-preview').count()).toBe(0);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'files-03-inline-images.png') });
  }, 120_000);

  it('zooms the image lightbox with the wheel and bounds click-drag panning', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-image-zoom-'));
    onTestFinished(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const userData = path.join(tmp, 'profile');
    const project = path.join(tmp, 'project');
    const sid = 's_image_zoom';
    const sessionDir = path.join(userData, 'sessions', sid);
    const naturalWidth = 2560;
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'wide.png'), widePreviewPng(naturalWidth, 512));
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const session: SessionMeta = {
      id: sid, title: 'Image zoom', createdAt: 1, updatedAt: 1,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project, status: 'idle', harnessRef: {}, queued: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    };
    const item: TranscriptItem = { id: 'reply', kind: 'assistant', ts: 1, text: '![Wide screenshot](wide.png)' };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.writeFile(path.join(sessionDir, 'transcript.jsonl'), JSON.stringify(item) + '\n');
    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: [...(packaged ? [] : [path.join(root, 'out', 'main', 'index.js')]), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData), timeout: 60_000,
    });
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1280, height: 800 });
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await win.getByRole('button', { name: 'Preview Wide screenshot', exact: true }).click({ timeout: 15_000 });

    const dialog = win.getByRole('dialog', { name: 'Image preview', exact: true });
    const viewport = dialog.locator('.image-lightbox-viewport');
    const image = dialog.getByRole('img', { name: 'Wide screenshot', exact: true });
    const zoomButton = (name: string) => dialog.getByRole('button', { name, exact: true });
    const reset = zoomButton('Reset zoom');
    await zoomButton('Close image preview').waitFor({ state: 'visible', timeout: 10_000 });
    await reset.waitFor({ state: 'visible', timeout: 10_000 });
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(naturalWidth);
    const box = async (locator: Locator) => {
      const bounds = await locator.boundingBox({ timeout: 1_000 });
      if (!bounds) throw new Error(`No rendered box for ${locator}`);
      return bounds;
    };
    const imageBox = () => box(image);
    const imageWidth = async () => (await imageBox()).width;
    const percent = async () => (await reset.innerText({ timeout: 1_000 })).trim();
    const stage = await box(viewport);
    const stageRight = stage.x + stage.width;
    const fit = await imageBox();
    const tolerance = 3; // CSS pixels: tolerate subpixel layout and mouse coordinate rounding.
    expect(fit.width).toBeLessThan(naturalWidth);
    expect(fit.width).toBeLessThanOrEqual(stage.width + tolerance);
    expect(await percent()).toBe('100%');

    // Zoom off-center. An image point under the pointer should stay there instead of zooming around the middle.
    const anchorX = Math.round(fit.x + fit.width * 0.65);
    const centerY = Math.round(fit.y + fit.height / 2);
    await win.mouse.move(anchorX, centerY);
    await win.mouse.wheel(0, -120);
    await expect.poll(imageWidth, { timeout: 5_000, message: 'wheel up widens the fitted image' }).toBeGreaterThan(stage.width + tolerance);
    const enlarged = await imageBox();
    const anchoredX = enlarged.x + (anchorX - fit.x) * enlarged.width / fit.width;
    expect(Math.abs(anchoredX - anchorX), 'zoom keeps the same horizontal image point under the pointer').toBeLessThanOrEqual(tolerance);
    expect(Number.parseFloat(await percent())).toBeGreaterThan(100);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'files-06-image-zoom.png') });

    // A smaller reverse wheel gesture shrinks the image but leaves room for a bounded horizontal pan.
    await win.mouse.wheel(0, 60);
    await expect.poll(imageWidth, { timeout: 5_000, message: 'wheel down shrinks the zoomed image' }).toBeLessThan(enlarged.width - tolerance);
    const wheelOut = await imageWidth();
    await zoomButton('Zoom in').click({ timeout: 5_000 });
    await expect.poll(imageWidth, { timeout: 5_000 }).toBeGreaterThan(wheelOut + tolerance);
    const buttonIn = await imageWidth();
    await zoomButton('Zoom out').click({ timeout: 5_000 });
    await expect.poll(imageWidth, { timeout: 5_000 }).toBeLessThan(buttonIn - tolerance);

    const beforeDrag = await imageBox();
    expect(beforeDrag.x).toBeLessThan(stage.x - tolerance);
    expect(beforeDrag.x + beforeDrag.width).toBeGreaterThan(stageRight + tolerance);
    expect(beforeDrag.y).toBeGreaterThan(stage.y + 2 * tolerance);
    const blankY = (stage.y + beforeDrag.y) / 2;
    const centerX = stage.x + stage.width / 2;
    const leftX = stage.x + stage.width * 0.1;
    const rightX = stage.x + stage.width * 0.9;
    const expectPanLimit = (side: 'left' | 'right') => expect.poll(async () => {
      const moved = await imageBox();
      const gap = side === 'left' ? moved.x - stage.x : moved.x + moved.width - stageRight;
      return Math.max(Math.abs(gap), Math.abs(moved.y - beforeDrag.y));
    }, { timeout: 5_000, message: `drag reaches the ${side} viewport edge without vertical pan` }).toBeLessThanOrEqual(tolerance);

    // Leave the image before moving horizontally, then overshoot both edges while over blank space.
    await win.mouse.move(centerX, centerY);
    await win.mouse.down();
    try {
      await win.mouse.move(centerX, blankY, { steps: 4 });
      await win.mouse.move(rightX, blankY, { steps: 8 });
      await expectPanLimit('left');
      await win.mouse.move(leftX, blankY, { steps: 8 });
      await expectPanLimit('right');
    } finally {
      await win.mouse.up();
    }
    expect(await dialog.isVisible(), 'releasing a drag over the backdrop does not close the lightbox').toBe(true);
    await win.mouse.move(centerX, centerY);
    await expectPanLimit('right');

    await reset.click({ timeout: 5_000 });
    await expect.poll(percent, { timeout: 5_000 }).toBe('100%');
    await expect.poll(async () => {
      const restored = await imageBox();
      return Math.max(...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(restored[key] - fit[key])));
    }, { timeout: 5_000, message: 'reset restores the fitted image size and position' }).toBeLessThanOrEqual(tolerance);
    await win.mouse.click(leftX, blankY);
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  }, 120_000);

  it('resolves exact and shortened reply paths within the session checkout and previews the chosen file', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-files-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const checkout = path.join(tmp, 'checkout');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(checkout, 'src', 'app', 'api', 'mcp'), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    const body = Array.from({ length: 400 }, (_, i) => i === 299
      ? 'export const line300 = "target";'
      : `export const line${i + 1} = ${i + 1};`).join('\n') + '\n';
    await fs.writeFile(path.join(checkout, 'src', 'hello.ts'), body);
    const toolsBody = 'export const sessionCheckoutTools = true;\n';
    await fs.writeFile(path.join(checkout, 'src', 'app', 'api', 'mcp', 'tools.ts'), toolsBody);
    await fs.writeFile(path.join(project, 'tools.ts'), 'PROJECT_ROOT_TOOLS_MUST_NOT_OPEN');
    const missingZip = 'SideGuard-Q-2026-10.zip';
    const lookupPath = path.join(checkout, missingZip);
    await fs.writeFile(path.join(project, missingZip), 'PROJECT_ROOT_ONLY_MUST_NOT_OPEN');
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
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    await fs.writeFile(path.join(checkout, 'src', 'bundle.zip'), zipHeader);
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'system', palette: 'dusk' }));

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
    const searchNeedle = 'PerformanceNeedle';
    const history: TranscriptItem[] = Array.from({ length: 400 }, (_, i) => ({
      id: `history${i}`, kind: 'assistant', ts: Date.now() - 1000 + i,
      text: i === 200 ? `${searchNeedle}: inspect \`src/hello.ts:300\`.` : `Historical reply ${i}`
    }));
    const items: TranscriptItem[] = [
      ...history,
      { id: 't1', kind: 'tool', ts: Date.now(), name: 'diagnostics', status: 'done', output: `${searchNeedle}: tool-only diagnostic.` },
      { id: 'u1', kind: 'user', ts: Date.now(), text: 'Where is the greeting?' },
      { id: 'a1', kind: 'assistant', ts: Date.now(), text: 'It lives in `src/hello.ts:300`, right at the top.' },
      // The missing name starts out in config.projectRoot only, not in the session checkout.
      { id: 'a2', kind: 'assistant', ts: Date.now(), text: `Import \`${missingZip}\`; the local copy is \`src/bundle.zip\`.` },
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
    await win.setViewportSize({ width: 1600, height: 1000 });
    await win.waitForSelector('.brand', { timeout: 60_000 });

    const ref = win.locator('[data-item-id="a1"]').getByRole('link', { name: 'src/hello.ts:300', exact: true });
    const missingLink = win.locator('[data-item-id="a2"]').getByRole('link', { name: missingZip, exact: true });
    const filePane = win.getByTestId('file-pane');
    const editor = filePane.locator('.cm-editor').getByRole('textbox', { name: 'File contents', exact: true });
    const previewPath = filePane.locator('.file-preview-path');
    const closePreview = async () => {
      await filePane.getByRole('button', { name: 'Close preview', exact: true }).click();
      await filePane.waitFor({ state: 'detached', timeout: 10_000 });
    };
    const expectPath = async (relativePath: string) => {
      expect(await previewPath.innerText()).toBe(relativePath);
      expect(await filePane.getByRole('region', { name: 'Choose a file', exact: true }).count()).toBe(0);
    };
    const expectFile = async (relativePath: string, content: string) => {
      await expectEditorText(editor, content);
      await expectPath(relativePath);
    };
    const expectHelloLine = async (lineNumber: number) => {
      const line = editor.locator('.cm-line.cm-activeLine').filter({ hasText: new RegExp(`^export const line${lineNumber} = `) });
      await line.waitFor({ timeout: 10_000 });
      // CodeMirror virtualizes the document and can render lines just outside the scroll viewport.
      await expect.poll(() => line.evaluate((el) => {
        const scroller = el.closest('.cm-scroller')!;
        const row = el.getBoundingClientRect();
        const top = scroller.getBoundingClientRect().top + scroller.clientTop;
        return row.height > 0 && row.top >= top && row.bottom <= top + scroller.clientHeight;
      }, undefined, { timeout: 1_000 }), { timeout: 10_000 }).toBe(true);
      await expectPath('src/hello.ts');
    };
    const alert = filePane.getByRole('alert');
    const retry = filePane.getByRole('button', { name: 'Retry', exact: true });
    const copyPath = filePane.getByRole('button', { name: 'Copy path', exact: true });
    const errorToasts = win.locator('.toast-error');
    const expectMissing = async () => {
      await alert.first().waitFor({ state: 'visible', timeout: 10_000 });
      expect(await alert.count()).toBe(1);
      const text = await alert.innerText();
      expect(text).toContain(`${missingZip} was not found in ${checkout}`);
      expect(text).not.toContain(project);
      expect(await retry.isEnabled()).toBe(true);
      expect(text).not.toMatch(/ENOENT|realpath|Error invoking remote method/);
      expect(await copyPath.isVisible()).toBe(true);
      expect(await errorToasts.count()).toBe(0);
    };

    // A failed first open keeps the drawer visible even without a prior file to show.
    await missingLink.click({ timeout: 30_000 });
    await expectMissing();
    expect(await editor.count()).toBe(0);
    await closePreview();

    // The preview overlays the transcript without becoming a session split or taking its active slot.
    await ref.click({ timeout: 30_000 });
    await expectHelloLine(300);
    expect(await win.getByTestId('session-panes').getByTestId('file-pane').count()).toBe(0);
    expect(await win.locator('[data-testid="session-pane"].active').count()).toBe(1);
    expect(await win.getByTestId('session-pane').isVisible()).toBe(true);
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

    // Check the painted gutter and syntax colors as the System scheme changes in the open editor.
    const syntaxLine = editor.locator('.cm-line').filter({ hasText: /^export const line300 = "target";$/ });
    const keyword = syntaxLine.locator('span').filter({ hasText: /^export$/ });
    const string = syntaxLine.locator('span').filter({ hasText: /^"target"$/ });
    const syntaxColors = () => Promise.all([keyword, string].map((token) => token.evaluate((el) => getComputedStyle(el).color)));
    const expectGutterPalette = async (scheme: 'light' | 'dark') => {
      await expect.poll(() => win.locator('html').getAttribute('data-scheme')).toBe(scheme);
      const { actual, expected } = await filePane.locator('.cm-gutters-before').evaluate((gutter) => {
        const gutterStyle = getComputedStyle(gutter);
        const activeStyle = getComputedStyle(gutter.querySelector('.cm-activeLineGutter')!);
        // Resolve tokens through Chromium too, so hex and color-mix() use the same serialization.
        const swatch = document.createElement('span');
        swatch.hidden = true;
        document.body.append(swatch);
        const color = (token: string) => {
          swatch.style.color = `var(${token})`;
          return getComputedStyle(swatch).color;
        };
        try {
          return {
            actual: [gutterStyle.backgroundColor, gutterStyle.color, gutterStyle.borderRightColor, activeStyle.backgroundColor, activeStyle.color],
            expected: [color('--bg-sunken'), color('--fg-muted'), color('--border'), color('--accent-soft'), color('--fg')],
          };
        } finally {
          swatch.remove();
        }
      });
      expect(actual, `${scheme} gutter colors`).toEqual(expected);
    };
    await win.emulateMedia({ colorScheme: 'light' });
    await keyword.waitFor({ timeout: 10_000 });
    await string.waitFor({ timeout: 10_000 });
    await expectGutterPalette('light');
    const lightColors = await syntaxColors();
    expect(lightColors[0]).not.toBe(lightColors[1]);
    await win.emulateMedia({ colorScheme: 'dark' });
    await expectGutterPalette('dark');
    const darkColors = await syntaxColors();
    expect(darkColors).not.toEqual(lightColors);
    expect(darkColors[0]).not.toBe(darkColors[1]);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'files-01-preview.png') });
    await win.emulateMedia({ colorScheme: null });

    // Use the keyboard to follow the covered link. Repeated misses keep the same editor and line
    // in view, with one inline alert and no error toasts.
    const originalEditor = await editor.elementHandle({ timeout: 10_000 });
    const expectMissingWithEditor = async (startLookup: () => Promise<void>) => {
      const [previousAlert] = await alert.elementHandles();
      try {
        await startLookup();
        // The old alert can still be visible when the action returns. Wait on that node,
        // not the locator, so a fast lookup that already replaced it also works.
        await previousAlert?.waitForElementState('hidden', { timeout: 10_000 });
        await expectMissing();
        await expectHelloLine(300);
        expect(await originalEditor.evaluate((el) => el.isConnected)).toBe(true);
      } finally {
        await previousAlert?.dispose();
      }
    };
    await expectMissingWithEditor(() => missingLink.press('Enter'));
    await expectMissingWithEditor(() => missingLink.press('Enter'));
    await expectMissingWithEditor(() => retry.click());
    await originalEditor.dispose();

    // Read the clipboard write without modifying the system clipboard.
    const copiedPaths = await win.evaluateHandle(() => {
      const writes: string[] = [];
      navigator.clipboard.writeText = async (text) => { writes.push(text); };
      return writes;
    });
    await copyPath.click();
    await expect.poll(() => copiedPaths.evaluate((writes) => writes), { timeout: 10_000 }).toEqual([lookupPath]);
    await copiedPaths.dispose();
    await win.screenshot({ path: path.join(shots, 'files-04-missing.png') });

    const expectBinaryFile = async (relativePath: string) => {
      await filePane.getByText('Binary file, no text preview.', { exact: true }).waitFor({ timeout: 10_000 });
      await expectPath(relativePath);
      expect(await editor.count()).toBe(0);
      expect(await filePane.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
    };
    // Retry now opens the checkout zip, not the text file with the same name in the project root.
    await fs.writeFile(lookupPath, zipHeader);
    await retry.click();
    await expectBinaryFile(missingZip);
    await alert.waitFor({ state: 'detached', timeout: 10_000 });
    expect(await errorToasts.count()).toBe(0);
    await closePreview();

    // An existing zip still opens directly as a binary file.
    await win.getByRole('link', { name: 'src/bundle.zip', exact: true }).click();
    await expectBinaryFile('src/bundle.zip');
    await win.screenshot({ path: path.join(shots, 'files-04-binary.png') });
    await closePreview();

    // Short mentions resolve against the session checkout, not the configured project root.
    // Keep these clicks before history search, which virtualizes away the recent replies.
    const shortRefs = win.locator('[data-item-id="a3"]');
    await shortRefs.getByRole('link', { name: 'tools.ts', exact: true }).click();
    await expectFile('src/app/api/mcp/tools.ts', toolsBody);
    await closePreview();
    await shortRefs.getByRole('link', { name: 'api/mcp/tools.ts', exact: true }).click();
    await expectFile('src/app/api/mcp/tools.ts', toolsBody);
    await closePreview();

    // An existing literal path wins even when a nested file has the same basename.
    await shortRefs.getByRole('link', { name: 'exact.ts', exact: true }).click();
    await expectFile('exact.ts', exactBody);
    await closePreview();

    // A Codex-style absolute link inside the checkout opens as a workspace path; the link nothing here
    // can open is plain text, not a coloured link that does nothing.
    const links = win.locator('[data-item-id="a4"]');
    await links.getByRole('link', { name: 'the greeting', exact: true }).click();
    await expectHelloLine(12);
    expect(await links.getByRole('link').count()).toBe(1);
    expect(await links.locator('.md-link-text').innerText()).toBe('write to support');
    expect(await links.locator('a:not([href]):not([data-file])').count()).toBe(0);
    await closePreview();

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
    // Cancelling with nothing previewed dismisses the overlay.
    await filePane.waitFor({ state: 'detached', timeout: 10_000 });

    await shortRefs.getByRole('link', { name: 'duplicate.ts', exact: true }).click();
    await expectChoices();
    await chooser.getByRole('button', { name: candidates[1], exact: true }).click();
    await expectFile(candidates[1], duplicateBody);
    await closePreview();

    // The same query matches both items in All content, but the scopes separate them.
    await win.getByRole('button', { name: 'Search sessions', exact: true }).click();
    const search = win.locator('.search-palette');
    const searchInput = search.getByLabel('Search sessions', { exact: true });
    const category = (name: string) => search.getByRole('button', { name, exact: true });
    const allPlaceholder = 'Search titles, goals and full transcripts…';
    expect(await category('All content').getAttribute('aria-pressed')).toBe('true');
    for (const label of ['Session names', 'Goals', 'Transcript', 'Tool output']) {
      expect(await category(label).getAttribute('aria-pressed')).toBe('false');
    }
    expect(await searchInput.getAttribute('placeholder')).toBe(allPlaceholder);
    await searchInput.fill(searchNeedle);
    const result = search.getByRole('button', { name: /inspect.*src\/hello\.ts:300/ });
    const toolResult = search.getByRole('button', { name: /tool-only diagnostic/ });
    await result.waitFor({ timeout: 10_000 });
    await toolResult.waitFor({ timeout: 10_000 });

    await category('Tool output').click();
    expect(await category('Tool output').getAttribute('aria-pressed')).toBe('true');
    expect(await searchInput.getAttribute('placeholder')).not.toBe(allPlaceholder);
    await result.waitFor({ state: 'hidden', timeout: 10_000 });
    await toolResult.waitFor({ timeout: 10_000 });
    expect(await result.count()).toBe(0);

    // Jump via Transcript: reveal history, then return to a bounded list at the match.
    await category('Transcript').click();
    expect(await category('Transcript').getAttribute('aria-pressed')).toBe('true');
    const resultLabel = result.locator('.session-label');
    await resultLabel.waitFor({ timeout: 10_000 });
    expect(await toolResult.count()).toBe(0);
    expect(await resultLabel.locator(':scope > span').allTextContents()).toEqual(sessionLabel);
    expect(await pillColors(resultLabel)).toEqual(conversationColors);
    await result.click();
    const match = win.locator('[data-item-id="history200"]');
    await match.waitFor({ state: 'visible', timeout: 10_000 });
    await expect.poll(() => win.locator('.transcript.virtual').count(), { timeout: 10_000 }).toBe(1);
    expect(await win.locator('.transcript-row').count()).toBeLessThan(80);
    await match.getByRole('link', { name: 'src/hello.ts:300' }).click();
    await expectHelloLine(300);
    await closePreview();

    // The Files tab browses; opening the PNG previews it as a decoded picture, not editable text.
    await win.locator('.panel').getByRole('button', { name: 'Files', exact: true }).click();
    await win.locator('.files .file-list').getByRole('button', { name: 'src', exact: true }).click();
    const pixelRow = win.locator('.files .file-list').getByRole('button', { name: /^pixel\.png\b/ });
    await pixelRow.click();
    const img = filePane.getByRole('img', { name: 'src/pixel.png', exact: true });
    await img.waitFor({ timeout: 10_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 10_000 }).toBe(1);
    expect(await editor.count()).toBe(0);
    expect(await filePane.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
    const readCopies = await captureImageCopies(win);
    await copyPreviewImage(win, img);
    expect(await readCopies()).toEqual([{
      types: ['image/png'], mime: 'image/png', size: [1, 1], corners: [[0, 0, 255, 127], [0, 0, 255, 127]],
    }]);
    await img.waitFor({ state: 'visible', timeout: 10_000 });
    await expect.poll(() => pixelRow.getAttribute('class')).toContain('active');
    await win.screenshot({ path: path.join(shots, 'files-02-image.png') });
  }, 180_000);

  it.each(['standard', 'zen'])('edits and saves from the Files overlay without reflow in %s', async (uiMode) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-files-edit-'));
    onTestFinished(() => fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const userData = path.join(tmp, 'profile');
    const project = path.join(tmp, 'project');
    const sid = 's_file_edit';
    const sessionDir = path.join(userData, 'sessions', sid);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(project);
    const markdown = path.join(project, 'notes.md');
    const extensionless = path.join(project, 'LICENSE');
    const markdownBefore = '# Workspace notes\n\nSeeded **notes**.\n';
    const licenseBefore = 'Original terms\n';
    await fs.writeFile(markdown, markdownBefore);
    await fs.writeFile(extensionless, licenseBefore);
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { uiMode }));
    const session: SessionMeta = {
      id: sid, title: 'File editing', createdAt: 1, updatedAt: 1,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project, status: 'idle', harnessRef: {}, queued: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    };
    const item: TranscriptItem = { id: 'reply', kind: 'assistant', ts: 1, text: 'These files are ready to edit: `notes.md`.' };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.writeFile(path.join(sessionDir, 'transcript.jsonl'), JSON.stringify(item) + '\n');

    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: [...(packaged ? [] : [path.join(root, 'out', 'main', 'index.js')]), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData), timeout: 60_000,
    });
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1600, height: 1000 });
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => win.locator('html').getAttribute('data-ui')).toBe(uiMode);
    const transcript = win.getByTestId('session-pane').locator('.transcript');
    const link = transcript.getByRole('link', { name: 'notes.md', exact: true });
    const panel = win.locator('.panel');
    const preview = win.getByTestId('file-pane');
    const editor = preview.getByRole('textbox', { name: 'File contents', exact: true });
    const replaceEditorText = async (text: string) => {
      await editor.press('ControlOrMeta+a');
      await win.keyboard.insertText(text);
      await expectEditorText(editor, text);
    };
    await link.waitFor();
    await panel.waitFor({ state: 'attached' });

    // A transcript link opens the drawer without taking the closed panel's space.
    await win.keyboard.press('ControlOrMeta+j');
    await panel.waitFor({ state: 'detached' });
    const closedTranscript = await transcript.boundingBox();
    expect(closedTranscript).not.toBeNull();
    await link.click();
    await expectEditorText(editor, markdownBefore);
    expect(await transcript.boundingBox()).toEqual(closedTranscript);
    await win.keyboard.press('ControlOrMeta+j');
    await preview.waitFor({ state: 'detached' });
    await panel.waitFor({ state: 'detached' });
    expect(await transcript.boundingBox()).toEqual(closedTranscript);

    await win.keyboard.press('ControlOrMeta+j');
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    const files = panel.locator('.files .file-list');
    const markdownRow = files.getByRole('button', { name: /^notes\.md\b/ });
    const extensionlessRow = files.getByRole('button', { name: /^LICENSE\b/ });
    await markdownRow.waitFor();
    const originalTranscript = await transcript.boundingBox();
    const originalPanel = await panel.boundingBox();
    expect(originalTranscript).not.toBeNull();
    expect(originalPanel).not.toBeNull();

    await markdownRow.click();
    await expectEditorText(editor, markdownBefore);
    await editor.click(); // Moving from the Files tree into the editor must not fold Zen's drawer.
    expect(await transcript.boundingBox()).toEqual(originalTranscript);
    expect(await panel.boundingBox()).toEqual(originalPanel);
    const overlay = (await preview.boundingBox())!;
    expect(Math.abs(overlay.x + overlay.width - originalPanel!.x), 'the preview touches the Files panel on its left').toBeLessThanOrEqual(1);
    const chat = originalTranscript!;
    expect(Math.min(overlay.x + overlay.width, chat.x + chat.width)).toBeGreaterThan(Math.max(overlay.x, chat.x));
    expect(Math.min(overlay.y + overlay.height, chat.y + chat.height)).toBeGreaterThan(Math.max(overlay.y, chat.y));
    expect(await win.getByTestId('session-panes').getByTestId('file-pane').count()).toBe(0);
    expect(await markdownRow.isVisible()).toBe(true);

    const heading = preview.getByRole('heading', { name: 'Workspace notes', exact: true });
    expect(await heading.count()).toBe(0);
    await preview.getByRole('button', { name: 'Show markdown preview', exact: true }).click();
    await heading.waitFor();
    expect(await editor.isVisible()).toBe(false);
    await preview.getByRole('button', { name: 'Show source', exact: true }).click();
    await expectEditorText(editor, markdownBefore);

    // Drive the real UI and read the actual files; the Electron IPC and filesystem are not mocked.
    const markdownAfter = '# Workspace notes\n\nSaved from the button.\n';
    const save = preview.getByRole('button', { name: 'Save', exact: true });
    await replaceEditorText(markdownAfter);
    expect(await fs.readFile(markdown, 'utf8')).toBe(markdownBefore);
    await save.click();
    await expect.poll(() => fs.readFile(markdown, 'utf8'), { timeout: 10_000 }).toBe(markdownAfter);
    await expect.poll(() => save.isDisabled()).toBe(true);

    await extensionlessRow.click();
    await expectEditorText(editor, licenseBefore);
    const licenseAfter = 'Revised terms — saved from the keyboard.\n';
    await replaceEditorText(licenseAfter);
    expect(await fs.readFile(extensionless, 'utf8')).toBe(licenseBefore);
    await editor.press('ControlOrMeta+s');
    await expect.poll(() => fs.readFile(extensionless, 'utf8'), { timeout: 10_000 }).toBe(licenseAfter);
    await expect.poll(() => save.isDisabled()).toBe(true);
    expect(await fs.readFile(markdown, 'utf8')).toBe(markdownAfter);

    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
    await preview.waitFor({ state: 'detached', timeout: 10_000 });
    await panel.getByRole('button', { name: 'Files', exact: true }).hover();
    await extensionlessRow.click();
    await expectEditorText(editor, licenseAfter);
    await markdownRow.click();
    await expectEditorText(editor, markdownAfter);
  }, 120_000);
});
