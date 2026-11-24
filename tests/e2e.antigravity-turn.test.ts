/** No-provider Electron regression: a scripted agy exercises the real ACP stdio transport. */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { expectQuietWindow, isolatedEnv, openNewSession, seedSettings } from './e2e-ui';

const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const firstReply = 'The first reply arrived before Antigravity stalled.';
const followUp = 'Confirm Antigravity recovered.';
const followUpReply = 'The follow-up reached a new ACP process.';
const questionPrompt = 'Ask me which window and models to use.';

async function scriptedAgy(tmp: string, cancelLog: string): Promise<string> {
  const script = path.join(tmp, 'scripted-agy.cjs');
  await fs.writeFile(script, `
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
if (process.argv.includes('--version')) { console.log('agy 99.0.0'); process.exit(0); }
const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
let stuck = false;
let supportsForm = false;
const pending = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined && msg.id !== undefined) {
    const done = pending.get(msg.id);
    if (done) { pending.delete(msg.id); done(msg.result); }
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => send({ id, result });
  const chunk = (text) => send({ method: 'session/update', params: {
    sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  } });
  switch (method) {
    case 'initialize':
      supportsForm = !!params.clientCapabilities?.elicitation?.form;
      reply({ protocolVersion: params.protocolVersion, agentCapabilities: { sessionCapabilities: { list: {} } } });
      break;
    case 'session/list': reply({ sessions: [] }); break;
    case 'session/new': reply({ sessionId: 'scripted-' + process.pid, modes: {
      currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }]
    } }); break;
    case 'session/set_mode': reply({}); break;
    case 'session/prompt':
      if (stuck) break;
      if (params.prompt.some((block) => block.type === 'text' && block.text.includes(${JSON.stringify(questionPrompt)}))) {
        if (!supportsForm) {
          chunk('No form capability advertised.');
          reply({ stopReason: 'end_turn' });
          break;
        }
        send({ method: 'session/update', params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId: 'ask-1', name: 'ask_question', kind: 'other', title: 'Run ask_question', status: 'in_progress' }
        } });
        const reqId = 'elicit-1';
        pending.set(reqId, (result) => {
          send({ method: 'session/update', params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 'ask-1', status: 'completed' }
          } });
          chunk('ELICIT_RESULT:' + JSON.stringify(result));
          reply({ stopReason: 'end_turn' });
        });
        send({
          id: reqId,
          method: 'elicitation/create',
          params: {
            sessionId: params.sessionId,
            toolCallId: 'ask-1',
            mode: 'form',
            message: 'The agent has 2 questions.',
            requestedSchema: {
              type: 'object',
              properties: {
                q1: {
                  type: 'string',
                  title: 'Which 30-minute window?',
                  oneOf: [
                    { const: '1', title: '09:30–10:00 ET' },
                    { const: '2', title: '10:00–10:30 ET' }
                  ]
                },
                q1_other: { type: 'string', title: 'Other', description: 'Optional free-form answer' },
                q2: {
                  type: 'array',
                  title: 'Which models?',
                  items: {
                    anyOf: [
                      { const: '1', title: 'LightGBM' },
                      { const: '2', title: 'SideGuard' }
                    ]
                  }
                },
                q2_other: { type: 'string', title: 'Other', description: 'Optional free-form answer' }
              }
            }
          }
        });
      } else if (params.prompt.some((block) => block.type === 'text' && block.text.includes(${JSON.stringify(followUp)}))) {
        chunk(${JSON.stringify(followUpReply)});
        reply({ stopReason: 'end_turn' });
      } else {
        stuck = true;
        chunk(${JSON.stringify(firstReply)});
        // No prompt result, and keep stdin open until the app stops the CLI.
      }
      break;
    case 'session/cancel':
      appendFileSync(${JSON.stringify(cancelLog)}, 'cancel\\n');
      break; // A cancellation notification does not settle the original prompt.
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: 'Unexpected method: ' + method } });
  }
});
`);
  const isWin = process.platform === 'win32';
  const shim = path.join(tmp, isWin ? 'agy.cmd' : 'agy');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(shim, isWin
    // Only --version matters to the fixture; avoid re-parsing the JSON --settings argument in cmd.
    ? `@echo off\r\n"${process.execPath}" "${script}" %1\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  return shim;
}

describe.runIf(process.env.VOCS_CODE_E2E_UI === '1')('electron e2e: Antigravity stuck turn recovery', () => {
  it('keeps the reply, clears the streaming cursor on Interrupt, and delivers a new prompt', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-antigravity-turn-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const cancelLog = path.join(tmp, 'cancel.log');
    let app: ElectronApplication | undefined;
    try {
      await Promise.all([userData, project].map((dir) => fs.mkdir(dir)));
      const agy = await scriptedAgy(tmp, cancelLog);
      await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
        defaultHarness: 'antigravity', binaries: { agy }
      }));
      const packaged = process.env.HARNESS_E2E_EXE;
      const dataArg = `--user-data-dir=${userData}`;
      app = await electron.launch({
        executablePath: packaged || (require('electron') as string),
        args: packaged ? [dataArg] : [path.join(root, 'out', 'main', 'index.js'), dataArg],
        env: isolatedEnv(userData),
        timeout: 30_000
      });
      const win = await app.firstWindow();
      await win.waitForSelector('.brand', { timeout: 20_000 });
      await expectQuietWindow(app);
      win.setDefaultTimeout(12_000);

      await openNewSession(win);
      await win.getByRole('button', { name: /^Google Antigravity\b/ }).click();
      await win.getByRole('button', { name: /^Start session/ }).click();
      const composer = win.locator('.composer');
      const draft = composer.locator('textarea');
      const send = composer.getByRole('button', { name: 'Send', exact: true });
      const interrupt = composer.getByTitle('Interrupt (Esc)', { exact: true });
      const assistant = win.locator('.msg-assistant .md');
      const streaming = assistant.and(win.locator('.streaming'));
      const turns = win.locator('.turn-footer .turn-label');

      await draft.fill('Give me a reply and leave the turn open.');
      await send.click();
      await streaming.filter({ hasText: firstReply }).waitFor({ state: 'visible' });
      expect(await turns.count()).toBe(0);
      await interrupt.click();
      await expect.poll(() => fs.readFile(cancelLog, 'utf8').catch(() => ''), { timeout: 3_000 }).toBe('cancel\n');
      await turns.getByText('Interrupted', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await streaming.waitFor({ state: 'detached' });
      await interrupt.waitFor({ state: 'hidden' });
      expect(await assistant.allInnerTexts()).toEqual([firstReply]);
      expect(await turns.allInnerTexts()).toEqual(['Interrupted']);

      // Sending again (not just typing) proves the composer is out of queue mode and the
      // adapter can reconnect. The scripted process that got stuck never answers another prompt.
      await draft.fill(followUp);
      await send.click();
      await turns.getByText('Turn complete', { exact: true }).waitFor({ state: 'visible' });
      expect(await assistant.allInnerTexts()).toEqual([firstReply, followUpReply]);
      expect(await turns.allInnerTexts()).toEqual(['Interrupted', 'Turn complete']);
    } finally {
      await app?.close();
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 90_000);

  it('renders Antigravity ask_question options interactively, sends selected answers back over ACP, and persists the decision across restart', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-antigravity-question-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const cancelLog = path.join(tmp, 'cancel.log');
    let app: ElectronApplication | undefined;
    try {
      await Promise.all([userData, project].map((dir) => fs.mkdir(dir)));
      const agy = await scriptedAgy(tmp, cancelLog);
      await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project, {
        defaultHarness: 'antigravity', binaries: { agy }
      }));
      const packaged = process.env.HARNESS_E2E_EXE;
      const dataArg = `--user-data-dir=${userData}`;
      const launchOpts = {
        executablePath: packaged || (require('electron') as string),
        args: packaged ? [dataArg] : [path.join(root, 'out', 'main', 'index.js'), dataArg],
        env: isolatedEnv(userData),
        timeout: 30_000
      };
      app = await electron.launch(launchOpts);
      const win = await app.firstWindow();
      await win.waitForSelector('.brand', { timeout: 20_000 });
      await expectQuietWindow(app);
      win.setDefaultTimeout(12_000);

      await openNewSession(win);
      await win.getByRole('button', { name: /^Google Antigravity\b/ }).click();
      await win.getByRole('button', { name: /^Start session/ }).click();
      const composer = win.locator('.composer');
      await composer.locator('textarea').fill(questionPrompt);
      await composer.getByRole('button', { name: 'Send', exact: true }).click();

      const card = win.locator('.approval.pending');
      await card.waitFor({ state: 'visible', timeout: 20_000 });
      expect(await card.locator('.approval-title').innerText()).toBe('Antigravity has 2 questions');
      await card.getByRole('button', { name: '10:00–10:30 ET', exact: true }).click();
      await card.getByRole('button', { name: 'LightGBM', exact: true }).click();
      await card.getByRole('button', { name: 'SideGuard', exact: true }).click();
      await card.getByRole('textbox', { name: 'Additional context (optional)' }).fill('Use 2025 data.');
      await card.getByRole('button', { name: 'Answer', exact: true }).click();

      const assistant = win.locator('.msg-assistant .md');
      await assistant.filter({ hasText: 'ELICIT_RESULT:' }).waitFor({ state: 'visible', timeout: 20_000 });
      await win.locator('.turn-footer .turn-label').getByText('Turn complete', { exact: true }).waitFor({ state: 'visible' });
      const replyText = await assistant.last().innerText();
      const parsed = JSON.parse(replyText.slice(replyText.indexOf('ELICIT_RESULT:') + 'ELICIT_RESULT:'.length));
      expect(parsed).toEqual({
        action: 'accept',
        content: { q1: '2', q2: ['1', '2'], q2_other: 'Additional context: Use 2025 data.' }
      });

      // Restart Electron and verify the decided question card kept the user's selections and context.
      await app.close();
      app = undefined;
      app = await electron.launch(launchOpts);
      const reopened = await app.firstWindow();
      await reopened.waitForSelector('.brand', { timeout: 20_000 });
      await expectQuietWindow(app);
      await reopened.locator('.work-head').first().click();
      const saved = reopened.locator('.approval.decided');
      await saved.waitFor({ state: 'visible', timeout: 15_000 });
      expect(await saved.getByText('10:00–10:30 ET', { exact: true }).isVisible()).toBe(true);
      expect(await saved.getByText('LightGBM', { exact: true }).isVisible()).toBe(true);
      expect(await saved.getByText('SideGuard', { exact: true }).isVisible()).toBe(true);
      expect(await saved.getByText('Use 2025 data.', { exact: true }).isVisible()).toBe(true);
    } finally {
      await app?.close();
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});
