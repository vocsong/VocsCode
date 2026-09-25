/** Stable across Electron/remote Error serialization. Only the pre-commit CAS rejection may
 * retire a pending user request; ambiguous IO/acknowledgment failures must keep its identity. */
export const MISSION_REVISION_CONFLICT_PREFIX = '[MISSION_REVISION_CONFLICT]';

export function isMissionRevisionConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:^|Error: )\[MISSION_REVISION_CONFLICT\] Expected revision \d+; current revision is \d+$/.test(text);
}
