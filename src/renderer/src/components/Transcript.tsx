import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalRequest, FileChange, SessionMeta, TranscriptItem } from '../../../shared/types';
import { invoke } from '../api';
import { fmtCost, fmtDuration, fmtRate, fmtTokens } from '../format';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import { useStore } from '../store';
import { DiffView } from './DiffView';
import { ImageLightbox, type LightboxImage } from './ImageLightbox';
import { TranscriptFind } from './TranscriptFind';
import { Badge, Button, Icon, Spinner } from './ui';

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

export function Transcript({ session }: { session: SessionMeta }) {
  const items = useStore((s) => s.transcripts[session.id] ?? EMPTY);
  const loaded = useStore((s) => s.loaded[session.id]);
  const showThinking = useStore((s) => s.showThinking);
  const jump = useStore((s) => s.searchJump);
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [lightbox, setLightbox] = useState<ImageLightboxState | null>(null);
  const onImageExpand = useCallback((images: LightboxImage[], index: number) => {
    setLightbox({ images, index });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Terminal owns Ctrl+F so its find bar opens instead of the transcript finder.
      if (isTerminalEventTarget(e.target)) return;
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
    return installMarkdownHandlers(el, (url) => void invoke('app:openExternal', { url }));
  }, []);

  // While the find bar is open, follow-the-stream would keep yanking the view away from matches.
  useEffect(() => {
    if (stick && !findOpen && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items, stick, findOpen]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  // Jump-to-match from the deep search modal: scroll to the item and flash it. Waits for the
  // transcript to load when the session was not the active one.
  useEffect(() => {
    if (!jump || jump.sessionId !== session.id || !loaded || !ref.current) return;
    const el = ref.current.querySelector(`[data-item-id="${CSS.escape(jump.itemId)}"]`);
    if (!el) return;
    setStick(false);
    el.scrollIntoView({ block: 'center' });
    el.classList.add('search-jump-hl');
    const t = setTimeout(() => el.classList.remove('search-jump-hl'), 2400);
    return () => clearTimeout(t);
  }, [jump, loaded, session.id]);

  const pendingApprovals = useMemo(() => items.filter((i) => i.kind === 'approval' && !i.decision).length, [items]);

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} onScroll={onScroll}>
        {!loaded && <div className="transcript-loading"><Spinner /> Loading…</div>}
        {loaded && items.length === 0 && (
          <div className="transcript-empty">
            <Icon name="sparkles" size={28} />
            <p>Send a message to start. Type <code>/</code> for commands, <code>@</code> to mention files, paste images to attach them.</p>
          </div>
        )}
        {groupTranscript(items).map((chunk) =>
          chunk.kind === 'group' ? (
            <ToolGroup key={chunk.id} entries={chunk.entries} sessionId={session.id} showThinking={showThinking} onImageExpand={onImageExpand} />
          ) : (
            <Item key={chunk.item.id} item={chunk.item} sessionId={session.id} showThinking={showThinking} onImageExpand={onImageExpand} dataItemId={chunk.item.id} />
          )
        )}
        {(session.status === 'running' || session.status === 'starting') && (
          <div className="working">
            <Spinner size={12} /> {session.status === 'starting' ? session.statusDetail ?? 'Starting…' : 'Working…'}
          </div>
        )}
      </div>
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
      <TranscriptFind open={findOpen} onClose={() => setFindOpen(false)} container={ref} revision={items} />
      {!stick && (
        <button type="button" className="jump-bottom" onClick={() => { setStick(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }}>
          <Icon name="chevron" size={14} /> {pendingApprovals ? `${pendingApprovals} approval pending` : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}

/** One transcript row; `dataItemId` anchors deep-search jumps to the exact item. */
const Item = memo(function Item({ item, sessionId, showThinking, onImageExpand, dataItemId }: { item: TranscriptItem; sessionId: string; showThinking: boolean; onImageExpand: OnImageExpand; dataItemId?: string }) {
  return (
    <div data-item-id={dataItemId}>
      {renderItem(item, sessionId, showThinking, onImageExpand)}
    </div>
  );
});

function renderItem(item: TranscriptItem, sessionId: string, showThinking: boolean, onImageExpand: OnImageExpand) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} onImageExpand={onImageExpand} />;
    case 'assistant':
      return <AssistantMessage item={item} showThinking={showThinking} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'approval':
      return <ApprovalCard item={item} sessionId={sessionId} />;
    case 'info':
      return (
        <div className={`info-line info-${item.level}`}>
          {item.pending ? <Spinner size={13} /> : <Icon name={item.level === 'error' ? 'alert' : item.level === 'warn' ? 'alert' : 'info'} size={13} />} <span>{item.text}</span>
        </div>
      );
    case 'turn':
      return (
        <div className={`turn-footer turn-${item.status}`}>
          <span>{item.status === 'completed' ? 'Turn complete' : item.status === 'interrupted' ? 'Interrupted' : `Failed${item.error ? `: ${item.error}` : ''}`}</span>
          {item.durationMs ? <span>· {fmtDuration(item.durationMs)}</span> : null}
          {item.usage && (item.usage.inputTokens || item.usage.outputTokens) ? <span>· {fmtTokens(item.usage.inputTokens)} in / {fmtTokens(item.usage.outputTokens)} out</span> : null}
          {item.status === 'completed' && fmtRate(item.usage?.outputTokens, item.durationMs) ? (
            <span title="Output tokens per second of turn wall time (includes tool execution)">· {fmtRate(item.usage?.outputTokens, item.durationMs)}</span>
          ) : null}
          {item.costUsd ? <span>· {fmtCost(item.costUsd)}</span> : null}
        </div>
      );
    case 'plan':
      return (
        <div className="plan-card">
          <div className="plan-title"><Icon name="target" size={13} /> Plan</div>
          <ul>
            {item.entries.map((e, i) => (
              <li key={i} className={`plan-${e.status}`}>
                <span className="plan-check">{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '›' : '○'}</span> {e.content}
              </li>
            ))}
          </ul>
        </div>
      );
    default:
      return null;
  }
}

export function UserMessage({ item, onImageExpand }: { item: Extract<TranscriptItem, { kind: 'user' }>; onImageExpand?: OnImageExpand }) {
  const images = item.images ?? [];
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">
        {item.queuedAs && item.queuedAs !== 'now' && <Badge tone="blue">{item.queuedAs}</Badge>}
        <div className="msg-text">{item.text}</div>
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
      </div>
    </div>
  );
}

function AssistantMessage({ item, showThinking }: { item: Extract<TranscriptItem, { kind: 'assistant' }>; showThinking: boolean }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => renderMarkdown(item.text), [item.text]);
  // With thinking hidden a thinking-only item has nothing left to show; rendering it anyway would
  // leave an empty row in the transcript.
  if (!item.text && !(item.thinking && showThinking)) return null;
  const onlyThinking = !item.text && !!item.thinking;
  return (
    <div className={`msg msg-assistant ${item.phase === 'plan' ? 'msg-plan' : ''} ${item.phase === 'commentary' ? 'msg-commentary' : ''}`}>
      {item.thinking && showThinking && (
        <div className={`thinking ${open || onlyThinking ? 'open' : ''}`}>
          <button type="button" className="thinking-toggle" onClick={() => setOpen((o) => !o)}>
            <Icon name="brain" size={13} /> {item.streaming && onlyThinking ? 'Thinking…' : 'Thinking'} <Icon name={open || onlyThinking ? 'chevron' : 'chevronRight'} size={12} />
          </button>
          {(open || onlyThinking) && <div className="thinking-body">{item.thinking}</div>}
        </div>
      )}
      {item.text && <div className={`md ${item.streaming ? 'streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />}
      {item.phase === 'plan' && <Badge tone="purple">plan</Badge>}
    </div>
  );
}

const HINT_ICON: Record<string, string> = { execute: 'terminal', edit: 'edit', read: 'file', search: 'search', fetch: 'external', think: 'brain', mcp: 'bolt', agent: 'fork', other: 'bolt' };

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** A run of shell commands (with interleaved commentary) collapses into one group. */
export type RenderChunk =
  | { kind: 'single'; item: TranscriptItem }
  | { kind: 'group'; id: string; entries: TranscriptItem[] };

/** A run ends at user messages, approvals, turn boundaries, plans and non-command tools. */
const breaksCommandRun = (item: TranscriptItem): boolean =>
  (item.kind === 'tool' && item.hint !== 'execute') ||
  item.kind === 'user' || item.kind === 'approval' || item.kind === 'turn' || item.kind === 'plan';

/**
 * Group execute tools (per nesting parent) into collapsible chunks. Assistant text, thinking
 * and info lines between two commands are absorbed so commentary does not break the run;
 * anything trailing the last command is popped back out so the turn's answer stays visible.
 */
export function groupTranscript(items: TranscriptItem[]): RenderChunk[] {
  const isCmd = (item: TranscriptItem): item is ToolItem => item.kind === 'tool' && item.hint === 'execute';
  const chunks: RenderChunk[] = [];
  let run: TranscriptItem[] = [];
  let runId = '';
  let runParent: string | null = null;
  const flush = () => {
    if (run.length) {
      const lastCmd = run.reduce((acc, it, idx) => (isCmd(it) ? idx : acc), -1);
      const head = run.slice(0, lastCmd + 1);
      const commands = head.filter(isCmd);
      if (commands.length > 1) chunks.push({ kind: 'group', id: runId, entries: head });
      else for (const it of head) chunks.push({ kind: 'single', item: it });
      for (const it of run.slice(lastCmd + 1)) chunks.push({ kind: 'single', item: it });
    }
    run = [];
  };
  for (const item of items) {
    if (isCmd(item)) {
      const parent = item.parentId ?? null;
      if (run.length && parent !== runParent) flush();
      if (!run.length) {
        runId = item.id;
        runParent = parent;
      }
      run.push(item);
    } else if (run.length && !breaksCommandRun(item)) {
      run.push(item);
    } else {
      flush();
      chunks.push({ kind: 'single', item });
    }
  }
  flush();
  return chunks;
}

/** Collapsed "Ran n commands" header for a run of shell commands, with interleaved commentary inside. */
export function ToolGroup({ entries, sessionId, showThinking, onImageExpand }: { entries: TranscriptItem[]; sessionId: string; showThinking: boolean; onImageExpand: OnImageExpand }) {
  // open === null means the user has not toggled; then follow running state so live output stays visible.
  const [open, setOpen] = useState<boolean | null>(null);
  // A deep-search jump into one of these commands forces the group open so the anchor exists.
  const jump = useStore((s) => s.searchJump);
  const jumpHere = !!jump && jump.sessionId === sessionId && entries.some((e) => e.id === jump.itemId);
  const commands = entries.filter((e): e is ToolItem => e.kind === 'tool');
  const running = commands.some((i) => i.status === 'running');
  const expanded = jumpHere || (open ?? running);
  const failed = commands.filter((i) => i.status === 'error' || i.status === 'declined').length;
  const totalMs = commands.reduce((sum, i) => sum + (i.durationMs ?? 0), 0);
  return (
    <div className={`tool-group ${running ? 'tool-group-running' : ''}`}>
      <button type="button" className="tool-group-head" onClick={() => setOpen(!expanded)}>
        <Icon name="terminal" size={14} className="tool-icon" />
        <span className="tool-name">{running ? 'Running' : 'Ran'} {commands.length} command{commands.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        {failed ? <Badge tone="red">{failed} failed</Badge> : null}
        {running ? <Spinner size={12} /> : totalMs ? <span className="muted small">{fmtDuration(totalMs)}</span> : null}
        <Icon name={expanded ? 'chevron' : 'chevronRight'} size={12} />
      </button>
      {expanded && (
        <div className="tool-group-body">
          {entries.map((e) =>
            e.kind === 'tool' ? (
              <ToolCard key={e.id} item={e} dataItemId={e.id} />
            ) : (
              <Item key={e.id} item={e} sessionId={sessionId} showThinking={showThinking} onImageExpand={onImageExpand} dataItemId={e.id} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function ToolCard({ item, dataItemId }: { item: Extract<TranscriptItem, { kind: 'tool' }>; dataItemId?: string }) {
  const [open, setOpen] = useState(false);
  const hasBody = !!item.output || !!(item.changes && item.changes.length) || item.input !== undefined;
  const statusTone = item.status === 'running' ? 'blue' : item.status === 'error' ? 'red' : item.status === 'declined' ? 'amber' : 'green';
  return (
    <div data-item-id={dataItemId} className={`tool-card tool-${item.status} ${item.parentId ? 'tool-nested' : ''}`}>
      <button type="button" className="tool-head" onClick={() => hasBody && setOpen((o) => !o)}>
        <Icon name={HINT_ICON[item.hint ?? 'other']} size={14} className="tool-icon" />
        <span className="tool-name">{item.title ?? item.name}</span>
        {item.summary && <span className="tool-summary mono" title={item.summary}>{item.summary}</span>}
        <span className="spacer" />
        {item.changes?.length ? <span className="tool-changes">{item.changes.length} file{item.changes.length === 1 ? '' : 's'}</span> : null}
        {item.status === 'running' ? <Spinner size={12} /> : <Badge tone={statusTone}>{item.status === 'done' ? (item.exitCode !== undefined && item.exitCode !== null ? `exit ${item.exitCode}` : 'done') : item.status}</Badge>}
        {item.durationMs ? <span className="muted small">{fmtDuration(item.durationMs)}</span> : null}
        {hasBody && <Icon name={open ? 'chevron' : 'chevronRight'} size={12} />}
      </button>
      {(open || (item.status === 'running' && item.hint === 'execute' && item.output)) && (
        <div className="tool-body">
          {open && item.input !== undefined && item.hint !== 'execute' && (
            <pre className="tool-input mono">{typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2).slice(0, 4000)}</pre>
          )}
          {item.changes?.some((c) => c.diff) && <DiffView diff={item.changes.filter((c) => c.diff).map((c) => c.diff!).join('\n')} compact />}
          {item.output && <pre className="tool-output mono">{item.output.length > 12_000 && !open ? item.output.slice(-12_000) : item.output}</pre>}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ item, sessionId }: { item: Extract<TranscriptItem, { kind: 'approval' }>; sessionId: string }) {
  const req = item.request;
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [editedCommand, setEditedCommand] = useState<string | null>(null);
  const decided = !!item.decision;
  const respond = (optionId: string) => {
    const decision: { optionId: string; note?: string; answers?: Record<string, string>; updatedInput?: unknown } = { optionId, note: note.trim() || undefined };
    if (req.questions?.length) decision.answers = answers;
    if (editedCommand !== null && editedCommand !== req.command && req.input && typeof req.input === 'object') decision.updatedInput = { ...(req.input as Record<string, unknown>), command: editedCommand };
    void invoke('approvals:respond', { sessionId, requestId: req.id, decision });
  };
  return (
    <div className={`approval ${decided ? 'decided' : 'pending'}`}>
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span className="approval-title">{req.title}</span>
        <Badge tone="neutral">{req.harness}</Badge>
        {decided && <Badge tone={/deny|reject|cancel/.test(item.decision!.optionId) ? 'red' : 'green'}>{labelFor(req, item.decision!.optionId)}</Badge>}
      </div>
      {req.description && <div className="approval-desc">{req.description}</div>}
      {req.command !== undefined && (
        decided ? (
          <pre className="approval-cmd mono">{req.command}</pre>
        ) : (
          <textarea className="approval-cmd mono editable" value={editedCommand ?? req.command} onChange={(e) => setEditedCommand(e.target.value)} rows={Math.min(6, (req.command.match(/\n/g)?.length ?? 0) + 1)} spellCheck={false} />
        )
      )}
      {req.cwd && req.command !== undefined && <div className="approval-cwd muted small">in {req.cwd}</div>}
      {req.changes?.length ? <ChangesPreview changes={req.changes} /> : null}
      {req.questions?.map((q) => (
        <div key={q.id} className="approval-question">
          {q.header && <div className="approval-qhead">{q.header}</div>}
          <div className="approval-qtext">{q.question}</div>
          {q.options?.length ? (
            <div className="approval-qopts">
              {q.options.map((o) => (
                <button key={o.label} type="button" className={`chip ${answers[q.id] === o.label ? 'active' : ''}`} disabled={decided} onClick={() => setAnswers({ ...answers, [q.id]: o.label })} title={o.description}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
          {(q.allowOther || !q.options?.length) && !decided && (
            <input type={q.secret ? 'password' : 'text'} placeholder="Type an answer" value={answers[q.id] && !q.options?.some((o) => o.label === answers[q.id]) ? answers[q.id] : ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
          )}
          {decided && item.decision?.answers?.[q.id] && <div className="approval-answer">→ {item.decision.answers[q.id]}</div>}
        </div>
      ))}
      {!decided && (
        <div className="approval-actions">
          {req.options.map((o) => (
            <Button key={o.id} variant={o.kind === 'allow' ? 'primary' : o.kind === 'allow_session' || o.kind === 'allow_always' ? 'default' : 'ghost'} size="sm" onClick={() => respond(o.id)} title={o.description}>
              {o.label}
            </Button>
          ))}
          <input className="approval-note" placeholder="Optional note for the agent (sent when denying)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
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
