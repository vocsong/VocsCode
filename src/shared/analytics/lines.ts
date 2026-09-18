/**
 * Code-output measurement: how many lines a file change added.
 *
 * Only `+` body lines count. A unified diff already expresses a modification as a removed line
 * followed by its replacement, so counting additions covers new *and* edited code in one number, and
 * a deletion — including deleting a whole file — contributes nothing. That is deliberate: removing
 * code is worth far less than writing it, and a file removal would otherwise dominate the total.
 */
import type { FileChange } from '../types';

/** Added lines in one unified diff: `+` body lines, never the `+++` file header. */
export function countAddedLines(diff: string): number {
  let added = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
  }
  return added;
}

/**
 * Added lines across one call's file changes, or `undefined` when the call cannot be measured.
 *
 * A rename scores zero rather than being skipped: it is a delete plus an add of identical content, so
 * counting it would credit the same code twice, but its intent is known and it genuinely added
 * nothing. A change the harness reported without a diff (Cursor reports none at all) leaves the call
 * unmeasured — recorded as "unknown", never as "wrote nothing", so a caller can tell the two apart.
 */
export function addedLinesOf(changes: readonly FileChange[] | undefined): number | undefined {
  if (!changes || changes.length === 0) return 0;
  let added = 0;
  for (const change of changes) {
    if (change.kind === 'rename') continue;
    if (!change.diff) return undefined;
    added += countAddedLines(change.diff);
  }
  return added;
}
