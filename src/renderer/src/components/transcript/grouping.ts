/** Pure transcript grouping, chunk comparison, link-kind routing, and scroll-pinning helpers. */
import { imageMimeType } from '../../../../shared/image-files';
import { missionToolOf } from '../../../../shared/mission-mode';
import type { SessionMeta, TranscriptItem } from '../../../../shared/types';
import { isWeb, platform } from '../../api';
import { workspaceRelativePath } from '../../file-refs';
import { isHandoffTool } from '../../mission';
import type { RenderChunk } from '../../transcript-window';

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** One row of a work body: a collapsed command run, or a single entry of any kind. */
export type CommandChunk = { kind: 'run'; id: string; entries: ToolItem[] } | { kind: 'single'; item: TranscriptItem };

/** Space left above a message the pinned prompt jumps to, so it lands just under the top edge. */
export const PROMPT_JUMP_MARGIN = 12;

/** Terminal key events are handled by the terminal find bar, not the transcript finder. */
export function isTerminalEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.term, .term-view');
}

/** Data-URL rendering for a transcript image attachment. */
export function imageSrc(im: { mimeType: string; data: string }): string {
  return `data:${im.mimeType};base64,${im.data}`;
}

/**
 * Which of your messages the pinned prompt shows: the one whose stretch of the transcript is at
 * the top of the viewport, once that message itself has scrolled out of view. While any of it is
 * still on screen there is nothing to pin, so jumping to a message makes the bar give way to it.
 * Offsets are content coordinates: `base` is where the first row starts, `tops` the row offsets.
 */
export function pinnedPromptIndex(userChunks: number[], tops: number[], base: number, scrollTop: number): number {
  let at = -1;
  for (const i of userChunks) {
    if (base + tops[i]! > scrollTop + PROMPT_JUMP_MARGIN + 4) break;
    at = i;
  }
  if (at < 0) return -1;
  return base + tops[at + 1]! <= scrollTop + 24 ? at : -1;
}

export function canOpenTranscriptPullRequest(session: SessionMeta | undefined, activeId: string | null): boolean {
  return !isWeb && !!session && session.id === activeId;
}

/** Mirrors revealFile's routing without reading or resolving files ahead of a click. */
export function transcriptFileKind(path: string, root: string, canRevealOutside: boolean) {
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

export const isRunningEntry = (item: TranscriptItem): boolean =>
  (item.kind === 'tool' && item.status === 'running') || (item.kind === 'assistant' && !!item.streaming);

/** An assistant row that carries no prose: reasoning only, or a stream that has not produced text yet. */
export const isThinkingOnly = (item: TranscriptItem): boolean => item.kind === 'assistant' && item.text.trim() === '';

/** A step the agent took, as opposed to a line that merely sits beside the steps. */
export const isStep = (item: TranscriptItem): boolean => item.kind === 'tool' || item.kind === 'approval' || item.kind === 'plan';

/**
 * Whether an item is machinery (it may collapse behind a work header) rather than something
 * written for the reader. Everything the model says in prose is a message and stays on screen,
 * whatever phase the harness gave it and whether or not more tool calls follow: only tool calls,
 * reasoning with no prose, info-level notices, approvals and plans are work. Approvals keep their
 * header open while undecided; plans are work that `WorkGroup` keeps on screen as one card under
 * its header, so a plan update does not split a stretch of work in two.
 */
export function isWorkItem(item: TranscriptItem): boolean {
  // A Mission handoff (a Builder started, a report filed, a branch landed) is the story of the
  // mission, so it stays on screen; the Lead's read-only checks fold away like any other step.
  if (item.kind === 'tool' && isHandoffTool(missionToolOf(item.name))) return false;
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

/** Grouping recreates wrappers; unchanged constituent items still have stable store identities. */
export function sameChunk(a: RenderChunk, b: RenderChunk): boolean {
  if (a.kind === 'single' && b.kind === 'single') return a.item === b.item;
  if (a.kind === 'group' && b.kind === 'group') return a.id === b.id && sameEntries(a.entries, b.entries);
  return a.kind === 'work' && b.kind === 'work' && a.id === b.id && sameEntries(a.entries, b.entries) &&
    a.turn?.status === b.turn?.status && a.turn?.durationMs === b.turn?.durationMs;
}

function sameEntries(a: TranscriptItem[], b: TranscriptItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
