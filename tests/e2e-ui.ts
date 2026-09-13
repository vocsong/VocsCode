/**
 * Shared UI steps for the Playwright/Electron e2e suites. The new-session flow is driven the same
 * way by five tests; keeping it here means a move in the chrome is one fix, not five.
 */
import { inflateSync } from 'node:zlib';
import { expect } from 'vitest';
import type { ElectronApplication, Page } from 'playwright-core';

/**
 * settings.json for a returning user: the project is already in the sidebar's folder list (so a
 * session starts without the native folder picker, which a test cannot drive) and the onboarding
 * wizard, which otherwise covers the whole window on first run, is done.
 */
export function seedSettings(project: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ folders: [project], recentProjects: [project], onboardingDone: true, ...extra });
}

/**
 * Environment for a launched Electron: the user's environment minus provider keys and Claude Code
 * markers, pointed at a throwaway userData directory. `extra` overrides individual variables (for
 * example PI_CODING_AGENT_DIR, so a suite never touches the real ~/.pi/agent).
 */
export function isolatedEnv(userData: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
    env[k] = v;
  }
  env.VOCS_CODE_USER_DATA = userData;
  return { ...env, ...extra };
}

/**
 * Opens the new-session dialog from the seeded folder's row in the sidebar. Addressed by test id
 * rather than by class: a restyle must not be able to take the suites' entry point away.
 */
export async function openNewSession(win: Page): Promise<void> {
  await win.getByTestId('new-session').first().click();
  await win.waitForSelector('.modal');
}

/** Opens analytics through the sidebar rather than reaching into renderer state. */
export async function openAnalytics(win: Page): Promise<void> {
  await win.getByRole('button', { name: 'Analytics', exact: true }).click();
  await win.getByRole('tablist', { name: 'Analytics sections' }).waitFor();
}

/**
 * Suites run off-screen and inactive so a test run covers nothing and takes no focus (see
 * `e2eQuiet` in src/main/index.ts). That is invisible from the page, so assert the window itself:
 * unfocused, and entirely outside every display. The window is placed when it is ready to show, so
 * this polls rather than racing the first paint. A no-op under VOCS_CODE_E2E_VISIBLE=1.
 */
export async function expectQuietWindow(app: ElectronApplication): Promise<void> {
  if (process.env.VOCS_CODE_E2E_VISIBLE === '1') return;
  const read = () =>
    app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const b = win.getBounds();
      const displays = screen.getAllDisplays().map((d) => d.bounds);
      return { focused: win.isFocused(), right: b.x + b.width, left: Math.min(...displays.map((d) => d.x)) };
    });
  let state = await read();
  for (let i = 0; i < 100 && state.right > state.left; i++) {
    await new Promise((r) => setTimeout(r, 100));
    state = await read();
  }
  expect(state.focused).toBe(false);
  expect(state.right).toBeLessThanOrEqual(state.left);
}

/**
 * Picks a model in the new-session dialog by `provider/id` — the qualified name the picker titles
 * every row with, and the name it searches by.
 */
export async function pickModel(win: Page, ref: string): Promise<void> {
  const picker = win.locator('.ns-col-model .model-picker');
  // The catalog arrives asynchronously; a first row means the harness has published it.
  await picker.locator('.mp-row').first().waitFor({ timeout: 60_000 });
  await picker.locator('.mp-search input').fill(ref);
  const row = picker.locator(`.mp-row:has(.mp-name[title="${ref}"]) .mp-select`).first();
  try {
    await row.click({ timeout: 20_000 });
  } catch {
    // Which models the dialog offers depends on the harness and on which providers are configured,
    // so say what was actually there rather than just timing out on a selector.
    const titles = await picker.locator('.mp-name').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    throw new Error(`model ${ref} is not in the picker; it offers: ${titles.join(', ') || '(nothing)'}`);
  }
}

export interface Frame {
  width: number;
  height: number;
  channels: number;
  /** Row-major, `channels` bytes per pixel. */
  pixels: Buffer;
}

/**
 * Minimal PNG reader for screenshot comparison: 8-bit, non-interlaced, RGB or RGBA, which is what
 * Playwright emits. Comparing decoded pixels rather than hashing the file lets a check tolerate
 * glyph antialiasing, which is not bit-stable between paints.
 */
export function decodePng(buf: Buffer): Frame {
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      colorType = data[9]!;
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) {
        throw new Error(`unsupported PNG: depth=${depth} colorType=${colorType} interlace=${data[12]}`);
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = pixels.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * Fraction of pixels (0..1) whose RGB differs by more than `tolerance` in any channel. Antialiased
 * text and icon edges drift by ±1 between paints, so a repaint-detecting check wants a threshold,
 * not equality: hashing the bytes instead makes "this theme is static" fail on four stray pixels.
 */
export function pixelDelta(a: Frame, b: Frame, tolerance = 2): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`frame size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let differing = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const ia = i * a.channels;
    const ib = i * b.channels;
    for (let c = 0; c < 3; c++) {
      if (Math.abs(a.pixels[ia + c]! - b.pixels[ib + c]!) > tolerance) {
        differing++;
        break;
      }
    }
  }
  return differing / (a.width * a.height);
}
