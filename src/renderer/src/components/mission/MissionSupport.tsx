/** What can actually run a Mission today, said before anyone configures or launches one. */
import React, { useEffect, useState } from 'react';
import type { HarnessId } from '../../../../shared/types';
import { HARNESS_BY_ID, isMissionHarnessSupported, MISSION_SUPPORT_SUMMARY, MISSION_SUPPORTED_PLATFORMS, MISSION_UNSUPPORTED_PLATFORM } from '../../../../shared/harness-meta';
import { invoke, platform } from '../../api';
import './mission.css';

/** Missions run on the host, so a paired browser asks the host instead of reading its own platform.
 * Undefined while unknown: then nothing is claimed about this platform either way. */
export function useMissionHostPlatform(): string | undefined {
  const local = platform === 'browser' || platform === 'unknown' ? undefined : platform;
  const [host, setHost] = useState<string | undefined>(local);
  useEffect(() => {
    if (host) return;
    let live = true;
    invoke('app:info', undefined).then((info) => { if (live && typeof info?.platform === 'string') setHost(info.platform); }).catch(() => undefined);
    return () => { live = false; };
  }, [host]);
  return host;
}

export function MissionSupportNotice() {
  const host = useMissionHostPlatform();
  const unsupportedHost = host !== undefined && !MISSION_SUPPORTED_PLATFORMS.includes(host);
  return <div className="callout warn mission-support" role="note" data-testid="mission-support">
    <strong>{MISSION_SUPPORT_SUMMARY}</strong>
    {unsupportedHost && <> {MISSION_UNSUPPORTED_PLATFORM}</>}
  </div>;
}

/** Plain words for a preset whose harness cannot pass Mission readiness yet. */
export function missionHarnessWarning(harnessId: HarnessId): string | undefined {
  return isMissionHarnessSupported(harnessId) ? undefined
    : `${HARNESS_BY_ID[harnessId].name} presets are not supported for Missions yet. A Mission that uses one stops at a blocker before any work; choose a Pi preset.`;
}
