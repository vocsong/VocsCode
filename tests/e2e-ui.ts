/**
 * Shared UI steps for the Playwright/Electron e2e suites. The new-session flow is driven the same
 * way by five tests; keeping it here means a move in the chrome is one fix, not five.
 */
import type { Page } from 'playwright-core';

/**
 * settings.json for a returning user: the project is already in the sidebar's folder list (so a
 * session starts without the native folder picker, which a test cannot drive) and the onboarding
 * wizard, which otherwise covers the whole window on first run, is done.
 */
export function seedSettings(project: string): string {
  return JSON.stringify({ folders: [project], recentProjects: [project], onboardingDone: true });
}

/** Opens the new-session dialog from the seeded folder's row in the sidebar. */
export async function openNewSession(win: Page): Promise<void> {
  await win.click('.project-new-btn');
  await win.waitForSelector('.modal');
}

/**
 * Picks a model in the new-session dialog by `provider/id` — the title the picker puts on every
 * row, and the only part of it that is not a display name.
 */
export async function pickModel(win: Page, ref: string): Promise<void> {
  const picker = win.locator('.ns-col-model .model-picker');
  // The catalog arrives asynchronously; a first row means the harness has published it.
  await picker.locator('.mp-row').first().waitFor({ timeout: 60_000 });
  await picker.locator('.mp-search input').fill(ref.slice(ref.indexOf('/') + 1));
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
