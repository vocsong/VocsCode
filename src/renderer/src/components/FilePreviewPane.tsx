/**
 * A file previewed in the split view, beside the session that named it. Every way of opening a file
 * — a transcript mention, a Files tab row, a link inside a previewed markdown file — lands here.
 *
 * A shortened mention (`tools.ts`) is resolved in the session folder first: one match opens, several
 * ask which one, none says so. Text, rendered markdown, images and binary files each get their own
 * view. The pane never becomes the active pane, so the conversation keeps the composer and panels.
 * A request that fails leaves the previous file on screen; with nothing to show, the pane closes.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { imageMimeType, type WorkspaceImage } from '../../../shared/image-files';
import { canInvoke, invoke, invokeErrorMessage } from '../api';
import { fileManagerName, fileScope } from '../file-open';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import type { SessionPane } from '../panes';
import { useStore } from '../store';
import { SessionTitle } from './SessionTitle';
import { Button, Icon, Spinner } from './ui';

interface Preview {
  path: string;
  content: string;
  truncated: boolean;
  /** Not text (a zip, an executable): there is nothing to show but its name. */
  binary?: boolean;
  /** Set for image files, which render as a picture; null when the image could not be read. */
  image?: WorkspaceImage | null;
  /** The line the request asked for, kept for "Open in editor". */
  line?: number;
}

const isMarkdown = (p: string) => /\.(?:md|markdown)$/i.test(p);
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function FilePreviewPane({ pane, size, split }: { pane: SessionPane; size: number; split: boolean }) {
  const target = pane.file!;
  const session = useStore((s) => s.sessions.find((x) => x.id === target.sessionId));
  const mission = useStore((s) => (session?.mission ? s.missions[session.mission.missionId] : undefined));
  const toast = useStore((s) => s.toast);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mdView, setMdView] = useState(false);
  const [scrollLine, setScrollLine] = useState<number | null>(null);
  const [matches, setMatches] = useState<{ reference: string; paths: string[]; line?: number } | null>(null);
  const [resolving, setResolving] = useState(false);
  const mdBody = useRef<HTMLDivElement | null>(null);
  const preBody = useRef<HTMLPreElement | null>(null);
  const shown = useRef<Preview | null>(null);
  shown.current = preview;
  /** Monotonic request id: a slow earlier read must not replace a file opened after it. */
  const readSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const sessionId = target.sessionId;
  const root = session ? fileScope(session, mission, target.missionWorkspaceId ?? '').root : '';
  const scope = session?.mission ? { missionWorkspaceId: target.missionWorkspaceId } : {};
  const current = (seq: number) => mounted.current && readSeq.current === seq;
  const close = () => useStore.getState().closePane(pane.id);
  /** A request that cannot be shown: say why, and keep whatever was on screen before it. */
  const fail = (message: string) => {
    toast(message, 'error');
    if (!shown.current) close();
  };

  const openFile = async (rel: string, line: number | undefined, seq: number) => {
    try {
      // Image bytes decoded as text are noise, so images take their own read and render as a picture.
      const r = imageMimeType(rel)
        ? { content: '', truncated: false, image: await invoke('fs:readImage', { sessionId, path: rel, ...scope }) }
        : await invoke('fs:read', { sessionId, path: rel, maxBytes: 200_000, ...scope });
      if (!current(seq)) return;
      const p = rel.replace(/\\/g, '/');
      setPreview({ path: p, ...r, ...(line ? { line } : {}) });
      setMdView(isMarkdown(p));
      setScrollLine(line && line > 0 ? line : null);
    } catch (err) {
      if (current(seq)) fail(invokeErrorMessage(err));
    }
  };

  /** StrictMode replays mount effects; one request must not start two lookups. */
  const handled = useRef<typeof target | null>(null);
  useEffect(() => {
    if (handled.current === target) return;
    handled.current = target;
    const seq = ++readSeq.current;
    setMatches(null);
    // Exact paths, and transports without the lookup, read the path as given.
    if (target.exact || !canInvoke('fs:resolve')) {
      setResolving(false);
      void openFile(target.path, target.line, seq);
      return;
    }
    setResolving(true);
    invoke('fs:resolve', { sessionId, path: target.path, ...scope })
      .then((result) => {
        if (!current(seq)) return;
        setResolving(false);
        if (result.status === 'resolved') void openFile(result.path, target.line, seq);
        else if (result.status === 'ambiguous') setMatches({ reference: target.path, paths: result.paths, line: target.line });
        else if (result.status === 'missing') fail(`${target.path} was not found in ${root}`);
        else fail(`Could not finish searching for ${target.path}. Use its full workspace-relative path.`);
      })
      .catch((err) => {
        if (!current(seq)) return;
        setResolving(false);
        fail(invokeErrorMessage(err));
      });
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Stops a lookup or a choice; the previous file stays, and without one the pane closes. */
  const cancel = () => {
    readSeq.current++;
    setResolving(false);
    setMatches(null);
    if (!shown.current) close();
  };

  // Once the text is on screen, bring the requested line to the middle of the view.
  useEffect(() => {
    if (scrollLine === null) return;
    const pre = preBody.current;
    if (!pre) return;
    const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 18;
    pre.scrollTop = Math.max(0, (scrollLine - 1) * lineHeight - pre.clientHeight / 2);
    setScrollLine(null);
  }, [scrollLine, preview, mdView]);

  const isMd = !!preview && isMarkdown(preview.path);
  // Links inside a markdown file are relative to that file, not to the workspace root.
  const mdHtml = useMemo(() => (isMd && preview ? renderMarkdown(preview.content, { fileLinks: true, fileBase: dirname(preview.path) }) : ''), [isMd, preview]);
  useEffect(() => {
    if (!mdView || !mdBody.current) return;
    return installMarkdownHandlers(
      mdBody.current,
      (url) => void invoke('app:openExternal', { url }),
      (p, line) => useStore.getState().revealFile(sessionId, p, line, { workspace: target.missionWorkspaceId ?? '' })
    );
  }, [mdView, mdHtml, sessionId, target.missionWorkspaceId]);
  const image = preview?.image;
  const imageSrc = useMemo(() => (image && !image.tooLarge ? `data:${image.mimeType};base64,${image.data}` : ''), [image]);

  if (!session) return null;
  const title = preview?.path ?? target.path;
  return (
    <section
      className="pane file-pane"
      data-pane-id={pane.id}
      data-testid="file-pane"
      aria-label={`Preview: ${title}`}
      style={split ? { flexGrow: Math.round(size * 1000) } : undefined}
    >
      <div className="file-preview-head">
        <Icon name="file" size={13} />
        <span className="mono file-preview-path" title={title}>{title}</span>
        <SessionTitle session={session} className="muted small file-preview-session" />
        <span className="spacer" />
        {preview && isMd && (
          <Button size="sm" variant="ghost" icon={mdView ? 'file' : 'eye'} onClick={() => setMdView((v) => !v)} title={mdView ? 'Show source' : 'Show markdown preview'} />
        )}
        {preview && !session.mission && (
          <Button
            size="sm"
            variant="ghost"
            icon="external"
            onClick={() => void invoke('app:openInEditor', { path: `${root}/${preview.path}`, sessionId, ...(preview.line ? { line: preview.line } : {}) })}
            title="Open in editor"
          />
        )}
        <Button size="sm" variant="ghost" icon="x" onClick={close} title="Close preview" aria-label="Close preview" />
      </div>
      {resolving ? (
        <div className="pad row gap8" role="status">
          <Spinner /> Finding {target.path}…
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
      ) : matches ? (
        <section className="file-match-list" aria-label="Choose a file">
          <div className="pad">
            <strong>Choose a file</strong>
            <p className="muted small">More than one file matches <code>{matches.reference}</code>. Select the full path to open.</p>
            <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
          {matches.paths.map((candidate) => (
            <button
              className="file-row"
              type="button"
              key={candidate}
              title={candidate}
              onClick={() => {
                setMatches(null);
                void openFile(candidate, matches.line, ++readSeq.current);
              }}
            >
              <Icon name="file" size={13} />
              <span className="file-path">{candidate}</span>
            </button>
          ))}
        </section>
      ) : !preview ? (
        <div className="pad row gap8" role="status">
          <Spinner /> Opening {target.path}…
        </div>
      ) : (
        // `.file-preview` is on screen only while a file actually is.
        <div className="file-preview">
          {preview.image !== undefined ? (
            <div className="file-image">
              {imageSrc ? (
                <img src={imageSrc} alt={preview.path} />
              ) : (
                <span className="muted small">
                  {image?.tooLarge ? `Image is ${(image.size / 1_000_000).toFixed(1)} MB, too large to preview.` : 'This image could not be previewed.'}
                </span>
              )}
            </div>
          ) : preview.binary ? (
            <div className="file-binary">
              <span className="muted small">Binary file, no text preview.</span>
              {!session.mission && canInvoke('app:showInFolder') && (
                <Button
                  size="sm"
                  icon="folder"
                  onClick={() => void invoke('app:showInFolder', { sessionId, path: `${root}/${preview.path}` }).then((r) => !r.ok && toast(r.error ?? 'Could not show the file', 'error'))}
                >
                  Show in {fileManagerName()}
                </Button>
              )}
            </div>
          ) : isMd && mdView ? (
            <div ref={mdBody} className="md file-md" dangerouslySetInnerHTML={{ __html: mdHtml }} />
          ) : (
            <pre className="mono" ref={preBody}>{preview.content}{preview.truncated ? '\n… (truncated)' : ''}</pre>
          )}
        </div>
      )}
    </section>
  );
}
