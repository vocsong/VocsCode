/**
 * Single authoritative security and ownership policy table for every IPC channel in `IpcContract`.
 *
 * Typed as `Record<IpcChannel, ChannelPolicy>` so adding a channel to `IpcContract` without
 * declaring both its exposure boundary and Mission ownership guard is a compile-time error.
 * `remote-channels.ts`, `src/main/ipc.ts`, and `src/main/handlers.ts` derive their runtime gates
 * directly from this table.
 */
import type { IpcChannel } from './ipc';
import { isIntelligenceOwnerRequest } from './intelligence';

export type ChannelExposure =
  /** Local desktop main-frame owner only (refused to subframes, remote browsers, and agents). */
  | 'desktop-owner'
  /** Local desktop renderer only (never on the remote allowlist). */
  | 'desktop'
  /** Paired remote browser read (also permitted in view-only mode). */
  | 'remote-read'
  /** Paired remote browser interactive write (refused in view-only mode). */
  | 'remote-write'
  /** Served directly by RemoteHost rather than HandlerRegistry (also remote-read). */
  | 'remote-host';

export type MissionGuardKind =
  | 'none'
  | 'session-control'
  | 'git-mutation'
  /** Git mutation that also touches repository-wide state (remotes, identity, worktree pruning). */
  | 'git-repo-mutation'
  | 'project-write'
  | 'terminal-control'
  /** Synchronous per-event PTY guard (keystrokes and resizes). */
  | 'terminal-io'
  /** Explicit custom handler in `guardMissionBoundary` (e.g. sessions:send/create/archive). */
  | 'custom';

export interface ChannelPolicy {
  readonly exposure: ChannelExposure;
  readonly missionGuard: MissionGuardKind;
  /** Exact refusal message when `exposure === 'desktop-owner'`. */
  readonly ownerError?: string;
}

const OWNER_ACCOUNT = 'Vocs account sign-in requires the local desktop owner.';
const OWNER_CONTROL = 'External control grants require the local desktop owner.';
const OWNER_HOUSEKEEP = 'Housekeep requires the local desktop owner.';
const OWNER_HARNESS_LOGIN = 'Harness sign-in requires the local desktop owner.';
const OWNER_ANTIGRAVITY_QUOTA = 'Antigravity quota requires the local desktop owner.';
const OWNER_FS_WRITE = 'Saving workspace text requires the local desktop owner.';
const OWNER_INTELLIGENCE = 'Intelligence settings and memory management require the local desktop owner.';

const p = (exposure: ChannelExposure, missionGuard: MissionGuardKind = 'none', ownerError?: string): ChannelPolicy =>
  ownerError ? { exposure, missionGuard, ownerError } : { exposure, missionGuard };

export const IPC_CHANNEL_POLICY: Readonly<Record<IpcChannel, ChannelPolicy>> = {
  // App & window
  'app:info': p('remote-read'),
  'app:doctor': p('desktop'),
  'app:openExternal': p('desktop'),
  'app:openPath': p('desktop'),
  'app:showInFolder': p('desktop'),
  'app:openInEditor': p('desktop', 'custom'),
  'app:openTerminal': p('desktop', 'custom'),
  'app:pickFolder': p('desktop'),
  'app:fileSaveAs': p('desktop', 'custom'),
  'app:notify': p('desktop'),
  'update:state': p('desktop'),
  'update:check': p('desktop'),
  'update:download': p('desktop'),
  'update:install': p('desktop'),
  'app:diag': p('desktop'),
  'app:rendererError': p('desktop'),
  'skills:openInEditor': p('desktop'),
  'window:toggleFullScreen': p('desktop'),
  'window:reload': p('desktop'),
  'window:toggleDevTools': p('desktop'),
  'window:zoom': p('desktop'),
  'window:edit': p('desktop'),
  'desktop:setFocus': p('desktop'),
  'desktop:setVisible': p('desktop'),
  'desktop:focus': p('remote-read'),

  // Vocs account (desktop owner)
  'vocsAccount:get': p('desktop-owner', 'none', OWNER_ACCOUNT),
  'vocsAccount:signIn': p('desktop-owner', 'none', OWNER_ACCOUNT),
  'vocsAccount:cancel': p('desktop-owner', 'none', OWNER_ACCOUNT),
  'vocsAccount:signOut': p('desktop-owner', 'none', OWNER_ACCOUNT),
  'vocsAccount:refresh': p('desktop-owner', 'none', OWNER_ACCOUNT),

  // Settings, folders, secrets, providers, models
  'settings:get': p('remote-read'),
  'settings:update': p('desktop'),
  'folders:remove': p('desktop', 'custom'),
  'secrets:set': p('desktop'),
  'secrets:clear': p('desktop'),
  'secrets:has': p('desktop'),
  'secrets:status': p('desktop'),
  'providers:list': p('desktop'),
  'providers:save': p('desktop'),
  'providers:delete': p('desktop'),
  'providers:refreshModels': p('desktop'),
  'providers:test': p('desktop'),
  'models:setOverride': p('desktop'),

  // Dictation (desktop only)
  'dictation:transcribe': p('desktop'),
  'dictation:cloudModels': p('desktop'),
  'dictation:status': p('desktop'),
  'dictation:install': p('desktop'),
  'dictation:cancelInstall': p('desktop'),
  'dictation:removeModel': p('desktop'),
  'dictation:stopLocal': p('desktop'),

  // Harnesses
  'harness:availability': p('remote-read'),
  'harness:setup': p('desktop'),
  'harness:login': p('desktop-owner', 'none', OWNER_HARNESS_LOGIN),
  'harness:antigravityQuota': p('desktop-owner', 'none', OWNER_ANTIGRAVITY_QUOTA),
  'harness:models': p('remote-read'),
  'harness:install': p('desktop'),
  'harness:checkUpdates': p('desktop'),

  // Skills
  'skills:list': p('remote-read'),
  'skills:read': p('remote-read'),
  'skills:reveal': p('desktop'),
  'skills:create': p('desktop'),
  'skills:copy': p('desktop'),
  'skills:delete': p('desktop'),

  // Pi global config
  'pi:setup': p('desktop'),
  'pi:preferences': p('desktop'),
  'pi:resource': p('desktop'),
  'pi:prompt:write': p('desktop'),
  'pi:package:install': p('desktop'),
  'pi:package:remove': p('desktop'),
  'pi:package:update': p('desktop'),
  'pi:package:resource': p('desktop'),
  'pi:subagents': p('desktop'),
  'pi:openInEditor': p('desktop'),
  'pi:reveal': p('desktop'),

  // App instructions
  'instructions:read': p('desktop'),
  'instructions:write': p('desktop'),

  // MCP, Cua, Processes
  'mcp:stores': p('desktop'),
  'mcp:project': p('desktop'),
  'mcp:project:save': p('desktop', 'project-write'),
  'mcp:project:state': p('desktop', 'project-write'),
  'mcp:project:index': p('desktop'),
  'mcp:inspect': p('desktop'),
  'mcp:import': p('desktop', 'custom'),
  'mcp:export': p('desktop', 'project-write'),
  'cua:status': p('desktop'),
  'cua:preview': p('desktop'),
  'cua:test': p('desktop'),
  'cua:install': p('desktop'),
  'processes:list': p('desktop'),
  'processes:end': p('desktop'),

  // Missions
  'missions:list': p('remote-read', 'custom'),
  'missions:get': p('remote-read', 'custom'),
  'missions:exportPlan': p('remote-read', 'custom'),
  'missions:create': p('remote-write', 'custom'),
  'missions:control': p('remote-write', 'custom'),
  'missions:command': p('remote-write', 'custom'),

  // Sessions, subagents, agents, housekeep
  'sessions:list': p('remote-read'),
  'sessions:importList': p('desktop'),
  'sessions:import': p('desktop'),
  'sessions:create': p('remote-write', 'custom'),
  'sessions:get': p('remote-read'),
  'sessions:transcript': p('remote-read'),
  'sessions:transcriptPage': p('remote-read'),
  'subagents:list': p('desktop'),
  'subagents:get': p('desktop'),
  'subagents:stop': p('desktop', 'session-control'),
  'subagents:steer': p('desktop', 'session-control'),
  'agents:list': p('desktop'),
  'agents:get': p('desktop'),
  'agents:save': p('desktop', 'session-control'),
  'agents:delete': p('desktop', 'session-control'),
  'agents:track': p('desktop', 'session-control'),
  'claude-agents:list': p('desktop'),
  'claude-agents:setModel': p('desktop', 'session-control'),
  'claude-agents:create': p('desktop', 'session-control'),
  'sessions:search': p('remote-read'),
  'sessions:delete': p('desktop', 'session-control'),
  'sessions:rename': p('remote-write'),
  'sessions:label': p('desktop'),
  'sessions:archive': p('desktop', 'custom'),
  'housekeep:preview': p('desktop-owner', 'none', OWNER_HOUSEKEEP),
  'housekeep:assess': p('desktop-owner', 'none', OWNER_HOUSEKEEP),
  'housekeep:apply': p('desktop-owner', 'none', OWNER_HOUSEKEEP),
  'housekeep:inventory': p('desktop-owner', 'none', OWNER_HOUSEKEEP),
  'sessions:pin': p('desktop'),
  'sessions:pinOrder': p('desktop'),
  'sessions:markViewed': p('desktop'),
  'sessions:send': p('remote-write', 'custom'),
  'sessions:editAndResend': p('desktop', 'session-control'),
  'sessions:interrupt': p('remote-write', 'session-control'),
  'sessions:stop': p('remote-write', 'session-control'),
  'sessions:setModel': p('remote-write', 'session-control'),
  'sessions:setEffort': p('remote-write', 'session-control'),
  'sessions:setFastMode': p('desktop', 'session-control'),
  'sessions:setPermissionMode': p('remote-write', 'session-control'),
  'sessions:compact': p('desktop', 'session-control'),
  'sessions:clearTranscript': p('desktop', 'session-control'),
  'sessions:export': p('desktop'),
  'sessions:fork': p('desktop', 'session-control'),
  'sessions:moveTo': p('desktop', 'session-control'),
  'sessions:goal': p('desktop', 'session-control'),

  // Vesta assistant
  'agent:state': p('desktop'),
  'agent:send': p('desktop'),
  'agent:cancel': p('desktop'),
  'agent:resolve': p('desktop'),
  'agent:reset': p('desktop'),

  // Analytics & approvals
  'analytics:summary': p('remote-read'),
  'analytics:executions': p('remote-read'),
  'approvals:respond': p('remote-write'),

  // Remote & external control
  'remote:get': p('desktop'),
  'remote:signIn': p('desktop'),
  'remote:enable': p('desktop'),
  'remote:disable': p('desktop'),
  'remote:pairStart': p('desktop'),
  'remote:pairRespond': p('desktop'),
  'remote:revoke': p('desktop'),
  'remote:revokeAll': p('desktop'),
  'remote:setViewOnly': p('desktop'),
  'remote:setMirror': p('desktop'),
  'remote:clearAudit': p('desktop'),
  'control:get': p('desktop-owner', 'none', OWNER_CONTROL),
  'control:enable': p('desktop-owner', 'none', OWNER_CONTROL),
  'control:grant': p('desktop-owner', 'none', OWNER_CONTROL),
  'control:revoke': p('desktop-owner', 'none', OWNER_CONTROL),

  // Git
  'git:folderBranch': p('remote-read'),
  'git:folderIsRepo': p('remote-read'),
  'git:folderBranches': p('remote-read'),
  'git:suggestBranchName': p('remote-write'),
  'git:summary': p('remote-read'),
  'git:diff': p('remote-read'),
  'git:revert': p('desktop', 'git-mutation'),
  'git:stageAll': p('desktop', 'git-mutation'),
  'git:commit': p('desktop', 'git-mutation'),
  'git:pr': p('desktop', 'git-mutation'),
  'git:merge': p('desktop', 'git-mutation'),
  'git:branches': p('remote-read'),
  'git:worktrees': p('remote-read'),
  'git:checkout': p('desktop', 'git-mutation'),
  'git:branchesOverview': p('remote-read'),
  'git:setupStatus': p('desktop'),
  'git:init': p('desktop', 'git-mutation'),
  'git:initialCommit': p('desktop', 'git-mutation'),
  'git:setRemote': p('desktop', 'git-repo-mutation'),
  'git:push': p('desktop', 'git-mutation'),
  'git:createGitHubRepo': p('desktop', 'git-repo-mutation'),
  'git:setIdentity': p('desktop', 'git-repo-mutation'),
  'git:githubIdentity': p('desktop'),
  'git:deleteBranch': p('desktop', 'git-mutation'),
  'git:updateBranch': p('desktop', 'git-mutation'),
  'git:removeWorktree': p('desktop', 'git-mutation'),
  'git:pruneWorktrees': p('desktop', 'git-repo-mutation'),
  'git:fetchPrune': p('desktop', 'git-repo-mutation'),
  'git:pullRequests': p('remote-read'),
  'git:pullRequest': p('desktop'),
  'git:issues': p('remote-read'),
  'git:issueComments': p('remote-read'),
  'git:prComments': p('remote-read'),

  // Filesystem
  'fs:list': p('remote-read'),
  'fs:search': p('remote-read'),
  'fs:resolve': p('desktop'),
  'fs:read': p('remote-read'),
  'fs:writeText': p('desktop-owner', 'none', OWNER_FS_WRITE),
  'fs:readImage': p('remote-read'),

  // Knowledge
  'knowledge:view': p('desktop'),
  'knowledge:read': p('desktop'),
  'knowledge:search': p('desktop'),
  'knowledge:create': p('desktop'),
  'knowledge:review': p('desktop'),
  'knowledge:reviewAll': p('desktop'),
  'knowledge:generate': p('desktop'),
  'knowledge:publish': p('desktop', 'project-write'),
  'knowledge:graph': p('desktop'),
  'knowledge:delete': p('desktop'),

  // Intelligence (local memory & project intelligence)
  'intelligence:view': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:search': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:compile': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:memory:add': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:memory:decide': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:memory:forget': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:memory:apply': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:memory:export': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:memory:import': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:reflect': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:promote': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:promotion:decide': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:collection:save': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:collection:delete': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:graph:index': p('desktop-owner', 'none', OWNER_INTELLIGENCE),
  'intelligence:graph:clear': p('desktop-owner', 'none', OWNER_INTELLIGENCE),

  // Terminal
  'terminal:list': p('remote-read'),
  'terminal:screen': p('remote-read'),
  'terminal:shells': p('desktop'),
  'terminal:create': p('remote-write', 'custom'),
  'terminal:attach': p('desktop', 'terminal-control'),
  'terminal:detach': p('desktop'),
  'terminal:input': p('remote-write', 'terminal-io'),
  'terminal:resize': p('desktop', 'terminal-io'),
  'terminal:ack': p('desktop'),
  'terminal:kill': p('desktop', 'terminal-control'),
  'terminal:restart': p('desktop', 'terminal-control'),
  'terminal:close': p('desktop', 'terminal-control'),
  'terminal:clear': p('desktop', 'terminal-control'),
  'terminal:rename': p('desktop'),
  'terminal:watch': p('remote-host'),
  'terminal:unwatch': p('remote-host'),
  'terminal:watchAck': p('remote-host')
};

const ALL_ENTRIES = Object.entries(IPC_CHANNEL_POLICY) as [IpcChannel, ChannelPolicy][];

export function channelsWithExposure(...exposures: ChannelExposure[]): IpcChannel[] {
  const wanted = new Set<ChannelExposure>(exposures);
  return ALL_ENTRIES.filter(([, policy]) => wanted.has(policy.exposure)).map(([channel]) => channel);
}

export function channelsWithMissionGuard(...guards: MissionGuardKind[]): ReadonlySet<string> {
  const wanted = new Set<MissionGuardKind>(guards);
  return new Set(ALL_ENTRIES.filter(([, policy]) => wanted.has(policy.missionGuard)).map(([channel]) => channel));
}

/**
 * Returns the refusal message when `(channel, req)` requires the local desktop owner (main frame /
 * desktop actor), or `null` when ordinary desktop/remote/agent dispatch rules apply.
 */
export function desktopOwnerError(channel: string, req: unknown): string | null {
  // Payload-conditional owner gates (e.g. `settings:update` patching `intelligence.*`).
  if (isIntelligenceOwnerRequest(channel, req)) return OWNER_INTELLIGENCE;
  const policy = (IPC_CHANNEL_POLICY as Record<string, ChannelPolicy | undefined>)[channel];
  if (policy?.exposure === 'desktop-owner') {
    return policy.ownerError ?? `${channel} requires the local desktop owner.`;
  }
  return null;
}
