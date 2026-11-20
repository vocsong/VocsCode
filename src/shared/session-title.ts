import type { HarnessId } from './types';

export interface SessionTitleMeta {
  title: string;
  config: {
    harness: string;
    projectRoot: string;
    acpAgent?: string;
  };
}

const HARNESS_LABELS: Readonly<Record<HarnessId, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  'codex-exec': 'Codex·exec',
  cursor: 'Cursor',
  pi: 'Pi',
  acp: 'ACP',
  native: 'Native'
};

/** Short display name for a harness id, with a fallback for historical records. */
export function harnessShort(id: string): string {
  return Object.hasOwn(HARNESS_LABELS, id) ? HARNESS_LABELS[id as HarnessId] : id;
}

/** Last path segment for both Windows and POSIX separators. */
export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Plain-text equivalent for tooltips, accessible labels and native notifications. */
export function sessionTitleText({ title, config }: SessionTitleMeta): string {
  return harnessShort(config.harness) + ' ' + basename(config.projectRoot) + ' | ' + title;
}
