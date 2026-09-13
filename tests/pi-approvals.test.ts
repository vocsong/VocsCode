/**
 * Offline tests for the pi approvals extension. When the host has no approval UI attached the
 * extension must fail closed and block the gated action (issue #126).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import vocsCodeApprovals from '../resources/pi/vocs-code-approvals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ToolCallHandler = (event: { toolName: string; toolCallId?: string; input: Record<string, unknown> }, ctx: object) => Promise<unknown>;

function register(mode: string): ToolCallHandler {
  process.env.VOCS_CODE_PERMISSION_MODE = mode;
  delete process.env.VOCS_CODE_MODE_FILE;
  let handler: ToolCallHandler | undefined;
  const pi: Parameters<typeof vocsCodeApprovals>[0] = {
    on: (event, h) => {
      if (event === 'tool_call') handler = h as unknown as ToolCallHandler;
    }
  };
  vocsCodeApprovals(pi);
  if (!handler) throw new Error('tool_call handler was not registered');
  return handler;
}

const tempDirs: string[] = [];
afterEach(async () => {
  delete process.env.VOCS_CODE_PERMISSION_MODE;
  delete process.env.VOCS_CODE_MODE_FILE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('pi approval path and command boundaries', () => {
  it('never executes denied writes through a junction, including missing descendants', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-gate-'));
    tempDirs.push(dir);
    const cwd = path.join(dir, 'workspace');
    const outside = path.join(dir, 'outside');
    await fs.mkdir(cwd);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const handler = register('accept-edits');
    const select = vi.fn(async () => 'Deny');
    for (const file of ['escape/existing.txt', 'escape/new/deep.txt', '../outside/direct.txt']) {
      const result = await handler({ toolName: 'write', toolCallId: file, input: { path: file, content: 'forbidden' } }, { cwd, ui: { select, notify: vi.fn() } }) as { block?: boolean } | undefined;
      if (!result?.block) {
        await fs.mkdir(path.dirname(path.resolve(cwd, file)), { recursive: true });
        await fs.writeFile(path.resolve(cwd, file), 'forbidden');
      }
      expect(result?.block).toBe(true);
    }
    expect(await fs.readdir(outside)).toEqual([]);
    expect(select).toHaveBeenCalledTimes(3);
    await expect(handler({ toolName: 'write', input: { path: 'safe/new.txt', content: 'allowed' } }, { cwd })).resolves.toBeUndefined();
  });

  it.each(['~/outside.txt', '@../outside.txt', 'file:///outside.txt'])('prompts for Pi-expanded path %s rather than checking an unrelated Node path', async (file) => {
    const handler = register('accept-edits');
    const select = vi.fn(async () => 'Deny');
    await expect(handler({ toolName: 'write', input: { path: file } }, { cwd: process.cwd(), ui: { select } })).resolves.toMatchObject({ block: true });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('dangerous commands still prompt after allowing a shell for the session, including powershell', async () => {
    const handler = register('ask');
    const select = vi.fn().mockResolvedValueOnce('Allow for session').mockResolvedValue('Deny');
    const execute = vi.fn();
    for (const [toolName, command] of [['bash', 'echo safe'], ['bash', 'git push --force'], ['powershell', 'Remove-Item -Recurse outside']]) {
      const result = await handler({ toolName, input: { command } }, { cwd: process.cwd(), ui: { select, notify: vi.fn() } }) as { block?: boolean } | undefined;
      if (!result?.block) execute(command);
    }
    expect(execute).toHaveBeenCalledExactlyOnceWith('echo safe');
    expect(select).toHaveBeenCalledTimes(3);
  });
});

describe('pi approval extension without a UI', () => {
  it('blocks a gated command instead of allowing it', async () => {
    const handler = register('ask');
    await expect(handler({ toolName: 'bash', input: { command: 'ls' } }, { cwd: process.cwd() })).resolves.toEqual({
      block: true,
      reason: expect.stringContaining('approval UI is unavailable')
    });
  });

  it('blocks when ctx.ui exists but has no select function', async () => {
    const handler = register('ask');
    await expect(handler({ toolName: 'bash', input: { command: 'ls' } }, { ui: { notify: vi.fn() }, cwd: process.cwd() })).resolves.toMatchObject({
      block: true
    });
  });

  it('fails closed for a dangerous command in auto mode', async () => {
    const handler = register('auto');
    await expect(handler({ toolName: 'bash', input: { command: 'rm -rf /' } }, { cwd: process.cwd() })).resolves.toMatchObject({
      block: true
    });
  });

  it('fails closed for an edit outside the project in accept-edits mode', async () => {
    const handler = register('accept-edits');
    await expect(handler({ toolName: 'edit', input: { path: '../outside.txt' } }, { cwd: process.cwd() })).resolves.toMatchObject({ block: true });
  });

  it('keeps full-auto and plan behavior unchanged without a UI', async () => {
    const auto = register('full-auto');
    await expect(auto({ toolName: 'bash', input: { command: 'ls' } }, { cwd: process.cwd() })).resolves.toBeUndefined();

    const plan = register('plan');
    await expect(plan({ toolName: 'bash', input: { command: 'ls' } }, { cwd: process.cwd() })).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('Plan mode')
    });
  });
});

describe('pi approval extension with a UI', () => {
  it.each(['ask', 'plan'])('correlates a %s denial without executing the operation', async (mode) => {
    const ui = { select: vi.fn(async (_title: string, _options: string[]) => 'Deny'), notify: vi.fn() };
    const execute = vi.fn();
    const handler = register(mode);
    const result = await handler({ toolName: 'write', toolCallId: 'blocked-write', input: { path: 'blocked.txt', content: 'never written' } }, { ui, cwd: process.cwd() }) as { block?: boolean } | undefined;
    if (!result?.block) execute();
    expect(execute).not.toHaveBeenCalled();
    expect(result?.block).toBe(true);
    expect(ui.notify).toHaveBeenCalledExactlyOnceWith('VCODE_TOOL_BLOCKED::' + JSON.stringify({ toolCallId: 'blocked-write', toolName: 'write' }), 'info');
    if (mode === 'ask') expect(JSON.parse(ui.select.mock.calls[0]![0]!.slice('VCODE_APPROVAL::'.length))).toMatchObject({ toolCallId: 'blocked-write' });
  });

  it('routes the request through the host select and allows on request', async () => {
    const ui = { select: vi.fn(async (_title: string, _options: string[]) => 'Allow once'), notify: vi.fn() };
    const handler = register('ask');
    await expect(handler({ toolName: 'bash', input: { command: 'ls' } }, { ui, cwd: process.cwd() })).resolves.toBeUndefined();
    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(ui.select.mock.calls[0]![0]).toContain('VCODE_APPROVAL::');
  });

  it('blocks when the user declines', async () => {
    const ui = { select: vi.fn(async (_title: string, _options: string[]) => 'Deny'), notify: vi.fn() };
    const handler = register('ask');
    await expect(handler({ toolName: 'bash', input: { command: 'ls' } }, { ui, cwd: process.cwd() })).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('declined')
    });
  });
});
