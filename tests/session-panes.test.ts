// The split view's pane model: which session each pane shows, which pane is active, and how a
// split survives a restart. Pure functions, so every rule is pinned here without a DOM.
import { describe, expect, it } from 'vitest';
import {
  activePane,
  applyDrop,
  closePane,
  dropZoneAt,
  MAX_PANES,
  openSession,
  restoreLayout,
  resizePanes,
  saveLayout,
  singlePaneLayout,
  splitPane,
  withoutSessions,
  type PaneLayout
} from '../src/renderer/src/panes';

const two = (a = 's_a', b: string | null = 's_b', orientation: PaneLayout['orientation'] = 'horizontal'): PaneLayout => {
  const layout = splitPane(singlePaneLayout(a), 'pane-1', orientation, b);
  expect(layout.panes).toHaveLength(2);
  return layout;
};
const shown = (layout: PaneLayout) => layout.panes.map((p) => p.sessionId);

describe('session pane model', () => {
  it('splits right into an empty, active pane and keeps the original session in the first', () => {
    const start = singlePaneLayout('s_a');
    const layout = splitPane(start, 'pane-1', 'horizontal');
    expect(shown(layout)).toEqual(['s_a', null]);
    expect(layout.activePaneId).toBe(layout.panes[1]!.id);
    expect(layout.orientation).toBe('horizontal');
    expect(layout.sizes).toEqual([0.5, 0.5]);
    // The starting layout is untouched: the store compares references to skip no-op updates.
    expect(shown(start)).toEqual(['s_a']);
  });

  it('opens a sidebar pick in the active pane and leaves the other pane alone', () => {
    const layout = openSession(splitPane(singlePaneLayout('s_a'), 'pane-1', 'horizontal'), 's_c');
    expect(shown(layout)).toEqual(['s_a', 's_c']);
    expect(activePane(layout).sessionId).toBe('s_c');
  });

  it('focuses the pane already showing a session instead of opening it twice', () => {
    const layout = two();
    const focused = openSession(layout, 's_a');
    expect(shown(focused)).toEqual(['s_a', 's_b']);
    expect(activePane(focused).sessionId).toBe('s_a');
    // Already active and already shown: nothing changes at all.
    expect(openSession(focused, 's_a')).toBe(focused);
  });

  it('caps the workspace at MAX_PANES and refuses to show one session twice through a split', () => {
    const full = two();
    expect(MAX_PANES).toBe(2);
    expect(splitPane(full, full.activePaneId, 'horizontal', 's_c')).toBe(full);
    const single = singlePaneLayout('s_a');
    expect(splitPane(single, 'pane-1', 'horizontal', 's_a')).toBe(single);
  });

  it('stacks vertically from a single pane', () => {
    const layout = two('s_a', 's_b', 'vertical');
    expect(layout.orientation).toBe('vertical');
    expect(shown(layout)).toEqual(['s_a', 's_b']);
  });

  it('closes a pane without touching its session, and the neighbour becomes active', () => {
    const layout = two();
    const closed = closePane(layout, layout.activePaneId);
    expect(shown(closed)).toEqual(['s_a']);
    expect(activePane(closed).sessionId).toBe('s_a');
    expect(closed.sizes).toEqual([1]);
    // The last pane never closes: that would leave no workspace.
    expect(closePane(closed, closed.activePaneId)).toBe(closed);
  });

  it('resizes with normalised shares and ignores degenerate input', () => {
    const layout = two();
    const resized = resizePanes(layout, [0.7, 0.3]);
    expect(resized.sizes).toEqual([0.7, 0.3]);
    expect(resizePanes(resized, [7, 3])).toBe(resized);
    expect(resizePanes(resized, [1, 0])).toBe(resized);
    expect(resizePanes(resized, [1])).toBe(resized);
  });

  it('closes panes whose session left, and gives a lone pane the replacement', () => {
    const layout = two();
    const afterB = withoutSessions(layout, (id) => id === 's_b', null);
    expect(shown(afterB)).toEqual(['s_a']);
    const lone = withoutSessions(singlePaneLayout('s_a'), (id) => id === 's_a', 's_z');
    expect(shown(lone)).toEqual(['s_z']);
  });
});

describe('dragging a session onto a pane', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 800 };

  it('splits on the edge nearest the pointer and replaces in the middle', () => {
    const single = singlePaneLayout('s_a');
    expect(dropZoneAt(single, rect, 500, 400)).toBe('center');
    expect(dropZoneAt(single, rect, 950, 400)).toBe('right');
    expect(dropZoneAt(single, rect, 30, 400)).toBe('left');
    expect(dropZoneAt(single, rect, 500, 20)).toBe('top');
    expect(dropZoneAt(single, rect, 500, 790)).toBe('bottom');
  });

  it('only replaces once the workspace is full', () => {
    expect(dropZoneAt(two(), rect, 990, 400)).toBe('center');
  });

  it('puts the dropped session in a new pane on that edge', () => {
    const left = applyDrop(singlePaneLayout('s_a'), 'pane-1', 'left', 's_b');
    expect(shown(left)).toEqual(['s_b', 's_a']);
    expect(left.orientation).toBe('horizontal');
    expect(activePane(left).sessionId).toBe('s_b');
    const bottom = applyDrop(singlePaneLayout('s_a'), 'pane-1', 'bottom', 's_b');
    expect(shown(bottom)).toEqual(['s_a', 's_b']);
    expect(bottom.orientation).toBe('vertical');
  });

  it('swaps two panes when a session already on screen is dropped onto the other one', () => {
    const layout = two();
    const swapped = applyDrop(layout, layout.panes[0]!.id, 'center', 's_b');
    expect(shown(swapped)).toEqual(['s_b', 's_a']);
    expect(activePane(swapped).sessionId).toBe('s_b');
  });

  it('does nothing when a session is dropped on the edge of its own lone pane', () => {
    const single = singlePaneLayout('s_a');
    expect(applyDrop(single, 'pane-1', 'right', 's_a')).toBe(single);
  });
});

describe('split persistence', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { data, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), getItem: (k: string) => data.get(k) ?? null };
  };

  it('round-trips a split with its orientation, shares and active pane', () => {
    const store = memory();
    const layout = resizePanes(two('s_a', 's_b', 'vertical'), [0.6, 0.4]);
    saveLayout(layout, store);
    const restored = restoreLayout(store.getItem('vocs-code.sessionLayout'), () => true);
    expect(restored).toEqual(layout);
  });

  it('leaves nothing behind for a single pane, so the next boot starts as it always did', () => {
    const store = memory();
    saveLayout(two(), store);
    saveLayout(singlePaneLayout('s_a'), store);
    expect(store.data.size).toBe(0);
  });

  it('drops panes whose session is gone and recovers from malformed data', () => {
    const store = memory();
    const layout = two();
    saveLayout(layout, store);
    const raw = store.getItem('vocs-code.sessionLayout');
    const partial = restoreLayout(raw, (id) => id === 's_a');
    expect(partial && shown(partial)).toEqual(['s_a']);
    expect(partial?.activePaneId).toBe(partial?.panes[0]!.id);
    expect(partial?.sizes).toEqual([1]);
    expect(restoreLayout(raw, () => false)).toBeNull();
    expect(restoreLayout('{not json', () => true)).toBeNull();
    expect(restoreLayout(JSON.stringify({ orientation: 'diagonal', panes: [] }), () => true)).toBeNull();
    // A hand-edited duplicate cannot put one session on screen twice.
    const dup = restoreLayout(JSON.stringify({ orientation: 'horizontal', panes: [{ id: 'a', sessionId: 's_a' }, { id: 'b', sessionId: 's_a' }], activePaneId: 'b', sizes: [1, 1] }), () => true);
    expect(dup && shown(dup)).toEqual(['s_a']);
  });
});
