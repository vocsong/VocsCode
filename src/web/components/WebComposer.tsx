/** The sticky composer. Phone keyboards make Enter a newline, so the send button is primary; while
 *  a turn runs the same box offers Steer, Queue and Interrupt. */
import { useMemo, useRef, useState } from 'react';
import { canInvoke, invoke } from '@renderer/api';
import { Button, Icon } from '@renderer/components/ui';
import { useStore } from '@renderer/store';
import type { FileAttachment, SessionMeta, SendMode } from '@shared/types';

// Base64 and the sealed remote frame expand these bytes; keep the per-file cap conservative.
const MAX_FILE_BYTES = 128 * 1024;
const MAX_FILES = 2;
// A lost reply must not become a second Mission action when the composer remounts.
const pendingMissionSends = new Map<string, { payload: string; key: string }>();

async function encodeFile(file: File): Promise<FileAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: file.name, mimeType: file.type || 'application/octet-stream', data: btoa(binary) };
}

export function WebComposer({ session, offline }: { session: SessionMeta; offline: boolean }) {
  const draft = useStore((s) => s.drafts[session.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const pushComposerHistory = useStore((s) => s.pushComposerHistory);
  const toast = useStore((s) => s.toast);
  const viewOnly = useStore((s) => s.remoteAccess.viewOnly);
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [fileError, setFileError] = useState('');
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const coarse = useMemo(() => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches, []);
  const running = session.status === 'running' || session.status === 'starting' || session.status === 'awaiting';
  const readable = !viewOnly && !offline && canInvoke('sessions:send');
  const canSend = !sending && !reading && (!!draft.trim() || files.length > 0);

  const addFiles = async (list: FileList | File[]) => {
    if (readingRef.current || sending || !readable) return;
    readingRef.current = true;
    setReading(true);
    setFileError('');
    const accepted: FileAttachment[] = [];
    try {
      for (const file of Array.from(list)) {
        if (file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|tiff?)$/i.test(file.name)) {
          setFileError('Images are not supported here. Choose a non-image file.');
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          setFileError(`${file.name} exceeds the 128 KiB per-file limit.`);
          continue;
        }
        if (file.size === 0) {
          setFileError(`${file.name} is empty and cannot be attached.`);
          continue;
        }
        if (files.length + accepted.length >= MAX_FILES) {
          setFileError('You can attach at most 2 files. Remove one before adding another.');
          continue;
        }
        try {
          accepted.push(await encodeFile(file));
        } catch (e) {
          setFileError(`Could not attach ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (accepted.length) setFiles((current) => [...current, ...accepted]);
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  };

  const send = async (mode: SendMode) => {
    const text = draft.trim();
    if ((!text && !files.length) || sending || readingRef.current || !readable) return;
    const input = { text, ...(files.length ? { files } : {}), ...(mode !== 'now' ? { mode } : {}) };
    const payload = JSON.stringify({ sessionId: session.id, input });
    if (session.mission && pendingMissionSends.get(session.id)?.payload !== payload) {
      pendingMissionSends.set(session.id, { payload, key: globalThis.crypto.randomUUID() });
    }
    const key = session.mission ? pendingMissionSends.get(session.id)!.key : undefined;
    setSending(true);
    try {
      await invoke('sessions:send', { id: session.id, input, ...(key ? { idempotencyKey: key } : {}) });
      if (key && pendingMissionSends.get(session.id)?.key === key) pendingMissionSends.delete(session.id);
      if (useStore.getState().drafts[session.id] === draft) setDraft(session.id, '');
      setFiles([]);
      setFileError('');
      if (text) pushComposerHistory(session.id, text);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSending(false);
    }
  };

  const interrupt = () => {
    if (!canInvoke('sessions:interrupt')) return;
    void invoke('sessions:interrupt', { id: session.id }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'));
  };

  if (!readable) {
    return (
      <div className="w-composer w-composer-blocked" role="status">
        {viewOnly ? 'View-only on this computer' : offline ? 'Offline: the computer is unreachable' : 'Sending is unavailable'}
      </div>
    );
  }

  return (
    <div className="w-composer">
      {files.length > 0 && <div className="w-composer-files">{files.map((file, index) => (
        <span className="w-composer-file" key={index} title={file.name}>
          <Icon name="file" size={14} /><span>{file.name}</span>
          <button type="button" disabled={sending} aria-label={`Remove ${file.name}`} onClick={() => { setFiles((current) => current.filter((_, i) => i !== index)); setFileError(''); }}><Icon name="x" size={12} /></button>
        </span>
      ))}</div>}
      {fileError && <div className="w-composer-error" role="alert">{fileError}</div>}
      <div className="w-composer-row">
        <textarea
          value={draft}
          onChange={(e) => setDraft(session.id, e.target.value)}
          onPaste={(e) => { if (e.clipboardData.files.length) void addFiles(e.clipboardData.files); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || coarse) return;
            e.preventDefault();
            void send('now');
          }}
          placeholder={running ? 'Steer or queue a message…' : session.status === 'stopped' ? 'Sending restarts it on your computer' : 'Message…'}
          rows={2}
          aria-label="Message"
        />
        <div className="w-composer-actions">
          <input ref={picker} className="w-composer-picker" type="file" multiple aria-label="Choose files" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
          <Button size="sm" variant="ghost" icon="file" disabled={sending || reading} onClick={() => picker.current?.click()} aria-label="Attach files" title="Non-image files, max 2 · 128 KiB each" />
          {running ? (
            <>
              <Button size="sm" variant="ghost" disabled={!canSend} onClick={() => void send('steer')}>Steer</Button>
              <Button size="sm" variant="ghost" disabled={!canSend} onClick={() => void send('queue')}>Queue</Button>
              <Button size="sm" variant="ghost" icon="stop" onClick={interrupt}>Interrupt</Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon="send" disabled={!canSend} onClick={() => void send('now')} aria-label="Send" />
          )}
        </div>
      </div>
    </div>
  );
}
