/**
 * End-to-end check of the theme catalogue in the real app: every theme is pickable, each one
 * actually repaints the window, and Nebula is the only one that animates. Requires `npm run build`
 * first. Gated by VOCS_CODE_E2E_UI=1.
 *
 * Screenshots land in tests/artifacts/theme-*.png, one per theme, so the palettes can be eyeballed.
 *
 * The renderer's CSP forbids eval, so nothing here uses page.evaluate: themes are switched by
 * clicking the picker and verified through the data-theme attribute and rendered pixels.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { decodePng, type Frame, openNewSession, pixelDelta, seedSettings } from './e2e-ui';
import { GROUP_ORDER, THEMES } from '../src/shared/themes';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

/**
 * The sidebar corner: painted from --bg-sunken, --accent (the New button) and --fg (the wordmark),
 * and free of the picker itself, so its pixels identify a theme rather than which card is selected.
 */
const SIDEBAR = { x: 0, y: 0, width: 280, height: 260 };

/**
 * Two frames count as the same skin below this fraction of differing pixels. Antialiasing of the
 * wordmark and the folder row's chevron drifts by +/-1 between paints (single-digit pixel counts,
 * ~0.01%), while a real theme switch repaints the whole region. Hashing the bytes instead made
 * "this theme is static" fail on four stray pixels.
 */
const SAME = 0.005;

describe.runIf(enabled)('theme catalogue (e2e)', () => {
  it('paints a distinct window for every theme, and animates only Nebula', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-themes-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(shots, { recursive: true });
    // `cat` is Get-Content on PowerShell and cat everywhere else, so this reaches the PTY either way.
    const esc = String.fromCharCode(27);
    const colored = ['31mRED', '32mGREEN', '34mBLUE', '33mYELLOW'].map((c) => esc + '[' + c).join(' ');
    await fs.writeFile(path.join(project, 'colors.txt'), colored + esc + '[0m' + String.fromCharCode(10));
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
      env[k] = v;
    }
    env.VOCS_CODE_USER_DATA = userData;

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env, timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.waitForSelector('.theme-picker', { timeout: 20_000 });

    // Every catalogue entry is offered, exactly once.
    const cards = win.locator('.theme-card');
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(THEMES.length);
    // The picker lays the catalogue out family by family, so that is the order to expect.
    const grouped = GROUP_ORDER.flatMap((g) => THEMES.filter((t) => t.group === g));
    expect(grouped).toHaveLength(THEMES.length);
    const labels = (await cards.allInnerTexts()).map((t) => t.trim());
    expect(labels).toEqual(grouped.map((t) => t.name));

    /**
     * Two identical consecutive frames. A theme switch lands in stages — the card's own 0.12s
     * transition, then the native caption overlay a frame or two later — and the sidebar itself
     * settles after mount (the folder row resolves its git branch when the main process answers),
     * so a fixed delay fingerprints a half-applied theme. Nebula never settles; it comes back with
     * the last frame after the cap, which is all its animation check needs.
     */
    const shot = async (): Promise<Frame> => decodePng(await win.screenshot({ clip: SIDEBAR }));
    const settle = async (): Promise<Frame> => {
      let prev = await shot();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const next = await shot();
        if (pixelDelta(prev, next) <= SAME) return next;
        prev = next;
      }
      return prev;
    };

    const pick = async (name: string, id: string): Promise<void> => {
      await win.locator('.theme-card', { hasText: new RegExp(`^${name}$`) }).click();
      await win.waitForSelector(`html[data-theme='${id}']`, { timeout: 10_000 });
      await win.locator(`.theme-card.active:has-text("${name}")`).waitFor({ timeout: 10_000 });
      await win.mouse.move(0, 0);
      await settle();
    };

    const frames = new Map<string, Frame>();
    for (const [i, theme] of grouped.entries()) {
      await pick(theme.name, theme.id);
      await win.screenshot({ path: path.join(shots, `theme-${String(i).padStart(2, '0')}-${theme.id}.png`) });
      frames.set(theme.id, await shot());
    }

    // 'system' has no palette of its own; it has to look like whichever built-in the OS asks for.
    const vsLight = pixelDelta(frames.get('system')!, frames.get('light')!);
    const vsDark = pixelDelta(frames.get('system')!, frames.get('dark')!);
    expect(Math.min(vsLight, vsDark), `system vs light=${vsLight}, vs dark=${vsDark}`).toBeLessThanOrEqual(SAME);

    // Every other theme repaints the window differently — no two are the same skin.
    const named = [...frames].filter(([id]) => id !== 'system');
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        const d = pixelDelta(named[i]![1], named[j]![1]);
        expect(d, `${named[i]![0]} and ${named[j]![0]} paint the same window`).toBeGreaterThan(SAME);
      }
    }

    // Nebula's aurora, grid and gradient sweeps keep moving while the app sits idle...
    await pick('Nebula', 'nebula');
    const nebulaA = await shot();
    await new Promise((r) => setTimeout(r, 1500));
    expect(pixelDelta(nebulaA, await shot()), 'Nebula should still be animating').toBeGreaterThan(SAME);

    // ...while a static theme is stable over the same window, bar glyph antialiasing.
    await pick('Midnight Navy', 'midnight');
    const midnightA = await shot();
    await new Promise((r) => setTimeout(r, 1500));
    expect(pixelDelta(midnightA, await shot()), 'Midnight Navy should be static').toBeLessThanOrEqual(SAME);

    // The choice survives as a plain id in settings.json.
    const stored = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { theme: string };
    expect(stored.theme).toBe('midnight');

    // The terminal is themed too: its screen is repainted from the active palette. (The 16 ANSI
    // slots themselves are checked for every theme in tests/themes.test.ts.)
    await win.locator('.settings-title button[title="Back"]').click();
    await openNewSession(win);
    await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
    // No prompt, so nothing is ever sent to a harness and no API key is needed.
    await win.click('button:has-text("Start session")');
    await win.waitForSelector('.header', { timeout: 30_000 });
    await win.click('.panel-tab:has-text("Terminal")');
    await win.waitForSelector('.term-view .xterm .xterm-helper-textarea', { timeout: 20_000 });
    await win.locator('.xterm-helper-textarea').focus();
    await win.waitForTimeout(1500); // let the shell print its prompt
    await win.keyboard.type('cat colors.txt');
    await win.keyboard.press('Enter');
    await win.waitForTimeout(1500);

    const term = win.locator('.term-view');
    const screens = new Map<string, Frame>();
    for (const id of ['midnight', 'blueprint', 'ember', 'nebula'] as const) {
      const name = THEMES.find((t) => t.id === id)?.name as string;
      // The View menu offers one "Theme" item that opens Settings; the catalogue itself lives there.
      await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
      await win.waitForSelector('.theme-picker', { timeout: 20_000 });
      await win.locator('.theme-card', { hasText: new RegExp(`^${name}$`) }).click();
      await win.waitForSelector(`html[data-theme='${id}']`, { timeout: 10_000 });
      await win.locator('.settings-title button[title="Back"]').click();
      // Back to the session: the shell is still running, so the terminal repaints its retained
      // screen in the new palette rather than starting empty.
      await win.waitForSelector('.term-view .xterm', { timeout: 20_000 });
      await win.waitForTimeout(500);
      await win.screenshot({ path: path.join(shots, `theme-terminal-${id}.png`) });
      screens.set(id, decodePng(await term.screenshot()));
    }
    const painted = [...screens];
    for (let i = 0; i < painted.length; i++) {
      for (let j = i + 1; j < painted.length; j++) {
        const d = pixelDelta(painted[i]![1], painted[j]![1]);
        expect(d, `terminal looks the same under ${painted[i]![0]} and ${painted[j]![0]}`).toBeGreaterThan(SAME);
      }
    }
  }, 240_000);
});
