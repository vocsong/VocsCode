/** Delegated control-channel request dispatcher for RemoteHost (separate from browser invoke). */
import { WebSocket } from 'ws';
import { CONTROL_MAX_BYTES, controlErrorCode, controlHostRequestSchema } from '../../shared/control';

export type ControlHandler = Pick<import('../control/service').ControlService, 'handle'>;

export class HostControlRunner {
  private controlInFlight = 0;
  private readonly controlRequests = new Map<string, number>();

  constructor(private readonly control: ControlHandler | undefined) {}

  clear(): void {
    this.controlRequests.clear();
  }

  async handleRequest(
    raw: string,
    socket: WebSocket,
    ctx: { isCurrentSocket: () => boolean; enrolledHostId: string | undefined }
  ): Promise<void> {
    if (Buffer.byteLength(raw) > CONTROL_MAX_BYTES || !ctx.isCurrentSocket() || !ctx.enrolledHostId) return;
    const parsed = controlHostRequestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const frame = parsed.data;
    const now = Date.now();
    if (frame.hostId !== ctx.enrolledHostId || frame.expiresAt <= now || frame.expiresAt > now + 30_000 ||
        frame.principal.validUntil <= now || frame.principal.validUntil > now + 30_000) return;
    const respond = (reply: unknown): void => {
      if (!ctx.isCurrentSocket() || socket.readyState !== WebSocket.OPEN) return;
      let body = JSON.stringify({ t: 'control.response', id: frame.id, ...reply as object });
      if (Buffer.byteLength(body) > CONTROL_MAX_BYTES) body = JSON.stringify({ t: 'control.response', id: frame.id, ok: false, error: 'unavailable' });
      try { socket.send(body); } catch { /* A lost reply is recovered through the durable receipt, never replayed here. */ }
    };
    for (const [id, expiry] of this.controlRequests) if (expiry <= now) this.controlRequests.delete(id);
    if (!this.control || this.controlInFlight >= 16 || this.controlRequests.size >= 1024) { respond({ ok: false, error: 'unavailable' }); return; }
    if (this.controlRequests.has(frame.id)) { respond({ ok: false, error: 'conflict' }); return; }
    this.controlRequests.set(frame.id, frame.expiresAt);
    this.controlInFlight++;
    try { respond({ ok: true, result: await this.control.handle(frame.principal, frame.request) }); }
    catch (error) { respond({ ok: false, error: controlErrorCode(error) }); }
    finally { this.controlInFlight--; }
  }
}
