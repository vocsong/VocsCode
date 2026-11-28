/** No-provider Electron regression for the Shared tab and /skill dispatch over ACP. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/shared/types';
import { expectQuietWindow, isolatedEnv, seedSettings } from './e2e-ui';

const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const skillName = 'offline-museum-guide';
const description = 'Describe a museum tile.';
const sentinel = 'Shared skill E2E sentinel: façade';
const skillBody = `${sentinel}\n\nDescribe a blue tile,  not a red tile.`;
const skillContent = `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${skillBody}\n`;
const stageCommand = `/skill ${skillName}`;
const reply = 'The shared skill prompt reached the offline agent.';

type PromptBlock = { type: string; text: string };

/** Same stdio/launcher pattern as e2e.antigravity-turn. Only session/prompt counts as a send. */
async function scriptedAgy(tmp: string, promptLog: string): Promise<string> {
  const script = path.join(tmp, 'scripted-agy.cjs');
  await fs.writeFile(promptLog, '');
  await fs.writeFile(script, `
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
if (process.argv.includes('--version')) { console.log('agy 99.0.0'); process.exit(0); }
const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => send({ id, result });
  switch (method) {
    case 'initialize':
      reply({ protocolVersion: params.protocolVersion, agentCapabilities: { sessionCapabilities: { list: {} } } });
      break;
    case 'session/list': reply({ sessions: [] }); break;
    case 'session/new': reply({ sessionId: 'scripted-' + process.pid, modes: {
      currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }]
    } }); break;
    case 'session/set_mode': reply({}); break;
    case 'session/prompt':
      appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(params.prompt) + '\\n');
      send({ method: 'session/update', params: {
        sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(reply)} } }
      } });
      reply({ stopReason: 'end_turn' });
      break;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: 'Unexpected method: ' + method } });
  }
});
`);
  const isWin = process.platform === 'win32';
  const shim = path.join(tmp, isWin ? 'agy.cmd' : 'agy');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Only --version matters to the fixture; avoid re-parsing the JSON --settings argument in cmd.
  await fs.writeFile(shim, isWin
    ? `@echo off\r\n"${process.execPath}" "${script}" %1\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  return shim;
}

async function openSharedSkills(win: Page) {
  await win.getByRole('button', { name: 'Skills', exact: true }).click();
  const shared = win.getByRole('tab', { name: 'Shared', exact: true });
  await shared.waitFor();
  expect(await shared.getAttribute('aria-selected')).toBe('true');
  return win.getByRole('tabpanel', { name: 'Shared', exact: true });
}

function composer(win: Page) {
  const bar = win.locator('.composer');
  return { draft: bar.locator('textarea'), send: bar.getByRole('button', { name: 'Send', exact: true }) };
}

async function expectSingleTurn(win: Page, command: string) {
  const user = win.locator('.msg-user');
  const turns = win.locator('.turn-footer .turn-label');
  await turns.getByText('Turn complete', { exact: true }).waitFor();
  expect(await turns.allInnerTexts()).toEqual(['Turn complete']);
  expect(await win.locator('.msg-assistant .md').allInnerTexts()).toEqual([reply]);
  expect(await user.locator('.msg-text').allTextContents()).toEqual([command]);
  await user.getByText(`Shared skill: ${skillName}`, { exact: true }).waitFor();
  expect(await user.innerText()).not.toContain(sentinel);
}

async function expectReceipt(win: Page, id: string, command: string, revision: string) {
  const items = await win.evaluate((id) => window.harness.invoke('sessions:transcript', { id }), id);
  const users = items.filter((item) => item.kind === 'user');
  expect(users.map(({ text, sharedSkill }) => ({ text, sharedSkill }))).toEqual([
    { text: command, sharedSkill: { name: skillName, revision } }
  ]);
  expect(JSON.stringify(items)).not.toContain(sentinel);
}

describe.runIf(process.env.VOCS_CODE_E2E_UI === '1')('electron e2e: Shared skills', () => {
  it('stages a reviewed skill as one normal turn and refuses an external edit without losing the draft', async () => {
    // The catalog rejects linked ancestors; e.g. macOS can report a temp path via /var.
    const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'vocs-shared-skills-'));
    const home = path.join(tmp, 'home');
    const appData = path.join(home, 'AppData', 'Roaming');
    const localAppData = path.join(home, 'AppData', 'Local');
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const skillFile = path.join(home, '.agents', 'skills', skillName, 'SKILL.md');
    const reviewFile = path.join(userData, 'shared-skills.json');
    const promptLog = path.join(tmp, 'prompts.jsonl');
    let app: ElectronApplication | undefined;
    const close = async () => {
      await app?.close();
      app = undefined;
    };
    try {
      // Windows resolves appData before Electron applies the userData override.
      await Promise.all([appData, localAppData, userData, project].map((dir) => fs.mkdir(dir, { recursive: true })));
      const agy = await scriptedAgy(tmp, promptLog);
      await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
        defaultHarness: 'antigravity', binaries: { agy }, agent: { enabled: false }
      }));
      const now = Date.now();
      const session: SessionMeta = {
        id: 's_shared_skill_e2e', title: 'Offline Antigravity fixture', createdAt: now, updatedAt: now,
        config: { harness: 'antigravity', projectRoot: project, permissionMode: 'ask' },
        cwd: project, status: 'idle', harnessRef: {}, queued: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
      };
      await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
      const packaged = process.env.HARNESS_E2E_EXE;
      const dataArg = `--user-data-dir=${userData}`;
      const env = isolatedEnv(userData, {
        HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
        PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent')
      });
      for (const key of ['ELECTRON_RENDERER_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
      const launchOpts = {
        executablePath: packaged || (require('electron') as string),
        args: packaged ? [dataArg] : [path.join(root, 'out', 'main', 'index.js'), dataArg],
        env,
        timeout: 30_000
      };
      const launch = async () => {
        app = await electron.launch(launchOpts);
        const win = await app.firstWindow();
        await win.waitForSelector('.brand', { timeout: 20_000 });
        await expectQuietWindow(app);
        const isolation = await app.evaluate(({ app }) => ({
          home: process.getBuiltinModule('node:os')!.homedir(), userData: app.getPath('userData')
        }));
        expect(isolation).toEqual({ home, userData });
        win.setDefaultTimeout(12_000);
        return win;
      };
      const readPrompts = async (): Promise<PromptBlock[][]> =>
        (await fs.readFile(promptLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

      const win = await launch();
      await win.getByTestId('session-row').click();
      const { draft, send } = composer(win);
      await draft.waitFor();

      const shared = await openSharedSkills(win);
      await shared.getByRole('button', { name: 'New shared skill', exact: true }).click();
      const create = win.getByRole('dialog', { name: 'New shared skill', exact: true });
      await create.getByRole('textbox', { name: 'Name', exact: true }).fill(skillName);
      await create.getByRole('textbox', { name: 'Description', exact: true }).fill(description);
      await create.getByRole('button', { name: 'Create', exact: true }).click();
      const preview = shared.getByLabel('SKILL.md', { exact: true });
      await preview.waitFor();
      const initialContent = await fs.readFile(skillFile, 'utf8');
      expect(initialContent).toContain(description);
      expect(await preview.textContent()).toBe(initialContent);

      await shared.getByRole('button', { name: 'Edit', exact: true }).click();
      const edit = win.getByRole('dialog', { name: `Edit ${skillName}`, exact: true });
      const editor = edit.getByRole('textbox', { name: 'SKILL.md', exact: true });
      expect(await editor.inputValue()).toBe(initialContent);
      await editor.fill(skillContent);
      await edit.getByRole('button', { name: 'Save', exact: true }).click();
      await edit.waitFor({ state: 'hidden' });
      expect(await preview.textContent()).toBe(skillContent);
      expect(await fs.readFile(skillFile)).toEqual(Buffer.from(skillContent, 'utf8'));
      const revision = createHash('sha256').update(skillContent).digest('hex');

      const use = shared.getByRole('button', { name: 'Use in session', exact: true });
      expect(await use.isDisabled()).toBe(true);
      await shared.getByRole('button', { name: 'Mark as reviewed', exact: true }).click();
      await shared.getByRole('button', { name: 'Disable', exact: true }).waitFor();
      const review = await fs.readFile(reviewFile, 'utf8');
      expect(JSON.parse(review)).toEqual({ version: 1, approvals: { [skillName]: revision } });
      if (process.platform !== 'win32') expect((await fs.stat(reviewFile)).mode & 0o077).toBe(0);
      expect(await fs.readdir(path.dirname(skillFile))).toEqual(['SKILL.md']);

      await use.click();
      await expect.poll(async () => (await draft.inputValue()).trimEnd()).toBe(stageCommand);
      expect(await readPrompts()).toEqual([]);
      expect(await win.locator('.msg-user').count()).toBe(0);

      const args = ' For  "the blue tile"\nUse two words. ';
      const command = `${stageCommand} ${args}`;
      await draft.fill(command);
      await send.click();
      await expectSingleTurn(win, command);
      await expect.poll(() => draft.inputValue()).toBe('');
      await expectReceipt(win, session.id, command, revision);
      const prompts = await readPrompts();
      expect(prompts).toEqual([[{ type: 'text', text: expect.any(String) }]]);
      const text = prompts[0]![0]!.text;
      expect(text).toContain(skillBody);
      expect(text.split(args)).toHaveLength(2);
      const promptBytes = Buffer.from(text, 'utf8');
      const sentinelBytes = Buffer.from(sentinel, 'utf8');
      expect(promptBytes.indexOf(sentinelBytes)).toBeGreaterThanOrEqual(0);
      expect(promptBytes.lastIndexOf(sentinelBytes)).toBe(promptBytes.indexOf(sentinelBytes));

      await close();
      const transcriptFile = path.join(userData, 'sessions', session.id, 'transcript.jsonl');
      expect(await fs.readFile(transcriptFile, 'utf8')).not.toContain(sentinel);
      const reopened = await launch();
      await reopened.getByTestId('session-row').click();
      await expectSingleTurn(reopened, command);
      await expectReceipt(reopened, session.id, command, revision);

      // The saved review can still stage a command after restart, but it cannot authorize new bytes.
      const reopenedShared = await openSharedSkills(reopened);
      await reopenedShared.getByRole('button', { name: new RegExp(`^${skillName}\\b`) }).click();
      const reopenedPreview = reopenedShared.getByLabel('SKILL.md', { exact: true });
      expect(await reopenedPreview.textContent()).toBe(skillContent);
      await reopenedShared.getByRole('button', { name: 'Use in session', exact: true }).click();
      const retry = composer(reopened);
      await expect.poll(async () => (await retry.draft.inputValue()).trimEnd()).toBe(stageCommand);
      const staleCommand = `${stageCommand} For  "the gray tile"`;
      await retry.draft.fill(staleCommand);
      await fs.writeFile(skillFile, skillContent.replace('blue tile', 'gray tile'), 'utf8');
      await retry.send.click();
      await reopened.getByRole('alert').filter({ hasText: /changed on disk.*review it again/i }).waitFor();
      await expect.poll(() => retry.draft.inputValue()).toBe(staleCommand);
      await expectSingleTurn(reopened, command);
      await expectReceipt(reopened, session.id, command, revision);
      await close();
      expect(await readPrompts()).toEqual(prompts);
      expect(await fs.readFile(reviewFile, 'utf8')).toBe(review);
    } finally {
      try {
        await close();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }, 120_000);
});
