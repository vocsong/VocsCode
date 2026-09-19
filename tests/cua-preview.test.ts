// The Desktop preview's capture path: it talks to the driver through the app's MCP client, turns
// an image content block into a data URL, and fails closed when computer use is off or refuses.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CuaPreviewSession } from '../src/main/mcp/cua-preview';
import { defaultSettings } from '../src/main/settings';
import type { AppSettings } from '../src/shared/types';

const { connectServer } = vi.hoisted(() => ({ connectServer: vi.fn() }));
vi.mock('../src/main/mcp/client', () => ({ connectServer }));

const settings = (enabled: boolean): AppSettings => ({
  ...defaultSettings(),
  cua: { enabled, mode: 'standard' },
  binaries: { cua: '/opt/cua/cua-driver' }
});

type FakeConnection = { call: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

function connection(callResult: unknown): FakeConnection {
  return { call: vi.fn().mockResolvedValue(callResult), close: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  connectServer.mockReset();
});

describe('Cua PreviewSession', () => {
  it('refuses to connect at all when computer use is off', async () => {
    const session = new CuaPreviewSession();
    const result = await session.capture(settings(false));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Off\./);
    expect(connectServer).not.toHaveBeenCalled();
  });

  it('turns an image block into a data URL and keeps the connection for the next poll', async () => {
    const conn = connection({ output: 'captured', isError: false, images: [{ mimeType: 'image/png', data: 'QUJD' }] });
    connectServer.mockResolvedValue(conn);
    const session = new CuaPreviewSession();
    const first = await session.capture(settings(true));
    const second = await session.capture(settings(true));
    expect(first).toEqual({ ok: true, imageDataUrl: 'data:image/png;base64,QUJD' });
    expect(second.ok).toBe(true);
    // One connection, two captures: the preview does not spawn a process every frame.
    expect(connectServer).toHaveBeenCalledTimes(1);
    await session.close();
    expect(conn.close).toHaveBeenCalled();
  });

  it('reports a refused tool and a missing screenshot instead of a blank frame', async () => {
    const session = new CuaPreviewSession();
    connectServer.mockResolvedValueOnce(connection({ output: 'no permission', isError: true, images: [] }));
    expect(await session.capture(settings(true))).toEqual({ ok: false, error: 'no permission' });
    await session.close();
    connectServer.mockResolvedValueOnce(connection({ output: 'ok', isError: false, images: [] }));
    expect(await session.capture(settings(true))).toEqual({ ok: false, error: 'Cua Driver returned no screenshot.' });
  });

  it('drops a dead connection so the next poll can reconnect', async () => {
    const dead = { call: vi.fn().mockRejectedValue(new Error('pipe closed')), close: vi.fn().mockResolvedValue(undefined) };
    const live = connection({ output: 'ok', isError: false, images: [{ mimeType: 'image/png', data: 'QUJD' }] });
    connectServer.mockResolvedValueOnce(dead).mockResolvedValueOnce(live);
    const session = new CuaPreviewSession();
    expect((await session.capture(settings(true))).ok).toBe(false);
    expect((await session.capture(settings(true))).ok).toBe(true);
    expect(connectServer).toHaveBeenCalledTimes(2);
  });
});