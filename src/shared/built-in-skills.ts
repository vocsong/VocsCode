/// <reference types="vite/client" />
import housekeepDocument from '../../resources/skills/housekeep/SKILL.md?raw';

/** Embedded by Vite in both the reviewer and the Skills page; no harness install is needed. */
export const HOUSEKEEP_SKILL = housekeepDocument.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
