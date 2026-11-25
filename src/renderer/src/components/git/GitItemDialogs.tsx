/** GitHub PR and issue detail dialogs with on-demand conversation comments. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GitComment, GitIssue, GitPullRequest } from '../../../../shared/types';
import { invoke } from '../../api';
import { relTime } from '../../format';
import { installMarkdownHandlers, renderMarkdown } from '../../markdown';
import { Badge, Button, Modal, Spinner } from '../ui';

/**
 * Pulls one issue's or PR's conversation comments when its preview opens. The list payload only
 * carries the count, so bodies are fetched on demand; `null` means the fetch is still in flight.
 */
function useGitComments(channel: 'git:issueComments' | 'git:prComments', sessionId: string, number: number) {
  const [comments, setComments] = useState<GitComment[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    setComments(null);
    setError(undefined);
    invoke(channel, { sessionId, number })
      .then((r) => {
        if (!live) return;
        setComments(r.comments ?? []);
        setError(r.error ?? (r.ghMissing ? 'GitHub CLI (gh) is not available, so comments cannot be shown.' : undefined));
      })
      .catch((e: unknown) => {
        if (!live) return;
        setComments([]);
        setError(String((e as Error).message ?? e));
      });
    return () => {
      live = false;
    };
  }, [channel, sessionId, number]);
  return { comments, error };
}

/** One conversation comment with GitHub's markdown rendered; links open in the OS browser. */
function CommentRow({ comment }: { comment: GitComment }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyHtml = useMemo(() => renderMarkdown(comment.body ?? ''), [comment.body]);
  useEffect(() => {
    if (!bodyRef.current || !bodyHtml) return;
    return installMarkdownHandlers(bodyRef.current, (url) => void invoke('app:openExternal', { url }));
  }, [bodyHtml]);
  const association = comment.authorAssociation && comment.authorAssociation !== 'NONE' ? comment.authorAssociation.toLowerCase().replace(/_/g, ' ') : undefined;
  return (
    <article className="git-comment">
      <header className="git-comment-head">
        <strong>{comment.author ?? 'unknown'}</strong>
        {association && <Badge tone="neutral">{association}</Badge>}
        {comment.createdAt !== undefined && (
          <span className="muted small" title={new Date(comment.createdAt).toLocaleString()}>
            {relTime(comment.createdAt)}
          </span>
        )}
      </header>
      {bodyHtml ? (
        <div ref={bodyRef} className="md git-comment-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      ) : (
        <p className="muted small git-comment-body">(no text)</p>
      )}
    </article>
  );
}

/** The conversation below an issue or PR preview: a loading note until the fetch settles, then the comments (or a note when there are none). */
function CommentsSection({ comments, error, loading }: { comments: GitComment[] | null; error?: string; loading: boolean }) {
  return (
    <section className="git-comments" aria-label="Comments">
      <h4 className="git-comments-title">Comments{comments && comments.length > 0 ? ` (${comments.length})` : ''}</h4>
      {error && <p className="muted small git-comments-note">{error}</p>}
      {!error && loading && <p className="muted small git-comments-note">Loading comments…</p>}
      {!error && !loading && comments && comments.length === 0 && <p className="muted small git-comments-note">No comments yet.</p>}
      {comments?.map((c, i) => (
        <CommentRow key={c.url ?? i} comment={c} />
      ))}
    </section>
  );
}

export function IssueDialog({
  issue,
  sessionId,
  onClose,
  onViewExternal,
  onNewSession
}: {
  issue: GitIssue;
  sessionId: string;
  onClose: () => void;
  onViewExternal: () => void;
  onNewSession: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyHtml = useMemo(() => renderMarkdown(issue.body ?? ''), [issue.body]);
  const { comments, error } = useGitComments('git:issueComments', sessionId, issue.number);
  useEffect(() => {
    if (!bodyRef.current || !bodyHtml) return;
    return installMarkdownHandlers(bodyRef.current, (url) => void invoke('app:openExternal', { url }));
  }, [bodyHtml]);
  const stateLabel = issue.state === 'OPEN' ? 'Open' : 'Closed';

  return (
    <Modal
      title={<><span className="mono muted">#{issue.number}</span> {issue.title}</>}
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button variant="ghost" icon="external" onClick={onViewExternal}>
            Open on GitHub
          </Button>
          <Button variant="primary" icon="plus" onClick={onNewSession}>
            Start session
          </Button>
        </>
      }
    >
      <div className="issue-dialog-meta">
        <Badge tone={issue.state === 'OPEN' ? 'green' : 'neutral'}>{stateLabel}</Badge>
        {issue.author && <span>Opened by <strong>{issue.author}</strong></span>}
        {issue.comments !== undefined && <span>{issue.comments} comment{issue.comments === 1 ? '' : 's'}</span>}
        {issue.createdAt !== undefined && <span title={new Date(issue.createdAt).toLocaleString()}>Opened {relTime(issue.createdAt)}</span>}
        {issue.updatedAt !== undefined && <span title={new Date(issue.updatedAt).toLocaleString()}>Updated {relTime(issue.updatedAt)}</span>}
        {issue.state === 'CLOSED' && issue.closedAt !== undefined && <span title={new Date(issue.closedAt).toLocaleString()}>Closed {relTime(issue.closedAt)}</span>}
        {issue.labels?.map((label) => (
          <Badge key={label.name} tone="neutral" title={`Label: ${label.name}`}>
            {label.name}
          </Badge>
        ))}
      </div>
      {bodyHtml ? <div ref={bodyRef} className="md issue-dialog-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} /> : <p className="muted issue-dialog-empty">No description provided.</p>}
      <CommentsSection comments={comments} error={error} loading={comments === null} />
    </Modal>
  );
}

export function ListedPrDialog({ pr, sessionId, onClose, onViewExternal, onMerge }: {
  pr: GitPullRequest;
  sessionId: string;
  onClose: () => void;
  onViewExternal: () => void;
  onMerge: () => void;
}) {
  const { comments, error } = useGitComments('git:prComments', sessionId, pr.number);
  return <PrDialog number={pr.number} pr={pr} comments={comments} commentsError={error} onClose={onClose} onViewExternal={onViewExternal} onMerge={onMerge} />;
}

export function PrDialog({
  number,
  pr,
  comments,
  commentsError,
  loadError,
  onClose,
  onViewExternal,
  onMerge
}: {
  number: number;
  pr?: GitPullRequest;
  comments: GitComment[] | null;
  commentsError?: string;
  loadError?: string;
  onClose: () => void;
  onViewExternal: () => void;
  onMerge?: () => void;
}) {
  const mergeable = pr?.state === 'OPEN' && !pr.isDraft && !!pr.headRefName;
  return (
    <Modal
      title={<><span className="mono muted">#{number}</span> {pr?.title}</>}
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button variant="ghost" icon="external" onClick={onViewExternal}>
            Open on GitHub
          </Button>
          {pr && onMerge && (
            <Button
              variant="primary"
              icon="check"
              disabled={!mergeable}
              title={mergeable ? `Merge ${pr.headRefName} into ${pr.baseRefName ?? 'its target branch'}` : pr.isDraft ? 'Draft pull requests cannot be merged' : 'Only open pull requests can be merged'}
              onClick={onMerge}
            >
              Merge PR
            </Button>
          )}
        </>
      }
    >
      {pr ? <PrDetails pr={pr} comments={comments} error={commentsError} /> : loadError ? (
        <div className="callout warn" role="status">{loadError}</div>
      ) : (
        <div className="muted" role="status"><Spinner /> Loading pull request…</div>
      )}
    </Modal>
  );
}

function PrDetails({ pr, comments, error }: { pr: GitPullRequest; comments: GitComment[] | null; error?: string }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyHtml = useMemo(() => renderMarkdown(pr.body ?? ''), [pr.body]);
  useEffect(() => {
    if (!bodyRef.current || !bodyHtml) return;
    return installMarkdownHandlers(bodyRef.current, (url) => void invoke('app:openExternal', { url }));
  }, [bodyHtml]);
  const stateLabel = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open';
  const stateTone = pr.state === 'MERGED' ? 'purple' : pr.state === 'CLOSED' ? 'neutral' : pr.isDraft ? 'neutral' : 'green';
  const review = pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : undefined;
  const diffStat = pr.additions !== undefined || pr.deletions !== undefined ? `+${pr.additions ?? 0} −${pr.deletions ?? 0}` : undefined;
  return (
    <>
      <div className="pr-dialog-meta">
        <Badge tone={stateTone}>{stateLabel}</Badge>
        {review && <Badge tone={pr.reviewDecision === 'APPROVED' ? 'green' : 'red'} title={`Review: ${review}`}>{review}</Badge>}
        {pr.author && <span>Opened by <strong>{pr.author}</strong></span>}
        {(pr.headRefName || pr.baseRefName) && <span className="mono">{pr.headRefName ?? '?'} → {pr.baseRefName ?? '?'}</span>}
        {diffStat && <span title="Changed lines">{diffStat}</span>}
        {pr.comments !== undefined && <span>{pr.comments} comment{pr.comments === 1 ? '' : 's'}</span>}
        {pr.createdAt !== undefined && <span title={new Date(pr.createdAt).toLocaleString()}>Opened {relTime(pr.createdAt)}</span>}
        {pr.updatedAt !== undefined && <span title={new Date(pr.updatedAt).toLocaleString()}>Updated {relTime(pr.updatedAt)}</span>}
        {pr.state === 'MERGED' && pr.mergedAt !== undefined && <span title={new Date(pr.mergedAt).toLocaleString()}>Merged {relTime(pr.mergedAt)}</span>}
        {pr.labels?.map((label) => (
          <Badge key={label.name} tone="neutral" title={`Label: ${label.name}`}>
            {label.name}
          </Badge>
        ))}
      </div>
      {bodyHtml ? <div ref={bodyRef} className="md pr-dialog-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} /> : <p className="muted pr-dialog-empty">No description provided.</p>}
      <CommentsSection comments={comments} error={error} loading={comments === null} />
    </>
  );
}
