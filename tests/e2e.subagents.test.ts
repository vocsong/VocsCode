/**
 * Electron end-to-end for the Subagents panel, in two tiers.
 *
 * Part one seeds one session, its transcript and a run record, then drives the real UI: the panel's
 * two halves, the bottom tab strip, the run list, a run's transcript and per-call table, the
 * transcript card's link into the panel, and Stop. No harness is started, so no key is involved.
 *
 * Part two (`VOCS_CODE_PI_INTEGRATION=1`) runs the real installed pi with the offline scripted
 * provider and asserts the run the extension writes is the run the panel shows. Requires
 * `npm run build` first; `VOCS_CODE_E2E_UI=1` launches Electron.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { IpcChannel, IpcRequest, IpcResponse } from '../src/shared/ipc';
import type { SessionMeta } from '../src/shared/types';
import type { ScriptedCall } from './pi-offline-runner';
import { piIntegrationPaths } from './pi-offline-runner';
import { seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const piEnabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const shots = path.join(root, 'tests', 'artifacts');
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

function invoke<K extends IpcChannel>(win: Page, channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  return win.evaluate(({ channel, request }) => window.harness.invoke(channel, request), { channel, request }) as Promise<IpcResponse<K>>;
}

/** Environment shared by both tiers: a temp userData, no inherited provider keys. */
function cleanEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) continue;
    if (/^(ELECTRON_RUN_AS_NODE|ANTHROPIC_BASE_URL|CLAUDECODE|PI_CODING_AGENT_DIR)$/.test(key) || key.startsWith('CLAUDE_CODE_') || key.startsWith('VOCS_CODE_PI_')) continue;
    env[key] = value;
  }
  env.VOCS_CODE_USER_DATA = userData;
  return env;
}

async function launch(userData: string, extraEnv: Record<string, string> = {}): Promise<Page> {
  const packaged = process.env.HARNESS_E2E_EXE;
  const env = { ...cleanEnv(userData), ...extraEnv };
  app = await electron.launch({
    executablePath: packaged || (require('electron') as string),
    args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
    env,
    timeout: 60_000
  });
  const win = await app.firstWindow();
  await expect.poll(() => win.evaluate(() => typeof window.harness?.invoke), { timeout: 30_000 }).toBe('function');
  await win.waitForSelector('.brand', { timeout: 60_000 });
  return win;
}

const SEED_SESSION_ID = 'sub_e2e_panel';

/**
 * A session whose transcript already contains a finished subagent card, plus its run record. Each
 * harness keeps its runs in its own folder under the session, so the record is seeded where that
 * harness's reader looks for it.
 */
async function seedSession(userData: string, project: string, harness: 'pi' | 'claude' = 'pi'): Promise<void> {
  const session: SessionMeta = {
    id: SEED_SESSION_ID,
    title: 'Subagents panel',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: { harness, projectRoot: project, permissionMode: 'ask' },
    cwd: project,
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
  };
  await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify([session]));
  const dir = path.join(userData, 'sessions', SEED_SESSION_ID);
  await fs.mkdir(path.join(dir, harness, 'subagents'), { recursive: true });
  // A project definition, so the Agents view has something that belongs to the repo. Only pi reads
  // this folder, so a Claude session has none to show.
  if (harness === 'pi') {
    await fs.mkdir(path.join(project, '.pi', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(project, '.pi', 'agents', 'reviewer.md'),
      ['---', 'name: reviewer', 'description: Reviews a diff against the repo rules', 'tools: read, grep', 'prompt_mode: replace', '---', 'You review diffs.'].join('\n'),
      'utf8'
    );
  }
  const items = [
    { id: 'u1', kind: 'user', ts: Date.now(), text: 'Find where the harness registry lives.' },
    { id: 't1', kind: 'tool', ts: Date.now(), name: harness === 'pi' ? 'subagent' : 'Agent', hint: 'agent', summary: 'Find the registry', status: 'done', runId: 'agent_seed1', output: 'The registry is at src/main/harness/registry.ts' }
  ];
  await fs.writeFile(path.join(dir, 'transcript.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n');
  const run = [
    { t: 'run', runId: 'agent_seed1', agent: 'Explore', description: 'Find the registry', mode: 'foreground', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: project, startedAt: 1000 },
    { t: 'item', item: { id: 'i1', ts: 1100, kind: 'tool', name: 'grep', summary: 'createAgentSession', status: 'done', output: 'src/main/harness/registry.ts:1' } },
    { t: 'item', item: { id: 'i2', ts: 1200, kind: 'assistant', text: 'The registry is at src/main/harness/registry.ts' } },
    { t: 'call', call: { index: 0, provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 800, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.1, durationMs: 1500, stopReason: 'toolUse', toolsInvoked: ['grep'] } },
    { t: 'call', call: { index: 1, provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 200, outputTokens: 60, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.15, durationMs: 2500, stopReason: 'stop', toolsInvoked: [] } },
    { t: 'end', status: 'completed', totals: { turns: 2, toolUses: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.25, durationMs: 4000 }, endedAt: 2000 }
  ];
  await fs.writeFile(path.join(dir, harness, 'subagents', 'agent_seed1.jsonl'), run.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe.runIf(enabled)('electron e2e: subagents panel', () => {
  it('splits the panel, lists the recorded run, shows its transcript and per-call cost, and links from the card', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-ui-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await seedSession(userData, project);
    try {
      const win = await launch(userData);
      await win.waitForSelector('.panel', { timeout: 30_000 });

      // The panel has two halves with a draggable split between them.
      const top = await win.locator('.panel-section.panel-top').boundingBox();
      const bottom = await win.locator('.panel-section.panel-bottom').boundingBox();
      expect(top!.height).toBeGreaterThan(100);
      expect(bottom!.height).toBeGreaterThan(100);
      expect(top!.height).toBeGreaterThan(bottom!.height); // default split favours the workspace views
      expect(await win.locator('.resizer-split').count()).toBe(1);
      await win.getByTestId('panel-bottom-mcp').waitFor({ state: 'visible', timeout: 20_000 });

      // The card in the transcript links into the panel's lower half. The turn's work is collapsed
      // behind its header, so open that first.
      await win.locator('.work-head').click();
      const chip = win.locator('.tool-card .chip', { hasText: 'open run' });
      await chip.waitFor({ timeout: 20_000 });
      await chip.click();
      await win.locator('.panel-tab.active:has-text("Subagents")').waitFor({ timeout: 20_000 });

      // The run list shows the recorded run and its stats.
      const row = win.locator('.subagent-row').first();
      await row.waitFor({ timeout: 20_000 });
      const rowText = await row.innerText();
      for (const expected of ['Explore', 'Find the registry', 'claude-sonnet-4-5', '$0.25']) expect(rowText).toContain(expected);

      // The detail shows the child's transcript and one row per model call.
      const detailText = await win.locator('.subagent-detail').innerText();
      expect(detailText).toContain('The registry is at src/main/harness/registry.ts');
      expect(await win.locator('.subagent-detail .subagent-tool-output').innerText()).toContain('registry.ts:1');
      await win.locator('.subagent-calls tbody tr').first().waitFor({ timeout: 20_000 });
      expect(await win.locator('.subagent-calls tbody tr').count()).toBe(2);
      const firstCall = await win.locator('.subagent-calls tbody tr').nth(0).innerText();
      expect(firstCall).toContain('anthropic/claude-sonnet-4-5');
      expect(firstCall).toContain('800');
      expect(firstCall).toContain('grep');
      expect(await win.locator('.subagent-calls tbody tr').nth(1).innerText()).toContain('$0.15');
      // A finished run offers no Stop.
      expect(await win.locator('.subagent-detail button:has-text("Stop")').count()).toBe(0);

      await fs.mkdir(shots, { recursive: true });
      await win.screenshot({ path: path.join(shots, 'subagents-panel.png') });

      // The tab survives a reload of the window: the split and the list are state, not mount effects.
      await win.reload();
      await win.waitForSelector('.panel-section.panel-bottom', { timeout: 30_000 });
      await win.getByTestId('panel-bottom-subagents').click();
      await win.locator('.subagent-row:has-text("Explore")').first().waitFor({ timeout: 20_000 });
    } finally {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);

  it("shows a Claude session's runs, and refuses only what its SDK cannot do", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-claude-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await seedSession(userData, project, 'claude');
    try {
      const win = await launch(userData);
      await win.waitForSelector('.panel', { timeout: 30_000 });

      // The panel is reachable the same way: the card in the transcript links into it.
      await win.locator('.work-head').click();
      const chip = win.locator('.tool-card .chip', { hasText: 'open run' });
      await chip.waitFor({ timeout: 20_000 });
      await chip.click();
      await win.locator('.panel-tab.active:has-text("Subagents")').waitFor({ timeout: 20_000 });

      // The Claude session's run is listed with its stats, not an explanation of why it cannot be.
      const row = win.locator('.subagent-row').first();
      await row.waitFor({ timeout: 20_000 });
      const rowText = await row.innerText();
      for (const expected of ['Explore', 'Find the registry', 'claude-sonnet-4-5', '$0.25']) expect(rowText).toContain(expected);
      expect(await win.locator('.subagents').innerText()).not.toContain('does not record subagent runs');

      // Its transcript and per-call table come through the same reader.
      const detailText = await win.locator('.subagent-detail').innerText();
      expect(detailText).toContain('The registry is at src/main/harness/registry.ts');
      await win.locator('.subagent-calls tbody tr').first().waitFor({ timeout: 20_000 });
      expect(await win.locator('.subagent-calls tbody tr').count()).toBe(2);

      await fs.mkdir(shots, { recursive: true });
      await win.screenshot({ path: path.join(shots, 'subagents-panel-claude.png') });

      // The Agents view edits `.pi/agents`, which a Claude session does not run with, so it is
      // absent rather than empty; the Models view is the Claude equivalent. Stop/Steer have no
      // per-child equivalent in the SDK at all.
      expect(await win.locator('[data-testid="subagent-view-agents"]').count()).toBe(0);
      await win.getByTestId('subagent-view-models').click();

      // This project supplies no `.claude/agents`, and the panel does not invent rows for the
      // built-ins: writing a definition for one would replace its instructions, not adjust them.
      await expect.poll(() => win.locator('.subagents').first().innerText(), { timeout: 20_000 }).toContain('This project defines no Claude agents');
      expect(await win.locator('[data-testid="claude-agent-Explore"]').count()).toBe(0);
      // Nothing is pinned, so the adapter holds the built-ins to the session model and there is
      // nothing to warn about.
      expect(await win.locator('.subagents .callout.warn').count()).toBe(0);

      // That rule holds over IPC, not merely in the UI: saving a model for a built-in is refused and
      // leaves no file behind.
      const saved = await invoke(win, 'claude-agents:setModel', { id: SEED_SESSION_ID, name: 'Explore', model: 'deepseek-v4.1-flash' });
      expect(saved).toMatchObject({ ok: false });
      expect(saved.ok === false && saved.error).toContain('Explore');
      expect(await fs.readdir(path.join(project, '.claude', 'agents')).catch(() => null)).toBeNull();

      // And the refusal is real, over IPC — not merely a hidden button.
      const stopped = await invoke(win, 'subagents:stop', { id: SEED_SESSION_ID, runId: 'agent_seed1' });
      expect(stopped).toMatchObject({ ok: false });
      expect(stopped.ok === false && stopped.error).toMatch(/not available for the claude harness/);

      // The panel's own New flow writes a genuinely new definition, which is the one file this
      // screen creates — the name is checked so it can never replace a built-in.
      await win.getByTestId('claude-agent-new').click();
      await win.getByTestId('claude-agent-new-name').fill('reviewer');
      await win.getByTestId('claude-agent-new-description').fill('Reviews a diff against the repo rules');
      await win.getByTestId('claude-agent-new-prompt').fill('You review diffs and report findings.');
      await win.getByTestId('claude-agent-new-save').click();

      const wrote = path.join(project, '.claude', 'agents', 'reviewer.md');
      await expect.poll(() => fs.readFile(wrote, 'utf8').then(() => true).catch(() => false), { timeout: 20_000 }).toBe(true);
      const created = await fs.readFile(wrote, 'utf8');
      expect(created).toContain('name: reviewer');
      expect(created).toContain('Reviews a diff against the repo rules');
      // No `model:` line: a new definition inherits the session model until one is pinned here.
      expect(created).not.toContain('model:');
      // The definition is a row the panel lists, with the model control it can take a pin from.
      await win.locator('[data-testid="claude-agent-reviewer"]').waitFor({ timeout: 20_000 });
      expect(await win.locator('[data-testid="claude-agent-model-reviewer"]').count()).toBe(1);

      // The built-in rule holds over IPC too, not merely in the form's own check.
      const replaced = await invoke(win, 'claude-agents:create', { id: SEED_SESSION_ID, name: 'Plan', description: 'Replaces the built-in', prompt: 'x' });
      expect(replaced).toMatchObject({ ok: false });
      expect(replaced.ok === false && replaced.error).toContain('Plan');
      expect(await fs.readdir(path.join(project, '.claude', 'agents'))).toEqual(['reviewer.md']);

      // An explicit override is the one way a built-in gets a file. Over the real IPC boundary and
      // filesystem it writes the definition that replaces the built-in, pinning the model it was given.
      const overrode = await invoke(win, 'claude-agents:create', {
        id: SEED_SESSION_ID,
        name: 'Plan',
        description: 'Plans a change',
        prompt: 'You plan changes.',
        model: 'deepseek-v4.1-flash',
        override: true
      });
      expect(overrode).toMatchObject({ ok: true });
      const planFile = path.join(project, '.claude', 'agents', 'Plan.md');
      const planText = await fs.readFile(planFile, 'utf8');
      expect(planText).toContain('name: Plan');
      expect(planText).toContain('model: deepseek-v4.1-flash');
      // The panel's own source sees both definitions, and the pin is what releases Claude Code from
      // the session model — the consequence the view warns about.
      const listed = await invoke(win, 'claude-agents:list', { id: SEED_SESSION_ID });
      expect(listed.files.map((file) => file.name).sort()).toEqual(['Plan', 'reviewer']);
      expect(listed.forced).toBe(false);

      await fs.mkdir(shots, { recursive: true });
      await win.screenshot({ path: path.join(shots, 'subagents-panel-claude-new-agent.png') });
    } finally {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);

  it("edits the model of a project's own Claude definition, and nothing else in the file", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-claude-models-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    const file = path.join(project, '.claude', 'agents', 'Explore.md');
    // A definition the project wrote itself, pinning a model the catalog has never heard of.
    const original = ['---', '# written by hand', 'name: Explore', 'description: Searches the repo', 'model: retired-model-9', '---', '', 'You search the repo.', ''].join('\n');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original, 'utf8');
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await seedSession(userData, project, 'claude');
    try {
      const win = await launch(userData);
      await win.waitForSelector('.panel', { timeout: 30_000 });
      await win.getByTestId('panel-bottom-subagents').click();
      await win.getByTestId('subagent-view-models').click();

      // The project's definition is listed, marked as the project's, showing the model it pins.
      const tile = win.locator('[data-testid="claude-agent-Explore"]');
      await tile.waitFor({ timeout: 20_000 });
      expect(await tile.innerText()).toContain('project');
      const select = win.locator('[data-testid="claude-agent-model-Explore"]');
      expect(await select.inputValue()).toBe('retired-model-9');
      // Because that pin exists, the adapter has stopped holding the other types to the session
      // model — the one consequence of this screen a user has to be told about.
      await expect.poll(() => win.locator('.subagents').first().innerText(), { timeout: 20_000 }).toContain('no longer held to the session model');

      // Choosing the session model clears the pin, and only the pin: the author's comment, the
      // other fields and the prompt are the file's own business.
      await select.selectOption('');
      await expect.poll(() => fs.readFile(file, 'utf8').then((text) => text.includes('model:')), { timeout: 20_000 }).toBe(false);
      expect(await fs.readFile(file, 'utf8')).toBe(original.replace('model: retired-model-9\n', ''));
      // Nothing is pinned any more, so the warning goes with the pin.
      await expect.poll(() => win.locator('.subagents .callout.warn').count(), { timeout: 20_000 }).toBe(0);

      await fs.mkdir(shots, { recursive: true });
      await win.screenshot({ path: path.join(shots, 'subagents-panel-claude-models.png') });
    } finally {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);

  it('lists the project definition, copies a template into the project and ignores it', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-agents-'));
    const userData = path.join(tmp, 'userData');
    const project = path.join(tmp, 'project');
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(project));
    await seedSession(userData, project);
    // The tracking affordance only exists inside a repository, so make the project one.
    await new Promise<void>((resolve) => execFile('git', ['init', '-q'], { cwd: project }, () => resolve()));
    try {
      const win = await launch(userData);
      await win.waitForSelector('.panel', { timeout: 30_000 });
      await win.getByTestId('panel-bottom-subagents').click();
      await win.getByTestId('subagent-view-agents').click();

      // The repo's own definition is listed, marked local, with its description.
      const tile = win.locator('[data-testid="agent-reviewer"]');
      await tile.waitFor({ timeout: 20_000 });
      const tileText = await tile.innerText();
      expect(tileText).toContain('reviewer');
      expect(tileText).toContain('Reviews a diff against the repo rules');
      expect(tileText).toContain('local');

      // Copying a template opens the editor with the template's prompt and an empty name.
      await win.locator('[data-testid="agent-templates"] button').first().click();
      const editor = win.locator('.agent-editor');
      await editor.waitFor({ timeout: 10_000 });
      expect((await editor.locator('textarea').inputValue()).length).toBeGreaterThan(0);
      await editor.locator('input').first().fill('searcher');
      await editor.locator('input').nth(1).fill('Searches the repo for a symbol');
      await editor.getByRole('button', { name: 'Save' }).click();

      // The file lands in the project and the repo is told to ignore the folder.
      const wrote = async (file: string) => fs.readFile(file, 'utf8').then(() => true).catch(() => false);
      await expect.poll(() => wrote(path.join(project, '.pi', 'agents', 'searcher.md')), { timeout: 20_000 }).toBe(true);
      const written = await fs.readFile(path.join(project, '.pi', 'agents', 'searcher.md'), 'utf8');
      expect(written).toContain('name: searcher');
      expect(written).toContain('Searches the repo for a symbol');
      expect(await fs.readFile(path.join(project, '.gitignore'), 'utf8')).toContain('.pi/agents/*');
      // …and it shows up in the list as a local definition.
      await win.locator('[data-testid="agent-searcher"]').waitFor({ timeout: 20_000 });

      // Sharing is explicit: tracking one definition un-ignores just that file.
      await win.locator('[data-testid="agent-searcher"] .agent-tile-track').click();
      const tracked = async () => (await fs.readFile(path.join(project, '.gitignore'), 'utf8')).includes('!.pi/agents/searcher.md');
      await expect.poll(tracked, { timeout: 20_000 }).toBe(true);
    } finally {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 180_000);

  it.runIf(piEnabled)('shows the run a real pi session actually recorded', async () => {
    piIntegrationPaths();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-subagents-live-'));
    const userData = path.join(tmp, 'userData');
    const agentDir = path.join(tmp, 'agent');
    const project = path.join(tmp, 'project');
    const { cli } = piIntegrationPaths();
    try {
      await Promise.all([userData, agentDir, project].map((dir) => fs.mkdir(dir, { recursive: true })));
      // Windows cannot spawn the installed pi entry point directly; the shim runs it with Node, the
      // same way the pi-tools suite does.
      const shim = path.join(tmp, process.platform === 'win32' ? 'pi.cmd' : 'pi');
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await fs.writeFile(shim, process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`);
      if (process.platform !== 'win32') await fs.chmod(shim, 0o755);
      // The scripted provider and the offline flags are passed to pi exactly like the pi-tools suite.
      await fs.writeFile(
        path.join(userData, 'settings.json'),
        JSON.stringify({
          ...JSON.parse(seedSettings(project)),
          binaries: { pi: shim },
          pi: {
            extraArgs: [
              '--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve',
              '-e', path.join(root, 'tests', 'fixtures', 'pi-scripted-provider.mjs'),
              '--provider', 'vocs-offline', '--model', 'scripted', '--thinking', 'off'
            ]
          }
        })
      );
      const env = cleanEnv(userData);
      Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' });
      const win = await launch(userData, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' });

      const session = await invoke(win, 'sessions:create', { config: { harness: 'pi', projectRoot: project, useWorktree: false, permissionMode: 'full-auto' }, title: 'Subagents panel live' });
      const id = session.id;
      const calls: ScriptedCall[] = [{ id: 's1', name: 'subagent', arguments: { description: 'Find the registry', prompt: 'Where is the harness registry?', type: 'Explore' } }];
      await invoke(win, 'sessions:send', { id, input: { text: JSON.stringify({ calls }) } });

      // The extension writes the run file; the panel reads it back through IPC.
      let summary: Awaited<ReturnType<typeof invoke<'subagents:list'>>>[number] | undefined;
      await expect
        .poll(async () => {
          // Surface a harness failure instead of a bare timeout: the panel cannot show a run that
          // the session never produced.
          const meta = await invoke(win, 'sessions:get', { id });
          if (meta?.status === 'error') throw new Error(`pi session failed: ${meta.lastError ?? meta.statusDetail ?? 'unknown'}`);
          summary = (await invoke(win, 'subagents:list', { id }))[0];
          return summary?.status ?? 'none';
        }, { timeout: 90_000, interval: 500 })
        .toBe('completed');
      expect(summary).toMatchObject({ agent: 'Explore', status: 'completed' });
      expect(summary!.runId).toMatch(/^agent_/);
      const detail = await invoke(win, 'subagents:get', { id, runId: summary!.runId });
      expect(detail!.calls.length).toBeGreaterThan(0);
      expect(detail!.items.some((item) => item.kind === 'assistant' && item.text?.includes('COMPAT_OK'))).toBe(true);

      // And the UI shows that same run. The session was created over IPC, so select it first.
      await win.locator('[data-testid="session-row"]', { hasText: 'Subagents panel live' }).first().click();
      await win.waitForSelector('.panel', { timeout: 30_000 });
      await win.getByTestId('panel-bottom-subagents').click();
      await win.locator('.subagent-row:has-text("Explore")').first().waitFor({ timeout: 20_000 });
      await win.locator('.subagent-detail:has-text("COMPAT_OK")').waitFor({ timeout: 20_000 });
    } finally {
      await app?.close().catch(() => undefined);
      app = null;
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);
});
