/** The sticky composer. Phone keyboards make Enter a newline, so the send button is primary; while
 *  a turn runs the same box offers Steer, Queue and Interrupt. */
import { useMemo, useState } from 'react';
import { canInvoke, invoke } from '@renderer/api';
import { Button, Icon } from '@renderer/components/ui';
import { useStore } from '@renderer/store';
import type { SessionMeta, SendMode } from '@shared/types';

export function WebComposer({ session, offline }: { session: SessionMeta; offline: boolean }) {
  const draft = useStore((s) => s.drafts[session.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const pushComposerHistory = useStore((s) => s.pushComposerHistory);
  const toast = useStore((s) => s.toast);
  const viewOnly = useStore((s) => s.remoteAccess.viewOnly);
  const [sending, setSending] = useState(false);
  const coarse = useMemo(() => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches, []);
  const running = session.status === 'running' || session.status === 'starting' || session.status === 'awaiting';
  const readable = !viewOnly && !offline && canInvoke('sessions:send');

  const send = async (mode: SendMode) => {
    const text = draft.trim();
    if (!text || sending || !readable) return;
    setSending(true);
    try {
      await invoke('sessions:send', { id: session.id, input: { text, mode: mode === 'now' ? undefined : mode } });
      setDraft(session.id, '');
      pushComposerHistory(session.id, text);
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
      <textarea
        value={draft}
        onChange={(e) => setDraft(session.id, e.target.value)}
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
        {running ? (
          <>
            <Button size="sm" variant="ghost" disabled={sending || !draft.trim()} onClick={() => void send('steer')}>Steer</Button>
            <Button size="sm" variant="ghost" disabled={sending || !draft.trim()} onClick={() => void send('queue')}>Queue</Button>
            <Button size="sm" variant="ghost" icon="stop" onClick={interrupt}>Interrupt</Button>
          </>
        ) : (
          <Button size="sm" variant="primary" icon="send" disabled={sending || !draft.trim()} onClick={() => void send('now')} aria-label="Send" />
        )}
      </div>
    </div>
  );
}
