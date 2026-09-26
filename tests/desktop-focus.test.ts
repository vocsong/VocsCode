/** Which session the desktop window is on (src/main/desktop-focus.ts): validated, deduped, pushed
 *  to paired browsers, and readable over `desktop:focus` in view-only mode. */
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { DesktopFocusTracker } from '../src/main/desktop-focus';
import { createHandlerRegistry, type HandlerDeps } from '../src/main/handlers';
import { SettingsStore } from '../src/main/settings';
import type { DesktopFocus } from '../src/shared/types';

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
});
