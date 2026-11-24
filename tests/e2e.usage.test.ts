/**
 * Electron end-to-end for the right panel's Usage dashboard. A session, its totals and a transcript
 * carrying turns, tool calls, file changes and failures are seeded on disk, so the whole page is
 * driven through the real UI with no harness and no provider key. Availability, subscription reads
 * and vendor launches are stubbed at IPC; opening Usage reads verified limits without sending a
 * prompt or launching a vendor view.
 * Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { PUSH_CHANNELS } from '../src/shared/ipc';
import type { SessionEventEnvelope, SessionMeta, TranscriptItem } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, openAnalytics, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

const SID = 's_usage_e2e';
const T = Date.now() - 600_000;

/** Three turns: one clean, one interrupted, one failed — plus the tool traffic around them. */
function transcript(): TranscriptItem[] {
  return [
    { id: 'u1', kind: 'user', ts: T, text: 'Wire up the registry' },
    { id: 't1', kind: 'tool', ts: T + 1, name: 'read_file', hint: 'read', status: 'done', durationMs: 120 },
    { id: 't2', kind: 'tool', ts: T + 2, name: 'apply_patch', hint: 'edit', status: 'done', durationMs: 340, changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] },
    { id: 'a1', kind: 'assistant', ts: T + 3, text: 'Registered.' },
    { id: 'turn1', kind: 'turn', ts: T + 4, status: 'completed', durationMs: 5200, costUsd: 0.4, usage: { inputTokens: 900, outputTokens: 420 } },
    { id: 'u2', kind: 'user', ts: T + 5, text: 'Now run the tests' },
    { id: 't3', kind: 'tool', ts: T + 6, name: 'bash', hint: 'execute', status: 'error', durationMs: 900, exitCode: 1, output: 'FAIL tests/registry.test.ts' },
    { id: 'turn2', kind: 'turn', ts: T + 7, status: 'interrupted', durationMs: 2100, costUsd: 0.15, usage: { inputTokens: 300, outputTokens: 60 } },
    { id: 'u3', kind: 'user', ts: T + 8, text: 'Retry' },
    { id: 't4', kind: 'tool', ts: T + 9, name: 'bash', hint: 'execute', status: 'error', durationMs: 150, exitCode: 1, output: 'FAIL tests/registry.test.ts' },
    { id: 'i1', kind: 'info', ts: T + 10, level: 'warn', text: 'context is getting full' },
    { id: 'turn3', kind: 'turn', ts: T + 11, status: 'failed', durationMs: 1800, costUsd: 0.2, error: 'provider returned 429' }
  ];
}

describe.runIf(enabled)('electron e2e: usage dashboard', () => {
  it('shows session metrics and reads subscription limits once per Usage visit in Standard and Zen', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-usage-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
      uiMode: 'standard', sidebarWidth: 280, panelWidth: 420,
      // Startup probes must not reach a developer's signed-in CLI.
      binaries: Object.fromEntries(['agy', 'claude', 'codex', 'dsh', 'pi'].map((name) => [name, path.join(tmp, `missing-${name}`)]))
    }));

    const session: SessionMeta = {
      id: SID,
      title: 'Usage dashboard',
      createdAt: T,
      updatedAt: T,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask', maxBudgetUsd: 1.5 },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 1200, outputTokens: 480, cacheReadTokens: 3600, cacheWriteTokens: 240, reasoningTokens: 0, costUsd: 0.75, turns: 3, contextWindow: 200_000, contextTokens: 120_000 }
    };
    const claudeSession: SessionMeta = {
      ...session, id: `${SID}_claude`, title: 'Claude usage sample', updatedAt: T - 1,
      config: { harness: 'claude', projectRoot: project, permissionMode: 'ask' },
      usage: { ...session.usage, costUsd: 0, turns: 1 }
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session, claudeSession]));
    await fs.mkdir(path.join(userData, 'sessions', SID), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', SID, 'transcript.jsonl'), transcript().map((i) => JSON.stringify(i)).join('\n') + '\n');

    const appData = path.join(tmp, 'AppData', 'Roaming');
    const localAppData = path.join(tmp, 'AppData', 'Local');
    // Electron resolves these before it opens the custom user-data directory on Windows.
    await Promise.all([appData, localAppData].map((dir) => fs.mkdir(dir, { recursive: true })));
    const packaged = process.env.HARNESS_E2E_EXE;
    app = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData, {
        HOME: tmp, USERPROFILE: tmp, APPDATA: appData, LOCALAPPDATA: localAppData,
        PI_CODING_AGENT_DIR: path.join(tmp, 'pi'), CURSOR_API_KEY: ''
      }),
      timeout: 60_000
    });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(app);
    const resetAt = '2030-01-01T12:00:00Z';
    await app.evaluate(({ ipcMain }, { resetAt, claudeId }) => {
      const calls = { checks: [] as string[], claudeObserved: [] as string[], launches: [] as string[], prompts: 0 };
      Reflect.set(globalThis, '__vocsUsageCalls', calls);
      for (const channel of ['harness:availability', 'sessions:send', 'subscriptions:read', 'subscriptions:claudeObserved', 'subscriptions:openUsage']) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle('harness:availability', async (_event, request?: { id?: string }) => {
        await Reflect.get(globalThis, '__vocsUsageAvailabilityGate')?.pending;
        return request?.id && request.id !== 'codex' ? {} : {
          codex: { available: true, authenticated: true, authMethod: 'subscription' }
        };
      });
      ipcMain.handle('sessions:send', () => { calls.prompts++; throw new Error('Usage must not send a prompt'); });
      // Catch every provider on the read IPC, including unexpected ones. Never fall through to a CLI.
      ipcMain.handle('subscriptions:read', (_event, { provider }: { provider: string }) => {
        calls.checks.push(provider);
        if (provider !== 'codex') throw new Error(`Unexpected subscription read: ${provider}`);
        return { groups: [{ name: 'Codex', buckets: [
          { name: '5-hour limit', remainingFraction: 0.726, resetAt },
          { name: 'Weekly limit', remainingFraction: 0.16 }
        ] }] };
      });
      ipcMain.handle('subscriptions:claudeObserved', (_event, { sessionId }: { sessionId: string }) => {
        calls.claudeObserved.push(sessionId);
        const observedAt = Date.now();
        return sessionId === claudeId ? [{ name: 'Weekly limit', remainingFraction: 0.63, observedAt, expiresAt: observedAt + 1_800_000, resetAt }] : [];
      });
      ipcMain.handle('subscriptions:openUsage', (_event, { provider }: { provider: string }) => {
        calls.launches.push(provider);
        return { kind: provider === 'antigravity' ? 'terminal' : 'browser' };
      });
    }, { resetAt, claudeId: claudeSession.id });
    // Discard any availability the first renderer fetched before the handlers were replaced.
    await win.clock.install();
    await win.reload();
    const vendorCalls = () => app!.evaluate(() => Reflect.get(globalThis, '__vocsUsageCalls'));
    const expectCalls = async (visits: number, launches: string[] = [], claudeObserved: string[] = []) => {
      expect(await vendorCalls()).toEqual({ checks: Array<string>(visits).fill('codex'), claudeObserved, launches, prompts: 0 });
    };
    const wideViewport = { width: 1440, height: 900 };
    await win.setViewportSize(wideViewport);

    const rightPanel = win.locator('aside.panel');
    const panel = rightPanel.getByTestId('usage-panel');
    const accounts = panel.getByRole('region', { name: 'Subscription limits', exact: true, includeHidden: true });
    const codex = accounts.getByRole('region', { name: 'Codex · ChatGPT', exact: true, includeHidden: true });
    const shortWindow = codex.getByRole('meter', { name: '5-hour limit', exact: true });
    const contextWindow = panel.getByRole('meter', { name: 'Context window' });
    const usageTab = rightPanel.getByRole('button', { name: 'Usage', exact: true });
    const composer = win.locator('.composer');
    const prompt = composer.locator('textarea');
    const meter = composer.getByRole('button', { name: 'Session usage', exact: true });
    const openUsage = async (command: string) => {
      await prompt.fill(command);
      await prompt.press('Enter');
      expect(await prompt.inputValue()).toBe('');
    };
    const expectVisit = async (visits: number, launches: string[] = []) => {
      await shortWindow.waitFor({ timeout: 10_000 });
      await expectCalls(visits, launches);
    };
    const expectLimits = async () => {
      expect(await shortWindow.getAttribute('aria-valuenow')).toBe('73');
      expect(await codex.getByRole('meter', { name: 'Weekly limit', exact: true }).getAttribute('aria-valuenow')).toBe('16');
      const reset = await win.evaluate((iso) => new Date(iso).toLocaleString(), resetAt);
      expect(await codex.getByText(/^Resets /).innerText()).toBe(`Resets ${reset}`);
    };
    expect(await meter.innerText({ timeout: 30_000 })).toBe('60%');
    await expectCalls(0);

    // Start closed, then use the context ring to open, close, and reopen Usage.
    await rightPanel.getByRole('button', { name: 'Close panel', exact: true }).click();
    await rightPanel.waitFor({ state: 'detached', timeout: 10_000 });
    await meter.click();
    await expectVisit(1);
    await meter.click();
    await rightPanel.waitFor({ state: 'detached', timeout: 10_000 });
    await meter.click();
    await expectVisit(2);

    // With another tab open, the ring switches to Usage without closing the panel.
    const goalTab = rightPanel.getByRole('button', { name: 'Goal', exact: true });
    await goalTab.click();
    await goalTab.and(rightPanel.locator('.panel-tab.active')).waitFor({ timeout: 10_000 });
    await meter.click();
    await expectVisit(3);

    // Clicking the selected Usage tab neither toggles the panel nor starts another read.
    await usageTab.click();
    await expectVisit(3);

    // Opening Usage can squeeze the composer below the cutoff that normally hides the ring.
    // The expanded ring must still be visible and clickable so it can close the panel.
    await meter.click();
    await rightPanel.waitFor({ state: 'detached', timeout: 10_000 });
    await win.setViewportSize({ width: 1080, height: 760 });
    await meter.click();
    await expectVisit(4);
    expect(await composer.locator('.composer-box').evaluate((el) => el.clientWidth)).toBeLessThanOrEqual(440);
    await meter.waitFor({ timeout: 10_000 });
    expect(await meter.innerText()).toBe('60%');
    expect(await meter.getAttribute('aria-expanded')).toBe('true');
    await meter.click();
    await rightPanel.waitFor({ state: 'detached', timeout: 10_000 });
    expect(await meter.getAttribute('aria-expanded')).toBe('false');

    await win.setViewportSize(wideViewport);
    await openUsage('/USAGE');
    await expectVisit(5);
    await expectLimits();
    expect(await panel.getByRole('radio', { name: /^(Session|Subscriptions)$/ }).count()).toBe(0);
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'usage-00-summary.png') });

    // Only the user's fallback clicks launch the Antigravity CLI and the official Claude page.
    const google = accounts.getByRole('region', { name: 'Google Antigravity', exact: true });
    await google.getByRole('button', { name: 'Open CLI', exact: true }).click();
    await google.getByText('In the terminal, type /usage and press Enter.').waitFor();
    await expectCalls(5, ['antigravity']);
    const claude = accounts.getByRole('region', { name: 'Claude', exact: true });
    await claude.getByRole('button', { name: 'Open usage page', exact: true }).click();
    await claude.getByText('Usage page opened in your browser.').waitFor();
    const explicitLaunches = ['antigravity', 'claude'];
    await expectCalls(5, explicitLaunches);
    await win.screenshot({ path: path.join(shots, 'usage-00-subscriptions.png') });

    // Summary block: spend, and counters the page derives from the transcript rather than the totals.
    expect(await win.locator('.usage-hero-value').innerText()).toBe('$0.75');
    expect(await win.locator('.usage-hero-sub').innerText()).toContain('4 tool calls');
    expect(await win.locator('.ukpi').count()).toBeGreaterThanOrEqual(8);
    expect(await panel.getByTitle(/Failed tool calls/).innerText()).toContain('3'); // 2 failed tools + 1 failed turn
    expect(await panel.getByTitle(/Distinct paths reported as changed/).innerText()).toContain('2');

    // Session meters are still on the same page and use the seeded totals.
    expect(await contextWindow.getAttribute('aria-valuenow')).toBe('60');
    expect(await win.getByRole('meter', { name: 'Budget' }).getAttribute('aria-valuenow')).toBe('50');
    expect(await win.getByRole('meter', { name: 'Tool success' }).getAttribute('aria-valuenow')).toBe('50');

    // Turns view: one column per recorded turn, and the readout follows the hovered one.
    expect(await win.locator('.uturn').count()).toBe(3);
    expect(await win.locator('.uturn.st-interrupted').count()).toBe(1);
    expect(await win.locator('.uturn.st-failed').count()).toBe(1);
    await win.locator('.uturn').first().hover();
    expect(await win.locator('.uturn-readout').innerText()).toContain('Turn 1/3');
    // Switching the metric moves the pointer off the chart, so re-enter it before reading a turn.
    await win.getByRole('radio', { name: 'Time' }).click();
    await win.locator('.uturn').first().hover();
    expect(await win.locator('.uturn-readout').innerText()).toContain('5.2s');
    expect(await win.locator('.uturn-row').count()).toBe(3);

    await win.screenshot({ path: path.join(shots, 'usage-01-turns.png') });

    // Tools view: the mix, and the busiest-tool list with its per-tool failure count.
    await win.getByRole('radio', { name: 'Tools' }).click();
    await win.getByRole('img', { name: 'Tool calls by category' }).waitFor({ timeout: 10_000 });
    expect(await win.locator('.usage-detail .hbar').count()).toBe(3);
    expect(await win.locator('.usage-detail .hbar').first().innerText()).toContain('2 failed');
    await win.getByRole('img', { name: 'Reported file changes by kind' }).waitFor({ timeout: 10_000 });
    await win.screenshot({ path: path.join(shots, 'usage-02-tools.png') });

    // Errors view: completion meters, the failure counters and the log of what actually failed.
    await win.getByRole('radio', { name: 'Errors' }).click();
    expect(await win.getByRole('meter', { name: 'Turn completion' }).getAttribute('aria-valuenow')).toBe('33');
    expect(await win.locator('.uerr-count.hot').count()).toBe(4); // failed tools, failed turns, interrupted, warnings
    const log = win.locator('.uerr');
    expect(await log.count()).toBe(3);
    expect(await log.first().innerText()).toContain('provider returned 429');
    expect(await log.nth(1).innerText()).toContain('exit 1 · FAIL tests/registry.test.ts');
    await win.screenshot({ path: path.join(shots, 'usage-03-errors.png') });

    // The page fills the panel's upper half rather than trailing off after a few tiles.
    const body = await win.locator('.panel-section.panel-top .panel-body').boundingBox();
    const content = await panel.boundingBox();
    expect(content!.height).toBeGreaterThan(body!.height * 0.9);

    // Drive a real preload push and wait for a changed session metric, not just a repaint.
    const usageUpdate: SessionEventEnvelope = {
      sessionId: SID, ts: T + 12, event: { type: 'usage', totals: { ...session.usage, contextTokens: 140_000 } }
    };
    await app.evaluate(({ BrowserWindow }, { channel, update }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send(channel, update);
    }, { channel: PUSH_CHANNELS.sessionEvent, update: usageUpdate });
    await expect.poll(() => contextWindow.getAttribute('aria-valuenow')).toBe('70');
    await expectCalls(5, explicitLaunches);
    await win.clock.fastForward('10:00');
    await expectCalls(5, explicitLaunches);

    // Reflow the same open visit without a pointer click outside the panel ending its peek.
    const panelWidth = () => rightPanel.evaluate((el) => el.clientWidth);
    await win.evaluate(() => window.harness.invoke('settings:update', { uiMode: 'zen' }));
    await win.locator('html[data-ui="zen"]').waitFor();
    await expect.poll(panelWidth).toBeGreaterThan(52);
    expect(await panel.getByRole('radio', { name: 'Errors', checked: true }).count()).toBe(1);
    expect(await contextWindow.getAttribute('aria-valuenow')).toBe('70');
    await expectLimits();
    await expectCalls(5, explicitLaunches);

    // Fresh Zen visit: let the boot-time sign-in result arrive only once the selected Usage
    // drawer folds. It must not start a read until the user explicitly opens the drawer again.
    await app.evaluate(() => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      Reflect.set(globalThis, '__vocsUsageAvailabilityGate', { pending, release });
    });
    await win.reload();
    await win.locator('html[data-ui="zen"]').waitFor();
    await openUsage('/usage');
    await expect.poll(panelWidth).toBeGreaterThan(52);
    await expectCalls(5, explicitLaunches);
    await win.mouse.click(wideViewport.width / 2, 300);
    await expect.poll(panelWidth).toBe(52);
    expect(await usageTab.getAttribute('aria-current')).toBe('true');
    await app.evaluate(() => { Reflect.get(globalThis, '__vocsUsageAvailabilityGate').release(); });
    await codex.getByText('Subscription sign-in detected', { exact: true }).waitFor({ state: 'attached', timeout: 10_000 });
    await expectCalls(5, explicitLaunches);

    await usageTab.click();
    await expect.poll(panelWidth).toBeGreaterThan(52);
    await expectVisit(6, explicitLaunches);
    await expectLimits();
    expect(await contextWindow.getAttribute('aria-valuenow')).toBe('60');
    await shortWindow.scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(shots, 'usage-00-subscriptions-zen.png'), animations: 'disabled' });
    await expectCalls(6, explicitLaunches);

    // A Claude window comes from the selected live session only, without another Codex check.
    await win.keyboard.press('ControlOrMeta+2');
    await expect.poll(() => panel.locator('.usage-hero-value').innerText()).toBe('$0.00');
    await openUsage('/usage');
    const observed = claude.getByRole('meter', { name: 'Weekly limit' });
    await expect.poll(() => observed.getAttribute('aria-valuenow', { timeout: 2_000 })).toBe('63');
    expect(await claude.getByText(/Last reported by Claude/).count()).toBe(1);
    await expectCalls(6, explicitLaunches, [claudeSession.id]);
  }, 180_000);
});

/**
 * The boot-time repair of spend the Claude CLI recorded at its own fallback rates.
 *
 * The fixture is the shape of the report that prompted it: a Claude session on a cheap third-party
 * model the CLI has no pricing row for, so it billed $5/$25/$0.50 per Mtok where the catalog's rate
 * is $0.15/$0.60/$0.003 — $36.75 on the clock against $0.94 of real money. Both figures are read off
 * the same session the panel draws, so the assertion cannot pass on an unrepaired profile: the
 * headline and the turn bar must both open on the catalog's number.
 */
describe.runIf(enabled)('electron e2e: usage repair', () => {
  const SID_REPAIR = 's_usage_repair';
  // One turn's worth of tokens; two turns make the same totals. Catalog: 0.15 + 0.60 + 0.003 +
  // 0.15*1.25 (cache writes default to 1.25x input) = $0.9405 for the pair.
  const TURN_USAGE = { inputTokens: 500_000, outputTokens: 500_000, cacheReadTokens: 500_000, cacheWriteTokens: 500_000 };
  const TURN_FALLBACK = 18.375;
  let repairApp: ElectronApplication | null = null;

  afterAll(async () => {
    await repairApp?.close().catch(() => undefined);
  });

  it('opens on the catalog price for a session the CLI billed at its fallback rates', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-usage-repair-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    const session: SessionMeta = {
      id: SID_REPAIR,
      title: 'Fallback-priced session',
      createdAt: T,
      updatedAt: T,
      config: { harness: 'claude', projectRoot: project, permissionMode: 'ask', model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, reasoningTokens: 0, costUsd: TURN_FALLBACK * 2, turns: 2 }
    };
    const rows: TranscriptItem[] = [
      { id: 'r1', kind: 'turn', ts: T, status: 'completed', durationMs: 1200, costUsd: TURN_FALLBACK, usage: TURN_USAGE },
      { id: 'r2', kind: 'turn', ts: T + 1, status: 'completed', durationMs: 900, costUsd: TURN_FALLBACK, usage: TURN_USAGE }
    ];
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    await fs.mkdir(path.join(userData, 'sessions', SID_REPAIR), { recursive: true });
    await fs.writeFile(path.join(userData, 'sessions', SID_REPAIR, 'transcript.jsonl'), rows.map((i) => JSON.stringify(i)).join('\n') + '\n');

    const packaged = process.env.HARNESS_E2E_EXE;
    repairApp = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await repairApp.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(repairApp);

    await win.click('.panel-tab:has-text("Usage")');
    const panel = win.getByTestId('usage-panel');
    await panel.waitFor({ timeout: 30_000 });

    // The session index, repriced from the catalog: $0.9405, not the $36.75 the CLI recorded.
    expect(await win.locator('.usage-hero-value').innerText()).toBe('$0.94');

    // And the transcript rows under it, which the same boot rewrote: each turn is worth $0.47025.
    expect(await win.locator('.uturn-row').count()).toBe(2);
    expect(await win.locator('.uturn-row-val').first().innerText()).toBe('$0.47');
    await win.locator('.uturn').first().hover();
    expect(await win.locator('.uturn-readout').innerText()).toContain('Turn 1/2 · $0.47');

    // The repair runs once: the next boot has nothing left that looks fallback-priced.
    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'usage-04-repair.png') });
    await repairApp.close();
    repairApp = null;

    repairApp = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const again: Page = await repairApp.firstWindow();
    await again.waitForSelector('.brand', { timeout: 60_000 });
    await again.click('.panel-tab:has-text("Usage")');
    await again.getByTestId('usage-panel').waitFor({ timeout: 30_000 });
    expect(await again.locator('.usage-hero-value').innerText()).toBe('$0.94');
  }, 240_000);
});

/**
 * The fork ledger: a session counts the money it spent itself.
 *
 * The fixture is the shape history actually holds — a session forked before the fix, carrying its
 * source's totals and its source's turn rows, with nothing on disk saying which is which. The
 * dollars are therefore on two sessions at once, and the analytics hero, which sums the sessions,
 * reads $40.50 instead of $20.50. The boot sweep takes them back from the fork once; the source
 * keeps its own, and the launch after proves the sweep does not run a second time.
 */
describe.runIf(enabled)('electron e2e: fork spend', () => {
  const SID_SRC = 's_fork_src';
  const SID_FORK = 's_fork_resumed';
  const SRC_COST = 20;
  const FORK_OWN_COST = 0.5;
  const FORK_TS = T + 100_000;
  let forkApp: ElectronApplication | null = null;

  afterAll(async () => {
    await forkApp?.close().catch(() => undefined);
  });

  const usage = (costUsd: number, inputTokens: number, outputTokens: number, turns: number): SessionMeta['usage'] => ({
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd,
    turns
  });

  async function seed(userData: string, project: string): Promise<void> {
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const shape = (id: string, title: string, createdAt: number, u: SessionMeta['usage']): SessionMeta => ({
      id,
      title,
      createdAt,
      updatedAt: createdAt,
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      usage: u
    });
    const sessions = [shape(SID_SRC, 'Source session', T, usage(SRC_COST, 1_000_000, 1_000, 1)), shape(SID_FORK, 'Fork of source', FORK_TS, usage(SRC_COST + FORK_OWN_COST, 1_100_000, 1_500, 2))];
    // No analytics.json: the boot path seeds the day from the sessions themselves, exactly as a
    // profile that predates the fix did, which is what puts the source's dollars on the books twice.
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
    await fs.mkdir(path.join(userData, 'sessions', SID_SRC), { recursive: true });
    await fs.mkdir(path.join(userData, 'sessions', SID_FORK), { recursive: true });
    const rows: Record<string, TranscriptItem[]> = {
      [SID_SRC]: [{ id: 'src_turn', kind: 'turn', ts: T + 4, status: 'completed', durationMs: 1_000, costUsd: SRC_COST, usage: { inputTokens: 1_000_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
      // The fork's transcript is the source's turn plus the one turn the fork ran itself. Nothing
      // marks the first as copied; being older than the session is the only thing that says so.
      [SID_FORK]: [
        { id: 'src_turn', kind: 'turn', ts: T + 4, status: 'completed', durationMs: 1_000, costUsd: SRC_COST, usage: { inputTokens: 1_000_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { id: 'fork_turn', kind: 'turn', ts: FORK_TS + 1, status: 'completed', durationMs: 1_000, costUsd: FORK_OWN_COST, usage: { inputTokens: 100_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      ]
    };
    for (const [id, items] of Object.entries(rows)) await fs.writeFile(path.join(userData, 'sessions', id, 'transcript.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  }

  async function launch(userData: string): Promise<Page> {
    const packaged = process.env.HARNESS_E2E_EXE;
    forkApp = await electron.launch({
      executablePath: packaged || (require('electron') as string),
      args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win: Page = await forkApp.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });
    await expectQuietWindow(forkApp);
    return win;
  }

  /** The all-time spend the dashboard leads with, which is the sum over every session. */
  async function dashboardSpend(win: Page): Promise<string> {
    await openAnalytics(win);
    await win.getByRole('tab', { name: 'Spend' }).click();
    return win.locator('.hero-value').innerText();
  }

  /** The right panel's figure for one session, addressed by its sidebar row. */
  async function sessionSpend(win: Page, id: string): Promise<string> {
    await win.locator(`[data-session-id="${id}"]`).click();
    await win.click('.panel-tab:has-text("Usage")');
    const panel = win.getByTestId('usage-panel');
    await panel.waitFor({ timeout: 30_000 });
    return win.locator('.usage-hero-value').innerText();
  }

  it("takes the source's dollars off a fork once, and leaves the source alone", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-usage-fork-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await seed(userData, project);

    const win = await launch(userData);
    // $20 spent once, not twice: the sweep runs in the background, so poll rather than race it.
    await expect.poll(() => dashboardSpend(win), { timeout: 30_000 }).toBe('$20.50');

    await fs.mkdir(shots, { recursive: true });
    await win.screenshot({ path: path.join(shots, 'usage-05-fork-dashboard.png') });
    await forkApp!.close();
    forkApp = null;

    // The second launch reads what the sweep wrote: the fork's own spend, and a turn row the reader
    // can still see in the transcript but that no longer carries anyone's money.
    const again = await launch(userData);
    expect(await sessionSpend(again, SID_FORK)).toBe('$0.50');
    expect(await again.locator('.usage-hero-note').innerText()).toBe('1 turn carried from the forked session');
    expect(await again.locator('.uturn-row').count()).toBe(1);
    expect(await again.locator('.uturn-row-val').first().innerText()).toBe('$0.50');
    // The source session is untouched: the dollars moved off the copy, they were not deleted.
    expect(await sessionSpend(again, SID_SRC)).toBe('$20.00');
    // And the sweep is idempotent — a third state would mean it took the fork's own money too.
    expect(await dashboardSpend(again)).toBe('$20.50');
    await again.screenshot({ path: path.join(shots, 'usage-06-fork-session.png') });
  }, 240_000);
});
