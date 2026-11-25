/** Transcript row dispatchers and collapsible work/command groups. */
import React, { memo, useEffect, useRef, useState } from 'react';
import { missionToolOf } from '../../../../shared/mission-mode';
import type { TranscriptItem } from '../../../../shared/types';
import { fmtCost, fmtDuration, fmtRate, fmtTokens } from '../../format';
import { useStore } from '../../store';
import { chunkKey, type RenderChunk } from '../../transcript-window';
import { Badge, Icon, Spinner } from '../ui';
import { ApprovalCard } from './ApprovalCard';
import { groupCommands, isRunningEntry, sameChunk, type ToolItem } from './grouping';
import { AssistantMessage, MissionMessageCard, UserMessage } from './MessageViews';
import { Stamp, type OnImageExpand } from './shared';
import { MissionToolCard, PlanCard, ToolCard } from './ToolCards';

/** One transcript row; `dataItemId` anchors deep-search jumps to the exact item. */
export const Item = memo(function Item({
  item,
  sessionId,
  canEdit,
  showThinking,
  onImageExpand,
  dataItemId
}: {
  item: TranscriptItem;
  sessionId: string;
  canEdit: boolean;
  showThinking: boolean;
  onImageExpand: OnImageExpand;
  dataItemId?: string;
}) {
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
export const TranscriptRow = memo(function TranscriptRow({
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
      {chunk.kind === 'work' ? (
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

function renderItem(item: TranscriptItem, sessionId: string, canEdit: boolean, showThinking: boolean, onImageExpand: OnImageExpand) {
  switch (item.kind) {
    case 'user':
      return item.origin === 'mission'
        ? <MissionMessageCard item={item} sessionId={sessionId} onImageExpand={onImageExpand} />
        : <UserMessage item={item} sessionId={sessionId} canEdit={canEdit} onImageExpand={onImageExpand} />;
    case 'assistant':
      return <AssistantMessage item={item} sessionId={sessionId} showThinking={showThinking} onImageExpand={onImageExpand} />;
    case 'tool': {
      const tool = missionToolOf(item.name);
      return tool ? <MissionToolCard item={item} tool={tool} sessionId={sessionId} /> : <ToolCard item={item} sessionId={sessionId} />;
    }
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

/** One stretch of work behind a "Worked …" header; the messages around it stay outside. */
export function WorkGroup({ chunk, sessionId, canEdit = false, showThinking, onImageExpand, live = false }: { chunk: Extract<RenderChunk, { kind: 'work' }>; sessionId: string; canEdit?: boolean; showThinking: boolean; onImageExpand: OnImageExpand; live?: boolean }) {
  // open === null means the user has not toggled; then follow the turn so live activity stays visible.
  const [open, setOpen] = useState<boolean | null>(null);
  // A deep-search jump into one of these entries forces the group open so the anchor exists.
  const jumpHere = useStore((s) => !!s.searchJump && s.searchJump.sessionId === sessionId && chunk.entries.some((e) => e.id === s.searchJump!.itemId));
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
  const jumpHere = useStore((s) => !!s.searchJump && s.searchJump.sessionId === sessionId && entries.some((e) => e.id === s.searchJump!.itemId));
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
