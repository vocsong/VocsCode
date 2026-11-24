/**
 * The New session dialog's folder choices. Every folder the sidebar knows — its sessions' folders
 * and the folders added without a session — listed once each, whatever layout the sidebar is in,
 * most recently worked in first. Recency, not the sidebar's order, because the question the picker
 * answers is "where was I just working?".
 */
import type { AppSettings, SessionMeta } from '../../shared/types';
import { basename } from './format';
import { recencyAt } from './sessionOrder';

export interface FolderChoice {
  root: string;
  /** The folder's own name, the row's headline. */
  name: string;
  /** Unarchived sessions in the folder. */
  sessionCount: number;
  /** The newest of those sessions' recency stamps; absent for a folder without a session. */
  lastActiveAt?: number;
}

/**
 * Folders with sessions come first, newest activity on top; folders without one follow by name.
 * `current` is listed even when the sidebar does not know it yet (a folder just picked from disk).
 */
export function folderChoices(sessions: SessionMeta[], settings: AppSettings | null, current?: string): FolderChoice[] {
  const byRoot = new Map<string, FolderChoice>();
  const choiceFor = (root: string) => {
    let choice = byRoot.get(root);
    if (!choice) byRoot.set(root, (choice = { root, name: basename(root) || root, sessionCount: 0 }));
    return choice;
  };
  for (const s of sessions) {
    if (s.archived) continue;
    const choice = choiceFor(s.config.projectRoot);
    choice.sessionCount += 1;
    choice.lastActiveAt = Math.max(choice.lastActiveAt ?? 0, recencyAt(s));
  }
  for (const root of settings?.folders ?? []) choiceFor(root);
  const list = [...byRoot.values()].sort(
    (a, b) => (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || a.name.localeCompare(b.name) || a.root.localeCompare(b.root)
  );
  if (current && !byRoot.has(current)) list.unshift({ root: current, name: basename(current) || current, sessionCount: 0 });
  return list;
}

/** Separators and case do not matter: "g:/vocs" finds G:\Vocs-Code. */
const norm = (text: string) => text.toLowerCase().replace(/\\/g, '/');

/** Every space-separated term of the query must appear in the folder's name or path. */
export function matchesFolder(choice: FolderChoice, query: string): boolean {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${norm(choice.name)}\n${norm(choice.root)}`;
  return terms.every((t) => haystack.includes(t));
}
