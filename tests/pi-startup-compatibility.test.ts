import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../src/main/harness/pi';
import type { HarnessContext } from '../src/main/harness/types';
import type { SessionEvent } from '../src/shared/types';
// Include the shipped resource in normal strict typechecking without requiring Pi as a desktop dependency.
import type vocsCodeTools from '../resources/pi/vocs-code-tools';
type ShippedToolsFactory = typeof vocsCodeTools;

const spawn = vi.hoisted(() => ({ spawnTool: vi.fn(), shutdownChild: vi.fn() }));
vi.mock('../src/main/harness/spawn', () => spawn);
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup(capabilities: string[], extensionError = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'vocs-pi-startup-'));
  roots.push(root);
  const events: SessionEvent[] = [];
  const commands: Record<string, unknown>[] = [];
  const children: EventEmitter[] = [];
  let previousNonce: string | undefined;
  spawn.spawnTool.mockImplementation((_bin, _args, options) => {
    const child = new EventEmitter();
    children.push(child);
    const stdout = new PassThrough();
    const emit = (event: Record<string, unknown>) => stdout.write(JSON.stringify(event) + '\n');
    const nonce = options.env.VOCS_CODE_PI_NONCE;
    const stdin = new Writable({ write(chunk, _encoding, done) {
      const command = JSON.parse(chunk.toString());
      commands.push(command);
      queueMicrotask(() => {
        if (command.type === 'get_state') {
          for (const capability of capabilities) {
            emit({ type: 'extension_ui_request', method: 'notify', message: 'VCODE_PI_READY::' + JSON.stringify({ version: 1, nonce: capability === 'stale-tools' ? previousNonce : nonce, capability: capability === 'stale-tools' ? 'tools' : capability }) });
          }
          if (extensionError) emit({ type: 'extension_error', extensionPath: '/resources/pi/vocs-code-tools.ts', error: 'SDK import failed' });
          previousNonce = nonce;
        }
        emit({ type: 'response', id: command.id, command: command.type, success: true, data: command.type === 'get_available_models' ? { models: [] } : {} });
      });
      done();
    } });
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin });
    return child;
  });
  spawn.shutdownChild.mockImplementation(async (child) => { child.emit('close', 0); });
  const ctx = {
    session: () => ({ cwd: root, usage: {}, harnessRef: {}, config: { appendSystemPrompt: 'Keep my custom instructions.' } }),
    settings: () => ({ pi: { extraArgs: ['--no-skills'] } }),
    runtime: { resolve: () => ({ path: '/fake/pi' }), resource: (...segments: string[]) => path.join(root, 'resources', ...segments) },
    sessionDir: root, permissionMode: () => 'ask', effort: () => undefined, getApiKey: async () => undefined,
    emit: (event: SessionEvent) => events.push(event), log: () => {}, updateRef: () => {}, updateMeta: () => {},
  } as unknown as HarnessContext;
  return { adapter: new PiAdapter(ctx), events, commands, children };
}

describe('Pi adapter startup capability boundary', () => {
  it.each([[], ['tools'], ['approvals']])('sends no prompt and never reports idle without both capabilities: %j', async (...caps) => {
    const { adapter, events, commands } = await setup(caps);
    await expect(adapter.send({ text: 'must not reach Pi' })).rejects.toThrow('Incompatible Pi runtime');
    expect(commands.map((command) => command.type)).toEqual(['get_state']);
    expect(events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(0);
    expect(spawn.shutdownChild).toHaveBeenCalledTimes(1);
  });
  it('loads both resources and preserves user append instructions before sending one prompt', async () => {
    const { adapter, events, commands } = await setup(['approvals', 'tools']);
    await adapter.send({ text: 'accepted' });
    expect(commands.filter((command) => command.type === 'prompt')).toEqual([{ id: expect.any(String), type: 'prompt', message: 'accepted', images: [] }]);
    expect(events.filter((event) => event.type === 'status' && event.status === 'idle')).toHaveLength(1);
    const args = spawn.spawnTool.mock.calls[0][1] as string[];
    expect(args.some((arg) => arg.endsWith('vocs-code-approvals.ts'))).toBe(true);
    expect(args.some((arg) => arg.endsWith('vocs-code-tools.ts'))).toBe(true);
    const appends = args.flatMap((arg, index) => arg === '--append-system-prompt' ? [args[index + 1]] : []);
    expect(appends).toHaveLength(2);
    expect(appends[0]).toBe('Keep my custom instructions.');
    expect(appends[1]).toContain('timeout_ms explicitly means milliseconds');
    await adapter.dispose();
  });
  it('fails closed for required extension errors even after both readiness notifications', async () => {
    const { adapter, commands } = await setup(['approvals', 'tools'], true);
    await expect(adapter.send({ text: 'must not reach Pi' })).rejects.toThrow('SDK import failed');
    expect(commands.map((command) => command.type)).toEqual(['get_state']);
  });
  it('clears capabilities on relaunch and rejects a stale process nonce', async () => {
    const caps = ['approvals', 'tools'];
    const { adapter, commands } = await setup(caps);
    await adapter.start();
    await adapter.dispose();
    caps[1] = 'stale-tools';
    await expect(adapter.send({ text: 'must not reach new Pi' })).rejects.toThrow('Missing readiness: tools');
    expect(commands.filter((command) => command.type === 'prompt')).toHaveLength(0);
    expect(spawn.spawnTool.mock.calls[0][2].env.VOCS_CODE_PI_NONCE).not.toBe(spawn.spawnTool.mock.calls[1][2].env.VOCS_CODE_PI_NONCE);
  });
});
