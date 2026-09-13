/** @vitest-environment jsdom */
/** Unit tests for the web-build invoke shims in api.ts: the browser-served desktop
 *  affordances (open URL guard, folder prompt, clipboard paste) and pass-through. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webShim } from '../src/renderer/src/api';

describe('web invoke shims', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes unknown channels through to the host', async () => {
    expect(await webShim('sessions:list', undefined)).toBeUndefined();
    expect(await webShim('settings:get', undefined)).toBeUndefined();
  });

  it('opens only http(s) URLs, never file:// or javascript:', async () => {
    const open = vi.fn();
    (window as { open: unknown }).open = open;
    await webShim('app:openExternal', { url: 'file:///etc/passwd' });
    await webShim('app:openExternal', { url: 'javascript:alert(1)' });
    expect(open).not.toHaveBeenCalled();
    await webShim('app:openExternal', { url: 'https://example.com' });
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });

  it('lets pickFolder pass through to the host', async () => {
    // The folders live on the host, and the renderer must not open native dialogs
    // (repo invariant, tests/unit.test.ts): the shim must not intercept this channel.
    expect(await webShim('app:pickFolder', { defaultPath: '/x' })).toBeUndefined();
  });

  it('pastes clipboard text into the focused field via insertText', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'hello' }, configurable: true });
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const insert = vi.fn();
    (document as unknown as { execCommand: unknown }).execCommand = insert;
    await webShim('window:edit', { command: 'paste' });
    expect(insert).toHaveBeenCalledWith('insertText', false, 'hello');
    // Non-paste edit commands are not shimmed; they pass through to the host.
    expect(await webShim('window:edit', { command: 'undo' })).toBeUndefined();
  });

  it('handles app:notify without a Notification API', async () => {
    // jsdom has no Notification: the shim must not throw and must not reach the host.
    await expect(webShim('app:notify', { title: 't', body: 'b' })).resolves.toBeNull();
  });
});