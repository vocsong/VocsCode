/** Thin typed wrapper over the preload bridge, plus platform helpers for shortcut labels.
 *  In web builds (platform === 'browser') a few desktop affordances are served in the
 *  browser itself instead of round-tripping to the host machine (docs/REMOTE-ACCESS.md):
 *  opening URLs, notifications, folder picking and clipboard paste. */
import type { IpcChannel, IpcRequest, IpcResponse, PushPayloads } from '../../shared/ipc';

export function on<K extends keyof PushPayloads>(channel: K, listener: (payload: PushPayloads[K]) => void): () => void {
  return window.harness.on(channel, listener);
}

export const platform = typeof window !== 'undefined' && window.harness ? window.harness.platform : 'unknown';
export const isMac = platform === 'darwin';
/** Web build: the browser provides the chrome, so the in-app title bar stays hidden. */
export const isWeb = platform === 'browser';
export const modKey = isMac ? '⌘' : 'Ctrl';

export function invoke<K extends IpcChannel>(channel: K, request: IpcRequest<K>): Promise<IpcResponse<K>> {
  if (isWeb) return webInvoke(channel, request) as Promise<IpcResponse<K>>;
  return window.harness.invoke(channel, request);
}

/** Serves the desktop affordances a browser must handle itself.
 *  Returns `undefined` to pass the invoke through to the host, `null` when handled
 *  with no result, or the shimmed result object. Exported for tests. */
export async function webShim(channel: IpcChannel, request: unknown): Promise<unknown | undefined> {
  switch (channel) {
    case 'app:openExternal': {
      const url = (request as { url?: string }).url ?? '';
      if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
      return null;
    }
    case 'app:notify': {
      browserNotify((request as { title?: string }).title ?? '', (request as { body?: string }).body ?? '');
      return null;
    }
    case 'window:edit': {
      if ((request as { command?: string }).command !== 'paste') return undefined;
      const text = (await navigator.clipboard?.readText?.()) ?? '';
      if (!text) return null;
      const el = document.activeElement;
      // execCommand('insertText') routes through the input event, so xterm's hidden
      // textarea forwards it to the terminal with bracketed-paste semantics intact.
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) document.execCommand('insertText', false, text);
      return null;
    }
    default:
      return undefined;
  }
}

async function webInvoke(channel: IpcChannel, request: unknown): Promise<unknown> {
  const shimmed = await webShim(channel, request);
  if (shimmed !== undefined) return shimmed;
  return window.harness.invoke(channel as never, request as never);
}

function browserNotify(title: string, body: string): void {
  // Notification needs a user gesture to grant permission; a turn finishing usually has
  // none, so an ungranted permission silently drops the toast (the UI still shows state).
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') new Notification(title, { body: body.slice(0, 200) });
  else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => { if (p === 'granted') new Notification(title, { body: body.slice(0, 200) }); });
}
