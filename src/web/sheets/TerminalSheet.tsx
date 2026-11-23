/** The session's terminals on the computer (docs/REMOTE-ACCESS.md P3.5): pick one and it streams
 *  live into the browser; type into it unless the computer is in view-only mode. A browser may open
 *  a new terminal for the session, but never resizes, kills or closes one — the desktop owns its
 *  terminals' geometry and lifetime. */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { invoke } from '@renderer/api';
import { useCanInvoke } from '@renderer/capabilities';
import { Spinner } from '@renderer/components/ui';
import type { TerminalInfo } from '@shared/terminal';
import { BottomSheet } from './BottomSheet';

// The headless parser is only needed once a terminal is open: keep it out of the first load.
const TerminalView = lazy(() => import('../terminal/TerminalView').then((m) => ({ default: m.TerminalView })));

export function TerminalSheet({ sessionId, online, onClose }: { sessionId: string; online: boolean; onClose: () => void }) {
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const canType = useCanInvoke('terminal:input');
  const canCreate = useCanInvoke('terminal:create');

  const refreshList = useCallback(async () => {
    try {
      const mine = (await invoke('terminal:list', undefined)).filter((t) => t.sessionId === sessionId);
      setTerminals(mine);
      setSelected((current) => (mine.some((t) => t.id === current) ? current : mine[0]?.id ?? ''));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    if (!online) return;
    void refreshList();
    // Titles, exits and tabs opened on the desktop: the terminal list is not part of the remote push surface.
    const timer = setInterval(() => void refreshList(), 3000);
    return () => clearInterval(timer);
  }, [online, refreshList]);

  const openNew = async () => {
    setOpening(true);
    try {
      const created = await invoke('terminal:create', { sessionId });
      await refreshList();
      setSelected(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const current = terminals?.find((t) => t.id === selected);

  return (
    <BottomSheet title="Terminal" onClose={onClose}>
      {!online && !terminals && <p className="w-hint">Terminals need the computer to be online.</p>}
      {online && !terminals && !error && <div className="w-loading"><Spinner /> Loading terminals…</div>}
      {terminals && (terminals.length > 0 || canCreate) && (
        <div className="w-term-head">
          {terminals.length > 0 && (
            <select className="w-select" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Terminal">
              {terminals.map((t) => <option key={t.id} value={t.id}>{t.title}{t.exit ? ' (exited)' : ''}</option>)}
            </select>
          )}
          {canCreate && online && (
            <button type="button" className="w-chip" data-testid="terminal-new" disabled={opening} onClick={() => void openNew()}>
              {opening ? 'Opening…' : 'New terminal'}
            </button>
          )}
        </div>
      )}
      {terminals?.length === 0 && <p className="w-hint">No terminal is open for this session on the computer.</p>}
      {current?.restored && !current.pid && (
        <p className="w-hint">This terminal came back from the computer's last run; its shell starts when it is opened on the computer.</p>
      )}
      {error && <p className="w-error" role="alert">{error}</p>}
      {selected && (
        <Suspense fallback={<div className="w-loading"><Spinner /> Loading terminal…</div>}>
          <TerminalView key={selected} terminalId={selected} online={online} canType={canType} running={!!current?.pid} onClosed={() => void refreshList()} />
        </Suspense>
      )}
    </BottomSheet>
  );
}
