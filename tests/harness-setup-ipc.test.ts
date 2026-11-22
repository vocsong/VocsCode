/** Exercise the actual Electron registration boundary, before any privileged handler can run. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { listeners, invoke, mainFrame, contents, ownerChannels } = vi.hoisted(() => {
  const mainFrame = {};
  const ownerChannels = ['harness:login', 'harness:antigravityQuota', 'control:grant', 'vocsAccount:get', 'vocsAccount:signIn', 'vocsAccount:cancel', 'vocsAccount:refresh', 'vocsAccount:signOut', 'housekeep:preview', 'housekeep:assess', 'housekeep:apply'];
  return { listeners: new Map<string, (event: { sender: unknown; senderFrame: unknown }, req: unknown) => unknown>(), invoke: vi.fn(), mainFrame, contents: { mainFrame }, ownerChannels };
});
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {}, ipcMain: { handle: (channel: string, fn: never) => listeners.set(channel, fn) } }));
vi.mock('../src/main/handlers', () => ({ createHandlerRegistry: () => ({ channels: () => [...ownerChannels, 'harness:setup'], invoke }) }));
import { registerIpc, type IpcDeps } from '../src/main/ipc';
let windowPresent: boolean;
beforeEach(() => {
  windowPresent = true; listeners.clear(); invoke.mockReset().mockResolvedValue({ ok: true });
  registerIpc({ getWindow: () => windowPresent ? { webContents: contents } : null } as unknown as IpcDeps);
});

describe('local desktop setup authority', () => {
  it.each(ownerChannels)('refuses foreign senders, subframes and a missing owner on %s', (channel) => {
    const handler = listeners.get(channel)!;
    for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender: contents, senderFrame: {} }]) expect(() => handler(event, { harness: 'antigravity', actor: 'desktop' })).toThrow(/local desktop owner/);
    windowPresent = false;
    expect(() => handler({ sender: contents, senderFrame: mainFrame }, { harness: 'antigravity' })).toThrow(/local desktop owner/);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('dispatches the real owner main frame with desktop authority, without deriving authority from the payload', async () => {
    const payload = { harness: 'codex', device: true };
    await expect(listeners.get('harness:login')!({ sender: contents, senderFrame: mainFrame }, payload)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('harness:login', payload, 'desktop');
  });
  it.each([
    { channel: 'harness:login', payload: { harness: 'antigravity' }, reply: { ok: true } },
    { channel: 'harness:antigravityQuota', payload: undefined, reply: { groups: [{ name: 'Gemini', buckets: [{ name: 'Gemini Pro', remainingFraction: 0.73 }] }] } }
  ])('passes Antigravity $channel through the owner frame', async ({ channel, payload, reply }) => {
    invoke.mockResolvedValue(reply);
    await expect(listeners.get(channel)!({ sender: contents, senderFrame: mainFrame }, payload)).resolves.toEqual(reply);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, payload, 'desktop');
  });
});
