/** Thin typed wrapper over the preload bridge, plus platform helpers for shortcut labels. */
import type { IpcChannel, IpcRequest, IpcResponse, PushPayloads } from '../../shared/ipc';

export function on<K extends keyof PushPayloads>(channel: K, listener: (payload: PushPayloads[K]) => void): () => void {
  return window.harness.on(channel, listener);
}

export const platform = typeof window !== 'undefined' && window.harness ? window.harness.platform : 'unknown';
export const isMac = platform === 'darwin';
export const modKey = isMac ? '⌘' : 'Ctrl';

export function invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  return window.harness.invoke(channel, request);
}

/** Whether the bound transport can serve a channel. Desktop IPC has no gate, so everything is
 *  allowed; a transport that binds `can` narrows the surface. Callers use this to
 *  hide a control that would be refused, never as a security boundary — the host still decides. */
export function canInvoke<K extends IpcChannel>(channel: K): boolean {
  return window.harness?.can?.(channel) ?? true;
}

/** The handler's own message. Electron wraps a rejected invoke as
 *  `Error invoking remote method '<channel>': Error: <message>`, which is noise in a toast. */
export function invokeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}
