/**
 * End-to-end check of the color themes in the real app: a System / Light / Dark mode and twenty
 * palettes, each with a light and a dark variant. The mode persists across every palette switch,
 * every variant actually repaints the window, a legacy single-variant theme id is upgraded on
 * launch, and Nebula is the only palette that animates. Requires `npm run build` first. Gated by
 * VOCS_CODE_E2E_UI=1.
 *
 * On failure, a pre-shutdown screenshot lands in tests/artifacts/ for diagnosis. Set
 * VOCS_CODE_E2E_CAPTURE_THEMES=1 for optional per-variant screenshots to eyeball palettes.
 *
 * The renderer's CSP forbids eval, so nothing here uses page.evaluate: themes are switched by
 * clicking the picker and verified through the data-theme / data-palette / data-scheme attributes
 * and rendered pixels.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { decodePng, type Frame, isolatedEnv, openNewSession, pixelDelta, seedSettings } from './e2e-ui';
import { GROUP_ORDER, PALETTES, findPalette, type ColorScheme, type PaletteId } from '../src/shared/themes';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
const captureThemes = process.env.VOCS_CODE_E2E_CAPTURE_THEMES === '1';
let app: ElectronApplication | null = null;
let failedPage: Page | null = null;

afterEach(async ({ task }) => {
  // Capture the live renderer before afterAll shuts it down; successful runs leave no images.
  if (task.result?.state !== 'fail' || !failedPage) return;
  await fs.mkdir(shots, { recursive: true });
  await failedPage.screenshot({ path: path.join(shots, 'e2e-fail-themes.png') }).catch(() => undefined);
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

/**
 * The sidebar corner: painted from --bg-sunken, --accent (the New button) and --fg (the wordmark),
 * and free of the picker itself, so its pixels identify a variant rather than which card is selected.
 */
const SIDEBAR = { x: 0, y: 0, width: 280, height: 260 };

/**
 * Two frames count as the same skin below this fraction of differing pixels. Antialiasing of the
 * wordmark and the folder row's chevron drifts by +/-1 between paints (single-digit pixel counts,
 * ~0.01%), while a real theme switch repaints the whole region. Hashing the bytes instead made
 * "this theme is static" fail on four stray pixels.
 */
const SAME = 0.005;

const nameOf = (id: PaletteId): string => findPalette(id)!.name;

describe.runIf(enabled)('color themes (e2e)', () => {
  it('keeps the mode across palettes, paints a distinct window for every variant, and animates only Nebula', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-themes-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    // `cat` is Get-Content on PowerShell and cat everywhere else, so this reaches the PTY either way.
    const esc = String.fromCharCode(27);
    const colored = ['31mRED', '32mGREEN', '34mBLUE', '33mYELLOW'].map((c) => esc + '[' + c).join(' ');
    await fs.writeFile(path.join(project, 'colors.txt'), colored + esc + '[0m' + String.fromCharCode(10));
    // A settings.json from a build with one flat list of themes: 'blueprint' was Midnight's light side.
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { theme: 'blueprint' }));

    app = await electron.launch({ executablePath: require('electron') as string, args: [path.join(root, 'out', 'main', 'index.js')], env: isolatedEnv(userData), timeout: 60_000 });
    const win: Page = await app.firstWindow();
    failedPage = win;
    await win.waitForSelector('.brand', { timeout: 60_000 });
    // The legacy id is split into the mode it painted and the palette it became.
    await win.waitForSelector("html[data-theme='light'][data-palette='midnight'][data-scheme='light']", { timeout: 10_000 });

    const openAppearance = async (): Promise<void> => {
      await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
      await win.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click();
      await win.waitForSelector('.theme-picker', { timeout: 20_000 });
    };
    await openAppearance();

    // The mode is one switch above the palettes, not three more swatches among them.
    const modes = win.getByRole('group', { name: 'Light or dark mode' }).getByRole('button');
    expect((await modes.allInnerTexts()).map((t) => t.trim())).toEqual(['System', 'Light', 'Dark']);
    await win.locator('.theme-mode-option.active', { hasText: 'Light' }).waitFor({ timeout: 10_000 });
    await win.locator('.theme-card.active', { hasText: /^Midnight$/ }).waitFor({ timeout: 10_000 });

    // Every palette is offered exactly once, family by family.
    const cards = win.locator('.theme-card');
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(PALETTES.length);
    const grouped = GROUP_ORDER.flatMap((g) => PALETTES.filter((p) => p.group === g));
    expect(grouped).toHaveLength(PALETTES.length);
    expect((await cards.allInnerTexts()).map((t) => t.trim())).toEqual(grouped.map((p) => p.name));

    /**
     * Two identical consecutive frames. A switch lands in stages — the card's own 0.12s transition,
     * then the native caption overlay a frame or two later — and the sidebar itself settles after
     * mount (the folder row resolves its git branch when the main process answers), so a fixed delay
     * fingerprints a half-applied theme. Nebula never settles; it comes back with the last frame
     * after the cap, which is all its animation check needs.
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

    const setMode = async (name: 'System' | 'Light' | 'Dark', mode: string): Promise<void> => {
      await modes.filter({ hasText: name }).click();
      await win.waitForSelector(`html[data-theme='${mode}']`, { timeout: 10_000 });
      await win.locator('.theme-mode-option.active', { hasText: name }).waitFor({ timeout: 10_000 });
    };

    const pick = async (id: PaletteId, scheme: ColorScheme): Promise<Frame> => {
      await win.locator('.theme-card', { hasText: new RegExp(`^${nameOf(id)}$`) }).click();
      // The palette changes; the mode the user chose stays exactly where it was.
      await win.waitForSelector(`html[data-palette='${id}'][data-scheme='${scheme}']`, { timeout: 10_000 });
      await win.locator(`.theme-card.active:has-text("${nameOf(id)}")`).waitFor({ timeout: 10_000 });
      await win.mouse.move(0, 0);
      return settle();
    };

    const frames: Record<ColorScheme, Map<PaletteId, Frame>> = { light: new Map(), dark: new Map() };
    for (const [scheme, label] of [['dark', 'Dark'], ['light', 'Light']] as const) {
      await setMode(label, scheme);
      for (const [i, p] of grouped.entries()) {
        frames[scheme].set(p.id, await pick(p.id, scheme));
        expect(await win.locator('html').getAttribute('data-theme'), `${p.id} kept the ${scheme} mode`).toBe(scheme);
        if (captureThemes) {
          await fs.mkdir(shots, { recursive: true });
          await win.screenshot({ path: path.join(shots, `theme-${scheme}-${String(i).padStart(2, '0')}-${p.id}.png`) });
        }
      }
      // Within one scheme, no two palettes paint the same window.
      const painted = [...frames[scheme]];
      for (let i = 0; i < painted.length; i++) {
        for (let j = i + 1; j < painted.length; j++) {
          const d = pixelDelta(painted[i]![1], painted[j]![1]);
          expect(d, `${scheme}: ${painted[i]![0]} and ${painted[j]![0]} paint the same window`).toBeGreaterThan(SAME);
        }
      }
    }
    // Every palette's light variant is its own skin, not its dark one.
    for (const p of PALETTES) {
      expect(pixelDelta(frames.light.get(p.id)!, frames.dark.get(p.id)!), `${p.id} light vs dark`).toBeGreaterThan(SAME);
    }

    // System keeps the palette and paints whichever variant the OS asks for. (Dusk, not the last
    // palette: Nebula animates, so no two of its frames ever match.)
    await pick('dusk', 'light');
    await setMode('System', 'system');
    const osScheme = (await win.locator('html').getAttribute('data-scheme')) as ColorScheme;
    expect(['light', 'dark']).toContain(osScheme);
    expect(await win.locator('html').getAttribute('data-palette')).toBe('dusk');
    await win.mouse.move(0, 0);
    expect(pixelDelta(await settle(), frames[osScheme].get('dusk')!), `system paints dusk/${osScheme}`).toBeLessThanOrEqual(SAME);

    // Nebula's aurora, grid and gradient sweeps keep moving while the app sits idle...
    await setMode('Dark', 'dark');
    await pick('nebula', 'dark');
    const nebulaA = await shot();
    await new Promise((r) => setTimeout(r, 1500));
    expect(pixelDelta(nebulaA, await shot()), 'Nebula should still be animating').toBeGreaterThan(SAME);

    // ...while a static palette is stable over the same window, bar glyph antialiasing.
    await pick('midnight', 'dark');
    const midnightA = await shot();
    await new Promise((r) => setTimeout(r, 1500));
    expect(pixelDelta(midnightA, await shot()), 'Midnight should be static').toBeLessThanOrEqual(SAME);

    // The choice survives as a plain mode and palette id in settings.json.
    const stored = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { theme: string; palette: string };
    expect(stored).toMatchObject({ theme: 'dark', palette: 'midnight' });

    // The terminal is themed too: its screen is repainted from the active variant. (The 16 ANSI
    // slots themselves are checked for every variant in tests/themes.test.ts.)
    await win.locator('.settings-title button[title="Back"]').click();
    await openNewSession(win);
    await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
    // No prompt, so nothing is ever sent to a harness and no API key is needed.
    await win.click('button:has-text("Start session")');
    await win.waitForSelector('.header', { timeout: 30_000 });
    await win.click('.panel-tab:has-text("Terminal")');
    await win.waitForSelector('.term-view .xterm .xterm-helper-textarea', { timeout: 20_000 });
    // Composer commands reach the PTY even during initial attach. Observe the actual xterm
    // buffer rather than sleeping for a presumed prompt/output delay.
    await win.fill('.composer textarea', '!cat colors.txt');
    await win.press('.composer textarea', 'Enter');
    const screenText = async (): Promise<string> => {
      await win.click('button[aria-label="Send output to agent"]');
      return win.locator('.composer textarea').inputValue();
    };
    await expect.poll(screenText, { timeout: 20_000 }).toContain('RED GREEN BLUE YELLOW');
    await win.fill('.composer textarea', '');

    const term = win.locator('.term-view');
    const screens = new Map<string, Frame>();
    const steps: { label: string; mode?: ['Light' | 'Dark', ColorScheme]; palette?: PaletteId }[] = [
      { label: 'midnight/dark' },
      { label: 'midnight/light', mode: ['Light', 'light'] },
      { label: 'ember/light', palette: 'ember' },
      { label: 'nebula/dark', mode: ['Dark', 'dark'], palette: 'nebula' }
    ];
    for (const step of steps) {
      if (step.mode || step.palette) {
        // Reopening Settings starts at General; themes live in Appearance.
        await openAppearance();
        if (step.mode) await setMode(step.mode[0], step.mode[1]);
        if (step.palette) {
          await win.locator('.theme-card', { hasText: new RegExp(`^${nameOf(step.palette)}$`) }).click();
          await win.waitForSelector(`html[data-palette='${step.palette}']`, { timeout: 10_000 });
        }
        await win.locator('.settings-title button[title="Back"]').click();
      }
      // Back to the session: the shell is still running, so the terminal repaints its retained
      // screen in the new variant rather than starting empty.
      await win.waitForSelector('.term-view .xterm', { timeout: 20_000 });
      const previous = [...screens.values()].at(-1);
      if (previous) await expect.poll(async () => pixelDelta(previous, decodePng(await term.screenshot())), { timeout: 10_000 }).toBeGreaterThan(SAME);
      if (captureThemes) await win.screenshot({ path: path.join(shots, `theme-terminal-${step.label.replace('/', '-')}.png`) });
      screens.set(step.label, decodePng(await term.screenshot()));
    }
    const painted = [...screens];
    for (let i = 0; i < painted.length; i++) {
      for (let j = i + 1; j < painted.length; j++) {
        const d = pixelDelta(painted[i]![1], painted[j]![1]);
        expect(d, `terminal looks the same under ${painted[i]![0]} and ${painted[j]![0]}`).toBeGreaterThan(SAME);
      }
    }
  }, 360_000);
});
