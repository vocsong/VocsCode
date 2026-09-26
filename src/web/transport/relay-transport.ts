/** The Transport a browser binds to window.harness (docs/REMOTE-ACCESS.md §4–5). Invokes and
 *  pushes ride the relay's e2e session; `can` refuses locally what the host would refuse, so the
 *  shared renderer hides a control instead of provoking an audited refusal. When the desktop is
 *  unreachable the transport answers the read surface from its sealed offline mirror. */
import { isRemoteChannel, isRemoteReadChannel } from '@shared/remote-channels';
import type { IpcChannel, IpcRequest, IpcResponse, PushChannel, PushPayloads } from '@shared/ipc';
import type { Transport } from '@shared/transport';
import type { DesktopFocus, SessionMeta } from '@shared/types';
import { PairingRevokedError, RelayClient } from '../../../relay/src/web-client';
import { MirrorBackend } from './mirror-backend';

export type ConnectionState = 'restoring' | 'unpaired' | 'connecting' | 'online' | 'mirror' | 'offline' | 'revoked';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 15_000;
/** Hiding this long means the socket was likely killed; probe on return instead of trusting it. */
const HIDDEN_PROBE_MS = 60_000;

export class RelayTransport implements Transport {
  readonly platform = 'browser';
  private connection: ConnectionState = 'restoring';
  private viewOnly = false;
  private backoff = BACKOFF_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private started = false;
  private hiddenSince = 0;
  private readonly stateListeners = new Set<() => void>();
  private readonly pushHandlers = new Map<PushChannel, Set<(payload: unknown) => void>>();
  private readonly mirror: MirrorBackend;

  constructor(private readonly client: RelayClient) {
    this.mirror = new MirrorBackend(client);
    client.onPush((channel, payload) => this.dispatchPush(channel, payload));
  }

  state(): ConnectionState {
    return this.connection;
  }

  onState(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** The desktop's policy is read from settings at boot and updated by push:remotePolicy. */
  setViewOnly(next: boolean): void {
    if (next === this.viewOnly) return;
    this.viewOnly = next;
    this.notify();
  }

  authenticated(): boolean {
    return this.client.hasCredentials();
  }

  /** The offline snapshot in store terms, when the transport is serving one: the shell seeds the
   *  shared store with these before rendering so Transcript and the session list work unchanged. */
  mirrorState(): { sessions: SessionMeta[]; focus: DesktopFocus } | null {
    return this.mirror.ready ? { sessions: this.mirror.sessions(), focus: this.mirror.focus() } : null;
  }

  can<K extends IpcChannel>(channel: K): boolean {
    if (!isRemoteChannel(channel)) return false;
    // A mirror and a view-only host serve the same read half; everything else is refused locally.
    if ((this.viewOnly || this.connection === 'mirror') && !isRemoteReadChannel(channel)) return false;
    return true;
  }

  invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
    if (!this.can(channel)) return Promise.reject(new Error('channel not available remotely'));
    return (async () => {
      const answer = await this.mirror.answer(channel, request);
      if (answer !== undefined) return answer as IpcResponse<K>;
      if (this.connection !== 'online') throw new Error(this.connection === 'mirror' ? 'the desktop is offline; showing its mirrored snapshot' : 'not connected to the desktop');
      return (await this.client.invoke(channel, request)) as IpcResponse<K>;
    })();
  }

  on<K extends PushChannel>(channel: K, listener: (payload: PushPayloads[K]) => void): () => void {
    let handlers = this.pushHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.pushHandlers.set(channel, handlers);
    }
    handlers.add(listener as (payload: unknown) => void);
    return () => handlers.delete(listener as (payload: unknown) => void);
  }

  /** Connects (idempotent) and installs the wake-up probes: a hidden tab's socket often dies. */
  start(): void {
    if (this.started) return;
    this.started = true;
    document.addEventListener('visibilitychange', this.onWake);
    window.addEventListener('online', this.onWake);
    window.addEventListener('pageshow', this.onWake);
    void this.connect();
  }

  async connect(force = false): Promise<void> {
    if (!this.client.hasCredentials()) {
      this.setConnection('unpaired');
      return;
    }
    if (this.connecting || (this.timer && !force)) return;
    this.clearTimer();
    this.connecting = true;
    this.setConnection('connecting');
    try {
      await this.client.connect(() => {
        this.setConnection('offline');
        this.scheduleReconnect();
      });
      this.backoff = BACKOFF_MIN_MS;
      this.mirror.reset();
      this.setConnection('online');
    } catch (e) {
      if (e instanceof PairingRevokedError) {
        this.setConnection('revoked');
        return;
      }
      // The desktop is unreachable: show what it left behind, and keep trying to reach it.
      try {
        this.setConnection((await this.mirror.load()) ? 'mirror' : 'offline');
      } catch {
        this.setConnection('offline');
      }
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private onWake = (): void => {
    if (!this.started) return;
    if (document.visibilityState === 'hidden') {
      this.hiddenSince = Date.now();
      return;
    }
    const hiddenFor = this.hiddenSince ? Date.now() - this.hiddenSince : 0;
    this.hiddenSince = 0;
    // While it is visibly online and was hidden only briefly, the socket is trusted; otherwise a
    // fresh connect is the probe: it drops stale state and re-handshakes.
    if (this.connection === 'online' && this.client.isConnected() && hiddenFor < HIDDEN_PROBE_MS) return;
    void this.connect(true);
  };

  private scheduleReconnect(): void {
    if (this.timer || !this.client.hasCredentials()) return;
    const delay = this.backoff;
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private dispatchPush(channel: string, payload: unknown): void {
    if (channel === 'push:remotePolicy') this.setViewOnly(!!(payload as { viewOnly?: boolean } | null)?.viewOnly);
    for (const handler of this.pushHandlers.get(channel as PushChannel) ?? []) handler(payload);
  }

  private setConnection(next: ConnectionState): void {
    if (next === this.connection) return;
    this.connection = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.stateListeners]) listener();
  }
}
