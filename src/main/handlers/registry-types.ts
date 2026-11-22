/**
 * Minimal HandlerRegistry contract shared by IPC and remote transports without
 * pulling in HandlerDeps or RemoteHost (keeping handlers <-> remote/host acyclic).
 */
import type { IpcChannel } from '../../shared/ipc';

export interface HandlerRegistry {
  /** Every channel this registry serves — the host binds each to its transport. */
  channels(): IpcChannel[];
  invoke(channel: string, req: unknown, actor?: 'user' | 'agent' | 'desktop'): Promise<unknown>;
  /** Shared ordinary-resource guard for typed control operations, not generic IPC dispatch. */
  assertControlResource?(resource: { sessionId?: string; projectRoot?: string }): Promise<void>;
  /** Stops background children the registry owns (Vesta's pi process). */
  shutdown(): Promise<void>;
}
