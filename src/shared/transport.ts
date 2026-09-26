/** Transport-agnostic renderer bridge: how the renderer reaches its host process.
 *  The preload script binds it to Electron IPC; web/remote builds (docs/REMOTE-ACCESS.md)
 *  bind the same interface to a WebSocket carrying the identical channel contract. */
import type { IpcChannel, IpcRequest, IpcResponse, PushChannel, PushPayloads } from './ipc';

export interface Transport {
  invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>>;
  on<K extends PushChannel>(channel: K, listener: (payload: PushPayloads[K]) => void): () => void;
  platform: string;
  /** Whether this transport can serve a channel. Absent means everything is allowed (desktop IPC).
   *  A remote transport refuses channels off its allowlist and, in view-only mode, writes — so the
   *  renderer can hide a control it would be refused instead of provoking an audited refusal. */
  can?<K extends IpcChannel>(channel: K): boolean;
}