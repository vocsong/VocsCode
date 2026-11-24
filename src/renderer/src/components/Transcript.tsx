import React, { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalRequest, FileChange, SessionMeta, TranscriptItem } from '../../../shared/types';
import { parseGitHubPullRequestUrl } from '../../../shared/github-pull-request';
import { imageMimeType } from '../../../shared/image-files';
import { invoke, isWeb, platform } from '../api';
import { fileManagerName, fileScope } from '../file-open';
import { workspaceRelativePath } from '../file-refs';
import { useCanInvoke, useTranscriptCapabilities } from '../capabilities';
import { fmtCost, fmtDuration, fmtRate, fmtStamp, fmtStampFull, fmtTokens } from '../format';
import { installMarkdownHandlers } from '../markdown';
import { useStore } from '../store';
import { MISSION_MANAGED_REASON } from '../missions';
import { chunkKey, estimateChunkHeight, windowRange, type RenderChunk } from '../transcript-window';
import { useStreamingMarkdown } from '../use-streaming-markdown';
import { validateQuestionResponse } from '../../../shared/question-response';
import { useMarkdownImages } from '../use-markdown-images';
import { isEditableTarget, showContextMenu, type ContextMenuItem } from './ContextMenu';
import { DiffView } from './DiffView';
import { ImageLightbox, type LightboxImage } from './ImageLightbox';
import { HarnessPill } from './SessionTitle';
import { TranscriptFind } from './TranscriptFind';
import { askConfirm, Badge, Button, Icon, Spinner } from './ui';
import { MissionCompletion } from './mission/MissionCompletion';
import { OngoingActivityStrip } from './OngoingActivityStrip';
import './transcript-links.css';

interface ImageLightboxState {
  images: LightboxImage[];
  index: number;
}

export type OnImageExpand = (images: LightboxImage[], index: number) => void;

/** Terminal key events are handled by the terminal find bar, not the transcript finder. */
export function isTerminalEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.term, .term-view');
}

/** Data-URL rendering for a transcript image attachment. */
export function imageSrc(im: { mimeType: string; data: string }): string {
  return `data:${im.mimeType};base64,${im.data}`;
}

/** Stable fallback so zustand selectors never return a fresh array (React #185 infinite loop). */
const EMPTY: never[] = [];

/** Below this many chunks the reconciliation cost is small enough to skip windowing entirely. */
const VIRTUALIZE_MIN = 150;

/** Space left above a message the pinned prompt jumps to, so it lands just under the top edge. */
const PROMPT_JUMP_MARGIN = 12;

/**
 * Which of your messages the pinned prompt shows: the one whose stretch of the transcript is at
 * the top of the viewport, once that message itself has scrolled out of view. While any of it is
 * still on screen there is nothing to pin, so jumping to a message makes the bar give way to it.
 * Offsets are content coordinates: `base` is where the first row starts, `tops` the row offsets.
 */
function pinnedPromptIndex(userChunks: number[], tops: number[], base: number, scrollTop: number): number {
  let at = -1;
  for (const i of userChunks) {
    if (base + tops[i]! > scrollTop + PROMPT_JUMP_MARGIN + 4) break;
    at = i;
  }
  if (at < 0) return -1;
  return base + tops[at + 1]! <= scrollTop + 24 ? at : -1;
}

function canOpenTranscriptPullRequest(session: SessionMeta | undefined, activeId: string | null): boolean {
  return !isWeb && !!session && !session.mission && session.id === activeId;
}

/** Mirrors revealFile's routing without reading or resolving files ahead of a click. */
function transcriptFileKind(path: string, root: string, canRevealOutside: boolean) {
  const target = path.trim();
  if (!target || /^[\\/]{2}/.test(target)) return;
  const relative = workspaceRelativePath(root, target);
  if (relative === null) {
    const drivePath = /^[A-Za-z]:[\\/]/.test(target);
    const local = platform === 'win32' ? drivePath : target.startsWith('/') || (platform === 'unknown' && drivePath);
    if (canRevealOutside && local) return 'explorer';
    return;
  }
  if (relative === '' || /[\\/]$/.test(target)) return 'folder';
  return imageMimeType(relative) ? 'image-file' : 'file';
}

/** `active` is false for a split pane the user is not working in: it keeps streaming, but window-wide keys skip it. */
export function Transcript({ session, active = true }: { session: SessionMeta; active?: boolean }) {
  const items = useStore((s) => s.transcripts[session.id] ?? EMPTY);
  const mission = useStore((s) => session.mission?.role === 'lead' ? s.missions[session.mission.missionId] : undefined);
  const loaded = useStore((s) => s.loaded[session.id]);
  const transcriptError = useStore((s) => s.transcriptErrors[session.id]);
  const loadTranscript = useStore((s) => s.loadTranscript);
  const loadEarlier = useStore((s) => s.loadEarlier);
  // A paged transcript's first item index; zero on the desktop, where the whole file is loaded.
  const transcriptStart = useStore((s) => s.transcriptStarts[session.id] ?? 0);
  const showThinking = useStore((s) => s.showThinking);
  const jump = useStore((s) => s.searchJump);
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
  const canEdit = caps.editAndResend && !session.mission && session.config.harness === 'native' && session.status === 'idle';

  const chunks = useMemo(() => {
    const grouped = groupTranscript(items, showThinking);
    if (mission?.status !== 'completed' || !mission.completionReport) return grouped;
    // Completion precedes later answer-only questions. Do not append it after each new answer
    // or forge an assistant item; this host projection has its own measured virtual-list row.
    const nextQuestion = grouped.findIndex((chunk) => chunk.kind === 'single' && chunk.item.kind === 'user' && chunk.item.ts > mission.completionReport!.completedAt);
    grouped.splice(nextQuestion < 0 ? grouped.length : nextQuestion, 0, { kind: 'mission-completion', record: mission });
    return grouped;
  }, [items, mission, showThinking]);
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
  }, [items, session.ongoing, mission?.completionReport, stick, findOpen, jumpHere, measureVersion]);

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
  const userChunks = useMemo(() => chunks.flatMap((c, i) => (c.kind === 'single' && c.item.kind === 'user' ? [i] : [])), [chunks]);
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
    const block = e.target instanceof Element ? e.target.closest<HTMLElement>('.msg, .tool-card, .info-line') : null;
    // A message's own body, not its meta row: the timestamp and the action buttons are chrome.
    const body = block?.querySelector<HTMLElement>('.msg-text, .md, .info-text') ?? block;
    const blockText = body ? (body.innerText ?? body.textContent ?? '').trim() : '';
    const items: ContextMenuItem[] = [];
    if (selection.trim()) items.push({ label: 'Copy selection', icon: 'copy', hint: 'Ctrl+C', onSelect: () => void copyText(selection, 'Selection') });
    if (blockText) items.push({ label: 'Copy message', icon: 'copy', onSelect: () => void copyText(blockText, 'Message') });
    items.push(
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
    showContextMenu(e, items);
  };

  return (
    <div className="transcript-wrap">
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
        {loaded && items.length === 0 && !mission?.completionReport && (
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

/** Your message for the part of the transcript on screen, floating at the top; a click goes back to it. */
function PinnedPrompt({ item, onJump }: { item: Extract<TranscriptItem, { kind: 'user' }>; onJump: () => void }) {
  const text = item.text.trim() || (item.images?.length ? (item.images.length === 1 ? 'Image' : `${item.images.length} images`) : 'Attachment');
  const time = new Date(item.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return (
    <button type="button" className="pinned-prompt" onClick={onJump} title="Go to this message" aria-label={`Go to your message: ${text}`}>
      <span className="pinned-prompt-text">{text}</span>
      <span className="pinned-prompt-meta">
        <time dateTime={new Date(item.ts).toISOString()}>{time}</time>
        <Icon name="arrowUp" size={12} />
      </span>
    </button>
  );
}

/**
 * When a message, step or thought happened. Standard shows it quietly on every row; Zen keeps it
 * out of sight until the row is pointed at (ui-zen.css). The tooltip carries the full date to the
 * second, plus whatever `detail` the row adds (how long a step took, when an approval was answered).
 */
export function Stamp({ ts, className = '', detail }: { ts: number; className?: string; detail?: string }) {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const full = fmtStampFull(ts);
  return (
    <time className={`stamp ${className}`} dateTime={new Date(ts).toISOString()} title={detail ? `${full} · ${detail}` : full}>
      {fmtStamp(ts)}
    </time>
  );
}

/** One transcript row; `dataItemId` anchors deep-search jumps to the exact item. */
const Item = memo(function Item({ item, sessionId, canEdit, showThinking, onImageExpand, dataItemId }: { item: TranscriptItem; sessionId: string; canEdit: boolean; showThinking: boolean; onImageExpand: OnImageExpand; dataItemId?: string }) {
  return (
    <div data-item-id={dataItemId}>
      {renderItem(item, sessionId, canEdit, showThinking, onImageExpand)}
    </div>
  );
});

/**
 * Measured wrapper around one chunk. When windowing is off it is a plain row; when on, its
 * height feeds the offset table so off-screen chunks can stay unmounted.
 */
const TranscriptRow = memo(function TranscriptRow({
  chunk,
  sessionId,
  canEdit,
  showThinking,
  onImageExpand,
  measureRow,
  live = false
}: {
  chunk: RenderChunk;
  sessionId: string;
  canEdit: boolean;
  showThinking: boolean;
  onImageExpand: OnImageExpand;
  measureRow: (key: string, el: HTMLElement) => () => void;
  live?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const key = chunkKey(chunk);
  useEffect(() => {
    const el = ref.current;
    return el ? measureRow(key, el) : undefined;
  }, [key, measureRow]);
  return (
    <div className="transcript-row" ref={ref}>
      {chunk.kind === 'mission-completion' ? (
        <MissionCompletion record={chunk.record} />
      ) : chunk.kind === 'work' ? (
        <WorkGroup chunk={chunk} sessionId={sessionId} canEdit={canEdit} showThinking={showThinking} onImageExpand={onImageExpand} live={live} />
      ) : chunk.kind === 'group' ? (
        <ToolGroup entries={chunk.entries} sessionId={sessionId} canEdit={canEdit} showThinking={showThinking} onImageExpand={onImageExpand} />
      ) : (
        <Item item={chunk.item} sessionId={sessionId} canEdit={canEdit} showThinking={showThinking} onImageExpand={onImageExpand} dataItemId={chunk.item.id} />
      )}
    </div>
  );
}, (a, b) => a.sessionId === b.sessionId && a.canEdit === b.canEdit && a.showThinking === b.showThinking && a.live === b.live &&
  a.onImageExpand === b.onImageExpand && a.measureRow === b.measureRow && sameChunk(a.chunk, b.chunk));

/** Grouping recreates wrappers; unchanged constituent items still have stable store identities. */
function sameChunk(a: RenderChunk, b: RenderChunk): boolean {
  if (a.kind === 'mission-completion' && b.kind === 'mission-completion') return a.record === b.record;
  if (a.kind === 'single' && b.kind === 'single') return a.item === b.item;
  if (a.kind === 'group' && b.kind === 'group') return a.id === b.id && sameEntries(a.entries, b.entries);
  return a.kind === 'work' && b.kind === 'work' && a.id === b.id && sameEntries(a.entries, b.entries) &&
    a.turn?.status === b.turn?.status && a.turn?.durationMs === b.turn?.durationMs;
}

function sameEntries(a: TranscriptItem[], b: TranscriptItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function renderItem(item: TranscriptItem, sessionId: string, canEdit: boolean, showThinking: boolean, onImageExpand: OnImageExpand) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} sessionId={sessionId} canEdit={canEdit} onImageExpand={onImageExpand} />;
    case 'assistant':
      return <AssistantMessage item={item} sessionId={sessionId} showThinking={showThinking} onImageExpand={onImageExpand} />;
    case 'tool':
      return <ToolCard item={item} sessionId={sessionId} />;
    case 'approval':
      return <ApprovalCard item={item} sessionId={sessionId} />;
    case 'info':
      return (
        <div className={`info-line info-${item.level}`}>
          {item.pending ? <Spinner size={13} /> : <Icon name={item.level === 'error' ? 'alert' : item.level === 'warn' ? 'alert' : 'info'} size={13} />} <span className="info-text">{item.text}</span>
          <Stamp ts={item.ts} className="info-time" />
        </div>
      );
    case 'turn':
      return (
        <div className={`turn-footer turn-${item.status}`}>
          <Icon name={item.status === 'completed' ? 'check' : 'alert'} size={12} />
          <span className="turn-label">{item.status === 'completed' ? 'Turn complete' : item.status === 'interrupted' ? 'Interrupted' : `Failed${item.error ? `: ${item.error}` : ''}`}</span>
          <span className="turn-time">· <time dateTime={new Date(item.ts).toISOString()} title={new Date(item.ts).toLocaleString()}>{new Date(item.ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time></span>
          {item.durationMs ? <span className="turn-duration">· {fmtDuration(item.durationMs)}</span> : null}
          {item.costUsd ? <span className="turn-cost">· {fmtCost(item.costUsd)}</span> : null}
          {/* Token detail is for the curious: it shows when the row is hovered. */}
          {item.usage && (item.usage.inputTokens || item.usage.outputTokens) ? <span className="turn-detail">· {fmtTokens(item.usage.inputTokens)} in / {fmtTokens(item.usage.outputTokens)} out</span> : null}
          {item.status === 'completed' && fmtRate(item.usage?.outputTokens, item.durationMs) ? (
            <span className="turn-detail" title="Output tokens per second of turn wall time (includes tool execution)">· {fmtRate(item.usage?.outputTokens, item.durationMs)}</span>
          ) : null}
        </div>
      );
    case 'plan':
      return <PlanCard item={item} />;
    default:
      return null;
  }
}

/** A plan as a checklist: done steps stay readable (no strike-through), the live one is marked. */
function PlanCard({ item }: { item: Extract<TranscriptItem, { kind: 'plan' }> }) {
  const done = item.entries.filter((e) => e.status === 'completed').length;
  const total = item.entries.length;
  return (
    <div className="plan-card">
      <div className="plan-title">
        <Icon name="list" size={13} /> Plan
        {total > 0 && <span className="plan-progress">{done} of {total} done</span>}
        {total > 0 && (
          <span className="plan-bar" aria-hidden>
            <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
          </span>
        )}
        <Stamp ts={item.ts} className="plan-time" />
      </div>
      <ul>
        {item.entries.map((e, i) => (
          <li key={i} className={`plan-${e.status}`}>
            <span className="plan-check" aria-label={e.status.replace('_', ' ')}>
              {e.status === 'completed' ? <Icon name="check" size={11} /> : e.status === 'in_progress' ? <span className="plan-live" /> : null}
            </span>
            <span className="plan-text">{e.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UserMessage({ item, sessionId, canEdit = true, onImageExpand }: { item: Extract<TranscriptItem, { kind: 'user' }>; sessionId?: string; canEdit?: boolean; onImageExpand?: OnImageExpand }) {
  const managed = useStore((s) => !!s.sessions.find((session) => session.id === sessionId)?.mission);
  const images = item.images ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [rerunning, setRerunning] = useState(false);
  const toast = useStore((s) => s.toast);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.text);
      toast('Message copied', 'success');
    } catch {
      toast('Could not copy message', 'error');
    }
  };

  const rerun = async () => {
    const text = draft.trim();
    if (!text && !images.length && !item.files?.length) return;
    if (!sessionId || managed) return;
    const confirmed = await askConfirm({
      title: 'Edit and rerun this message?',
      body: 'All transcript items after this message will be discarded. Files changed by those turns are not rolled back.',
      confirmLabel: 'Rerun message',
      danger: true
    });
    if (!confirmed) return;
    setRerunning(true);
    try {
      const items = await invoke('sessions:editAndResend', { id: sessionId, userItemId: item.id, input: { text, images: images.length ? images : undefined, mode: 'now' } });
      useStore.getState().replaceTranscript(sessionId, items);
      setEditing(false);
      toast('Message rerun from here', 'success');
    } catch (e) {
      toast((e as Error).message || 'Could not rerun message', 'error');
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div className="msg msg-user">
      <div className="msg-bubble">
        {item.queuedAs && item.queuedAs !== 'now' && <Badge tone="blue">{item.queuedAs}</Badge>}
        {editing ? (
          <div className="msg-edit">
            <textarea aria-label="Edit message" value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.max(2, Math.min(8, draft.split('\n').length))} autoFocus />
            <div className="msg-edit-actions">
              <Button size="sm" onClick={() => { setDraft(item.text); setEditing(false); }} disabled={rerunning}>Cancel</Button>
              <Button size="sm" variant="primary" icon="refresh" onClick={() => void rerun()} disabled={rerunning || (!draft.trim() && !images.length && !item.files?.length)}>{rerunning ? 'Rerunning…' : 'Save & rerun'}</Button>
            </div>
          </div>
        ) : (
          <div className="msg-text">{item.text}</div>
        )}
        {images.length ? (
          <div className="msg-images">
            {images.map((im, i) =>
              onImageExpand ? (
                <button
                  key={i}
                  type="button"
                  className="msg-image-btn"
                  aria-label={`Preview ${im.name ?? 'image'}`}
                  onClick={() => onImageExpand(images.map((att) => ({ src: imageSrc(att), name: att.name })), i)}
                >
                  <img src={imageSrc(im)} alt={im.name ?? 'attachment'} draggable={false} />
                </button>
              ) : (
                <img key={i} src={imageSrc(im)} alt={im.name ?? 'attachment'} />
              )
            )}
          </div>
        ) : null}
        {item.files?.length ? <div className="msg-files" aria-label="Attached files">{item.files.map((file) => <Badge key={file.path} tone="neutral">{file.name}</Badge>)}</div> : null}
        {!images.length && item.imagesOmitted ? (
          <Badge tone="neutral" title="Images are too large to send to a paired browser">
            {item.imagesOmitted === 1 ? '1 image not shown' : `${item.imagesOmitted} images not shown`}
          </Badge>
        ) : null}
      </div>
      <div className="msg-user-meta">
        <Stamp ts={item.ts} />
        <button type="button" className="msg-action" title="Copy message" aria-label="Copy message" onClick={() => void copy()}><Icon name="copy" size={14} /></button>
        {sessionId && (canEdit || managed) && <button type="button" className="msg-action" title={managed ? MISSION_MANAGED_REASON : 'Edit and rerun message'} aria-label={managed ? 'Rewind unavailable for Mission' : 'Edit and rerun message'} onClick={() => !managed && setEditing(true)} disabled={rerunning || managed}><Icon name="edit" size={14} /></button>}
      </div>
    </div>
  );
}

function AssistantMessage({ item, sessionId, showThinking, onImageExpand }: { item: Extract<TranscriptItem, { kind: 'assistant' }>; sessionId: string; showThinking: boolean; onImageExpand: OnImageExpand }) {
  // open === null means the user has not toggled; then reasoning shows only while it is being written.
  const [open, setOpen] = useState<boolean | null>(null);
  const html = useStreamingMarkdown(item.text, item.streaming);
  // React must leave the hydrated DOM alone when only the active pane or link capability changes.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === sessionId));
  const mission = useStore((s) => session?.mission ? s.missions[session.mission.missionId] : undefined);
  const canOpenPr = useStore((s) => canOpenTranscriptPullRequest(session, s.activeId));
  const { openFile } = useTranscriptCapabilities();
  const canRevealOutside = useCanInvoke('app:showInFolder');
  const root = !isWeb && openFile && session ? fileScope(session, mission).root : undefined;
  const cwd = session?.cwd;
  const body = useMarkdownImages(html, sessionId, cwd, onImageExpand);
  useLayoutEffect(() => {
    // Use only the sanitized targets, not labels or Markdown-supplied link-kind attributes.
    // Reclassify cached HTML in place when the session or capability changes.
    for (const el of body.current?.querySelectorAll<HTMLElement>('a[href], [data-file]') ?? []) {
      const path = el.getAttribute('data-file');
      const href = el.getAttribute('href');
      const kind = path && root !== undefined ? transcriptFileKind(path, root, canRevealOutside)
        : path === null && href && /^https?:\/\//i.test(href) ? (canOpenPr && parseGitHubPullRequestUrl(href) ? 'pr' : 'external')
        : undefined;
      if (kind) el.dataset.linkKind = kind;
      else delete el.dataset.linkKind;
      if (path && el.classList.contains('file-ref')) {
        if (kind) {
          el.setAttribute('role', 'link');
          el.tabIndex = 0;
          const line = el.getAttribute('data-line');
          el.title = kind === 'explorer' ? `Show ${path} in ${fileManagerName()}`
            : kind === 'folder' ? `Show ${path} in the Files panel`
            : `Preview ${path}${line ? ` at line ${line}` : ''}`;
        } else {
          el.removeAttribute('role');
          el.removeAttribute('tabindex');
          el.removeAttribute('title');
        }
      }
    }
  }, [body, markup, cwd, root, canOpenPr, canRevealOutside]);
  // A deep-search jump into a row that is only reasoning matched that reasoning: show it.
  const jumpHere = useStore((s) => !!s.searchJump && s.searchJump.sessionId === sessionId && s.searchJump.itemId === item.id);
  const proseless = !item.text;
  useEffect(() => { if (jumpHere && proseless) setOpen(true); }, [jumpHere, proseless]);
  // With thinking hidden a thinking-only item has nothing left to show; rendering it anyway would
  // leave an empty row in the transcript.
  if (!item.text && !(item.thinking && showThinking)) return null;
  // Reasoning is the same control wherever a harness puts it — on a message's row or a row of its
  // own: open while it streams with no prose yet, one collapsed toggle once it is done.
  const thinkingLive = !item.text && !!item.thinking && !!item.streaming;
  const expanded = open ?? thinkingLive;
  return (
    <div className={`msg msg-assistant ${item.phase === 'plan' ? 'msg-plan' : ''}`}>
      {/* One time per row, floated into the right-hand column the step times share, so it costs no
          height: on the reasoning toggle's line when there is one, else beside the first line of prose. */}
      <Stamp ts={item.ts} className="msg-stamp" />
      {item.thinking && showThinking && (
        <div className={`thinking ${expanded ? 'open' : ''}`}>
          <button type="button" className="thinking-toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
            <Icon name="brain" size={13} /> {thinkingLive ? 'Thinking…' : 'Thinking'} <Icon name={expanded ? 'chevron' : 'chevronRight'} size={12} />
          </button>
          {expanded && <div className="thinking-body">{item.thinking}</div>}
        </div>
      )}
      {item.text && <div key={`${sessionId}:${cwd}`} ref={body} className={`md ${item.streaming ? 'streaming' : ''}`} dangerouslySetInnerHTML={markup} />}
      {item.phase === 'plan' && <Badge tone="purple">plan</Badge>}
    </div>
  );
}

const HINT_ICON: Record<string, string> = { execute: 'terminal', edit: 'edit', read: 'file', search: 'search', fetch: 'external', think: 'brain', mcp: 'bolt', agent: 'fork', other: 'bolt' };

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

export const isRunningEntry = (item: TranscriptItem): boolean =>
  (item.kind === 'tool' && item.status === 'running') || (item.kind === 'assistant' && !!item.streaming);

/** An assistant row that carries no prose: reasoning only, or a stream that has not produced text yet. */
const isThinkingOnly = (item: TranscriptItem): boolean => item.kind === 'assistant' && item.text.trim() === '';

/** A step the agent took, as opposed to a line that merely sits beside the steps. */
const isStep = (item: TranscriptItem): boolean => item.kind === 'tool' || item.kind === 'approval' || item.kind === 'plan';

/**
 * Whether an item is machinery (it may collapse behind a work header) rather than something
 * written for the reader. Everything the model says in prose is a message and stays on screen,
 * whatever phase the harness gave it and whether or not more tool calls follow: only tool calls,
 * reasoning with no prose, info-level notices, approvals and plans are work. Approvals keep their
 * header open while undecided; plans are work that `WorkGroup` keeps on screen as one card under
 * its header, so a plan update does not split a stretch of work in two.
 */
export function isWorkItem(item: TranscriptItem): boolean {
  if (isStep(item)) return true;
  // Warnings and errors are signals, not work: they stay on screen when the group is collapsed.
  if (item.kind === 'info') return item.level === 'info';
  return isThinkingOnly(item);
}

/**
 * Collapses each stretch of steps between two messages into a `work` chunk, together with the
 * thinking and notices that sit among them, and keeps every message, warning and turn row
 * standalone. Harnesses differ in what they emit — some label prose as commentary or final, some
 * do not; some put reasoning on the message's own row, some on a row of its own — and none of
 * that changes what is shown, so a turn reads the same on all of them: message, work, message,
 * work, answer.
 *
 * A header needs a step behind it. Thinking or a notice with no step beside it stays a row of its
 * own (the same collapsed "Thinking" toggle a message carries; a one-line notice) instead of a
 * "Worked" header over nothing. With `showThinking` off a thinking-only row has nothing to render,
 * so it makes no row at all.
 */
export function groupTranscript(items: TranscriptItem[], showThinking = true): RenderChunk[] {
  const chunks: RenderChunk[] = [];
  let work: TranscriptItem[] = [];
  /** Where the current turn's chunks begin: just past the last user or turn row. */
  let turnStart = 0;
  const flush = (closedBy?: TranscriptItem) => {
    if (!work.length) return;
    // Reasoning that leads straight into a message belongs with that message, not with the steps
    // before it: a harness that reasons on a row of its own then reads like one that reasons on
    // the message's row. Until the message arrives it stays with the live work.
    let end = work.length;
    if (closedBy?.kind === 'assistant') while (end > 0 && isThinkingOnly(work[end - 1]!)) end--;
    const entries = work.slice(0, end);
    if (entries.some(isStep)) chunks.push({ kind: 'work', id: entries[0]!.id, entries });
    else end = 0;
    for (const item of work.slice(end)) chunks.push({ kind: 'single', item });
    work = [];
  };
  /**
   * A turn's duration belongs on a work header only when that header stands for the whole turn's
   * work. With several stretches of work in one turn no single header can claim it, and the turn
   * row carries it instead.
   */
  const attachTurn = (turn: Extract<TranscriptItem, { kind: 'turn' }>) => {
    const stretches = chunks.slice(turnStart).filter((c): c is Extract<RenderChunk, { kind: 'work' }> => c.kind === 'work');
    if (stretches.length === 1) stretches[0]!.turn = { status: turn.status, durationMs: turn.durationMs };
  };
  for (const item of items) {
    if (item.kind === 'assistant' && isThinkingOnly(item) && !(showThinking && item.thinking)) continue;
    if (isWorkItem(item)) {
      work.push(item);
      continue;
    }
    flush(item);
    if (item.kind === 'turn') attachTurn(item);
    chunks.push({ kind: 'single', item });
    if (item.kind === 'turn' || item.kind === 'user') turnStart = chunks.length;
  }
  flush();
  return chunks;
}

/** One row of a work body: a collapsed command run, or a single entry of any kind. */
type CommandChunk = { kind: 'run'; id: string; entries: ToolItem[] } | { kind: 'single'; item: TranscriptItem };

/**
 * Consecutive shell commands become one "Ran n commands" row (per nesting parent); every other
 * entry keeps its own row. Thinking or a notice breaks a run: it belongs beside the commands, not inside.
 */
export function groupCommands(entries: TranscriptItem[]): CommandChunk[] {
  const isCmd = (item: TranscriptItem): item is ToolItem => item.kind === 'tool' && item.hint === 'execute';
  const chunks: CommandChunk[] = [];
  let run: ToolItem[] = [];
  let runParent: string | null = null;
  const flush = () => {
    if (run.length > 1) chunks.push({ kind: 'run', id: run[0]!.id, entries: run });
    else if (run.length === 1) chunks.push({ kind: 'single', item: run[0]! });
    run = [];
  };
  for (const item of entries) {
    if (isCmd(item)) {
      const parent = item.parentId ?? null;
      if (run.length && parent !== runParent) flush();
      if (!run.length) runParent = parent;
      run.push(item);
    } else {
      flush();
      chunks.push({ kind: 'single', item });
    }
  }
  flush();
  return chunks;
}

/** One stretch of work behind a "Worked …" header; the messages around it stay outside. */
export function WorkGroup({ chunk, sessionId, canEdit = false, showThinking, onImageExpand, live = false }: { chunk: Extract<RenderChunk, { kind: 'work' }>; sessionId: string; canEdit?: boolean; showThinking: boolean; onImageExpand: OnImageExpand; live?: boolean }) {
  // open === null means the user has not toggled; then follow the turn so live activity stays visible.
  const [open, setOpen] = useState<boolean | null>(null);
  // A deep-search jump into one of these entries forces the group open so the anchor exists.
  const jump = useStore((s) => s.searchJump);
  const jumpHere = !!jump && jump.sessionId === sessionId && chunk.entries.some((e) => e.id === jump.itemId);
  useEffect(() => { if (jumpHere) setOpen(true); }, [jumpHere]);
  const running = live || chunk.entries.some(isRunningEntry);
  // An undecided approval is a gate the user has to answer: it keeps the work open no matter what.
  const pendingApproval = chunk.entries.some((e) => e.kind === 'approval' && !e.decision);
  const expanded = pendingApproval || jumpHere || (open ?? running);
  const failed = chunk.entries.filter((e) => e.kind === 'tool' && (e.status === 'error' || e.status === 'declined')).length;
  const durationMs = chunk.turn?.durationMs;
  // Every plan update replaces the last one, so only the latest is shown — and it stays on screen
  // while the work around it is collapsed.
  const plan = [...chunk.entries].reverse().find((e): e is Extract<TranscriptItem, { kind: 'plan' }> => e.kind === 'plan');
  const entries = plan ? chunk.entries.filter((e) => e.kind !== 'plan') : chunk.entries;
  const tools = entries.filter((e): e is ToolItem => e.kind === 'tool');
  const files = new Set(tools.flatMap((t) => t.changes?.map((c) => c.path) ?? []));
  if (!entries.length) return plan ? <div className="work-group"><PlanCard item={plan} /></div> : null;
  return (
    <div className={`work-group ${running ? 'work-running' : ''} ${expanded ? 'work-open' : ''}`}>
      <button type="button" className="work-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <Icon name={running ? 'activity' : 'layers'} size={13} className="work-icon" />
        {/* data-short carries the same facts without the words, for the Zen interface. */}
        <span className="work-label" data-short={running ? '…' : durationMs ? fmtDuration(durationMs) : '✓'}>{running ? 'Working…' : durationMs ? `Worked for ${fmtDuration(durationMs)}` : 'Worked'}</span>
        {tools.length > 0 && <span className="work-stat work-steps" data-short={String(tools.length)}>{tools.length} step{tools.length === 1 ? '' : 's'}</span>}
        {files.size > 0 && <span className="work-stat work-files" data-short={`±${files.size}`}>{files.size} file{files.size === 1 ? '' : 's'} changed</span>}
        <Stamp ts={entries[0]!.ts} className="work-time" />
        {running ? <Spinner size={12} /> : null}
        {failed ? <Badge tone="red">{failed} failed</Badge> : null}
        <Icon name={expanded ? 'chevron' : 'chevronRight'} size={12} className="work-chevron" />
      </button>
      {plan && <PlanCard item={plan} />}
      {expanded && (
        <div className="work-body">
          {groupCommands(entries).map((c) =>
            c.kind === 'run' ? (
              <ToolGroup key={c.id} entries={c.entries} sessionId={sessionId} canEdit={canEdit} showThinking={showThinking} onImageExpand={onImageExpand} />
            ) : (
              <Item key={c.item.id} item={c.item} sessionId={sessionId} canEdit={canEdit} showThinking={showThinking} onImageExpand={onImageExpand} dataItemId={c.item.id} />
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Collapsed "Ran n commands" header for a run of shell commands. */
export function ToolGroup({ entries, sessionId, canEdit = false, showThinking, onImageExpand }: { entries: TranscriptItem[]; sessionId: string; canEdit?: boolean; showThinking: boolean; onImageExpand: OnImageExpand }) {
  // open === null means the user has not toggled; then follow running state so live output stays visible.
  const [open, setOpen] = useState<boolean | null>(null);
  // A deep-search jump into one of these commands forces the group open so the anchor exists.
  const jump = useStore((s) => s.searchJump);
  const jumpHere = !!jump && jump.sessionId === sessionId && entries.some((e) => e.id === jump.itemId);
  // Consuming the navigation request must not immediately hide its matched command.
  useEffect(() => { if (jumpHere) setOpen(true); }, [jumpHere]);
  const commands = entries.filter((e): e is ToolItem => e.kind === 'tool');
  const running = commands.some((i) => i.status === 'running');
  const expanded = jumpHere || (open ?? running);
  const failed = commands.filter((i) => i.status === 'error' || i.status === 'declined').length;
  const totalMs = commands.reduce((sum, i) => sum + (i.durationMs ?? 0), 0);
  return (
    <div className={`tool-group ${running ? 'tool-group-running' : ''}`}>
      <button type="button" className="tool-group-head" onClick={() => setOpen(!expanded)}>
        <span className="tool-glyph"><Icon name="terminal" size={13} className="tool-icon" /></span>
        <span className="tool-name">{running ? 'Running' : 'Ran'} {commands.length} command{commands.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        {failed ? <Badge tone="red">{failed} failed</Badge> : null}
        {running ? <Spinner size={12} /> : totalMs ? <span className="muted small">{fmtDuration(totalMs)}</span> : null}
        {commands[0] && <Stamp ts={commands[0].ts} className="tool-time" />}
        <Icon name={expanded ? 'chevron' : 'chevronRight'} size={12} />
      </button>
      {expanded && (
        <div className="tool-group-body">
          {entries.map((e) =>
            e.kind === 'tool' ? (
              <ToolCard key={e.id} item={e} sessionId={sessionId} dataItemId={e.id} />
            ) : (
              <Item key={e.id} item={e} sessionId={sessionId} canEdit={canEdit} showThinking={showThinking} onImageExpand={onImageExpand} dataItemId={e.id} />
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Status badge text for a tool row: an exit code says more than "error" when there is one. */
function toolStatus(item: ToolItem): string {
  if (item.exitCode !== undefined && item.exitCode !== null && (item.status === 'done' || item.status === 'error')) return `exit ${item.exitCode}`;
  return item.status === 'done' ? 'done' : item.status;
}

/** Lines added and removed across a tool call's diffs; null when it carried none. */
function diffStat(changes: FileChange[] | undefined): { add: number; del: number } | null {
  const diffs = changes?.filter((c) => c.diff) ?? [];
  if (!diffs.length) return null;
  let add = 0;
  let del = 0;
  for (const c of diffs) {
    for (const line of c.diff!.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) add++;
      else if (line.startsWith('-') && !line.startsWith('---')) del++;
    }
  }
  return { add, del };
}

function ToolCard({ item, sessionId, dataItemId }: { item: Extract<TranscriptItem, { kind: 'tool' }>; sessionId: string; dataItemId?: string }) {
  const [open, setOpen] = useState(false);
  const revealSubagentRun = useStore((s) => s.revealSubagentRun);
  const command = item.hint === 'execute';
  const running = item.status === 'running';
  const failed = item.status === 'error' || item.status === 'declined';
  const hasBody = !!item.output || !!(item.changes && item.changes.length) || item.input !== undefined;
  const statusTone = running ? 'blue' : item.status === 'error' ? 'red' : item.status === 'declined' ? 'amber' : 'green';
  // A running command streams its output into view; every other body waits for a click.
  const showBody = open || (running && command && !!item.output);
  const commandText = item.summary ?? (typeof item.input === 'string' ? item.input : '');
  const stat = diffStat(item.changes);
  return (
    <div data-item-id={dataItemId} className={`tool-card tool-${item.status} ${command ? 'tool-command' : ''} ${item.parentId ? 'tool-nested' : ''}`}>
      <button type="button" className="tool-head" onClick={() => hasBody && setOpen((o) => !o)}>
        <span className="tool-glyph"><Icon name={HINT_ICON[item.hint ?? 'other']} size={13} className="tool-icon" /></span>
        <span className="tool-name">{command ? (running ? 'Running' : 'Ran') : item.title ?? item.name}</span>
        {item.summary && <span className="tool-summary mono" title={item.summary}>{item.summary}</span>}
        <span className="spacer" />
        {stat ? (
          <span className="tool-changes diff-stat"><span className="add">+{stat.add}</span> <span className="del">−{stat.del}</span></span>
        ) : item.changes?.length ? <span className="tool-changes">{item.changes.length} file{item.changes.length === 1 ? '' : 's'}</span> : null}
        {/* Success is the expected outcome, so only a failure, a refusal or live work earns a badge. */}
        {running ? <Spinner size={12} /> : failed ? <Badge tone={statusTone}>{toolStatus(item)}</Badge> : null}
        {!command && item.durationMs ? <span className="muted small">{fmtDuration(item.durationMs)}</span> : null}
        {item.runId ? (
          <span
            className="chip"
            role="button"
            tabIndex={0}
            title="Open this run in the Subagents panel"
            onClick={(e) => {
              e.stopPropagation();
              revealSubagentRun(sessionId, item.runId!);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              revealSubagentRun(sessionId, item.runId!);
            }}
          >
            open run
          </span>
        ) : null}
        <Stamp ts={item.ts} className="tool-time" detail={item.durationMs ? `took ${fmtDuration(item.durationMs)}` : undefined} />
        {/* Held in place without a body too, so the times line up in one column down the steps. */}
        <Icon name={open ? 'chevron' : 'chevronRight'} size={12} className={hasBody ? undefined : 'tool-chevron-none'} />
      </button>
      {showBody && (
        <div className="tool-body">
          {command ? (
            <div className="shell-card">
              <div className="shell-bar">Shell</div>
              {commandText ? <pre className="shell-cmd mono"><span className="shell-prompt">$ </span>{commandText}</pre> : null}
              {item.output && <pre className="tool-output mono">{item.output.length > 12_000 && !open ? item.output.slice(-12_000) : item.output}</pre>}
              {open && (
                <div className={`shell-foot ${failed ? 'shell-foot-failed' : ''}`}>
                  <Icon name={failed ? 'alert' : 'check'} size={12} /> {toolStatus(item)}{item.durationMs ? ` · ${fmtDuration(item.durationMs)}` : ''}
                </div>
              )}
            </div>
          ) : (
            <>
              {open && item.input !== undefined && (
                <pre className="tool-input mono">{typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2).slice(0, 4000)}</pre>
              )}
              {item.changes?.some((c) => c.diff) && <DiffView diff={item.changes.filter((c) => c.diff).map((c) => c.diff!).join('\n')} compact />}
              {item.output && <pre className="tool-output mono">{item.output.length > 12_000 && !open ? item.output.slice(-12_000) : item.output}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({ item, sessionId }: { item: Extract<TranscriptItem, { kind: 'approval' }>; sessionId: string }) {
  const req = item.request;
  // A view-only or browser client cannot answer: it says where the decision has to be made.
  const canRespond = useCanInvoke('approvals:respond');
  const toast = useStore((s) => s.toast);
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [editedCommand, setEditedCommand] = useState<string | null>(null);
  const [responseState, setResponseState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => setValidationError(null), [answers, note]);
  const responding = useRef(false);
  const fieldId = useId();
  const decided = !!item.decision;
  const locked = decided || !canRespond || responseState !== 'idle';
  const questionComment = req.kind === 'question' && req.supportsQuestionComment !== false;
  const emptyQuestion = questionComment && !Object.values(answers).some((answer) => answer.trim()) && !note.trim();
  const noteLabel = req.kind === 'question' ? 'Additional context (optional)' : 'Note for the agent (sent with Deny only)';
  const decisionKind = req.options.find((o) => o.id === item.decision?.optionId)?.kind ?? item.decision?.optionId ?? '';
  const respond = (optionId: string) => {
    if (locked || responding.current) return;
    const option = req.options.find((o) => o.id === optionId);
    const sendsNote = questionComment || (req.kind !== 'question' && (option?.kind === 'deny' || option?.kind === 'deny_always'));
    const decision: ApprovalDecision = { optionId, note: sendsNote ? note.trim() || undefined : undefined };
    if (req.questions?.length) decision.answers = answers;
    if (editedCommand !== null && editedCommand !== req.command && req.input && typeof req.input === 'object') decision.updatedInput = { ...(req.input as Record<string, unknown>), command: editedCommand };
    try {
      validateQuestionResponse(req, decision);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
      return;
    }
    responding.current = true;
    setResponseState('sending');
    void invoke('approvals:respond', { sessionId, requestId: req.id, decision }).then(() => {
      // Keep the draft locked until the persisted decision arrives, not just until IPC resolves.
      setResponseState('sent');
    }).catch((e: unknown) => {
      responding.current = false;
      setResponseState('idle');
      toast(`Approval could not be sent: ${e instanceof Error ? e.message : String(e)}`, 'error');
    });
  };
  return (
    <div className={`approval ${decided ? 'decided' : 'pending'}`}>
      <div className="approval-head">
        <span className="approval-glyph"><Icon name="shield" size={14} /></span>
        <span className="approval-heading">
          <span className="approval-title">{req.title}</span>
          {req.description && <span className="approval-desc">{req.description}</span>}
        </span>
        <Stamp ts={item.ts} className="approval-time" detail={item.decidedAt ? `answered ${fmtStampFull(item.decidedAt)}` : undefined} />
        <HarnessPill harness={req.harness} />
        {decided && <Badge tone={/deny|reject|cancel/.test(decisionKind) ? 'red' : 'green'}>{labelFor(req, item.decision!.optionId)}</Badge>}
      </div>
      {req.command !== undefined && (
        decided ? (
          <pre className="approval-cmd mono">{req.command}</pre>
        ) : (
          <textarea className="approval-cmd mono editable" aria-label="Command" disabled={locked} value={editedCommand ?? req.command} onChange={(e) => setEditedCommand(e.target.value)} rows={Math.min(6, (req.command.match(/\n/g)?.length ?? 0) + 1)} spellCheck={false} />
        )
      )}
      {req.cwd && req.command !== undefined && <div className="approval-cwd muted small">in {req.cwd}</div>}
      {req.changes?.length ? <ChangesPreview changes={req.changes} /> : null}
      {req.questions?.map((q, qi) => {
        const questionId = `${fieldId}-question-${qi}`;
        const savedAnswer = /deny|reject|cancel/.test(decisionKind) ? undefined : item.decision?.answers?.[q.id];
        const savedOption = !q.secret && q.options?.find((o) => o.label === savedAnswer);
        return (
          <div key={q.id} className="approval-question" role="group" aria-labelledby={questionId}>
            {q.header && <div className="approval-qhead">{q.header}</div>}
            <div className="approval-qtext" id={questionId}>{q.question}</div>
            {decided ? (
              savedAnswer ? (
                <div className="approval-answer">
                  <span>{q.secret ? 'Answer hidden' : savedAnswer}</span>
                  {savedOption && savedOption.description && <span className="approval-choice-desc">{savedOption.description}</span>}
                </div>
              ) : <div className="muted small">No answer provided</div>
            ) : (
              <>
                {q.options?.length ? (
                  <div className="approval-qopts">
                    {q.options.map((o, oi) => {
                      const descriptionId = `${questionId}-option-${oi}`;
                      return (
                        <button key={o.label} type="button" className={`approval-choice ${answers[q.id] === o.label ? 'active' : ''}`} disabled={locked} onClick={() => setAnswers(answers[q.id] === o.label ? Object.fromEntries(Object.entries(answers).filter(([id]) => id !== q.id)) : { ...answers, [q.id]: o.label })} aria-label={o.label} aria-pressed={answers[q.id] === o.label} aria-describedby={o.description ? descriptionId : undefined}>
                          <span className="approval-choice-label">{o.label}{answers[q.id] === o.label && <Icon name="check" size={14} />}</span>
                          {o.description && <span className="approval-choice-desc" id={descriptionId}>{o.description}</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {(q.allowOther || !q.options?.length) && (
                  <label className="approval-field">
                    <span>Type an answer</span>
                    <input type={q.secret ? 'password' : 'text'} placeholder="Type an answer" aria-describedby={questionId} disabled={locked} value={answers[q.id] && !q.options?.some((o) => o.label === answers[q.id]) ? answers[q.id] : ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
                  </label>
                )}
              </>
            )}
          </div>
        );
      })}
      {decided && item.decision?.note && (
        <div className="approval-saved-note">
          <div className="approval-note-label">{req.kind === 'question' ? 'Additional context' : 'Note for the agent'}</div>
          <div>{item.decision.note}</div>
        </div>
      )}
      {!decided && (req.kind !== 'question' || questionComment) && (
        <label className="approval-field">
          <span>{noteLabel}</span>
          <textarea className="approval-note" rows={2} disabled={locked} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      {!decided && validationError && <div className="callout warn small" role="alert">{validationError}</div>}
      {!decided && emptyQuestion && <div className="muted small" id={`${fieldId}-response-hint`}>Choose an option, type an answer, or add context to continue.</div>}
      {!decided && canRespond && (
        <div className="approval-actions">
          {req.options.map((o) => (
            <Button key={o.id} className={`approval-opt opt-${o.kind}`} variant={o.kind === 'allow' ? 'primary' : o.kind === 'allow_session' || o.kind === 'allow_always' ? 'default' : 'ghost'} size="sm" disabled={locked || (emptyQuestion && o.kind === 'allow')} aria-describedby={emptyQuestion && o.kind === 'allow' ? `${fieldId}-response-hint` : undefined} onClick={() => respond(o.id)} title={o.description}>
              {o.label}
            </Button>
          ))}
          {responseState !== 'idle' && <span className="muted small" role="status">{responseState === 'sending' ? 'Sending response…' : 'Response sent'}</span>}
        </div>
      )}
      {!decided && !canRespond && <div className="approval-remote muted small">Decide on your computer</div>}
    </div>
  );
}

function labelFor(req: ApprovalRequest, optionId: string): string {
  return req.options.find((o) => o.id === optionId)?.label ?? optionId;
}

function ChangesPreview({ changes }: { changes: FileChange[] }) {
  const withDiff = changes.filter((c) => c.diff);
  return (
    <div className="approval-changes">
      <div className="approval-files">
        {changes.map((c) => (
          <span key={c.path} className={`file-chip kind-${c.kind}`}>
            {c.kind === 'add' ? '+' : c.kind === 'delete' ? '−' : '~'} {c.path}
          </span>
        ))}
      </div>
      {withDiff.length > 0 && <DiffView diff={withDiff.map((c) => c.diff!).join('\n')} compact />}
    </div>
  );
}
