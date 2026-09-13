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
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { openNewSession, seedSettings } from './e2e-ui';
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

function digest(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

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
    const settle = async (): Promise<string> => {
      let prev = digest(await win.screenshot({ clip: SIDEBAR }));
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const next = digest(await win.screenshot({ clip: SIDEBAR }));
        if (next === prev) return next;
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

    const fingerprints = new Map<string, string>();
    for (const [i, theme] of grouped.entries()) {
      await pick(theme.name, theme.id);
      await win.screenshot({ path: path.join(shots, `theme-${String(i).padStart(2, '0')}-${theme.id}.png`) });
      fingerprints.set(theme.id, digest(await win.screenshot({ clip: SIDEBAR })));
    }

    // 'system' has no palette of its own; it has to look exactly like whichever built-in the OS asks for.
    expect([fingerprints.get('light'), fingerprints.get('dark')]).toContain(fingerprints.get('system'));

    // Every other theme repaints the window differently — no two are the same skin.
    const named = [...fingerprints].filter(([id]) => id !== 'system');
    expect(new Set(named.map(([, hash]) => hash)).size, JSON.stringify(named)).toBe(named.length);

    // Nebula's aurora, grid and gradient sweeps keep moving while the app sits idle...
    await pick('Nebula', 'nebula');
    const nebulaA = digest(await win.screenshot({ clip: SIDEBAR }));
    await new Promise((r) => setTimeout(r, 1500));
    const nebulaB = digest(await win.screenshot({ clip: SIDEBAR }));
    expect(nebulaB, 'Nebula should still be animating').not.toBe(nebulaA);

    // ...while a static theme is pixel-stable over the same window.
    await pick('Midnight Navy', 'midnight');
    const midnightA = digest(await win.screenshot({ clip: SIDEBAR }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(digest(await win.screenshot({ clip: SIDEBAR })), 'Midnight Navy should be static').toBe(midnightA);

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
    const screens = new Map<string, string>();
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
      screens.set(id, digest(await term.screenshot()));
    }
    expect(new Set(screens.values()).size, JSON.stringify([...screens])).toBe(screens.size);
  }, 240_000);
});
