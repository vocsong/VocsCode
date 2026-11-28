/** Desktop-owned Shared Skills data and the app's exact `/skill` namespace. */
import type { HarnessId } from './harness-types';

export interface SharedSkillReceipt {
  name: string;
  /** Full lowercase SHA-256 of the raw SKILL.md bytes. */
  revision: string;
}

export interface SharedSkillInfo extends SharedSkillReceipt {
  description: string;
  reviewed: boolean;
}

export interface SharedSkillDocument extends SharedSkillInfo {
  /** The full editable SKILL.md, including frontmatter. */
  content: string;
}

export const SHARED_SKILL_NAME = /^(?=[a-z0-9-]{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SHARED_SKILL_COMMAND_CHARS = 16 * 1024;

/** Own the token even when its arguments are invalid, so callers can refuse it rather than forward it. */
export function isSharedSkillCommand(text: string): boolean {
  return /^\/skill(?=\s|$)/.test(text);
}

/** Consume one delimiter after the name (CRLF counts as one); the rest of the arguments are literal text. */
export function parseSharedSkillCommand(text: string): { name: string; args: string } | null {
  if (typeof text !== 'string' || text.length > MAX_SHARED_SKILL_COMMAND_CHARS) return null;
  const match = /^\/skill[ \t]+(\S+)(?:(?:\r\n|\s)([\s\S]*))?$/.exec(text);
  return match && SHARED_SKILL_NAME.test(match[1]) ? { name: match[1], args: match[2] ?? '' } : null;
}

export function sharedSkillSupported(harness: HarnessId): boolean {
  return harness === 'codex' || harness === 'codex-exec' || harness === 'claude' || harness === 'pi' || harness === 'antigravity';
}
