/**
 * Compile-time and runtime invariants for `IPC_CHANNEL_POLICY`.
 * Proves every channel in `IpcContract` is classified once, remote halves are disjoint,
 * desktop-owner channels are never remotely exposed, and Mission guard sets stay aligned.
 */
import { describe, expect, it } from 'vitest';
import {
  IPC_CHANNEL_POLICY,
  channelsWithExposure,
  channelsWithMissionGuard,
  desktopOwnerError
} from '../src/shared/ipc-policy';
import {
  REMOTE_CHANNELS,
  REMOTE_HOST_CHANNELS,
  REMOTE_READ_CHANNELS,
  REMOTE_WRITE_CHANNELS
} from '../src/shared/remote-channels';

describe('IPC_CHANNEL_POLICY invariants', () => {
  it('keeps remote read and write halves strictly disjoint and matches REMOTE_CHANNELS', () => {
    for (const ch of REMOTE_READ_CHANNELS) {
      expect(REMOTE_WRITE_CHANNELS.has(ch), `${ch} cannot be both read and write`).toBe(false);
    }
    expect(REMOTE_CHANNELS.size).toBe(REMOTE_READ_CHANNELS.size + REMOTE_WRITE_CHANNELS.size);
    for (const ch of REMOTE_HOST_CHANNELS) {
      expect(REMOTE_READ_CHANNELS.has(ch), `${ch} host channel must be readable in view-only`).toBe(true);
    }
  });

  it('never exposes a desktop-owner channel on the remote surface and always provides an owner error', () => {
    const ownerChannels = channelsWithExposure('desktop-owner');
    expect(ownerChannels.length).toBeGreaterThan(0);
    for (const ch of ownerChannels) {
      expect(REMOTE_CHANNELS.has(ch), `${ch} is desktop-owner and must not be remote`).toBe(false);
      expect(IPC_CHANNEL_POLICY[ch].ownerError).toBeTruthy();
      expect(desktopOwnerError(ch, undefined)).toBe(IPC_CHANNEL_POLICY[ch].ownerError);
    }
  });

  it('gates payload-conditional intelligence settings updates via desktopOwnerError', () => {
    expect(desktopOwnerError('settings:update', { intelligence: { enabled: true } })).toContain('Intelligence');
    expect(desktopOwnerError('settings:update', { theme: 'dark' })).toBeNull();
    expect(desktopOwnerError('sessions:list', undefined)).toBeNull();
  });

  it('derives non-empty Mission guard channel sets including repo mutations inside git mutations', () => {
    const git = channelsWithMissionGuard('git-mutation', 'git-repo-mutation');
    const repo = channelsWithMissionGuard('git-repo-mutation');
    for (const ch of repo) expect(git.has(ch)).toBe(true);
    expect(channelsWithMissionGuard('session-control').has('sessions:delete')).toBe(true);
    expect(channelsWithMissionGuard('terminal-io').has('terminal:input')).toBe(true);
    expect(channelsWithMissionGuard('terminal-control').has('terminal:attach')).toBe(true);
    expect(channelsWithMissionGuard('project-write').has('mcp:project:save')).toBe(true);
  });
});
