/** Real Electron -> preload -> SessionManager -> installed Pi, with an offline scripted model.
 * HARNESS_E2E_EXE selects the packaged app and its copied extensions, never a CLI-only substitute.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import type { IpcChannel, IpcRequest, IpcResponse } from '../src/shared/ipc';
import type { TranscriptItem } from '../src/shared/types';
import { piIntegrationPaths, type ScriptedCall } from './pi-offline-runner';
import { seedSettings } from './e2e-ui';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function invoke<K extends IpcChannel>(win: Page, channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  return win.evaluate(({ channel, request }) => window.harness.invoke(channel, request), { channel, request }) as Promise<IpcResponse<K>>;
}

function assertCompleted(items: TranscriptItem[], count: number): void {
  expect(items.filter((item) => item.kind === 'turn').map((item) => item.status)).toEqual(Array(count).fill('completed'));
  expect(items.filter((item) => item.kind === 'user')).toHaveLength(count);
  expect(items.filter((item) => item.kind === 'assistant' && item.text === 'COMPAT_OK' && !item.streaming)).toHaveLength(count);
  expect(items.filter((item) => item.kind === 'info' && item.level === 'error')).toEqual([]);
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
}

async function completed(win: Page, id: string, count: number): Promise<TranscriptItem[]> {
  await expect.poll(async () => {
    const meta = await invoke(win, 'sessions:get', { id });
    if (meta?.lastError || meta?.status === 'error' || meta?.status === 'stopped') {
      throw new Error(`Pi session failed: ${meta.lastError ?? meta.statusDetail ?? meta.status}`);
    }
    const items = await invoke(win, 'sessions:transcript', { id });
    return { status: meta?.status, turns: items.filter((item) => item.kind === 'turn').length };
  }, { timeout: 60_000, interval: 200 }).toEqual({ status: 'idle', turns: count });
  const items = await invoke(win, 'sessions:transcript', { id });
  assertCompleted(items, count);
  return items;
}

async function approve(win: Page, id: string, toolId: string, optionId: 'deny' | 'allow'): Promise<void> {
  let pending: Extract<TranscriptItem, { kind: 'approval' }> | undefined;
  await expect.poll(async () => {
    const items = await invoke(win, 'sessions:transcript', { id });
    const approvals = items.filter((item) => item.kind === 'approval' && !item.decision);
    expect(approvals.length).toBeLessThanOrEqual(1);
    pending = approvals[0] as typeof pending;
    return pending?.request.toolItemId;
  }, { timeout: 60_000, interval: 200 }).toBe(toolId);
  expect(pending!.request.options.some((option) => option.id === optionId)).toBe(true);
  await invoke(win, 'approvals:respond', { sessionId: id, requestId: pending!.request.id, decision: { optionId } });
}

function tool(items: TranscriptItem[], id: string): Extract<TranscriptItem, { kind: 'tool' }> {
  const rows = items.filter((item) => item.kind === 'tool' && item.id === id);
  expect(rows).toHaveLength(1);
  return rows[0] as Extract<TranscriptItem, { kind: 'tool' }>;
}

// Selecting this suite without its Electron opt-in or installed runtime is a failure, not a skip.
describe.runIf(enabled)('electron e2e: Pi tool compatibility', () => {
  it('loads app resources, denies/executes aliases exactly once, and resumes after a real restart', async () => {
    expect(process.env.VOCS_CODE_E2E_UI, 'Set VOCS_CODE_E2E_UI=1 to launch Electron').toBe('1');
    const { cli } = piIntegrationPaths();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs-pi-app-'));
    const userData = path.join(tmp, 'userData');
    const agentDir = path.join(tmp, 'agent');
    const project = path.join(tmp, 'project');
    const audit = path.join(tmp, 'pi-args.jsonl');
    let app: ElectronApplication | undefined;
    try {
      await Promise.all([userData, agentDir, project].map((dir) => fs.mkdir(dir, { recursive: true })));
      // Record the adapter's real CLI arguments before executing the unmodified installed runtime.
      const capture = path.join(tmp, 'capture.mjs');
      await fs.writeFile(capture, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(audit)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
      const shim = path.join(tmp, process.platform === 'win32' ? 'pi.cmd' : 'pi');
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await fs.writeFile(shim, process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${capture}" %*\r\n"${process.execPath}" "${cli}" %*\r\n`
        : `#!/bin/sh\n${quote(process.execPath)} ${quote(capture)} "$@" || exit $?\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`);
      if (process.platform !== 'win32') await fs.chmod(shim, 0o755);
      await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({
        ...JSON.parse(seedSettings(project)),
        binaries: { pi: shim },
        pi: { extraArgs: ['--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve',
          '-e', path.join(root, 'tests', 'fixtures', 'pi-scripted-provider.mjs'), '--provider', 'vocs-offline', '--model', 'scripted', '--thinking', 'off'] },
      }));
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)
          && !/^(ELECTRON_RUN_AS_NODE|ANTHROPIC_BASE_URL|CLAUDECODE|PI_CODING_AGENT_DIR)$/.test(key)
          && !key.startsWith('CLAUDE_CODE_') && !key.startsWith('VOCS_CODE_PI_')) env[key] = value;
      }
      Object.assign(env, { VOCS_CODE_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' });
      const packaged = process.env.HARNESS_E2E_EXE;
      const launch = async () => {
        app = await electron.launch({
          executablePath: packaged || (require('electron') as string),
          args: packaged ? [`--user-data-dir=${userData}`] : [path.join(root, 'out', 'main', 'index.js'), `--user-data-dir=${userData}`],
          env, timeout: 60_000,
        });
        const win = await app.firstWindow();
        await expect.poll(() => win.evaluate(() => typeof window.harness?.invoke), { timeout: 30_000 }).toBe('function');
        expect(await invoke(win, 'app:info', undefined)).toMatchObject({ isPackaged: Boolean(packaged), userData });
        return win;
      };
      let win = await launch();
      const resourceDir = packaged ? await app!.evaluate(() => process.resourcesPath) : path.join(root, 'resources');
      for (const name of ['vocs-code-tools.ts', 'tool-arguments.ts', 'vocs-code-approvals.ts']) {
        expect(await fs.readFile(path.join(resourceDir, 'pi', name), 'utf8')).toBe(await fs.readFile(path.join(root, 'resources', 'pi', name), 'utf8'));
      }
      const session = await invoke(win, 'sessions:create', {
        config: { harness: 'pi', projectRoot: project, useWorktree: false, permissionMode: 'ask' }, title: 'Pi packaged compatibility',
      });
      const id = session.id;
      const send = (calls: ScriptedCall[]) => invoke(win, 'sessions:send', { id, input: { text: JSON.stringify({ calls }) } });
      const file = path.join(project, 'alias.txt');
      await send([{ id: 'denied-write', name: 'write', arguments: { file_path: file, content: 'must not exist' } }]);
      await approve(win, id, 'denied-write', 'deny');
      let items = await completed(win, id, 1);
      expect(tool(items, 'denied-write')).toMatchObject({ name: 'write', status: 'declined' });
      expect(tool(items, 'denied-write').changes ?? []).toEqual([]);
      await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(items.filter((item) => item.kind === 'tool')).toHaveLength(1);

      await send([{ id: 'allowed-write', name: 'write', arguments: { file_path: file, content: 'keep REMOVE\n' } }]);
      await approve(win, id, 'allowed-write', 'allow');
      items = await completed(win, id, 2);
      expect(tool(items, 'allowed-write')).toMatchObject({ name: 'write', status: 'done' });
      expect(await fs.readFile(file, 'utf8')).toBe('keep REMOVE\n');

      await send([{ id: 'empty-edit', name: 'edit', arguments: { file_path: file, old_string: ' REMOVE', new_string: '' } }]);
      await approve(win, id, 'empty-edit', 'allow');
      items = await completed(win, id, 3);
      expect(tool(items, 'empty-edit')).toMatchObject({ name: 'edit', status: 'done' });
      expect(tool(items, 'empty-edit').changes).toHaveLength(1);
      expect(await fs.readFile(file, 'utf8')).toBe('keep\n');

      await send([{ id: 'bash-alias', name: 'bash', arguments: { command: 'echo PI_SHELL_OK', timeout_ms: 10000 } }]);
      await approve(win, id, 'bash-alias', 'allow');
      items = await completed(win, id, 4);
      expect(tool(items, 'bash-alias')).toMatchObject({ name: 'bash', status: 'done' });
      expect(tool(items, 'bash-alias').output?.trim()).toBe('PI_SHELL_OK');
      expect(items.filter((item) => item.kind === 'tool')).toHaveLength(4);
      expect(items.filter((item) => item.kind === 'approval').map((item) => item.decision?.optionId)).toEqual(['deny', 'allow', 'allow', 'allow']);
      const ref = (await invoke(win, 'sessions:get', { id }))!.harnessRef.piSessionFile;
      expect(ref).toBeTruthy();
      await fs.access(ref!);
      const saved = items;
      await app!.close();
      app = undefined;
      win = await launch();
      expect((await invoke(win, 'sessions:get', { id }))!.harnessRef.piSessionFile).toBe(ref);
      expect(await invoke(win, 'sessions:transcript', { id })).toEqual(saved);
      await send([{ id: 'resumed-read', name: 'read', arguments: { file_path: file } }]);
      items = await completed(win, id, 5);
      expect(items.slice(0, saved.length)).toEqual(saved);
      expect(tool(items, 'resumed-read')).toMatchObject({ name: 'read', status: 'done', output: 'keep\n' });
      expect(items.filter((item) => item.kind === 'tool')).toHaveLength(5);
      expect(items.filter((item) => item.kind === 'approval')).toHaveLength(4);
      expect(await fs.readFile(file, 'utf8')).toBe('keep\n');
      expect((await invoke(win, 'sessions:get', { id }))!.harnessRef.piSessionFile).toBe(ref);
      const launches: string[][] = (await fs.readFile(audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      // Availability/model probes use --no-session; count only actual session adapters.
      const rpc = launches.filter((args) => args.includes('rpc') && args.includes('--session-dir'));
      expect(rpc).toHaveLength(2);
      for (const args of rpc) {
        const extensions = args.flatMap((arg, index) => arg === '-e' ? [args[index + 1]] : []);
        expect(extensions).toContain(path.join(resourceDir, 'pi', 'vocs-code-tools.ts'));
        expect(extensions).toContain(path.join(resourceDir, 'pi', 'vocs-code-approvals.ts'));
      }
      expect(rpc[1]![rpc[1]!.indexOf('--session') + 1]).toBe(ref);
    } finally {
      await app?.close();
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 240_000);
});
