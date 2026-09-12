/**
 * Offline tests for the pi approvals extension. When the host has no approval UI attached the
 * extension must fail closed and block the gated action (issue #126).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import vocsCodeApprovals from '../resources/pi/vocs-code-approvals';

type ToolCallHandler = (event: { toolName: string; input: Record<string, unknown> }, ctx: object) => Promise<unknown>;

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

afterEach(() => {
  delete process.env.VOCS_CODE_PERMISSION_MODE;
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
