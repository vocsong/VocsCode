/** Ephemeral controller RPC over authenticated host sockets. No queue, retry, content storage or
 *  shared current-host selection: every request carries its own target and controller. */
import { z } from 'zod';
import { CONTROL_MAX_BYTES, CONTROL_REQUIRED_SCOPE, CONTROL_VERSION, ControlError, controlParams, type ControllerPrincipal, type ControlReply, type ControlRequest } from '../../src/shared/control';
import { MAX_HOST_DEVICES, type DeviceRecord, type RelayStore } from './core';
import type { HubSocket, SocketRegistry } from './hub';
import { BROADCAST_TAG } from './routes';

export const CONTROL_RPC_TIMEOUT_MS = 5000;
export const CONTROL_MAX_PENDING = 32;
export const CONTROL_MAX_CONTROLLER_PENDING = 8;
const encoder = new TextEncoder();
const responseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ t: z.literal('control.response'), id: z.string().uuid(), ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ t: z.literal('control.response'), id: z.string().uuid(), ok: z.literal(false), error: z.enum(['invalid_request', 'denied', 'unavailable', 'busy', 'conflict', 'expired', 'storage_unavailable', 'unknown']) })
]);
const capabilitySchema = z.object({ version: z.literal(CONTROL_VERSION), instanceId: z.string().uuid() });
interface Pending<S> {
  hostId: string;
  controllerId: string;
  socket: S;
  finish: (reply: ControlReply) => void;
  expiresAt: number;
}

export class ControlHostBridge<S extends HubSocket> {
  private readonly pending = new Map<string, Pending<S>>();

  constructor(private readonly deps: { store: RelayStore; sockets: SocketRegistry<S> }) {}

  /** Control generations are socket-attachment metadata, so hibernation cannot revive a stale
   *  host. Superseding affects this channel only: encrypted browser routing is unchanged. */
  opened(ws: S, hostId: string): void {
    if (hostId === 'enrolling') return;
    for (const previous of this.deps.sockets.byTag(`host:${hostId}`)) {
      if (previous === ws) continue;
      this.deps.sockets.attach(previous, { controlCurrent: false });
      this.closed(previous);
    }
    this.deps.sockets.attach(ws, { controlCurrent: true });
  }

  closed(ws: S): void {
    for (const pending of this.pending.values()) if (pending.socket === ws) pending.finish({ ok: false, error: 'unavailable' });
  }

  private current(hostId: string): S | undefined {
    const live = this.deps.sockets.byTag(`host:${hostId}`).filter((ws) =>
      this.deps.sockets.isOpen(ws) && (this.deps.sockets.attachment(ws) as { controlCurrent?: unknown } | null)?.controlCurrent === true);
    // Fail closed on ambiguous or pre-control sockets; reconnect establishes a generation.
    return live.length === 1 ? live[0] : undefined;
  }

  private async registered(principal: ControllerPrincipal, hostId: string): Promise<DeviceRecord | undefined> {
    const device = await this.deps.store.get<DeviceRecord>(`device:${principal.accountId}:${hostId}`);
    return device?.kind === 'host' && device.deviceId === hostId ? device : undefined;
  }

  async call(principal: ControllerPrincipal, hostId: string, request: ControlRequest, signal: AbortSignal): Promise<ControlReply> {
    if (!principal.scopes.includes(CONTROL_REQUIRED_SCOPE[request.method])) throw new ControlError('denied');
    const parsed = controlParams[request.method].safeParse(request.params);
    if (!parsed.success) throw new ControlError('invalid_request');
    if (!(await this.registered(principal, hostId))) throw new ControlError('unavailable');
    const socket = this.current(hostId);
    if (!socket || signal.aborted) throw new ControlError('unavailable');
    if (principal.validUntil <= Date.now()) throw new ControlError('expired');
    if (this.pending.size >= CONTROL_MAX_PENDING || [...this.pending.values()].filter((p) => p.controllerId === principal.controllerId).length >= CONTROL_MAX_CONTROLLER_PENDING) throw new ControlError('busy');
    const id = crypto.randomUUID();
    const expiresAt = Math.min(Date.now() + CONTROL_RPC_TIMEOUT_MS, principal.validUntil);
    const frame = JSON.stringify({ t: 'control.request', id, hostId, principal, request: { method: request.method, params: parsed.data }, expiresAt });
    if (encoder.encode(frame).byteLength > CONTROL_MAX_BYTES) throw new ControlError('invalid_request');
    return new Promise<ControlReply>((resolve) => {
      const abort = () => finish({ ok: false, error: 'unavailable' });
      const timer = setTimeout(abort, Math.max(0, expiresAt - Date.now()));
      const finish = (reply: ControlReply): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(reply);
      };
      this.pending.set(id, { hostId, controllerId: principal.controllerId, socket, expiresAt, finish });
      signal.addEventListener('abort', abort, { once: true });
      try { socket.send(frame); } catch { finish({ ok: false, error: 'unavailable' }); }
    });
  }

  /** Called only for a host-tagged socket; additionally bind to the exact current connection and
   *  recheck registration after every await so revoked/replaced hosts cannot answer pending work. */
  async response(ws: S, hostId: string, accountId: string, raw: string): Promise<void> {
    if (raw.length > CONTROL_MAX_BYTES || encoder.encode(raw).byteLength > CONTROL_MAX_BYTES) {
      this.closed(ws);
      return;
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) return;
    const pending = this.pending.get(parsed.data.id);
    if (!pending || pending.hostId !== hostId || pending.socket !== ws || this.current(hostId) !== ws) return;
    const device = await this.deps.store.get<DeviceRecord>(`device:${accountId}:${hostId}`);
    if (this.pending.get(parsed.data.id) !== pending) return;
    if (device?.kind !== 'host' || device.deviceId !== hostId || this.current(hostId) !== ws || Date.now() >= pending.expiresAt) {
      pending.finish({ ok: false, error: 'unavailable' });
      return;
    }
    pending.finish(parsed.data.ok ? { ok: true, result: parsed.data.result } : { ok: false, error: parsed.data.error });
  }

  async computers(principal: ControllerPrincipal, signal: AbortSignal): Promise<unknown> {
    if (!principal.scopes.includes('control:discover')) throw new ControlError('denied');
    // Socket count is bounded by the runtime. Inspect at most 64 entries and five distinct host
    // ids (the registry's account host cap); never enumerate offline registry/mirror contents.
    const ids = new Set<string>();
    for (const ws of this.deps.sockets.byTag(BROADCAST_TAG.host).slice(0, 64)) {
      const hostId = this.deps.sockets.tags(ws).find((tag) => tag.startsWith('host:'))?.slice(5);
      if (hostId && hostId !== 'enrolling' && this.current(hostId) === ws) ids.add(hostId);
      if (ids.size >= MAX_HOST_DEVICES) break;
    }
    const computers = await Promise.all([...ids].map(async (hostId) => {
      try {
        const socket = this.current(hostId);
        const reply = await this.call(principal, hostId, { method: 'capabilities', params: {} }, signal);
        if (!reply.ok || signal.aborted || !socket || this.current(hostId) !== socket) return null;
        const capability = capabilitySchema.safeParse(reply.result);
        if (!capability.success) return null;
        const device = await this.registered(principal, hostId);
        if (!device || this.current(hostId) !== socket) return null;
        return { hostId, name: device.name, platform: device.platform, online: true, ...capability.data };
      } catch { return null; }
    }));
    return { computers: computers.filter((computer) => computer !== null) };
  }
}
