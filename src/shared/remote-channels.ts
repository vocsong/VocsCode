/** The remote surface (docs/REMOTE-ACCESS.md §5): which channels a paired browser may invoke and
 *  which pushes it receives. Derived from the exhaustive `IPC_CHANNEL_POLICY` table so no channel
 *  can be classified inconsistently across desktop-owner, remote, and Mission gates. */
import type { IpcChannel, PushChannel } from './ipc';
import { channelsWithExposure } from './ipc-policy';

/** View-only mode (P4) admits the read half (including remote-host terminal watches) and refuses
 *  the write half. Both sets are derived from disjoint exposure values in `IPC_CHANNEL_POLICY`. */
const READ: readonly IpcChannel[] = channelsWithExposure('remote-read', 'remote-host');
const WRITE: readonly IpcChannel[] = channelsWithExposure('remote-write');
const HOST: readonly IpcChannel[] = channelsWithExposure('remote-host');

/** Push channels broadcast to every paired browser: the ones the remote surface consumes.
 *  Everything else the desktop pushes stays on this machine — raw terminal output (a watched
 *  terminal reaches only its watcher, as push:remoteTerminal sealed to it), the assistant panel,
 *  update prompts, and push:remoteState, which carries the live pairing code and pending pairing
 *  requests. */
const PUSH: readonly PushChannel[] = [
  'push:sessionEvent',
  'push:sessionsChanged',
  // Mission records contain public coordination state, not broker credentials or provider keys.
  'push:missionsChanged',
  'push:settingsChanged',
  'push:remotePolicy',
  'push:desktopFocus'
];

const lookup = <T extends string>(values: readonly T[]): ReadonlySet<T> => new Set(values);

/** Channels a paired web client may invoke. */
export const REMOTE_CHANNELS: ReadonlySet<IpcChannel> = lookup([...READ, ...WRITE]);
export const REMOTE_READ_CHANNELS: ReadonlySet<IpcChannel> = lookup(READ);
export const REMOTE_WRITE_CHANNELS: ReadonlySet<IpcChannel> = lookup(WRITE);
export const REMOTE_PUSH_CHANNELS: ReadonlySet<PushChannel> = lookup(PUSH);
export const REMOTE_HOST_CHANNELS: ReadonlySet<IpcChannel> = lookup(HOST);

/** Channel names arrive as plain strings off the relay, so the predicates — not `.has()` at the
 *  call site — are the boundary that narrows them to the contract. */
export function isRemoteChannel(channel: string): channel is IpcChannel {
  return (REMOTE_CHANNELS as ReadonlySet<string>).has(channel);
}

export function isRemoteReadChannel(channel: string): channel is IpcChannel {
  return (REMOTE_READ_CHANNELS as ReadonlySet<string>).has(channel);
}

export function isRemoteHostChannel(channel: string): channel is IpcChannel {
  return (REMOTE_HOST_CHANNELS as ReadonlySet<string>).has(channel);
}

export function isRemotePushChannel(channel: string): channel is PushChannel {
  return (REMOTE_PUSH_CHANNELS as ReadonlySet<string>).has(channel);
}

/** The largest WebSocket message the relay forwards (relay/src/hub.ts MAX_WS_FRAME_BYTES); it drops
 *  anything bigger without telling either side. */
export const REMOTE_FRAME_MAX_BYTES = 1024 * 1024;
