/** Ctrl+N quick picker: pick a known folder, then an optional first prompt — keyboard only.
 *  Stage 1 lists folders (arrows + Enter); stage 2 takes a prompt with pasted images, Enter sends. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FileAttachment, ImageAttachment } from '../../../shared/types';
import { FileAttachmentChips, readAttachments } from '../attachments';
import { basename } from '../format';
import { useStore } from '../store';
import { Icon, Kbd } from './ui';

export function QuickSessionPicker() {
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  /** A prompt seeded by the opener (e.g. from a GitHub issue); the picker starts on the prompt stage already filled. */
  const prefill = useStore((s) => s.quickSessionPrefill);
  const close = () => useStore.getState().openQuickSession(false);

  const [picked, setPicked] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(prefill ?? '');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const sendingRef = useRef(false);
  const toast = useStore((s) => s.toast);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (picked) promptRef.current?.focus();
  }, [picked]);

  // Known folders: everything the sidebar could show — session roots, pinned folders and
  // recent projects — ordered like the sidebar (saved order, then alphabetical).
  const roots = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) set.add(s.config.projectRoot);
    for (const r of settings?.folders ?? []) set.add(r);
    for (const r of settings?.recentProjects ?? []) set.add(r);
    const order = settings?.folderOrder ?? [];
    const pos = (root: string) => {
      const i = order.indexOf(root);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...set].sort((a, b) => pos(a) - pos(b) || basename(a).localeCompare(basename(b)));
  }, [sessions, settings]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions) if (!s.archived) m.set(s.config.projectRoot, (m.get(s.config.projectRoot) ?? 0) + 1);
    return m;
  }, [sessions]);

  // The last row falls back to the Ctrl+N flow: native folder picker, then the full dialog.
  const browse = () => {
    close();
    void useStore.getState().startNewSession();
  };

  const send = async (root = picked, message = prompt, attachedImages = images, attachedFiles = files) => {
    if (!root || sendingRef.current) return;
    sendingRef.current = true;
    try {
      if (await useStore.getState().createQuickSession(root, { prompt: message, images: attachedImages, ...(attachedFiles.length ? { files: attachedFiles } : {}) })) close();
    } finally {
      sendingRef.current = false;
    }
  };

  const sendRef = useRef(send);
  sendRef.current = send;
  const [idx, setIdx] = useState(0);
  const total = roots.length + 1;
  // The capture listener is intentionally installed once. These refs keep it current without
  // interrupting keyboard handling while the prompt or attachments change.
  const pickedRef = useRef<string | null>(null);
  const idxRef = useRef(0);
  const rootsRef = useRef<string[]>([]);
  const promptValueRef = useRef('');
  const imagesRef = useRef<ImageAttachment[]>([]);
  const filesRef = useRef<FileAttachment[]>([]);
  pickedRef.current = picked;
  idxRef.current = idx;
  rootsRef.current = roots;
  promptValueRef.current = prompt;
  imagesRef.current = images;
  filesRef.current = files;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const currentPicked = pickedRef.current;
      if (currentPicked) {
        // Prompt stage: Enter sends, Escape backs out while the prompt is still empty.
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void sendRef.current(currentPicked, promptValueRef.current, imagesRef.current, filesRef.current);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (!promptValueRef.current.trim() && !imagesRef.current.length && !filesRef.current.length) {
            pickedRef.current = null;
            setPicked(null);
          } else {
            useStore.getState().openQuickSession(false);
          }
        }
        return;
      }
      const currentRoots = rootsRef.current;
      const currentTotal = currentRoots.length + 1;
      if (e.key === 'Escape') useStore.getState().openQuickSession(false);
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = (idxRef.current + 1) % currentTotal;
        idxRef.current = next;
        setIdx(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = (idxRef.current - 1 + currentTotal) % currentTotal;
        idxRef.current = next;
        setIdx(next);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (idxRef.current < currentRoots.length) {
          pickedRef.current = currentRoots[idxRef.current];
          setPicked(currentRoots[idxRef.current]);
        } else {
          useStore.getState().openQuickSession(false);
          void useStore.getState().startNewSession();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const addFiles = async (list: Iterable<File>) => {
    const added = await readAttachments(list, (message) => toast(message, 'error'));
    setImages((prev) => [...prev, ...added.images]);
    setFiles((prev) => [...prev, ...added.files]);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    void addFiles(pasted);
  };

  if (picked) {
    return (
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div className="palette">
          <div className="palette-input">
            <Icon name="folder" size={16} />
            <span className="row gap6" style={{ padding: '6px 0' }}>
              <span className="qs-picked" title={picked}>
                New session in {basename(picked)}
              </span>
              <span className="spacer" /> <Kbd>↵</Kbd> start <Kbd>esc</Kbd> back
            </span>
          </div>
          <div className="qs-prompt">
            {images.length > 0 && (
              <div className="attachments ns-attachments">
                {images.map((im, i) => (
                  <div key={i} className="attachment">
                    <img src={`data:${im.mimeType};base64,${im.data}`} alt={im.name ?? 'image'} />
                    <button type="button" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove">
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <FileAttachmentChips files={files} onRemove={(i) => setFiles((current) => current.filter((_, j) => j !== i))} />
            <div className="ns-prompt-box">
              <textarea
                ref={promptRef}
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={onPaste}
                placeholder="First prompt (optional) — Enter starts the session, Shift+Enter for a new line"
              />
              <label className="icon-btn ns-attach" title="Attach files">
                <Icon name="file" size={14} />
                <input type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles([...e.target.files]); e.target.value = ''; }} />
              </label>
            </div>
            <span className="field-hint">Paste or attach files and images — they are sent with the first message.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <div className="palette-input">
          <Icon name="plus" size={16} />
          <span className="row gap6" style={{ padding: '6px 0' }}>
            New session in… <span className="spacer" /> <Kbd>↑↓</Kbd> <Kbd>↵</Kbd>
          </span>
        </div>
        <div className="palette-list">
          {roots.map((root, i) => (
            <button
              key={root}
              type="button"
              className={`palette-item ${i === idx ? 'active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => setPicked(root)}
            >
              <Icon name="folder" size={14} />
              <span>{basename(root)}</span>
              <span className="spacer" />
              {counts.get(root) ? <span className="muted small">{counts.get(root)} session{counts.get(root) === 1 ? '' : 's'}</span> : null}
              <span className="muted small qs-root" title={root}>
                {root}
              </span>
            </button>
          ))}
          <button type="button" className={`palette-item ${roots.length === idx ? 'active' : ''}`} onMouseEnter={() => setIdx(roots.length)} onClick={browse}>
            <Icon name="search" size={14} />
            <span>Browse for another folder…</span>
            <span className="spacer" />
            <span className="muted small">Ctrl+N</span>
          </button>
        </div>
      </div>
    </div>
  );
}