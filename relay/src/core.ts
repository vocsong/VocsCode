/** Relay core facade (docs/RELAY.md): re-exports device registry, token auth,
 *  pairing, Connect-with-Vocs enrollment, and offline transcript mirror operations. */
export type { RelayStorage, RelayStore } from './storage';
export {
  ACCESS_TTL_MS,
  CHALLENGE_TTL_MS,
  MAX_HOST_DEVICES,
  MAX_WEB_DEVICES,
  PairError,
  SOCKET_TICKET_TTL_MS,
  consumeSocketTicket,
  deviceInfos,
  hashToken,
  issueAccessToken,
  issueChallenge,
  issueSocketTicket,
  listDevices,
  randomToken,
  registerHostDevice,
  registerWebDevice,
  revocationEpoch,
  revokeAllExcept,
  revokeDevice,
  verifyAccessToken,
  verifyRefreshToken,
  type AccessGrant,
  type DeviceInfo,
  type DeviceRecord,
  type Json
} from './devices';
export {
  ENROLL_GRANT_TTL_MS,
  enrollmentStatus,
  grantEnrollment,
  redeemEnrollment,
  type Redemption
} from './enrollment';
export {
  PAIRING_TTL_MS,
  claimPairing,
  pollPairing,
  requestPairing,
  resolvePairing,
  startPairing,
  type ApprovedPoll,
  type PairingApproval,
  type PairingRecord
} from './pairing';
export {
  MIRROR_MAX_BLOB_CHARS,
  MirrorError,
  clearMirror,
  deleteMirrorSession,
  getMirrorIndex,
  getMirrorSession,
  listMirrorSessions,
  putMirrorIndex,
  putMirrorSession,
  type MirrorBlob,
  type MirrorSessionMeta
} from './mirror-store';
