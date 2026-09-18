/**
 * End-to-end test for the text-only-model warning and the capability override, driven through the
 * real UI. Requires `npm run build` first. Gated by VOCS_CODE_E2E_UI=1.
 *
 * Deliberately runs with every provider key stripped from the environment and a fresh userData
 * directory, so no request ever leaves the machine: the native harness emits its model list during
 * start() and only needs a key once a turn actually runs.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { openAnalytics, openNewSession, pickModel, seedSettings } from './e2e-ui';
import { AnalyticsStore } from '../src/main/analytics';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
const packaged = process.env.HARNESS_E2E_EXE;
const launchOptions = { executablePath: packaged || require('electron') as string, args: packaged ? [] : [path.join(root, 'out', 'main', 'index.js')] };
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

/** 1x1 transparent PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function isolatedEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER|OPENCODE|GEMINI|GROQ|XAI|MISTRAL)_API_KEY$/.test(k)) continue;
    env[k] = v;
  }
  env.VOCS_CODE_USER_DATA = userData;
  return env;
}

describe.runIf(enabled)('vision capability UI', () => {
  it('warns on a text-only model and lets the user override it', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-vision-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const imageFile = path.join(tmp, 'shot.png');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# vision e2e\n');
    await fs.writeFile(imageFile, Buffer.from(PNG_BASE64, 'base64'));
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await fs.mkdir(shots, { recursive: true });

    const env = isolatedEnv(userData);

    app = await electron.launch({ ...launchOptions, env, timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    // A DeepSeek model: the built-in catalog marks the whole provider text-only.
    await openNewSession(win);
    await win.locator('.harness-card', { has: win.locator('.harness-card-name', { hasText: /^Native loop$/ }) }).click();
    await pickModel(win, 'deepseek/deepseek-v4-flash');
    await win.fill('textarea[placeholder="What should the agent do?"]', 'hello');
    await win.click('button:has-text("Start session")');
    await win.waitForSelector('.header', { timeout: 30_000 });
    // start() publishes the model list before the turn fails for the missing key.
    // The pill names the model the same way the picker did: provider first.
    await win.waitForSelector('.pill:has-text("deepseek/deepseek-v4-flash")', { timeout: 30_000 });

    // No attachment, no warning.
    expect(await win.locator('.composer-warn').count()).toBe(0);

    await win.setInputFiles('.composer-actions input[type=file]', imageFile);
    const warn = win.locator('.composer-warn');
    await warn.waitFor({ timeout: 10_000 });
    // The warning names the model the same qualified way, so it says which provider is text-only.
    expect(await warn.innerText()).toContain('deepseek/deepseek-v4-flash');
    expect(await warn.innerText()).toContain('text-only');
    // The native loop passes attachments through; only Pi strips them itself.
    expect(await warn.innerText()).toContain('may reject');
    await win.screenshot({ path: path.join(shots, 'vision-01-warning.png') });

    // Overriding the model clears the warning without dropping the attachment.
    await warn.locator('button:has-text("It does accept images")').click();
    await warn.waitFor({ state: 'detached', timeout: 10_000 });
    expect(await win.locator('.attachment').count()).toBe(1);

    // The override is persisted and listed in settings, where it can be removed again.
    const stored = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { modelOverrides: Record<string, { supportsImages?: boolean }> };
    expect(stored.modelOverrides['deepseek/deepseek-v4-flash']).toEqual({ supportsImages: true });

    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.locator('.settings-link:has-text("Providers & keys")').click({ timeout: 20_000 });
    const row = win.locator('.override-row', { hasText: 'deepseek/deepseek-v4-flash' });
    await row.waitFor({ timeout: 10_000 });
    await row.scrollIntoViewIfNeeded();
    expect(await row.innerText()).toContain('accepts images');
    await win.screenshot({ path: path.join(shots, 'vision-02-settings.png') });

    await row.locator('button[title="Remove override"]').click();
    await row.waitFor({ state: 'detached', timeout: 10_000 });
    const after = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8')) as { modelOverrides: Record<string, unknown> };
    expect(after.modelOverrides).toEqual({});
  }, 180_000);
});

describe.runIf(enabled)('analytics harness/tool reliability UI', () => {
  it('compares same-model harness calls, failures and denials across exact selected dates', async () => {
    await app?.close();
    app = null;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-code-analytics-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const now = Date.now();
    const dayMs = 86_400_000;
    const dateOf = (ago: number) => new Date(now - ago * dayMs).toISOString().slice(0, 10);
    const sessions: SessionMeta[] = (['claude', 'pi'] as const).map((harness) => ({
      id: harness, title: `${harness} same-model workload`, createdAt: now - 40 * dayMs, updatedAt: now,
      config: { harness, projectRoot: project, permissionMode: 'ask' }, cwd: project, status: 'idle', harnessRef: {},
      activeModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    }));
    // Seed through the production store; no sessions are started and no providers are contacted.
    const store = new AnalyticsStore(userData, { log: () => undefined });
    await store.load(sessions);
    let id = 0;
    const call = (session: string, name: string, status: Extract<TranscriptItem, { kind: 'tool' }>['status'], daysAgo: number) => {
      const ts = now - daysAgo * dayMs;
      store.recordToolCall(session, { id: String(++id), kind: 'tool', name, status, ts }, ts);
    };
    call('claude', 'Read', 'error', 40);
    call('claude', 'Read', 'done', 40);
    call('claude', 'Read', 'done', 10);
    call('claude', 'Read', 'done', 1);
    call('claude', 'read', 'error', 1);
    call('claude', 'Read', 'declined', 1);
    call('pi', 'read', 'done', 1);
    call('pi', 'Read', 'declined', 1);
    call('pi', 'bash', 'declined', 1);
    await store.flush();

    try {
      app = await electron.launch({
        ...launchOptions,
        env: isolatedEnv(userData), timeout: 60_000
      });
      const win = await app.firstWindow();
      await openAnalytics(win);
      await win.getByRole('tab', { name: 'Tools & files' }).click();
      const table = win.getByRole('table', { name: 'Raw error rate by harness' });
      const rows = () => table.getByRole('row').evaluateAll((els) => els.slice(1).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)));
      const expected = (claude: string[]) => [claude, ['Pi', '(0/1) 0%', '(0/1) 0%', '—']];
      await table.waitFor();
      expect(await table.getByRole('columnheader').allTextContents()).toEqual(['Harness', 'Total', 'read', 'bash']);
      expect(await rows()).toEqual(expected(['Claude', '(1/3) 33%', '(1/3) 33%', '—']));
      expect(await win.getByText(/Recorded since update/).innerText()).toContain('same model and workload');
      expect(await win.getByText(/Raw error rate = harness-flagged errors/).innerText()).toContain('executed calls (calls − declined)');
      expect(await win.getByText(`last 30 days · ${dateOf(29)} – ${dateOf(0)}`).count()).toBe(1);

      await win.getByRole('radio', { name: '7 days', exact: true }).click();
      await win.getByText(`last 7 days · ${dateOf(6)} – ${dateOf(0)}`).waitFor();
      await expect.poll(rows).toEqual(expected(['Claude', '(1/2) 50%', '(1/2) 50%', '—']));
      expect(await win.getByRole('radio', { name: '7 days', exact: true }).getAttribute('aria-checked')).toBe('true');

      await win.getByRole('radio', { name: 'All time' }).click();
      await win.getByText(`all time · ${dateOf(40)} – ${dateOf(0)}`).waitFor();
      await expect.poll(rows).toEqual(expected(['Claude', '(2/5) 40%', '(2/5) 40%', '—']));
      await win.getByRole('radio', { name: '30 days', exact: true }).click();
      await win.getByText(`last 30 days · ${dateOf(29)} – ${dateOf(0)}`).waitFor();
      await expect.poll(rows).toEqual(expected(['Claude', '(1/3) 33%', '(1/3) 33%', '—']));
      // A bounded range rebuilds its model rows from the stored day slices, whose labels were just
      // rewritten to the bare id: both matrices still name the model by its qualified key.
      const modelTable = win.locator('.atable').filter({ has: win.getByRole('columnheader', { name: 'Model', exact: true }) });
      await expect.poll(() => modelTable.locator('tbody tr').first().locator('td').first().innerText()).toBe('anthropic/claude-sonnet-4-6');
      const harnessModelTable = win.locator('.atable').filter({ has: win.getByRole('columnheader', { name: 'Harness · model' }) });
      await expect.poll(() => harnessModelTable.locator('tbody tr').first().locator('td').first().innerText()).toBe('Claude · anthropic/claude-sonnet-4-6');
      // A real process restart with the same userData must preserve exact counters.
      await app.close();
      app = await electron.launch({ ...launchOptions, env: isolatedEnv(userData), timeout: 60_000 });
      const restarted = await app.firstWindow();
      await openAnalytics(restarted);
      await restarted.getByRole('tab', { name: 'Tools & files' }).click();
      await restarted.getByRole('radio', { name: 'All time' }).click();
      const restored = restarted.getByRole('table', { name: 'Raw error rate by harness' });
      await restored.waitFor();
      await expect.poll(() => restored.getByRole('row').evaluateAll((els) => els.slice(1).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent))))
        .toEqual(expected(['Claude', '(2/5) 40%', '(2/5) 40%', '—']));
    } finally {
      await app?.close();
      app = null;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  it('separates raw harness errors into real failures, informational exits and unknowns, then drills into a signature', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-reliability-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const now = Date.now();
    const sessions: SessionMeta[] = (['claude', 'pi'] as const).map((harness) => ({
      id: harness, title: `${harness} reliability workload`, createdAt: now - 40 * 86_400_000, updatedAt: now,
      config: { harness, projectRoot: project, permissionMode: 'ask' }, cwd: project, status: 'idle', harnessRef: {},
      activeModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    }));
    // Seed through the production store: four executed shell calls with real exit codes, one denial.
    const store = new AnalyticsStore(userData, { log: () => undefined });
    await store.load(sessions);
    let id = 0;
    const call = (session: string, item: Partial<Extract<TranscriptItem, { kind: 'tool' }>> & { name: string; status: Extract<TranscriptItem, { kind: 'tool' }>['status'] }) => {
      const ts = now - 1_000;
      store.recordToolCall(session, { id: String(++id), kind: 'tool', ts, ...item } as Extract<TranscriptItem, { kind: 'tool' }>, ts);
    };
    // A real failure: non-zero exit with a program error in the output.
    call('claude', { name: 'Bash', status: 'error', exitCode: 1, input: { command: 'node build.js' }, output: 'Error: Cannot find module ./missing\n' });
    // A non-zero exit that is not a failure: a search that matched nothing.
    call('claude', { name: 'Bash', status: 'error', exitCode: 1, input: { command: 'rg needle src' }, output: '' });
    call('claude', { name: 'Bash', status: 'done', exitCode: 0, input: { command: 'npm test' }, output: 'ok\n' });
    // A second harness: a non-zero exit the rules cannot attribute.
    call('pi', { name: 'bash', status: 'error', exitCode: 2, input: { command: 'git push origin main' }, output: 'fatal: could not read from remote\n' });
    call('pi', { name: 'read', status: 'declined' });
    await store.flush();

    try {
      app = await electron.launch({ ...launchOptions, env: isolatedEnv(userData), timeout: 60_000 });
      const win = await app.firstWindow();
      await openAnalytics(win);
      await win.getByRole('tab', { name: 'Reliability' }).click();
      const kpi = (label: string) => win.locator('.kpi').filter({ has: win.locator('.kpi-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.kpi-value');
      // Three raw errors out of four executed calls are not three failures: one failure, one
      // informational exit (the empty search), one the rules refuse to name.
      await expect.poll(() => kpi('Raw error status').innerText()).toBe('75% (3/4)');
      await expect.poll(() => kpi('Unexpected failures').innerText()).toBe('25% (1/4)');
      await expect.poll(() => kpi('Executed calls').innerText()).toBe('4');

      const byHarness = win.getByRole('table', { name: 'Reliability by harness', exact: true });
      const claudeRow = byHarness.getByRole('row').filter({ hasText: 'Claude' });
      expect(await byHarness.getByRole('columnheader').allTextContents()).toEqual(['Harness', 'Executed', 'Raw error status', 'Unexpected failures', 'Informational', 'Diagnostic', 'Unknown', 'Incidents', 'Recovered', 'Unrecovered', 'Turns completed', 'Sample']);
      expect(await claudeRow.getByRole('cell').allTextContents()).toEqual(['Claude', '3', '67% (2/3) n<20', '33% (1/3) n<20', '33% (1/3) n<20', '0% (0/3) n<20', '0% (0/3) n<20', '33% (1/3) n<20', '0% (0/1) n<20', '33% (1/3) n<20', '—', 'n<20']);

      // Each pattern sorts into its own signature; the informational exit is labelled as such, not as a failure.
      const signatures = win.getByRole('table', { name: 'Failure signatures', exact: true });
      const search = signatures.getByRole('row').filter({ hasText: 'search_no_match' });
      await search.waitFor();
      expect(await search.innerText()).toContain('Informational non-zero');
      const unknown = signatures.getByRole('row').filter({ hasText: 'process_nonzero_unknown' });
      expect(await unknown.innerText()).toContain('Unknown');
      const failure = signatures.getByRole('button', { name: 'bash | program_error | node' });
      await failure.waitFor();

      // Drilling into the signature fetches the real execution: its command and exit code.
      await failure.click();
      const drill = win.getByTestId('signature-drilldown');
      await drill.waitFor();
      const row = drill.getByTestId('execution-row');
      await expect.poll(() => row.count()).toBe(1);
      const text = await row.innerText();
      expect(text).toContain('node build.js');
      expect(text).toContain('exit 1');
      expect(text).toContain('Program raised an error');
    } finally {
      await app?.close();
      app = null;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});

describe.runIf(enabled)('analytics code output UI', () => {
  it('rates lines written per token for turns that wrote code, and shows what it could not measure', async () => {
    await app?.close();
    app = null;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-code-output-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    const now = Date.now();
    const session = (id: string, harness: 'claude' | 'cursor'): SessionMeta => ({
      id,
      title: `${harness} code workload`,
      createdAt: now - 40 * 86_400_000,
      updatedAt: now,
      config: { harness, projectRoot: project, permissionMode: 'ask' },
      cwd: project,
      status: 'idle',
      harnessRef: {},
      activeModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
    });
    const claude = session('code-claude', 'claude');
    const cursor = session('code-cursor', 'cursor');
    // Seed through the production store: a turn that writes 150 lines over 900k tokens, one that
    // writes code without reporting tokens, and a harness that reports no diff at all.
    const store = new AnalyticsStore(userData, { log: () => undefined });
    await store.load([claude, cursor]);
    const ts = now - 60_000;
    const diff = `--- a.ts\n+++ a.ts\n@@ -0,0 +1,150 @@\n${Array.from({ length: 150 }, (_, i) => `+line ${i}`).join('\n')}\n`;
    const tool = (id: string, changes: Extract<TranscriptItem, { kind: 'tool' }>['changes']): Extract<TranscriptItem, { kind: 'tool' }> => ({ id, kind: 'tool', ts, name: 'Edit', hint: 'edit', input: {}, status: 'done', changes });

    store.recordUserMessage(claude, { id: 'u1', kind: 'user', ts, text: 'write it' }, ts);
    store.recordToolCall('code-claude', tool('a', [{ path: 'a.ts', kind: 'update', diff }]), ts);
    store.recordTurn(claude, { id: 'turn1', kind: 'turn', ts, status: 'completed', durationMs: 20_000, costUsd: 3, usage: { inputTokens: 1000, outputTokens: 5000, cacheReadTokens: 894_000, cacheWriteTokens: 0 } }, ts);

    store.recordUserMessage(claude, { id: 'u2', kind: 'user', ts: ts + 1, text: 'again' }, ts + 1);
    store.recordToolCall('code-claude', tool('b', [{ path: 'b.ts', kind: 'update', diff }]), ts + 1);
    // Wrote lines, but the harness reported no counters: nothing to divide them by.
    store.recordTurn(claude, { id: 'turn2', kind: 'turn', ts: ts + 1, status: 'completed', durationMs: 20_000 }, ts + 1);

    store.recordUserMessage(cursor, { id: 'u3', kind: 'user', ts: ts + 2, text: 'edit it' }, ts + 2);
    store.recordToolCall('code-cursor', tool('c', [{ path: 'c.ts', kind: 'update' }]), ts + 2);
    store.recordTurn(cursor, { id: 'turn3', kind: 'turn', ts: ts + 2, status: 'completed', durationMs: 20_000, usage: { inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } }, ts + 2);
    await store.flush();

    try {
      app = await electron.launch({ ...launchOptions, env: isolatedEnv(userData), timeout: 60_000 });
      const win: Page = await app.firstWindow();
      await openAnalytics(win);
      await win.getByRole('tab', { name: 'Code output' }).click();

      // 150 lines over 900k tokens is 167 lines per million; the cost-only and diff-less turns are out.
      await expect.poll(() => win.locator('.hero-value').innerText()).toBe('167 lines / M tokens');
      const kpi = (label: string) => win.locator('.kpi').filter({ has: win.locator('.kpi-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.kpi-value');
      await expect.poll(() => kpi('Lines written').innerText()).toBe('150');
      await expect.poll(() => kpi('Tokens behind them').innerText()).toBe('900k');
      await expect.poll(() => kpi('Cost per 1k lines').innerText()).toBe('$20.00 / 1k lines');

      const byHarness = win.getByRole('table', { name: 'Code output by harness', exact: true });
      await byHarness.waitFor();
      // Only the harness that wrote code and reported its tokens is rated; Cursor has no rows at all.
      expect(await byHarness.getByRole('columnheader').allTextContents()).toEqual(['Harness', 'Turns with code', 'Lines written', 'Tokens', 'Lines / M tokens', '$ / 1k lines', 'Written by subagents', 'Sample']);
      expect(await byHarness.getByRole('row').filter({ hasText: 'Claude' }).getByRole('cell').allTextContents()).toEqual(['Claude', '1', '150', '900k', '166.7', '$20.00 / 1k lines', '0%', 'n<3']);
      expect(await byHarness.getByRole('row').filter({ hasText: 'Cursor' }).count()).toBe(0);

      // Every turn in range is accounted for, including the two that stayed out of the rate.
      const coverage = win.getByRole('table', { name: 'Code output coverage', exact: true });
      const bucket = (label: string) => coverage.getByRole('row').filter({ hasText: label });
      expect(await bucket('Wrote code and reported tokens').getByRole('cell').allTextContents()).toEqual(['Wrote code and reported tokens', '1', '150', '900k', 'yes']);
      expect(await bucket('Wrote code, reported no tokens').getByRole('cell').allTextContents()).toEqual(['Wrote code, reported no tokens', '1', '150', '—', 'no']);
      expect(await bucket('Changed files without a diff (Cursor)').getByRole('cell').allTextContents()).toEqual(['Changed files without a diff (Cursor)', '1', '0', '—', 'no']);
    } finally {
      await app?.close();
      app = null;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
