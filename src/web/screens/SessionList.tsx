/** Sessions home: the desktop's current session first, then what needs a person, what is running,
 *  and the rest by folder; archived rows stay collapsed. */
import { useMemo, useState } from 'react';
import { Button, Icon } from '@renderer/components/ui';
import { basename, harnessShort, relTime } from '@renderer/format';
import { sortSessionRows } from '@renderer/sessionOrder';
import { useStore } from '@renderer/store';
import type { SessionMeta } from '@shared/types';
import { StatusChip } from '../components/StatusChip';

export function SessionList({ focus, onNew, onOpen }: { focus: string | null; onNew: () => void; onOpen: (id: string) => void }) {
  const sessions = useStore((s) => s.sessions);
  const [filter, setFilter] = useState('');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const query = filter.trim().toLowerCase();
  const matches = (s: SessionMeta) => !query || s.title.toLowerCase().includes(query);

  const { focused, needsYou, running, folders, archived } = useMemo(() => {
    const visible = sessions.filter((s) => !s.archived && matches(s));
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const candidate = focus ? byId.get(focus) : undefined;
    const foc = candidate && !candidate.archived && matches(candidate) ? candidate : undefined;
    const needs = sortSessionRows(visible.filter((s) => s.status === 'awaiting' && s.id !== focus));
    const live = sortSessionRows(visible.filter((s) => (s.status === 'running' || s.status === 'starting') && s.id !== focus));
    const rest = sortSessionRows(visible.filter((s) => s.id !== focus && s.status !== 'awaiting' && s.status !== 'running' && s.status !== 'starting'));
    const grouped = new Map<string, SessionMeta[]>();
    for (const s of rest) grouped.set(s.config.projectRoot, [...(grouped.get(s.config.projectRoot) ?? []), s]);
    return { focused: foc, needsYou: needs, running: live, folders: [...grouped.entries()], archived: sessions.filter((s) => s.archived && matches(s)) };
  }, [sessions, focus, query]);

  const row = (s: SessionMeta) => (
    <li key={s.id}>
      <button type="button" className="w-session-row" data-testid="session-row" data-session-id={s.id} onClick={() => onOpen(s.id)}>
        <span className="w-session-row-main">
          <span className="w-session-row-title">{s.title}</span>
          <span className="w-session-row-meta">{harnessShort(s.config.harness)} · {relTime(s.updatedAt)}</span>
        </span>
        {s.status === 'awaiting' && s.statusDetail ? <span className="w-row-detail">{s.statusDetail}</span> : null}
        <StatusChip status={s.status} label={s.statusLabel} />
        <Icon name="chevronRight" size={14} />
      </button>
    </li>
  );

  const anything = focused || needsYou.length || running.length || folders.length || archived.length;
  return (
    <main className="w-home" data-testid="session-list">
      <div className="w-home-head">
        <h1>Sessions</h1>
        <Button size="sm" variant="primary" icon="sessionPlus" onClick={onNew} data-testid="new-session">New session</Button>
      </div>
      <input className="w-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sessions…" aria-label="Filter sessions" />
      {!anything && <p className="w-empty">{query ? 'No sessions match.' : 'No sessions on this computer yet.'}</p>}

      {focused && (
        <section className="w-section" data-testid="on-your-computer">
          <h2>On your computer now</h2>
          <div className="w-continue-card">
            <div className="w-continue-main">
              <span className="w-continue-title">{focused.title}</span>
              <span className="w-continue-meta">{harnessShort(focused.config.harness)} · {relTime(focused.updatedAt)}</span>
            </div>
            <Button size="sm" variant="primary" icon="play" onClick={() => onOpen(focused.id)}>Continue</Button>
          </div>
        </section>
      )}

      {needsYou.length > 0 && (
        <section className="w-section" data-testid="needs-you">
          <h2>Needs you</h2>
          <ul className="w-sessions">{needsYou.map(row)}</ul>
        </section>
      )}

      {running.length > 0 && (
        <section className="w-section" data-testid="running">
          <h2>Running</h2>
          <ul className="w-sessions">{running.map(row)}</ul>
        </section>
      )}

      {folders.map(([root, list]) => (
        <section className="w-section" key={root}>
          <h2>{basename(root)}</h2>
          <ul className="w-sessions">{list.map(row)}</ul>
        </section>
      ))}

      {archived.length > 0 && (
        <section className="w-section">
          <details open={archivedOpen} onToggle={(e) => setArchivedOpen((e.target as HTMLDetailsElement).open)}>
            <summary>Archived ({archived.length})</summary>
            <ul className="w-sessions">{archived.map(row)}</ul>
          </details>
        </section>
      )}
    </main>
  );
}
