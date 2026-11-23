/** How an adapter publishes the slash commands its engine answers itself (shared/harness-commands.ts). */
import { harnessCommandNames, normalizeHarnessCommands, sameHarnessCommands, type HarnessCommand } from '../../shared/harness-commands';
import type { HarnessContext } from './types';

/** Mission sessions keep their own goal, loop and task machinery; the harness's versions stay out of them. */
const MISSION_RESERVED = /^(?:goal|loop|tasks|agents)(?::|$)/i;

/**
 * Publishes `commands` as the session's harness commands: the names (aliases included) that drive
 * `/goal` (shared/goal-driver.ts) and the described list the composer offers. An unchanged list is
 * not re-sent, so a harness that re-reports on every start does not push sessions for nothing.
 */
export function reportHarnessCommands(ctx: Pick<HarnessContext, 'session' | 'updateMeta'>, commands: readonly HarnessCommand[]): void {
  const session = ctx.session();
  const list = normalizeHarnessCommands(commands).filter((c) => !session.mission || !MISSION_RESERVED.test(c.name));
  const names = harnessCommandNames(list);
  const current = session.harnessCommands;
  const sameNames = !!current && current.length === names.length && current.every((n, i) => n === names[i]);
  if (sameNames && sameHarnessCommands(session.harnessCommandList, list)) return;
  ctx.updateMeta({ harnessCommands: names, harnessCommandList: list });
}
