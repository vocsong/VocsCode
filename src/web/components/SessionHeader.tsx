/** The web session header: a slim bar with back, title and folder, status and an overflow menu. */
import { useState } from 'react';
import { canInvoke, invoke } from '@renderer/api';
import { basename } from '@renderer/format';
import { askPrompt, Button, Icon } from '@renderer/components/ui';
import { useStore } from '@renderer/store';
import type { SessionMeta } from '@shared/types';
import { BottomSheet } from '../sheets/BottomSheet';
import { StatusChip } from './StatusChip';

export function SessionHeader({ session, onBack, onTerminal }: { session: SessionMeta; onBack: () => void; onTerminal: () => void }) {
  const [menu, setMenu] = useState(false);
  const toast = useStore((s) => s.toast);
  const running = session.status === 'running' || session.status === 'starting' || session.status === 'awaiting';

  const stop = () => {
    if (!canInvoke('sessions:stop')) return;
    void invoke('sessions:stop', { id: session.id }).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'));
    setMenu(false);
  };

  const rename = async () => {
    setMenu(false);
    if (!canInvoke('sessions:rename')) return;
    const title = await askPrompt({
      title: 'Rename session',
      confirmLabel: 'Rename',
      input: { value: session.title, label: 'Title', placeholder: 'Session title', submitOnEnter: true }
    });
    if (!title || title === session.title) return;
    try {
      await invoke('sessions:rename', { id: session.id, title });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const copyLink = () => {
    setMenu(false);
    void navigator.clipboard.writeText(window.location.href).then(() => toast('Link copied', 'success'), () => toast('Could not copy the link', 'error'));
  };

  return (
    <header className="w-session-head">
      <button type="button" className="w-icon-btn" onClick={onBack} aria-label="Back to sessions"><Icon name="chevron" size={18} className="w-back" /></button>
      <div className="w-session-title">
        <span className="w-session-name" title={session.title}>{session.title}</span>
        <span className="w-session-path" title={session.cwd}>{basename(session.cwd)}</span>
      </div>
      <StatusChip status={session.status} label={session.statusLabel} />
      <button type="button" className="w-icon-btn" onClick={() => setMenu(true)} aria-label="Session actions"><Icon name="more" size={18} /></button>
      {menu && (
        <BottomSheet title="Session" onClose={() => setMenu(false)}>
          <div className="w-menu">
            <Button variant="ghost" icon="terminal" onClick={() => { setMenu(false); onTerminal(); }}>Terminal</Button>
            <Button variant="ghost" icon="edit" onClick={() => void rename()}>Rename</Button>
            {running && <Button variant="ghost" icon="stop" onClick={stop}>Stop</Button>}
            <Button variant="ghost" icon="link" onClick={copyLink}>Copy link</Button>
          </div>
        </BottomSheet>
      )}
    </header>
  );
}
