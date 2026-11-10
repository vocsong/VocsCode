/** Which session the desktop window is on (src/main/desktop-focus.ts): validated, deduped, pushed
 *  to paired browsers, and readable over `desktop:focus` in view-only mode. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { DesktopFocusTracker, forgetVisibleOnRendererReset } from '../src/main/desktop-focus';
import { createHandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import { SettingsStore } from '../src/main/settings';
import type { DesktopFocus } from '../src/shared/types';
import { REMOTE_CHANNELS } from '../src/shared/remote-channels';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `vocs-desktop-focus-${prefix}-`));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) fsSync.rmSync(dir, { recursive: true, force: true });
});

function tracker(known: Set<string>) {
  const pushes: DesktopFocus[] = [];
  const focus = new DesktopFocusTracker({ hasSession: (id) => known.has(id), push: (state) => pushes.push(state) });
  return { focus, pushes };
}

describe('DesktopFocusTracker', () => {
  it('dedupes a session report and coerces an unknown id to Home', () => {
    const known = new Set(['s1']);
    const { focus, pushes } = tracker(known);
    focus.setSession('s1');
    focus.setSession('s1');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ sessionId: 's1', windowFocused: false });
    // A session deleted a moment ago is stale news, not an error: report Home once.
    focus.setSession('deleted');
    focus.setSession('deleted');
    expect(focus.state().sessionId).toBeNull();
    expect(pushes).toHaveLength(2);
  });

  it('reports window focus changes and forgets a reconciled session', () => {
    const known = new Set(['s1']);
    const { focus, pushes } = tracker(known);
    focus.setWindowFocused(true);
    focus.setWindowFocused(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].windowFocused).toBe(true);
    focus.setSession('s1');
    known.delete('s1');
    focus.reconcile();
    expect(focus.state()).toMatchObject({ sessionId: null, windowFocused: true });
    expect(pushes).toHaveLength(3);
  });

  it('counts a session as viewed only while it is on screen and the window is focused', () => {
    const { focus, pushes } = tracker(new Set(['s1', 's2']));
    expect(focus.isViewing('s1')).toBe(false);
    focus.setVisible(['s1']);
    // On screen but the window is behind another app: not viewed.
    expect(focus.isViewing('s1')).toBe(false);
    focus.setWindowFocused(true);
    expect(focus.isViewing('s1')).toBe(true);
    expect(focus.isViewing('s2')).toBe(false);
    focus.setWindowFocused(false);
    expect(focus.isViewing('s1')).toBe(false);
    focus.setWindowFocused(true);
    focus.setVisible([]);
    expect(focus.isViewing('s1')).toBe(false);
    // The visible set is local bookkeeping: paired browsers never receive it.
    expect(pushes.every((p) => !('visible' in p) && !('sessionIds' in p))).toBe(true);
    expect(Object.keys(focus.state()).sort()).toEqual(['at', 'sessionId', 'windowFocused']);
  });

  it('forgets what was on screen when the renderer reloads or dies, so a turn ending then is not seen', () => {
    for (const event of ['did-start-loading', 'render-process-gone']) {
      const { focus } = tracker(new Set(['s1']));
      const contents = new EventEmitter();
      forgetVisibleOnRendererReset(contents, focus);
      focus.setWindowFocused(true);
      focus.setVisible(['s1']);
      expect(focus.isViewing('s1')).toBe(true);
      contents.emit(event, {}, {});
      expect(focus.isViewing('s1'), event).toBe(false);
    }
  });

  it('does not hand out its live state', () => {
    const { focus } = tracker(new Set());
    const state = focus.state();
    state.sessionId = 'tampered';
    expect(focus.state().sessionId).toBeNull();
  });
});

describe('desktop focus handlers', () => {
  it('reports a valid session and coerces an unknown one to Home', async () => {
    const known = new Set(['s1']);
    const { focus } = tracker(known);
    const registry = createHandlerRegistry({
      settings: new SettingsStore(tmpDir('settings')),
      desktopFocus: focus
    } as unknown as HandlerDeps);

    await registry.invoke('desktop:setFocus', { sessionId: 's1' });
    expect(await registry.invoke('desktop:focus', undefined)).toMatchObject({ sessionId: 's1', windowFocused: false });
    await registry.invoke('desktop:setFocus', { sessionId: 'nope' });
    expect(await registry.invoke('desktop:focus', undefined)).toMatchObject({ sessionId: null });
  });

  it('records the visible panes and rejects a malformed report', async () => {
    const { focus } = tracker(new Set(['s1']));
    const registry = createHandlerRegistry({
      settings: new SettingsStore(tmpDir('settings')),
      desktopFocus: focus,
      log: () => undefined
    } as unknown as HandlerDeps);

    focus.setWindowFocused(true);
    await registry.invoke('desktop:setVisible', { sessionIds: ['s1'] });
    expect(focus.isViewing('s1')).toBe(true);
    await expect(registry.invoke('desktop:setVisible', { sessionIds: 's1' } as never)).rejects.toThrow();
    expect(focus.isViewing('s1')).toBe(true);
  });

  it('keeps the visible-pane report off the remote surface', () => {
    expect(REMOTE_CHANNELS.has('desktop:setVisible' as never)).toBe(false);
  });
});
