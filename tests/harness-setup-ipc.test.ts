/** Exercise the actual Electron registration boundary, before any privileged handler can run. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { listeners, invoke, mainFrame, contents } = vi.hoisted(() => {
  const mainFrame = {};
  return { listeners: new Map<string, (event: { sender: unknown; senderFrame: unknown }, req: unknown) => unknown>(), invoke: vi.fn(), mainFrame, contents: { mainFrame } };
});
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {}, ipcMain: { handle: (channel: string, fn: never) => listeners.set(channel, fn) } }));
vi.mock('../src/main/handlers', () => ({ createHandlerRegistry: () => ({ channels: () => ['harness:login', 'harness:setup', 'control:grant'], invoke }) }));
import { registerIpc, type IpcDeps } from '../src/main/ipc';
let windowPresent: boolean;
beforeEach(() => {
  windowPresent = true; listeners.clear(); invoke.mockReset().mockResolvedValue({ ok: true });
  registerIpc({ getWindow: () => windowPresent ? { webContents: contents } : null } as unknown as IpcDeps);
});

describe('local desktop setup authority', () => {
  it.each(['harness:login', 'control:grant'])('refuses foreign senders, subframes and a missing owner on %s', (channel) => {
    const handler = listeners.get(channel)!;
    for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender: contents, senderFrame: {} }]) expect(() => handler(event, { harness: 'codex', actor: 'desktop' })).toThrow(/local desktop owner/);
    windowPresent = false;
    expect(() => handler({ sender: contents, senderFrame: mainFrame }, { harness: 'codex' })).toThrow(/local desktop owner/);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('dispatches the real owner main frame with desktop authority, without deriving authority from the payload', async () => {
    const payload = { harness: 'codex', device: true };
    await expect(listeners.get('harness:login')!({ sender: contents, senderFrame: mainFrame }, payload)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('harness:login', payload, 'desktop');
  });
});
