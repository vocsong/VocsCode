/**
 * Workspace layout, split panes, navigation history, panels, file/PR/subagent reveals, and modal UI slice.
 */
import { parseGitHubPullRequestUrl } from '../../../shared/github-pull-request';
import type { GitPullRequestDetail } from '../../../shared/types';
import { invoke, invokeErrorMessage } from '../api';
import { showOutsideFile } from '../file-open';
import { workspaceRelativePath } from '../file-refs';
import * as panes from '../panes';
import type { FilePreviewTarget } from '../panes';
import { loadPins, savePins } from '../pins';
import { applyNav, markPanelBottomOpened, pushHistory } from './helpers';
import type { Getter, Setter, State, StoreRuntime } from './types';

type LayoutSliceKeys =
  | 'activeId'
  | 'layout'
  | 'view'
  | 'analyticsTab'
  | 'analyticsRange'
  | 'sidebarOpen'
  | 'panelOpen'
  | 'panelTab'
  | 'panelBottomTab'
  | 'panelBottomOpened'
  | 'panelFocus'
  | 'panelPeek'
  | 'pins'
  | 'gitPanelView'
  | 'gitPullRequestPreview'
  | 'fileReveal'
  | 'subagentReveal'
  | 'newSessionOpen'
  | 'newSessionRoot'
  | 'quickSessionOpen'
  | 'quickSessionPrefill'
  | 'paletteOpen'
  | 'searchOpen'
  | 'searchJump'
  | 'showThinking'
  | 'visibleSessionIds'
  | 'history'
  | 'historyIndex'
  | 'setActive'
  | 'focusPane'
  | 'splitPane'
  | 'closePane'
  | 'dropSession'
  | 'resizePanes'
  | 'navBack'
  | 'navForward'
  | 'setView'
  | 'setAnalyticsView'
  | 'toggleSidebar'
  | 'togglePanel'
  | 'setPanelTab'
  | 'setGitPanelView'
  | 'openPullRequestLink'
  | 'closePullRequestPreview'
  | 'setPanelBottomTab'
  | 'endPanelPeek'
  | 'togglePin'
  | 'revealFile'
  | 'closeFilePreview'
  | 'consumeFileReveal'
  | 'revealSubagentRun'
  | 'consumeSubagentReveal'
  | 'openNewSession'
  | 'startNewSession'
  | 'openQuickSession'
  | 'openPalette'
  | 'openSearch'
  | 'jumpToSearchMatch'
  | 'toggleThinking';

export function createLayoutSlice(rt: StoreRuntime, toastError: (error: unknown) => void) {
  return (set: Setter, get: Getter): Pick<State, LayoutSliceKeys> => ({
    activeId: null,
    layout: panes.singlePaneLayout(),
    view: 'chat',
    analyticsTab: 'overview',
    analyticsRange: 30,
    sidebarOpen: true,
    panelOpen: true,
    panelTab: 'changes',
    panelBottomTab: 'mcp',
    panelBottomOpened: [],
    panelFocus: 'top',
    panelPeek: false,
    pins: loadPins(),
    gitPanelView: 'branches',
    gitPullRequestPreview: null,
    fileReveal: null,
    subagentReveal: null,
    newSessionOpen: false,
    newSessionRoot: null,
    quickSessionOpen: false,
    quickSessionPrefill: undefined,
    paletteOpen: false,
    searchOpen: false,
    searchJump: null,
    showThinking: true,
    visibleSessionIds: [],
    history: [],
    historyIndex: -1,

    async setActive(id, pane) {
      set((s) => ({
        activeId: id,
        view: 'chat',
        layout: pane === 'right' && id ? panes.openSessionOnRight(s.layout, id) : panes.openSession(s.layout, id)
      }));
      pushHistory(rt, set, get, { view: 'chat', sessionId: id });
      if (id) await get().loadTranscript(id);
    },

    focusPane(paneId) {
      const layout = panes.focusPane(get().layout, paneId);
      if (layout === get().layout) return;
      const sessionId = panes.activePane(layout).sessionId;
      // Both panes are mounted and loaded already: focusing only moves the context, nothing reloads.
      set({ layout, activeId: sessionId });
      pushHistory(rt, set, get, { view: 'chat', sessionId });
    },

    splitPane(orientation, opts = {}) {
      const current = get().layout;
      const layout = panes.splitPane(current, opts.paneId ?? current.activePaneId, orientation, opts.sessionId ?? null, opts.side);
      if (layout === current) return;
      const sessionId = panes.activePane(layout).sessionId;
      set({ layout, activeId: sessionId, view: 'chat' });
      if (sessionId) {
        pushHistory(rt, set, get, { view: 'chat', sessionId });
        void get().loadTranscript(sessionId).catch(toastError);
      }
    },

    closePane(paneId) {
      const layout = panes.closePane(get().layout, paneId);
      if (layout === get().layout) return;
      set({ layout, activeId: panes.activePane(layout).sessionId });
    },

    dropSession(paneId, zone, sessionId) {
      const target = get().sessions.find((s) => s.id === sessionId);
      if (!target) return;
      const layout = panes.applyDrop(get().layout, paneId, zone, sessionId);
      if (layout === get().layout) return;
      set({ layout, activeId: sessionId, view: 'chat' });
      pushHistory(rt, set, get, { view: 'chat', sessionId });
      void get().loadTranscript(sessionId).catch(toastError);
    },

    resizePanes(sizes) {
      const layout = panes.resizePanes(get().layout, sizes);
      if (layout !== get().layout) set({ layout });
    },

    async navBack() {
      const { history, historyIndex } = get();
      if (historyIndex <= 0) return;
      await applyNav(rt, set, get, history[historyIndex - 1], historyIndex - 1);
    },

    async navForward() {
      const { history, historyIndex } = get();
      if (historyIndex >= history.length - 1) return;
      await applyNav(rt, set, get, history[historyIndex + 1], historyIndex + 1);
    },

    setView(view) {
      set({ view });
      pushHistory(rt, set, get, { view, sessionId: get().activeId });
    },

    setAnalyticsView(patch) {
      set((s) => ({ analyticsTab: patch.tab ?? s.analyticsTab, analyticsRange: patch.range ?? s.analyticsRange }));
    },

    toggleSidebar() {
      set((s) => ({ sidebarOpen: !s.sidebarOpen }));
    },

    togglePanel(open) {
      set((s) => {
        const panelOpen = open ?? !(s.panelOpen || s.layout.filePreview);
        return { panelOpen, panelPeek: panelOpen, layout: panelOpen ? s.layout : panes.closeFilePreview(s.layout) };
      });
    },

    setPanelTab(tab) {
      // MCP moved to the lower half; asking for that tab opens the half instead of an empty top pane.
      if (tab === 'mcp') get().setPanelBottomTab('mcp');
      else set({ panelTab: tab, panelOpen: true, panelFocus: 'top', panelPeek: true });
    },

    setGitPanelView(gitPanelView) {
      set({ gitPanelView });
    },

    openPullRequestLink(sessionId, url) {
      if (get().activeId !== sessionId) return false;
      const link = parseGitHubPullRequestUrl(url);
      if (!link) return false;
      const preview = { sessionId, url, number: link.number, detail: null };
      set({ panelOpen: true, panelTab: 'branches', panelFocus: 'top', panelPeek: true, gitPanelView: 'prs', gitPullRequestPreview: preview });
      // A different link, dismissal, or session switch takes precedence over this response.
      const settle = (detail: GitPullRequestDetail) => {
        set((s) => s.gitPullRequestPreview === preview ? { gitPullRequestPreview: { ...preview, detail } } : s);
      };
      void invoke('git:pullRequest', { sessionId, url: link.url }).then(settle, (error) => settle({ error: invokeErrorMessage(error) }));
      return true;
    },

    closePullRequestPreview() {
      set({ gitPullRequestPreview: null });
    },

    setPanelBottomTab(panelBottomTab) {
      set((s) => ({ panelBottomTab, panelBottomOpened: markPanelBottomOpened(s.panelBottomOpened, panelBottomTab), panelOpen: true, panelFocus: 'bottom', panelPeek: true }));
    },

    endPanelPeek() {
      set((s) => (s.panelPeek ? { panelPeek: false } : {}));
    },

    togglePin(side) {
      const pins = { ...get().pins, [side]: !get().pins[side] };
      savePins(pins);
      set({ pins });
    },

    revealFile(sessionId, path, line, opts = {}) {
      const st = get();
      const session = st.sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const root = session.cwd;
      const target = path.trim();
      const rel = workspaceRelativePath(root, target);
      if (rel === null) {
        void showOutsideFile(sessionId, root, target, (text, kind) => get().toast(text, kind));
        return;
      }
      const filesPanel = { panelTab: 'files', panelFocus: 'top', panelPeek: true, view: 'chat' } as const;
      const clean = rel.replace(/\/+$/, '');
      if (/[\\/]$/.test(target) || clean === '') {
        // A folder is something to browse: the Files tab opens on it.
        set({ ...filesPanel, panelOpen: true, fileReveal: { sessionId, path: target } });
        return;
      }
      const file: FilePreviewTarget = {
        sessionId,
        path: clean,
        nonce: ++rt.fileNonce,
        ...(line && line > 0 ? { line } : {}),
        ...(opts.exact ? { exact: true } : {})
      };
      const layout = panes.openFilePreview(st.layout, file);
      if (layout !== st.layout) set({ ...filesPanel, layout });
    },

    closeFilePreview() {
      const current = get().layout;
      const layout = panes.closeFilePreview(current);
      if (layout !== current) set({ layout });
    },

    consumeFileReveal() {
      set((s) => (s.fileReveal ? { fileReveal: null } : {}));
    },

    revealSubagentRun(sessionId, runId) {
      set((s) => ({ subagentReveal: { sessionId, runId }, panelBottomTab: 'subagents', panelBottomOpened: markPanelBottomOpened(s.panelBottomOpened, 'subagents'), panelOpen: true, panelFocus: 'bottom', panelPeek: true }));
    },

    consumeSubagentReveal() {
      set((s) => (s.subagentReveal ? { subagentReveal: null } : {}));
    },

    openNewSession(newSessionOpen) {
      set({ newSessionOpen });
    },

    async startNewSession(root) {
      if (!root) {
        const r = await invoke('app:pickFolder', { defaultPath: get().settings?.recentProjects[0] });
        if (!r.path) return;
        root = r.path;
      }
      set({ newSessionOpen: true, newSessionRoot: root });
    },

    openQuickSession(quickSessionOpen, quickSessionPrefill) {
      set(quickSessionOpen ? { quickSessionOpen, quickSessionPrefill } : { quickSessionOpen, quickSessionPrefill: undefined });
    },

    openPalette(paletteOpen) {
      set({ paletteOpen });
    },

    openSearch(searchOpen) {
      set({ searchOpen });
    },

    jumpToSearchMatch(sessionId, itemId) {
      set((s) => ({ searchOpen: false, searchJump: itemId ? { sessionId, itemId, n: (s.searchJump?.n ?? 0) + 1 } : null }));
      void get().setActive(sessionId).catch(toastError);
    },

    toggleThinking() {
      set((s) => ({ showThinking: !s.showThinking }));
    }
  });
}
