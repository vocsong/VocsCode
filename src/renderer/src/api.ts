import type { IpcChannel, IpcRequest, IpcResponse, PushPayloads } from '../../shared/ipc';

export function invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  return window.harness.invoke(channel, request);
}

export function on<K extends keyof PushPayloads>(channel: K, listener: (payload: PushPayloads[K]) => void): () => void {
  return window.harness.on(channel, listener);
}

export const platform = typeof window !== 'undefined' && window.harness ? window.harness.platform : 'unknown';
export const isMac = platform === 'darwin';
export const modKey = isMac ? '⌘' : 'Ctrl';
