import React, { useEffect, useRef, useState } from 'react';
import type { GitSummary, SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { basename } from '../format';
import { archiveSession } from '../sessionActions';
import { useGitSummary } from '../gitReads';
import { useStore } from '../store';
import { Button, Icon, StatusDot } from './ui';
import { ForkIntoDropdown } from './ForkInto';
import { SwitchHarnessDropdown } from './SwitchHarness';
import { SessionTitle } from './SessionTitle';
import { MissionHeaderControls, useMission } from './mission/MissionPanel';
import { openMission } from '../missions';
import { canClosePane, canSplit } from '../panes';

/**
 * One row: the session's status, title and working-tree crumbs on the left, what it changed
 * and the view actions on the right. The run controls — model, effort, mode, Fast, spend — sit under
 * the composer (SessionControls), where a change applies to the next message.
 *
 * `paneId` is the split pane this header sits in; it carries the split and close-pane actions.
 */
export function Header({ session, paneId }: { session: SessionMeta; paneId?: string }) {
  const { record: mission, error: missionError } = useMission(session);
  const missions = useStore((s) => s.missions);
  const panelVisible = useStore((s) => s.panelOpen || !!s.layout.filePreview);
  const togglePanel = useStore((s) => s.togglePanel);
  const setPanelTab = useStore((s) => s.setPanelTab);
  const toast = useStore((s) => s.toast);
  const showThinking = useStore((s) => s.showThinking);
  const toggleThinking = useStore((s) => s.toggleThinking);
  const changesVersion = useStore((s) => s.changesVersion);
  const splittable = useStore((s) => canSplit(s.layout));
  // A file preview beside a lone session does not make that session's pane closable.
  const split = useStore((s) => !!paneId && canClosePane(s.layout, paneId));
  const { data: summary } = useGitSummary(session.id, changesVersion);
  const branch = summary?.branch;
  const folder = basename(session.cwd);
  const distinctFolder = folder !== basename(session.config.projectRoot);
  const busy = session.status === 'running' || session.status === 'awaiting' || session.status === 'starting';
  const ref = useRef<HTMLElement>(null);
  const width = useHeaderWidth(ref);

  return (
    <header className="header" ref={ref} data-width={width}>
      <div className="header-title">
        <StatusDot status={session.status} />
        <SessionTitle session={session} className="header-name" nameTestId="session-title" />
        <span className="header-crumbs">
          <button type="button" className="header-path" title={session.cwd} aria-label="Open session folder" onClick={() => void invoke('app:openPath', { path: session.cwd, sessionId: session.id })}>
            <Icon name="folder" size={12} />
            {distinctFolder && <span>{folder}</span>}
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
          <SwitchHarnessDropdown
            session={session}
            trigger={() => <Button variant="ghost" size="sm" icon="swap" title="Switch harness (same workspace)" aria-label="Switch harness" />}
          />
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
            onClick={(e) => void archiveSession(session, toast, e.currentTarget)}
          />
        </div>
        <span className="header-divider" aria-hidden />
        {paneId && splittable && (
          <Button variant="ghost" size="sm" icon="splitRight" onClick={() => useStore.getState().splitPane('horizontal', { paneId })} title="Split right (Ctrl+\) · Ctrl+Shift+\ splits down" aria-label="Split right" />
        )}
        {paneId && split && (
          <Button variant="ghost" size="sm" icon="x" onClick={() => useStore.getState().closePane(paneId)} title="Close pane — the session keeps running" aria-label="Close pane" />
        )}
        <Button variant={panelVisible ? 'subtle' : 'ghost'} size="sm" icon="layout" className="header-panel-toggle" onClick={() => togglePanel()} title="Toggle panel (Ctrl+J)" aria-label="Toggle panel" />
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
 * row sheds the folder/branch crumbs first, then the line totals, then the
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
