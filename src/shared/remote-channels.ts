/** The remote surface (docs/REMOTE-ACCESS.md §5): which channels a paired browser may invoke and
 *  which pushes it receives. Shared so the desktop host enforces it and the web client can hide
 *  what it will be refused before sending anything. The host stays authoritative; the web copy
 *  only spares the user a refused control and the desktop an audit entry. */
import type { IpcChannel, PushChannel } from './ipc';

/** View-only mode (P4) admits the read half and refuses the write half. Every remote channel is
 *  classified as one or the other; a test asserts the two halves are disjoint, so a newly added
 *  channel cannot silently become writable when view-only. */
const READ: readonly IpcChannel[] = [
  'app:info',
  'settings:get',
  'desktop:focus',
  'harness:availability',
  'harness:models',
  'sessions:list',
  'sessions:get',
  'sessions:transcript',
  'sessions:transcriptPage',
  'sessions:search',
  'missions:list',
  'missions:get',
  'missions:exportPlan',
  'analytics:summary',
  'analytics:executions',
  'skills:list',
  'skills:read',
  'git:folderBranch',
  'git:folderIsRepo',
  'git:summary',
  'git:diff',
  'git:branches',
  'git:branchesOverview',
  'git:worktrees',
  'git:pullRequests',
  'git:issues',
  'git:issueComments',
  'git:prComments',
  'fs:list',
  'fs:search',
  'fs:read',
  // P3.5, read-only first: list terminals and read a plain-text screen. No input, resize or attach.
  'terminal:list',
  'terminal:screen'
];

/** Interactive P3: chat send/interrupt/stop, session lifecycle and per-session model controls.
 *  Destructive git stays desktop-only. */
const WRITE: readonly IpcChannel[] = [
  'missions:create',
  'missions:control',
  // Even `/mission status` travels on a mixed command channel: never classify it as a read.
  'missions:command',
  'sessions:send',
  'sessions:interrupt',
  'sessions:stop',
  'sessions:create',
  'sessions:rename',
  'sessions:setModel',
  'sessions:setEffort',
  'sessions:setPermissionMode',
  'approvals:respond'
];

/** Push channels a paired browser receives: the ones the remote surface consumes. Everything else
 *  the desktop pushes stays on this machine — terminal output (not remote until P3.5), the
 *  assistant panel, update prompts, and push:remoteState, which carries the live pairing code
 *  and pending pairing requests. */
const PUSH: readonly PushChannel[] = ['push:sessionEvent', 'push:sessionsChanged',
  // Mission records contain public coordination state, not broker credentials or provider keys.
  'push:missionsChanged',
  'push:settingsChanged', 'push:remotePolicy', 'push:desktopFocus'];

/** A typed runtime lookup: the arrays above are checked against the contract where they are
 *  written, and callers get channel names back rather than arbitrary strings. */
const lookup = <T extends string>(values: readonly T[]): ReadonlySet<T> => new Set(values);

/** Channels a paired web client may invoke. */
export const REMOTE_CHANNELS: ReadonlySet<IpcChannel> = lookup([...READ, ...WRITE]);
export const REMOTE_READ_CHANNELS: ReadonlySet<IpcChannel> = lookup(READ);
export const REMOTE_WRITE_CHANNELS: ReadonlySet<IpcChannel> = lookup(WRITE);
export const REMOTE_PUSH_CHANNELS: ReadonlySet<PushChannel> = lookup(PUSH);

/** Channel names arrive as plain strings off the relay, so the predicates — not `.has()` at the
 *  call site — are the boundary that narrows them to the contract. */
export function isRemoteChannel(channel: string): channel is IpcChannel {
  return (REMOTE_CHANNELS as ReadonlySet<string>).has(channel);
}

export function isRemoteReadChannel(channel: string): channel is IpcChannel {
  return (REMOTE_READ_CHANNELS as ReadonlySet<string>).has(channel);
}

export function isRemotePushChannel(channel: string): channel is PushChannel {
  return (REMOTE_PUSH_CHANNELS as ReadonlySet<string>).has(channel);
}

/** The largest WebSocket message the relay forwards (relay/src/hub.ts MAX_WS_FRAME_BYTES); it drops
 *  anything bigger without telling either side. */
export const REMOTE_FRAME_MAX_BYTES = 1024 * 1024;
