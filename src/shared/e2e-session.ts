/**
 * Replay-protected E2E frame decryption shared by desktop RemoteHost and browser RelayClient.
 * Keeps sequence monotonicity and per-direction salt pinning identical on both ends of the tunnel.
 */
import { openFrame } from './crypto';

export interface E2eReceiveState {
  key: CryptoKey;
  inSeq: number;
  inSalt?: string;
}

export type OpenCheckedResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'ignored' }
  | { status: 'undecryptable' };

/**
 * Validates frame envelope shape, sequence monotonicity, and pinned direction salt before
 * decrypting. Only advances `state.inSeq` and `state.inSalt` after decryption succeeds and
 * `isCurrent()` (when provided) confirms the session is still active.
 */
export async function openCheckedFrame<T>(
  state: E2eReceiveState,
  payload: unknown,
  opts?: { expectedSeq?: number; isCurrent?: () => boolean }
): Promise<OpenCheckedResult<T>> {
  const sealed = payload as { salt?: unknown; seq?: unknown; ct?: unknown } | null;
  if (!sealed || typeof sealed !== 'object') return { status: 'ignored' };
  const seq = sealed.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return { status: 'ignored' };
  if (opts?.expectedSeq !== undefined && (!Number.isSafeInteger(opts.expectedSeq) || opts.expectedSeq !== seq)) return { status: 'ignored' };
  if (typeof sealed.salt !== 'string' || typeof sealed.ct !== 'string') return { status: 'ignored' };
  if (seq <= state.inSeq) return { status: 'ignored' };
  if (state.inSalt !== undefined && sealed.salt !== state.inSalt) return { status: 'ignored' };
  let inner: T;
  try {
    inner = await openFrame<T>(state.key, { salt: sealed.salt, seq, ct: sealed.ct });
  } catch {
    return { status: 'undecryptable' };
  }
  if (opts?.isCurrent && !opts.isCurrent()) return { status: 'ignored' };
  state.inSeq = seq;
  state.inSalt = sealed.salt;
  return { status: 'ok', value: inner };
}
