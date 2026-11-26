/** Message-level transcript views: pinned prompt, user bubbles, mission cards, and assistant prose/reasoning. */
import React, { useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { parseGitHubPullRequestUrl } from '../../../../shared/github-pull-request';
import type { MissionMessageKind } from '../../../../shared/mission-mode';
import type { TranscriptItem } from '../../../../shared/types';
import { invoke } from '../../api';
import { useCanInvoke } from '../../capabilities';
import { fileManagerName } from '../../file-open';
import { renderMarkdown } from '../../markdown';
import { builderIndexOf, missionMessageLabel } from '../../mission';
import { useStore } from '../../store';
import { useMarkdownImages } from '../../use-markdown-images';
import { useStreamingMarkdown } from '../../use-streaming-markdown';
import { askConfirm, Badge, Button, Icon } from '../ui';
import { imageSrc, transcriptFileKind } from './grouping';
import { Stamp, TranscriptSessionContext, type OnImageExpand } from './shared';

/** Your message for the part of the transcript on screen, floating at the top; a click goes back to it. */
export function PinnedPrompt({ item, onJump }: { item: Extract<TranscriptItem, { kind: 'user' }>; onJump: () => void }) {
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

export function UserMessage({ item, sessionId, canEdit = true, onImageExpand }: { item: Extract<TranscriptItem, { kind: 'user' }>; sessionId?: string; canEdit?: boolean; onImageExpand?: OnImageExpand }) {
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
    if (!sessionId) return;
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
      </div>
      <div className="msg-user-meta">
        <Stamp ts={item.ts} />
        <button type="button" className="msg-action" title="Copy message" aria-label="Copy message" onClick={() => void copy()}><Icon name="copy" size={14} /></button>
        {sessionId && canEdit && <button type="button" className="msg-action" title="Edit and rerun message" aria-label="Edit and rerun message" onClick={() => setEditing(true)} disabled={rerunning}><Icon name="edit" size={14} /></button>}
      </div>
    </div>
  );
}

const MISSION_KIND_ICON: Record<MissionMessageKind, string> = {
  kickoff: 'flag', from_lead: 'arrowRight', from_builder: 'arrowLeft', report: 'check', question: 'info',
  approval: 'shield', failed: 'alert', stopped: 'stop', resume: 'play', note: 'info'
};

/** Past either, a mission message folds to its first lines until it is opened. */
const MISSION_FOLD_CHARS = 600;
const MISSION_FOLD_LINES = 8;

/**
 * A row Mission mode wrote into this transcript (a kickoff, a Lead↔Builder message, a report): a
 * compact labelled card rather than a bubble that reads as if you had typed it.
 */
export function MissionMessageCard({ item, sessionId, onImageExpand }: { item: Extract<TranscriptItem, { kind: 'user' }>; sessionId: string; onImageExpand?: OnImageExpand }) {
  const meta = item.mission;
  const kind = meta?.kind ?? 'note';
  const builderIndex = useStore((s) => builderIndexOf(meta?.builderId, s.missionViews, s.sessions));
  const jumpHere = useStore((s) => !!s.searchJump && s.searchJump.sessionId === sessionId && s.searchJump.itemId === item.id);
  const [open, setOpen] = useState(false);
  const long = item.text.length > MISSION_FOLD_CHARS || item.text.split('\n').length > MISSION_FOLD_LINES;
  const expanded = !long || open || jumpHere;
  const markup = useMemo(() => ({ __html: renderMarkdown(item.text) }), [item.text]);
  const images = item.images ?? [];
  return (
    <div className={`mission-card mission-msg${expanded ? '' : ' folded'}`} data-kind={kind}>
      <div className="mission-card-head">
        <span className="mission-card-glyph"><Icon name={MISSION_KIND_ICON[kind] ?? 'info'} size={13} /></span>
        <span className="mission-card-label">{missionMessageLabel(meta, builderIndex)}</span>
        {builderIndex && kind !== 'from_builder' ? <span className="mission-card-who">Builder {builderIndex}</span> : null}
        <span className="spacer" />
        {long && (
          <button type="button" className="link-btn mission-card-toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <Stamp ts={item.ts} className="mission-card-time" />
      </div>
      {item.text && <div className="md mission-card-body" dangerouslySetInnerHTML={markup} />}
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((im, i) => (
            <button key={i} type="button" className="msg-image-btn" aria-label={`Preview ${im.name ?? 'image'}`} onClick={() => onImageExpand?.(images.map((att) => ({ src: imageSrc(att), name: att.name })), i)}>
              <img src={imageSrc(im)} alt={im.name ?? 'attachment'} draggable={false} />
            </button>
          ))}
        </div>
      )}
      {item.files?.length ? <div className="msg-files" aria-label="Attached files">{item.files.map((file) => <Badge key={file.path} tone="neutral">{file.name}</Badge>)}</div> : null}
    </div>
  );
}

interface AssistantMessageProps {
  item: Extract<TranscriptItem, { kind: 'assistant' }>;
  sessionId: string;
  showThinking: boolean;
  onImageExpand: OnImageExpand;
}

export function AssistantMessage(props: AssistantMessageProps) {
  const ctx = useContext(TranscriptSessionContext);
  if (ctx) return <AssistantMessageBody {...props} cwd={ctx.cwd} canOpenPr={ctx.canOpenPr} />;
  return <StandaloneAssistantMessage {...props} />;
}

/** Fallback when a WorkGroup/ToolGroup is rendered outside `<Transcript>` (such as unit tests). */
function StandaloneAssistantMessage(props: AssistantMessageProps) {
  const cwd = useStore((s) => s.sessions.find((candidate) => candidate.id === props.sessionId)?.cwd);
  const canOpenPr = useStore((s) => s.activeId === props.sessionId && s.sessions.some((candidate) => candidate.id === props.sessionId));
  return <AssistantMessageBody {...props} cwd={cwd} canOpenPr={canOpenPr} />;
}

function AssistantMessageBody({
  item,
  sessionId,
  showThinking,
  onImageExpand,
  cwd,
  canOpenPr
}: AssistantMessageProps & { cwd: string | undefined; canOpenPr: boolean }) {
  // open === null means the user has not toggled; then reasoning shows only while it is being written.
  const [open, setOpen] = useState<boolean | null>(null);
  const html = useStreamingMarkdown(item.text, item.streaming);
  // React must leave the hydrated DOM alone when only the active pane changes.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const canRevealOutside = useCanInvoke('app:showInFolder');
  const body = useMarkdownImages(html, sessionId, cwd, onImageExpand);
  useLayoutEffect(() => {
    // Use only the sanitized targets, not labels or Markdown-supplied link-kind attributes.
    // Reclassify cached HTML in place when the session or capability changes.
    for (const el of body.current?.querySelectorAll<HTMLElement>('a[href], [data-file]') ?? []) {
      const path = el.getAttribute('data-file');
      const href = el.getAttribute('href');
      const kind = path && cwd !== undefined ? transcriptFileKind(path, cwd, canRevealOutside)
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
  }, [body, markup, cwd, canOpenPr, canRevealOutside]);
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
