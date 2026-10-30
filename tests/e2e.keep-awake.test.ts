/**
 * Electron end-to-end for "Keep computer awake" in the session header. A local OpenAI-compatible
 * server holds its streaming answer open, so a turn is genuinely in flight while the suite checks
 * what unit tests cannot: the switch reaches the main process, the app takes (and gives back) a real
 * power-save blocker as the turn starts and ends, turning the switch off mid-turn releases it, and
 * the choice does not survive a restart. On macOS the blocker is read back from `pmset -g assertions`
 * for the app's own pid; elsewhere the app's log line is the evidence. No provider key; requires
 * `npm run build` first; gated by VOCS_CODE_E2E_UI=1.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const run = promisify(execFile);
const shotDir = process.env.VOCS_CODE_E2E_SHOTS;
const apps: ElectronApplication[] = [];
let server: http.Server | null = null;

afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  releaseAll();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

/** Streaming answers wait here, so the turn stays in flight until the test lets it finish. */
let gates: Array<() => void> = [];
let requests = 0;
function releaseAll(): void {
  for (const open of gates.splice(0)) open();
}

function startServer(): Promise<number> {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      const stream = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model' };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ ...stream, choices: [{ index: 0, delta: { role: 'assistant', content: 'Working' }, finish_reason: null }] })}\n\n`);
      new Promise<void>((open) => gates.push(open)).then(() => {
        res.write(`data: ${JSON.stringify({ ...stream, choices: [{ index: 0, delta: { content: ' done.' }, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...stream, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      res.on('close', () => undefined);
    });
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port)));
}

const T = Date.now() - 60_000;
const sessionId = 's_keep_awake';

async function launch(userData: string): Promise<{ app: ElectronApplication; win: Page }> {
  const packaged = process.env.HARNESS_E2E_EXE;
  const app = await electron.launch({
    executablePath: packaged || (require('electron') as string),
    args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env: isolatedEnv(userData),
    timeout: 60_000
  });
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForSelector('.brand', { timeout: 60_000 });
  await expectQuietWindow(app);
  return { app, win };
}

/** Power assertions the OS lists against one process: the app's own blocker, as the OS sees it. */
async function osAssertions(pid: number): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  const { stdout } = await run('pmset', ['-g', 'assertions']);
  return stdout.split('\n').filter((line) => line.includes(`pid ${pid}(`) && /NoIdleSleepAssertion|PreventUserIdleSystemSleep|PreventSystemSleep/.test(line));
}

describe.runIf(enabled)('electron e2e: keep computer awake', () => {
  it('holds a real power-save blocker only while an opted-in turn runs, honours switching off mid-turn, and resets on restart', async () => {
    const port = await startServer();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-keep-awake-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
      defaultHarness: 'native',
      providers: [{ id: 'fake', kind: 'ollama', name: 'Fake model server', baseUrl: `http://127.0.0.1:${port}/v1`, hasApiKey: false, enabled: true, models: [{ provider: 'fake', id: 'fake-model', displayName: 'Fake model' }] }]
    }));
    const session: SessionMeta = {
      id: sessionId, title: 'Keep awake', createdAt: T, updatedAt: T, cwd: project, status: 'idle', harnessRef: {},
      config: { harness: 'native', projectRoot: project, permissionMode: 'ask', useWorktree: false, model: { provider: 'fake', model: 'fake-model' } },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    };
    await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
    const mainLog = async () => fs.readFile(path.join(userData, 'logs', 'main.log'), 'utf8').catch(() => '');
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    // Startup briefly passes through idle between starting and running, so the app may give the
    // blocker back and take it again within milliseconds. What must hold is the balance: one taken
    // while a turn works, none left over once it stops.
    const held = async () => {
      const log = await mainLog();
      return count(log, 'keep-awake: holding') - count(log, 'keep-awake: released');
    };

    const { app, win } = await launch(userData);
    const pid = await app.evaluate(() => process.pid);
    const toggle = win.getByRole('switch', { name: 'Keep computer awake' });
    const status = async () => (await win.evaluate((id) => window.harness.invoke('sessions:get', { id }), sessionId) as SessionMeta).status;
    const send = async (text: string) => {
      const box = win.locator('.composer textarea');
      await box.fill(text);
      await box.press('Enter');
    };

    // Off by default; opting in while idle holds nothing.
    await toggle.waitFor({ timeout: 30_000 });
    expect(await toggle.getAttribute('aria-checked')).toBe('false');
    expect(await toggle.getAttribute('data-awake')).toBe('off');
    // Hovering explains it at once: the card is the pill's ::after, hidden until hover, and says what it does.
    const tip = () => toggle.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return { content: after.content, display: after.display, position: after.position };
    });
    expect((await tip()).content).toBe('none');
    await toggle.hover();
    await expect.poll(async () => (await tip()).content, { timeout: 2_000 }).toContain('Only for this session');
    expect((await tip()).content).toContain('Keep computer awake');
    expect((await tip()).content).toContain('idle-sleeping');
    if (shotDir) await win.screenshot({ path: path.join(shotDir, 'keep-awake-tooltip-off.png') });
    await win.mouse.move(5, 5);
    await expect.poll(async () => (await tip()).content, { timeout: 2_000 }).toBe('none');

    await toggle.click();
    await expect.poll(() => toggle.getAttribute('data-awake'), { timeout: 10_000 }).toBe('armed');
    expect(await osAssertions(pid)).toEqual([]);
    expect(await held()).toBe(0);

    // A turn in flight: the app holds one blocker, and the OS can see it.
    await send('Run for a while');
    await expect.poll(() => requests, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(status, { timeout: 15_000 }).toBe('running');
    await expect.poll(() => toggle.getAttribute('data-awake'), { timeout: 10_000 }).toBe('held');
    await expect.poll(held, { timeout: 10_000 }).toBe(1);
    if (process.platform === 'darwin') await expect.poll(async () => (await osAssertions(pid)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    await toggle.hover();
    await expect.poll(async () => (await tip()).content, { timeout: 2_000 }).toContain('Holding your computer awake');
    if (shotDir) await win.screenshot({ path: path.join(shotDir, 'keep-awake-tooltip-held.png') });
    await win.mouse.move(5, 5);

    // The turn ends: the blocker goes back, so the machine may sleep again.
    releaseAll();
    await expect.poll(status, { timeout: 30_000 }).toBe('idle');
    await expect.poll(() => toggle.getAttribute('data-awake'), { timeout: 10_000 }).toBe('armed');
    await expect.poll(held, { timeout: 10_000 }).toBe(0);
    await expect.poll(async () => (await osAssertions(pid)).length, { timeout: 10_000 }).toBe(0);

    // Switching off in the middle of a turn gives the blocker back at once, without touching the turn.
    const before = requests;
    await send('Run again');
    await expect.poll(() => requests, { timeout: 30_000 }).toBeGreaterThan(before);
    await expect.poll(() => toggle.getAttribute('data-awake'), { timeout: 10_000 }).toBe('held');
    await toggle.click();
    await expect.poll(() => toggle.getAttribute('data-awake'), { timeout: 10_000 }).toBe('off');
    await expect.poll(held, { timeout: 10_000 }).toBe(0);
    await expect.poll(async () => (await osAssertions(pid)).length, { timeout: 10_000 }).toBe(0);
    expect(await status()).toBe('running');
    releaseAll();
    await expect.poll(status, { timeout: 30_000 }).toBe('idle');

    // A choice left on does not outlive the app.
    await toggle.click();
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true');
    await app.close();
    const second = await launch(userData);
    const again = second.win.getByRole('switch', { name: 'Keep computer awake' });
    await again.waitFor({ timeout: 30_000 });
    expect(await again.getAttribute('aria-checked')).toBe('false');
    expect(await again.getAttribute('data-awake')).toBe('off');
    expect(await osAssertions(await second.app.evaluate(() => process.pid))).toEqual([]);
  }, 240_000);
});
