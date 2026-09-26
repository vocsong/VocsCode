/** Sessions home: the computer's sessions, newest first, with a filter and a way to start one. */
import { useMemo, useState } from 'react';
import { Button, Icon } from '@renderer/components/ui';
import { relTime } from '@renderer/format';
import { harnessShort } from '@renderer/format';
import { sortSessionRows } from '@renderer/sessionOrder';
import { useStore } from '@renderer/store';
import { navigate } from '../router';
import { StatusChip } from '../components/StatusChip';

export function SessionList({ host, onNew }: { host: string; onNew: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return sortSessionRows(sessions.filter((s) => !s.archived && (!query || s.title.toLowerCase().includes(query))));
  }, [sessions, filter]);

  return (
    <main className="w-home" data-testid="session-list">
      <div className="w-home-head">
        <h1>Sessions</h1>
        <Button size="sm" variant="primary" icon="sessionPlus" onClick={onNew} data-testid="new-session">New session</Button>
      </div>
      <input
        className="w-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter sessions…"
        aria-label="Filter sessions"
      />
      {visible.length === 0 && <p className="w-empty">{filter ? 'No sessions match.' : 'No sessions on this computer yet.'}</p>}
      <ul className="w-sessions">
        {visible.map((session) => (
          <li key={session.id}>
            <button type="button" className="w-session-row" data-testid="session-row" data-session-id={session.id} onClick={() => navigate({ name: 'session', host, session: session.id })}>
              <span className="w-session-row-main">
                <span className="w-session-row-title">{session.title}</span>
                <span className="w-session-row-meta">{harnessShort(session.config.harness)} · {relTime(session.updatedAt)}</span>
              </span>
              <StatusChip status={session.status} label={session.statusLabel} />
              <Icon name="chevronRight" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
