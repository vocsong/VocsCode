/** The harness's own slash commands for one session, as the composer's `/` popover offers them. */
import type { HarnessDescriptor, SessionMeta } from '../../shared/types';
import type { HarnessCommand } from '../../shared/harness-commands';
import { useStore } from './store';

/**
 * The session's own list, or — until its harness has started and reported one — the latest list a
 * session of the same harness in the same project reported. Commands come from the harness and the
 * project's files, so a sibling's list is what this one will report; the session's own replaces it
 * the moment it arrives.
 * Undefined while nothing is known yet, which is not the same as a harness that reported none.
 */
export function useHarnessCommandList(session: SessionMeta): HarnessCommand[] | undefined {
  return useStore((s) => {
    if (session.harnessCommandList) return session.harnessCommandList;
    let best: SessionMeta | undefined;
    for (const other of s.sessions) {
      if (other.id === session.id || !other.harnessCommandList?.length) continue;
      if (other.config.harness !== session.config.harness || other.config.projectRoot !== session.config.projectRoot) continue;
      if (!best || other.updatedAt > best.updatedAt) best = other;
    }
    return best?.harnessCommandList;
  });
}

/**
 * What the popover says about the harness's commands when it cannot list them, or null when the list
 * speaks for itself. Honest per harness: one that publishes nothing is not pretending to be empty.
 */
export function harnessCommandNote(harness: HarnessDescriptor, list: readonly HarnessCommand[] | undefined): string | null {
  switch (harness.capabilities.slashCommands) {
    case 'listed':
      if (!list) return `${harness.name}'s own commands appear here once the session has started.`;
      return list.length ? null : `${harness.name} reported no commands of its own for this session.`;
    case 'typed':
      return `${harness.name} does not publish its own commands to Vocs Code; any other /text is passed to it as written.`;
    default:
      return `${harness.name} has no slash commands of its own; any other /text goes to the model as written.`;
  }
}
