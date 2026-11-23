/**
 * Zustand store for session state, panel selection, and toasts. Selectors must return stable references.
 * Composed from cohesive slices under `./store/*` backed by a single encapsulated `StoreRuntime`.
 */
import { create } from 'zustand';
import type { SessionMeta } from '../../shared/types';
import * as panes from './panes';
import { createHostSlice } from './store/host-slice';
import { createLayoutSlice } from './store/layout-slice';
import { configureStore, createStoreRuntime } from './store/runtime';
import { createSessionsSlice } from './store/sessions-slice';
import { COMPOSER_HISTORY_LIMIT, NO_COMPOSER_HISTORY, type State } from './store/types';

export type {
  AnalyticsRange,
  AnalyticsTab,
  FileReveal,
  GitPanelView,
  ModelCatalogEntry,
  NavEntry,
  PanelBottomTab,
  PanelTab,
  StoreOptions,
  Toast,
  View
} from './store/types';
export { COMPOSER_HISTORY_LIMIT, configureStore, NO_COMPOSER_HISTORY };

const runtime = createStoreRuntime();

/** Reports a rejected fire-and-forget action as an error toast instead of an unhandled rejection. */
export function toastError(error: unknown): void {
  useStore.getState().toast(error instanceof Error ? error.message : String(error), 'error');
}

export const useStore = create<State>((set, get) => ({
  ...createHostSlice(runtime, toastError)(set, get),
  ...createLayoutSlice(runtime, toastError)(set, get),
  ...createSessionsSlice(runtime, toastError)(set, get)
}));

useStore.subscribe((s, prev) => {
  // `activeId` is the active pane's session. The actions keep the two together; this catches any
  // other write to `activeId`, so the layout can never show one session while the panels show another.
  if (s.activeId !== prev.activeId && panes.activePane(s.layout).sessionId !== s.activeId) {
    useStore.setState({ layout: panes.openSession(s.layout, s.activeId) });
    return;
  }
  // The split is remembered for the next launch; boot turns this on once it has restored the last one.
  if (runtime.persistLayout && s.layout !== prev.layout) panes.saveLayout(s.layout);
  if (s.gitPullRequestPreview && (s.activeId !== s.gitPullRequestPreview.sessionId || s.view !== 'chat' || !s.panelOpen || s.panelTab !== 'branches' || s.gitPanelView !== 'prs')) {
    useStore.setState({ gitPullRequestPreview: null });
  }
});

export function useActiveSession(): SessionMeta | undefined {
  return useStore((s) => s.sessions.find((x) => x.id === s.activeId));
}
