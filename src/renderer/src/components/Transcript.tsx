import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '../../../shared/types';
import { invoke, isWeb } from '../api';
import { useTranscriptCapabilities } from '../capabilities';
import { installMarkdownHandlers } from '../markdown';
import { useStore } from '../store';
import { chunkKey, estimateChunkHeight, windowRange } from '../transcript-window';
import { isEditableTarget, showContextMenu, type ContextMenuItem } from './ContextMenu';
import { ImageLightbox, type LightboxImage } from './ImageLightbox';
import { OngoingActivityStrip } from './OngoingActivityStrip';
import { TranscriptFind } from './TranscriptFind';
import { ApprovalCard } from './transcript/ApprovalCard';
import {
  canOpenTranscriptPullRequest,
  groupCommands,
  groupTranscript,
  imageSrc,
  isRunningEntry,
  isTerminalEventTarget,
  isWorkItem,
  pinnedPromptIndex,
  PROMPT_JUMP_MARGIN
} from './transcript/grouping';
import { ToolGroup, TranscriptRow, WorkGroup } from './transcript/Groups';
import { PinnedPrompt, UserMessage } from './transcript/MessageViews';
import { Stamp, TranscriptSessionContext, type OnImageExpand } from './transcript/shared';
import { Button, Icon, Spinner } from './ui';
import './transcript-links.css';

export { ApprovalCard, groupCommands, groupTranscript, imageSrc, isRunningEntry, isTerminalEventTarget, isWorkItem, Stamp, ToolGroup, UserMessage, WorkGroup };
export type { OnImageExpand };

interface ImageLightboxState {
  images: LightboxImage[];
  index: number;
}

/** Stable fallback so zustand selectors never return a fresh array (React #185 infinite loop). */
const EMPTY: never[] = [];

/** Below this many chunks the reconciliation cost is small enough to skip windowing entirely. */
const VIRTUALIZE_MIN = 150;

/** `active` is false for a split pane the user is not working in: it keeps streaming, but window-wide keys skip it. */
export function Transcript({ session, active = true }: { session: SessionMeta; active?: boolean }) {
  const items = useStore((s) => s.transcripts[session.id] ?? EMPTY);
  const sessionProcesses = useStore((s) => (isWeb ? EMPTY : (s.processSummary?.bySession?.[session.id] ?? EMPTY)));
  const loaded = useStore((s) => s.loaded[session.id]);
  const transcriptError = useStore((s) => s.transcriptErrors[session.id]);
  const loadTranscript = useStore((s) => s.loadTranscript);
  const loadEarlier = useStore((s) => s.loadEarlier);
  // A paged transcript's first item index; zero on the desktop, where the whole file is loaded.
  const transcriptStart = useStore((s) => s.transcriptStarts[session.id] ?? 0);
  const showThinking = useStore((s) => s.showThinking);
  const jump = useStore((s) => s.searchJump);
  // Subscribe once at the transcript level with primitive selectors so individual AssistantMessage
  // rows never run `s.sessions.find(...)` on every session status/usage push.
  const storeCwd = useStore((s) => s.sessions.find((candidate) => candidate.id === session.id)?.cwd);
  const canOpenPr = useStore((s) => !isWeb && s.activeId === session.id && s.sessions.some((candidate) => candidate.id === session.id));
  const sessionCtx = useMemo(() => ({ cwd: storeCwd, canOpenPr }), [storeCwd, canOpenPr]);
  const caps = useTranscriptCapabilities();
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** The last item the reader had seen when they scrolled away from the bottom. */
  const [unseenAfter, setUnseenAfter] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [lightbox, setLightbox] = useState<ImageLightboxState | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [measureVersion, setMeasureVersion] = useState(0);
  const heights = useRef(new Map<string, number>());
  const rowObserver = useRef<ResizeObserver | null>(null);
  const scrollFrame = useRef(0);
  /** The reader's distance from the bottom, so prepending older items does not move the view. */
  const anchor = useRef<{ firstId: string | null; fromBottom: number }>({ firstId: null, fromBottom: 0 });
  const onImageExpand = useCallback((images: LightboxImage[], index: number) => {
    setLightbox({ images, index });
  }, []);
  /** Inline file references (`\`src/store.ts\``) preview in the split view beside this session. */
  const openFile = useCallback(
    (path: string, line?: number) => useStore.getState().revealFile(session.id, path, line),
    [session.id]
  );
  const canEdit = caps.editAndResend && session.config.harness === 'native' && session.status === 'idle';

  const chunks = useMemo(() => groupTranscript(items, showThinking), [items, showThinking]);
  const running = session.status === 'running' || session.status === 'starting';
  // Work in flight stays open: that is the stretch nothing has followed yet. Once the next message
  // starts, the stretch is finished and collapses to its header, like every earlier one.
  const liveWorkId = useMemo(() => {
    const last = chunks[chunks.length - 1];
    return running && last?.kind === 'work' ? last.id : null;
  }, [chunks, running]);

  // Track the viewport so the window can be sized. jsdom reports 0 and simply disables windowing.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const keys = new Set(chunks.map(chunkKey));
    for (const k of heights.current.keys()) if (!keys.has(k)) heights.current.delete(k);
  }, [chunks]);

  // Rendered rows report their height so unmeasured chunks can keep an estimate instead of the
  // list measuring every historical chunk.
  const measureRow = useCallback((key: string, el: HTMLElement) => {
    el.dataset.rowKey = key;
    if (typeof ResizeObserver !== 'undefined' && !rowObserver.current) {
      rowObserver.current = new ResizeObserver((entries) => {
        // Non-windowed rows use a flex gap; windowed rows carry that gap as padding.
        const gap = ref.current ? Number.parseFloat(getComputedStyle(ref.current).rowGap) || 0 : 0;
        let changed = false;
        for (const entry of entries) {
          const k = (entry.target as HTMLElement).dataset.rowKey;
          if (!k) continue;
          const h = (entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height) + gap;
          if (h > 0 && Math.abs((heights.current.get(k) ?? -1) - h) > 0.5) {
            heights.current.set(k, h);
            changed = true;
          }
        }
        if (changed) setMeasureVersion((v) => v + 1);
      });
    }
    rowObserver.current?.observe(el);
    const gap = ref.current ? Number.parseFloat(getComputedStyle(ref.current).rowGap) || 0 : 0;
    const initial = el.getBoundingClientRect().height + gap;
    if (initial > 0 && Math.abs((heights.current.get(key) ?? -1) - initial) > 0.5) {
      heights.current.set(key, initial);
      setMeasureVersion((v) => v + 1);
    }
    return () => rowObserver.current?.unobserve(el);
  }, []);
  useEffect(() => () => rowObserver.current?.disconnect(), []);

  const tops = useMemo(() => {
    const list = new Array<number>(chunks.length + 1);
    let acc = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      list[i] = acc;
      acc += heights.current.get(chunkKey(chunk)) ?? estimateChunkHeight(chunk);
    }
    list[chunks.length] = acc;
    return list;
  }, [chunks, measureVersion]);

  const jumpHere = !!jump && jump.sessionId === session.id;
  // Windowing stays off while the find bar or a deep-search jump needs every row in the DOM.
  // Until the viewport is measured, assume a screenful so a long transcript never mounts whole.
  const effectiveViewport = viewportH > 0 ? viewportH : 600;
  const virtual = chunks.length > VIRTUALIZE_MIN && !findOpen && !jumpHere;
  const range = virtual ? windowRange(tops, scrollTop, effectiveViewport, 600) : { start: 0, end: chunks.length };
  const visible = virtual ? chunks.slice(range.start, range.end) : chunks;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Terminal owns Ctrl+F so its find bar opens instead of the transcript finder.
      if (isTerminalEventTarget(e.target) || !activeRef.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        // Plain Ctrl+F: find in transcript. Ctrl+Shift+F is the global deep session search.
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const openLink = (url: string) => {
      const state = useStore.getState();
      if (canOpenTranscriptPullRequest(session, state.activeId) && state.openPullRequestLink(session.id, url)) return;
      void invoke('app:openExternal', { url });
    };
    return installMarkdownHandlers(el, openLink, !isWeb && caps.openFile ? openFile : undefined);
  }, [openFile, caps.openFile, session]);

  // While the find bar is open, follow-the-stream would keep yanking the view away from matches.
  useEffect(() => {
    if (stick && !findOpen && !jumpHere && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items, session.ongoing, sessionProcesses, stick, findOpen, jumpHere, measureVersion]);

  // Prepending older items must not move what the reader is looking at: restore the distance from
  // the bottom captured before the prepend. Only runs `some` when the head actually changed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const firstId = items[0]?.id ?? null;
    const previous = anchor.current;
    if (previous.firstId && firstId !== previous.firstId && items.some((item) => item.id === previous.firstId)) {
      el.scrollTop = Math.max(0, el.scrollHeight - previous.fromBottom);
    }
    anchor.current = { firstId, fromBottom: el.scrollHeight - el.scrollTop };
  }, [items]);

  // Near the top of a paged transcript, fetch the previous page automatically (the desktop loads
  // the whole file at once, so this only runs in a web shell with `transcriptStart > 0`).
  const earlierBusy = useRef(false);
  const lastAutoLoad = useRef(0);
  useEffect(() => {
    if (!loaded || transcriptStart <= 0 || scrollTop > 160 || earlierBusy.current) return;
    if (Date.now() - lastAutoLoad.current < 500) return;
    lastAutoLoad.current = Date.now();
    earlierBusy.current = true;
    void loadEarlier(session.id).finally(() => {
      earlierBusy.current = false;
    });
  }, [loaded, transcriptStart, scrollTop, loadEarlier, session.id]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    anchor.current = { firstId: items[0]?.id ?? null, fromBottom: el.scrollHeight - el.scrollTop };
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    if (typeof requestAnimationFrame !== 'function') {
      setScrollTop(el.scrollTop);
      return;
    }
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      setScrollTop(ref.current?.scrollTop ?? 0);
    });
  };
  useEffect(
    () => () => {
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    },
    []
  );

  // Jump-to-match from the deep search modal: scroll to the item and flash it. Waits for the
  // transcript to load when the session was not the active one.
  useEffect(() => {
    if (!jump || jump.sessionId !== session.id || !loaded || !ref.current) return;
    const el = ref.current.querySelector(`[data-item-id="${CSS.escape(jump.itemId)}"]`);
    const consume = () => useStore.setState((s) => s.searchJump === jump ? { searchJump: null } : {});
    if (!el) {
      consume();
      return;
    }
    setStick(false);
    el.scrollIntoView({ block: 'center' });
    el.classList.add('search-jump-hl');
    const t = setTimeout(() => {
      el.classList.remove('search-jump-hl');
      // Keep the reached viewport when rows outside it are unmounted again.
      setScrollTop(ref.current?.scrollTop ?? 0);
      consume();
    }, 2400);
    return () => {
      clearTimeout(t);
      el.classList.remove('search-jump-hl');
    };
  }, [jump, loaded, session.id]);

  // Your message for the stretch being read floats at the top once it scrolls away. Row offsets
  // cover unmounted rows too, so this works the same with windowing on.
  // Mission rows are written by the app, not by you, so they never become the pinned prompt.
  const userChunks = useMemo(() => chunks.flatMap((c, i) => (c.kind === 'single' && c.item.kind === 'user' && c.item.origin !== 'mission' ? [i] : [])), [chunks]);
  const [pinned, setPinned] = useState(-1);
  const rowBase = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !userChunks.length) return setPinned(-1);
    const first = el.querySelector<HTMLElement>(':scope > .transcript-row');
    if (first) rowBase.current = first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - tops[range.start]!;
    setPinned(pinnedPromptIndex(userChunks, tops, rowBase.current, el.scrollTop));
  });
  const pinnedChunk = chunks[pinned];
  const pinnedItem = pinnedChunk?.kind === 'single' && pinnedChunk.item.kind === 'user' ? pinnedChunk.item : null;

  /** Jump target: scrolled to by its offset first, then aligned exactly once its row is mounted. */
  const [promptJump, setPromptJump] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const jumpToPrompt = (index: number) => {
    const el = ref.current;
    const chunk = chunks[index];
    if (!el || chunk?.kind !== 'single') return;
    setStick(false);
    el.scrollTop = Math.max(0, rowBase.current + tops[index]! - PROMPT_JUMP_MARGIN);
    setScrollTop(el.scrollTop);
    setPromptJump(chunk.item.id);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!promptJump || !el) return;
    const row = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(promptJump)}"]`);
    if (!row) {
      // Windowing mounts the row on the next scroll frame; without windowing it is simply gone.
      if (!virtual) setPromptJump(null);
      return;
    }
    setPromptJump(null);
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - PROMPT_JUMP_MARGIN;
    setScrollTop(el.scrollTop);
    const target = row.querySelector<HTMLElement>('.msg-bubble') ?? row;
    target.classList.remove('prompt-jump-hl');
    void target.offsetWidth; // restart the flash when the same message is reached twice
    target.classList.add('prompt-jump-hl');
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => target.classList.remove('prompt-jump-hl'), 1600);
  });

  const pendingApprovals = useMemo(() => items.filter((i) => i.kind === 'approval' && !i.decision).length, [items]);
  // Count what arrived since the reader left the bottom; switching sessions in this pane starts over.
  // Anchored on the last item seen rather than a length, so `loadEarlier` prepending a page of
  // history does not read as new arrivals.
  useEffect(() => setUnseenAfter(stick ? null : (id) => id ?? items[items.length - 1]?.id ?? null), [stick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setUnseenAfter(null), [session.id]);
  const unseen = useMemo(() => {
    if (unseenAfter === null) return 0;
    const at = items.findIndex((i) => i.id === unseenAfter);
    return at < 0 ? 0 : items.length - 1 - at;
  }, [items, unseenAfter]);

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      useStore.getState().toast(`${what} copied`, 'success');
    } catch {
      useStore.getState().toast(`Could not copy the ${what.toLowerCase()}`, 'error');
    }
  };

  /**
   * Right-click menu for the transcript. A text field or the terminal keeps its own menu, and a
   * click on a message offers that message's text even when nothing is selected.
   */
  const onContextMenu = (e: React.MouseEvent) => {
    if (isEditableTarget(e.target) || isTerminalEventTarget(e.target)) return;
    const selection = window.getSelection()?.toString() ?? '';
    const block = e.target instanceof Element ? e.target.closest<HTMLElement>('.msg, .tool-card, .info-line, .mission-card') : null;
    // A message's own body, not its meta row: the timestamp and the action buttons are chrome.
    const body = block?.querySelector<HTMLElement>('.msg-text, .md, .info-text') ?? block;
    const blockText = body ? (body.innerText ?? body.textContent ?? '').trim() : '';
    const menuItems: ContextMenuItem[] = [];
    if (selection.trim()) menuItems.push({ label: 'Copy selection', icon: 'copy', hint: 'Ctrl+C', onSelect: () => void copyText(selection, 'Selection') });
    if (blockText) menuItems.push({ label: 'Copy message', icon: 'copy', onSelect: () => void copyText(blockText, 'Message') });
    menuItems.push(
      { separator: true },
      { label: 'Find in transcript', icon: 'search', hint: 'Ctrl+F', onSelect: () => setFindOpen(true) },
      { label: 'Jump to latest', icon: 'chevron', disabled: stick, onSelect: () => { setStick(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; } },
      { separator: true },
      {
        label: 'Export transcript…',
        icon: 'download',
        onSelect: () =>
          void invoke('sessions:export', { id: session.id })
            .then((r) => r.path && useStore.getState().toast(`Exported to ${r.path}`, 'success'))
            .catch((err) => useStore.getState().toast(err instanceof Error ? err.message : String(err), 'error'))
      }
    );
    showContextMenu(e, menuItems);
  };

  return (
    <div className="transcript-wrap">
      <TranscriptSessionContext.Provider value={sessionCtx}>
        <div className={`transcript ${virtual ? 'virtual' : ''} ${caps.openFile ? '' : 'no-file-links'}`} ref={ref} onScroll={onScroll} onContextMenu={caps.contextMenu ? onContextMenu : undefined}>
          {!loaded && !transcriptError && <div className="transcript-loading"><Spinner /> Loading…</div>}
          {!loaded && transcriptError && (
            <div className="transcript-error callout warn" role="alert">
              <div>Could not load this transcript.</div>
              <div className="muted small">{transcriptError}</div>
              <Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadTranscript(session.id)}>
                Retry
              </Button>
            </div>
          )}
          {loaded && items.length === 0 && (
            <div className="transcript-empty">
              <Icon name="sparkles" size={28} />
              <p>Send a message to start. Type <code>/</code> for commands, <code>@</code> to mention files, paste images to attach them.</p>
            </div>
          )}
          {virtual && range.start > 0 && <div className="transcript-spacer" style={{ height: tops[range.start] }} aria-hidden />}
          {caps.header}
          {loaded && transcriptStart > 0 && (
            <div className="transcript-more">
              <Button size="sm" variant="ghost" icon="chevron" onClick={() => void loadEarlier(session.id)}>
                Load earlier
              </Button>
            </div>
          )}
          {visible.map((chunk) => (
            <TranscriptRow key={chunkKey(chunk)} chunk={chunk} sessionId={session.id} canEdit={canEdit} showThinking={showThinking} onImageExpand={onImageExpand} measureRow={measureRow} live={chunk.kind === 'work' && chunk.id === liveWorkId} />
          ))}
          {virtual && range.end < chunks.length && <div className="transcript-spacer" style={{ height: tops[chunks.length]! - tops[range.end]! }} aria-hidden />}
          {(session.status === 'running' || session.status === 'starting') && (
            <div className="working">
              <Spinner size={12} /> {session.status === 'starting' ? session.statusDetail ?? 'Starting…' : 'Working…'}
            </div>
          )}
          <OngoingActivityStrip session={session} />
        </div>
      </TranscriptSessionContext.Provider>
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
      {pinnedItem && <PinnedPrompt key={pinnedItem.id} item={pinnedItem} onJump={() => jumpToPrompt(pinned)} />}
      <TranscriptFind open={findOpen} onClose={() => setFindOpen(false)} container={ref} revision={chunks} />
      {!stick && (
        <button type="button" className="jump-bottom" onClick={() => { setStick(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }}>
          <Icon name="chevron" size={14} /> {pendingApprovals ? `${pendingApprovals} approval pending` : unseen ? `${unseen} new · Jump to latest` : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}
