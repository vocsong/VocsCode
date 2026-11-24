/**
 * The thin bar above a Mission Lead's transcript: the mission's state, how many Builders are still
 * on their task, Stop / Resume and the PR. `SessionMeta.mission` arrives with the session list; the
 * rest comes from `mission:get`, asked again whenever this mission's sessions change.
 */
import React, { useEffect, useState } from 'react';
import { parseGitHubPullRequestUrl } from '../../../shared/github-pull-request';
import type { MissionState } from '../../../shared/mission-mode';
import type { SessionMeta } from '../../../shared/types';
import { canInvoke, invoke, invokeErrorMessage } from '../api';
import { MISSION_STATE_LABELS, missionInFlight, runningBuilders } from '../mission';
import { useStore } from '../store';
import { askConfirm, Badge, Button, Icon } from './ui';

const STATE_TONE: Record<MissionState, 'blue' | 'amber' | 'green' | 'red' | 'neutral' | 'purple'> = {
  running: 'blue',
  waiting_user: 'amber',
  pr_open: 'green',
  done_local: 'green',
  interrupted: 'amber',
  stopped: 'neutral',
  ended: 'neutral'
};

/** What changes when the mission does: the Lead's own record and every session of this mission. */
function missionSignature(sessions: SessionMeta[], lead: SessionMeta): string {
  const id = lead.mission?.missionId;
  return sessions
    .filter((s) => s.id === lead.id || (!!id && s.mission?.missionId === id))
    .map((s) => `${s.id}:${s.status}:${s.archived ? 'a' : ''}:${s.mission?.state ?? ''}:${s.mission?.builderState ?? ''}:${s.mission?.prUrl ?? ''}`)
    .sort()
    .join('|');
}

export function MissionStrip({ session }: { session: SessionMeta }) {
  const mission = session.mission;
  const view = useStore((s) => s.missionViews[session.id]);
  const signature = useStore((s) => missionSignature(s.sessions, session));
  const refreshMission = useStore((s) => s.refreshMission);
  const putMissionView = useStore((s) => s.putMissionView);
  const toast = useStore((s) => s.toast);
  const [pending, setPending] = useState<'stop' | 'resume' | null>(null);

  useEffect(() => {
    void refreshMission(session.id);
  }, [refreshMission, session.id, signature]);

  if (mission?.role !== 'lead') return null;
  // The pushed session record is the freshest word on the state; the view fills in the rest.
  const state: MissionState = mission.state ?? view?.state ?? 'running';
  const prUrl = mission.prUrl ?? view?.prUrl;
  const pr = prUrl ? parseGitHubPullRequestUrl(prUrl) : undefined;
  const running = runningBuilders(view);
  const blocked = view?.blockedOnUser.length ?? 0;
  const canControl = canInvoke('mission:stop');

  const stop = async (anchor: HTMLElement) => {
    const ok = await askConfirm({
      title: 'Stop this mission?',
      body: 'Every Builder stops. Committed work stays on its branch, and unmerged work is kept and listed.',
      confirmLabel: 'Stop mission',
      danger: true,
      anchor
    });
    if (!ok) return;
    setPending('stop');
    try {
      putMissionView(await invoke('mission:stop', { leadId: session.id }));
    } catch (e) {
      toast(`Could not stop the mission: ${invokeErrorMessage(e)}`, 'error');
    } finally {
      setPending(null);
    }
  };

  const resume = async () => {
    setPending('resume');
    try {
      putMissionView(await invoke('mission:resume', { leadId: session.id }));
    } catch (e) {
      toast(`Could not resume the mission: ${invokeErrorMessage(e)}`, 'error');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="mission-strip" role="region" aria-label="Mission" data-state={state}>
      <span className="mission-strip-title">
        <Icon name="flag" size={13} /> Mission
      </span>
      <Badge tone={STATE_TONE[state]}>{MISSION_STATE_LABELS[state]}</Badge>
      {view && (view.builders.length > 0 || missionInFlight(state)) && (
        <span className="mission-strip-stat" data-testid="mission-builders-running">
          {running} {running === 1 ? 'Builder' : 'Builders'} running
        </span>
      )}
      {blocked > 0 && <span className="mission-strip-stat mission-strip-blocked">{blocked} waiting on you</span>}
      {view?.leadBranch && (
        <span className="mission-strip-branch mono" title={view.baseBranch ? `${view.leadBranch} → ${view.baseBranch}` : view.leadBranch}>
          <Icon name="branch" size={12} /> {view.leadBranch}{view.baseBranch ? ` → ${view.baseBranch}` : ''}
        </span>
      )}
      <span className="spacer" />
      {prUrl && (
        <Button size="sm" variant="ghost" icon="pr" title={prUrl} onClick={() => void invoke('app:openExternal', { url: prUrl })}>
          {pr ? `PR #${pr.number}` : 'Open PR'}
        </Button>
      )}
      {canControl && state === 'interrupted' && (
        <Button size="sm" variant="primary" icon="play" disabled={pending !== null} onClick={() => void resume()} title="Tell the Lead where each Builder stopped, so it can pick the work back up">
          Resume
        </Button>
      )}
      {canControl && missionInFlight(state) && (
        <Button size="sm" variant="ghost" icon="stop" disabled={pending !== null} onClick={(e) => void stop(e.currentTarget)} title="Stop the Lead and every Builder">
          Stop
        </Button>
      )}
    </div>
  );
}
