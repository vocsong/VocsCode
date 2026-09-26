/** One session: the slim header, the chip row, a sticky approval banner, the reused Transcript and
 *  the sticky composer. */
import { useEffect, useMemo, useState } from 'react';
import { Transcript } from '@renderer/components/Transcript';
import { Spinner } from '@renderer/components/ui';
import { useStore } from '@renderer/store';
import { SessionHeader } from '../components/SessionHeader';
import { SessionControls } from '../sheets/SessionControlSheets';
import { WebComposer } from '../components/WebComposer';
import { TerminalSheet } from '../sheets/TerminalSheet';
import type { ConnectionState } from '../transport/relay-transport';

export function SessionView({ sessionId, connection, onBack }: { sessionId: string; connection: ConnectionState; onBack: () => void }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const loaded = useStore((s) => s.loaded[sessionId]);
  const items = useStore((s) => s.transcripts[sessionId]);
  const setActive = useStore((s) => s.setActive);
  const [terminal, setTerminal] = useState(false);
  const pendingApproval = useMemo(() => items?.find((item) => item.kind === 'approval' && !item.decision), [items]);

  useEffect(() => {
    if (!session) return;
    void setActive(session.id).catch(() => undefined);
  }, [session, setActive]);

  if (!session) {
    return (
      <main className="w-session">
        <header className="w-session-head">
          <button type="button" className="w-icon-btn" onClick={onBack} aria-label="Back to sessions"><span>‹</span></button>
          <div className="w-session-title"><span className="w-session-name">Session</span></div>
        </header>
        <div className="w-empty">{connection === 'mirror' ? 'This session is not in the offline snapshot.' : 'This session is not on the computer any more.'}</div>
      </main>
    );
  }

  const review = () => {
    const el = document.querySelector(`[data-item-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(pendingApproval!.id) : pendingApproval!.id}"]`);
    el?.scrollIntoView?.({ block: 'center' });
  };

  return (
    <main className="w-session">
      <SessionHeader session={session} onBack={onBack} onTerminal={() => setTerminal(true)} />
      <SessionControls session={session} />
      {pendingApproval && (
        <button type="button" className="w-approval-banner" data-testid="approval-banner" onClick={review} aria-live="polite">
          Needs approval · Review
        </button>
      )}
      {loaded ? <Transcript session={session} /> : <div className="w-loading"><Spinner /> Loading transcript…</div>}
      <WebComposer session={session} offline={connection !== 'online'} />
      {terminal && <TerminalSheet sessionId={session.id} onClose={() => setTerminal(false)} />}
    </main>
  );
}
