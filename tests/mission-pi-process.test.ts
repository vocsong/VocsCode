/** The managed Pi adapter owns descendants, not just the RPC root's exit event. */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent, SessionMeta } from '../src/shared/types';
import { emptyUsage } from '../src/main/models/static-models';
import { inspectManagedPiOwnership } from '../src/main/harness/pi-ownership';

const roots: string[] = [];
const adapters: PiAdapter[] = [];
const unrelated: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  for (const child of unrelated.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill(); await closed;
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Managed Pi child did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function host() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mission-pi-owned space-')); roots.push(root);
  const armed = path.join(root, 'descendant-ready'); const late = path.join(root, 'late-write');
  const script = path.join(root, 'scripted-pi.cjs'); const bin = path.join(root, 'pi.cmd');
  await fs.writeFile(script, `
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
const model = { provider: 'fixture', id: 'scripted', name: 'Fixture' };
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    for (const capability of ['approvals', 'tools', 'mcp', 'mission']) emit({
      type: 'extension_ui_request', method: 'notify', message: 'VCODE_PI_READY::' + JSON.stringify({
        version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, capability, ready: true,
        ...(capability === 'mission' ? { tools: ['read', 'mission_read', 'mission_report'] } : {}),
      }),
    });
  }
  if (command.type === 'prompt') {
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(armed)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'UNSAFE'), 2500);`)}], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  emit({ type: 'response', id: command.id, command: command.type, success: true,
    data: command.type === 'get_state' ? { model, thinkingLevel: 'off' } : command.type === 'get_available_models' ? { models: [model] } : {} });
});
process.stdin.on('end', () => process.exit(0));
`);
  // The CLI arguments are deliberately ignored; only the production adapter's RPC/env boundary
  // drives this fixture. An npm-style shim also covers the nested cmd -> node launch.
  await fs.writeFile(bin, `@"${process.execPath}" "${script}" %*\r\n`);
  const events: SessionEvent[] = [];
  const meta: SessionMeta = {
    id: 's1', title: 'Mission', cwd: root, createdAt: 0, updatedAt: 0, status: 'idle', harnessRef: {}, usage: emptyUsage(),
    config: { harness: 'pi', projectRoot: root, permissionMode: 'full-auto', model: { provider: 'fixture', model: 'scripted' } },
    mission: { missionId: 'm1', role: 'worker', generation: 1, sourceAccess: 'assigned_workspace', requestedTools: [], reasoningDefault: true },
  };
  const ctx = {
    sessionId: meta.id, session: () => meta, sessionDir: path.join(root, 'session'),
    settings: () => ({ pi: { extraArgs: [] }, providers: [] }),
    runtime: { resolve: () => ({ path: bin, source: 'installed' }), resource: (...parts: string[]) => path.resolve('resources', ...parts) },
    permissionMode: () => meta.config.permissionMode, effort: () => undefined, getApiKey: async () => undefined,
    mcpServers: async () => [{ def: { id: 'vocs-mission', transport: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer test-only-ownership-secret' } }, missing: [], secretEnvKeys: [], secretHeaderKeys: [] }],
    ownedMcpIds: () => ['vocs-mission'], emit: (event: SessionEvent) => events.push(event), log: () => {},
    updateRef: (patch: object) => Object.assign(meta.harnessRef, patch), updateMeta: (patch: object) => Object.assign(meta, patch),
  } as unknown as HarnessContext;
  const adapter = new PiAdapter(ctx); adapters.push(adapter);
  return { adapter, root, armed, late, events };
}

describe.runIf(process.platform === 'win32')('managed Pi Windows process ownership', () => {
  it('cannot let a detached descendant write after safe disposal, even when the RPC root exits first', async () => {
    const h = await host();
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    unrelated.push(other);
    await h.adapter.send({ text: 'start a detached delayed writer' });
    await until(async () => !!await fs.stat(h.armed).catch(() => undefined));
    const receipt = await h.adapter.dispose();
    await new Promise((resolve) => setTimeout(resolve, 2800));
    expect(await fs.readdir(h.root)).not.toContain('late-write');
    expect(receipt).toBeUndefined(); // Success is allowed only after the owned Job receipt + close.
    expect(await inspectManagedPiOwnership(path.join(h.root, 'session'), { sessionId: 's1', missionId: 'm1', generation: 1 })).toEqual({ state: 'quiescent', quiescent: true, intents: 1 });
    expect(other.exitCode).toBeNull(); expect(other.signalCode).toBeNull();
    expect(await h.adapter.missionReadiness()).toMatchObject({ ready: false, tools: [] });
  }, 30000);
});
