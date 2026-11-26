/**
 * End-to-end test for Settings → MCP control: grant and revoke External MCP control from the native
 * owner, connect this computer with Vocs through a local relay and test landing (VOCS_CODE_RELAY_URL;
 * the relay is not a setting), and prove a restart reconnects as the same registered computer with no
 * stored relay URL or secret. On Windows the suite separately checks native owner grants for local
 * CLI and MCP discovery without a relay. Requires `npm run build` first; gated by VOCS_CODE_E2E_UI=1
 * (the e2e guard sets it).
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { isolatedEnv, seedSettings } from './e2e-ui';
import { ENROLL, FakeRelay } from './fake-relay';
import { startTestLanding, TEST_SESSION_COOKIE } from './support/test-landing';
import { prepareWindowsLocalPipeOnCi } from './support/windows-local-pipe-fixture';
import { memoryVault, RelayClient } from '../relay/src/web-client';
import { connectCheckCode } from '../src/shared/pairing';
import { decodeLocalControlTarget, encodeLocalControlTarget } from '../src/shared/local-control';
import type { SessionMeta, TranscriptItem } from '../src/shared/types';

const enabled = process.env.VOCS_CODE_E2E_UI === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
let app: ElectronApplication | null = null;

afterAll(async () => {
  await app?.close().catch(() => undefined);
});

async function seedProfile(name: string): Promise<{ userData: string; project: string; settingsPath: string }> {
  const tmp = path.join(os.tmpdir(), `vocs-code-${name}-${Date.now()}`);
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# mcp control e2e\n');
  const settingsPath = path.join(userData, 'settings.json');
  await fs.writeFile(settingsPath, seedSettings(project));
  return { userData, project, settingsPath };
}

async function openMcpControl(page: Page): Promise<void> {
  await page.waitForSelector('.brand', { timeout: 60_000 });
  await page.click('.sidebar-bottom .sidebar-link:has-text("Settings")');
  await page.locator('.settings-link:has-text("MCP control")').click({ timeout: 20_000 });
}

describe.runIf(enabled)('MCP control settings', () => {
  it('grants and revokes External MCP control from the native owner, with no browser access left', async () => {
    const { userData, project } = await seedProfile('mcp-control');
    app = await electron.launch({
      executablePath: require('electron') as string,
      args: [path.join(root, 'out', 'main', 'index.js')],
      env: isolatedEnv(userData),
      timeout: 60_000
    });
    const win = await app.firstWindow();
    await openMcpControl(win);
    await win.getByText('Vocs relay connection', { exact: true }).waitFor();
    // The retired paired-browser access offers nothing on this page.
    for (const testId of ['remote-enroll', 'remote-pair-code', 'remote-pair-link', 'remote-pair-qr', 'remote-audit']) {
      expect(await win.getByTestId(testId).count()).toBe(0);
    }
    expect(await win.getByText(/View-only mode|Offline mirror|Pair a browser/).count()).toBe(0);

    // External automation is independently disabled. Only the native owner can persist a scoped
    // grant; this fixture exercises the actual renderer → IPC → durable journal boundary.
    const control = win.getByTestId('control-settings');
    await control.getByTestId('control-enabled').waitFor();
    expect(await control.getByTestId('control-enabled').isChecked()).toBe(false);
    // This checkbox reflects committed state, so click then await the asynchronous save.
    await control.getByTestId('control-enabled').click();
    await expect.poll(() => control.getByTestId('control-enabled').isChecked()).toBe(true);
    const controlFile = path.join(userData, 'control.json');
    await expect.poll(async () => JSON.parse(await fs.readFile(controlFile, 'utf8')).enabled).toBe(true);
    await control.getByLabel('Controller label', { exact: true }).fill('E2E controller');
    await control.getByLabel('Account ID from OAuth consent', { exact: true }).fill('vocs-v1');
    await control.getByLabel('Controller ID from OAuth consent', { exact: true }).fill('30e4d8a1-cb8b-40bc-aa03-0c7ace255174');
    await control.getByLabel(project, { exact: true }).check();
    await control.getByLabel('I approve these actions and the harness’s existing access on this computer.').check();
    await control.getByRole('button', { name: 'Save controller grant' }).click();
    await expect.poll(async () => JSON.parse(await fs.readFile(controlFile, 'utf8')).grants.length).toBe(1);
    const grant = JSON.parse(await fs.readFile(controlFile, 'utf8')).grants[0];
    expect(grant.scopes).toEqual(['control:discover']);
    expect(grant.projectIds).toHaveLength(1);
    expect(grant.permissionModes).toEqual(['ask']);
    await control.getByRole('button', { name: 'Revoke E2E controller' }).click();
    await expect.poll(async () => JSON.parse(await fs.readFile(controlFile, 'utf8')).grants[0].revokedAt).toBeTypeOf('number');
    await expect.poll(() => control.getByTestId('control-enabled').isEnabled()).toBe(true);
    await control.getByTestId('control-enabled').click();
    await expect.poll(() => control.getByTestId('control-enabled').isChecked()).toBe(false);
    await expect.poll(async () => JSON.parse(await fs.readFile(controlFile, 'utf8')).enabled).toBe(false);
    await app.close();
    app = null;
  }, 120_000);

  it('connects with Vocs from Settings with no secret typed, and resumes as the same computer after a restart', async () => {
    const fake = new FakeRelay();
    const port = await fake.start();
    const gate = await startTestLanding(`http://127.0.0.1:${port}`, ENROLL);
    let desktop: ElectronApplication | null = null;
    try {
      const { userData, settingsPath } = await seedProfile('mcp-connect');
      const launch = async (): Promise<Page> => {
        const launched = await electron.launch({
          executablePath: require('electron') as string,
          args: [path.join(root, 'out', 'main', 'index.js')],
          // The desktop reaches the relay through the landing, as it does at code.vocs.io.
          env: isolatedEnv(userData, { VOCS_CODE_RELAY_URL: gate.origin }),
          timeout: 60_000
        });
        desktop = launched;
        // Record the page the app opens instead of launching a real browser.
        await launched.evaluate(({ shell }) => {
          const opened: string[] = [];
          (globalThis as unknown as { __opened: string[] }).__opened = opened;
          shell.openExternal = async (url: string) => void opened.push(url);
        });
        const page = await launched.firstWindow();
        await openMcpControl(page);
        return page;
      };
      const win = await launch();

      // The landing's gate answers this signed-out desktop with 401: Connect with Vocs is the way in.
      const signIn = win.getByTestId('remote-sign-in');
      await signIn.waitFor({ timeout: 30_000 });
      await expect.poll(() => signIn.innerText(), { timeout: 20_000 }).toBe('Connect with Vocs');
      await expect.poll(() => signIn.isEnabled(), { timeout: 20_000 }).toBe(true);
      await signIn.click();
      const opened = () => desktop!.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
      await expect.poll(async () => (await opened()).length, { timeout: 20_000 }).toBe(1);
      const link = (await opened())[0];
      const nonceHash = new URL(link).searchParams.get('connect')!;
      expect(link).toBe(`${gate.origin}/dashboard?connect=${nonceHash}`);
      await expect.poll(() => win.getByTestId('remote-sign-in-code').textContent(), { timeout: 20_000 }).toBe(connectCheckCode(nonceHash));

      // The signed-in owner adds this computer: it comes online, registered, with nothing typed.
      const signedIn: typeof fetch = (input, init = {}) => fetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie: TEST_SESSION_COOKIE, origin: gate.origin } });
      const owner = new RelayClient({ vault: memoryVault(), fetchImpl: signedIn, wsFactory: () => { throw new Error('no browser socket'); } });
      await owner.addComputer(gate.origin, nonceHash);
      await expect.poll(async () => win.getByTestId('remote-status').innerText(), { timeout: 30_000 }).toMatch(/online/);
      expect(await win.getByTestId('remote-sign-in').count()).toBe(0);
      const added = await owner.addedComputer(gate.origin, nonceHash);
      expect(added.status).toBe('redeemed');
      await win.getByText('Your computers', { exact: true }).waitFor({ timeout: 20_000 });

      // No relay URL or secret is stored in settings, yet a restart comes back to the same relay as
      // the same registered computer: the connection resumes from the enabled flag and the keychain.
      const hostId = () => fake.connected().find((c) => c.kind === 'host')?.id;
      await expect.poll(hostId, { timeout: 20_000 }).toBe(added.hostDeviceId);
      expect(JSON.parse(await fs.readFile(settingsPath, 'utf8')).remote).toEqual({ enabled: true });
      await desktop!.close();
      await expect.poll(hostId, { timeout: 20_000 }).toBeUndefined();
      const again = await launch();
      await expect.poll(hostId, { timeout: 30_000 }).toBe(added.hostDeviceId);
      await expect.poll(async () => again.getByTestId('remote-status').innerText(), { timeout: 20_000 }).toMatch(/online/);

      // Disconnect is persisted and drops the socket.
      await again.getByTestId('remote-disconnect').click();
      await expect.poll(hostId, { timeout: 20_000 }).toBeUndefined();
      await expect.poll(async () => JSON.parse(await fs.readFile(settingsPath, 'utf8')).remote.enabled).toBe(false);
      await expect.poll(() => again.getByTestId('remote-sign-in').innerText(), { timeout: 20_000 }).toBe('Connect');
    } finally {
      await (desktop as ElectronApplication | null)?.close().catch(() => undefined);
      await gate.stop();
      await fake.stop();
    }
  }, 180_000);

  if (process.platform === 'win32') it('scopes and revokes native local CLI and stdio discovery for two projects', async () => {
    await prepareWindowsLocalPipeOnCi();
    // Windows CI can expose TEMP through an 8.3 alias. Local discovery intentionally
    // refuses aliased project and profile paths; seed the fixture under the canonical path.
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-local-control-e2e-')));
    const userData = path.join(tmp, 'userData');
    const alpha = 'local-alpha';
    const beta = 'local-beta';
    const folders = [path.join(tmp, alpha), path.join(tmp, beta)];
    const home = path.join(tmp, 'home');
    const env = isolatedEnv(userData, {
      HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: path.join(home, 'codex'), PI_CODING_AGENT_DIR: path.join(home, 'pi')
    });
    for (const key of ['ELECTRON_RENDERER_URL', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
    const cliEnv = { ...env };
    delete cliEnv.VOCS_CODE_USER_DATA; // The copied descriptor, not this fixture's launch override, selects the target.
    const script = path.join(root, 'scripts', 'vocs-code.mjs');
    const commands = promisify(execFile);
    let desktop: ElectronApplication | undefined;

    async function runCli(target: string, ...args: string[]) {
      return commands(process.execPath, [script, '--target', target, ...args, '--json'], {
        cwd: root, env: cliEnv, encoding: 'utf8', windowsHide: true, timeout: 35_000, maxBuffer: 512 * 1024
      }).then(
        ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
        (error: { code?: number | string; stdout: string; stderr: string }) => {
          // A spawn error, signal or timeout is not an authorization refusal.
          if (typeof error.code !== 'number') throw error;
          return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
        }
      );
    }
    async function readCli(target: string, ...args: string[]): Promise<unknown> {
      const result = await runCli(target, ...args);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    }
    async function refuseCli(target: string, reason: 'denied' | 'unavailable', ...args: string[]) {
      const result = await runCli(target, ...args);
      expect(result.exitCode, result.stderr).toBe(reason === 'denied' ? 3 : 4);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({ error: reason });
    }
    async function launchPanel() {
      desktop = await electron.launch({
        executablePath: require('electron') as string,
        args: [path.join(root, 'out', 'main', 'index.js')], env, timeout: 45_000
      });
      const win = await desktop.firstWindow({ timeout: 20_000 });
      win.setDefaultTimeout(15_000);
      await win.setViewportSize({ width: 1280, height: 860 });
      await win.locator('.sidebar-bottom').getByRole('button', { name: 'Settings', exact: true }).click();
      await win.getByRole('button', { name: 'MCP control', exact: true }).click();
      return win.getByTestId('local-control-settings');
    }
    async function copyTarget(panel: Locator, projectCount: number) {
      const status = `Local discovery is on for ${projectCount} ${projectCount === 1 ? 'project' : 'projects'}.`;
      const error = panel.getByRole('alert');
      await panel.getByText(status, { exact: true }).or(error).first().waitFor({ timeout: 35_000 });
      if (await error.isVisible()) throw new Error(await error.innerText());
      const field = panel.getByTestId('local-control-target');
      expect(await field.getAttribute('readonly')).not.toBeNull();
      const shown = await field.inputValue();
      expect(shown).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
      await panel.getByRole('button', { name: 'Copy target descriptor', exact: true }).click();
      let copied = '';
      await expect.poll(async () => (copied = await desktop!.evaluate(({ clipboard }) => clipboard.readText())), { timeout: 10_000 }).toBe(shown);
      return copied;
    }
    async function expectOff(panel: Locator) {
      await expect.poll(() => panel.innerText(), { timeout: 10_000 }).toContain('Local discovery is off.');
      const projects = panel.getByRole('group', { name: 'Projects to grant' });
      expect(await projects.getByRole('checkbox').count()).toBe(2);
      expect(await projects.getByRole('checkbox', { checked: true }).count()).toBe(0);
      expect(await panel.getByRole('checkbox', { name: /apps running as this Windows user/ }).isChecked()).toBe(false);
      expect(await panel.getByRole('button', { name: 'Enable grant', exact: true }).isEnabled()).toBe(false);
      expect(await panel.getByRole('button', { name: 'Revoke grant', exact: true }).isEnabled()).toBe(false);
      expect(await panel.getByTestId('local-control-target').count()).toBe(0);
    }
    async function closeDesktop() {
      const current = desktop;
      if (!current) return;
      const child = current.process();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([current.close(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Local discovery desktop did not quit')), 12_000);
        })]);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        desktop = undefined;
      }
    }

    try {
      await Promise.all([...folders, userData, env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.PI_CODING_AGENT_DIR]
        .map((dir) => fs.mkdir(dir, { recursive: true })));
      await fs.writeFile(path.join(userData, 'settings.json'), seedSettings(folders[0], {
        folders, recentProjects: folders, remote: { enabled: false }
      }));
      const now = Date.now();
      const ordinary = [
        { id: 's_local_alpha', title: 'Alpha ordinary session', status: 'idle', harness: 'native' },
        { id: 's_local_beta', title: 'Beta ordinary session', status: 'idle', harness: 'native' }
      ] as const;
      const sessions: SessionMeta[] = ordinary.map(({ id, title, status, harness }, index) => ({
        id, title, status, config: { projectRoot: folders[index], harness, permissionMode: 'ask' },
        cwd: folders[index], createdAt: now, updatedAt: now, harnessRef: {},
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
      }));
      await fs.writeFile(path.join(userData, 'sessions.json'), JSON.stringify(sessions));
      for (const { id } of sessions) {
        const dir = path.join(userData, 'sessions', id);
        await fs.mkdir(dir, { recursive: true });
        const item: TranscriptItem = { id: 'u_fixture', kind: 'user', ts: now, text: 'Fixture transcript must not leave Electron' };
        await fs.writeFile(path.join(dir, 'transcript.jsonl'), `${JSON.stringify(item)}\n`);
      }

      const panel = await launchPanel();
      await expectOff(panel);
      const alphaBox = panel.getByRole('checkbox', { name: alpha });
      const betaBox = panel.getByRole('checkbox', { name: beta });
      const ack = panel.getByRole('checkbox', { name: /apps running as this Windows user/ });
      const enable = panel.getByRole('button', { name: 'Enable grant', exact: true });
      await alphaBox.check();
      expect(await enable.isEnabled()).toBe(false);
      await ack.check();
      expect(await enable.isEnabled()).toBe(true);
      await betaBox.check(); // Expanding the selection invalidates the prior acknowledgement.
      expect(await ack.isChecked()).toBe(false);
      expect(await enable.isEnabled()).toBe(false);
      await ack.check();
      await enable.click();
      const both = await copyTarget(panel, 2);
      const descriptor = decodeLocalControlTarget(both);
      expect(await readCli(both, 'status')).toEqual({
        version: 1, instanceId: descriptor.instanceId, methods: ['capabilities', 'projects.list', 'sessions.list']
      });
      const projects = await readCli(both, 'projects', 'list') as { items: { id: string; name: string }[]; nextOffset: number | null };
      expect(projects).toEqual({ items: expect.arrayContaining([
        { name: alpha, id: expect.any(String) }, { name: beta, id: expect.any(String) }
      ]), nextOffset: null });
      expect(projects.items).toHaveLength(2);
      const alphaProject = projects.items.find(({ name }) => name === alpha)!;
      const betaProject = projects.items.find(({ name }) => name === beta)!;
      expect(alphaProject.id).not.toBe(betaProject.id);
      expect(await readCli(both, 'sessions', 'list', '--project', alphaProject.id)).toEqual({ items: [ordinary[0]], nextOffset: null });
      expect(await readCli(both, 'sessions', 'list', '--project', betaProject.id)).toEqual({ items: [ordinary[1]], nextOffset: null });

      // Change only the embedded profileId, keeping the exact live pipe/launch. It must not fall
      // through to the otherwise matching, active desktop.
      const profileId = (descriptor.profileId[0] === '0' ? '1' : '0') + descriptor.profileId.slice(1);
      await refuseCli(encodeLocalControlTarget({ ...descriptor, profileId }), 'denied', 'projects', 'list');
      const started = (BigInt(descriptor.started) - 1n).toString();
      await refuseCli(encodeLocalControlTarget({ ...descriptor, started }), 'denied', 'status');

      const replace = panel.getByRole('button', { name: 'Replace grant', exact: true });
      expect(await replace.isEnabled()).toBe(false);
      await betaBox.uncheck();
      expect(await ack.isChecked()).toBe(false);
      expect(await replace.isEnabled()).toBe(false);
      await ack.check();
      await replace.click();
      const scoped = await copyTarget(panel, 1);
      expect(await readCli(scoped, 'projects', 'list')).toEqual({ items: [alphaProject], nextOffset: null });
      await refuseCli(scoped, 'denied', 'sessions', 'list', '--project', betaProject.id);

      const client = new Client({ name: 'local-control-e2e', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [script, '--target', scoped, 'mcp', 'serve', '--stdio'], cwd: root, env: cliEnv });
      const rpc = { timeout: 35_000 };
      const call = (name: string, args?: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, rpc);
      try {
        await client.connect(transport, rpc);
        expect((await client.listTools(undefined, rpc)).tools.map(({ name }) => name).sort()).toEqual(['capabilities', 'projects_list', 'sessions_list']);
        const capabilities = await call('capabilities');
        expect(capabilities.isError).not.toBe(true);
        expect(capabilities.structuredContent).toEqual({ version: 1, instanceId: decodeLocalControlTarget(scoped).instanceId, methods: ['capabilities', 'projects.list', 'sessions.list'] });
        const listed = await call('projects_list');
        expect(listed.isError).not.toBe(true);
        expect(listed.structuredContent).toEqual({ items: [alphaProject], nextOffset: null });
        const sessionList = await call('sessions_list', { projectId: alphaProject.id });
        expect(sessionList.isError).not.toBe(true);
        expect(sessionList.structuredContent).toEqual({ items: [ordinary[0]], nextOffset: null });
        const denied = await call('sessions_list', { projectId: betaProject.id });
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent).toEqual({ error: 'denied' });
        for (const name of ['sessions_transcript', 'sessions_send', 'invoke', 'control:local:enable']) {
          const unknown = await call(name);
          expect(unknown.isError).toBe(true);
          expect(unknown.content).toEqual([{ type: 'text', text: expect.stringContaining(`Tool ${name} not found`) }]);
        }

        await panel.getByRole('button', { name: 'Revoke grant', exact: true }).click();
        await expectOff(panel);
        const revoked = await call('sessions_list', { projectId: alphaProject.id });
        expect(revoked.isError).toBe(true);
        expect(revoked.structuredContent).toEqual({ error: 'unavailable' });
        await refuseCli(scoped, 'unavailable', 'status');
      } finally {
        await client.close(); // The SDK closes stdin, then bounds termination of its Node child.
      }

      // Quit with a fresh grant still active, then reopen the same isolated profile.
      await alphaBox.check();
      expect(await enable.isEnabled()).toBe(false);
      await ack.check();
      await enable.click();
      const beforeExit = await copyTarget(panel, 1);
      const child = desktop!.process();
      await closeDesktop();
      expect(child.exitCode).toBe(0);
      await expectOff(await launchPanel());
      await refuseCli(beforeExit, 'unavailable', 'status');
    } finally {
      try { await closeDesktop(); } finally { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
    }
  }, 240_000);
});
