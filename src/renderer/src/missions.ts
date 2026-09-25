/** Mission UI actions only: the main-process coordinator owns admission and execution. */
import type { CreateMissionRequest, MissionControlRequest, MissionRecord, MissionUserControl } from '../../shared/mission';
import { applyMissionProjectOverride, DEFAULT_MISSION_CONFIG } from '../../shared/mission-config';
import { isMissionRevisionConflict } from '../../shared/mission-errors';
import type { AppSettings, ImageAttachment, SessionMeta, UserInput } from '../../shared/types';
import { invoke } from './api';
import { useStore } from './store';

export const MISSION_MANAGED_REASON = 'Mission owns execution and accepted changes. Ask the lead for a change; generic fork, rewind, revert and commit are unavailable.';
export const isTopLevelSession = (session: SessionMeta): boolean => session.mission?.role !== 'worker';
export const missionStatusLabel = (status: string): string => status.replace(/_/g, ' ');

/** Read configuration without repairing its default, changing source settings, or certifying a runtime. */
export function missionLaunchConfig(settings: AppSettings | null, root: string) {
  try {
    return { config: applyMissionProjectOverride(settings?.mission ?? DEFAULT_MISSION_CONFIG, settings?.missionProjects?.[root]), error: undefined };
  } catch (error) {
    return { config: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Keep payload/key until the reply is usable, including remounts, lost replies and missing leads. */
const requests = new Map<string, { run: () => Promise<unknown>; pending?: Promise<unknown> }>();
function request<T>(slot: string, make: (key: string) => () => Promise<T>, resetOnRevisionConflict = true): Promise<T> {
  let entry = requests.get(slot);
  if (!entry) {
    entry = { run: make(`mission-ui-${crypto.randomUUID()}`) };
    requests.set(slot, entry);
  }
  if (!entry.pending) {
    const current = entry;
    current.pending = Promise.resolve().then(current.run).then((result) => {
      requests.delete(slot);
      return result;
    }).catch((error) => {
      // The host proves this CAS failed before committing. A later click can bind the newer
      // record; network/persistence/lost-ack failures must retry the original payload and key.
      if (resetOnRevisionConflict && isMissionRevisionConflict(error)) requests.delete(slot);
      throw error;
    }).finally(() => { current.pending = undefined; });
  }
  return entry.pending as Promise<T>;
}

export async function openMission(record: MissionRecord): Promise<void> {
  const store = useStore.getState();
  store.setMission(record);
  // A create reply can arrive before sessionsChanged. Resolve the real lead rather than manufacturing metadata.
  if (!store.sessions.some((s) => s.id === record.leadSessionId)) {
    const lead = await invoke('sessions:get', { id: record.leadSessionId });
    if (!lead) {
      const latest = useStore.getState().missions[record.id] ?? record;
      const reason = latest.blockers.filter((blocker) => blocker.resolvedAt === undefined).map((blocker) => blocker.message).join('\n');
      throw new Error(`The Mission principal-engineer session is not available.${reason ? ` ${reason}` : ' Retry after the host has created the session.'}`);
    }
    useStore.getState().setSessions([...useStore.getState().sessions, lead]);
  }
  await useStore.getState().setActive(record.leadSessionId);
  useStore.getState().setPanelTab('goal');
}

export async function createMission(input: Omit<CreateMissionRequest, 'idempotencyKey'>): Promise<MissionRecord> {
  return request(`create:${JSON.stringify(input)}`, (idempotencyKey) => async () => {
    const record = await invoke('missions:create', { ...input, idempotencyKey });
    await openMission(record);
    return record;
  });
}

export async function controlMission(record: MissionRecord, control: MissionUserControl): Promise<MissionRecord> {
  const next = await request(`control:${record.id}:${JSON.stringify(control)}`, (idempotencyKey) => {
    const input: MissionControlRequest = { missionId: record.id, expectedRevision: record.revision, idempotencyKey, control };
    return () => invoke('missions:control', input);
  });
  useStore.getState().setMission(next);
  if (next.leadSessionId !== record.leadSessionId) await openMission(next);
  return next;
}

/** The host may already have retained attachments or committed the mailbox before a reply is
 * lost. Keep the exact input/key through remount/retry; a later acknowledged send is a new action. */
export function sendMissionUser(sessionId: string, input: UserInput): Promise<void> {
  const captured = structuredClone(input);
  return request(`message:${sessionId}:${JSON.stringify(captured)}`, (idempotencyKey) => () =>
    invoke('sessions:send', { id: sessionId, input: captured, idempotencyKey }), false);
}

export async function commandMission(session: SessionMeta, text: string, images?: ImageAttachment[]): Promise<void> {
  const input = structuredClone({ sessionId: session.id, text, ...(images?.length ? { images } : {}) });
  const reply = await request(`command:${JSON.stringify(input)}`, (idempotencyKey) => async () => {
    const reply = await invoke('missions:command', { ...input, idempotencyKey });
    if (reply.mission) await openMission(reply.mission);
    return reply;
  });
  if (reply.kind === 'show') useStore.getState().openMissionLaunch(session.config.projectRoot, session.id);
  if (reply.message) useStore.getState().toast(reply.message);
}

export function pauseMissionSession(session: SessionMeta): void {
  const store = useStore.getState();
  const record = session.mission && store.missions[session.mission.missionId];
  if (record) void controlMission(record, { action: 'pause' }).catch((e) => store.toast(String(e.message ?? e), 'error'));
  else if (session.mission) store.toast('Mission state is not loaded. Open the Mission panel and retry.', 'error');
  else void invoke('sessions:interrupt', { id: session.id });
}
