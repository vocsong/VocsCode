import React, { useEffect, useRef, useState } from 'react';
import type { GitSummary, SessionMeta } from '../../../shared/types';
import { HARNESS_BY_ID } from '../../../shared/harness-meta';
import { invoke } from '../api';
import { basename, harnessShort, harnessTone } from '../format';
import { archiveSession } from '../sessionActions';
import { useGitSummary } from '../gitReads';
import { useStore } from '../store';
import { Badge, Button, Icon, StatusDot } from './ui';
import { ForkIntoDropdown } from './ForkInto';
import { MissionHeaderControls, useMission } from './mission/MissionPanel';
import { openMission } from '../missions';
import { canSplit } from '../panes';

/**
 * One row: who the session is (status, title, harness, folder, branch) on the left, what it changed
 * and the view actions on the right. The run controls — model, effort, mode, Fast, spend — sit under
 * the composer (SessionControls), where a change applies to the next message.
 *
 * `paneId` is the split pane this header sits in; it carries the split and close-pane actions.
 */
export function Header({ session, paneId }: { session: SessionMeta; paneId?: string }) {
  const { record: mission, error: missionError } = useMission(session);
  const missions = useStore((s) => s.missions);
  const panelOpen = useStore((s) => s.panelOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const toast = useStore((s) => s.toast);
  const showThinking = useStore((s) => s.showThinking);
  const toggleThinking = useStore((s) => s.toggleThinking);
  const changesVersion = useStore((s) => s.changesVersion);
  const splittable = useStore((s) => canSplit(s.layout));
  const split = useStore((s) => s.layout.panes.length > 1);
  const { data: summary } = useGitSummary(session.id, changesVersion);
  const branch = summary?.branch;
  const h = HARNESS_BY_ID[session.config.harness];
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  const ref = useRef<HTMLElement>(null);
  const width = useHeaderWidth(ref);

  return (
    <header className="header" ref={ref} data-width={width}>
      <div className="header-title">
        <StatusDot status={session.status} />
        <span className="header-name" data-testid="session-title" title={session.title}>
          {session.title}
        </span>
        {!session.mission && (
          <Badge tone={harnessTone(session.config.harness)} title={h.name}>
            {harnessShort(session.config.harness)}
            {session.config.harness === 'acp' && session.config.acpAgent ? ` · ${session.config.acpAgent}` : ''}
          </Badge>
        )}
        <span className="header-crumbs">
          <button type="button" className="header-path" title={session.cwd} onClick={() => void invoke('app:openPath', { path: session.cwd, sessionId: session.id })}>
            <Icon name="folder" size={12} /> <span>{basename(session.cwd)}</span>
          </button>
          {branch && (
            <button type="button" className="header-path" title={`Branch ${branch} — open the Git panel`} onClick={() => setPanelTab('branches')}>
              <Icon name="branch" size={12} /> <span>{branch}</span>
            </button>
          )}
        </span>
        {session.statusDetail && busy && <span className="header-status muted">{session.statusDetail}</span>}
        <span className="spacer" />
        {summary && <ChangesButton summary={summary} onOpen={() => setPanelTab('changes')} />}
        <div className="header-actions">
          <Button variant="ghost" size="sm" icon={showThinking ? 'eye' : 'eyeOff'} onClick={toggleThinking} title={showThinking ? 'Hide thinking' : 'Show thinking'} aria-label={showThinking ? 'Hide thinking' : 'Show thinking'} />
          <ForkIntoDropdown
            session={session}
            onForked={(f) => useStore.getState().setActive(f.id)}
            trigger={() => <Button variant="ghost" size="sm" icon="fork" title="Fork into another harness" aria-label="Fork session" />}
          />
          <Button
            variant="ghost"
            size="sm"
            icon="archive"
            title={session.mission ? 'Archive Mission (retain worktrees)' : session.worktreeBranch ? 'Archive & remove worktree' : 'Archive'}
            aria-label="Archive session"
            disabled={!!session.archived}
            onClick={() => void archiveSession(session, toast)}
          />
        </div>
        <span className="header-divider" aria-hidden />
        {paneId && splittable && (
          <Button variant="ghost" size="sm" icon="splitRight" onClick={() => useStore.getState().splitPane('horizontal', { paneId })} title="Split right (Ctrl+\) · Ctrl+Shift+\ splits down" aria-label="Split right" />
        )}
        {paneId && split && (
          <Button variant="ghost" size="sm" icon="x" onClick={() => useStore.getState().closePane(paneId)} title="Close pane — the session keeps running" aria-label="Close pane" />
        )}
        <Button variant={panelOpen ? 'subtle' : 'ghost'} size="sm" icon="layout" onClick={() => togglePanel()} title="Toggle panel (Ctrl+J)" aria-label="Toggle panel" />
      </div>

      {session.mission && (
        <div className="header-controls">
          {mission ? <MissionHeaderControls record={mission} /> : <span role="status">Mission · {missionError ?? 'Loading coordination state…'}</span>}
        </div>
      )}
      {!session.mission && Object.values(missions).some((m) => m.originSessionId === session.id) && <div className="mission-links row gap8 wrap">{Object.values(missions).filter((m) => m.originSessionId === session.id).map((m) => <Button size="sm" variant="ghost" key={m.id} onClick={() => void openMission(m).catch((e) => toast(String(e.message ?? e), 'error'))}>Mission: {m.title}</Button>)}</div>}
    </header>
  );
}

/**
 * How much of the one-row header fits: a split pane can be as narrow as 360px. Measured on the
 * header itself (a container query on the pane would trap the transcript's fixed lightbox), so the
 * row sheds the folder/branch crumbs first, then the harness badge and line totals, then the
 * changes button — the title, the actions and the pane controls stay.
 */
type HeaderWidth = 'wide' | 'compact' | 'narrow' | 'tiny';
function useHeaderWidth(ref: React.RefObject<HTMLElement | null>): HeaderWidth {
  const [width, setWidth] = useState<HeaderWidth>('wide');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.clientWidth;
      setWidth(w === 0 || w >= 760 ? 'wide' : w >= 560 ? 'compact' : w >= 440 ? 'narrow' : 'tiny');
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** What the session's working tree holds right now: file count and line totals, opening Changes. */
function ChangesButton({ summary, onOpen }: { summary: GitSummary; onOpen: () => void }) {
  const files = summary.files ?? [];
  if (!summary.isRepo || files.length === 0) return null;
  const add = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const del = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <button type="button" className="header-changes" title={`${files.length} changed file${files.length === 1 ? '' : 's'} — open Changes`} onClick={onOpen}>
      <Icon name="diff" size={13} />
      <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
      <span className="add">+{add}</span>
      <span className="del">−{del}</span>
    </button>
  );
}
