/** The read-only terminal view (docs/REMOTE-ACCESS.md P3.5, read-only first): the desktop's
 *  terminals for the active session as plain text, polled while the sheet is open. Nothing here
 *  attaches, resizes or types into a terminal. */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@renderer/api';
import { Spinner } from '@renderer/components/ui';
import type { TerminalInfo } from '@shared/terminal';
import { BottomSheet } from './BottomSheet';

export function TerminalSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const [selected, setSelected] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState('');
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    const list = setInterval(() => void refreshList(), 3000);
    const refreshList = async () => {
      try {
        const mine = (await invoke('terminal:list', undefined)).filter((t) => t.sessionId === sessionId);
        if (!alive) return;
        setTerminals(mine);
        setSelected((current) => (mine.some((t) => t.id === current) ? current : mine[0]?.id ?? ''));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void refreshList();
    return () => {
      alive = false;
      clearInterval(list);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const poll = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const view = await invoke('terminal:screen', { terminalId: selected, lines: 200 });
        if (alive) {
          setLines(view.lines);
          setError('');
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy.current = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selected]);

  const autoScroll = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = autoScroll.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 24) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <BottomSheet title="Terminal" onClose={onClose}>
      {terminals && terminals.length > 1 && (
        <select className="w-select" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Terminal">
          {terminals.map((t) => <option key={t.id} value={t.id}>{t.title}{t.exit ? ' (exited)' : ''}</option>)}
        </select>
      )}
      {!terminals && <div className="w-loading"><Spinner /> Loading terminals…</div>}
      {terminals?.length === 0 && <p className="w-hint">No terminal is open for this session on the computer.</p>}
      {error && <p className="w-error" role="alert">{error}</p>}
      <pre className="w-terminal" ref={autoScroll}>{lines.join('\n')}</pre>
    </BottomSheet>
  );
}
