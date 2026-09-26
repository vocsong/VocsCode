import type { MissionFailure, MissionFailureKind } from './mission';

/** Stable across Electron/remote Error serialization. Only the pre-commit CAS rejection may
 * retire a pending user request; ambiguous IO/acknowledgment failures must keep its identity. */
export const MISSION_REVISION_CONFLICT_PREFIX = '[MISSION_REVISION_CONFLICT]';

/** The exact text of a pre-commit revision rejection, as MissionStoreError words it. Any host
 * check that refuses a stale expectedRevision must use it, or the UI keeps replaying the stale
 * request instead of binding the newer record. */
export function missionRevisionConflictMessage(expected: number, current: number): string {
  return `${MISSION_REVISION_CONFLICT_PREFIX} Expected revision ${expected}; current revision is ${current}`;
}

export function isMissionRevisionConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:^|Error: )\[MISSION_REVISION_CONFLICT\] Expected revision \d+; current revision is \d+$/.test(text);
}

const FAILURE_LABELS: Record<MissionFailureKind, string> = {
  requirements: 'Requirements', implementation: 'Implementation', protocol: 'Runtime protocol', environment: 'Environment',
  provider: 'Provider', rate_limit: 'Rate limit', permission: 'Permission', stale_state: 'Stale state', integration: 'Integration',
  verification: 'Verification', persistence: 'Persistence', unknown: 'Unclassified'
};

/** Human category for a failure kind; an unknown kind falls back to its own words. */
export function missionFailureLabel(kind: string): string {
  return Object.hasOwn(FAILURE_LABELS, kind) ? FAILURE_LABELS[kind as MissionFailureKind] : kind.replace(/_/g, ' ');
}

const CLASSIFICATION = 'Failure classification: ';

/** Host notices (missionFailureNotice) embed the typed diagnosis as JSON for the lead. People get
 * its category and message instead of an object dump; any other text is returned unchanged. */
export function readableMissionText(text: string): string {
  let out = '';
  let from = 0;
  for (let at = text.indexOf(CLASSIFICATION); at >= 0; at = text.indexOf(CLASSIFICATION, from)) {
    const start = at + CLASSIFICATION.length;
    const end = jsonObjectEnd(text, start);
    let failure: Partial<MissionFailure> | undefined;
    try { failure = end > 0 ? JSON.parse(text.slice(start, end)) as Partial<MissionFailure> : undefined; } catch { failure = undefined; }
    if (typeof failure?.kind !== 'string' || typeof failure.message !== 'string') {
      out += text.slice(from, start);
      from = start;
      continue;
    }
    out += `${text.slice(from, at)}${missionFailureLabel(failure.kind)} failure: ${failure.message}`;
    from = end;
  }
  return out + text.slice(from);
}

/** End (exclusive) of the JSON object that starts at `start`, honoring strings; -1 if unbalanced. */
function jsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}
