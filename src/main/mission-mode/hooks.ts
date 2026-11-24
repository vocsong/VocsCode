/**
 * What SessionManager asks of Mission mode. MissionService implements it; the manager only calls
 * through this interface, so neither imports the other's class.
 */
import type { ApprovalMissionRoute } from '../../shared/mission-mode';
import type { ApprovalRequest, SessionMeta } from '../../shared/types';
import type { BranchGitState } from '../git';
import type { MissionGatewayPort } from './contracts';

export interface MissionHooks {
  /** The gateway mission sessions reach the Mission tools through; absent when it cannot start. */
  gateway(): MissionGatewayPort | undefined;
  /** The role prompt and live mission context for a Lead or Builder session. */
  instructions(meta: SessionMeta): Promise<string | undefined>;
  /** A Builder raised a permission request: classify it and queue it to the Lead or the user. */
  routeApproval(meta: SessionMeta, request: ApprovalRequest): Promise<ApprovalMissionRoute>;
  /** The session is about to be deleted or archived; stop and clean what the mission owns of it. */
  sessionRemoved(meta: SessionMeta): Promise<void>;
  /** A PR/merge check of the session's branch finished. */
  gitState(meta: SessionMeta, state: BranchGitState): void;
}
