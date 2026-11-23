/** The right-panel file drawer. Opening a file never takes space from the conversation layout. */
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { imageMimeType, type WorkspaceImage } from '../../../shared/image-files';
import { FILE_PREVIEW_MAX_BYTES } from '../../../shared/ipc';
import type { SessionMeta } from '../../../shared/types';
import { canInvoke, invoke, invokeErrorMessage, modKey } from '../api';
import { fileManagerName, fileScope } from '../file-open';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import type { FilePreviewTarget } from '../panes';
import { useStore } from '../store';
import { showImageContextMenu } from './image-context-menu';
import { SessionTitle } from './SessionTitle';
import { Button, Icon, Spinner } from './ui';

const FileSourceEditor = lazy(() => import('./FileSourceEditor').then(({ FileSourceEditor }) => ({ default: FileSourceEditor })));

interface Preview {
  path: string;
  content: string;
  editorRevision: number;
  truncated: boolean;
  readOnly?: boolean;
  binary?: boolean;
  image?: WorkspaceImage | null;
  line?: number;
}

interface Draft {
  original: string;
  text: string;
  saving?: boolean;
}

type Drafts = Map<string, Draft>;
const isMarkdown = (p: string) => /\.(?:md|markdown)$/i.test(p);
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const editorText = (content: string) => content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

/** The editor uses LF internally. Keep the BOM and preserve the endings of unchanged lines. */
function restoreFileText(text: string, original: string): string {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const endings = original.match(/\r\n|\r|\n/g) ?? [];
  const eol = endings[0] ?? '\n';
  if (endings.every((ending) => ending === eol)) return bom + text.replace(/\n/g, eol);
  const changes = diffLines(editorText(original), text, { maxEditLength: 2000 });
  if (!changes) return bom + text.replace(/\n/g, eol);
  let at = 0;
  return bom + changes.map(({ value, added, removed }) => {
    const restored = value.replace(/\n/g, () => added ? eol : endings[at++] ?? eol);
    return removed ? '' : restored;
  }).join('');
}

export function FilePreviewPane({ visible = true }: { visible?: boolean }) {
  const target = useStore((s) => s.layout.filePreview);
  const session = useStore((s) => s.sessions.find((x) => x.id === target?.sessionId));
  const mission = useStore((s) => (session?.mission ? s.missions[session.mission.missionId] : undefined));
  // Drafts are in-memory only and follow the exact workspace and file, even when the drawer closes.
  const [drafts, setDrafts] = useState<Drafts>(() => new Map());
  const pendingWrites = useRef(new Map<string, Promise<void>>()).current;
  const updateDraft = (key: string, draft?: Draft) => setDrafts((current) => {
    const next = new Map(current);
    if (draft) next.set(key, draft);
    else next.delete(key);
    return next;
  });
  if (!visible || !target || !session) return null;
  const root = fileScope(session, mission, target.missionWorkspaceId ?? '').root;
  const scopeKey = JSON.stringify([session.id, session.mission?.missionId, target.missionWorkspaceId, root]);
  return <ScopedPreview key={scopeKey} {...{ target, session, root, scopeKey, drafts, updateDraft, pendingWrites }} />;
}

function ScopedPreview({ target, session, root, scopeKey, drafts, updateDraft, pendingWrites }: {
  target: FilePreviewTarget;
  session: SessionMeta;
  root: string;
  scopeKey: string;
  drafts: Drafts;
  updateDraft: (key: string, draft?: Draft) => void;
  pendingWrites: Map<string, Promise<void>>;
}) {
  const toast = useStore((s) => s.toast);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mdView, setMdView] = useState(false);
  const [scrollLine, setScrollLine] = useState<{ line: number } | null>(null);
  const [matches, setMatches] = useState<{ reference: string; paths: string[]; line?: number } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [reading, setReading] = useState(false);
  const mdBody = useRef<HTMLDivElement>(null);
  const shown = useRef<Preview | null>(null);
  shown.current = preview;
  const readSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const sessionId = target.sessionId;
  const scope = session.mission ? { missionWorkspaceId: target.missionWorkspaceId } : {};
  const current = (seq: number) => mounted.current && readSeq.current === seq && useStore.getState().layout.filePreview === target;
  const close = () => useStore.getState().closeFilePreview();
  const fail = (message: string) => {
    toast(message, 'error');
    if (!shown.current) close();
  };

  const keyFor = (path: string) => JSON.stringify([scopeKey, path]);
  const openFile = async (rel: string, line: number | undefined, seq: number, discard = false) => {
    const path = rel.replace(/\\/g, '/');
    const key = keyFor(path);
    setReading(true);
    try {
      // Reopening a drawer mid-save must read the bytes after the write, not the stale baseline.
      const pending = pendingWrites.get(key);
      if (pending) await pending;
      if (!current(seq)) return;
      const r = imageMimeType(rel)
        ? { content: '', truncated: false, image: await invoke('fs:readImage', { sessionId, path: rel, ...scope }) }
        : await invoke('fs:read', { sessionId, path: rel, maxBytes: FILE_PREVIEW_MAX_BYTES, ...scope });
      if (!current(seq)) return;
      if (discard) updateDraft(key);
      // Don't carry undo history across files, an explicit discard, or a changed disk baseline.
      setPreview((prior) => ({
        path, ...r, line,
        editorRevision: discard || prior?.path !== path || prior.content !== r.content ? seq : prior.editorRevision,
      }));
      setMdView(false);
      setScrollLine(line && line > 0 ? { line } : null);
    } catch (err) {
      if (current(seq)) fail(invokeErrorMessage(err));
    } finally {
      if (current(seq)) setReading(false);
    }
  };

  /** StrictMode replays mount effects; one request must not start two lookups. */
  const handled = useRef<FilePreviewTarget | null>(null);
  useEffect(() => {
    if (handled.current === target) return;
    handled.current = target;
    const seq = ++readSeq.current;
    setMatches(null);
    setReading(false);
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

  const cancel = () => {
    readSeq.current++;
    setResolving(false);
    setMatches(null);
    if (!shown.current) close();
  };

  const isText = !!preview && !preview.binary && preview.image === undefined;
  const editable = isText && !preview.truncated && !preview.readOnly && canInvoke('fs:writeText');
  const blocked = reading || resolving || !!matches;
  const pathKey = keyFor(preview?.path ?? '');
  const draft = drafts.get(pathKey);
  const text = draft?.text ?? (preview ? editorText(preview.content) : '');
  const dirty = !!draft;

  const draftFor = (value: string, original: string): Draft | undefined =>
    value === editorText(original) ? undefined : { original, text: value };

  const save = (value?: string) => {
    if (!preview || !editable || blocked || draft?.saving || pendingWrites.has(pathKey)) return;
    const next = value === undefined ? draft : draftFor(value, draft?.original ?? preview.content);
    if (!next) return;
    updateDraft(pathKey, { ...next, saving: true });
    const write = async () => {
      try {
        const content = restoreFileText(next.text, next.original);
        await invoke('fs:writeText', { sessionId, path: preview.path, expectedContent: next.original, content, ...scope });
        if (mounted.current) setPreview((current) => current?.path === preview.path ? { ...current, content } : current);
        updateDraft(pathKey);
        useStore.setState((s) => ({ changesVersion: s.changesVersion + 1 }));
        toast(`Saved ${preview.path}`, 'success');
      } catch (error) {
        updateDraft(pathKey, next);
        toast(invokeErrorMessage(error), 'error');
      }
    };
    pendingWrites.set(pathKey, write().finally(() => pendingWrites.delete(pathKey)).then(() => undefined));
  };

  const isMd = isText && isMarkdown(preview.path);
  const mdPath = preview?.path ?? '';
  const mdHtml = useMemo(() => isMd && mdView ? renderMarkdown(text, { fileLinks: true, fileBase: dirname(mdPath) }) : '', [isMd, mdView, text, mdPath]);
  useEffect(() => {
    if (!mdView || !mdBody.current) return;
    return installMarkdownHandlers(
      mdBody.current,
      (url) => void invoke('app:openExternal', { url }),
      (p, line) => useStore.getState().revealFile(sessionId, p, line, { workspace: target.missionWorkspaceId ?? '' })
    );
  }, [mdView, mdHtml, resolving, matches, sessionId, target.missionWorkspaceId]);
  const image = preview?.image;
  const imageSrc = useMemo(() => (image && !image.tooLarge ? `data:${image.mimeType};base64,${image.data}` : ''), [image]);
  const title = preview?.path ?? target.path;
  return (
    <section
      className="file-pane"
      data-testid="file-pane"
      aria-label={`Preview: ${title}`}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }
      }}
    >
      <div className="file-preview-head">
        <Icon name="file" size={13} />
        <span className="mono file-preview-path" title={title}>{title}</span>
        <SessionTitle session={session} className="muted small file-preview-session" />
        <span className="spacer" />
        {editable && <Button size="sm" variant={dirty ? 'primary' : 'ghost'} disabled={!dirty || draft.saving || blocked} onClick={() => save()} title={`Save file (${modKey}+S)`}>{draft?.saving ? 'Saving…' : 'Save'}</Button>}
        {isMd && (
          <Button size="sm" variant="ghost" icon={mdView ? 'file' : 'eye'} onClick={() => setMdView((v) => !v)} title={mdView ? 'Show source' : 'Show markdown preview'} aria-label={mdView ? 'Show source' : 'Show markdown preview'} />
        )}
        {preview && !session.mission && canInvoke('app:openInEditor') && (
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
        <section className={`file-match-list${preview ? ' file-match-list-with-preview' : ''}`} aria-label="Choose a file">
          <div className="pad">
            <strong>Choose a file</strong>
            <p className="muted small">More than one file matches <code>{matches.reference}</code>. Select the full path to open.</p>
            <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
          {matches.paths.map((candidate) => (
            <button className="file-row" type="button" key={candidate} title={candidate} onClick={() => {
              setMatches(null);
              void openFile(candidate, matches.line, ++readSeq.current);
            }}>
              <Icon name="file" size={13} />
              <span className="file-path">{candidate}</span>
            </button>
          ))}
        </section>
      ) : !preview ? (
        <div className="pad row gap8" role="status"><Spinner /> Opening {target.path}…</div>
      ) : null}
      {/* Keep the previous editor's viewport and history through failed or cancelled lookups. */}
      {preview && (
        <div className="file-preview">
          {preview.image !== undefined ? (
            <div className="file-image">
              {imageSrc ? <img src={imageSrc} alt={preview.path} onContextMenu={showImageContextMenu} /> : (
                <span className="muted small">
                  {image?.tooLarge ? `Image is ${(image.size / 1_000_000).toFixed(1)} MB, too large to preview.` : 'This image could not be previewed.'}
                </span>
              )}
            </div>
          ) : preview.binary ? (
            <div className="file-binary">
              <span className="muted small">Binary file, no text preview.</span>
              {!session.mission && canInvoke('app:showInFolder') && (
                <Button size="sm" icon="folder" onClick={() => void invoke('app:showInFolder', { sessionId, path: `${root}/${preview.path}` }).then((r) => !r.ok && toast(r.error ?? 'Could not show the file', 'error'))}>
                  Show in {fileManagerName()}
                </Button>
              )}
            </div>
          ) : isMd && mdView ? (
            <div ref={mdBody} className="md file-md" dangerouslySetInnerHTML={{ __html: mdHtml }} />
          ) : (
            <Suspense fallback={<div className="pad row gap8" role="status"><Spinner /> Loading editor…</div>}>
              <FileSourceEditor
                key={preview.editorRevision}
                path={preview.path}
                text={text}
                readOnly={!editable || !!draft?.saving || blocked}
                scrollLine={scrollLine}
                onLineRevealed={() => setScrollLine((current) => current === scrollLine ? null : current)}
                onChange={(value) => {
                  if (!editable || draft?.saving || blocked || pendingWrites.has(pathKey)) return;
                  updateDraft(pathKey, draftFor(value, draft?.original ?? preview.content));
                }}
                onSave={save}
              />
            </Suspense>
          )}
          {isText && <div className="file-preview-status muted small">
            <span role="status">{reading ? 'Loading…' : preview.truncated ? 'Truncated preview · read-only' : !editable ? 'Read-only' : draft?.saving ? 'Saving…' : dirty ? 'Unsaved changes' : ''}</span>
            {editable && dirty && !draft.saving && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void openFile(preview.path, preview.line, ++readSeq.current, true)}>Discard and reload</Button>}
          </div>}
        </div>
      )}
    </section>
  );
}
