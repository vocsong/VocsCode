/** Encrypted client-session transport, handshake handling, and filtered remote invoke dispatch. */
import { WebSocket } from 'ws';
import { hostAccept, sealFrame, verify, type PublicIdentity } from '../../shared/crypto';
import { openCheckedFrame } from '../../shared/e2e-session';
import { isRemoteChannel, isRemoteHostChannel, isRemotePushChannel, isRemoteReadChannel, REMOTE_FRAME_MAX_BYTES } from '../../shared/remote-channels';
import { REMOTE_TERMINAL_INPUT_MAX, type RemoteTerminalFrame } from '../../shared/remote-terminal';
import type { HandlerRegistry } from '../handlers/context';
import type { RemoteAudit } from './audit';
import { projectRemoteValue } from './project';
import type { HostCredentials } from './relay-client';
import { RemoteTerminalStreams, type TerminalSource } from './terminal-streams';

interface Session {
  key: CryptoKey;
  salt: Uint8Array;
  out: number;
  inSeq: number;
  inSalt?: string;
  outgoing: Promise<void>;
  identity: PublicIdentity;
}

export interface HostSessionBridgeDeps {
  getCreds: () => HostCredentials | null;
  getSocket: () => WebSocket | null;
  registry: () => HandlerRegistry;
  terminals?: () => TerminalSource | null;
  viewOnly?: () => boolean;
  push: () => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  audit?: RemoteAudit;
}

export class HostSessionBridge {
  private readonly sessions = new Map<string, Session>();
  /** Serialize handshake and ciphertext delivery per peer, not across unrelated clients. */
  private readonly incoming = new Map<string, Promise<void>>();
  /** Terminals streamed to paired browsers (P3.5), each to the browser that watches it. */
  private readonly terminalStreams: RemoteTerminalStreams;
  /** Terminals each connected browser has typed into, so the audit trail records the first
   *  keystroke of a connection rather than every one. */
  private readonly typedInto = new Map<string, Set<string>>();

  constructor(private readonly deps: HostSessionBridgeDeps) {
    this.terminalStreams = new RemoteTerminalStreams({
      source: () => this.deps.terminals?.() ?? null,
      send: (clientId, frame: RemoteTerminalFrame) => this.sendTo(clientId, { type: 'push', channel: 'push:remoteTerminal', payload: frame }),
      log: (level, message) => this.deps.log(level, message)
    });
  }

  onlineClients(): string[] {
    return [...this.sessions.keys()];
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  clearIncoming(): void {
    this.incoming.clear();
  }

  /** A browser's e2e session ended: stop everything streamed to it. */
  forgetClient(clientId: string): void {
    this.terminalStreams.dropClient(clientId);
    this.typedInto.delete(clientId);
  }

  clearAll(): void {
    this.sessions.clear();
    this.terminalStreams.dropAll();
    this.typedInto.clear();
    this.incoming.clear();
  }

  dropClients(ids: string[]): void {
    for (const id of ids) {
      this.sessions.delete(id);
      this.forgetClient(id);
    }
  }

  /** Clears all live sessions on socket close and returns the ids that were disconnected. */
  onSocketClosed(): string[] {
    const dropped = [...this.sessions.keys()];
    this.clearAll();
    for (const client of dropped) this.deps.audit?.record('client-disconnect', { device: client });
    return dropped;
  }

  enqueue(from: string, socket: WebSocket, task: () => Promise<void>): void {
    const previous = this.incoming.get(from) ?? Promise.resolve();
    const next = previous.then(() => (this.deps.getSocket() === socket ? task() : undefined)).catch((e: unknown) => {
      this.deps.log('warn', `remote: message from ${from} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.incoming.set(from, next);
    void next.then(() => {
      if (this.incoming.get(from) === next) this.incoming.delete(from);
    });
  }

  handleClientGone(client: string, socket: WebSocket): void {
    this.enqueue(client, socket, async () => {
      this.forgetClient(client);
      if (this.sessions.delete(client)) {
        this.deps.log('info', `remote: client ${client} disconnected (${this.sessions.size} online)`);
        this.deps.audit?.record('client-disconnect', { device: client });
      }
      this.deps.push();
    });
  }

  async onHandshake(from: string, payload: unknown): Promise<void> {
    const creds = this.deps.getCreds();
    if (!creds) return;
    const expected = creds.clients[from];
    if (!expected) {
      // The relay routed a device this host never paired with (or one that was revoked).
      this.deps.log('warn', `remote: ignored a handshake from unpaired device ${from}`);
      this.deps.audit?.record('handshake-failed', { device: from, detail: 'unpaired device' });
      return;
    }
    const socket = this.deps.getSocket();
    try {
      const session = await hostAccept(creds.identity, payload as never, expected);
      if (!socket || this.deps.getSocket() !== socket || this.deps.getCreds()?.clients[from] !== expected) return;
      // A fresh handshake is a reconnect: the browser re-watches what it still shows.
      this.forgetClient(from);
      this.sessions.set(from, { key: session.key, salt: session.salt, out: 0, inSeq: -1, outgoing: Promise.resolve(), identity: expected });
      this.deps.getSocket()?.send(JSON.stringify({ t: 'hs', to: from, seq: 0, payload: session.reply }));
      this.deps.log('info', `remote: client ${from} connected (${this.sessions.size} online)`);
      this.deps.audit?.record('client-connect', { device: from });
      // Hand the browser the mirror key sealed inside the just-established session; it needs the
      // key before the desktop can ever be offline, and re-receives it on every reconnect.
      if (creds.mirrorKey) await this.sendTo(from, { type: 'mirror.key', key: creds.mirrorKey });
    } catch (e) {
      this.deps.log('warn', `remote handshake failed for ${from}: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.audit?.record('handshake-failed', { device: from });
    }
  }

  async onFrame(from: string, seq: number, payload: unknown): Promise<void> {
    const session = this.sessions.get(from);
    if (!session) return;
    const opened = await openCheckedFrame<{ type: string; id?: number; channel?: string; request?: unknown; sig?: string }>(
      session,
      payload,
      { expectedSeq: seq, isCurrent: () => this.sessions.get(from) === session }
    );
    if (opened.status === 'undecryptable') {
      this.deps.log('warn', `remote: undecryptable frame from ${from} (seq ${seq})`);
      return;
    }
    if (opened.status !== 'ok') return;
    const inner = opened.value;
    if (inner.type === 'invoke' && inner.channel) {
      const allowed = isRemoteChannel(inner.channel);
      // Approvals are signed inside the e2e channel (§6.8): only a paired device key resolves.
      const signedOk = inner.channel !== 'approvals:respond' || (!!inner.sig && (await verify(session.identity, inner.request, inner.sig)));
      if (!allowed || !signedOk) {
        // A paired client asking for a local-only channel is either an outdated web build or a probe.
        this.deps.log('warn', `remote: refused ${inner.channel} from ${from} (${allowed ? 'missing or invalid approval signature' : 'channel not available remotely'})`);
        this.deps.audit?.record('channel-refused', { device: from, detail: inner.channel });
        await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: 'channel not available remotely' });
        return;
      }
      // View-only mode (P4): the read half is served, the write half is refused before dispatch,
      // so no send, approval, session change or lifecycle action can reach the registry.
      if (this.deps.viewOnly?.() && !isRemoteReadChannel(inner.channel)) {
        this.deps.log('info', `remote: refused ${inner.channel} from ${from} (view-only mode)`);
        this.deps.audit?.record('view-only-blocked', { device: from, detail: inner.channel });
        await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: 'remote access is in view-only mode' });
        return;
      }
      try {
        const value = projectRemoteValue(isRemoteHostChannel(inner.channel)
          ? await this.serveHostChannel(from, inner.channel, inner.request)
          : await this.dispatch(from, inner.channel, inner.request));
        const outcome = await this.sendTo(from, { type: 'result', id: inner.id, ok: true, value });
        if (outcome === 'oversize') {
          // The relay would drop the frame silently and leave the client waiting out its timeout.
          this.deps.log('warn', `remote: ${inner.channel} response for ${from} exceeded the relay frame limit`);
          // A watch whose snapshot never arrived must not keep streaming against it.
          if (inner.channel === 'terminal:watch') this.terminalStreams.unwatch(from, (value as { terminalId?: string } | null)?.terminalId ?? '');
          await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: 'response too large' });
        }
      } catch (e) {
        await this.sendTo(from, { type: 'result', id: inner.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (inner.type === 'handshake.hello') {
      // Duplicate hello (client retry): re-run the handshake to refresh the session.
      await this.onHandshake(from, inner);
    }
  }

  /** Fan a local push event out to every connected web client, sealed per client. Only the
   *  remote push surface leaves the machine; the rest is dropped here, before sealing. */
  async broadcastPush(channel: string, payload: unknown): Promise<void> {
    if (!isRemotePushChannel(channel)) return;
    // Session pushes carry SessionMeta; strip what only the desktop may see before sealing.
    const body = channel === 'push:sessionsChanged' ? projectRemoteValue(payload) : payload;
    for (const clientId of [...this.sessions.keys()]) {
      const outcome = await this.sendTo(clientId, { type: 'push', channel, payload: body });
      if (outcome === 'oversize') this.deps.log('warn', `remote: dropped a ${channel} push for ${clientId} (over the relay frame limit)`);
    }
  }

  async broadcastMirrorKey(key: string): Promise<void> {
    for (const clientId of [...this.sessions.keys()]) await this.sendTo(clientId, { type: 'mirror.key', key });
  }

  /** Channels whose answer depends on the caller (P3.5 terminal streams). */
  private async serveHostChannel(from: string, channel: string, request: unknown): Promise<unknown> {
    const req = (request && typeof request === 'object' ? request : {}) as { terminalId?: unknown; chars?: unknown; snapshot?: unknown };
    const terminalId = typeof req.terminalId === 'string' ? req.terminalId : '';
    if (!terminalId) throw new Error('terminalId is required');
    switch (channel) {
      case 'terminal:watch':
        return this.terminalStreams.watch(from, terminalId);
      case 'terminal:unwatch':
        this.terminalStreams.unwatch(from, terminalId);
        return undefined;
      case 'terminal:watchAck':
        this.terminalStreams.ack(from, terminalId, typeof req.chars === 'number' ? req.chars : 0, typeof req.snapshot === 'number' ? req.snapshot : undefined);
        return undefined;
      default:
        throw new Error('channel not available remotely');
    }
  }

  /** A registry channel on behalf of a browser. Terminal writes are bounded and audited here before
   *  the registry's own handler passes them to the shell. */
  private async dispatch(from: string, channel: string, request: unknown): Promise<unknown> {
    if (channel === 'terminal:input') {
      const req = (request && typeof request === 'object' ? request : {}) as { terminalId?: unknown; data?: unknown };
      if (typeof req.terminalId !== 'string' || typeof req.data !== 'string') throw new Error('terminalId and data are required');
      if (req.data.length > REMOTE_TERMINAL_INPUT_MAX) throw new Error('input too large');
      // Only a running shell takes remote keystrokes: a restored tab would queue them, unseen, until
      // someone opens it on the desktop, and an unknown id must not grow the audit bookkeeping.
      const info = this.deps.terminals?.()?.list().find((t) => t.id === req.terminalId);
      if (!info) throw new Error('Terminal not found');
      if (!info.pid) throw new Error(info.restored && !info.exit ? "This terminal's shell starts when it is opened on the computer" : "This terminal's shell has exited");
      let typed = this.typedInto.get(from);
      if (!typed) this.typedInto.set(from, (typed = new Set()));
      if (!typed.has(req.terminalId)) {
        typed.add(req.terminalId);
        this.deps.log('info', `remote: ${from} is typing into terminal ${req.terminalId}`);
        this.deps.audit?.record('terminal-input', { device: from, detail: req.terminalId });
      }
    }
    const value = await this.deps.registry().invoke(channel, request);
    if (channel === 'terminal:create') {
      const id = (value as { id?: string } | null)?.id;
      this.deps.log('info', `remote: ${from} opened terminal ${id ?? '?'}`);
      this.deps.audit?.record('terminal-create', { device: from, detail: id });
    }
    return value;
  }

  /** One sealed frame's fate: 'oversize' means it was refused unsent because the relay would have
   *  dropped it, 'skipped' that the client or its socket is already gone. */
  async sendTo(clientId: string, inner: unknown): Promise<'sent' | 'oversize' | 'skipped'> {
    const session = this.sessions.get(clientId);
    if (!session) return 'skipped';
    const send = session.outgoing.then(async (): Promise<'sent' | 'oversize' | 'skipped'> => {
      const socket = this.deps.getSocket();
      if (this.sessions.get(clientId) !== session || !socket || socket.readyState !== WebSocket.OPEN) return 'skipped';
      const sealed = await sealFrame(session.key, session.salt, session.out++, inner);
      const wire = JSON.stringify({ t: 'd', to: clientId, seq: sealed.seq, payload: sealed });
      // The relay drops anything over MAX_WS_FRAME_BYTES without telling either side
      // (relay/src/hub.ts). Refuse it here, where the sender can still say so.
      if (Buffer.byteLength(wire, 'utf8') > REMOTE_FRAME_MAX_BYTES) return 'oversize';
      if (this.sessions.get(clientId) === session && this.deps.getSocket() === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(wire);
        return 'sent';
      }
      return 'skipped';
    });
    session.outgoing = send.then(() => undefined, () => undefined);
    return send;
  }
}
