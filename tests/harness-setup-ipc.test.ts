/** Exercise the actual Electron registration boundary, before any privileged handler can run. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { listeners, invoke, mainFrame, contents, ownerChannels, ownerDocument } = vi.hoisted(() => {
  const ownerDocument = 'file:///C:/vocs-fixture/renderer/index.html';
  const mainFrame = { url: ownerDocument, detached: false };
  const ownerChannels = [
    'harness:login', 'subscriptions:read', 'subscriptions:claudeObserved', 'subscriptions:openUsage', 'control:grant', 'control:local:get', 'control:local:enable', 'control:local:disable',
    'vocsAccount:get', 'vocsAccount:signIn', 'vocsAccount:cancel', 'vocsAccount:refresh', 'vocsAccount:signOut',
    'vocsAccount:hubConnect', 'vocsAccount:hubCancel', 'vocsAccount:hubDisconnect',
    'housekeep:preview', 'housekeep:assess', 'housekeep:apply', 'housekeep:inventory', 'fs:writeText', 'intelligence:view', 'intelligence:promote', 'desktop:setFocus'
  ];
  return { listeners: new Map<string, (event: { sender: unknown; senderFrame: unknown }, req: unknown) => unknown>(), invoke: vi.fn(), mainFrame, ownerChannels, ownerDocument,
    contents: { mainFrame, isLoadingMainFrame: vi.fn(() => false) } };
});
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {}, ipcMain: { handle: (channel: string, fn: never) => listeners.set(channel, fn) } }));
vi.mock('../src/main/handlers', () => ({ createHandlerRegistry: () => ({ channels: () => [...ownerChannels, 'harness:setup', 'settings:update'], invoke }) }));
import { registerIpc, type IpcDeps } from '../src/main/ipc';
let windowPresent: boolean;
beforeEach(() => {
  windowPresent = true; listeners.clear(); invoke.mockReset().mockResolvedValue({ ok: true });
  Object.assign(mainFrame, { url: ownerDocument, detached: false });
  contents.isLoadingMainFrame.mockReset().mockReturnValue(false);
  registerIpc({ localControlDocument: ownerDocument, getWindow: () => windowPresent ? { webContents: contents } : null } as unknown as IpcDeps);
});

describe('local desktop setup authority', () => {
  it.each(ownerChannels)('refuses foreign senders, subframes and a missing owner on %s', (channel) => {
    const handler = listeners.get(channel)!;
    for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender: contents, senderFrame: {} }]) expect(() => handler(event, { harness: 'antigravity', actor: 'desktop' })).toThrow(/local desktop owner/);
    windowPresent = false;
    expect(() => handler({ sender: contents, senderFrame: mainFrame }, { harness: 'antigravity' })).toThrow(/local desktop owner/);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('keeps intelligence settings owner-only without changing ordinary settings dispatch', async () => {
    const handler = listeners.get('settings:update')!;
    const intelligence = { intelligence: { personalMemory: true } };
    expect(() => handler({ sender: contents, senderFrame: {} }, intelligence)).toThrow(/local desktop owner/);
    expect(invoke).not.toHaveBeenCalled();
    await expect(handler({ sender: contents, senderFrame: mainFrame }, intelligence)).resolves.toEqual({ ok: true });
    const ordinary = { theme: 'dark' };
    await expect(handler({ sender: contents, senderFrame: mainFrame }, ordinary)).resolves.toEqual({ ok: true });
    expect(invoke.mock.calls).toEqual([['settings:update', intelligence, 'desktop'], ['settings:update', ordinary, 'desktop']]);
  });
  it('dispatches the real owner main frame with desktop authority, without deriving authority from the payload', async () => {
    const payload = { harness: 'codex', device: true };
    await expect(listeners.get('harness:login')!({ sender: contents, senderFrame: mainFrame }, payload)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('harness:login', payload, 'desktop');
  });
  it('requires the exact settled desktop document before enabling local control', async () => {
    const handler = listeners.get('control:local:enable')!;
    const event = { sender: contents, senderFrame: mainFrame };
    const input = { projectIds: ['fixture'] };
    mainFrame.url = 'file:///C:/vocs-fixture/renderer/other.html';
    expect(() => handler(event, input)).toThrow(/trusted desktop page/);
    mainFrame.url = ownerDocument + '?different';
    expect(() => handler(event, input)).toThrow(/trusted desktop page/);
    mainFrame.url = ownerDocument;
    mainFrame.detached = true;
    expect(() => handler(event, input)).toThrow(/trusted desktop page/);
    mainFrame.detached = false;
    contents.isLoadingMainFrame.mockReturnValue(true);
    expect(() => handler(event, input)).toThrow(/trusted desktop page/);
    expect(invoke).not.toHaveBeenCalled();
    contents.isLoadingMainFrame.mockReturnValue(false);
    mainFrame.url = ownerDocument + '#settings';
    await expect(handler(event, input)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('control:local:enable', input, 'desktop');
  });
  it.each(['subscriptions:read', 'subscriptions:claudeObserved', 'subscriptions:openUsage'])('refuses stale main frames for %s', (channel) => {
    mainFrame.detached = true;
    expect(() => listeners.get(channel)!({ sender: contents, senderFrame: mainFrame }, { provider: 'codex' })).toThrow(/local desktop owner/);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    { channel: 'harness:login', payload: { harness: 'antigravity' }, reply: { ok: true } },
    { channel: 'subscriptions:read', payload: { provider: 'codex' }, reply: { groups: [{ name: 'Codex', buckets: [{ name: '5-hour limit', remainingFraction: 0.73 }] }] } },
    { channel: 'subscriptions:claudeObserved', payload: { sessionId: 's1' }, reply: [{ name: 'Weekly limit', remainingFraction: 0.25, observedAt: 1000, expiresAt: 2000 }] },
    { channel: 'subscriptions:openUsage', payload: { provider: 'antigravity' }, reply: { kind: 'terminal' } },
    { channel: 'fs:writeText', payload: { sessionId: 's1', path: 'notes.txt', content: 'next', expectedContent: 'before' }, reply: undefined },
    { channel: 'desktop:setFocus', payload: { sessionId: 's1' }, reply: undefined }
  ])('passes $channel through the owner frame', async ({ channel, payload, reply }) => {
    invoke.mockResolvedValue(reply);
    await expect(listeners.get(channel)!({ sender: contents, senderFrame: mainFrame }, payload)).resolves.toEqual(reply);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(channel, payload, 'desktop');
  });
});
