/** Ctrl+N quick picker: pick a known folder, then an optional first prompt — keyboard only.
 *  Stage 1 lists folders (arrows + Enter); stage 2 takes a prompt with pasted images, Enter sends. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageAttachment } from '../../../shared/types';
import { basename } from '../format';
import { useStore } from '../store';
import { fileToAttachment } from './Composer';
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

  const send = () => {
    const root = picked;
    close();
    void useStore.getState().createQuickSession(root!, { prompt, images });
  };

  const [idx, setIdx] = useState(0);
  const total = roots.length + 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (picked) {
        // Prompt stage: Enter sends, Escape backs out while the prompt is still empty.
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (!prompt.trim() && !images.length) setPicked(null);
          else close();
        }
        return;
      }
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx((i) => (i + 1) % total);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx((i) => (i - 1 + total) % total);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (idx < roots.length) setPicked(roots[idx]);
        else browse();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picked, idx, roots, total, prompt, images]);

  // Same image handling as the chat composer: pasted or picked screenshots ride along with the first prompt.
  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const imgs = await Promise.all(files.map(fileToAttachment));
    setImages((prev) => [...prev, ...imgs]);
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const imgs = await Promise.all([...list].filter((f) => f.type.startsWith('image/')).map(fileToAttachment));
    setImages((prev) => [...prev, ...imgs]);
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
            <div className="ns-prompt-box">
              <textarea
                ref={promptRef}
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={onPaste}
                placeholder="First prompt (optional) — Enter starts the session, Shift+Enter for a new line"
              />
              <label className="icon-btn ns-attach" title="Attach image">
                <Icon name="image" size={14} />
                <input type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
              </label>
            </div>
            <span className="field-hint">Paste a screenshot or attach one with the button — it is sent with the first message.</span>
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