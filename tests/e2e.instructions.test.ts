/**
 * End-to-end test for Settings → Instructions, driven through the real UI. Requires
 * `npm run build` first. Gated by VOCS_CODE_E2E_UI=1 (the e2e guard sets it).
 *
 * The app's own instruction layer is one file per scope under `<userData>/instructions/`. The suite
 * runs against a throwaway userData, so it proves the page writes there — not into any harness's own
 * global file, and not into the real profile.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';
import { isolatedEnv, seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
// These fixture-only flows never store credentials; keep macOS from probing the user's keychain.
const launchOptions = { executablePath: require('electron') as string, args: ['--use-mock-keychain', path.join(root, 'out', 'main', 'index.js')] };
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

describe.runIf(enabled)('instructions UI', () => {
  it('writes the shared and harness-specific files, and removes one when cleared', async () => {
    const tmp = path.join(os.tmpdir(), `vocs-code-instructions-${Date.now()}`);
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# instructions e2e\n');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));

    app = await electron.launch({ ...launchOptions, env: isolatedEnv(userData), timeout: 60_000 });
    const win: Page = await app.firstWindow();
    await win.waitForSelector('.brand', { timeout: 60_000 });

    await win.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
    await win.locator('.settings-link:has-text("Instructions")').click({ timeout: 20_000 });
    await win.waitForSelector('.pi-prompt-editor', { timeout: 20_000 });

    // Every scope is offered, shared first, and none of them is set yet.
    const tabs = await win.locator('.pi-tab').allInnerTexts();
    expect(tabs.map((t) => t.replace(/not set/g, '').trim())).toEqual(['All harnesses', 'Pi', 'Claude Agent SDK', 'Codex', 'Cursor', 'ACP agents', 'Native']);
    await expect.poll(async () => win.locator('.pi-tab:has-text("not set")').count()).toBe(7);

    // The shared file lands under this run's userData, not under a harness's own config.
    const editor = win.locator('.pi-prompt-editor');
    await editor.fill('Always be proactive.\n');
    await win.locator('.pi-prompt-actions button:has-text("Save")').click();
    const globalFile = path.join(userData, 'instructions', 'global.md');
    await expect.poll(async () => fs.readFile(globalFile, 'utf8').catch(() => '')).toBe('Always be proactive.\n');
    await expect.poll(async () => win.locator('.pi-tab:has-text("not set")').count()).toBe(6);

    // A harness tab adds its own file rather than editing the shared one.
    await win.locator('.pi-tab:has-text("Pi")').click();
    await win.locator('.pi-prompt-editor').fill('Pi: keep it terse.\n');
    await win.locator('.pi-prompt-actions button:has-text("Save")').click();
    await expect.poll(async () => fs.readFile(path.join(userData, 'instructions', 'pi.md'), 'utf8').catch(() => '')).toBe('Pi: keep it terse.\n');
    expect(await fs.readFile(globalFile, 'utf8')).toBe('Always be proactive.\n');

    // Saving an empty file removes the layer again, so the editor can switch it off.
    await win.locator('.pi-prompt-editor').fill('   \n');
    await win.locator('.pi-prompt-actions button:has-text("Save")').click();
    await expect.poll(async () => fs.access(path.join(userData, 'instructions', 'pi.md')).then(() => true).catch(() => false)).toBe(false);
  }, 120_000);
});

describe.runIf(enabled)('chat import UI', () => {
  it('offers import on first launch, copies both histories through Settings and deduplicates after restart', async () => {
    await app?.close();
    app = null;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-code-chat-import-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const claudeDir = path.join(tmp, 'claude');
    const codexDir = path.join(tmp, 'codex');
    const claudeFile = path.join(claudeDir, 'projects', 'fixture-project', 'claude-fixture.jsonl');
    const codexFile = path.join(codexDir, 'sessions', '2026', '10', '30', 'rollout-codex-fixture.jsonl');
    for (const dir of [userData, project, path.dirname(claudeFile), path.dirname(codexFile)]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, { onboardingDone: false, agent: { enabled: false } }));
    const claudeText = [
      { type: 'user', uuid: 'claude-clear', sessionId: 'claude-fixture', cwd: project, timestamp: '2026-10-30T00:58:00Z', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } },
      { type: 'user', uuid: 'claude-local-output', sessionId: 'claude-fixture', cwd: project, timestamp: '2026-10-30T00:59:00Z', message: { role: 'user', content: [{ type: 'text', text: '<local-command-stdout>Conversation cleared.</local-command-stdout>' }] } },
      { type: 'user', uuid: 'claude-user', sessionId: 'claude-fixture', cwd: project, timestamp: '2026-10-30T01:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Claude import fixture' }] } },
      { type: 'assistant', uuid: 'claude-assistant', sessionId: 'claude-fixture', cwd: project, timestamp: '2026-10-30T01:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude conversation survived import.' }] } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n';
    const codexText = [
      { type: 'session_meta', timestamp: '2026-10-30T02:00:00Z', payload: { id: 'codex-fixture', cwd: project, timestamp: '2026-10-30T02:00:00Z' } },
      { type: 'response_item', timestamp: '2026-10-30T02:00:00Z', payload: { id: 'codex-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex import fixture' }] } },
      { type: 'response_item', timestamp: '2026-10-30T02:01:00Z', payload: { id: 'codex-assistant', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex conversation survived import.' }] } },
      { type: 'response_item', timestamp: '2026-10-30T02:02:00Z', payload: { id: 'discarded-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'DISCARDED-CODEX-TURN question' }] } },
      { type: 'response_item', timestamp: '2026-10-30T02:03:00Z', payload: { id: 'discarded-assistant', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DISCARDED-CODEX-TURN answer' }] } },
      { type: 'event_msg', timestamp: '2026-10-30T02:04:00Z', payload: { type: 'thread_rolled_back', num_turns: 1 } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n';
    await fs.writeFile(claudeFile, claudeText);
    await fs.writeFile(codexFile, codexText);
    const skippedFixtures = [
      { file: path.join(path.dirname(claudeFile), 'command-only.jsonl'), text: claudeText.split('\n').slice(0, 2).join('\n') + '\n' },
      { file: path.join(path.dirname(claudeFile), 'missing-project.jsonl'), text: JSON.stringify({ type: 'user', uuid: 'missing-project', sessionId: 'missing-project', message: { role: 'user', content: 'History without project metadata' } }) + '\n' },
      { file: path.join(path.dirname(claudeFile), 'invalid.jsonl'), text: 'not-json\n' },
    ];
    await Promise.all(skippedFixtures.map(({ file, text }) => fs.writeFile(file, text)));
    const env = isolatedEnv(userData, { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir });
    const launch = async (): Promise<Page> => {
      app = await electron.launch({ ...launchOptions, env, timeout: 60_000 });
      const win = await app.firstWindow();
      await win.waitForSelector('.brand', { timeout: 60_000 });
      return win;
    };
    const openImport = async (win: Page) => {
      await win.locator('.sidebar-bottom').getByRole('button', { name: 'Settings', exact: true }).click();
      await win.getByRole('button', { name: 'Import chats', exact: true }).click();
      await win.getByRole('heading', { name: 'Import chats' }).waitFor();
    };
    const checkSkipReasons = async (win: Page, source: string) => {
      const reasons = win.getByRole('list', { name: 'Skipped chat reasons' });
      if (source === 'Claude Code') {
        await win.getByText('3 history files skipped.', { exact: true }).waitFor();
        expect(await reasons.locator('li').allTextContents()).toEqual([
          '1 — Empty or no conversation text', '1 — Missing or invalid project directory metadata', '1 — Unrecognized or invalid history'
        ]);
      } else {
        expect(await reasons.count()).toBe(0);
      }
    };
    const readSessions = async (): Promise<SessionMeta[]> => JSON.parse(await fs.readFile(path.join(userData, 'sessions.json'), 'utf8').catch(() => '[]'));
    let win = await launch();
    // First-run users can find the feature without completing the provider setup steps.
    await win.getByRole('button', { name: 'Import chats from Claude Code or Codex' }).click();
    await win.getByRole('heading', { name: 'Import chats' }).waitFor();
    expect(await readSessions()).toHaveLength(0);
    await win.getByRole('button', { name: 'Done', exact: true }).click();
    await win.locator('.modal').waitFor({ state: 'hidden' });
    await openImport(win);
    for (const [source, title] of [['Claude Code', 'Claude import fixture'], ['Codex', 'Codex import fixture']] as const) {
      await win.getByRole('button', { name: `Scan ${source}`, exact: true }).click();
      await win.getByRole('checkbox', { name: `Import ${title}`, exact: true }).check();
      await checkSkipReasons(win, source);
      if (source === 'Claude Code') {
        // The global form-input rule is full-width: checkboxes must keep their own compact size.
        expect((await win.getByRole('checkbox', { name: `Import ${title}`, exact: true }).boundingBox())!.width).toBeLessThan(24);
        expect((await win.locator('.provider-card').boundingBox())!.height).toBeLessThan(150);
        await fs.mkdir(path.join(root, 'tests', 'artifacts'), { recursive: true });
        await win.screenshot({ path: path.join(root, 'tests', 'artifacts', 'chat-import.png') });
      }
      await win.getByRole('button', { name: 'Import selected (1)', exact: true }).click();
      await expect.poll(async () => win.getByRole('checkbox', { name: `Import ${title}`, exact: true }).isDisabled()).toBe(true);
    }
    await expect.poll(async () => (await readSessions()).length).toBe(2);
    const sessions = await readSessions();
    expect(new Set(sessions.map((session) => session.config.harness))).toEqual(new Set(['claude', 'codex']));
    for (const session of sessions) {
      expect(session.title).toBe(session.config.harness === 'claude' ? 'Claude import fixture' : 'Codex import fixture');
      expect(session.harnessRef).toEqual({});
      expect(session.usage.costUsd).toBe(0);
      expect(session.worktreeBranch).toBeUndefined();
      const items: TranscriptItem[] = (await fs.readFile(path.join(userData, 'sessions', session.id, 'transcript.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(items.filter((item) => item.kind === 'user' || item.kind === 'assistant')).toHaveLength(2);
      expect(JSON.stringify(items)).not.toMatch(/DISCARDED-CODEX-TURN|command-name|local-command-stdout|Conversation cleared/);
      expect(await fs.readFile(path.join(userData, 'sessions', session.id, 'fork-context.md'), 'utf8')).not.toMatch(/DISCARDED-CODEX-TURN|command-name|local-command-stdout|Conversation cleared/);
    }
    for (const source of ['Claude', 'Codex']) {
      await win.getByTestId('session-row').filter({ hasText: `${source} import fixture` }).click();
      await win.getByText(`${source} conversation survived import.`, { exact: true }).waitFor();
      expect(await win.getByText('DISCARDED-CODEX-TURN', { exact: false }).count()).toBe(0);
    }
    expect(await win.getByText('<command-name>', { exact: false }).count()).toBe(0);
    expect(await win.getByText('Conversation cleared.', { exact: false }).count()).toBe(0);
    await app!.close();
    app = null;
    win = await launch();
    await openImport(win);
    for (const [source, title] of [['Claude Code', 'Claude import fixture'], ['Codex', 'Codex import fixture']] as const) {
      await win.getByRole('button', { name: `Scan ${source}`, exact: true }).click();
      const checkbox = win.getByRole('checkbox', { name: `Import ${title}`, exact: true });
      await checkbox.waitFor();
      await checkSkipReasons(win, source);
      expect(await checkbox.isDisabled()).toBe(true);
      expect(await win.getByRole('button', { name: 'Import selected', exact: true }).isDisabled()).toBe(true);
    }
    const restored = await readSessions();
    expect(restored).toEqual(sessions);
    for (const source of ['Claude', 'Codex']) {
      await win.getByTestId('session-row').filter({ hasText: `${source} import fixture` }).click();
      await win.getByText(`${source} conversation survived import.`, { exact: true }).waitFor();
      expect(await win.getByText('DISCARDED-CODEX-TURN', { exact: false }).count()).toBe(0);
    }
    expect(await win.getByText('<command-name>', { exact: false }).count()).toBe(0);
    expect(await win.getByText('Conversation cleared.', { exact: false }).count()).toBe(0);
    expect(await fs.readFile(claudeFile)).toEqual(Buffer.from(claudeText));
    expect(await fs.readFile(codexFile)).toEqual(Buffer.from(codexText));
    for (const { file, text } of skippedFixtures) expect(await fs.readFile(file)).toEqual(Buffer.from(text));
  }, 180_000);
});
