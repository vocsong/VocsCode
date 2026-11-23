/**
 * Shared global skills discovery types.
 * Keep this file free of Node/Electron/DOM imports.
 */

/** Harnesses that load a global skills directory (see main/skills.ts). */
export type SkillHarness = 'claude' | 'codex' | 'pi';

/** One installed skill: a directory with a SKILL.md carrying name/description frontmatter. */
export interface SkillInfo {
  /** Frontmatter name; falls back to the folder name. */
  name: string;
  description: string;
  /** Absolute path of the skill directory. */
  path: string;
  /** Absolute path of SKILL.md; null when the folder has none. */
  file: string | null;
  /** Last modification of SKILL.md; 0 when missing. */
  mtimeMs: number;
  /** Set when the folder has no readable SKILL.md, with the reason. */
  broken?: string;
}

/** A harness's global skills directory and the skills found in it. */
export interface SkillRootInfo {
  harness: SkillHarness;
  /** Human label; the Codex directory also serves the codex-exec harness. */
  label: string;
  /** Absolute path of the skills directory. */
  path: string;
  /** Same path with the home directory shortened to `~`, for display. */
  display: string;
  /** False when the directory does not exist yet. */
  exists: boolean;
  skills: SkillInfo[];
}
