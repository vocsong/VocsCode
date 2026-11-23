/**
 * Regression guards for Wave 2 renderer architecture:
 * - Store `reset()` clears all per-host state and queued streaming deltas atomically.
 * - Every layered renderer stylesheet declares the canonical `@layer` order up front so
 *   Rollup chunk ordering can never invert cascade precedence, and `main.tsx` imports
 *   `styles.css` before `App`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from '../src/renderer/src/store';
import type { MissionRecord } from '../src/shared/mission';

const CANONICAL_LAYERS = '@layer tokens, reset, base, components, features, themes, modes;';

describe('store reset isolation', () => {
  it('clears per-host mission/overlay state and drops queued streaming deltas on reset', () => {
    const rafQueue: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    try {
      useStore.setState({
        sessions: [],
        transcripts: { s1: [{ id: 'a1', kind: 'assistant', ts: 1, text: 'hi' }] },
        missions: { m1: { id: 'm1', revision: 1, lastEventSequence: 1 } as unknown as MissionRecord },
        missionErrors: { m1: 'boom' },
        missionInspector: { missionId: 'm1', sessionId: 's1' },
        archiving: { s1: true },
        fileReveal: { sessionId: 's1', path: 'src' },
        subagentReveal: { sessionId: 's1', runId: 'r1' },
        searchJump: { sessionId: 's1', itemId: 'a1', n: 1 },
        processSummary: { total: 1, running: 1 } as never
      });

      // Queue a streaming delta before reset.
      useStore.getState().applyEvent({
        sessionId: 's1',
        ts: 2,
        event: { type: 'item.delta', id: 'a1', textDelta: ' stale-from-previous-host' }
      });
      expect(rafQueue).toHaveLength(1);

      // Reset for a host switch, then install a fresh session sharing id `s1`.
      useStore.getState().reset();
      const afterReset = useStore.getState();
      expect(afterReset.missions).toEqual({});
      expect(afterReset.missionErrors).toEqual({});
      expect(afterReset.missionInspector).toBeNull();
      expect(afterReset.archiving).toEqual({});
      expect(afterReset.fileReveal).toBeNull();
      expect(afterReset.subagentReveal).toBeNull();
      expect(afterReset.searchJump).toBeNull();
      expect(afterReset.processSummary).toBeNull();

      useStore.setState({ transcripts: { s1: [{ id: 'a1', kind: 'assistant', ts: 10, text: 'fresh' }] } });
      // Flush the pre-reset RAF callback: it must not mutate the new host's transcript.
      rafQueue.forEach((cb) => cb(16));
      expect(useStore.getState().transcripts.s1).toEqual([{ id: 'a1', kind: 'assistant', ts: 10, text: 'fresh' }]);
    } finally {
      if (origRaf) vi.stubGlobal('requestAnimationFrame', origRaf);
      else vi.unstubAllGlobals();
      useStore.getState().reset();
    }
  });
});

describe('renderer CSS cascade layers', () => {
  const root = process.cwd();
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it('imports styles.css before App in main.tsx', () => {
    const main = read('src/renderer/src/main.tsx');
    expect(main.indexOf("import './styles.css'")).toBeGreaterThan(-1);
    expect(main.indexOf("import './styles.css'")).toBeLessThan(main.indexOf("import { App } from './App'"));
  });

  it('declares the canonical layer order in every layered stylesheet', () => {
    const layered = [
      'src/renderer/src/styles.css',
      'src/renderer/src/ui-zen.css',
      'src/renderer/src/terminal/xterm.css',
      'src/renderer/src/components/settings.css',
      'src/renderer/src/components/onboarding.css',
      'src/renderer/src/components/session-title.css',
      'src/renderer/src/components/file-editor.css',
      'src/renderer/src/components/housekeep-dialog.css',
      'src/renderer/src/components/transcript-links.css',
      'src/renderer/src/components/knowledge/knowledge.css',
      'src/renderer/src/components/mission/mission.css',
      'src/renderer/src/components/mission/MissionSettings.css'
    ];
    for (const file of layered) {
      const content = read(file);
      const declPos = content.indexOf(CANONICAL_LAYERS);
      const blockPos = content.search(/@layer\s+[a-z]+\s*\{/);
      expect(declPos, `${file} missing canonical @layer order`).toBeGreaterThan(-1);
      if (blockPos !== -1) expect(declPos, `${file} must declare layer order before any @layer block`).toBeLessThan(blockPos);
    }
  });
});
