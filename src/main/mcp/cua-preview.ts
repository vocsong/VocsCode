/**
 * The Desktop preview: one live screenshot of the screen the driver is acting on, for the
 * right-panel tab. It talks to `cua-driver mcp` through the app's own MCP client — the same
 * connection path the native loop uses — and keeps that connection alive between polls so a 2s
 * preview does not spawn a process every frame. The connection is closed after a short idle.
 *
 * This is observation only: it calls `get_desktop_state`, which never moves the pointer or takes
 * focus. Acting on the desktop is the agent's job, through the injected server.
 *
 * No Electron imports.
 */
import type { AppSettings, CuaPreviewResult } from '../../shared/types';
import { errorMessage } from '../util/async';
import { connectServer, type ConnectedMcpServer } from './client';
import { cuaBaseDef, cuaDefState } from './cua';

/** A full-display PNG larger than this is not worth shipping over IPC every poll. */
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const IDLE_CLOSE_MS = 30_000;

export class CuaPreviewSession {
  private connection: ConnectedMcpServer | null = null;
  private connecting: Promise<ConnectedMcpServer | null> | null = null;
  private idle: NodeJS.Timeout | null = null;

  /** One capture. A disabled built-in, a dead connection and a refused tool all come back as `ok: false`. */
  async capture(settings: AppSettings): Promise<CuaPreviewResult> {
    const def = cuaBaseDef(settings);
    if (def.disabled) return { ok: false, error: cuaDefState(settings).note };
    const connection = await this.ensure(def);
    if (!connection) return { ok: false, error: 'Could not start Cua Driver.' };
    this.armIdle();
    try {
      const result = await connection.call('get_desktop_state', {}, { timeoutMs: CAPTURE_TIMEOUT_MS });
      if (result.isError) return { ok: false, error: result.output || 'Cua Driver refused the capture.' };
      const image = result.images[0];
      if (!image) return { ok: false, error: 'Cua Driver returned no screenshot.' };
      // Base64 is 4 chars per 3 bytes; a cheap bound before the data URL is built.
      if (Math.floor((image.data.length * 3) / 4) > MAX_PREVIEW_BYTES) return { ok: false, error: 'Screenshot is too large to preview.' };
      return { ok: true, imageDataUrl: `data:${image.mimeType};base64,${image.data}` };
    } catch (e) {
      // A dropped connection must not poison every later poll; the next one reconnects.
      await this.close();
      return { ok: false, error: errorMessage(e) };
    }
  }

  /** Shuts the kept-alive connection; the next capture reconnects. Also used on quit. */
  async close(): Promise<void> {
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
    const connection = this.connection;
    this.connection = null;
    this.connecting = null;
    if (connection) await connection.close().catch(() => undefined);
  }

  private async ensure(def: ReturnType<typeof cuaBaseDef>): Promise<ConnectedMcpServer | null> {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = connectServer(def, { timeoutMs: CONNECT_TIMEOUT_MS })
        .then((connection) => {
          this.connection = connection;
          return connection;
        })
        .catch(() => null)
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
  }
}